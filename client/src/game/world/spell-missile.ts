import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { spellData } from '../pipeline/dbc/spell-data';
import { warnOnce } from '../ui/framexml/lua/methods/region';
import spellMotion, { MotionOffset } from './spell-motion';
import { spellFxParticleSize } from './spell-fx-scale';
import type Unit from '../classes/unit';

/**
 * SPELL MISSILES -- the travelling projectile a `Speed > 0` cast launches, and the impact hand-off
 * when it arrives. The owner's "не вижу эффекта самого снаряда, т.е. основной вещи".
 *
 * `world/spell-kit-effects.ts` is its sibling: that file hangs the precast and release kits on the
 * caster, this one flies the thing between the caster and the target.
 *
 * ## The gate is `Spell.dbc` Speed ALONE
 *
 * Not `hasMissile` (`SpellVisual` column 7) and not the model column. The reference is explicit and
 * byte-pinned: "the spawn gate is Speed **alone** ... every basic shot spell has no `SpellVisual` row
 * at all and still flies" (`benilla-app/src/creature_anim/spell_visual.rs:951-953`). `hasMissile`'s one
 * reader there is a different suppressor entirely, which is why this file never reads it.
 *
 * ## The flight law is ARRIVE-ON-TIME HOMING, and it is the reference's, not a lerp
 *
 * `entities/missile.rs:18-19`: "the **arrival deadline is fixed at GO** (the client's `0x61ceb0`:
 * remaining travel time = `distance / Spell.dbc Speed` **minus the time spent queued**"; then in
 * flight (`:26-28`), "each frame the missile covers `remaining distance / remaining time * dt` toward
 * the target's destination attach point -- so a moving target bends the path (homing) and arrival
 * lands exactly on schedule."
 *
 * The "minus the time spent queued" term is ZERO here, and that is not a truncation of the formula:
 * it exists because the reference parks projectiles until the cast animation's release keyframe, and
 * this client launches at GO (the first named deviation below), so nothing is ever queued. The
 * formula is complete for the edge this code actually launches on.
 *
 * That is a genuinely different law from a lerp along a fixed line: the DEADLINE is fixed at launch
 * while the DIRECTION is re-resolved every frame, so a target who runs is chased and still hit on the
 * original schedule. A missile whose deadline is already past when it gets here "arrives on the spot
 * -- at melee range there is no visible flight or trail at all" (`missile.rs:20-22`), which is why the
 * zero-time case below is an impact and not a discard.
 *
 * ## THE ARC ON TOP OF IT IS THE GAME'S OWN LUA, AND IT IS NOW RUNNING
 *
 * The straight line above is the reference's whole flight law; the reference has no motion table at
 * all and admits "a lobbed shot reads as a straight glide here" (`missile.rs:59-61`).
 * `SpellMissileMotion.dbc` supplies the missing arc as **Lua source**, and `world/spell-motion.ts`
 * compiles and evaluates it -- with the frame cost measured BEFORE it was written, which is the whole
 * reason it exists at all (0.014 ms for one projectile, 0.096 ms for eight, against a 16.67 ms frame).
 * That file carries the numbers, the rejected alternatives and the unresolved trig-unit question.
 *
 * **How the offset is APPLIED is derived here, not ported, because nothing to port exists.** The
 * script yields `transMag` (a magnitude), `transAngle` (an angle around the flight axis) and the three
 * explicit axis terms `transFront`/`transRight`/`transUp`. This composes them in a basis built at
 * launch -- forward along the flight, right horizontal, up completing it -- as
 *
 *     offset = (up * cos(transAngle) + right * sin(transAngle)) * transMag
 *              + forward * transFront + right * transRight + up * transUp
 *
 * with `transAngle = 0` therefore meaning STRAIGHT UP. That pairing is the derivation: row 13
 * `Parabola` sets `transAngle = 0` and a positive `transMag`, and a parabola is a vertical bulge, so
 * angle zero must be the up axis. **The falsifier is direct and the owner can see it** -- if Fireball
 * bulges SIDEWAYS instead of upward, the cos/sin pair is swapped and nothing else in this file is
 * wrong. It is stated this plainly because `CLAUDE.md` records that every orientation defect here has
 * been two conventions meeting, and this is a place where a convention had to be chosen.
 *
 * ## Named deviations from the reference, each with its reason
 *
 *  - **Launch is GO-keyed, not release-keyed.** The reference parks projectiles on the caster and
 *    launches them when the cast animation's release keyframe fires -- `$CSL`/`$CSR`/`$CST`/`$BWR`
 *    (`missile.rs:8-16`) -- so the fireball leaves the raised hand at the top of the throw. This client
 *    has no animation-event dispatcher, so GO is the only edge available. The visible difference is
 *    that the projectile starts from the caster's body rather than from the hand at release.
 *  - **The aim point is the target's body, not its destination attach point.** The reference homes to
 *    the attach tag `SpellVisual` column 9's ordinal names through `MISSILE_ATTACH_TABLE`. That table
 *    is MEASURED to be unavailable on this build: the reference dumps 11 entries for 1.12 and this
 *    build's ordinals reach **19**, so the table grew and its contents are not known here -- recorded
 *    on that column in `dbc/entities/spell-visual.js`. Aiming at the body is the reference's own
 *    fallback for an out-of-table ordinal ("the target base position, the client's `-1` sentinel
 *    path"), so this is its degraded arm rather than a new rule.
 *  - **A missed target still gets a projectile that ends on it.** The reference does the same and names
 *    the deflection it omits; the victim's dodge/block clip is additionally not played here, which
 *    needs the defense-clip route this file does not touch.
 *  - **The wire AMMO model is not resolved.** A `Speed > 0` spell whose visual chain names no model
 *    (every basic shot: Auto Shot, the Shoot family, Throw) flies INVISIBLY here. The reference calls
 *    that its phase 5 and resolves an `ItemDisplayInfo` row by shape (`missile.rs:33-40`). Counted in
 *    `stats.modelless` and warned once, so "the arrow is invisible" is a named gap and not a mystery.
 *
 * ## Frame cost
 *
 * UI draw-list fingerprint: **ZERO**, by construction -- world models in the world scene, which
 * `drawListSignature` mixes UI draw items only and cannot see. Same argument as
 * `spell-kit-effects.ts`, `selection-ring.ts` and `nameplates.ts` each make about themselves, so the
 * 4-7.5 ms offscreen saving on ~92% of frames is untouched.
 *
 * Idle: one array-length compare. Per live missile per frame: one target lookup, one vector subtract,
 * one length, one scalar divide and one `updateMatrix` -- and **no allocation**, because the two
 * scratch vectors are module-level. A cast flies one projectile per wire target, so the count is
 * bounded by the GO's own hit list.
 *
 * NOT MEASURED and named as owed: the millisecond cost of the projectile models' own emitters inside
 * `ParticleManager#animate`. That needs the models parsed in a browser.
 *
 * ## The floating-promise warning, closed
 *
 * `register` below starts a texture load per emitter from inside a `.then` handler, which is what
 * Bluebird reported. The handler now RETURNS `ParticleManager#ready`, joining the chain instead of
 * silencing the report; the handle never rejects and does not gate the flight, so a projectile's
 * first frames still draw with the placeholder texture exactly as before. The whole finding is in
 * `world/spell-kit-effects.ts` and the contract is on `particle/manager.ts#ready`.
 *
 * ## No material is written
 *
 * Same discipline as the kit effects: a projectile model instances, so a clone shares the source's
 * batches and writing one would be a write into every copy of that path in the zone. `ownsBatches` is
 * the test and this file never needs it -- it positions, registers and removes, and sets no colour,
 * alpha or tint.
 */

