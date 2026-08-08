import { collisionWorld } from '../collision/collision-world';
import { adtLiquidSurface } from '../collision/liquid-query';
import LiquidType from '../pipeline/liquid/type';

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

    collisionWorld.terrain.add(terrain);

    // Liquid layers are children of the chunk, added in the Chunk constructor. They are a surface
    // QUERY, not a collider -- you do not collide with water, you compare its height to your feet.
    terrain.traverse((child) => {
      if (child.isMesh && child.data && child.data.vertexData) {
        collisionWorld.liquid.add(adtLiquidSurface(child));
      }
    });
  }

  unloadChunk(_index, terrain) {
    this.view.remove(terrain);

    terrain.traverse((child) => {
      collisionWorld.liquid.remove(child);

      const material = child.material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach((entry) => this.map.materialRegistry.delete(entry));
    });

    terrain.dispose();

    collisionWorld.terrain.remove(terrain);
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
