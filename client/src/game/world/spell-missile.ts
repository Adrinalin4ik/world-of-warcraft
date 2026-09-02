import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { spellData } from '../pipeline/dbc/spell-data';
import { warnOnce } from '../ui/framexml/lua/methods/region';
import spellMotion, { MotionOffset } from './spell-motion';
import { spellFxParticleSize } from './spell-fx-scale';
import { poseEffectModel } from './effect-pose';
import { worldClock } from '../pipeline/m2/anim/world-clock';
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
// Module-level, like every scratch above it: `orient` runs once per live missile per frame.
const scratchBasis = new THREE.Matrix4();
const scratchAxisX = new THREE.Vector3();

/**
 * THE PROJECTILE-ORIENTATION A/B, AND IT NOW DEFAULTS **ON** -- see `SpellMissiles#orient`.
 *
 * `window.missileOrientControl.enabled = false` restores identity rotation, which is what every
 * build before `2286a20` did and what `a038fc0` reverted to. On is the fix: the model's authored
 * EMISSION axis is pointed along the flight.
 *
 * Kept as a knob rather than removed because it is the single line that isolates this change from
 * everything else landing in this subsystem -- one console word gives a before/after on the same
 * cast, which is worth more here than a tidy file.
 */
export const missileOrientControl = { enabled: true };

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).missileOrientControl = missileOrientControl;
}

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
/**
 * What these lanes need of `map.ribbonManager`. Separate from the particle manager on purpose: they
 * share the group and the cull rule, but a ribbon's geometry, shader and simulation are all different,
 * so one object pretending to be both would hide that.
 */
