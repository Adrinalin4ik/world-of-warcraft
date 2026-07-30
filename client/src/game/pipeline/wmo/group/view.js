import * as THREE from 'three';
import ColliderManager from '../../../world/collider-manager';

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
    
    ColliderManager.collidableMeshList.set(this.uuid, this.mesh);
    // this.boxHelper = new THREE.BoxHelper( this, 0xff0000 );
    // this.boxHelper.visible = false;
    // this.add(this.boxHelper);
  }

  clone() {
    return this.group.createView();
  }

}

export default WMOGroupView;
