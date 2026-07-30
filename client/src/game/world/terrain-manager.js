import LiquidType from '../pipeline/liquid/type';
import ColliderManager from './collider-manager';

class TerrainManager {

  constructor(map, zeropoint) {
    this.map = map;
    this.view = map.exterior;
    this.zeropoint = zeropoint;
    this.mapLight = null;
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

  /**
   * Set the map light system
   */
  setMapLight(mapLight) {
    this.mapLight = mapLight;
    
    // Update liquid materials
    LiquidType.materials.forEach((material) => {
      if (material.setMapLight) {
        material.setMapLight(mapLight);
      }
    });
  }

  /**
   * Update lighting for all terrain materials
   */
  updateLighting() {
    if (!this.mapLight) return;
    
    // Update liquid materials
    LiquidType.materials.forEach((material) => {
      if (material.updateLightUniforms) {
        material.updateLightUniforms();
      }
    });
  }

}

export default TerrainManager;
