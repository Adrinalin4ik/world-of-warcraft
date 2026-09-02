import { animCounters } from '../pipeline/m2/anim/counters';
import { BoneBudget } from '../pipeline/m2/anim/gating';
import { externalMergeEpoch } from '../pipeline/m2/anim/model-anim';
import { poseGatedInstance } from '../pipeline/m2/anim/pose-gate';
import { armDoodad, cycleDoodad } from '../pipeline/m2/anim/variation-cycle';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import M2Blueprint from '../pipeline/m2/blueprint';
import { beginAnimSection, endAnimSection } from '../perf/anim-section';
import gameSettings from '../settings';

class DoodadManager {

  // Proportion of pending doodads to load or unload in a given tick.
  static LOAD_FACTOR = gameSettings.doodad.loadFactor;

  // Minimum number of pending doodads to load or unload in a given tick.
  static MINIMUM_LOAD_THRESHOLD = gameSettings.doodad.loadMin;

  // Number of milliseconds to wait before loading another portion of doodads.
  static LOAD_INTERVAL = gameSettings.doodad.loadInterval;

  constructor(map, zeropoint) {
    this.map = map;
    this.view = map.exterior;
    this.zeropoint = zeropoint;

    this.chunkRefs = new Map();
    this.mapLight = null;

    this.doodads = new Map();
    this.animatedDoodads = new Map();

    // Dense, monotonically increasing slot handed to each animated doodad at registration. This is
    // the phase input for `shouldPose`'s decimation stagger, and it deliberately is NOT the doodad's
    // entry id: entry ids are sparse, large, and clustered by map chunk, so `id % period` can put a
    // whole chunk's worth of props on one phase -- which is the single-phase pile-up the stagger
    // exists to prevent, and a worse worst frame than not decimating at all.
    this.nextPoseSlot = 0;

    // The global external-`.anim` merge epoch this manager last rescanned at. -1 rather than the
    // live value so the first frame always scans -- at that point `doodads` is empty or nearly so,
    // and starting in step would mean a merge that landed BEFORE the first frame was never adopted.
    this.lastMergeEpoch = -1;

    this.boneBudget = new BoneBudget(gameSettings.m2.boneBudgetPerFrame);

    this.entriesPendingLoad = new Map();
    this.entriesPendingUnload = new Map();

    this.loadChunk = this.loadChunk.bind(this);
    this.unloadChunk = this.unloadChunk.bind(this);
    this.loadDoodads = this.loadDoodads.bind(this);
    this.unloadDoodads = this.unloadDoodads.bind(this);

    // Kick off intervals.
    this.loadDoodads();
    this.unloadDoodads();
  }

  // Process a set of doodad entries for a given chunk index of the world map.
  loadChunk(index, entries) {
    for (let i = 0, len = entries.length; i < len; ++i) {
      const entry = entries[i];

      let chunkRefs;

      // Fetch or create chunk references for entry.
      if (this.chunkRefs.has(entry.id)) {
        chunkRefs = this.chunkRefs.get(entry.id);
      } else {
        chunkRefs = new Set();
        this.chunkRefs.set(entry.id, chunkRefs);
      }

      // Add chunk reference to entry.
      chunkRefs.add(index);

      // If the doodad is pending unload, remove the pending unload.
      if (this.entriesPendingUnload.has(entry.id)) {
        this.entriesPendingUnload.delete(entry.id);
      }

      // Add to pending loads. Actual loading is done by interval.
      this.entriesPendingLoad.set(entry.id, entry);
    }
  }

  unloadChunk(index, entries) {
    for (let i = 0, len = entries.length; i < len; ++i) {
      const entry = entries[i];

      const chunkRefs = this.chunkRefs.get(entry.id);

      // Remove chunk reference for entry.
      chunkRefs.delete(index);

      // If at least one chunk reference remains for entry, leave loaded. Typically happens in
      // cases where a doodad is shared across multiple chunks.
      if (chunkRefs.size > 0) {
        continue;
      }

      // No chunk references remain, so we should remove from pending loads if necessary.
      if (this.entriesPendingLoad.has(entry.id)) {
        this.entriesPendingLoad.delete(entry.id);
      }

      // Add to pending unloads. Actual unloading is done by interval.
      this.entriesPendingUnload.set(entry.id, entry);
    }
  }

