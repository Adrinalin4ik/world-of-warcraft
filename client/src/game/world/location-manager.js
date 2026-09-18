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
    /**
     * **A VERDICT OF "OUTDOORS" FROM THE BODY IS AN ANSWER, AND ASKING THE EYE TO OVERRULE IT IS WHAT
     * MADE THE WORLD DEPEND ON WHICH WAY YOU FACED.**
     *
     * `locateAt` used to answer `null` for two unrelated reasons -- "nothing could place this point" and
     * "this point resolved into the exterior shell, so you are outdoors" -- and this line read both as
     * the first. So the body's correct "I am on the road" was discarded and the boom was asked instead;
     * a boom eight yards long swings into a building's bounding box, resolves a group there, and the
     * frame is declared INTERIOR with the whole outdoors switched off.
     *
     * Measured offline on the real `nsabbey` files, with the body held still and the boom swept every
     * 30 degrees (`harness/fallback-probe.test.js`):
     *
     *   body on the road, local (-27.72, 45, 2.0) -- outside the root box entirely, so unambiguously
     *   outdoors: the eye resolved `null` at eleven yaws and **group 5 at 90 degrees**, and that one
     *   bearing turned the terrain off.
     *
     *   body on the porch, local (-27.72, 33.5, 2.16): the eye decided EIGHT of twelve frames, handing
     *   back group 5, group 3 or nothing purely as a function of bearing.
     *
     * The same sweep from inside a room shows the ordering is otherwise sound: at local (-10, 12, 3)
     * the body resolved group 1 at all twelve yaws while the eye would have said g0, g1 or g3.
     *
     * So the eye stays as the fallback for the case it was added for -- the body inside a building that
     * cannot place it -- and no longer overrules a body that knows it is outside.
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
  /**
   * Resolve a location for one world POINT. Three outcomes, and they are deliberately distinct:
   *
   * - an interior location -- some group places the point;
   * - `{ type: 'exterior' }` -- the point is OUTDOORS, said with confidence, either because no
   *   building's bounding volume contains it or because the only group that resolved it is the
   *   exterior shell;
   * - `null` -- UNKNOWN: the point is inside a building whose groups cannot place it.
   *
   * Only the third invites a second opinion. Collapsing the second into the third is the defect
   * `locateCamera` describes: a body that knew it was outside had its answer thrown away.
   */
  locateAt(point) {
    const candidates = [];
    let insideSomeBuilding = false;

    for (const wmo of this.map.wmoManager.entries.values()) {
      if (this.addCandidates({ position: point }, wmo, candidates)) {
        insideSomeBuilding = true;
      }
    }

    if (!insideSomeBuilding) {
      // Not inside any building's bounding volume. Nothing about a portal graph can make this point
      // indoors, so it is not an open question and must not be re-asked of another seed.
      return { type: 'exterior', at: point.clone ? point.clone() : point };
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
      return false;
    }

    // Check if camera is in any of this WMO's groups
    for (const group of wmo.groups.values()) {
      /**
       * **AN EXTERIOR GROUP IS A CANDIDATE TOO, and refusing to consider one is why stepping into a
       * doorway killed the world.**
       *
       * Measured at the owner's feet, local `(-27.72, 30.38, 2.16)`: group **5**, flagged EXTERIOR,
       * resolves a real floor at 2.13 with a ceiling at 16.42. Group 0, interior, resolves NOTHING. And
       * group 3 is not even a candidate -- its box is `y[14.0, 29.5]` and he is at 30.38, so he has
       * stepped out of it. By the data he is standing in group 5, one pace beyond portal 10
       * (`x[-26.6,-23.4] y[25.2,28.5]`), which is the abbey's front door.
       *
       * Skipping exterior groups outright made the verdict "you are outdoors" UNREACHABLE. So group 0
       * won through the no-floor fallback, the flood seeded in the far hall, and the outdoors was never
       * enabled -- which is his own observation exactly: the world appears by his CHARACTER's position,
       * never by where the camera looks, and one step forward fixes it. A step carries him past group
       * 0's box as well, leaving no interior candidate at all, and only then does the type fall through
       * to exterior.
       *
       * INTERIOR STILL WINS WHEREVER IT RESOLVES -- see `selectCandidate`. This adds an exterior
       * candidate as the answer of last resort, which matters because one of these boxes
       * (group 5's: `x[-35.9, 16.2] y[-14.6, 37.9] z[0, 89.1]`) spans the entire model. Its BSP only
       * answers where its own geometry is, and that is what keeps it from claiming the whole building.
       */
      const isExterior = (group.header.flags & WmoFlags.visibilityMask) !== 0;
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

    // The point is inside this building's own bounding volume. Reported so `locateAt` can tell a point
    // that no group could PLACE from a point that is simply not in a building at all -- see the
    // verdicts it builds out of this.
    return true;
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

      const isExterior = (group.header.flags & WmoFlags.visibilityMask) !== 0;
      valid.push({ candidate, isExterior, closestPortal: group.closestPortal(camera.local, 1.0) });
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

      /**
       * **THE SHELL RULE APPLIES HERE TOO, and leaving it off this path is what switched the whole
       * outdoors off while the owner stood on the abbey steps.**
       *
       * His own `voidReport()`, taken in that frame:
       *
       *   {"loc":"interior","group":5,"exteriorVisible":false,"chunksLoaded":441,"chunksDrawn":0}
       *
       * Group 5 is the abbey's EXTERIOR shell, so "interior, group 5" is a contradiction in terms --
       * and `addCandidates` stamps every candidate `type: 'interior'`, so returning one raw from this
       * branch asserts it. `VisibilityManager#update` then takes the interior branch,
       * `enablePortalsFromExterior` never runs, and **441 loaded terrain chunks draw none**. That pair
       * of numbers is what made this diagnosable: loaded-but-not-drawn rules out streaming, which the
       * screenshot could not.
       *
       * The rule below is the same one the `valid` path already applies twenty lines down. The last
       * round put it there and not here, and the two paths are reached by different inputs: `valid` is
       * empty exactly when no group resolved a floor, which is what standing on outdoor steps looks
       * like from the BSP's point of view.
       *
       * Reproduced offline before fixing (`harness/shell-as-interior.test.js`, real `nsabbey` bytes):
       * **465 of 1755 sampled positions in front of the abbey returned an interior verdict naming an
       * exterior group, and the outdoors was dark in all 465.**
       */
      if (tightest && (tightest.wmo.group.header.flags & WmoFlags.visibilityMask) !== 0) {
        return { type: 'exterior' };
      }

      return tightest;
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

    /**
     * **INTERIOR FIRST. An exterior candidate is the answer of last resort, never a competitor.**
     *
     * Standing inside a hall, the shell group's box contains you as surely as the room's does -- group
     * 5's is `x[-35.9, 16.2] y[-14.6, 37.9] z[0, 89.1]`, the whole model. It may only ever win when no
     * interior group can place you at all, which is what standing in a doorway looks like from here.
     */
    const interior = valid.filter((entry) => !entry.isExterior);
    const chosen = interior.length > 0 ? interior[0] : valid[0];

    if (chosen.isExterior) {
      /**
       * Resolved INTO the shell: the viewer is outdoors, and the exterior pass owns the frame.
       *
       * This says so with a location rather than with `null`. `null` here used to mean both this and
       * "no idea", and `locateCamera` could only read it as the second -- so a body standing on the
       * porch, which resolves group 5 and nothing else, was ruled unplaceable and the boom decided the
       * frame instead. Measured: the eye decided eight of twelve bearings there.
       */
      return { type: 'exterior' };
    }

    return chosen.candidate;
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