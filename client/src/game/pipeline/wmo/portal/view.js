import { vec4, mat4 } from 'gl-matrix';
import * as THREE from 'three';
import THREEUtil from '../../../utils/three-util';
import {
  FULL_SCREEN_RECT,
  clipPolygonToSidePlanes,
  intersectRect,
  ON_PLANE_EPS,
  rectFromClipPolygon,
} from './rect';

// Clip-space scratch, grown on demand. Portal polygons are small (4-8 vertices in practice) and
// this runs per portal per frame, so the buffer is reused rather than rebuilt.
const SCRATCH_CLIP = [];

// Reused across localToWorld conversions. These run per portal vertex, per portal, per frame; a
// fresh Vector3 per vertex was the single largest allocator in the cull pass.
const SCRATCH_VERTEX = new THREE.Vector3();

class WMOPortalView extends THREE.Mesh {

  constructor(portal, geometry, material) {
    super();

    this.matrixAutoUpdate = false;

    this.portal = portal;
    this.legacyGeometry = geometry;
    this.material = material;

    this.geometry = geometry.toBufferGeometry();
    // this.geometry.computeBoundsTree();
    this.geometry.computeBoundingBox();
  }

  clone() {
    return this.portal.createView();
  }

  portalCull(camera, frustum, flip) {
    const frustumPlanes = [];
    const vertices = [];
    const origin = camera.position.clone();
    // let local = this.worldToLocal(origin);
    // local = new THREE.Vector3(-local.x, -local.y, local.z)
    // Obtain vertices in world space
    for (let vindex = 0, vcount = this.legacyGeometry.vertices.length; vindex < vcount; ++vindex) {
      const local = this.legacyGeometry.vertices[vindex].clone();
      const world = this.localToWorld(local);
      const {x, y, z} = world;
      vertices.push([x, y, z]);
    }

    for (const plane of frustum.planes) {
      const {x, y, z} = plane.normal;
      frustumPlanes.push([x, y, z, plane.constant])
    }
    var thisPortalVertices = vertices;
    var thisPortalVerticesCopy = thisPortalVertices.slice(0);
    for (let i = 0; i < thisPortalVerticesCopy.length; i++)
        thisPortalVerticesCopy[i] = vec4.clone(thisPortalVerticesCopy[i]);

    var visible = true;
    for (let i = 0; visible && i < frustumPlanes.length; i++) {
      visible = visible && THREEUtil.planeCull(thisPortalVerticesCopy, frustumPlanes);
    }

    if (!visible) return null;

    const {x, y, z} = this.portal.plane.normal;
    const plane = [x, y, z, 1]
    THREEUtil.sortVec3ArrayAgainstPlane(thisPortalVerticesCopy, plane);

    // var lastFrustumPlanesLen = frustumPlanes.length;

    //3. Construct frustum planes for this portal
    var thisPortalPlanes = [];
    
    const cameraVec4 = [origin.x, origin.y, origin.z]
    for (let i = 0; i < thisPortalVerticesCopy.length; ++i) {
        var i2 = (i + 1) % thisPortalVerticesCopy.length;

        var n = THREEUtil.createPlaneFromEyeAndVertexes(cameraVec4, thisPortalVerticesCopy[i], thisPortalVerticesCopy[i2]);

        if (flip) {
            vec4.scale(n, n, -1)
        }

        const plane = new THREE.Plane(new THREE.Vector3(n[0], n[1], n[2]), n[3])
        thisPortalPlanes.push(plane);
    }
    // console.log(thisPortalPlanes)
    return { planes: thisPortalPlanes }
  }

