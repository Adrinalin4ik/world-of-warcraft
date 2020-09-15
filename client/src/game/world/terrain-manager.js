import LiquidType from '../pipeline/liquid/type';
import ColliderManager from './collider-manager';

class TerrainManager {

  constructor(map, zeropoint) {
    this.map = map;
    this.view = map.exterior;
    this.zeropoint = zeropoint;
  }

  loadChunk(_index, terrain) {
    this.view.add(terrain);
    
    terrain.updateMatrix();
    terrain.updateWorldMatrix();

    ColliderManager.collidableMeshList.set(terrain.uuid, terrain);
  }

  unloadChunk(_index, terrain) {
    this.view.remove(terrain);
    terrain.dispose();

    ColliderManager.collidableMeshList.delete(terrain.uuid);
  }

  animate(delta, camera, cameraMoved) {
    LiquidType.materials.forEach((material) => {
      material.animate(delta, camera, cameraMoved);
    });
  }

}

export default TerrainManager;
