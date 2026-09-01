// import * as THREE from 'three';
import * as THREE from 'three';
import ADT from '../pipeline/adt';
import Chunk from '../pipeline/adt/chunk';
import DBC from '../pipeline/dbc';
import WDT from '../pipeline/wdt';
import gameSettings from '../settings';
import DoodadManager from './doodad-manager';
import MapLight from './light/MapLight';
import { MaterialRegistry } from './light/material-registry';
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

    // Read by World#updateDynamicMatrices: this subtree is the streamed static world -- terrain
    // tiles, static doodads, WMO geometry -- each positioned once at placement and never moved
    // again, so it is excluded from the per-frame world-matrix refresh. The movers it does contain
    // (particles, animated doodads) are updated explicitly there.
    this.isStaticSubtree = true;
    this.exterior = new THREE.Group();
    this.exterior.name = 'ExteriorView';
    this.add(this.exterior);

    // Set up geometry managers
    this.terrainManager = new TerrainManager(this, this.constructor.ZEROPOINT);
    this.doodadManager = new DoodadManager(this, this.constructor.ZEROPOINT);
    this.wmoManager = new WMOManager(this, this.constructor.ZEROPOINT);
    this.visibilityManager = new VisibilityManager(this);

    /**
     * **`window.wmoReport()` -- every loaded WMO group, its flags, and whether it was drawn.**
     *
     * The owner's floor is present in COLLISION and absent from the render: his own probe found
     * `NSABBEY_005.WMO#5` with an upward normal directly under the eye, and the area was a VOID until a
     * terrain guard filled it. So the question is no longer "which subsystem" -- it is "why is one
     * GROUP not drawn", and that needs the groups named by index rather than counted.
     *
     * `visibleFrame` against the manager's current `frame` is the whole answer: equal means the flood
     * reached it this frame, behind means it did not. `EXTERIOR`/`EXTERIOR_LIT` are printed raw because
     * the mask over them is what this thread already turned on once.
     */
    if (typeof window !== 'undefined') {
      /**
       * **`window.groupProbe(x, y, z)` -- which groups claim a world point, and what the containment
       * test says about each.**
       *
       * The portal trace cleared the projection: world vertices are sane, and the collapsed rects are
       * genuinely off screen, so the flood is behaving correctly for the seed it was given. What it also
       * showed is that every portal in the seed group's list is 30 to 45 yd away from where the owner
       * stands. The seed is not his room, and no amount of sorting candidates fixes that -- a group only
       * BECOMES a candidate if `queryBoundedPoint` yields a floor for it.
       *
       * So this asks the question one layer earlier: for every group whose bounding box contains the
       * point, does the BSP place the point inside, and what Z range comes back. A group whose box
       * contains the feet but whose query returns null can never be selected, however the selection is
       * written -- and that is the gap this is built to expose or to rule out.
       *
       * Takes WORLD coordinates and converts per WMO, because that conversion is itself a candidate:
       * `local` is printed so it can be checked against the group box that is being tested.
       */
      window.groupProbe = (x, y, z) => {
        const world = new THREE.Vector3(x, y, z);
        const rows = [];
        for (const wmo of this.wmoManager.entries.values()) {
          if (!wmo.views.root) continue;
          const local = wmo.views.root.worldToLocal(world.clone());
          if (!wmo.root.boundingBox.containsPoint(local)) continue;
          for (const group of wmo.groups.values()) {
            if (!group.boundingBox.containsPoint(local)) continue;
            let query = null;
            let threw = null;
            try {
              query = group.bspTree.queryBoundedPoint(local, group.boundingBox);
            } catch (e) {
              threw = String(e && e.message);
            }
            const flags = group.header.flags;
            rows.push({
              index: group.index,
              flags: `0x${flags.toString(16)}`,
              exterior: (flags & 0x8) !== 0,
              local: [local.x, local.y, local.z].map((v) => Number(v.toFixed(2))),
              boxZ: [group.boundingBox.min.z, group.boundingBox.max.z].map((v) => Number(v.toFixed(2))),
              queryNull: query === null,
              zMin: query && query.z.min === null ? null : (query ? Number(query.z.min.toFixed(2)) : null),
              zMax: query && query.z.max === null ? null : (query ? Number(query.z.max.toFixed(2)) : null),
              portalRefs: group.portalRefs ? group.portalRefs.length : null,
              threw,
            });
          }
        }
        return rows;
      };

      window.wmoReport = () => {
        const out = [];
        for (const wmo of this.wmoManager.entries.values()) {
          for (const group of wmo.groups.values()) {
            const view = wmo.views.groups.get(group.index);
            const flags = group.header.flags;
            out.push({
              path: (wmo.path || '').split(/[\/]/).pop(),
              index: group.index,
              flags: `0x${flags.toString(16)}`,
              exterior: (flags & 0x8) !== 0,
              exteriorLit: (flags & 0x40) !== 0,
              hasView: !!view,
              visibleFrame: view ? view.visibleFrame : null,
              drawn: view ? view.visible : null,
              meshes: view ? view.children.filter((c) => c.isMesh).length : null,
            });
          }
        }
        return { frame: this.visibilityManager.frame, groups: out };
      };
    }
    this.locationManager = new LocationManager(this);

    // Materials that want per-frame light uniforms. Populated at content-load time by the managers
    // above, so the per-frame pass never walks the scene graph. See light/material-registry.ts.
    this.materialRegistry = new MaterialRegistry();

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

    // Set by `unload()`. A chunk load in flight when the zone changes resolves against a map that is
    // no longer in the scene, and would register its terrain, WMO groups and doodad hulls with the
    // collision world after everything else had been taken back out.
    this.unloaded = false;

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
      if (chunk && !this.unloaded) {
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

  /**
   * Tear this zone's streamed content down -- every loaded chunk, and with it that chunk's terrain,
   * WMO entries and doodads.
   *
   * A zone change used to drop the map reference and remove it from the scene, and nothing else. The
   * scene graph does not own this content's OTHER registrations, so all of them survived: the
   * collision world kept every terrain chunk, WMO group collider and M2 bounding hull of every zone
   * visited this session. Measured in game, on one session with 45 chunks actually loaded: 1323
   * terrain chunks, 142 WMO groups and 11132 M2 hulls still registered.
   *
   * That is not merely a leak. Every map is its own 64x64 grid over the SAME world coordinates, so
   * the leftovers do not sit harmlessly off to one side -- they overlap wherever the player now is,
   * and the cast collides with a previous zone's floors and walls layered through this one.
   *
   * Deliberately routed through `unloadChunkByIndex` rather than clearing the collision world
   * directly: colliders are registered from CONSTRUCTORS (`WMOGroupView`, `M2#createBoundingMesh`)
   * whose results the loaders cache by path, so a construction never repeats for a re-visited model.
   * Wiping the registries would therefore lose that geometry permanently. Unloading properly takes
   * the loader refcounts down with it, which is what lets a re-visit rebuild.
   */
  unload() {
    this.unloaded = true;

    // Snapshot: `unloadChunkByIndex` deletes from the map being walked.
    for (const index of Array.from(this.chunks.keys())) {
      this.unloadChunkByIndex(index);
    }

    this.queuedChunks.clear();
  }

  indexFor(chunkX, chunkY) {
    return chunkX * 64 * 16 + chunkY;
  }

  /**
   * WHICH AREA THE GROUND UNDER A WORLD POSITION BELONGS TO -- `AreaTable.id`, or 0 when unknown.
   *
   * The map's and the minimap's "where am I", and the last piece of that foundation that is not a DBC
   * question. It is the reference's own source: "our MCNK `CurrentArea` is the leaf sub-area, so the
   * parent walk lands on the same zone" (`benilla-app/src/ui_world_map.rs:17-20`). The zone above the
   * leaf comes from `pipeline/dbc/map-data.ts#zoneOf`.
   *
   * **NOTHING NEW IS PARSED OR STREAMED FOR THIS.** `wow-data-parser/adt/index.js:133` has always read
   * `areaID` out of the MCNK header, and `pipeline/adt/chunk` has always kept the whole record as
   * `chunk.data` -- so the number was sitting in memory for every cell on screen and nothing had ever
   * asked for it. That is the third time this arc has found the data already present (after
   * `GameObjectDisplayInfo` and the four map tables), which is why "is it already there" is now the first
   * question rather than the last.
   *
   * ZERO for "unknown", and the distinction matters to the caller: `AreaTable` has no id 0, so 0 can only
   * mean the cell under the player is not loaded -- a teleport's first frames, or a position off the
   * streamed set. A caller must not turn that into a zone name; `mapData.zoneOf(0)` answers null, which
   * is the honest end of it.
   *
   * Cost: two divisions and one `Map#get`. Meant to be called once per frame at most, which is what the
   * zone text and the map's own position need.
   */
  areaIdAt(x, y) {
    // `chunkFor` takes a WORLD axis and answers the MCNK cell index on it. The x/y swap is the one this
    // file already uses everywhere -- `render(x, y)` passes x through `chunkFor` for `chunkX` -- and it
    // is the ADT convention, not a bug: a chunk's `position.x` is derived from `data.indexY`.
    const chunk = this.chunks.get(this.indexFor(Chunk.chunkFor(x), Chunk.chunkFor(y)));
    const areaId = chunk && chunk.data ? chunk.data.areaID : 0;
    return typeof areaId === 'number' ? areaId : 0;
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

    // Bind the current light to everything already registered. This runs once from the constructor,
    // when the registry is typically empty -- the streaming managers register as content arrives,
    // and `updateAllMaterialsWithLight` binds each newly seen material on the next frame.
    const { seen, applied } = this.materialRegistry.applyLight(this.mapLight);

    // Preserved from the traverse this replaced: the opt-in "new light system" hook on
    // M2MaterialNew / M2MaterialNewShaders / M2MaterialLite. It was only ever called here, never
    // on the per-frame path.
    this.materialRegistry.forEach((material) => {
      if (material.enableNewLightSystem) {
        material.enableNewLightSystem(this.mapLight.camera, this.mapID);
      }
    });

    console.log(`MapLight: Set MapLight on ${applied}/${seen} materials`);
  }

  /**
   * Update all materials in the scene with current light data
   *
   * The per-material binding rule -- including WHY the staleness check is `!==` and not a truthiness
   * check -- now lives in `light/material-registry.ts`, along with its tests.
   */
  updateAllMaterialsWithLight() {
    if (!this.mapLight) return;

    // Flat iteration over the registry. This used to be `this.traverse()` across the entire scene
    // graph, every frame, purely to rediscover the same material set. Registration now happens once
    // per loaded object; see light/material-registry.ts for why the rebinding check stays `!==`.
    //
    // `mapLight.revision` is what makes the flat iteration itself skippable. Measured in Elwynn this
    // registry holds 20 258 materials and the refresh cost 3.2 ms of EVERY frame, while the values
    // being copied changed on 1 frame in 401. See `MapLight#revision` and `MaterialRegistry#applyLight`
    // -- the skip is exact, not a throttle: it fires only when a copy would have written the value
    // that is already there.
    this.materialRegistry.applyLight(this.mapLight, this.mapLight.revision);

    // Object-level lighting, distinct from material uniforms: these iterate their own flat maps
    // already and are not scene walks.
    if (this.wmoManager && this.wmoManager.updateLighting) {
      this.wmoManager.updateLighting();
    }

    if (this.doodadManager && this.doodadManager.updateLighting) {
      this.doodadManager.updateLighting();
    }

    if (this.terrainManager && this.terrainManager.updateLighting) {
      this.terrainManager.updateLighting();
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
