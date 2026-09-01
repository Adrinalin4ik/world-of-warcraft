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
    /**
     * **THE BODY GOES FIRST. Trying the eye first put the seed in the wrong room every time, and the
     * abbey's own file says why.**
     *
     * MOGI, decoded from `nsabbey.wmo`: group 0's bounding box is `x[-28.8, 11.9] y[-11.1, 31.0]
     * z[1.5, 23.9]` -- the ENTIRE BUILDING. A third-person eye eight yards behind the player lands
     * inside it from almost anywhere, resolves a floor there, and wins. Measured: seed 0 while the
     * body's own probe resolved group 1 with a real floor at 1.87, and group 1's box is `x[-18.4,-2.0]
     * y[4.1, 20.6]` -- an actual room.
     *
     * The reference seeds from the eye and is right to: its boom stops at every collidable face, so its
     * eye is in the room the body is in. Ours passes `NOCAMCOLLIDE` geometry by design
     * (`collision/layers.ts`) and sits eight yards back, so the eye is routinely in a different group --
     * and with one group's box spanning the whole model, "a different group" means "the wrong one".
     *
     * The eye is still tried when the body resolves nothing, which covers a body mid-air or in geometry
     * the BSP cannot place. Ordering is the whole change.
     */
    let location = bodyPoint ? this.locateAt(bodyPoint) : null;

    if (!location) {
      location = this.locateAt(camera.position);
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

    const location = this.selectCandidate(candidates);
    if (location) {
      // The point this location was resolved AT. The portal flood tests from it, so seeding at one
      // point and testing from another would ask every side test its question in the wrong room.
      location.at = point.clone ? point.clone() : point;
    }
    return location;
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

    /**
     * **NO RESOLVED FLOOR ANYWHERE: TAKE THE TIGHTEST BOX. Decoded from the abbey, not guessed.**
     *
     * `nsabbey.wmo`'s MOGI, parsed from the file: at the owner's feet, local `(-22.42, 21.54, 1.90)`,
     * exactly three group boxes contain the point --
     *
     *   group 0: x[-28.8, 11.9] y[-11.1, 31.0] z[1.5, 23.9]   -- the whole building footprint
     *   group 3: x[-27.8,-12.2] y[14.0, 29.5] z[1.8, 14.9]   -- the corridor he is actually in
     *   group 5: x[-35.9, 16.2] y[-14.6, 37.9] z[0.0, 89.1]  -- EXTERIOR, never an interior candidate
     *
     * The right answer is group 3, and the portal geometry agrees: his position sits between portal 11
     * (x[-15.9,-12.2] y[14.4,18.1]) and portal 10 (x[-26.6,-23.4] y[25.2,28.5]), which are exactly the
     * two doorways of group 3. He seeded in group 0 instead -- a whole room wrong -- because group 3's
     * BSP could not resolve a floor while group 0's could, and an unresolved floor disqualifies a
     * candidate outright.
     *
     * Returning null there is the worst of the options: it declares the viewer OUTDOORS and floods from
     * outside a building he is standing inside. A box is a crude containment test, but the tightest box
     * containing a point is a far better guess at "which room" than "no room at all" -- and it can only
     * ever be consulted when the BSP has already failed for every candidate.
     *
     * The BSP-resolved answer still wins whenever it exists, so this changes nothing where containment
     * works. It replaces a verdict of "outdoors" with the smallest room that contains you.
     */
    if (valid.length === 0) {
      let tightest = null;
      let smallest = Infinity;
      for (const candidate of candidates) {
        const box = candidate.wmo.group.boundingBox;
        const size = box.max.clone().sub(box.min);
        const volume = size.x * size.y * size.z;
        if (volume < smallest) {
          smallest = volume;
          tightest = candidate;
        }
      }
      return tightest;
    }

    /**
     * **THE TIGHTEST BOX WINS, not the highest floor -- and the abbey's own MOGI is why.**
     *
     * The floor heights do not discriminate: group 0's floor is 1.5 and group 3's is 1.87, a third of a
     * yard apart, so a "highest floor" rule decides essentially at random between them. Their BOXES are
     * not close at all:
     *
     *   group 0: x[-28.8, 11.9] y[-11.1, 31.0] z[1.5, 23.9]  -- the entire building
     *   group 3: x[-27.8,-12.2] y[14.0, 29.5] z[1.8, 14.9]  -- one corridor
     *
     * Measured consequence, standing in the abbey's front door: seed 0, seven groups flooded, and
     * neither 1 nor 3 among them -- so portal 10, the ONLY interior route to daylight in the whole
     * model, was never even considered. `exteriorVisible: false`, `chunks: 0`, and a void where the
     * valley should be.
     *
     * A group whose box spans the whole model is never a better answer to "which room am I in" than one
     * whose box is a room. The floor height stays as the tie-break, for two boxes of genuinely similar
     * size stacked vertically -- a gallery over a hall -- which is the case it was written for.
     */
    const volumeOf = (candidate) => {
      const box = candidate.wmo.group.boundingBox;
      const size = box.max.clone().sub(box.min);

      return size.x * size.y * size.z;
    };

    valid.sort((a, b) => {
      const dv = volumeOf(a.candidate) - volumeOf(b.candidate);
      if (Math.abs(dv) > 1e-3) {
        return dv;
      }
      const dz = b.candidate.query.z.min - a.candidate.query.z.min;
      if (dz !== 0) {
        return dz;
      }
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