/** Module-level scratch, so the per-frame path allocates nothing. */
const toTarget = new THREE.Vector3();
const launchPoint = new THREE.Vector3();
const straightAt = new THREE.Vector3();
const offset = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 0, 1);

/**
 * How high above a unit's origin a projectile is launched from and aimed at, in world units.
 *
 * **UNEXPLAINED, and said so rather than sourced.** The reference launches from the release
 * keyframe's live bone position and aims at a destination attach point, and neither is available here
 * -- see the two named deviations above. A projectile flying between two pairs of FEET would be
 * visibly wrong in a way neither of those gaps requires, so both ends are lifted. This is the one
 * number in this file with no citation behind it; it goes away when the attach table is known.
 */
const BODY_HEIGHT = 1.2;

/** What this module needs of `map.particleManager`. Same shape the sibling effect modules declare. */
interface ParticleManager {
  register: (instance: unknown) => number;
  unregister: (instance: unknown) => void;
  /** The readiness handle -- see `pipeline/m2/particle/manager.ts#ready`. Never rejects. */
  ready: (instance: unknown) => Promise<void>;
}

/** One projectile in flight. */
interface Missile {
  model: (THREE.Object3D & { updateMatrix?: () => void }) | null;
  manager: ParticleManager | null;
  spellId: number;
  /** The unit being homed to, or null for the ground-point fallback. */
  targetGuid: string | null;
  /** The fixed world point a ground missile flies at. */
  groundAt: THREE.Vector3 | null;
  /** Where it is now. Held here rather than read off the model, which may not have loaded yet. */
  at: THREE.Vector3;
  /** Seconds left until the arrival deadline, fixed at launch and never recomputed. */
  remaining: number;
  /** True when the target was in the GO's MISS list -- arrival plays no impact kit. */
  missed: boolean;

