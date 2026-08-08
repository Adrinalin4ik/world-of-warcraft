import * as THREE from 'three';
import { collisionWorld } from '../../../collision/collision-world';
import { wmoLiquidSurface } from '../../../collision/liquid-query';

class WMOGroupView extends THREE.Group {

  constructor(group, geometry, material) {
    super();
    this.matrixAutoUpdate = false;

    this.group = group;
    this.geometry = geometry;
    this.material = material;
    
    // Create the main geometry mesh
    this.mesh = new THREE.Mesh(geometry, material);
    this.add(this.mesh);
    
    // Add liquid mesh if present
    if (group.liquid) {
      console.log('Adding liquid mesh to WMO group view:', group.path, group.index);
      this.add(group.liquid);
    }
    
    // Collision comes from the group's MOBN/MOBR BSP -- the client's own collision structure --
    // not from the render mesh. The flags ride along so the walk and camera audiences can be
    // filtered out of the one shared tree.
    collisionWorld.wmo.add({
      view: this,
      bspTree: group.bspTree,
      triangleFlags: group.triangleFlags
    });

    // This room's own liquid, scoped to this group: indoors only THIS placement's MLIQ answers a
    // depth query, so a building's floor water cannot answer for someone standing outside it.
    if (group.liquid) {
      group.liquid.children.forEach((layer) => {
        if (layer.data && layer.data.liquidVerts) {
          collisionWorld.liquid.add(wmoLiquidSurface(layer, this));
        }
      });
    }
    // this.boxHelper = new THREE.BoxHelper( this, 0xff0000 );
    // this.boxHelper.visible = false;
    // this.add(this.boxHelper);
  }

  clone() {
    return this.group.createView();
  }

}

export default WMOGroupView;