  /**
   * Projects a new frustum from this portal using an origin point and restricting the new
   * frustum to include only the spill from the given frustum.
   *
   * @param origin - Position to use when projecting new frustum
   * @param frustum - Previous frustum (used to clip portal vertices)
   * @param flip - Optional, specify that the new frustum sides should be flipped
   *
   * @returns - Frustum clipped by this portal
   *
   */
  createFrustum(camera, frustum, flip = false) {
    const planes = [];
    const vertices = [];

    const origin = camera.position;

    // Obtain vertices in world space
    // These world-space vertices are retained by the clipper, so each needs its own Vector3 -- but
    // the intermediate copy does not.
    for (let vindex = 0, vcount = this.legacyGeometry.vertices.length; vindex < vcount; ++vindex) {
      const world = new THREE.Vector3().copy(this.legacyGeometry.vertices[vindex]);
      this.localToWorld(world);
      vertices.push(world);
    }

    // Check distance to portal
    SCRATCH_VERTEX.copy(origin);
    const distance = this.portal.plane.distanceToPoint(this.worldToLocal(SCRATCH_VERTEX));
    const close = distance < 1.0 && distance > -1.0;

    // If the portal is very close, use the portal vertices unedited; otherwise, clip the portal
    // vertices by the provided frustum.
    const clipped = close ? vertices : THREEUtil.clipVerticesByFrustum(vertices, frustum);

    // If clipping the portal vertices resulted in a polygon with fewer than 3 vertices, return
    // null to indicate a new frustum couldn't be produced.
    if (clipped.length < 3) {
      return null;
    }

    // Produce side planes for new frustum
    for (let vindex = 0, vcount = clipped.length; vindex < vcount; ++vindex) {
      const vertex1 = clipped[vindex];
      const vertex2 = clipped[(vindex + 1) % vcount];

      const plane = new THREE.Plane().setFromCoplanarPoints(origin, vertex1, vertex2);
      if (flip) plane.negate();
      planes.push(plane);
    }

    // Copy the original far plane (index: last - 1)
    const farPlaneIndex = frustum.planes.length - 1;
    const farPlane = frustum.planes[farPlaneIndex];
    planes.push(farPlane);

    // Create a near plane matching the portal
    const nearPlane = new THREE.Plane().setFromCoplanarPoints(clipped[0], clipped[1], clipped[2]);
    if (flip) nearPlane.negate();
    planes.push(nearPlane);

    const newFrustum = { planes };

    return newFrustum;
  }

