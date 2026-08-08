import gameSettings from '../../settings';
import { collisionWorld } from '../../collision/collision-world';
import { traceStage } from '../../perf/frame-trace';
import WorkerPool from '../worker/pool';
import { externalAnims } from './anim/external-anim-binder';
import M2 from './';

class M2Blueprint {

  static cache = new Map();

  // Per-model animation data, keyed by the same normalised path `cache` uses. Built once, by the
  // source M2, and shared by every clone; kept here so callers that hold no M2 (the doodad
  // variation cycler, debug readouts) can still reach a model's sequence table.
  static modelAnims = new Map();

  static references = new Map();
  static pendingUnload = new Set();
  static unloaderRunning = false;

  static UNLOAD_INTERVAL = gameSettings.m2.unloadInterval;

  static load(rawPath) {
    const path = rawPath.replace(/\.md(x|l)/i, '.m2').toUpperCase();

    // Prevent unintended unloading.
    if (this.pendingUnload.has(path)) {
      this.pendingUnload.delete(path);
    }

    // Background unloader might need to be started.
    if (!this.unloaderRunning) {
      this.unloaderRunning = true;
      this.backgroundUnload();
    }

    // Keep track of references.
    let refCount = this.references.get(path) || 0;
    ++refCount;
    this.references.set(path, refCount);

    if (!this.cache.has(path)) {
      this.cache.set(path, WorkerPool.enqueue('M2', path).then((args) => {
        const [data, skinData] = args;

        // TIMED. `new M2` is the first-sight cost that is unavoidably on the main thread: the parse
        // ran in the worker, but building the BufferGeometry, assembling the skeleton from the bind
        // pose, creating the batches and their materials all happen here, once per model PATH. It is
        // therefore the leading suspect for "only a NEW KIND of mob hitches", and the mark is how
        // that suspicion becomes a number instead of an argument. See `perf/frame-trace.ts`.
        const m2 = traceStage('m2.build', path, () => new M2(path, data, skinData));

        this.modelAnims.set(path, m2.modelAnim);

        // Fetch and merge whatever sibling `.anim` files this model's quarantined sequences need.
        // Fire and forget, and off the load promise on purpose: the model must not wait on them.
        // Each merge lifts the quarantine for its own sequence when it lands, and until it does the
        // sequence stays exactly as unplayable as it was -- so an `.anim` that is slow, missing or
        // corrupt costs nothing but the animation it carried. A model with no external sequence
        // (nearly every placed doodad) does no work here at all.
        externalAnims.ensure(path, m2.modelAnim);

        return m2;
      }));
    }

    return this.cache.get(path).then((m2) => {
      // TIMED too, and separately: this is the PER-INSTANCE half. A `canInstance` model shares the
      // source's geometry and batches and the clone is nearly free; a character/creature model that
      // animates does not, and rebuilds its own batches and materials here. Splitting the two marks
      // is what distinguishes "the first of a kind is expensive" from "every one of them is".
      return traceStage('m2.clone', path, () => m2.clone());
    });
  }

  static unload(m2) {
    const path = m2.path.replace(/\.md(x|l)/i, '.m2').toUpperCase();
    // Immediately dispose any non-instanced M2s.
    if (!m2.canInstance) {
      m2.dispose();
    }
    
    let refCount = this.references.get(path) || 1;
    
    --refCount;
    collisionWorld.doodads.remove(m2.boundingMesh);

    if (refCount === 0) {
      this.pendingUnload.add(path);
    } else {
      this.references.set(path, refCount);
    }
  }

  static backgroundUnload() {
    this.pendingUnload.forEach((path) => {
      // Handle disposal for instanced M2s.
      if (this.cache.has(path)) {
        this.cache.get(path).then((m2) => {
          m2.dispose();
        });
      }

      this.cache.delete(path);
      this.modelAnims.delete(path);
      this.references.delete(path);
      this.pendingUnload.delete(path);
    });

    setTimeout(this.backgroundUnload.bind(this), this.UNLOAD_INTERVAL);
  }

  /**
   * There is deliberately no `animate(delta)` here any more.
   *
   * Global sequences advance on world time alone -- there is nothing per-instance to tick. The old
   * `animate(delta)` walked every loaded model to push a delta into a shared AnimationMixer;
   * instances now read `worldClockMs` directly, so the method is gone. Instance posing lives in the
   * per-frame doodad pass (`DoodadManager#animate`), added in Task 13.
   */

}

export default M2Blueprint;
