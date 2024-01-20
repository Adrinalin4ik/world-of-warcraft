import * as THREE from 'three';
import ColliderManager from '../../../world/collider-manager';

class WMOGroupView extends THREE.Mesh {

  constructor(group, geometry, material) {
    super();
    this.matrixAutoUpdate = false;

    this.group = group;
    this.geometry = geometry;
    this.material = material;
    ColliderManager.collidableMeshList.set(this.uuid, this);
    // this.boxHelper = new THREE.BoxHelper( this, 0xff0000 );
    // this.boxHelper.visible = false;
    // this.add(this.boxHelper);
  }

  clone() {
    return this.group.createView();
  }

}

export default WMOGroupView;
