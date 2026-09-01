import * as THREE from 'three';

import DebugPanel from '../../pages/game/debug/debug';
import { doodadFadeAlpha } from '../pipeline/m2/fade/laws';
import { FULL_SCREEN_RECT } from '../pipeline/wmo/portal/rect';
import { WmoFlags } from './wmo-flags';
import THREEUtil from '../utils/three-util';
import { PlaneHelper } from '../utils/plane-helper';
import { vec4 } from 'gl-matrix';

export const ObjectsManager = [];

// Camera position converted into a WMO view's local space, once per group visited per frame.
const SCRATCH_CAMERA_LOCAL = new THREE.Vector3();


class VisibilityManager {

  /**
   * Live kill-switch for the doodad distance-fade cull, so it can be A/B'd against the
   * frustum-only behaviour at a fixed camera pose from the browser console:
   *
   *   VisibilityManager.fadeCullEnabled = false; world.map.updateVisibility(world.game.camera)
   */
  static fadeCullEnabled = true;

  constructor(map) {
    this.map = map;

    this.stats = {
      map: {
        visibleChunks: 0,
        visibleDoodads: 0
      },
      wmo: {
        visibleGroups: 0,
        visibleDoodads: 0
      }
    };

    // Per-frame scratch. `update` runs every frame the camera moves; allocating a Frustum and a
    // Matrix4 here rather than inside it keeps the cull pass allocation-free at its top level.
    this.scratchFrustum = new THREE.Frustum();
    this.scratchViewProjection = new THREE.Matrix4();

    // Scratch for turning a window rect back into a sub-frustum.
    this.scratchRectToNdc = new THREE.Matrix4();
    this.scratchRectMatrix = new THREE.Matrix4();
    this.scratchRectFrustum = new THREE.Frustum();

    // Camera position for the horizontal fade distance, refreshed once per update().
    this.cameraX = 0;
    this.cameraY = 0;

    // Monotonic frame counter. An object whose `visibleFrame` equals the current frame was reached
    // by this frame's traversal; anything else is invisible. This replaces four full "hide
    // everything" sweeps that ran before any culling decision existed.
    this.frame = 0;
  }

  update(cameras) {
    if (!this.map) {
      return;
    }

    // Hide the exterior world (doodads and terrain) until a traversal reaches the exterior
    this.map.exterior.visible = false;

    ++this.frame;

    const camera = cameras.find(x => x.name === 'MainCamera');
    
    if (!camera) {
      return;
    }

    this.cameraX = camera.position.x;
    this.cameraY = camera.position.y;

    // camera.updateMatrix(); // make sure camera's local matrix is updated
    // camera.updateMatrixWorld(); // make sure camera's world matrix is updated
    // camera.updateProjectionMatrix(); // make sure camera's world matrix is updated
    // console.log(camera)
    // Obtain a frustum matching the camera
    // const cameraHelper = new THREE.CameraHelper(camera);
    // const projectionMatrix = camera.projectionMatrix;
    const frustum = this.scratchFrustum;
    // const frustum = new THREE.Frustum(
    //   (new THREE.Plane(-projectionMatrix.elements[3] - projectionMatrix.elements[0], -projectionMatrix.elements[7] - projectionMatrix.elements[4], -projectionMatrix.elements[11] - projectionMatrix.elements[8], -projectionMatrix.elements[15] - projectionMatrix.elements[12])),
    //   (new THREE.Plane(-projectionMatrix.elements[3] + projectionMatrix.elements[0], -projectionMatrix.elements[7] + projectionMatrix.elements[4], -projectionMatrix.elements[11] + projectionMatrix.elements[8], -projectionMatrix.elements[15] + projectionMatrix.elements[12])),
    //   (new THREE.Plane(-projectionMatrix.elements[3] + projectionMatrix.elements[1], -projectionMatrix.elements[7] + projectionMatrix.elements[5], -projectionMatrix.elements[11] + projectionMatrix.elements[9], -projectionMatrix.elements[15] + projectionMatrix.elements[13])),
    //   (new THREE.Plane(-projectionMatrix.elements[3] - projectionMatrix.elements[1], -projectionMatrix.elements[7] - projectionMatrix.elements[5], -projectionMatrix.elements[11] - projectionMatrix.elements[9], -projectionMatrix.elements[15] - projectionMatrix.elements[13])),
    //   (new THREE.Plane(-projectionMatrix.elements[2], -projectionMatrix.elements[6], -projectionMatrix.elements[10], -projectionMatrix.elements[14]))
    // );
    // debugger;
    this.scratchViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(this.scratchViewProjection);
    // frustum.setFromProjectionMatrix(camera.projectionMatrix);
    // debugger;
    // this.map.add(new PlaneHelper(frustum))
    // const p1 = new THREE.PlaneHelper(frustum.planes[0], 1, 0xffff00);
    // p1.position.set(camera.position.x, camera.position.y, camera.position.z);
    // world.scene.add(p1);
    // this.map.add(new THREE.PlaneHelper(frustum.planes[1], 1, 0xffff00));
    // this.map.add(new THREE.PlaneHelper(frustum.planes[2], 1, 0xffff00));
    // Adjust near plane (5) back to camera position
    const nearGap = frustum.planes[5].distanceToPoint(camera.position);
    frustum.planes[5].constant -= nearGap;

    // var nearPlane = frustum.planes[5];
    // var cameraVec4 = vec4.fromValues(camera.position.x, camera.position.y, camera.position.z,1);
    // var dist = vec4.dot(nearPlane, cameraVec4);
    // nearPlane.constant -= dist;

    if (camera.location.type === 'exterior') {
      this.enablePortalsFromExterior(0, camera, frustum);
    } else {
      this.enablePortalsFromInterior(0, camera, FULL_SCREEN_RECT);
    }

    this.resolveVisibility();
    this.updateStats();
  }

