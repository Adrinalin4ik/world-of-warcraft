import * as THREE from 'three';
import { WmoFlags } from './wmo-flags';
import DebugPanel from '../../pages/game/debug/debug';

class LocationManager {

  constructor(map) {
    this.map = map;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.raycastUp = new THREE.Vector3(0, 0, 1);
    this.raycastUp.firstHitOnly = true;
    this.raycastDown = new THREE.Vector3(0, 0, -1);
    this.raycastDown.firstHitOnly = true;
  }

  /**
   * Iterate over the set of given cameras, and attempt to identify each camera's location relative
   * to map geometry. This location serves as the starting point when traversing WMO groups as
   * part of portal culling.
   *
   * Possible location results:
   * - exterior: camera is either not in a WMO, or is in a WMO group marked as exterior
   * - interior: camera is in a specific WMO and WMO group, and WMO group is marked as interior
   */
  update(cameras, bodyPoint = null) {
    for (const camera of cameras) {
      this.locateCamera(camera, bodyPoint);
    }
  }

  /**
   * **THE BODY IS THE FALLBACK SEED, because a third-person eye is routinely outside the room.**
   *
   * Measured: the owner's eye resolved to local `(-12.42, 18.30, 8.67)` while his feet were at
   * `(-22.42, 21.54, 1.90)` -- ten yards away horizontally and seven up. The boom had carried it clean
   * out of the hall, so no group contained it, the location came back EXTERIOR, and the interior flood
   * never ran. `portalTrace` said it outright: no `seed` record at all, and the only traversals were
   * exterior ones through buildings 630 yd away.
   *
   * The reference seeds from the eye too, and can afford to: its boom stops at every collidable face,
   * so its camera cannot leave the room. Ours passes `NOCAMCOLLIDE` geometry by design
   * (`collision/layers.ts`), so our eye leaves rooms the body cannot. Given that, the BODY is the
   * better authority on which room to draw -- it is the thing standing in it.
   *
   * The eye is still tried FIRST, so nothing changes wherever it resolves. This fills only the case
   * that used to fall through to "outdoors" and draw the world from the wrong room.
   */
  locateCamera(camera, bodyPoint = null) {
    let location = this.locateAt(camera.position);

    if (!location && bodyPoint) {
      location = this.locateAt(bodyPoint);
    }
    if (location) {
      camera.location = location;
      // console.log("Interior")
    } else {
      camera.location = {
        type: 'exterior'
      };
    }
  }

  /** Resolve a location for one world POINT, or null. Both seeds go through this. */
  locateAt(point) {
    const candidates = [];

    for (const wmo of this.map.wmoManager.entries.values()) {
      this.addCandidates({ position: point }, wmo, candidates);
    }

    return this.selectCandidate(candidates);
  }

  addCandidates(camera, wmo, candidates) {
    // The root view needs to have loaded before we can try locate the camera in this WMO
    if (!wmo.views.root) {
      return;
    }
    const cameraLocal = wmo.views.root.worldToLocal(camera.position.clone());
    // All operations assume the camera position is in local space
    // const cameraLocalConverted = new THREE.Vector3(cameraLocal.x, cameraLocal.y, cameraLocal.z)
    // let cameraLocal = wmo.views.root.localToWorld(camera.position.clone());
    // cameraLocal = new THREE.Vector3(-cameraLocal.x, -cameraLocal.y, cameraLocal.z)
    // const cameraLocal = camera.position.clone()
    // console.log(cameraLocal)

    // Check if camera could be inside this WMO
    const maybeInsideWMO = wmo.root.boundingBox.containsPoint(cameraLocal);
    // Camera cannot be inside this WMO
    if (!maybeInsideWMO) {
      return;
    }

    // Check if camera is in any of this WMO's groups
    for (const group of wmo.groups.values()) {
      // Only hunting for interior groups. See world/wmo-flags.ts for which bits decide this and
      // why the visibility class is not the same law as the lighting class.
      const isExterior = (group.header.flags & WmoFlags.visibilityMask) !== 0;
      if (isExterior) {
        continue;
      }
      // console.log(isExterior)
      
      // Check if camera could be inside this group
      const maybeInsideGroup = group.boundingBox.containsPoint(cameraLocal);
      
      // Camera cannot be inside this group
      if (!maybeInsideGroup) {
        continue;
      }
      // console.log(group.boundingBox, cameraLocal)
      // Query BSP tree for matching leaves
      let result = group.bspTree.queryBoundedPoint(cameraLocal, group.boundingBox);
      
      // console.log(result)
      // Depending on group geometry, interior portions of a group may lack BSP leaves
      if (result === null) {
        result = {
          z: {
            min: null,
            max: null
          }
        };
      }

      // Attempt to find unbounded Zs by raycasting the Z axis against portals
      if (result.z.min === null || result.z.max === null) {
        const portalViews = [];

        for (const portalRef of group.portalRefs) {
          const portalView = wmo.views.portals.get(portalRef.portalIndex);
          portalViews.push(portalView);
        }

        // Unbounded max Z (raycast up to try find portal)
        if (result.z.max === null) {
          this.raycaster.set(camera.position, this.raycastUp);
          const upIntersections = this.raycaster.intersectObjects(portalViews);

          if (upIntersections.length > 0) {
            const closestUp = upIntersections[0];
            result.z.max = closestUp.object.worldToLocal(closestUp.point).z;
          }
        }

        // Unbounded min Z (raycast down to try find portal)
        if (result.z.min === null) {
          this.raycaster.set(camera.position, this.raycastDown);
          const downIntersections = this.raycaster.intersectObjects(portalViews);
          // console.log(downIntersections)

          if (downIntersections.length > 0) {
            const closestDown = downIntersections[0];
            result.z.min = closestDown.object.worldToLocal(closestDown.point).z;
          }
        }
      }
      // console.log(result.z.min)
      const location = {
        type: 'interior',
        query: result,
        camera: {
          local: cameraLocal,
          world: camera.position
        },
        wmo: {
          handler: wmo,
          root: wmo.root,
          group: group,
          views: {
            root: wmo.views.root,
            group: wmo.views.groups.get(group.index)
          }
        }
      };
      // console.log("Interior", location)
      candidates.push(location);
    }
  }

