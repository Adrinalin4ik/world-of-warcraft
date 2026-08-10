import * as THREE from 'three';

class ColliderManager {
  static collidableMeshList = new Map();
  static collidableMesh = new THREE.Mesh();
}

export default ColliderManager;
