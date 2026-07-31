// import * as THREE from 'three';
import * as THREE from 'three';
import ADT from '../pipeline/adt';
import Chunk from '../pipeline/adt/chunk';
import DBC from '../pipeline/dbc';
import WDT from '../pipeline/wdt';
import gameSettings from '../settings';
import DoodadManager from './doodad-manager';
import MapLight from './light/MapLight';
import LocationManager from './location-manager';
import TerrainManager from './terrain-manager';
import VisibilityManager from './visibility-manager';
import WMOManager from './wmo-manager';
import { ParticleManager } from '../pipeline/m2/particle/manager';

class WorldMap extends THREE.Group {

  static ZEROPOINT = ADT.SIZE * 32;

  static CHUNKS_PER_ROW = 64 * 16;
  
  mapLight = null;

  // Controls when ADT chunks are loaded and unloaded from the map.
  static CHUNK_RENDER_RADIUS = gameSettings.world.render.radius;

  constructor(data, wdt) {
    super();

    this.matrixAutoUpdate = false;
    this.name = 'WorldMap';
    this.exterior = new THREE.Group();
    this.exterior.name = 'ExteriorView';
    this.add(this.exterior);

    // Set up geometry managers
    this.terrainManager = new TerrainManager(this, this.constructor.ZEROPOINT);
    this.doodadManager = new DoodadManager(this, this.constructor.ZEROPOINT);
    this.wmoManager = new WMOManager(this, this.constructor.ZEROPOINT);
    this.visibilityManager = new VisibilityManager(this);
    this.locationManager = new LocationManager(this);

    // Particles live in their own group so that doodad visibility culling cannot take them with it.
    this.particleGroup = new THREE.Group();
    this.particleGroup.name = 'Particles';
    this.add(this.particleGroup);

    this.particleManager = new ParticleManager(this.particleGroup);

    this.data = data;
    this.wdt = wdt;

    this.mapID = this.data.id;
    this.chunkX = null;
    this.chunkY = null;

    this.queuedChunks = new Map();
    this.chunks = new Map();

    this.collidableMeshList = [];
    // Initialize map light system
    this.mapLight = new MapLight();
    // Particles read the same fog ramp as everything else in the zone.
    this.particleManager.mapLight = this.mapLight;
    
    // Set up light system for all managers
    this.setupLightSystem();
    
    // Set map ID on the light system
    this.mapLight.mapId = this.mapID;
  }

  get internalName() {
    return this.data.internalName;
  }

  render(x, y) {
    const chunkX = Chunk.chunkFor(x);
    const chunkY = Chunk.chunkFor(y);

    if (this.chunkX === chunkX && this.chunkY === chunkY) {
      return;
    }

    this.chunkX = chunkX;
    this.chunkY = chunkY;
    const radius = this.constructor.CHUNK_RENDER_RADIUS;
    const indices = this.chunkIndicesAround(chunkX, chunkY, radius);
    indices.forEach((index) => {
      this.loadChunkByIndex(index);
    });

    this.chunks.forEach((_chunk, index) => {
      if (indices.indexOf(index) === -1) {
        this.unloadChunkByIndex(index);
      }
    });
  }

  chunkIndicesAround(chunkX, chunkY, radius) {
    const perRow = this.constructor.CHUNKS_PER_ROW;

    const base = this.indexFor(chunkX, chunkY);
    const indices = [];

    for (let y = -radius; y <= radius; ++y) {
      for (let x = -radius; x <= radius; ++x) {
        indices.push(base + y * perRow + x);
      }
    }

    return indices;
  }

  loadChunkByIndex(index) {
    if (this.queuedChunks.has(index)) {
      return;
    }

    const perRow = this.constructor.CHUNKS_PER_ROW;
    const chunkX = (index / perRow) | 0;
    const chunkY = index % perRow;

    this.queuedChunks.set(index, Chunk.load(this, chunkX, chunkY).then((chunk) => {
      if (chunk) {
        this.chunks.set(index, chunk);
        this.terrainManager.loadChunk(index, chunk);
        this.doodadManager.loadChunk(index, chunk.doodadEntries);
        this.wmoManager.loadChunk(index, chunk.wmoEntries);
      }
    }));
  }

  unloadChunkByIndex(index) {
    const chunk = this.chunks.get(index);
    if (!chunk) {
      return;
    }

    this.terrainManager.unloadChunk(index, chunk);
    this.doodadManager.unloadChunk(index, chunk.doodadEntries);
    this.wmoManager.unloadChunk(index, chunk.wmoEntries);

    this.queuedChunks.delete(index);
    this.chunks.delete(index);
  }

  indexFor(chunkX, chunkY) {
    return chunkX * 64 * 16 + chunkY;
  }

  animate(delta, camera, cameraMoved) {
    this.updateWorldTime(camera, this.mapID, null, delta);
    this.terrainManager.animate(delta, camera, cameraMoved);
    this.doodadManager.animate(delta, camera, cameraMoved);
    this.wmoManager.animate(delta, camera, cameraMoved);
    this.particleManager.animate(delta, camera);
  }

  // `delta` is the real per-frame seconds elapsed (THREE.Clock.getDelta(), from
  // pages/game/index.tsx's animate loop) -- MapLight's interior-fog crossfade needs it to track
  // wall-clock time rather than frame rate. Optional because this is also called from
  // `World.animate` before `delta` has been read for the frame it belongs to (see world/index.ts);
  // MapLight falls back to its own wall-clock measurement when it is omitted.
  updateWorldTime(camera, mapID, time=null, delta=undefined) {
    if (this.mapLight) {
      // Set camera on MapLight if not already set
      if (!this.mapLight.camera) {
        this.mapLight.camera = camera;
      }

      this.mapLight.update(camera, delta);

      // Propagate light updates to all materials
      this.updateAllMaterialsWithLight();
    }
  }

