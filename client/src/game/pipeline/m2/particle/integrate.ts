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
 *   `0x4000` acts EVERY FRAME, on EVERY live particle's POSITION -- it buys back a RIDE, because
 *            world-frozen is the baseline. See `FOLLOW_EMITTER` for the polarity's whole history.
 *
 * They are independent in the reference (separate runtime bits `0x400` and `0x40000`) and
 * independent here. An emitter authoring BOTH gets both: its births lead, and its live cloud rides
 * by `followFraction`'s line -- coherent rather than contradictory, because one is a birth impulse
 * and the other a per-frame displacement of the whole cloud.
 *
 * An emitter authoring NEITHER is left behind in world space, which is the baseline. (This sentence
 * used to read "rides its anchor exactly as before either flag existed" -- correct while the drift
 * was gated on `0x4000` and false the moment that gate came off, so it is corrected here rather
 * than left to mislead.) A STATIC emitter is unaffected either way: its per-frame delta is exactly
 * zero, so it reaches neither mechanism.
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
/**
 * M2Particle file flag `0x10`: the cloud is ORIENTED by the emitter's live bone matrix every frame.
 * Its ABSENCE means the emitter's rotation is baked into each particle AT BIRTH and never re-applied.
 *
 * `ParticleEmitterDef::model_space` (`benilla-formats/src/particles.rs:452-461`, wow-re
 * `part-simspace-fields.md` corrections `1f40db0b`, byte block `0x70faf8-0x70fc44`): "the whole cloud
 * renders through the emitter's **live bone matrix** each frame (rotation and all -- the chandelier's
 * candle flames rigidly ride the swing). **Clear => bone/model rotation is baked at birth instead.**"
 *
 * THE OWNER DESCRIBED EXACTLY THIS DISTINCTION, unprompted, which is what identified it: "они
 * следуют за руками по всем осям. Они не должны ротироваться совсем, но ротируются вместе с руками."
 * Position following is right; rotating with the wrist is not. That is `0x10` clear.
 *
 * ## It is a DIFFERENT AXIS from the two motion flags, and that is why it looked like a dead end
 *
 * An earlier round measured `0x10` as clear on both hand emitters AND on all three Fireball tail
 * emitters and concluded it "does not separate them". True -- and irrelevant, because it was being
 * tested against the wrong question. `0x10` does not govern whether a cloud RIDES or TRAILS (that is
 * `FOLLOW_EMITTER`); it governs whether the cloud is RE-ORIENTED. Three flags, three axes:
 *
 *   `0x10`    ORIENTATION: live bone rotation each frame, or baked once at birth.
 *   `0x4000`  POSITION:    how much of the emitter's motion the live cloud keeps.
 *   `0x40`    BIRTH IMPULSE: the emitter's recent velocity added to a birth.
 *
 * Measured on the served build: `0x10` is clear on every emitter of `Magic_PreCast_Hand`,
 * `Fire_PreCast_Hand`, `Fireball_Missile_Low` and `Fireball_Missile_High` -- so all of them should be
 * baked-at-birth, and this client re-oriented all of them every frame.
 *
 * ## What baking changes, and what it deliberately does not
 *
 * The pool stores model-space offsets and `ParticleBatch#pack` applied the emitter's whole world
 * matrix -- rotation, scale AND translation -- to every particle every frame. Baking splits that: the
 * matrix's LINEAR part (rotation and scale together, so a scaled instance is unaffected) is applied
 * at BIRTH inside `spawnParticle`, and `pack` then adds only the translation column.
 *
 * **A STATIC emitter is byte-identical either way** -- its world matrix never changes, so baking the
 * linear part at birth and adding the translation at pack composes to exactly the same world position
 * as applying the whole matrix at pack. Every campfire, torch and brazier is therefore unaffected by
 * construction rather than by measurement.
 *
 * AND IT FIXES GRAVITY'S FRAME AS A SIDE EFFECT, which is worth stating because it was filed as an
 * open two-conventions problem. `integratePool` applies gravity along the POOL's local -Z. With the
 * old full-matrix pack the pool was model-space, so gravity pointed along the model's rotated -Z --
 * wrong for any rotated emitter. Baked, the pool is WORLD-AXED, so its -Z IS world down and gravity
 * is correct. The defect was measured LATENT (gravity is authored 0 on every emitter measured), so
 * nothing visible changes, but the convention is now right rather than accidentally unused.
 */