  /**
   * **WHICH GROUP THE CAMERA IS IN. Every rule in here was commented out, and that is the root of a
   * week's worth of the owner's reports.**
   *
   * What was live: candidates whose `z.min` was unresolved became `null` but were NOT removed; the
   * sort compared `undefined - undefined`, i.e. `NaN`, so it did not reorder; and `[0]` was taken --
   * the first interior group in `Map` order whose BOUNDING BOX contains the point. WMO group boxes
   * overlap almost completely inside a building, so that is group 0, always.
   *
   * The consequence, measured: `portalTrace` reported `seed: 0` while the collision under his feet
   * named group **5**. The flood therefore started in the wrong room and reached 5 groups of 14 --
   * 0, 2, 8, 9, 13 -- and the floor he was standing on was never among them. That is the void, the
   * disappearing building, the room over dirt: one wrong seed, four disguises.
   *
   * THE RULE IS THE ONE THIS FILE ALREADY STATED, in a comment above the code that implemented it:
   * "The correct candidate has the highest min Z bound of all remaining candidates". Among the groups
   * that genuinely contain the eye, the one whose floor is highest is the room you are standing in --
   * a gallery over a hall, an upper storey over a lower.
   *
   * So, in order: reject a candidate with no resolved floor; reject one whose Z range does not contain
   * the eye; take the highest floor of what is left; break a tie on the nearest portal, which is what
   * the live sort was reaching for.
   *
   * The portal-side rejection stays out. It was commented too, and it is a second rule with its own
   * failure mode -- restoring two at once would leave neither attributable, which is the mistake this
   * thread has already made repeatedly.
   */
  selectCandidate(candidates) {
    const valid = [];

    for (const candidate of candidates) {
      const { camera, query } = candidate;
      const { group } = candidate.wmo;

      // No floor was resolved, by the BSP or by a portal raycast: we cannot say we are inside.
      if (query.z.min === null) {
        continue;
      }
      // Assume the bounding box max when the ceiling is unbounded -- the original intent, kept.
      if (query.z.max === null) {
        query.z.max = group.boundingBox.max.z;
      }

      // The test that was commented out. Without it a group whose floor is twenty yards below still
      // counted as containing the eye.
      if (camera.local.z < query.z.min || camera.local.z > query.z.max) {
        continue;
      }

      valid.push({ candidate, closestPortal: group.closestPortal(camera.local, 1.0) });
    }

    if (valid.length === 0) {
      return null;
    }

    valid.sort((a, b) => {
      const dz = b.candidate.query.z.min - a.candidate.query.z.min;
      if (dz !== 0) {
        return dz;
      }
      // Tie: the nearer portal, which is what the previous sort was attempting on its own.
      const ad = a.closestPortal ? a.closestPortal.distance : Infinity;
      const bd = b.closestPortal ? b.closestPortal.distance : Infinity;
      return ad - bd;
    });

    return valid[0].candidate;
  }
}

export default LocationManager;


// import * as THREE from 'three';

// class LocationManager {

//   constructor(map) {
//     this.map = map;

//     this.raycaster = new THREE.Raycaster();
//     this.raycastUp = new THREE.Vector3(0, 0, 1);
//     this.raycastDown = new THREE.Vector3(0, 0, -1);
//   }

//   /**
//    * Iterate over the set of given cameras, and attempt to identify each camera's location relative
//    * to map geometry. This location serves as the starting point when traversing WMO groups as
//    * part of portal culling.
//    *
//    * Possible location results:
//    * - exterior: camera is either not in a WMO, or is in a WMO group marked as exterior
//    * - interior: camera is in a specific WMO and WMO group, and WMO group is marked as interior
//    */
//   update(cameras) {
//     for (const camera of cameras) {
//       this.locateCamera(camera);
//     }
//   }

