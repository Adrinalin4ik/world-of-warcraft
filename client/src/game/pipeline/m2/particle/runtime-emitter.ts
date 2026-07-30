import { integratePool } from './integrate';
import { ParticlePool } from './pool';
import { spawnParticle, SpawnParams } from './spawn';
import { evaluateAnimationTrack, evaluateAnimationTrackStep } from './tracks';

/**
 * One live particle emitter: a parsed M2Particle definition bound to a pool.
 *
 * Emission is accumulated as a fraction. A rate of 3 per second stepped at 60 FPS works out to 0.05
 * particles per frame, so truncating each frame's share to an integer would emit nothing at all,
 * forever -- and would silently make an emitter's behaviour depend on frame rate.
 *
 * WARNING: this class currently assumes it owns its pool exclusively. `step()` calls
 * `integratePool` on the *entire* pool, and `liveCount` reports the *entire* pool's live count --
 * both are only correct when no other emitter shares that pool. Before this can be wired up to a
 * shared pool (which the Phase 2b manager will use to honour a single global 20 000-particle
 * budget), three things have to change together:
 *   1. Integration must move to the manager as a single pass over the shared pool, not be called
 *      once per emitter -- otherwise every particle gets aged and forced N times per frame, once
 *      per emitter that shares the pool.
 *   2. Forces (gravity, drag) are per-emitter; a single shared-pool integration pass needs
 *      per-slot force parameters, or one emitter's gravity leaks onto another's particles.
 *   3. The pool needs per-slot owner tracking so `liveCount` and the `capacity` check below can
 *      be scoped to "particles this emitter owns" rather than "particles anyone owns" -- as
 *      written, the first emitter stepped would consume the whole shared budget and every later
 *      emitter would read itself as permanently over cap.
 */
export class RuntimeEmitter {

  /** Fallback particle lifespan, in seconds, when an emitter's lifespan track is empty or evaluates to
   * zero or less. A silently-zero lifespan would free every particle on its first integration step,
   * which spawns and instantly kills at full rate forever -- indistinguishable from a broken pool. */
  static DEFAULT_LIFESPAN_SECONDS = 1;

  readonly definition: any;
  readonly pool: ParticlePool;

  animationIndex = 0;
  enabled = true;
  capacity: number;

  private random: () => number;
  private pending = 0;
  private spawnParams: SpawnParams;
  private animationTimeMs = 0;

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

  private at = (block: any, fallback: number) =>
    evaluateAnimationTrack(block, this.animationIndex, this.animationTimeMs, fallback);

  private atStep = (block: any, fallback: number) =>
    evaluateAnimationTrackStep(block, this.animationIndex, this.animationTimeMs, fallback);

  /**
   * @param dt animation-independent step, in seconds
   * @param animationTimeMs the owning model's current animation time, already wrapped to the
   *   model's animation duration. Wrapping is the manager's job, not this class's: the manager is
   *   the only place that knows the duration, and an emitter that accumulated its own time would
   *   run its animated inputs (emission rate, enabledIn, ...) once and then hold the last key
   *   forever once the model's animation loops.
   */
  step(dt: number, animationTimeMs: number) {
    this.animationTimeMs = animationTimeMs;

    const definition = this.definition;
    const at = this.at;
    const atStep = this.atStep;

    integratePool(this.pool, dt, {
      gravity: at(definition.gravity, 0),
      drag: definition.drag || 0,
    });

    if (!this.enabled) {
      return;
    }

    // enabledIn gates emission on the owning model's current animation. An emitter with no track is
    // always enabled -- most world emitters leave it empty -- so the fallback must be 1, not 0.
    // This is a flag, not a continuous quantity, so it must not be interpolated (Finding 4):
    // lerping between an ON key and an OFF key would read 0.5, which is neither.
    if (atStep(definition.enabledIn, 1) === 0) {
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

    // An empty lifespan track (or one that evaluates to <= 0) falls back to
    // DEFAULT_LIFESPAN_SECONDS rather than 0 -- see the class-level doc comment on that constant.
    const baseLifespan = at(definition.lifespan, RuntimeEmitter.DEFAULT_LIFESPAN_SECONDS);
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
        params.lifespan = baseLifespan > 0 ? baseLifespan : RuntimeEmitter.DEFAULT_LIFESPAN_SECONDS;
      }

      spawnParticle(this.pool, slot, params, this.random);
    }
  }

}
