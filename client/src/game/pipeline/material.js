import * as THREE from 'three';

import TextureLoader from './texture-loader';

class Material extends THREE.MeshBasicMaterial {

  constructor(params = {}) {
    params.wireframe = true;
    super(params);
  }

  set texture(path) {
    TextureLoader.load(path, THREE.RepeatWrapping, THREE.RepeatWrapping)
      .then((texture) => {
        this.wireframe = false;
        this.map = texture;
        this.needsUpdate = true;
      })
      .catch((error) => {
        console.error(`Failed to load material texture ${path}:`, error);
      });
  }

}

export default Material;
