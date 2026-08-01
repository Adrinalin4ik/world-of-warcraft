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

    // `updateMatrixWorld(true)`, NOT `updateWorldMatrix()`. Those are different methods: the latter
    // takes (updateParents, updateChildren) and with no arguments updates neither, so a chunk's
    // CHILDREN -- its liquid layers, added in the Chunk constructor -- never received a world matrix
    // here at all. That went unnoticed only because the renderer's per-frame `scene.updateMatrixWorld()`
    // fixed them up every frame; with that walk switched off (world/index.ts) the water would have
    // rendered at the world origin. Forcing the subtree once, at load, is the actual fix.
    terrain.updateMatrixWorld(true);

    // Register this tile's materials once, here, instead of rediscovering them by walking the whole
    // scene every frame.
    this.map.materialRegistry.addFrom(terrain);

    ColliderManager.collidableMeshList.set(terrain.uuid, terrain);
  }

  unloadChunk(_index, terrain) {
    this.view.remove(terrain);

    terrain.traverse((child) => {
      const material = child.material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach((entry) => this.map.materialRegistry.delete(entry));
    });

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