  enablePortalsFromExterior(depth, camera, frustum = null) {
    this.map.exterior.visible = true;

    for (const doodad of this.map.doodadManager.doodads.values()) {
      this.enableStaticObjectInFrustum(doodad, frustum);
    }

    for (const chank of this.map.chunks.values()) {
      this.enableStaticObjectInFrustum(chank, frustum);
    }

    const wmos = this.map.wmoManager.entries.values();

    for (const wmo of wmos) {
      const groups = wmo.groups.values();

      for (const group of groups) {
        const isExterior = (group.header.flags & WmoFlags.visibilityMask) !== 0;

        // Only concerned with exterior groups.
        if (!isExterior) {
          continue;
        }

        const view = wmo.views.groups.get(group.index);

        // View could still be pending load.
        if (!view) {
          continue;
        }

        // Cache world-space bounding box on group view, invalidated when the root moves.
        const rootMatrixKey = wmo.views.root.matrixWorld.elements.join(',');
        if (!view.worldBoundingBox || view.worldBoundingBoxKey !== rootMatrixKey) {
          view.worldBoundingBox = group.boundingBox.clone().applyMatrix4(wmo.views.root.matrixWorld);
          view.worldBoundingBoxKey = rootMatrixKey;
        }

        // If the current frustum does not include the group view, we can skip it
        // if (!THREEUtil.checkFrustum(frustum, view.worldBoundingBox)) {
        //   continue;
        // }
        if (!THREEUtil.frustumContainsBox(frustum, view.worldBoundingBox)) {
          // console.log(frustum, view)
          continue;
        }

        // Since the camera is in the exterior, all exterior WMO groups are visible.
        view.visibleFrame = this.frame;

        // Doodads within frustum are visible
        for (const doodad of wmo.doodadsForGroup(group)) {
          this.enableStaticObjectInFrustum(doodad, frustum);
        }

        // Traverse inward from the exterior groups of all WMOs, marking any relevant WMO groups
        // as visible.
        this.traversePortalsAndEnable(depth, camera, wmo, group, FULL_SCREEN_RECT);
      }
    }
  }