  /**
   * Set up the light system for all managers
   */
  setupLightSystem() {
    if (!this.mapLight) return;

    // Set MapLight on all managers that support it
    if (this.wmoManager && this.wmoManager.setMapLight) {
      this.wmoManager.setMapLight(this.mapLight);
    }

    // The reverse link, for the debug readout's near-camera WMO-group survey (diagnostic 2) --
    // MapLight has no other way to reach the loaded WMO groups, since it does not raycast the scene.
    this.mapLight.wmoManager = this.wmoManager;
    
    if (this.doodadManager && this.doodadManager.setMapLight) {
      this.doodadManager.setMapLight(this.mapLight);
    }
    
    if (this.terrainManager && this.terrainManager.setMapLight) {
      this.terrainManager.setMapLight(this.mapLight);
    }
    
    // Also set MapLight on all existing materials in the scene
    this.propagateMapLightToAllMaterials();
  }

  /**
   * Propagate MapLight to all existing materials in the scene
   */
  propagateMapLightToAllMaterials() {
    if (!this.mapLight) return;

    let materialCount = 0;
    let setCount = 0;

    this.traverse((child) => {
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(material => {
            materialCount++;
            if (material.setMapLight) {
              material.setMapLight(this.mapLight);
              setCount++;
            }
            // Also try to enable new light system if available
            if (material.enableNewLightSystem) {
              material.enableNewLightSystem(this.mapLight.camera, this.mapID);
            }
          });
        } else {
          materialCount++;
          if (child.material.setMapLight) {
            child.material.setMapLight(this.mapLight);
            setCount++;
          }
          // Also try to enable new light system if available
          if (child.material.enableNewLightSystem) {
            child.material.enableNewLightSystem(this.mapLight.camera, this.mapID);
          }
        }
      }
    });

    console.log(`MapLight: Set MapLight on ${setCount}/${materialCount} materials`);
  }

  /**
   * Update all materials in the scene with current light data
   */
  /**
   * Give a material the CURRENT map light the first time we see it (or the first time we see it
   * again after the light system it was bound to stopped being this one), then refresh its light
   * uniforms.
   *
   * Adopting unseen materials here is what keeps streamed terrain lit. `setupLightSystem` only runs
   * once, from the constructor, so it reaches nothing: ADT chunks are built lazily as tiles load in.
   * A material that was never handed the light keeps `mapLight` null, which makes its
   * `updateLightUniforms` a no-op, and it stays on its constructor defaults forever - fully bright,
   * unfogged and with no time of day.
   *
   * The comparison is `!==`, not a truthiness check, because M2 materials are cached and shared
   * across every placement AND every map that uses the same model (`M2Blueprint.cache`/`this.batches`
   * -- see per-object-light.ts's doc comment). `changeMap` (world/index.ts) swaps `WorldMap.mapLight`
   * for a brand-new `MapLight` on every zone change but never touches that cache, so a common prop --
   * a shipwreck, a floating log pile, anything likely to reappear across zones -- keeps whatever
   * `MapLight` it was first bound to. A truthiness check treats that stale reference as "already
   * bound" and only ever calls `updateLightUniforms()` against it, which reads `mapLight.uniforms` off
   * the OLD `MapLight` -- one nobody calls `.update()` on anymore, since the new `WorldMap.animate()`
   * only updates its OWN `mapLight`. Its fog/sun/time-of-day freeze at whatever they were the instant
   * the old zone's `MapLight` stopped ticking: on a zone that authors little or no fog, that reads as
   * "no fog at all" while everything freshly bound to the current `MapLight` fogs correctly around it.
   * Comparing against the CURRENT `this.mapLight` re-binds the material the next time this sweep sees
   * it, exactly like a material that had never been bound at all.
   */
  applyLightToMaterial(material) {
    if (!material) {
      return false;
    }

    let applied = false;

    if (material.mapLight !== this.mapLight && material.setMapLight) {
      // setMapLight refreshes the uniforms itself.
      material.setMapLight(this.mapLight);
      applied = true;
    } else if (material.updateLightUniforms) {
      material.updateLightUniforms();
      applied = true;
    }

    return applied;
  }

  updateAllMaterialsWithLight() {
    if (!this.mapLight) return;

    let materialCount = 0;
    let updatedCount = 0;

    // Update ADT materials
    this.traverse((child) => {
      if (child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];

        materials.forEach((material) => {
          materialCount++;
          if (this.applyLightToMaterial(material)) {
            updatedCount++;
          }
        });
      }
    });

    // Update WMO materials
    if (this.wmoManager && this.wmoManager.updateLighting) {
      this.wmoManager.updateLighting();
    }

    // Update M2 materials
    if (this.doodadManager && this.doodadManager.updateLighting) {
      this.doodadManager.updateLighting();
    }
  }

  locateCamera(camera) {
    this.locationManager.update([camera]);
  }

  updateVisibility(camera) {
    this.visibilityManager.update([camera]);
  }

  static load(id) {
    try {
      return DBC.load('Map', id).then((data) => {
        if (data) {
          const { internalName: name } = data;
          return WDT.load(`World\\Maps\\${name}\\${name}.wdt`).then((wdt) => {
            return new this(data, wdt);
          });
        }
      })
    } catch(ex) {
      console.warn('ADT load exeption', ex);
    }
  }

}

export default WorldMap;
