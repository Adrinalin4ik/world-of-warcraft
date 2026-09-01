import { vec4, mat4 } from 'gl-matrix';
import * as THREE from 'three';
import THREEUtil from '../../../utils/three-util';
import {
  FULL_SCREEN_RECT,
  intersectRect,
  ON_PLANE_EPS,
  clipPolygonToSidePlanes,
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
  projectToRect(viewProjection, incoming, cameraLocal) {
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
    // The four SIDE planes, and not the near plane -- see `clipPolygonToSidePlanes` for the
    // reference's pairing and for what removing the near clip alone cost.
    const sided = clipPolygonToSidePlanes(SCRATCH_CLIP.slice(0, count));
    if (sided.length < 3) {
      return null;
    }

    const projected = rectFromClipPolygon(sided);
    if (!projected) {
      return null;
    }

    return intersectRect(incoming, projected);
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