  enablePortalsFromInterior(depth, camera, rect = FULL_SCREEN_RECT) {
    const wmo = camera.location.wmo.handler;
    const group = camera.location.wmo.group;
    const groupView = camera.location.wmo.views.group;

    // The group the camera is currently in should always be visible
    groupView.visibleFrame = this.frame;

    for (const doodad of wmo.doodadsForGroup(group)) {
      this.enableStaticObjectInRect(doodad, rect);
    }

    this.traversePortalsAndEnable(depth, camera, wmo, group, rect);
  }

  enableStaticObjectInFrustum(object, frustum) {
    // The distance fade runs BEFORE the frustum test: it is far cheaper (two subtractions and a
    // compare against the object's own radius) and it rejects the bulk of a dense zone's props
    // outright. See pipeline/m2/fade/laws.ts for the ported law.
    const radius = object.worldFadeRadius;
    if (radius !== undefined && VisibilityManager.fadeCullEnabled) {
      // World-space translation, NOT `object.position`. A map doodad's parent is at the origin so
      // the two agree, but a WMO doodad's position is local to its building's root -- measuring the
      // camera distance from that would be meaningless.
      const e = object.matrixWorld.elements;
      const dx = e[12] - this.cameraX;
      const dy = e[13] - this.cameraY;
      const horizDist = Math.sqrt(dx * dx + dy * dy);
      const alpha = doodadFadeAlpha(radius, horizDist);

      object.fadeAlpha = alpha;

      // `fade <= 0` means the object contributes nothing and is not added to the draw list at all.
      if (alpha <= 0) {
        return;
      }
    }

    this.refreshWorldBoundingBox(object);

    if (object.worldBoundingBox && THREEUtil.frustumContainsBox(frustum, object.worldBoundingBox)) {
      object.visibleFrame = this.frame;
    }
  }

  /**
   * Recompute the cached world-space bounding box when the object's world matrix has changed.
   *
   * This used to be a compute-once cache with no invalidation, so any object that moved after its
   * first culled frame was tested against a stale box forever.
   *
   * The key is a string built from the matrix elements. That is only acceptable because it is
   * computed once per object and only when the object has actually moved -- a static doodad hits
   * the early return on the identity compare below. If this ever shows up in the HUD's profile,
   * replace it with a numeric revision counter bumped by whatever moves the object.
   */
  refreshWorldBoundingBox(object) {
    const matrix = object.matrixWorld;
    const version = matrix.elements.join(',');

    if (object.worldBoundingBox && object.worldBoundingBoxKey === version) {
      return;
    }

    const source = object.geometry && object.geometry.boundingBox;
    if (!source) {
      return;
    }

    object.worldBoundingBox = source.clone().applyMatrix4(matrix);
    object.worldBoundingBoxKey = version;
  }