//   locateCamera(camera) {
//     const candidates = [];

//     for (const wmo of this.map.wmoManager.entries.values()) {
//       this.addCandidates(camera, wmo, candidates);
//     }

//     const location = this.selectCandidate(candidates);

//     if (location) {
//       camera.location = location;
//     } else {
//       camera.location = {
//         type: 'exterior'
//       };
//     }
//   }

//   addCandidates(camera, wmo, candidates) {
//     // The root view needs to have loaded before we can try locate the camera in this WMO
//     if (!wmo.views.root) {
//       return;
//     }

//     // All operations assume the camera position is in local space
//     const cameraLocal = wmo.views.root.worldToLocal(camera.position.clone());

//     // Check if camera could be inside this WMO
//     const maybeInsideWMO = wmo.root.boundingBox.containsPoint(cameraLocal);

//     // Camera cannot be inside this WMO
//     if (!maybeInsideWMO) {
//       return;
//     }

//     // Check if camera is in any of this WMO's groups
//     for (const group of wmo.groups.values()) {
//       // Only hunting for interior groups
//       if (group.header.flags & 0x08) {
//         continue;
//       }

//       // Check if camera could be inside this group
//       const maybeInsideGroup = group.boundingBox.containsPoint(cameraLocal);

//       // Camera cannot be inside this group
//       if (!maybeInsideGroup) {
//         continue;
//       }

//       // Query BSP tree for matching leaves
//       let result = group.bspTree.queryBoundedPoint(cameraLocal, group.boundingBox);

//       // Depending on group geometry, interior portions of a group may lack BSP leaves
//       if (result === null) {
//         result = {
//           z: {
//             min: null,
//             max: null
//           }
//         };
//       }

//       // Attempt to find unbounded Zs by raycasting the Z axis against portals
//       if (result.z.min === null || result.z.max === null) {
//         const portalViews = [];

//         for (const portalRef of group.portalRefs) {
//           const portalView = wmo.views.portals.get(portalRef.portalIndex);
//           portalViews.push(portalView);
//         }

//         // Unbounded max Z (raycast up to try find portal)
//         if (result.z.max === null) {
//           this.raycaster.set(camera.position, this.raycastUp);
//           const upIntersections = this.raycaster.intersectObjects(portalViews);

//           if (upIntersections.length > 0) {
//             const closestUp = upIntersections[0];
//             result.z.max = closestUp.object.worldToLocal(closestUp.point).z;
//           }
//         }

//         // Unbounded min Z (raycast down to try find portal)
//         if (result.z.min === null) {
//           this.raycaster.set(camera.position, this.raycastDown);
//           const downIntersections = this.raycaster.intersectObjects(portalViews);

//           if (downIntersections.length > 0) {
//             const closestDown = downIntersections[0];
//             result.z.min = closestDown.object.worldToLocal(closestDown.point).z;
//           }
//         }
//       }

//       const location = {
//         type: 'interior',
//         query: result,
//         camera: {
//           local: cameraLocal,
//           world: camera.position
//         },
//         wmo: {
//           handler: wmo,
//           root: wmo.root,
//           group: group,
//           views: {
//             root: wmo.views.root,
//             group: wmo.views.groups.get(group.index)
//           }
//         }
//       };

//       candidates.push(location);
//     }
//   }

//   selectCandidate(candidates) {
//     // Adjust bounds and mark invalid candidates
//     const adjustedCandidates = candidates.map((candidate) => {
//       const { camera, query } = candidate;
//       const { group } = candidate.wmo;

//       // If a query didn't get a min Z bound from the BSP tree or from raycasting for portals, the
//       // candidate is invalid.
//       if (query.z.min === null) {
//         return null;
//       }

//       // Assume the bounding box max in cases where max Z is unbounded
//       if (query.z.max === null) {
//         query.z.max = group.boundingBox.max.z;
//       }

//       const cameraInBoundsZ =
//         camera.local.z >= query.z.min &&
//         camera.local.z <= query.z.max;

//       if (!cameraInBoundsZ) {
//         return null;
//       }

//       // Get the closest portal within a small range and ensure we're inside it
//       const closestPortal = group.closestPortal(camera.local, 1.0);

//       if (closestPortal !== null) {
//         const outsidePortal = closestPortal.portalRef.side * closestPortal.distance < 0.0;

//         if (outsidePortal) {
//           return null;
//         }
//       }

//       return candidate;
//     });

//     // Remove invalid candidates
//     const validCandidates = adjustedCandidates.filter((candidate) => candidate !== null);

//     // No valid candidates
//     if (validCandidates.length === 0) {
//       return null;
//     }

//     // The correct candidate has the highest min Z bound of all remaining candidates
//     validCandidates.sort((a, b) => {
//       if (a.query.z.min > b.query.z.min) {
//         return -1;
//       } else if (a.query.z.min < b.query.z.min) {
//         return 1;
//       } else {
//         return 0;
//       }
//     });

//     return validCandidates[0];
//   }

// }

// export default LocationManager;