  // ---- the motion script's state, all fixed at launch. See `world/spell-motion.ts`.
  /** The whole flight time, so `progress` and `time` can be derived from `remaining`. */
  totalTime: number;
  /** `startDistance` -- launch-to-aim distance at launch, the input 93 of 204 rows read. */
  startDistance: number;
  /** Which of this cast's projectiles this is, and how many there are: 32 rows read the pair. */
  index: number;
  count: number;
  /** `rand1`/`rand2`/`rand3` -- per-missile seeds, so a seeded row is pure PER MISSILE. */
  rand1: number;
  rand2: number;
  rand3: number;
  /** The flight basis, built once at launch. `forward` is launch -> aim; `up` completes the pair. */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  /** Where the straight line starts, kept so the offset is applied to the unoffset path. */
  from: THREE.Vector3;
}

export class SpellMissiles {
  private scene: THREE.Scene;

  private live: Missile[] = [];

  /** THE INSTRUMENT -- a flight that never starts is otherwise only an absence. */
  public stats = {
    /** Launches asked for: one per hit, one per miss, or one at a ground point. */
    launched: 0,
    /** Launches with no model at all -- the visual chain named none and the ammo route is unbuilt. */
    modelless: 0,
    /** Arrivals that handed off to an impact kit. */
    impacts: 0,
    /** Casts refused because the spell has no Speed. Expected for most spells. */
    speedless: 0,
    /** Model loads that threw. */
    failed: 0,
    /**
     * THE THREE SILENT GATES, counted because the projectile is invisible and the kit effects are not.
     *
     * Two lanes sharing one manager, one material and one batch, with one visible and one not, is the
     * cleanest lead in this thread -- and every difference is upstream of the renderer, in gates that
     * until now returned without saying anything. The kit lane has none of these: it never touches the
     * `SMSG_SPELL_GO` tail, never needs a target position, and never asks `Spell.dbc` for a Speed.
     */
    /** `SMSG_SPELL_GO`'s target tail failed its stride check, so no missile was allowed to launch. */
    implausibleTail: 0,
    /** The tail decoded, but named no unit target and carried no ground point. Nothing to fly at. */
    noTargets: 0,
    /** A named target was not in our object set, so `unitAt` gave no position to aim at. */
    targetNotInWorld: 0,
    /** The model landed after the flight had already ended. */
    lateModel: 0,
  };

