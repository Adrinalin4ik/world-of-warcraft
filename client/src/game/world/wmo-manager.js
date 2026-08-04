import { BoneBudget } from '../pipeline/m2/anim/gating';
import WMO from '../pipeline/wmo';
import gameSettings from '../settings';
import ContentQueue from '../utils/content-queue';
class WMOManager {

  static LOAD_ENTRY_INTERVAL = gameSettings.wmo.loadInterval;
  static LOAD_ENTRY_WORK_FACTOR = gameSettings.wmo.loadFactor;
  static LOAD_ENTRY_WORK_MIN = gameSettings.wmo.loadMin;

  static UNLOAD_DELAY_INTERVAL = gameSettings.wmo.unloadDelay;

  constructor(view, zeropoint) {
    this.view = view;
    this.zeropoint = zeropoint;

    this.chunkRefs = new Map();
    this.mapLight = null;

    this.counters = {
      loadingEntries: 0,
      loadedEntries: 0,
      loadingGroups: 0,
      loadedGroups: 0,
      loadingDoodads: 0,
      loadedDoodads: 0,
      animatedDoodads: 0
    };

    this.entries = new Map();

    // ONE budget for every building's interior doodads, reset here and passed down into each
    // `WMO#animate`. Owning it per WMO would multiply the per-frame ceiling by the number of loaded
    // buildings -- 113 visible groups were measured in Stormwind -- which is not a ceiling.
    //
    // Still SEPARATE from `DoodadManager`'s budget of the same size, so the true worst-frame ceiling
    // is currently 2x `boneBudgetPerFrame` (units are exempt from both; see `World#animateEntities`).
    // Unifying them means one budget object shared across managers with a single begin-frame, which
    // is Task 20's job once the HUD says what the real numbers are.
    this.boneBudget = new BoneBudget(gameSettings.m2.boneBudgetPerFrame);

    this.pendingUnloads = new Map();

    this.queues = {
      loadEntry: new ContentQueue(
        this.processLoadEntry.bind(this),
        this.constructor.LOAD_ENTRY_INTERVAL,
        this.constructor.LOAD_ENTRY_WORK_FACTOR,
        this.constructor.LOAD_ENTRY_WORK_MIN
      )
    };
  }

  loadChunk(chunkIndex, wmoEntries) {
    for (let i = 0, len = wmoEntries.length; i < len; ++i) {
      const wmoEntry = wmoEntries[i];

      this.addChunkRef(chunkIndex, wmoEntry);
      this.cancelUnloadEntry(wmoEntry);
      this.enqueueLoadEntry(wmoEntry);
    }
  }

  unloadChunk(chunkIndex, wmoEntries) {
    for (let i = 0, len = wmoEntries.length; i < len; ++i) {
      const wmoEntry = wmoEntries[i];

      const refCount = this.removeChunkRef(chunkIndex, wmoEntry);
      // Still has a chunk reference; don't queue for unload.
      if (refCount > 0) {
        continue;
      }

      this.dequeueLoadEntry(wmoEntry);
      this.scheduleUnloadEntry(wmoEntry);
    }
  }

  addChunkRef(chunkIndex, wmoEntry) {
    let chunkRefs;

    // Fetch or create chunk references for entry.
    if (this.chunkRefs.has(wmoEntry.id)) {
      chunkRefs = this.chunkRefs.get(wmoEntry.id);
    } else {
      chunkRefs = new Set();
      this.chunkRefs.set(wmoEntry.id, chunkRefs);
    }

    // Add chunk reference to entry.
    chunkRefs.add(chunkIndex);

    const refCount = chunkRefs.size;

    return refCount;
  }

  removeChunkRef(chunkIndex, wmoEntry) {
    const chunkRefs = this.chunkRefs.get(wmoEntry.id);

    // Remove chunk reference for entry.
    chunkRefs.delete(chunkIndex);

    const refCount = chunkRefs.size;

    if (chunkRefs.size === 0) {
      this.chunkRefs.delete(wmoEntry.id);
    }

    return refCount;
  }