  // Every tick of the load interval, load a portion of any doodads pending load.
  loadDoodads() {
    let count = 0;

    for (const entry of this.entriesPendingLoad.values()) {
      if (this.doodads.has(entry.id)) {
        this.entriesPendingLoad.delete(entry.id);
        continue;
      }

      this.loadDoodad(entry);

      this.entriesPendingLoad.delete(entry.id);

      ++count;

      const shouldYield = count >= this.constructor.MINIMUM_LOAD_THRESHOLD &&
        count > this.entriesPendingLoad.size * this.constructor.LOAD_FACTOR;

      if (shouldYield) {
        setTimeout(this.loadDoodads, this.constructor.LOAD_INTERVAL);
        return;
      }
    }

    setTimeout(this.loadDoodads, this.constructor.LOAD_INTERVAL);
  }

  loadDoodad(entry) {
    M2Blueprint.load(entry.filename).then((doodad) => {
      if (this.entriesPendingUnload.has(entry.id)) {
        return;
      }

      doodad.entryID = entry.id;

      this.doodads.set(entry.id, doodad);

      this.placeDoodad(doodad, entry.position, entry.rotation, entry.scale);

      this.map.materialRegistry.addFrom(doodad);

      if (this.map.particleManager) {
        this.map.particleManager.register(doodad);
      }

      // TWO independent reasons to be in the per-frame set, and they must both be asked.
      //
      // `doodad.animated` comes from `ModelAnim.classify()`, which answers "is there anything to
      // SAMPLE?" -- the right question for posing, and deliberately blind to billboarding. The
      // parser's older `data.animated` getter folded `|| billboarded` in
      // (`wow-data-parser/m2/index.js:63-67`), so gating on `animated` alone would silently drop a
      // doodad whose only moving part is a billboarded bone: it would stop being turned to face the
      // camera AND stop getting the forced `updateMatrixWorld` in `World#updateDynamicMatrices`,
      // freezing it in bind orientation.
      //
      // The answer is NOT final, either: `doodad.animated` is `ModelAnim.classify()` over the
      // INLINE slots only, so a model whose real authoring lives in sibling `.anim` files reads
      // static here and becomes animated later, when the merge lands. `adoptMergedAnimations`
      // below is what re-asks; without it such a doodad would stand in bind pose for ever with
      // correct keys in the table beside it.
      if (doodad.animated || doodad.billboards.length > 0) {
        this.enableDoodadAnimations(entry.id, doodad);
      }

      // RETURNED, not orphaned. `particleManager.register` above builds a `ParticleMaterial` per
      // emitter and each one starts a texture load, so registering from inside this `.then` created a
      // promise nothing returned -- which Bluebird reports as "a promise was created in a handler ...
      // but was not returned from it". Returning the readiness handle joins the chain instead.
      //
      // THIS IS THE ZONE-LOAD LANE, so the cost matters and was measured rather than assumed: it is
      // one `WeakMap` read per doodad, and `ready` hands back the material's OWN already-existing
      // promise when a doodad has a single emitter, allocating nothing. See
      // `pipeline/m2/particle/manager.ts#ready`.
      //
      // The handle never rejects, and here that is not a nicety: this chain has no `.catch` of its
      // own, so a rejecting handle would turn a missing particle texture into an unhandled rejection
      // at zone-load scale. `ParticleMaterial#ready` carries that requirement.
      return this.map.particleManager ? this.map.particleManager.ready(doodad) : undefined;
    });
  }

  /**
   * Re-ask the membership question for every STATIC doodad, but only when an external `.anim` merge
   * has actually landed somewhere since the last time we asked.
   *
   * `loadDoodad` decides membership once, from `doodad.animated`, in the load callback. That is the
   * right answer for the overwhelming majority of models and the wrong one for a model whose only
   * real authoring is external: it classifies static, allocates no `InstanceAnim`, joins no
   * per-frame set, and nothing on this path ever re-asks -- the exact silent failure
   * `M2#syncMergedAnimation` exists to prevent, which until now only the unit path pulled on.
   *
   * Reachability in 3.3.5a is low (external ids are emotes and specials on creature models), but
   * `externalAnims.ensure` runs for EVERY model from `M2Blueprint.load`, so the machinery is live
   * here and the failure mode is the silent kind.
   *
   * COST. Gated on the global epoch (`externalMergeEpoch`), not on any per-doodad state: the steady
   * state is one integer compare per frame, and the O(loaded doodads) walk happens only on frames a
   * merge landed on. Called BEFORE the `animatedDoodads` walk in `animate` on purpose -- it inserts
   * into that map, and a `Map` grown during its own `forEach` visits the new entries with a
   * `poseFrame` and `poseSlot` assigned microseconds earlier.
   */
  adoptMergedAnimations() {
    const epoch = externalMergeEpoch();
    if (epoch === this.lastMergeEpoch) {
      return;
    }
    this.lastMergeEpoch = epoch;

    this.doodads.forEach((doodad, entryID) => {
      if (this.animatedDoodads.has(entryID)) {
        return;
      }
      // One boolean compare for a doodad that has nothing to adopt. Only ever flips one way.
      if (doodad.syncMergedAnimation && doodad.syncMergedAnimation()) {
        this.enableDoodadAnimations(entryID, doodad);
      }
    });
  }