  public lastError: string | null = null;

  /**
   * The models currently in flight, for `window.worldSpellFxScale` to retune live. Yields the
   * MODEL rather than the entry, because `particleSizeScale` is a property the manager reads off
   * the instance -- see `world/spell-fx-scale.ts`.
   */
  public liveModels(): Array<{ particleSizeScale?: number }> {
    return this.live
      .map((entry) => entry.model as unknown as { particleSizeScale?: number })
      .filter((model) => model !== null && model !== undefined);
  }

  /** Where each projectile is, and where it is aiming. See `SpellKitEffects#liveTransforms`. */
  public liveTransforms(): Array<{ spellId: number; at: number[]; remaining: number; hasModel: boolean }> {
    return this.live.map((m) => ({
      spellId: m.spellId,
      at: [Math.round(m.at.x * 100) / 100, Math.round(m.at.y * 100) / 100, Math.round(m.at.z * 100) / 100],
      remaining: Math.round(m.remaining * 1000) / 1000,
      hasModel: m.model !== null,
    }));
  }

  public get liveCount(): number {
    return this.live.length;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Launch this cast's projectiles: one per hit, one per miss, or exactly one at the ground point when
   * the GO carried no unit targets at all -- the reference's location fallback (`missile.rs:52-58`,
   * "the hunter's Flare arcing out to where it was placed").
   */
  launch(
    caster: Unit,
    spellId: number,
    hits: string[],
    misses: string[],
    groundAt: { x: number; y: number; z: number } | null,
    particleManager: ParticleManager | null,
    unitAt: (guid: string) => THREE.Vector3 | null,
  ): void {
    const speed = spellData.spellSpeed(spellId);
    if (!(speed > 0)) {
      // NOT a gap: the great majority of spells have no projectile, and Speed is the whole gate.
      this.stats.speedless += 1;
      return;
    }

    launchPoint.copy(caster.position);
    launchPoint.z += BODY_HEIGHT;

    // Resolved ONCE per cast: the path is the same for every target of the same spell, and
    // `M2Blueprint` caches per path, so only the first projectile of a kind pays a fetch.
    const visualId = spellData.spell(spellId)?.visualID ?? 0;
    const modelPath = visualId === 0 ? null : spellData.missileModelPath(visualId);

    const targets: Array<{ guid: string; missed: boolean }> = [
      ...hits.map((guid) => ({ guid, missed: false })),
      ...misses.map((guid) => ({ guid, missed: true })),
    ];

    if (targets.length === 0) {
      if (groundAt === null) {
        // No targets and no point. The cast still animates through the kit path; nothing flies.
        this.stats.noTargets += 1;
        return;
      }
      this.spawn(
        spellId, null, new THREE.Vector3(groundAt.x, groundAt.y, groundAt.z),
        false, speed, modelPath, particleManager, unitAt, 0, 1,
      );
      return;
    }

    for (let i = 0; i < targets.length; i += 1) {
      this.spawn(
        spellId, targets[i].guid, null, targets[i].missed, speed, modelPath, particleManager, unitAt,
        i, targets.length,
      );
    }
  }

