import * as THREE from 'three';

import DebugPanel from '../../pages/game/debug/debug';
import THREEUtil from '../utils/three-util';


export const ObjectsManager = [];

class VisibilityManager {

  constructor(map) {
    this.map = map;

    this.stats = {
      wmo: {
        visibleGroups: 0,
        visibleDoodads: 0
      }
    };
  }

  update(cameras) {
    if (!this.map) {
      return;
    }

    // Hide the exterior world (doodads and terrain) until a traversal reaches the exterior
    this.map.exterior.visible = false;

    this.hideAllMapChanks();
    this.hideAllMapDoodads();
    this.hideAllWMOGroups();
    // this.hideAllWMODoodads();

    const camera = cameras.find(x => x.name === 'MainCamera');
    
    if (!camera) {
      return;
    }
    
    // camera.updateMatrix(); // make sure camera's local matrix is updated
    // camera.updateMatrixWorld(); // make sure camera's world matrix is updated
    // camera.updateProjectionMatrix(); // make sure camera's world matrix is updated
    // console.log(camera)
    // Obtain a frustum matching the camera
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    // this.map.add(new PlaneHelper(frustum))
    // Adjust near plane (5) back to camera position
    // const nearGap = frustum.planes[5].distanceToPoint(camera.position);
    // frustum.planes[5].constant -= nearGap;

    DebugPanel.test1 = camera.location.type;
    if (camera.location.type === 'exterior') {
      this.enablePortalsFromExterior(0, camera, frustum);
    } else {
      this.enablePortalsFromInterior(0, camera, frustum);
    }

    this.updateStats();
  }