  enableDoodadAnimations(entryID, doodad) {
    // Maintain separate entries for animated doodads to avoid excessive iterations on each
    // call to animate() during the render loop.
    this.animatedDoodads.set(entryID, doodad);

    doodad.poseSlot = this.nextPoseSlot++;

    // Last frame on which this doodad's bones were actually written. Read by
    // `World#updateDynamicMatrices` to skip the scene walk for everything the gates rejected.
    doodad.poseFrame = -1;

    // Membership in this map does NOT imply `instanceAnim` is non-null -- a billboard-only doodad
    // is here purely for `applyBillboards`, and never allocates an instance at all.
    if (doodad.instanceAnim) {
      armDoodad(doodad.instanceAnim, worldClock.ms);
    }
  }

  // Every tick of the load interval, unload a portion of any doodads pending unload.
  unloadDoodads() {
    let count = 0;

    for (const entry of this.entriesPendingUnload.values()) {
      // If the doodad was already unloaded, remove it from the pending unloads.
      if (!this.doodads.has(entry.id)) {
        this.entriesPendingUnload.delete(entry.id);
        continue;
      }

      this.unloadDoodad(entry);

      this.entriesPendingUnload.delete(entry.id);

      ++count;

      const shouldYield = count >= this.constructor.MINIMUM_LOAD_THRESHOLD &&
        count > this.entriesPendingUnload.size * this.constructor.LOAD_FACTOR;

      if (shouldYield) {
        setTimeout(this.unloadDoodads, this.constructor.LOAD_INTERVAL);
        return;
      }
    }

    setTimeout(this.unloadDoodads, this.constructor.LOAD_INTERVAL);
    return;
  }

  unloadDoodad(entry) {
    const doodad = this.doodads.get(entry.id);

    if (this.map.particleManager) {
      this.map.particleManager.unregister(doodad);
    }

    this.doodads.delete(entry.id);
    this.animatedDoodads.delete(entry.id);
    this.view.remove(doodad);

    // Materials are intentionally left in the registry: M2 materials are cached and shared across
    // placements (M2Blueprint.cache), so removing them here would darken every other placement of
    // the same model still on screen.
    M2Blueprint.unload(doodad);
  }

  // Place a doodad on the world map, adhereing to a provided position, rotation, and scale.
  placeDoodad(doodad, position, rotation, scale) {
    doodad.position.set(
      -(position.z - this.zeropoint),
      -(position.x - this.zeropoint),
      position.y
    );

    // Provided as (Z, X, -Y)
    doodad.rotation.set(
      rotation.z * Math.PI / 180,
      rotation.x * Math.PI / 180,
      -rotation.y * Math.PI / 180
    );

    // Adjust doodad rotation to match Wowser's axes.
    const quat = doodad.quaternion;
    quat.set(quat.x, quat.y, quat.z, -quat.w);

    const scaleFloat = scale / 1024;

    if (scale !== 1024) {
      doodad.scale.set(scaleFloat, scaleFloat, scaleFloat);
    }

    // World bounding-sphere radius = authored M2 radius x placement scale, matching the reference's
    // `rec+0x68` (`FUN_006952a0`: radius x scale). Read by the distance-fade cull; see
    // pipeline/m2/fade/laws.ts.
    doodad.worldFadeRadius = (doodad.vertexRadius || 0) * scaleFloat;

    // Add doodad to world map.
    doodad.updateMatrix();
    doodad.updateMatrixWorld();
    
    this.view.add(doodad);
  }