interface RibbonManagerLike {
  register: (instance: unknown) => number;
  unregister: (instance: unknown) => void;
  ready: (instance: unknown) => Promise<void>;
}

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
  /** The ribbon lane this model registered with, so removal releases it too. */
  ribbons: RibbonManagerLike | null;

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
    /**
     * Casts refused because the spell has no Speed. Expected for most spells, and NOT a defect.
     *
     * The counters are per-SESSION totals across every spell, which read as a contradiction once:
     * `speedless: 1` beside `launched: 1` looked like one cast doing both. It was two different GO
     * packets -- Lightning Bolt 403 has `Spell.dbc` column 47 = **20.0** and launched, while some
     * other spell's GO in the same session had no Speed and was refused. `speedlessSpells` records
     * which, so the pair can never be misread that way again.
     */
    speedless: 0,
    /** The spell ids refused for having no Speed, newest last, capped. See `speedless`. */
    speedlessSpells: [] as number[],
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
    ribbonManager: RibbonManagerLike | null = null,
  ): void {
    const speed = spellData.spellSpeed(spellId);
    if (!(speed > 0)) {
      // NOT a gap: the great majority of spells have no projectile, and Speed is the whole gate.
      this.stats.speedless += 1;
      if (!this.stats.speedlessSpells.includes(spellId) && this.stats.speedlessSpells.length < 16) {
        this.stats.speedlessSpells.push(spellId);
      }
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
        false, speed, modelPath, particleManager, unitAt, 0, 1, ribbonManager,
      );
      return;
    }

    for (let i = 0; i < targets.length; i += 1) {
      this.spawn(
        spellId, targets[i].guid, null, targets[i].missed, speed, modelPath, particleManager,
        unitAt, i, targets.length, ribbonManager,
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
    ribbonManager: RibbonManagerLike | null = null,
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
      ribbons: ribbonManager,
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
        this.orient(missile, model);
        // BOTH calls: the scene is `matrixWorldAutoUpdate = false` and `M2` sets
        // `matrixAutoUpdate = false` on itself, so without them a model added here draws at the world
        // ORIGIN. `level-up-effect.ts` records the same trap.
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        this.scene.add(model);
        model.updateMatrixWorld(true);
        const emitterCount = particleManager?.register(model) ?? 0;
        // RIBBON TRAILS. Additive to the particle registration, not an alternative: a lightning
        // bolt's model carries 3 ribbons AND 116 mesh vertices, and the real client draws both. So
        // this does NOT change the visibility rule above -- the rule keys on PARTICLE emitters
        // because that is what decides whether the mesh is the only thing the model can draw.
        ribbonManager?.register(model);
        // THE VISIBILITY RULE, AND IT IS DATA-DRIVEN RATHER THAN A CONVENTION GUESS.
        //
        // `register` returns how many particle emitters it took. That number decides whether this
        // model's MESH is the effect or merely the skeleton its particles hang off:
        //
        //  - **emitters > 0 -> stay hidden.** `ParticleManager` puts each batch in its OWN group
        //    (`particle/manager.ts` over `map.js`'s `particleGroup`), so the particles draw whatever
        //    this flag says. Un-hiding would add nothing and reveal a mesh nothing poses -- which is
        //    what drew the big pale sheets (`ThunderClap_Cast_Base` is 178 vertices in a
        //    12.7 x 13.0 x 8.7 box, `Frost_Nova_state` 614 in 9.7 x 9.7 x 2.7).
        //  - **emitters == 0 -> MUST be visible.** Then the mesh is the only thing the model can
        //    draw, and hiding it draws nothing at all.
        //
        // The second arm is measured, not assumed, and it is why the owner lost the projectile:
        // `Spells\LightningBolt_Missile.mdx` and `Spells\Lightning_PreCast_Low_Hand.mdx` register
        // **0 emitters** and carry **116 vertices, 23 animated bones and 3 RIBBON emitters**
        // (`__bench__/effect-emitter-probe.test.ts`). This client renders no ribbon emitters at all --
        // nothing in `pipeline/m2` references them -- so those two models have only their mesh, and
        // blanket-hiding it in 9f4101b is exactly "И снаряд тоже было видно раньше".
        //
        // NAMED LIMIT: a mesh shown this way still draws in BIND POSE, because nothing poses a
        // free-standing effect model (the `DoodadManager#poseDoodad` gap this file's header records).
        // So Lightning Bolt's projectile is a static shape again rather than an animated one -- which
        // is what the owner saw before and reported as "снаряд не анимирован". Visible-and-static is
        // the honest state; invisible was a regression.
        if (emitterCount === 0) {
          model.visible = true;
        }
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
    camera?: THREE.Camera,
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
        // Re-applied per frame rather than once at spawn: the flight basis is FIXED at launch, but
        // `M2` runs `matrixAutoUpdate = false`, and a model whose quaternion was written before it
        // was added to the scene has had exactly one `updateMatrix` since. Cheap and unconditional
        // beats a dirty flag that has to stay correct across the late-model path above.
        this.orient(missile, model);
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        // THE POSE PASS, before the world-matrix walk rather than after: `poseEffectModel` writes bone
        // TRS, and `updateMatrixWorld(true)` below is what accumulates it -- the ordering the doodad
        // lane keeps through its `poseFrame` stamp. `world/effect-pose.ts` carries the reasoning, and
        // the projectile is why it matters here: `LightningBolt_Missile` has 23 animated bones and was
        // drawing every one of them in bind pose.
        //
        // The return is deliberately DISCARDED, unlike the kit lane's: this lane calls
        // `updateMatrixWorld(true)` unconditionally on the next line because the missile MOVED, so
        // there is nothing a pose-only walk would add.
        poseEffectModel(model, camera, worldClock.frameIndex);
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

  /**
   * POINT THE MODEL'S **EMISSION AXIS** ALONG THE FLIGHT.
   *
   * ## The axis comes from the EMITTER, which is what `2286a20` got wrong
   *
   * That commit derived "forward is +X" from the MD20 bounding box and was reverted (`a038fc0`)
   * because the box is the particle VOLUME, not the body -- Fireball's mesh is 43 vertices spanning
   * `+/-0.18` in all three axes. The box said where the emitters throw and it was written up as the
   * shape of the model.
   *
   * The authored emission axis is measured, not inferred from a silhouette. All four of Fireball's
   * emitters are `emitterType 1` (PLANE), and a plane emitter emits from a rectangle in the
   * emitter's local XY with **velocity along local +Z** (`particle/spawn.ts`: "Zero polar angle
   * sends velocity straight up (+Z)"). With identity rotation -- the state this replaces -- model
   * local +Z IS world +Z, so every one of those emitters threw its spray STRAIGHT UP in world space
   * and the glow hung above the projectile and drifted upward. That is exactly the picture the owner
   * circled, and it is the prediction I parked last round as needing a live run.
   *
   * So the mapping is `model local +Z -> flight forward`, and it is the whole of the fix.
   *
   * ## What that does to the other two axes, and which part is a CONVENTION
   *
   * `makeBasis(a, b, c)` maps +X to `a`, +Y to `b`, +Z to `c`. With +Z pinned to `forward`, the
   * emission RECTANGLE (authored in local XY, sized by `areaWidth`/`areaLength`) becomes the spray's
   * cross-section perpendicular to travel -- which is the correct shape for a jet along the flight,
   * and is a consequence of the mapping rather than a second choice.
   *
   * **THE ROLL ABOUT THE FLIGHT AXIS IS UNDETERMINED BY ANY DATA I CAN READ, and it is fixed here by
   * convention: model +Y points "up" in the flight frame.** Concretely `makeBasis(-right, up,
   * forward)`, using the flight basis already built at launch. `-right` and not `right` because the
   * triple must stay right-handed -- `(-right) x up = forward`, where `right x up = -forward` -- and
   * a mirrored basis would flip every authored asymmetry in the model.
   *
   * This is stated as a convention and NOT excused. `2286a20` justified choosing the roll freely on
   * the grounds that "a spin about the nose is invisible on a radially symmetric fireball", and that
   * excuse is known false: Fireball's particle box is y `+/-1.95` against z `+/-1.63`. The honest
   * position is that the roll is a convention, that world up is the only stable reference available
   * for it, and that a model authored to have a distinguishable top would need the real determinant
   * found before this line could be called correct.
   *
   * ## PITCH, not yaw -- and what a steep shot tests
   *
   * This is necessarily a full 3D pitch: `forward` is a 3D direction, and mapping +Z onto it tilts
   * the model out of the horizontal. A yaw-only rotation (the way `plantTransform` yaws a plant
   * about world Z) would leave local +Z along world up and the spray would still rise -- it would
   * not fix anything, which is why the choice is not free.
   *
   * The owner's shot is nearly flat, so it cannot discriminate the two. **A steep shot is the case
   * that tests this**: firing sharply upward or downward should send the spray along the steep
   * travel direction, not vertically. Under a yaw-only implementation the spray would stay vertical
   * on both; under this one it follows the barrel. A near-vertical shot is also where the roll goes
   * ill-conditioned (`forward` parallel to world up), and the flight basis already handles that by
   * falling back to a stable arbitrary `right` rather than producing a NaN.
   *
   * ## What this should look like
   *
   * The spray should sit BEHIND and along the projectile rather than above it, and the bright core
   * should stop having a glow stacked over it. Whether the big emitter-3 sprite still reads as
   * ELONGATED is a separate and unresolved question -- its 1.94 aspect and zero spin are authored
   * and this changes neither -- but it should now be elongated ALONG the travel rather than at a
   * fixed screen angle unrelated to it, because the cloud it sits in is finally pointing the right
   * way. If it still reads as crosswise after this, the rotation question is genuinely separate and
   * the parked screen-angle observation is what to take next.
   */
  private orient(missile: Missile, model: THREE.Object3D): void {
    if (!missileOrientControl.enabled) {
      return;
    }
    // `-right` keeps the triple right-handed with +Z on `forward`; see the header.
    scratchAxisX.copy(missile.right).negate();
    scratchBasis.makeBasis(scratchAxisX, missile.up, missile.forward);
    model.quaternion.setFromRotationMatrix(scratchBasis);
  }

  /**
   * NOT IMPLEMENTED: THE PROJECTILE'S GROUND LIGHT DECAL -- named here with its real size, because
   * commit `2286a20` overstated it and a commit message is the permanent record.
   *
   * The owner: "Декаль света летящего снаряда фаербола должна быть на земле, а сейчас она над
   * снарядом." That commit reported the gap as "a decal/projector lane -- a new pass, not a fix".
   * **THAT IS WRONG, AND BY A LOT.** The projector already exists in this client:
   * `world/decal.ts` is a full port of the reference's ground-decal mechanism (`decal.rs:1-23`, the
   * `0x6d7330 -> 0x6d6fa0 -> 0x6d7480` emit chain) -- it gathers terrain and WMO faces, never
   * doodads, clips them Sutherland-Hodgman to a projection box and emits coplanar triangles with
   * planar top-down UVs, so a decal follows a slope by construction instead of floating over it.
   * `selection-ring.ts:384` already drives it, and `hover-highlight.ts` uses the same module.
   *
   * So the actual work is: one `DecalFrame` per live missile centred under the projectile, a
   * `decalMesh` sized like the ring's, and an ADDITIVE material instead of the ring's -- reusing a
   * lane that is already ported and already has its own test (`__tests__/ring-decal.test.ts`). That
   * is a small, well-scoped addition, not a new pass.
   *
   * It is still not taken in this round because the reference's own blob-shadow port
   * (`benilla-app/src/blob_shadow.rs:1-28`) records that the shared collector's receiver set here
   * does NOT yet include liquid -- "the shadow lands on terrain + WMO faces only" -- so a fireball
   * skimming water would drop its light decal. That is a receiver-set question in `decal.ts`, and
   * worth settling before adding a second consumer that inherits the same hole.
   */
  private remove(index: number): void {
    const missile = this.live[index];
    if (missile.model !== null) {
      missile.manager?.unregister(missile.model);
      missile.ribbons?.unregister(missile.model);
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