  private spawn(
    spellId: number,
    targetGuid: string | null,
    groundAt: THREE.Vector3 | null,
    missed: boolean,
    speed: number,
    modelPath: string | null,
    particleManager: ParticleManager | null,
    unitAt: (guid: string) => THREE.Vector3 | null,
    index: number,
    count: number,
  ): void {
    // THE DEADLINE, fixed here and never recomputed: distance / Speed (`missile.rs:17-19`). Measured
    // from the aim point at LAUNCH, so a target who then runs is chased inside the original window.
    const aim = targetGuid === null ? groundAt : unitAt(targetGuid);
    if (aim === null) {
      // The target is not in our object set -- nothing to fly at, and no invisible flight either.
      this.stats.targetNotInWorld += 1;
      return;
    }
    toTarget.copy(aim);
    if (targetGuid !== null) {
      toTarget.z += BODY_HEIGHT;
    }
    const startDistance = toTarget.distanceTo(launchPoint);
    const remaining = startDistance / speed;

    this.stats.launched += 1;

    // THE FLIGHT BASIS, built once. `right` is horizontal by construction (forward crossed with world
    // up), so a level shot gets a level `right` and `up` lands vertical -- which is what makes
    // `transAngle = 0` read as straight up. A perfectly vertical shot degenerates (forward parallel to
    // world up), and then `right` falls back to world X rather than becoming zero: an arbitrary but
    // stable pair beats a NaN basis, and a straight-up projectile has no visually meaningful "right".
    const forward = new THREE.Vector3().subVectors(toTarget, launchPoint);
    if (forward.lengthSq() < 1e-8) {
      forward.set(1, 0, 0);
    } else {
      forward.normalize();
    }
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-8) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const missile: Missile = {
      model: null,
      manager: particleManager,
      spellId,
      targetGuid,
      groundAt: groundAt === null ? null : groundAt.clone(),
      at: launchPoint.clone(),
      remaining,
      missed,
      totalTime: remaining,
      startDistance,
      index,
      count,
      // The three seeds a script may read. `Math.random` per missile is what makes a seeded row differ
      // between projectiles of the same volley while staying pure for any one of them.
      rand1: Math.random(),
      rand2: Math.random(),
      rand3: Math.random(),
      forward,
      right,
      up,
      from: launchPoint.clone(),
    };
    this.live.push(missile);

    if (modelPath === null) {
      // "No model at all (no chain, no ammo) -> the missile flies invisible and still impacts on
      // schedule" (`missile.rs:40-41`). Named, not silent: the ammo route is the reference's phase 5.
      this.stats.modelless += 1;
      warnOnce(
        `spell missile: spell ${spellId} has Speed but its visual chain names no model -- it flies `
        + 'invisible. The wire ammo-model route (arrows, bullets, thrown weapons) is not implemented.',
      );
      return;
    }

