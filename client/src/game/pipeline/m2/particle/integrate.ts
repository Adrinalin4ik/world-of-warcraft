import { ParticlePool } from './pool';

export interface Forces {
  gravity: number;
  drag: number;
}

/**
 * Step every live particle in a pool and free the expired ones.
 *
 * Order matters: forces adjust velocity, then velocity moves the particle. Doing it the other way
 * round makes the first frame of a particle's life ignore gravity entirely.
 *
 * @returns how many particles were freed this step
 */
export const integratePool = (pool: ParticlePool, dt: number, forces: Forces): number => {
  // exp() once per step rather than once per particle.
  const dragFactor = forces.drag > 0 ? Math.exp(-forces.drag * dt) : 1;
  const gravityStep = forces.gravity * dt;

  let freed = 0;

  pool.forEachLive((slot) => {
    pool.age[slot] += dt;

    if (pool.age[slot] >= pool.lifespan[slot]) {
      pool.free(slot);
      freed++;
      return;
    }

    const base = slot * 3;

    if (gravityStep !== 0) {
      pool.velocity[base + 2] -= gravityStep;
    }

    if (dragFactor !== 1) {
      pool.velocity[base] *= dragFactor;
      pool.velocity[base + 1] *= dragFactor;
      pool.velocity[base + 2] *= dragFactor;
    }

    pool.position[base] += pool.velocity[base] * dt;
    pool.position[base + 1] += pool.velocity[base + 1] * dt;
    pool.position[base + 2] += pool.velocity[base + 2] * dt;

    pool.spin[slot] += pool.spinSpeed[slot] * dt;
  });

  return freed;
};

/**
 * M2Particle file flag `0x4000`: live particles KEEP a fraction of the emitter's per-frame world
 * motion, so the cloud rides the emitter instead of being left behind.
 *
 * The reference is `ParticleEmitterDef::follow_emitter` (`benilla-formats/src/particles.rs:470-472`,
 * wow-re `part-emitter-motion.md` §2/§2b, marked §5-resolved there): "live particles keep exactly
 * follow_line's fraction (<= 1) of the emitter's per-frame world motion -- at saturation the trail
 * rides the emitter rigidly, below it lags toward a world-frozen trail; it never leads."
 *
 * ## THE POLARITY, AND I GOT IT BACKWARDS ONCE -- THE BASELINE IS *RIDE*
 *
 * The reference contradicts itself here and the disagreement is recorded rather than resolved
 * silently. `follow_emitter`'s own doc says "the reference's baseline for this content class is
 * **world-frozen** ... and its `+fraction*delta` add recovers the ride". Forty lines above it,
 * `model_space()`'s doc says the opposite: "Either way the cloud is re-anchored to the emitter's
 * current position every frame ... a moving model carries its flame; there is **NO world-frozen
 * trail mode**."
 *
 * **SELF-REVIEW: THIS FILE ARGUED FOR THE FIRST READING AND THAT WAS WRONG.** It reasoned that
 * Fireball authors no `0x4000` yet trails in the original, so the baseline must be world-frozen.
 * The step that reasoning skipped is that 94.6% of ALL emitters author no `0x4000` either --
 * measured: `0x4000` is 5.4% of 607 missile emitters and 1.5% of 337 doodad emitters -- so a
 * flagless world-freeze is not a port, it is every emitter in the game trailing. It shipped that
 * way for one commit and the owner's next screenshot showed a running mage laying a line of rings
 * across the grass from his SHIELD's hand glow.
 *
 * The measurement that closes it: all four mage shield chains -- Ice Barrier 11426, Mana Shield
 * 1463, Frost Ward 6143, Fire Ward 543 -- resolve to hand-slot models
 * (`ice_precast_uber_hand`, `magic_precast_hand`, `ice_precast_med_hand`, `fire_precast_hand`
 * and siblings) whose **33 emitters carry `0x4000` CLEAR without exception**. A hand glow must ride
 * the hand. So the baseline is RIDE, the flag is what ENABLES the lag, and `model_space()` is the
 * paragraph that was right. `follow_emitter`'s "at saturation the trail rides the emitter rigidly,
 * below it lags toward a world-frozen trail" describes the range WITHIN the flag, not without it.
 *
 * WHICH RE-OPENS FIREBALL'S TAIL as an honest unknown rather than a solved problem. It is NOT this
 * mechanism. The evidenced candidate is file flag **`0x40` `inherits_emitter_motion`**
 * (`particles.rs:485-492`, "VERIFIED"): births inherit the emitter's recent ~30 Hz motion vector
 * scaled by `inherit_scale`, and Fireball's fourth emitter authors it (`0x20055` includes `0x40`).
 * This client does not implement it. That is the next thing to port, and it is a birth-velocity
 * change rather than a per-frame displacement, so it cannot leave a field of rings behind a walking
 * character the way this did.
 *
 * ## The flag word did NOT shift between 1.12 and 3.3.5a, and that was checked rather than assumed
 *
 * Surveyed on the served build with a validated reader (it reproduces the JS parser's bone, ribbon
 * and particle counts and all four of Fireball's flag words exactly): across 129 missile-named
 * `SpellVisualEffectName` models (607 emitters) and a 300-model `GameObjectDisplayInfo` sample
 * (337 emitters), `0x4000` is **5.4% of missile emitters against 1.5% of doodad emitters** -- live,
 * and enriched 3.6x on exactly the content class the reference names ("the hunter missiles author
 * it"). The 1.12 -> runtime remap `0x4000 -> 0x40000` is NOT what this build's file holds: file
 * `0x40000` runs 11.0% / 13.6%, i.e. no enrichment at all, so it is a different flag. The
 * cross-check that pins the word as unshifted is `0x20`
 * (`scale_size_by_instance`, "torches/campfires author it"): 78.9% of doodad emitters against 50.2%
 * of missile ones, and 9/9 vs 0/10 on a hand-split fire-versus-missile control.
 */