  /**
   * Flood the portal graph from `group`, carrying a screen rect that narrows at every portal.
   *
   * Ported from samples/benilla `wmo_portal/mod.rs`. The rect -- NOT a plane frustum -- is the
   * working window, and a branch terminates the instant the rect collapses below RECT_EPS. The
   * plane-frustum version this replaces never terminated on area at all, which is why a city drew
   * every building interior at once (113 visible groups measured in Stormwind).
   *
   * The exterior is still reached the ordinary way -- recursing into `enablePortalsFromExterior`
   * with the narrowed window. The reference's stricter "no window => no exterior at all" gate is
   * deliberately NOT reinstated here: it was tried, and it hid the whole outdoor world because the
   * doorway test keyed on MOGP 0x8 while city streets carry 0x40. That predicate is fixed now
   * (see world/wmo-flags.ts), but the gate needs its own verification pass first.
   */
  /**
   * **THE GLOBAL VISITED SET IS NOT THE REFERENCE'S GUARD, AND IT IS WHY A VISIBLE PORTAL BLINKS.**
   *
   * The owner: "кручу камерой и бывает пропадает явно видимый портал." A portal was marked visited by
   * the FIRST branch that reached it, so a later branch arriving with a WIDER screen rect was
   * discarded -- and which branch arrives first depends on the traversal order, which depends on the
   * camera. Rotate, and a narrow route wins a race it lost a moment ago, taking a room with it.
   *
   * The reference has no such set (`benilla-world/src/wmo_portal/mod.rs:659-723`). Its guards are
   * three, and all three are local or global-but-cheap:
   *
   *  - `neighbour == came` -- never re-cross the portal you entered THROUGH. Per branch, so it stops
   *    the immediate bounce without forbidding a second, better route to the same room;
   *  - a recursion DEPTH cap, which we already had at 10;
   *  - a global ITERATION budget, which is the real cycle backstop: a portal graph can loop, and
   *    without a bound on total work a cycle would spin. It bounds cost, not reachability -- exactly
   *    the distinction the visited set got wrong.
   *
   * So `cameFrom` replaces the set, and `budget` is carried by reference so every branch spends from
   * one pot. `MAX_ITERS` matches the reference's own backstop role: high enough that no honest room
   * ever reaches it, low enough that a cyclic graph cannot spin a frame away.
   *
   * STILL MISSING, and named so it is not silently absent: the ON-PLANE special case. The reference
   * gives the full-screen rect to an eye standing IN a portal's polygon (the client's `0x6b46f0`), and
   * says of its absence: "a camera crossing a doorway clips the room ahead to nothing for a frame."
   * That is a second, independent cause of the same report and it needs a point-in-polygon test we do
   * not have yet.
   */
  traversePortalsAndEnable(depth, camera, wmo, group, rect = FULL_SCREEN_RECT, cameFrom = -1, budget = { left: 4096 }) {
    if (depth > 10) return;
    if (budget.left <= 0) return;
    budget.left -= 1;

    const view = wmo.views.groups.get(group.index);
    if (!view) return;

    SCRATCH_CAMERA_LOCAL.copy(camera.position);
    const cameraLocal = view.worldToLocal(SCRATCH_CAMERA_LOCAL);

    for (const doodad of wmo.doodadsForGroup(group)) {
      this.enableStaticObjectInRect(doodad, rect);
    }

    for (let pindex = 0, pcount = group.portals.length; pindex < pcount; ++pindex) {
      const portal = group.portals[pindex];
      const ref = group.portalRefs[pindex];
      const destination = wmo.groups.get(ref.groupIndex);

      // Destination group is pending load.
      if (!destination) continue;

      const portalView = wmo.views.portals.get(ref.portalIndex);
      const destinationView = wmo.views.groups.get(destination.index);
      const exteriorDestination = (destination.header.flags & WmoFlags.visibilityMask) !== 0;

      if (!portalView || !destinationView) continue;
      // Never re-cross the portal we came THROUGH -- the reference's only per-branch guard. A second
      // route to the same room is allowed, and is the whole point: it may carry a wider window.
      if (ref.groupIndex === cameFrom) continue;

      // Exterior-to-exterior links are already covered by enablePortalsFromExterior.
      if ((group.header.flags & WmoFlags.visibilityMask) !== 0 && exteriorDestination) continue;

      if (portalView.legacyGeometry.vertices.length < 4) continue;

      // The side test: portals are traversed outward only.
      const distance = portal.plane.distanceToPoint(cameraLocal) + 0.001;
      const insidePortal = ref.side < 0 ? distance <= 0 : distance >= 0;
      if (!insidePortal) continue;

      // Narrow the window through this portal. Null means the branch dies here.
      const nextRect = portalView.projectToRect(this.scratchViewProjection, rect, cameraLocal);
      if (!nextRect) continue;

      destinationView.visibleFrame = this.frame;

      if (exteriorDestination && camera.location.type !== 'exterior') {
        this.enablePortalsFromExterior(depth + 1, camera, this.frustumFromRect(nextRect));
      }

      this.traversePortalsAndEnable(depth + 1, camera, wmo, destination, nextRect, group.index, budget);
    }
  }