    void M2Blueprint.load(modelPath)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        // The flight may already be over: arrival does not wait on a fetch, exactly as the deadline
        // does not. Release the handle rather than adding a model to a missile that has landed.
        if (!this.live.includes(missile)) {
          this.stats.lateModel += 1;
          M2Blueprint.unload(model as never);
          return;
        }
        model.position.copy(missile.at);
        // BOTH calls: the scene is `matrixWorldAutoUpdate = false` and `M2` sets
        // `matrixAutoUpdate = false` on itself, so without them a model added here draws at the world
        // ORIGIN. `level-up-effect.ts` records the same trap.
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        this.scene.add(model);
        model.updateMatrixWorld(true);
        // NOT `model.visible = true`, and that was a defect here for two rounds.
        //
        // `M2` hides itself at construction (`pipeline/m2/index.ts:242`, `this.visible = false`), and a
        // particle effect must STAY hidden: `ParticleManager` adds each emitter's batch to its own
        // group (`particle/manager.ts:150`, constructed from `map.js:200`'s `particleGroup`), NOT to
        // the model's subtree, so the particles draw whatever the model's own flag says. Un-hiding the
        // model therefore adds nothing to the effect and reveals its MESH -- which for an effect model
        // nothing poses is a static shape at bind pose.
        //
        // `level-up-effect.ts` and `game-object-sparkle.ts` are the working precedent and neither sets
        // it; this copied the flag from `character/dress.ts`, where it IS required, because a
        // bone-attached ITEM's geometry is the thing being drawn and no visibility manager will ever
        // enable it. Two lanes, two conventions, and the wrong one was borrowed.
        //
        // Measured before removing it, because a plausible fix is not a verified one
        // (`__bench__/effect-emitter-probe.test.ts`): of six real effect models, `ChargeTrail.mdx`,
        // `DustCloud_Land.mdx`, `Fire_Precast_Hand.mdx` and `Shadow_Precast_Uber_Hand.mdx` carry
        // **0 vertices** -- pure emitters, for which this flag could never have drawn anything either
        // way -- while `Fireball_Missile_Low.mdx` has 43, `ThunderClap_Cast_Base.mdx` 178 (authored box
        // 12.7 x 13.0 x 8.7) and `Frost_Nova_state.mdx` 614 (9.7 x 9.7 x 2.7). Those three are the ones
        // this flag was wrongly drawing, and the last two are large enough to read as sheets.
        // Without this a PARTICLE model draws nothing at all -- and a projectile is one.
        // THE PARTICLE SIZE MULTIPLIER, read by `ParticleBatch#pack` every frame. Defaults to 1,
        // i.e. the size the asset authors -- `world/spell-fx-scale.ts` carries the measurement that
        // says 1 is what the game's own data asks for, and why no other number is picked here.
        (model as unknown as { particleSizeScale?: number }).particleSizeScale = spellFxParticleSize();
        particleManager?.register(model);
        missile.model = model;
        // RETURNED, not orphaned -- the same reason as `spell-kit-effects.ts`, and the handle never
        // rejects and does not gate the flight. See `ParticleManager#ready`.
        return particleManager?.ready(model);
      })
      .catch((e) => {
        this.stats.failed += 1;
        this.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      });
  }

  /**
   * One frame of flight.
   *
   * `unitAt` is re-resolved every frame, and that is what makes this HOMING rather than a lerp: the
   * direction is re-taken while the deadline stays where launch put it. A target that leaves the world
   * mid-flight freezes the aim rather than cancelling the projectile -- it still arrives on schedule,
   * which is the arrive-on-time contract.
   *
   * `onImpact` is the hand-off (`missile.rs:27-30`, the client's unit-impact `0x61dc50`): the impact
   * KIT plays on the victim, which is the other half of what this round's `SMSG_SPELL_GO` tail decode
   * bought.
   */
  update(
    deltaMs: number,
    unitAt: (guid: string) => THREE.Vector3 | null,
    onImpact: (targetGuid: string, spellId: number) => void,
  ): void {
    if (this.live.length === 0) {
      return;
    }
    const dt = deltaMs / 1000;

    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const missile = this.live[i];

      missile.remaining -= dt;
      if (missile.remaining <= 0) {
        // ARRIVAL. A deadline already past at launch lands here on the first frame, which is the
        // reference's melee-range case: no visible flight, just the impact.
        if (!missile.missed && missile.targetGuid !== null) {
          this.stats.impacts += 1;
          onImpact(missile.targetGuid, missile.spellId);
        }
        this.remove(i);
        continue;
      }

      const aim = missile.targetGuid === null
        ? missile.groundAt
        : unitAt(missile.targetGuid);
      if (aim !== null) {
        toTarget.copy(aim);
        if (missile.targetGuid !== null) {
          toTarget.z += BODY_HEIGHT;
        }
      } else {
        // Target gone: hold position rather than steering at nothing. The deadline still expires.
        toTarget.copy(missile.at);
      }

      // THE ARRIVE-ON-TIME STEP: cover `remaining distance / remaining time * dt`. Deliberately not a
      // constant speed -- a target running away raises the step so the fixed deadline still holds.
      toTarget.sub(missile.at);
      const distance = toTarget.length();
      if (distance > 1e-4) {
        const step = Math.min(distance, (distance / missile.remaining) * dt);
        toTarget.multiplyScalar(step / distance);
        missile.at.add(toTarget);
      }

      // THE MOTION SCRIPT'S OFFSET, on top of the straight arrive-on-time position. `missile.at` stays
      // the UNOFFSET path so the arc is a pure function of progress rather than an accumulating drift
      // -- integrating the offset into `at` would compound it every frame and the projectile would
      // spiral away instead of arcing.
      straightAt.copy(missile.at);
      const shaped = this.applyMotion(missile, straightAt);

      const model = missile.model;
      if (model !== null) {
        model.position.copy(shaped);
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        model.updateMatrixWorld(true);
      }
    }
  }

  /**
   * Offset a missile's straight-line position by its motion script, in place, and return it.
   *
   * The composition and the `transAngle = 0` means up derivation are in this file's header, with the
   * falsifier. `progress` and `time` are derived from the fixed deadline rather than accumulated, so
   * they are exact at every frame regardless of frame pacing.
   *
   * A spell with no motion row returns the straight position untouched, which is the common case and
   * the reference's own behaviour.
   */
  private applyMotion(missile: Missile, at: THREE.Vector3): THREE.Vector3 {
    if (missile.totalTime <= 0) {
      return at;
    }
    const elapsed = missile.totalTime - missile.remaining;
    const progress = Math.min(1, Math.max(0, elapsed / missile.totalTime));
    const travelled = missile.from.distanceTo(at);

    const shape: MotionOffset | null = spellMotion.evaluate(missile.spellId, {
      progress,
      time: elapsed,
      startDistance: missile.startDistance,
      missileIndex: missile.index,
      missileCount: missile.count,
      rand1: missile.rand1,
      rand2: missile.rand2,
      rand3: missile.rand3,
      // The three distance inputs, derived rather than guessed: `distanceToFirePos` is how far the
      // projectile has come, `distanceToImpactPos`/`distanceFromImpactPos` how far is left (the two
      // names are read by 9 and 1 rows and no measurement here distinguishes them, so both get the
      // same value and that is stated rather than hidden), `totalDistance` the whole span.
      distanceToFirePos: travelled,
      distanceToImpactPos: Math.max(0, missile.startDistance - travelled),
      distanceFromImpactPos: Math.max(0, missile.startDistance - travelled),
      totalDistance: missile.startDistance,
    });
    if (shape === null) {
      return at;
    }

    // DEGREES -- see `spell-motion.ts` on why, and on why the choice is contained.
    const radians = shape.transAngle * (Math.PI / 180);
    offset.set(0, 0, 0);
    if (shape.transMag !== 0) {
      offset.addScaledVector(missile.up, Math.cos(radians) * shape.transMag);
      offset.addScaledVector(missile.right, Math.sin(radians) * shape.transMag);
    }
    if (shape.transFront !== 0) {
      offset.addScaledVector(missile.forward, shape.transFront);
    }
    if (shape.transRight !== 0) {
      offset.addScaledVector(missile.right, shape.transRight);
    }
    if (shape.transUp !== 0) {
      offset.addScaledVector(missile.up, shape.transUp);
    }
    return at.add(offset);
  }

  private remove(index: number): void {
    const missile = this.live[index];
    if (missile.model !== null) {
      missile.manager?.unregister(missile.model);
      this.scene.remove(missile.model);
      // A refcount decrement, not a free -- another projectile of the same path may still be flying.
      M2Blueprint.unload(missile.model as never);
    }
    this.live.splice(index, 1);
  }

  /**
   * The tail was unusable, so nothing launched. Called by the GO handler rather than counted here,
   * because the gate lives there -- see `stats.implausibleTail`.
   */
  noteImplausibleTail(): void {
    this.stats.implausibleTail += 1;
  }

  /** Drop everything, for a worldport or a teardown. */
  dispose(): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      this.remove(i);
    }
    this.live = [];
  }
}

export default SpellMissiles;