  enqueueLoadEntry(wmoEntry) {
    const key = wmoEntry.id;

    // Already loading or loaded.
    if (this.queues.loadEntry.has(key) || this.entries.has(key)) {
      return;
    }

    this.queues.loadEntry.add(key, wmoEntry);

    this.counters.loadingEntries++;
  }

  dequeueLoadEntry(wmoEntry) {
    const key = wmoEntry.key;

    // Not loading.
    if (!this.queues.loadEntry.has(key)) {
      return;
    }

    this.queues.loadEntry.remove(key);

    this.counters.loadingEntries--;
  }

  scheduleUnloadEntry(entry) {
    const wmo = this.entries.get(entry.id);

    if (!wmo) {
      return;
    }

    if (this.pendingUnloads.has(entry.id)) {
      return;
    }

    const unload = () => {
      this.unloadEntry(entry);
    };

    this.pendingUnloads.set(entry.id, setTimeout(unload, this.constructor.UNLOAD_DELAY_INTERVAL));
  }

  cancelUnloadEntry(entry) {
    const wmo = this.entries.get(entry.id);

    if (!wmo) {
      return;
    }

    if (this.pendingUnloads.has(entry.id)) {
      return;
    }

    clearTimeout(this.pendingUnloads.get(entry.id));
  }

  unloadEntry(entry) {
    this.pendingUnloads.delete(entry.id);

    const wmo = this.entries.get(entry.id);
    
    for (const obj of wmo.views.root.children) {
      const colisionIndex = this.view.collidableMeshList.findIndex(x => x.uuid === obj.uuid);
      if (colisionIndex !== -1) {
        this.view.collidableMeshList.splice(colisionIndex, 1);
      }
    }

    this.view.remove(wmo.views.root);

    this.entries.delete(entry.id);
    this.counters.loadedEntries--;



    this.counters.loadingGroups -= wmo.counters.loadingGroups;
    this.counters.loadedGroups -= wmo.counters.loadedGroups;
    this.counters.loadingDoodads -= wmo.counters.loadingDoodads;
    this.counters.loadedDoodads -= wmo.counters.loadedDoodads;
    this.counters.animatedDoodads -= wmo.counters.animatedDoodads;
    wmo.unload();
  }

  processLoadEntry(entry) {
    const wmo = new WMO(entry.filename, entry.doodadSet, entry.id, this.counters, this.view.particleManager, this.view.materialRegistry);

    this.entries.set(entry.id, wmo);

    wmo.load().then(() => {
      this.placeWMOView(entry, wmo.views.root);
      this.counters.loadingEntries--;
      this.counters.loadedEntries++;
    });
  }

  placeWMOView(entry, view) {
    const { position, rotation } = entry;

    view.position.set(
      -(position.z - this.zeropoint),
      -(position.x - this.zeropoint),
      position.y
    );

    // Provided as (Z, X, -Y)
    view.rotation.set(
      rotation.z * Math.PI / 180,
      rotation.x * Math.PI / 180,
      -rotation.y * Math.PI / 180
    );
    // Adjust WMO rotation to match Wowser's axes.
    const quat = view.quaternion;
    quat.set(quat.x, quat.y, quat.z, -quat.w);
    view.scale.set(-1, -1, 1)
    // console.log(view)
    view.updateMatrix();
    view.updateMatrixWorld();

    this.view.add(view);
  }

  animate(delta, camera, cameraMoved) {
    this.boneBudget.beginFrame();

    this.entries.forEach((wmo) => {
      wmo.animate(delta, camera, cameraMoved, this.boneBudget);
    });
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight) {
    this.mapLight = mapLight;
    
    // Propagate to all existing WMO entries
    this.entries.forEach((wmo) => {
      if (wmo.setMapLight) {
        wmo.setMapLight(mapLight);
      }
    });
  }

  /**
   * Update lighting for all WMO entries
   */
  updateLighting() {
    if (!this.mapLight) return;
    
    this.entries.forEach((wmo) => {
      if (wmo.updateLighting) {
        wmo.updateLighting();
      }
    });
  }

}

export default WMOManager;