  animate(delta, camera, cameraMoved) {
    if (!this.view.visible) {
      return;
    }

    // One of the three `'anim'` span call sites (the others are `World#animateEntities` and
    // `WMOManager#animate`). `CpuSections` sums same-named spans within a frame, so the three
    // report one `anim` total -- the number the plan's <= 2 ms gate is stated against.
    beginAnimSection();

    // Before the walk below, and inside the span: adopting a merge is animation work.
    this.adoptMergedAnimations();

    // Clock-INDEXED, never delta-accumulated, and shared with every other animation consumer -- see
    // `anim/world-clock.ts` and `InstanceAnim`. `delta` is untouched here on purpose.
    const worldClockMs = worldClock.ms;
    const frameIndex = worldClock.frameIndex;

    this.boneBudget.beginFrame();

    const camPos = camera.position;

    this.animatedDoodads.forEach((doodad) => {
      // A member of this map has EITHER keyframes to sample OR billboarded bones, and possibly only
      // the latter -- in which case `instanceAnim` is null and every pose step below is skipped
      // while the billboard step at the bottom still runs.
      const inst = doodad.instanceAnim;

      if (inst) {
        animCounters.resident++;

        // RESIDENCY gate: the variation cycle runs for every loaded doodad, drawn or not.
        // Deliberately separate from the pose gate below -- benilla `doodad_anim.rs:20-25`. A doodad
        // behind the camera keeps cycling; it just stops being posed. Because sampling is
        // clock-indexed that costs nothing and drifts nothing.
        cycleDoodad(inst, worldClockMs);
      }

      // DRAW gate: only what is actually drawn gets posed or turned.
      if (!doodad.visible) {
        if (inst) {
          animCounters.skipped++;
        }
        return;
      }

      // `touched` drives the scene walk in `World#updateDynamicMatrices`. Only a doodad whose bones
      // actually moved this frame needs its subtree re-accumulated, and that walk is O(bones) --
      // comparable to `solveBones` itself, so leaving it ungated would have handed back most of
      // what the gates above just saved.
      let touched = false;

      // NON-BONE channels: UV scroll, transparency, vertex colour.
      //
      // Deliberately NOT inside `poseDoodad`. That path is behind the `useSkinning` test below AND
      // behind the distance-decimation and bone-budget gates, and neither applies here: a scrolling
      // waterfall or a pulsing glow often has no animated bone at all (so `useSkinning` is false),
      // and a doodad the bone gates denied still has to keep scrolling -- there are no bones to
      // budget for these three channels, only a handful of scalar samples.
      //
      // Behind the DRAW gate above, though. The values are only read per draw
      // (`applyAnimatedUniformsBeforeRender`), and sampling is clock-indexed, so an undrawn doodad
      // that resumes samples the value the shared clock dictates rather than a stale one.
      if (inst) {
        animCounters.materialsEvaluated++;
        doodad.evaluateMaterialChannels(worldClockMs);
      }

      // BONE-MESH gate. `classify()` returns true for UV, transparency and vertex-colour animation
      // with no bone tracks at all, but `useSkinning` is driven only by `boneDef.animated`, and
      // `createMesh` parents the root bones ONLY on the skinning branch. For such a model the bones
      // are orphaned from the scene graph, so solving them charges the bone budget and writes into
      // objects nothing reads. The instance must still be resident and must still cycle -- Task 14
      // needs its clock for the UV and transparency channels -- so this gates the BONE work only,
      // never the membership.
      if (inst && doodad.useSkinning) {
        touched = this.poseDoodad(doodad, inst, camPos, frameIndex, worldClockMs);
      } else if (inst) {
        animCounters.skipped++;
      }

      if (cameraMoved && doodad.billboards.length > 0) {
        doodad.applyBillboards(camera);
        touched = true;
      }

      if (touched) {
        doodad.poseFrame = frameIndex;
      }

      if (doodad.skeletonHelper) {
        doodad.skeletonHelper.update();
      }
    });

    endAnimSection();
  }

  /**
   * Distance-decimate, budget, solve and apply one visible instance's pose.
   *
   * The gate itself now lives in `anim/pose-gate.ts`, shared with the WMO-interior doodads and the
   * units Task 16 added: it turns on two details (measure from `matrixWorld`, phase on a dense
   * `poseSlot`) that a second hand-written copy gets wrong quietly. This wrapper is what supplies
   * THIS manager's bone budget.
   */
  poseDoodad(doodad, inst, camPos, frameIndex, worldClockMs) {
    return poseGatedInstance(doodad, inst, camPos, frameIndex, worldClockMs, this.boneBudget);
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight) {
    this.mapLight = mapLight;
    
    // Propagate to all existing doodads
    this.doodads.forEach((doodad) => {
      if (doodad.setMapLight) {
        doodad.setMapLight(mapLight);
      }
    });
  }

  /**
   * Update lighting for all doodads
   */
  updateLighting() {
    if (!this.mapLight) return;
    
    this.doodads.forEach((doodad) => {
      if (doodad.updateLighting) {
        doodad.updateLighting();
      }
    });
  }

}

export default DoodadManager;