/**
 * M2Particle file flag `0x40`: each BIRTH inherits the emitter's recent world motion, added to its
 * own emission velocity.
 *
 * `ParticleEmitterDef::inherits_emitter_motion` (`benilla-formats/src/particles.rs:485-492`, wow-re
 * `part-emitter-motion.md` §1, marked **VERIFIED**): "the emitter keeps a ~30 Hz inherit-velocity
 * vector -- at each trigger (accumulated dt > 1/30 s), `oneFrameDelta * ((1/30)/accum) *
 * inherit_scale`, zeroed while no particles are live -- and each birth adds
 * `(1 + S11*speed_variation) * inherit` to its velocity". The named corpus is "the enchant hands /
 * Bloodlust / Death Wish family (70 emitters / 33 spell models)".
 *
 * ## THIS IS A DIFFERENT AXIS FROM `FOLLOW_EMITTER`, and conflating them is how a polarity inverts
 *
 *   `0x40`   acts ONCE, at birth, on ONE particle's VELOCITY -- it carries motion FORWARD.
 *   `0x4000` acts EVERY FRAME, on EVERY live particle's POSITION -- it leaves motion BEHIND.
 *
 * They are independent in the reference (separate runtime bits `0x400` and `0x40000`) and
 * independent here. An emitter authoring BOTH gets both: its births lead, and all its live particles
 * then lag the anchor -- which is coherent rather than contradictory, because one is a birth impulse
 * and the other a per-frame displacement of the whole cloud. An emitter authoring NEITHER rides its
 * anchor exactly as before either flag existed.
 *
 * ## The (1/30) is a STORAGE convention, not a 30x reduction
 *
 * Read literally, `oneFrameDelta * ((1/30)/accum)` is a DISPLACEMENT over a 1/30 s window, and the
 * reference adds it to a velocity. Those do not have the same units, so one of the two readings has
 * to be named rather than guessed. The trigger fires when `accum > 1/30`, so `accum ~= 1/30` and the
 * factor is `~= 1`: the expression is "the emitter's displacement over a 1/30 s window", i.e. a
 * velocity divided by 30. Our `pool.velocity` is units per SECOND (`integratePool` does
 * `position += velocity * dt`), so the port multiplies back by 30, which cancels the 1/30 and leaves
 * `delta / accum * inherit_scale` -- a plain velocity. Taking the reference's literal expression
 * into a per-second integrator instead would make the inherit 30x too small, i.e. invisible, which
 * would contradict the reference's own account of the mechanism being load-bearing for hand effects.
 */
export const INHERIT_EMITTER_MOTION = 0x40;

export const FOLLOW_EMITTER = 0x4000;

export interface FollowDef {
  flags: number;
  followSpeed1: number;
  followScale1: number;
  followSpeed2: number;
  followScale2: number;
}

/**
 * The fraction of the emitter's motion this frame's live particles KEEP, in 0..1.
 *
 * `0` is a world-frozen trail and `1` is a rigid ride. The line is the reference's load-time
 * `0x7b5d30` (`particles.rs:477-483`): the slope/intercept through the two authored
 * `(speed, fraction)` samples, evaluated at this frame's emitter speed and clamped. Coincident
 * speeds mean "no follow response" and the reference zeroes both, so that degrades to 0 here too --
 * which is the same answer as an unflagged emitter and therefore cannot introduce a third behaviour.
 */
export const followFraction = (definition: FollowDef, emitterSpeed: number): number => {
  if ((definition.flags & FOLLOW_EMITTER) === 0) {
    return 0;
  }
  const span = definition.followSpeed2 - definition.followSpeed1;
  if (Math.abs(span) < 1e-6) {
    return 0;
  }
  const slope = (definition.followScale2 - definition.followScale1) / span;
  const value = slope * emitterSpeed + (definition.followScale1 - slope * definition.followSpeed1);
  return value < 0 ? 0 : value > 1 ? 1 : value;
};

/**
 * Leave `amount` of the emitter's motion BEHIND: subtract it from every live particle's position.
 *
 * The pool stores positions in the emitter's local space and `ParticleBatch#pack` re-places them
 * through the emitter's CURRENT world matrix every frame, so the store is anchor-riding by
 * construction. The reference states the conversion for exactly that case: "over an anchor-riding
 * store the same observable is a `(fraction-1)*delta` move" (`particles.rs:463-469`). This is that
 * move, with the sign carried by the caller passing `(1 - fraction) * delta` and subtracting.
 *
 * SO NOTHING ABOUT GRAVITY'S CONVENTION CHANGES. `delta` arrives already rotated into the pool's own
 * local frame, which is why this takes three scalars rather than a world vector -- see the caller.
 * Integrating in world space instead would have been the smaller diff and would have silently
 * redefined `integratePool`'s gravity, which is applied along the POOL's local -Z
 * (`velocity[base + 2] -= gravityStep`) for every campfire in the game.
 *
 * A zero delta returns before touching the pool, so a static emitter -- every campfire, torch and
 * brazier -- pays one three-way compare and not one write. That is what keeps the unchanged path
 * unchanged.
 */
export const driftPool = (pool: ParticlePool, dx: number, dy: number, dz: number): void => {
  if (dx === 0 && dy === 0 && dz === 0) {
    return;
  }
  pool.forEachLive((slot) => {
    const base = slot * 3;
    pool.position[base] -= dx;
    pool.position[base + 1] -= dy;
    pool.position[base + 2] -= dz;
  });
};