  /**
   * Admit a static object against a screen-rect window by building that window's sub-frustum.
   *
   * An NDC rect is a scale+offset on clip space, so `rectToNdc * viewProjection` fed to
   * THREE.Frustum extracts the same 6 planes the reference builds by bilerping its corner rays.
   *
   * The returned frustum is shared scratch: consume it immediately, never hold it across a
   * recursion. Use `frustumFromRect` where the value has to outlive the call.
   */
  enableStaticObjectInRect(object, rect) {
    this.enableStaticObjectInFrustum(object, this.frustumForRect(rect));
  }

  frustumForRect(rect) {
    if (rect === FULL_SCREEN_RECT) {
      return this.scratchFrustum;
    }

    const sx = 2 / (rect.maxX - rect.minX);
    const sy = 2 / (rect.maxY - rect.minY);
    const tx = -(rect.maxX + rect.minX) / (rect.maxX - rect.minX);
    const ty = -(rect.maxY + rect.minY) / (rect.maxY - rect.minY);

    this.scratchRectToNdc.set(
      sx, 0, 0, tx,
      0, sy, 0, ty,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );

    this.scratchRectMatrix.multiplyMatrices(this.scratchRectToNdc, this.scratchViewProjection);
    this.scratchRectFrustum.setFromProjectionMatrix(this.scratchRectMatrix);
    return this.scratchRectFrustum;
  }

  /** A window's sub-frustum as its OWN object, safe to hand into a recursion. */
  frustumFromRect(rect) {
    return new THREE.Frustum().copy(this.frustumForRect(rect));
  }

  /**
   * Write the frame's verdict onto `visible`.
   *
   * One pass over each collection, at the end, instead of a "hide everything" sweep at the start
   * plus an enable sweep in the middle -- which touched every loaded object at least twice per
   * frame before any culling decision existed.
   */
  resolveVisibility() {
    const frame = this.frame;

    for (const chunk of this.map.chunks.values()) {
      chunk.visible = chunk.visibleFrame === frame;
    }

    for (const doodad of this.map.doodadManager.doodads.values()) {
      doodad.visible = doodad.visibleFrame === frame;
    }

    for (const wmo of this.map.wmoManager.entries.values()) {
      for (const group of wmo.groups.values()) {
        const view = wmo.views.groups.get(group.index);
        if (view) {
          view.visible = view.visibleFrame === frame;
        }
      }

      for (const doodad of wmo.doodads.values()) {
        doodad.visible = doodad.visibleFrame === frame;
      }
    }
  }

  updateStats() {
    let visibleGroupCount = 0;
    let visibleDoodadCount = 0;

    const wmos = this.map.wmoManager.entries.values();

    for (const wmo of wmos) {
      const groups = wmo.groups.values();
      const doodads = wmo.doodads.values();

      for (const group of groups) {
        const view = wmo.views.groups.get(group.index);

        // View can be pending load
        if (!view) {
          continue;
        }

        if (view.visible) {
          visibleGroupCount++;
        }
      }

      for (const doodad of doodads) {
        if (doodad.visible) {
          visibleDoodadCount++;
        }
      }
    }

    let visibleChunkCount = 0;
    for (const chunk of this.map.chunks.values()) {
      if (chunk.visible) {
        visibleChunkCount++;
      }
    }

    let visibleMapDoodadCount = 0;
    for (const doodad of this.map.doodadManager.doodads.values()) {
      if (doodad.visible) {
        visibleMapDoodadCount++;
      }
    }

    this.stats.map.visibleChunks = visibleChunkCount;
    this.stats.map.visibleDoodads = visibleMapDoodadCount;

    this.stats.wmo.visibleGroups = visibleGroupCount;
    this.stats.wmo.visibleDoodads = visibleDoodadCount;
  }

}

// Exposed for live debugging from the browser console -- the `fadeCullEnabled` A/B above needs a
// handle on the class, not an instance. Guarded because the pure-logic tests run under
// `@jest-environment node`, where `window` does not exist.
if (typeof window !== 'undefined') {
  window.VisibilityManager = VisibilityManager;
}

export default VisibilityManager;


// import * as THREE from 'three';

// import THREEUtil from '../utils/three-util';

// class VisibilityManager {

//   constructor(map) {
//     this.map = map;