export const MODEL_SPACE = 0x10;

export const INHERIT_EMITTER_MOTION = 0x40;

/**
 * ## THE POLARITY, ITS WHOLE HISTORY IN ONE PLACE
 *
 * This has inverted once and a reader should not have to reconstruct it from three commits.
 *
 *   `57efa68`  world-frozen UNGATED. Restored Fireball's tail. Also world-froze the mage shield's
 *              hand glow, which the owner photographed as a line of faint rings across the grass.
 *   `93ee44f`  gated on `FOLLOW_EMITTER`. Removed the rings AND the tail. Justified by "94.6% of
 *              emitters author no flag, so a flagless freeze is not a port" -- true as far as it
 *              goes, and it was still the wrong call, because it made the flag's ABSENCE mean
 *              "ride" when the reference's own `follow_emitter` doc says the absence is the
 *              world-frozen baseline and the flag is what buys the ride back.
 *   THIS ONE    ungated again, deliberately, on arithmetic rather than on a third guess.
 *
 * ## Why ungated, and it is measured rather than argued
 *
 * Fireball's tail is arithmetically ONLY possible if its particles are left behind in world space.
 * Per emitter, with its own authored rate, lifespan and (already half-size-doubled) sprite extent:
 *
 *   Fireball_Missile_Low at the missile's 24 u/s (`Spell.dbc` Speed), world-frozen:
 *     e0  rate 130   life 0.40  ->  52 particles over 9.6 units, spacing 0.185 vs extent 0.556
 *     e1  rate 63.1  life 0.40  ->  25 particles over 9.6 units, spacing 0.380 vs extent 0.444
 *     e2  rate 63.1  life 0.40  ->  25 particles over 9.6 units, spacing 0.380 vs extent 0.444
 *   Every one MERGES -- a continuous 9.6-unit tail, which is the owner's original-client screenshot.
 *
 * And the emission speeds forbid the alternative outright: every Fireball emitter emits at 0 to
 * 1.111 u/s against a 24 u/s carrier, so an anchor-riding emitter holds its cloud within
 * `speed * lifespan` = 0.28-0.44 units of the ball whatever direction it throws. No mapping, and no
 * sign flip, can make a tail out of that.
 *
 * ## THE DISCRIMINATOR DOES NOT EXIST IN THE DATA, and four candidates are now excluded
 *
 * A rule that world-freezes a missile emitter and anchor-rides a hand emitter would be ideal. There
 * isn't one to find:
 *
 *   * NOT `FOLLOW_EMITTER` `0x4000` -- clear on all nine Fireball emitters (`_Low` 0x40009/0x30009/
 *     0x30009/0x20055, `_High` 0x20028/0x40009/0x20055/0x30009/0x30009) and on both
 *     `Magic_PreCast_Hand` emitters (0x20109/0x20469).
 *   * NOT `0x10 model_space` -- clear on all three Fireball tail emitters and clear on both hand
 *     emitters too, while SET on other hand models. It does not separate them.
 *   * NOT the emitter's PARENT BONE, which was the last structural candidate and the reason this
 *     round was spent: Fireball is 4/4 and 5/5 emitters on ROOT bones (parent -1), and the hand
 *     models are mixed -- `Ice_Precast_Uber_Hand` 5/5 descendants, `Ice_Precast_High_Hand` 4/4
 *     descendants, `Magic_Cast_Hand` 2 descendants + 1 root, `Magic_PreCast_Hand` 1 + 1, and
 *     **`Fire_PreCast_Hand` 5/5 ROOT BONES** -- structurally identical to the missile, and it must
 *     ride. A root-bone rule would bead the Fire Ward glow.
 *   * NOT anything the reference supplies: its particle path DEFERS bone-follow entirely --
 *     "Bone-follow @ +0x14 is deferred -- static props sit on the root" (`particles.rs:344`) -- so
 *     it never distinguishes a bone-attached emitter from a root one and cannot arbitrate this.
 *
 * ## THE COST OF UNGATING: SMALLER THAN FIRST FILED, BECAUSE THE FIRST ARITHMETIC WAS MINE AND WRONG
 *
 * This block first read: "the mage shield's hand glow WILL bead again while its owner runs ... eleven
 * particles per second cannot look continuous over 5.6 units at ANY sprite size -- the gap is eleven
 * times the sprite". **The rate and the lifespan were right; the SPRITE SIZE was not.**
 *
 * It used `scaleTrack` key **0** for the extent. `scaleTrack` is an FBlock keyed on the particle's
 * own LIFETIME FRACTION, so key 0 is the BIRTH size and the sprite ramps from it. That is the exact
 * `capacityFor` mistake -- a t=0 read where the track has a ramp -- committed a second time in the
 * same record by the same author. `ParticleBatch#pack` never had the bug: it samples
 * `evaluateFBlockVec2(scaleTrack, age/lifespan)` per particle, which is correct. Only the analysis
 * was wrong.
 *
 * Re-done on each track's PEAK, at a player running ~7 u/s, world-frozen:
 *
 *   Magic_PreCast_Hand
 *     e0  rate 11  life 0.80  8.8 over 5.6u  spacing 0.636  scale 0.028->0.078->0.028  extent 0.156
 *         -> BEADS (gap 4.1x the sprite)
 *     e1  rate 10  life 0.40  4.0 over 2.8u  spacing 0.700  scale 0.139->0.278->0.556  extent 1.111
 *         -> **MERGES** (the sprite is 1.6x the gap)
 *   Fire_PreCast_Hand -- all five merge:
 *     e0 spacing 0.175 vs extent 0.444 · e1 0.108 vs 0.167 · e2 0.700 vs 1.333 ·
 *     e3 0.700 vs 1.333 · e4 0.108 vs 0.167
 *
 * So the beading is ONE emitter of seven across the two models, its sprite is 0.156 units, and it
 * sits inside `Magic_PreCast_Hand` e1's continuous 1.111-unit wash. The "line of rings" the owner
 * photographed cannot have been e0 at 0.156 units; whatever he saw, the arithmetic that predicted it
 * was the discredited t=0 one.
 *
 * WHICH OF THE THREE IT WAS, answered plainly: not a misread rate (`emissionRate` is a SINGLE key,
 * `0ms = 11`, with `emissionRateVariation = 0`), not a misread lifespan (a single key, `0ms = 0.8`,
 * `lifespanVariation = 0`), but a misread APPEARANCE property -- and misread by the analysis, not by
 * the renderer. **Nothing is tuned here, and no number is raised.** The authored values are correct
 * and this client already applies them correctly.
 *
 * The residual -- e0 beading at 4.1x -- is left alone deliberately rather than filed as a defect: it
 * is one small emitter inside a merged wash, and the honest position after two bad arithmetics on
 * this exact question is that it needs the owner's eye before anyone acts on it again.
 *
 * A SIDE EFFECT WORTH RECORDING: the sub-frame birth-distribution question is now dead for BOTH
 * cases. It would only matter where consecutive births are far enough apart to read as separate, and
 * the merging emitters above (0.108 to 0.700 spacing against 0.167 to 1.333 extents) leave nothing
 * for it to smooth.
 *
 * `window.particleTrailControl.enabled = false` restores the gated behaviour for a one-line A/B.
 */
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
