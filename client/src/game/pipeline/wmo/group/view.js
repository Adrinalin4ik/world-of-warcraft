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
  }

  clone() {
    return this.group.createView();
  }

}

export default WMOGroupView;