//     this.stats = {
//       wmo: {
//         visibleGroups: 0,
//         visibleDoodads: 0
//       }
//     };
//   }

//   update(cameras) {
//     if (!this.map) {
//       return;
//     }

//     // Hide the exterior world (doodads and terrain) until a traversal reaches the exterior
//     this.map.exterior.visible = false;

//     this.hideAllMapDoodads();
//     this.hideAllWMOGroups();
//     this.hideAllWMODoodads();

//     for (const camera of cameras) {
//       if (!camera.location) {
//         continue;
//       }

//       camera.updateMatrix();
//       camera.updateMatrixWorld();

//       // Obtain a frustum matching the camera
//       const frustum = new THREE.Frustum();
//       frustum.setFromMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

//       // Adjust near plane (5) back to camera position
//       const nearGap = frustum.planes[5].distanceToPoint(camera.position);
//       frustum.planes[5].constant -= nearGap;

//       if (camera.location.type === 'exterior') {
//         this.enablePortalsFromExterior(0, camera, frustum);
//       } else {
//         this.enablePortalsFromInterior(0, camera, frustum);
//       }
//     }

//     this.updateStats();
//   }

//   enablePortalsFromExterior(depth, camera, frustum = null, visitedPortals = new Set()) {
//     this.map.exterior.visible = true;

//     for (const doodad of this.map.doodadManager.doodads.values()) {
//       this.enableStaticObjectInFrustum(doodad, frustum);
//     }

//     const wmos = this.map.wmoManager.entries.values();

//     for (const wmo of wmos) {
//       const groups = wmo.groups.values();

//       for (const group of groups) {
//         const isExterior = (group.header.flags & 0x08) !== 0;

//         // Only concerned with exterior groups.
//         if (!isExterior) {
//           continue;
//         }

//         const view = wmo.views.groups.get(group.index);

//         // View could still be pending load.
//         if (!view) {
//           continue;
//         }

//         // Cache world-space bounding box on group view
//         if (!view.worldBoundingBox) {
//           view.worldBoundingBox = group.boundingBox.clone().applyMatrix4(wmo.views.root.matrixWorld);
//         }

//         // If the current frustum does not include the group view, we can skip it
//         if (!THREEUtil.frustumContainsBox(frustum, view.worldBoundingBox)) {
//           continue;
//         }

//         // Since the camera is in the exterior, all exterior WMO groups are visible.
//         view.visible = true;

//         // Doodads within frustum are visible
//         for (const doodad of wmo.doodadsForGroup(group)) {
//           this.enableStaticObjectInFrustum(doodad, frustum);
//         }

//         // Traverse inward from the exterior groups of all WMOs, marking any relevant WMO groups
//         // as visible.
//         this.traversePortalsAndEnable(depth, camera, wmo, group, frustum, visitedPortals);
//       }
//     }
//   }

//   enablePortalsFromInterior(depth, camera, frustum = null, visitedPortals = new Set()) {
//     const wmo = camera.location.wmo.handler;
//     const group = camera.location.wmo.group;
//     const groupView = camera.location.wmo.views.group;

//     // The group the camera is currently in should always be visible
//     groupView.visible = true;

//     // Doodads within frustum are visible
//     for (const doodad of wmo.doodadsForGroup(group)) {
//       this.enableStaticObjectInFrustum(doodad, frustum);
//     }

//     // Traverse outward from the given group, marking any relevant WMO groups as visible
//     this.traversePortalsAndEnable(depth, camera, wmo, group, frustum, visitedPortals);
//   }

//   enableStaticObjectInFrustum(object, frustum) {
//     // Cache world-space bounding box
//     if (!object.worldBoundingBox) {
//       object.worldBoundingBox = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
//     }

//     if (THREEUtil.frustumContainsBox(frustum, object.worldBoundingBox)) {
//       object.visible = true;
//     }
//   }

//   traversePortalsAndEnable(depth, camera, wmo, group, frustum = null, visitedPortals = new Set()) {
//     const view = wmo.views.groups.get(group.index);

//     const cameraLocal = view.worldToLocal(camera.position.clone());