  enablePortalsFromExterior(depth, camera, frustum = null, visitedPortals = new Set()) {
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
        const isExterior = (group.header.flags & 0x08) !== 0;

        // Only concerned with exterior groups.
        if (!isExterior) {
          continue;
        }

        const view = wmo.views.groups.get(group.index);

        // View could still be pending load.
        if (!view) {
          continue;
        }

        // Cache world-space bounding box on group view
        if (!view.worldBoundingBox) {
          // console.log(view, wmo.views.root)
          view.worldBoundingBox = group.boundingBox.clone().applyMatrix4(wmo.views.root.matrixWorld);
          // console.log(view.worldBoundingBox)
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
        view.visible = true;

        // Doodads within frustum are visible
        for (const doodad of wmo.doodadsForGroup(group)) {
          this.enableStaticObjectInFrustum(doodad, frustum);
        }

        // Traverse inward from the exterior groups of all WMOs, marking any relevant WMO groups
        // as visible.
        this.traversePortalsAndEnable(depth, camera, wmo, group, frustum, visitedPortals);
      }
    }
  }

  enablePortalsFromInterior(depth, camera, frustum = null, visitedPortals = new Set()) {
    const wmo = camera.location.wmo.handler;
    const group = camera.location.wmo.group;
    const groupView = camera.location.wmo.views.group;

    // The group the camera is currently in should always be visible
    groupView.visible = true;

    // Doodads within frustum are visible
    // for (const doodad of wmo.doodadsForGroup(group)) {
    //   this.enableStaticObjectInFrustum(doodad, frustum);
    // }

    // Traverse outward from the given group, marking any relevant WMO groups as visible
    this.traversePortalsAndEnable(depth, camera, wmo, group, frustum, visitedPortals);
  }

  enableStaticObjectInFrustum(object, frustum) {
    // Cache world-space bounding box
    if (!object.worldBoundingBox) {
      // object.geometry.computeBoundingBox();
      object.worldBoundingBox = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
    }

    if (THREEUtil.frustumContainsBox(frustum, object.worldBoundingBox)) {
      object.visible = true;
    }
  }

  traversePortalsAndEnable(depth, camera, wmo, group, frustum = null, visitedPortals = new Set()) {
    // if (depth > 8) return; 
    
    const view = wmo.views.groups.get(group.index);
    const cameraLocal = view.worldToLocal(camera.position.clone());

    // Doodads within frustum are visible
    // for (const doodad of wmo.doodadsForGroup(group)) {
    //   this.enableStaticObjectInFrustum(doodad, frustum);
    // }

    for (let pindex = 0, pcount = group.portals.length; pindex < pcount; ++pindex) {
      const portal = group.portals[pindex];
      const ref = group.portalRefs[pindex];
      const destination = wmo.groups.get(ref.groupIndex);

      // Destination group is pending load
      if (!destination) {
        console.debug('Destination group is pending load')
        continue;
      }

      const portalView = wmo.views.portals.get(ref.portalIndex);
      const destinationView = wmo.views.groups.get(destination.index);
      const exteriorDestination = (destination.header.flags & 0x08) !== 0;

      // Destination group's view is pending load
      if (!destinationView) {
        console.debug('Destination group\'s view is pending load')
        continue;
      }

      // Already visited this portal, so we're done
      if (visitedPortals.has(portalView)) {
        console.debug("Already visited this portal, so we're done")
        continue;
      }

      // Exterior to exterior links are already covered by enablePortalsFromExterior
      if ((group.header.flags & 0x08) !== 0 && exteriorDestination) {
        console.debug('Exterior to exterior links are already covered by enablePortalsFromExterior')
        continue;
      }

      if (portalView.legacyGeometry.vertices.length < 4) {
        console.debug('Portal has less then 4 verticies. It is invalid');
        continue;
      }

      // Portal out of group is not visible from previous frustum
      if (frustum !== null && !portalView.intersectFrustum(frustum)) {
        console.debug('Portal out of group is not visible from previous frustum')
        continue;
      }

      // const plane = portal.plane;
      // const vec = vec4.fromValues(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      // console.log(vec)
      // var dotResult = (vec4.dot(
      //   vec, 
      //   [cameraLocal.x, cameraLocal.y, cameraLocal.z, 1]
      // ));
      // dotResult = dotResult + ref.side * 0.01;
      // DebugPanel.test1 = dotResult;
      // var isInsidePortalThis = (ref.side < 0) ? (dotResult <= 0) : (dotResult >= 0);
      // if (!isInsidePortalThis) continue;

      const distance = portal.plane.distanceToPoint(cameraLocal) + 0.001;
      // const insidePortal = distance < 0.0;
      var insidePortal = (ref.side < 0) ? (distance <= 0) : (distance >= 0);
      
      // Portals must be traversed outward
      if (!insidePortal) {
        console.debug('Portals must be traversed outward', distance, ref)
        continue;
      }

      // Portal out of group is visible, thus the destination group is visible
      destinationView.visible = true;
      
      // Track visited portals to prevent duplicate work
      visitedPortals.add(portalView);
      
      // Project a frustum out of this portal for use in the next level of recursion
      // const nextFrustum = portalView.createFrustum(camera, frustum, ref.side < 0);
      
      const nextFrustum = portalView.portalCull(camera, frustum, ref.side < 0);

      if (!nextFrustum) {
        console.debug('Project a frustum out of this portal for use in the next level of recursion')
        continue;
      }

      // Portal out of group is to exterior and camera is not already in exterior, thus we need
      // to traverse and enable exterior groups
      if (exteriorDestination && camera.location.type !== 'exterior') {
        this.enablePortalsFromExterior(depth + 1, camera, nextFrustum, visitedPortals);
      }

      // Recurse
      this.traversePortalsAndEnable(depth + 1, camera, wmo, destination, nextFrustum, visitedPortals);
    }
  }

  hideAllWMOGroups() {
    const wmos = this.map.wmoManager.entries.values();

    for (const wmo of wmos) {
      const groups = wmo.groups.values();

      for (const group of groups) {
        const view = wmo.views.groups.get(group.index);

        // View can be pending load
        if (!view) {
          continue;
        }

        view.visible = false;
      }
    }
  }

  hideAllWMODoodads() {
    const wmos = this.map.wmoManager.entries.values();

    for (const wmo of wmos) {
      const doodads = wmo.doodads.values();

      for (const doodad of doodads) {
        doodad.visible = false;
      }
    }
  }

  hideAllMapDoodads() {
    for (const doodad of this.map.doodadManager.doodads.values()) {
      doodad.visible = false;
    }
  }

  hideAllMapChanks() {
    for (const chank of this.map.chunks.values()) {
      chank.visible = false;
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

    this.stats.wmo.visibleGroups = visibleGroupCount;
    this.stats.wmo.visibleDoodads = visibleDoodadCount;
  }

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