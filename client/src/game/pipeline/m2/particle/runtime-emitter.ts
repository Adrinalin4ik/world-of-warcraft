import { integratePool } from './integrate';
import { ParticlePool } from './pool';
import { spawnParticle, SpawnParams } from './spawn';
import { evaluateAnimationTrack } from './tracks';

/**
 * One live particle emitter: a parsed M2Particle definition bound to a pool.
 *
 * Emission is accumulated as a fraction. A rate of 3 per second stepped at 60 FPS works out to 0.05
 * particles per frame, so truncating each frame's share to an integer would emit nothing at all,
 * forever -- and would silently make an emitter's behaviour depend on frame rate.
 *
 * `capacity` is a cap the Phase 2b budget allocator writes to each frame; on its own an emitter is
 * limited only by its pool.
 */
export class RuntimeEmitter {

  readonly definition: any;
  readonly pool: ParticlePool;

  animationIndex = 0;
  animationTimeMs = 0;
  enabled = true;
  capacity: number;

  private random: () => number;
  private pending = 0;
  private spawnParams: SpawnParams;

  constructor(definition: any, pool: ParticlePool, random: () => number = Math.random) {
    this.definition = definition;
    this.pool = pool;
    this.random = random;
    this.capacity = pool.capacity;

    // Reused every spawn; allocating one of these per particle would defeat the pool.
    this.spawnParams = {
      emitterType: definition.emitterType,
      areaWidth: 0,
      areaLength: 0,
      verticalRange: 0,
      horizontalRange: 0,
      speed: 0,
      speedVariation: 0,
      lifespan: 0,
      baseSpin: 0,
      spinSpeed: 0,
      zSource: 0,
    };
  }

  get liveCount() {
    return this.pool.liveCount;
  }

  /** Stop emitting. Particles already alive keep running until their lifespan expires. */
  stop() {
    this.enabled = false;
    this.pending = 0;
  }

  step(dt: number) {
    this.animationTimeMs += dt * 1000;

    const definition = this.definition;
    const at = (block: any, fallback: number) =>
      evaluateAnimationTrack(block, this.animationIndex, this.animationTimeMs, fallback);

    integratePool(this.pool, dt, {
      gravity: at(definition.gravity, 0),
      drag: definition.drag || 0,
    });

    if (!this.enabled) {
      return;
    }

    // enabledIn gates emission on the owning model's current animation. An emitter with no track is
    // always enabled -- most world emitters leave it empty -- so the fallback must be 1, not 0.
    if (at(definition.enabledIn, 1) === 0) {
      this.pending = 0;
      return;
    }

    const rate = at(definition.emissionRate, 0);
    if (rate <= 0) {
      this.pending = 0;
      return;
    }

    this.pending += rate * dt;

    const params = this.spawnParams;
    params.emitterType = definition.emitterType;
    params.areaWidth = at(definition.emissionAreaWidth, 0);
    params.areaLength = at(definition.emissionAreaLength, 0);
    params.verticalRange = at(definition.verticalRange, 0);
    params.horizontalRange = at(definition.horizontalRange, 0);
    params.speed = at(definition.emissionSpeed, 0);
    params.speedVariation = at(definition.speedVariation, 0);
    params.baseSpin = definition.baseSpin || 0;
    params.spinSpeed = definition.spinSpeed || 0;
    // Spawn-time initial-velocity override, not a force. See the correction note in Task 4.
    params.zSource = at(definition.zSource, 0);

    const baseLifespan = at(definition.lifespan, 0);
    const lifespanVariation = definition.lifespanVariation || 0;

    while (this.pending >= 1) {
      this.pending -= 1;

      if (this.pool.liveCount >= this.capacity) {
        // Over budget. Drop the backlog rather than carrying it, so that an emitter which spends a
        // while at its cap does not burst the instant capacity frees up.
        this.pending = 0;
        break;
      }

      const slot = this.pool.allocate();
      if (slot < 0) {
        this.pending = 0;
        break;
      }

      params.lifespan = baseLifespan + lifespanVariation * (this.random() * 2 - 1);
      if (params.lifespan <= 0) {
        params.lifespan = baseLifespan;
      }

      spawnParticle(this.pool, slot, params, this.random);
    }
  }

}