//     // Doodads within frustum are visible
//     for (const doodad of wmo.doodadsForGroup(group)) {
//       this.enableStaticObjectInFrustum(doodad, frustum);
//     }

//     for (let pindex = 0, pcount = group.portals.length; pindex < pcount; ++pindex) {
//       const portal = group.portals[pindex];
//       const ref = group.portalRefs[pindex];
//       const destination = wmo.groups.get(ref.groupIndex);

//       // Destination group is pending load
//       if (!destination) {
//         continue;
//       }

//       const portalView = wmo.views.portals.get(ref.portalIndex);
//       const destinationView = wmo.views.groups.get(destination.index);
//       const exteriorDestination = (destination.header.flags & 0x08) !== 0;

//       // Destination group's view is pending load
//       if (!destinationView) {
//         continue;
//       }

//       // Already visited this portal, so we're done
//       if (visitedPortals.has(portalView)) {
//         continue;
//       }

//       // Exterior to exterior links are already covered by enablePortalsFromExterior
//       if ((group.header.flags & 0x08) !== 0 && exteriorDestination) {
//         continue;
//       }

//       const distance = portal.plane.distanceToPoint(cameraLocal) * ref.side + 0.001;
//       const insidePortal = distance < 0.0;

//       // Portals must be traversed outward
//       if (insidePortal) {
//         continue;
//       }

//       // Portal out of group is not visible from previous frustum
//       if (frustum !== null && !portalView.intersectFrustum(frustum)) {
//         continue;
//       }

//       // Portal out of group is visible, thus the destination group is visible
//       destinationView.visible = true;

//       // Track visited portals to prevent duplicate work
//       visitedPortals.add(portalView);

//       // Project a frustum out of this portal for use in the next level of recursion
//       const nextFrustum = portalView.createFrustum(camera, frustum, ref.side < 0);

//       if (!nextFrustum) {
//         continue;
//       }

//       // Portal out of group is to exterior and camera is not already in exterior, thus we need
//       // to traverse and enable exterior groups
//       if (exteriorDestination && camera.location.type !== 'exterior') {
//         this.enablePortalsFromExterior(depth + 1, camera, nextFrustum, visitedPortals);
//       }

//       // Recurse
//       this.traversePortalsAndEnable(depth + 1, camera, wmo, destination, nextFrustum, visitedPortals);
//     }
//   }

//   hideAllWMOGroups() {
//     const wmos = this.map.wmoManager.entries.values();

//     for (const wmo of wmos) {
//       const groups = wmo.groups.values();

//       for (const group of groups) {
//         const view = wmo.views.groups.get(group.index);

//         // View can be pending load
//         if (!view) {
//           continue;
//         }

//         view.visible = false;
//       }
//     }
//   }

//   hideAllWMODoodads() {
//     const wmos = this.map.wmoManager.entries.values();

//     for (const wmo of wmos) {
//       const doodads = wmo.doodads.values();

//       for (const doodad of doodads) {
//         doodad.visible = false;
//       }
//     }
//   }

//   hideAllMapDoodads() {
//     for (const doodad of this.map.doodadManager.doodads.values()) {
//       doodad.visible = false;
//     }
//   }

//   updateStats() {
//     let visibleGroupCount = 0;
//     let visibleDoodadCount = 0;

//     const wmos = this.map.wmoManager.entries.values();

//     for (const wmo of wmos) {
//       const groups = wmo.groups.values();
//       const doodads = wmo.doodads.values();

//       for (const group of groups) {
//         const view = wmo.views.groups.get(group.index);

//         // View can be pending load
//         if (!view) {
//           continue;
//         }

//         if (view.visible) {
//           visibleGroupCount++;
//         }
//       }

//       for (const doodad of doodads) {
//         if (doodad.visible) {
//           visibleDoodadCount++;
//         }
//       }
//     }

//     this.stats.wmo.visibleGroups = visibleGroupCount;
//     this.stats.wmo.visibleDoodads = visibleDoodadCount;
//   }

// }

// export default VisibilityManager;