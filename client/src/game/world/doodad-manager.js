import { animCounters } from '../pipeline/m2/anim/counters';
import { BoneBudget, shouldPose } from '../pipeline/m2/anim/gating';
import { armDoodad, cycleDoodad } from '../pipeline/m2/anim/variation-cycle';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import M2Blueprint from '../pipeline/m2/blueprint';
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
      if (doodad.animated || doodad.billboards.length > 0) {
        this.enableDoodadAnimations(entry, doodad);
      }
    });
  }

  enableDoodadAnimations(entry, doodad) {
    // Maintain separate entries for animated doodads to avoid excessive iterations on each
    // call to animate() during the render loop.
    this.animatedDoodads.set(entry.id, doodad);

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
  }

  /**
   * Distance-decimate, budget, solve and apply one visible instance's pose.
   *
   * Returns whether the bones were actually written, which is what decides if this doodad needs a
   * scene-graph walk this frame. Split out of the loop purely for readability; it allocates nothing.
   */
  poseDoodad(doodad, inst, camPos, frameIndex, worldClockMs) {
    // World-space translation off `matrixWorld`, NOT `doodad.position` -- the same rule
    // `VisibilityManager#enableStaticObjectInFrustum` documents. A terrain doodad's parent sits at
    // the origin so the two agree, but a WMO doodad's position is local to its building, and Task 16
    // reuses this gate.
    const e = doodad.matrixWorld.elements;
    const dx = e[12] - camPos.x;
    const dy = e[13] - camPos.y;
    const dz = e[14] - camPos.z;
    const distanceYd = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (!shouldPose(doodad.poseSlot, distanceYd, frameIndex)) {
      animCounters.skipped++;
      return false;
    }

    // The backstop. Denied instances hold last frame's pose for a frame, which a clock-indexed
    // sampler makes safe.
    if (!this.boneBudget.request(inst.model.boneDefs.length)) {
      animCounters.skipped++;
      return false;
    }

    animCounters.posed++;
    animCounters.bonesSolved += inst.solveBones(worldClockMs);
    doodad.applyPose();

    return true;
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
