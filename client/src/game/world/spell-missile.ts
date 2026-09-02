import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { spellData } from '../pipeline/dbc/spell-data';
import { warnOnce } from '../ui/framexml/lua/methods/region';
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
 * ## THE PARABOLA IS REAL, IS AUTHORED IN LUA, AND IS NOT IMPLEMENTED HERE
 *
 * The brief for this round asked to port the motion "from the reference rather than lerping". **The
 * reference has no motion to port**: `SpellMissile.dbc` and `SpellMissileMotion.dbc` appear NOWHERE in
 * it -- zero matches across every crate -- and its own header names the consequence, "a lobbed shot
 * reads as a straight glide here" (`missile.rs:59-61`). So the straight arrive-on-time line below IS
 * the reference's behaviour, faithfully ported, and not a shortcut taken instead of one.
 *
 * What the measurement found instead is better news than a port would have been.
 * `SpellMissileMotion.dbc` on this build is 204 rows x 5 fields with a **57,509-byte string block**,
 * and its column 2 is **Lua SOURCE** -- the flight law is authored as script, not as coefficients.
 * Row 13 `Parabola`, verbatim off the served file:
 *
 *     local angle = 0
 *     local maxMagnitude = startDistance * .15
 *     transAngle = angle
 *     transMag = (progress * 2) - 1
 *     transMag = (1 - (transMag * transMag)) * maxMagnitude
 *
 * So the contract is: inputs `progress`, `time`, `startDistance`, `missileIndex`, `missileCount`,
 * `rand1`, `rand2`; outputs `transAngle`, `transMag`, `transFront`, `transRight`, `transUp`,
 * `speedScalar`. Row 19 `Spiral Vortex` and row 20 `Drunken Missiles` use the full input set including
 * `sin`/`cos` and both random seeds, so the simple rows are not the whole shape.
 *
 * **This client already has the VM to run that** (fengari, executing FrameXML), so it is portable
 * rather than blocked -- but it is a per-missile per-frame Lua evaluation, and `CLAUDE.md` records a
 * 10.1 s interface freeze caused by fengari handle churn, so it needs its own round with its own
 * measurement. Named as the scoped next step, with the column measured and the script quoted, rather
 * than approximated with a hand-rolled arc here -- a hand-rolled arc would look plausible and would
 * agree with nothing in the data.
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
 * ## The floating-promise warning
 *
 * `particleManager?.register(model)` below is called from inside a `.then` handler and starts a
 * texture load it cannot return, which is what bluebird warns about. It is NOT an unhandled rejection
 * -- `ParticleMaterial` terminates its own chain with a logging `.catch`
 * (`particle/material.ts:119-133`) -- and no caller can await it because `register` is synchronous.
 * The full finding, and why it is reported rather than worked around, is in
 * `world/spell-kit-effects.ts`.
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
  };

  public lastError: string | null = null;

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
        return;
      }
      this.spawn(
        spellId, null, new THREE.Vector3(groundAt.x, groundAt.y, groundAt.z),
        false, speed, modelPath, particleManager, unitAt,
      );
      return;
    }

    for (const target of targets) {
      this.spawn(spellId, target.guid, null, target.missed, speed, modelPath, particleManager, unitAt);
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
  ): void {
    // THE DEADLINE, fixed here and never recomputed: distance / Speed (`missile.rs:17-19`). Measured
    // from the aim point at LAUNCH, so a target who then runs is chased inside the original window.
    const aim = targetGuid === null ? groundAt : unitAt(targetGuid);
    if (aim === null) {
      // The target is not in our object set -- nothing to fly at, and no invisible flight either.
      return;
    }
    toTarget.copy(aim);
    if (targetGuid !== null) {
      toTarget.z += BODY_HEIGHT;
    }
    const remaining = toTarget.distanceTo(launchPoint) / speed;

    this.stats.launched += 1;

    const missile: Missile = {
      model: null,
      manager: particleManager,
      spellId,
      targetGuid,
      groundAt: groundAt === null ? null : groundAt.clone(),
      at: launchPoint.clone(),
      remaining,
      missed,
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
        // `M2` constructs itself hidden and nothing registers this with the visibility manager.
        model.visible = true;
        // Without this a PARTICLE model draws nothing at all -- and a projectile is one.
        particleManager?.register(model);
        missile.model = model;
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

      const model = missile.model;
      if (model !== null) {
        model.position.copy(missile.at);
        if (typeof model.updateMatrix === 'function') {
          model.updateMatrix();
        }
        model.updateMatrixWorld(true);
      }
    }
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

  /** Drop everything, for a worldport or a teardown. */
  dispose(): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      this.remove(i);
    }
    this.live = [];
  }
}

export default SpellMissiles;