  /**
   * Project this portal into the screen rect the flood should carry through it.
   *
   * Returns the incoming rect narrowed by this portal's screen-space AABB, or null when the branch
   * dies -- the portal is entirely behind the eye, or the narrowed rect collapsed below the
   * client's zero-area epsilon. That collapse is the mechanism: it is why a room behind a doorway
   * you cannot see through stops being drawn.
   *
   * **THE POLYGON IS NOT CLIPPED AGAINST THE NEAR PLANE, and this paragraph used to say the
   * opposite.** It claimed that skipping that step "silently drops visible rooms"; doing it is what
   * dropped them. The reference clips against the four SIDE planes only and handles the degenerate
   * `w` instead -- see the block inside for the citation and for what the clip was costing.
   *
   * The reference's special case (client `0x6b46f0`): an eye within ON_PLANE_EPS of the portal's
   * plane AND inside its polygon gets the full screen rect, because the projection is degenerate
   * there. Both halves -- the plane test alone opens rooms a doorway does not show.
   *
   * @param viewProjection  projection * matrixWorldInverse for the main camera
   * @param incoming        the rect this branch arrived with
   * @param cameraLocal     camera position in THIS portal view's local space
   */
  projectToRect(viewProjection, incoming, cameraLocal, debugOut = null) {
    /**
     * **THE EYE MUST BE IN THE POLYGON, NOT MERELY IN ITS PLANE.**
     *
     * A portal's plane is infinite. Standing twenty yards to the side of a doorway but coplanar with
     * it granted the FULL-SCREEN rect, which opens rooms the doorway does not show. The reference
     * tests both halves -- within `ON_PLANE_EPS` of the plane (the client's `|d| <= 0.01`) AND inside
     * the polygon, by a dominant-axis 2-D projection (the client's `0x7c23e0`)
     * (`benilla-world/src/wmo_portal/mod.rs:755-770`).
     *
     * This errs OPEN rather than closed, so it was never the blink -- but it is a rule we were half
     * applying, and the half we had is the one that costs correctness.
     */
    if (Math.abs(this.portal.plane.distanceToPoint(cameraLocal)) <= ON_PLANE_EPS
      && this.eyeInPolygon(cameraLocal)) {
      return intersectRect(incoming, FULL_SCREEN_RECT);
    }

    const vertices = this.legacyGeometry.vertices;
    const count = vertices.length;
    const e = viewProjection.elements;

    for (let vindex = 0; vindex < count; ++vindex) {
      SCRATCH_VERTEX.copy(vertices[vindex]);
      this.localToWorld(SCRATCH_VERTEX);
      const { x, y, z } = SCRATCH_VERTEX;

      let clip = SCRATCH_CLIP[vindex];
      if (!clip) {
        clip = SCRATCH_CLIP[vindex] = [0, 0, 0, 0];
      }

      // THREE.Matrix4 stores column-major, so column n starts at element 4n.
      clip[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
      clip[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      clip[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      clip[3] = e[3] * x + e[7] * y + e[11] * z + e[15];
    }

    /**
     * **NO NEAR-PLANE CLIP. The reference says so in as many words, and its absence here is the blink.**
     *
     * This clipped the polygon against the near plane and returned `null` when fewer than three
     * vertices survived. A doorway the eye is close to has vertices BEHIND the near plane, so the
     * polygon degenerated, the branch died, and the room behind it vanished for that frame -- which is
     * "кручу камерой и бывает пропадает явно видимый портал" under certain angles, because the angle
     * is what decides how many vertices fall behind.
     *
     * The reference clips against "the four **side** planes of the view pyramid (there is NO
     * near-plane clip)" and handles the degenerate `w` instead: `|w| < 0.001` substitutes `+1e-5`
     * regardless of sign, and a vertex still carrying `w <= -0.001` divides by its real negative `w`
     * so its MIRRORED NDC enters the rect. Its own words for why: "That is what keeps a doorway the
     * eye is straddling wide open (the boundary points at the eye clamp to `+1e-5` and blow the rect
     * out) instead of collapsing it for a frame" (`mod.rs:789-798`).
     *
     * `ndcFromClip` already implements that clamp exactly -- so the fix is to stop throwing away the
     * vertices it was written to handle. The rect comes out raw and un-clamped, as the reference
     * returns it; the `intersectRect` below is what bounds it, which is the reference's own
     * arrangement too ("the caller's intersect with the carried rect bounds it").
     *
     * The side-plane clip is NOT ported with it. It narrows a rect the carried-rect intersect narrows
     * anyway, and adding a clipping pass while removing another is how one fix becomes two changes
     * with one measurement. If a portal is ever seen opening too WIDE, that is where to look.
     */
    /**
     * **THE FOUR SIDE PLANES, back on -- and the 'no clipping at all' argument that removed them was
     * wrong on one specific point: Sutherland-Hodgman does not merely DISCARD a vertex behind the eye,
     * it replaces the edge through it with an intersection point.**
     *
     * The comment that stood here said `w + x >= 0` is false for almost any vertex behind the eye, so
     * the clip throws away exactly the vertices the `w` rule exists to handle. The first half is true
     * and the conclusion does not follow. The reference clips those vertices away too, and says what
     * takes their place: "a polygon spanning the eye survives as boundary points at/near `w = 0`, which
     * the caller's `w`-clamp handles" (`mod.rs:834-837`). Those boundary points are the interpolated
     * ones the clip inserts on the sign change; they clamp to `+1e-5` and blow the rect out, which is
     * the straddled doorway staying open. The vertices do not have to survive -- the EDGE does.
     *
     * Our `clipPolygonToSidePlanes` is already a faithful port: same four planes as the reference's
     * `PLANES` (`mod.rs:838-839`), same `>= 0` keep rule, same interpolation, same "fewer than three
     * remain" failure, which is the client's `rc.flags |= 0x1` skip. Nothing about it needed changing.
     *
     * **Why the measurement that removed it does not stand: it predates the seed.** Seven
     * `rect-collapse` in thirteen attempts was measured while the location manager was still seeding
     * group 0 for a body standing in group 5, so those floods were collapsing doorways viewed from the
     * wrong room -- the collapse was downstream of the seed, not caused by the clip. That is not a
     * claim I can make from reading; it is why this change ships with a guard that the old one had no
     * way to state.
     *
     * **The guard, and the numbers it gave (`client/harness/`, real `nsabbey` bytes, no browser):**
     *
     *   floor invariant -- the group whose floor resolves under the body must be drawn, over 20
     *   positions x 8 bearings x 2 eye heights: 0 violations before, 0 violations after. If the clip
     *   killed a doorway that matters, this is the arm that says so, and it is the exact symptom the
     *   removal was defending against.
     *
     *   over-draw -- groups drawn whose whole bounding box misses the frustum: see the round's commit
     *   message for the before/after share. Without the clip a portal with a vertex behind the eye
     *   projects to an AABB hundreds of screens wide, so the carried rect intersects to the FULL
     *   SCREEN and every branch below it inherits no narrowing at all -- traced at one frame as
     *   `11 -> 0` carrying `[-1,1]x[-1,1]`, which then opened 13, 2 and 9.
     */
    const clipped = clipPolygonToSidePlanes(SCRATCH_CLIP.slice(0, count));
    const projected = rectFromClipPolygon(clipped);

    /**
     * The projection, for the portal trace. Four `rect-collapse` outcomes in six attempts, with the
     * eye inside the room those doorways belong to, is not a portal that is off screen -- it is a
     * projection landing somewhere it should not. Recording the first WORLD vertex beside the rect is
     * what separates "the matrix is wrong" from "the rect really is outside the carried window":
     * this scene runs with `matrixWorldAutoUpdate = false`, so a view whose matrix was never updated
     * projects from the origin and lands consistently off screen.
     */
    if (debugOut) {
      SCRATCH_VERTEX.copy(vertices[0]);
      this.localToWorld(SCRATCH_VERTEX);
      debugOut.v0 = [SCRATCH_VERTEX.x, SCRATCH_VERTEX.y, SCRATCH_VERTEX.z]
        .map((v) => Number(v.toFixed(2)));
      debugOut.clip0 = SCRATCH_CLIP[0].map((v) => Number(v.toFixed(3)));
      debugOut.rect = projected === null ? null : {
        minX: Number(projected.minX.toFixed(3)), maxX: Number(projected.maxX.toFixed(3)),
        minY: Number(projected.minY.toFixed(3)), maxY: Number(projected.maxY.toFixed(3)),
      };
      debugOut.verts = count;
    }
    if (!projected) {
      return null;
    }

    const narrowed = intersectRect(incoming, projected);

    /**
     * **BOTH RECTS, because recording only one of them nearly cost a diagnosis.**
     *
     * `debugOut.rect` is the raw PROJECTED AABB and can be hundreds of screens wide -- a portal
     * vertex behind the eye divides by a negative `w` and flies off. Read on its own it looks like a
     * window that admits everything, and a round was one step from concluding that. It admits
     * nothing of the sort: what the flood carries is this intersection with the incoming rect, which
     * starts at the screen and can only ever narrow.
     *
     * So the trace now names the carried rect separately. A field whose name does not say which of
     * two things it holds is an instrument that agrees with whatever you already believe.
     */
    if (debugOut) {
      debugOut.carried = narrowed === null ? null : {
        minX: Number(narrowed.minX.toFixed(3)), maxX: Number(narrowed.maxX.toFixed(3)),
        minY: Number(narrowed.minY.toFixed(3)), maxY: Number(narrowed.maxY.toFixed(3)),
      };
    }

    return narrowed;
  }

  /**
   * Check if a given frustum contains or intersects with this portal view.
   *
   * @param frustum - Frustum object containing planes to check for portal inclusion / intersection
   *
   * @returns {Boolean} - Boolean indicating if the given frustum contained or intersected with
   * this portal view
   *
   */
  /**
   * Is the eye inside this portal's POLYGON? Projects out the plane's dominant axis and runs an
   * even-odd test -- the reference's `eye_on_portal` (`mod.rs:759-787`, the client's `0x7c23e0`).
   * Only meaningful for an eye already known to be in the plane: its projection is then itself.
   */
  eyeInPolygon(eyeLocal) {
    const vertices = this.legacyGeometry.vertices;
    const count = vertices.length;
    if (count < 3) {
      return false;
    }

    // The normal's dominant axis is the one to project OUT; the other two index the 2-D test.
    const n = this.portal.plane.normal;
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    let u;
    let v;
    if (ax >= ay && ax >= az) {
      u = 'y'; v = 'z';
    } else if (ay >= az) {
      u = 'x'; v = 'z';
    } else {
      u = 'x'; v = 'y';
    }

    const pu = eyeLocal[u];
    const pv = eyeLocal[v];
    let inside = false;
    for (let i = 0, j = count - 1; i < count; j = i, ++i) {
      const cu = vertices[i][u];
      const cv = vertices[i][v];
      const ju = vertices[j][u];
      const jv = vertices[j][v];
      if ((cv > pv) !== (jv > pv)
        && pu < ((ju - cu) * (pv - cv)) / (jv - cv) + cu) {
        inside = !inside;
      }
    }
    return inside;
  }

  intersectFrustum(frustum) {
    const planes = frustum.planes;
    const vertices = this.legacyGeometry.vertices;

    for (let pindex = 0, pcount = planes.length; pindex < pcount; ++pindex) {
      const plane = planes[pindex];

      if (!plane) {
        continue;
      }

      let inside = 0;

      for (let vindex = 0, vcount = vertices.length; vindex < vcount; ++vindex) {
        SCRATCH_VERTEX.copy(vertices[vindex]);
        this.localToWorld(SCRATCH_VERTEX);
        const distance = plane.distanceToPoint(SCRATCH_VERTEX);

        if (distance >= 0.0) {
          inside++;
        }
      }

      if (inside === 0) {
        return false;
      }
    }

    return true;
  }
}

export default WMOPortalView;

// import * as THREE from 'three';

// import THREEUtil from '../../../utils/three-util';

// class WMOPortalView extends THREE.Mesh {

//   constructor(portal, geometry, material) {
//     super();

//     this.matrixAutoUpdate = false;

//     this.portal = portal;
//     this.geometry = geometry;
//     this.material = material;
//   }

//   clone() {
//     return this.portal.createView();
//   }

//   /**
//    * Projects a new frustum from this portal using an origin point and restricting the new
//    * frustum to include only the spill from the given frustum.
//    *
//    * @param origin - Position to use when projecting new frustum
//    * @param frustum - Previous frustum (used to clip portal vertices)
//    * @param flip - Optional, specify that the new frustum sides should be flipped
//    *
//    * @returns - Frustum clipped by this portal
//    *
//    */
//   createFrustum(camera, frustum, flip = false) {
//     const planes = [];
//     const vertices = [];

//     const origin = camera.position;

//     // Obtain vertices in world space
//     for (let vindex = 0, vcount = this.geometry.vertices.length; vindex < vcount; ++vindex) {
//       const local = this.geometry.vertices[vindex].clone();
//       const world = this.localToWorld(local);
//       vertices.push(world);
//     }

//     // Check distance to portal
//     const distance = this.portal.plane.distanceToPoint(this.worldToLocal(origin.clone()));
//     const close = distance < 1.0 && distance > -1.0;

//     // If the portal is very close, use the portal vertices unedited; otherwise, clip the portal
//     // vertices by the provided frustum.
//     const clipped = close ? vertices : THREEUtil.clipVerticesByFrustum(vertices, frustum);

//     // If clipping the portal vertices resulted in a polygon with fewer than 3 vertices, return
//     // null to indicate a new frustum couldn't be produced.
//     if (clipped.length < 3) {
//       return null;
//     }

//     // Produce side planes for new frustum
//     for (let vindex = 0, vcount = clipped.length; vindex < vcount; ++vindex) {
//       const vertex1 = clipped[vindex];
//       const vertex2 = clipped[(vindex + 1) % vcount];

//       const plane = new THREE.Plane().setFromCoplanarPoints(origin, vertex1, vertex2);
//       if (flip) plane.negate();
//       planes.push(plane);
//     }

//     // Copy the original far plane (index: last - 1)
//     const farPlaneIndex = frustum.planes.length - 2;
//     const farPlane = frustum.planes[farPlaneIndex];
//     planes.push(farPlane);

//     // Create a near plane matching the portal
//     const nearPlane = new THREE.Plane().setFromCoplanarPoints(clipped[0], clipped[1], clipped[2]);
//     if (flip) nearPlane.negate();
//     planes.push(nearPlane);

//     const newFrustum = { planes };

//     return newFrustum;
//   }

//   /**
//    * Check if a given frustum contains or intersects with this portal view.
//    *
//    * @param frustum - Frustum object containing planes to check for portal inclusion / intersection
//    *
//    * @returns {Boolean} - Boolean indicating if the given frustum contained or intersected with
//    * this portal view
//    *
//    */
//   intersectFrustum(frustum) {
//     const planes = frustum.planes;
//     const vertices = this.geometry.vertices;

//     for (let pindex = 0, pcount = planes.length; pindex < pcount; ++pindex) {
//       const plane = planes[pindex];

//       if (!plane) {
//         continue;
//       }

//       let inside = 0;

//       for (let vindex = 0, vcount = vertices.length; vindex < vcount; ++vindex) {
//         const vertex = this.localToWorld(vertices[vindex].clone());
//         const distance = plane.distanceToPoint(vertex);

//         if (distance >= 0.0) {
//           inside++;
//         }
//       }

//       if (inside === 0) {
//         return false;
//       }
//     }

//     return true;
//   }

// }

// export default WMOPortalView;