import * as THREE from 'three';

import { ParticleBatch } from './batch';
import { ParticleMaterial } from './material';
import { ParticlePool } from './pool';
import { RuntimeEmitter } from './runtime-emitter';
import { evaluateAnimationTrack } from './tracks';

interface LiveEmitter {
  emitter: RuntimeEmitter;
  batch: ParticleBatch;
  definition: any;
  instance: any;
  // Tracks whether this entry was culled as of the previous animate() call, so the pool is only reset
  // on the transition into culled (see I5) rather than every frame it stays culled.
  culled: boolean;
}

// Reused across animate() calls to avoid an allocation per emitter per frame.
const scratchWorldPosition = new THREE.Vector3();

/**
 * Owns every live particle emitter and its batch.
 *
 * One emitter gets one pool and one batch. That is deliberate for this phase: RuntimeEmitter integrates
 * its whole pool and reports its whole pool's live count, which is only correct while it owns that pool
 * exclusively. The spec's global 20 000-particle budget with proximity ranking needs a shared pool with
 * per-slot ownership and is Phase 2c.
 */
export class ParticleManager {

  /**
   * Ceiling on one emitter's pool. Capacity is normally derived from the emitter's own rate and
   * lifespan; this only bounds a pathological definition, which does exist in game data.
   */
  static MAX_PARTICLES_PER_EMITTER = 512;

  /**
   * World units beyond which an emitter is culled: not stepped, not packed, and drawn with zero
   * instances. Roughly the distance at which a particle a metre across stops being legible. A
   * proximity-ranked global budget with distance-based culling is Phase 2c; this is a cheap interim
   * cutoff to keep every emitter in the loaded world from simulating and drawing every frame.
   */
  static CULL_DISTANCE = 120;

  private group: THREE.Object3D;
  private emitters: LiveEmitter[] = [];
  private registered = new Set<any>();

  constructor(group: THREE.Object3D) {
    this.group = group;
  }

  get emitterCount() {
    return this.emitters.length;
  }

  get liveParticleCount() {
    let total = 0;
    for (const entry of this.emitters) {
      total += entry.emitter.liveCount;
    }
    return total;
  }

  /**
   * Register every particle emitter on a loaded M2 instance.
   *
   * @returns how many emitters were registered
   */
  register(instance: any): number {
    if (!instance || this.registered.has(instance)) {
      return 0;
    }

    const definitions = instance.particleEmitters || [];
    if (definitions.length === 0) {
      return 0;
    }

    // Built locally first so a throw partway through leaves this.emitters, this.group and
    // this.registered untouched -- a malformed definition must not half-register the instance and
    // permanently wedge it behind the registered.has() guard above.
    const built: LiveEmitter[] = [];

    try {
      for (const definition of definitions) {
        const texture = (instance.textures || [])[definition.textureId];
        const texturePath = texture && texture.filename ? texture.filename : '';

        if (!texturePath) {
          // An emitter with no resolvable texture can never draw, so building a batch for it is
          // pure cost -- it would only ever load the empty placeholder path.
          const path = instance && instance.path ? instance.path : instance;
          // eslint-disable-next-line no-console
          console.warn('ParticleManager: skipping emitter with unresolvable textureId', definition.textureId, 'for', path);
          continue;
        }

        const capacity = ParticleManager.capacityFor(definition);

        const material = new ParticleMaterial(texturePath, definition.blendingType);
        const batch = new ParticleBatch(material, capacity, definition.rows, definition.columns);
        const pool = new ParticlePool(capacity);

        built.push({ emitter: new RuntimeEmitter(definition, pool), batch, definition, instance, culled: false });
      }
    } catch (error) {
      for (const entry of built) {
        entry.batch.geometry.dispose();
        (entry.batch.material as THREE.Material).dispose();
      }

      const path = instance && instance.path ? instance.path : instance;
      // eslint-disable-next-line no-console
      console.error('ParticleManager: failed to register emitters for', path, error);

      return 0;
    }

    this.registered.add(instance);

    for (const entry of built) {
      this.group.add(entry.batch);
      this.emitters.push(entry);
    }

    return built.length;
  }

  unregister(instance: any) {
    if (!this.registered.has(instance)) {
      return;
    }

    this.registered.delete(instance);

    this.emitters = this.emitters.filter((entry) => {
      if (entry.instance !== instance) {
        return true;
      }

      this.group.remove(entry.batch);
      entry.batch.geometry.dispose();
      (entry.batch.material as THREE.Material).dispose();

      return false;
    });
  }

  animate(delta: number, camera: THREE.Camera) {
    const cullDistanceSquared = ParticleManager.CULL_DISTANCE * ParticleManager.CULL_DISTANCE;

    // Clamp at the manager boundary: after a backgrounded tab, `Clock.getDelta()` can hand back several
    // seconds' worth of elapsed time in one call. A multi-second Euler step would teleport every live
    // particle across the screen for a frame before the lifespan check kills them. 0.1s (~6 frames at
    // 60fps) is generous for a normal frame and still short enough that a resumed tab doesn't visibly
    // jump.
    const dt = Math.min(delta, 0.1);

    for (const entry of this.emitters) {
      // Read matrixWorld directly instead of calling updateMatrixWorld() up front: the renderer's own
      // scene.updateMatrixWorld() has already produced it this frame, and a static doodad's subtree
      // (submeshes plus bone hierarchy) doesn't need walking again just to answer the cull distance
      // check. Recursing that subtree is only worth paying for emitters that survive the cull below.
      scratchWorldPosition.setFromMatrixPosition(entry.instance.matrixWorld);
      const distanceSquared = camera.position.distanceToSquared(scratchWorldPosition);

      if (distanceSquared > cullDistanceSquared) {
        // Beyond the cull distance: don't step or pack, and draw nothing. Comparing squared
        // distances avoids a per-emitter, per-frame Math.sqrt.
        if (!entry.culled) {
          // Release on the transition into culled, not every frame: an emitter simulates nothing while
          // culled, so re-resetting an already-empty pool every frame would be pure waste. Without this,
          // particles freeze mid-animation instead of being released, so walking away and back shows a
          // stale, frozen puff before the emitter resumes -- and the pool's slots are never reclaimed.
          entry.emitter.pool.reset();
          entry.culled = true;
        }

        (entry.batch.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
        entry.batch.visible = false;
        continue;
      }

      entry.culled = false;
      entry.batch.visible = true;

      // The instance's own matrix places its particles in the world. Emitters bound to a specific bone
      // are Phase 2c; for now every emitter sits at the model's origin.
      entry.instance.updateMatrixWorld(false);

      // advance() is a self-driven stand-in for the model's animation mixer, wrapped to the longest
      // timestamp among the emitter's own animated inputs. Driving this from the mixer's real time,
      // wrapped to the clip duration, is Phase 2c.
      entry.emitter.step(dt, entry.emitter.advance(dt));
      entry.batch.pack(entry.emitter.pool, entry.definition, entry.instance.matrixWorld);
    }
  }

  private static capacityFor(definition: any): number {
    const rate = evaluateAnimationTrack(definition.emissionRate, 0, 0, 0);
    const lifespan = evaluateAnimationTrack(definition.lifespan, 0, 0, RuntimeEmitter.DEFAULT_LIFESPAN_SECONDS);

    // +1 covers the fractional accumulator's overshoot; the floor of 1 keeps a zero-rate emitter from
    // constructing zero-length typed arrays.
    const needed = Math.ceil(Math.max(0, rate) * Math.max(0, lifespan)) + 1;

    return Math.max(1, Math.min(ParticleManager.MAX_PARTICLES_PER_EMITTER, needed));
  }

}
