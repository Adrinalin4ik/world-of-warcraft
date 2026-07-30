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
}

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

    this.registered.add(instance);

    let added = 0;

    for (const definition of definitions) {
      const capacity = ParticleManager.capacityFor(definition);

      const texture = (instance.textures || [])[definition.textureId];
      const texturePath = texture && texture.filename ? texture.filename : '';

      const material = new ParticleMaterial(texturePath, definition.blendingType);
      const batch = new ParticleBatch(material, capacity, definition.rows, definition.columns);
      const pool = new ParticlePool(capacity);

      this.group.add(batch);
      this.emitters.push({ emitter: new RuntimeEmitter(definition, pool), batch, definition, instance });

      added++;
    }

    return added;
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

  animate(delta: number) {
    for (const entry of this.emitters) {
      // The instance's own matrix places its particles in the world. Emitters bound to a specific bone
      // are Phase 2c; for now every emitter sits at the model's origin.
      entry.instance.updateMatrixWorld(false);

      // Animation time is not tracked per emitter yet, so unanimated inputs are evaluated at time zero.
      // Driving this from the model's animation mixer, wrapped to the clip duration, is Phase 2c.
      entry.emitter.step(delta, 0);
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
