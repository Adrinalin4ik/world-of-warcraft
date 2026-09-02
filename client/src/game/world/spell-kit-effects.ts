import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import { kitEmitters, WORLD_EFFECT_TAG, KitEmitter } from '../classes/spell-kit-fx';
import { warnOnce } from '../ui/framexml/lua/methods/region';
import type Unit from '../classes/unit';

/**
 * SPELL VISUAL KIT EFFECTS -- the attach-point models a kit hangs on a casting unit, and the ground
 * plant it puts at his feet. **The first thing in this subsystem that draws.**
 *
 * Everything upstream is already measured and committed: `pipeline/dbc/spell-data.ts` reads the kit
 * slots, `classes/spell-kit-fx.ts` maps a slot to an M2 attachment tag (measured against 23 real rigs
 * in `harness/attach-probe.test.js`), and `classes/spell-anim.ts` owns which kit belongs to which cast
 * edge. This module only spawns, places and reaps.
 *
 * ## Shape copied, not invented
 *
 * Two existing files already do most of this and both are followed rather than paraphrased:
 *
 *  - `world/level-up-effect.ts` -- a free-standing effect model in the world scene. Its three
 *    load-bearing lines are copied verbatim in spirit: `updateMatrix()` before `scene.add` (the scene
 *    has `matrixWorldAutoUpdate = false`, so a model added without it draws at the world ORIGIN),
 *    `updateMatrixWorld(true)` after, and `particleManager.register(model)` -- **without which a
 *    particle model draws nothing at all.** Effect models are overwhelmingly particle models, so that
 *    registration is what makes this visible rather than a no-op.
 *  - `character/dress.ts#attachCharacterItems` -- a model on a bone. Its `stillWanted` re-check and its
 *    load-failure discipline are copied. **Its `model.visible = true` is NOT**, and that distinction
 *    cost two rounds: see the note at the spawn site. An ITEM on a bone must be un-hidden because its
 *    geometry is the thing being drawn; a particle EFFECT must stay hidden, because its particles draw
 *    from `ParticleManager`'s own group and un-hiding it only reveals a mesh nothing poses.
 *
 * ## The attach cascade is the reference's, not a fallback of ours
 *
 * A model asked for a point its rig does not carry does NOT simply fail: the client walks
 * `tag -> 0xf -> 0x13 -> the unit's base` (`benilla-app/src/entities/spell_fx/mod.rs:21-22`, wow-re
 * `spell-visual-apply.md` §5, the client's `0x61ceb0`). That matters here because it is measured that
 * three of the nine tags are rig-specific: `harness/attach-probe.test.js` found Special1 on 2 of 23
 * models and Special2/Special3 on none, so the cascade is the common path for a special slot and not
 * an edge case. Both cascade targets are MEASURED to exist everywhere probed: 0xf (15) and 0x13 (19)
 * are in the attachment table of **23 of 23** rigs, checked the same way the tags were, so the walk
 * terminates on a real point rather than falling off the end.
 *
 * ## Lifetime is the stage's, and the two stages differ
 *
 * `spell_fx/mod.rs:15-19`: a **persistent** instance (precast, channel) lives until its spell-id-keyed
 * reap; a **self-terminating** one (the cast release) despawns after one pass of its model's sequence
 * 0. A persistent Begin REPLACES the unit's live persistent instances of the same spell
 * (`resolve_spell_fx`, `mod.rs:698-705`) -- so a re-cast does not stack two precast glows.
 *
 * The reap is not immediate: if the model authors `Decay` (`AnimationData` 159) the instance keeps
 * rendering for that sequence's authored span before it goes, and only despawns at once when it does
 * not (`lifecycle.rs:200-215`, the client's `0x614150` -> `0x6141c0`).
 *
 * **This closes a residual `level-up-effect.ts` left open.** Its `DURATION_MS` is a hardcoded 2.5 s
 * whose own docstring says "UNEXPLAINED, and said so rather than sourced ... Replace it with the
 * model's real sequence length the day a duration is readable here." It is readable:
 * `M2#modelAnim.resolve(0, false).lengthMs` is exactly the sequence-0 span the reference's
 * self-termination uses, through the same `resolve` that `character/dress.ts#armStand` already calls.
 * That file is deliberately NOT edited here -- it is a working, owner-validated visual and changing
 * its duration in a commit about kit spawning is how two correct changes cancel. Named for a scoped
 * round instead.
 *
 * ## What is NOT implemented, named rather than silently skipped
 *
 *  - **The `Stand` -> `Hold` -> `Decay` animation handover** (`lifecycle.rs`). The birth sequence is
 *    armed here through the `armStand` convention, and the `Decay` SPAN is honoured by the reap, but
 *    nothing hands a state kit over to `Hold` (158) mid-life. That needs a per-instance completion
 *    callback, and more basically it needs someone to ADVANCE the instance every frame -- see the next
 *    item.
 * ## BILLBOARDING: found, diagnosed, and it was NOT the particle system
 *
 * The owner's first screenshot showed the hand glow as flat sheets EDGE-ON rather than facing him.
 * `CLAUDE.md` records that every orientation defect on this project has been two conventions meeting,
 * three for three, and none was fixed by negating a coordinate -- so the first job was to find which
 * two, and no sign was touched.
 *
 * It is not the particle shader. `particle/shader.vert` builds every quad in VIEW space
 * (`viewCenter.xy += spun`), so a particle physically cannot be edge-on -- and `particle/material.ts`
 * sets `DoubleSide` for the same reason. Particles were never the suspect once read.
 *
 * The two conventions are the MODEL's billboarded BONES and the host lane that is supposed to orient
 * them. An M2 carries a `billboards` list -- bones whose `userData.billboardType` is spherical (0) or
 * cylindrical-Z (3) -- and `M2#applyBillboards(camera)` is what turns them to face the viewer
 * (`pipeline/m2/index.ts:1011-1024`). Nothing calls it for a model unless its lane does: the doodad
 * lane does, per frame, at `doodad-manager.js:401-404`. **This lane did not**, so an effect model with
 * billboarded bones drew its quads in whatever direction the bind pose left them -- exactly flat
 * sheets at a fixed angle. The fix is one existing call, added to `update` below.
 *
 * NOT gated on `cameraMoved`, unlike the doodad lane, and that difference is deliberate: a doodad is
 * static so only camera motion changes its billboard, while these ride units that move. Gating on the
 * camera would freeze the billboard of an effect on a walking mob.
 *
 *  - **Nothing poses a free-standing effect model per frame.** A unit's body is advanced by
 *    `unit.update`, a doodad by `DoodadManager#poseDoodad` (bone budget, distance decimation, material
 *    channels -- a subsystem, not a line). A model this module spawns is in neither lane, so its
 *    PARTICLE emitters run (they are driven by `ParticleManager#animate` off the registration above)
 *    while its bone-animated MESH sits in bind pose. For the particle-and-ribbon effects that make up
 *    nearly all of this table that is the whole effect; for a bone-animated one it is a static shape.
 *    Reported, not hidden: `poseDoodad` is the pattern that would close it.
 *  - **The impact kit.** `SMSG_SPELL_GO`'s hit list is deliberately not decoded
 *    (`network/game/object/spells.ts` says so of its tail), and an impact kit plays on the TARGETS.
 *    So this module is armed at START and GO on the CASTER only, and the impact stage is unreachable
 *    until that tail is read.
 *  - **The kit sound** (`SpellVisualKit` column 15). This client has no audio engine at all.
 *
 * ## Frame cost
 *
 * **The UI draw-list fingerprint cost is ZERO, by construction.** These are world models in the world
 * scene; `drawListSignature` mixes UI draw items and cannot see them -- the same argument
 * `selection-ring.ts`, `nameplates.ts` and `level-up-effect.ts` each make about themselves. So the
 * offscreen-target saving (4-7.5 ms on ~92% of frames) is untouched.
 *
 * **Idle cost is one array-length compare**: `update` returns immediately on an empty list, which is
 * why this is a module with its own tick rather than a branch inside the unit loop.
 *
 * **Per live instance per frame** the tick does one subtraction and one compare. It does NOT call
 * `updateMatrixWorld` per frame on anything: a bone child is moved by the skeleton it hangs on, and a
 * world plant is BAKED at spawn and deliberately never re-transformed (see `plantTransform`). The
 * remaining cost is the model's own emitters inside `ParticleManager#animate`, which is that manager's
 * existing per-emitter cost rather than new work.
 *
 * **What is NOT measured**: the emitter and particle counts of these models, and therefore the real
 * per-instance millisecond cost. That needs the models parsed in a browser. The number is owed and is
 * named as owed rather than estimated -- the same standing `level-up-effect.ts` takes for its own.
 *
 * ## THE FLOATING-PROMISE WARNING IS REAL, AND IT IS NOT AN UNHANDLED REJECTION
 *
 * The owner's console carries, from this spawn path:
 *
 *     Warning: a promise was created in a handler at bundle.js:100618:89 but was not returned from it
 *       at new ParticleMaterial -> ParticleManager.register -> SpellKitEffects.spawn
 *
 * Read rather than assumed, and the brief's framing of it ("a failure there is unhandled") does not
 * survive the read. `ParticleMaterial`'s constructor starts `TextureLoader.load(...)` and **already
 * terminates that chain with a `.catch` that logs** (`particle/material.ts:119-133`), so a texture
 * 404 is handled, not swallowed. What the warning reports is the other thing bluebird warns about: a
 * new promise chain was begun inside a `.then` handler and not returned, so nothing can await it.
 *
 * **And nothing CAN, from any caller.** `ParticleManager.register` is synchronous and returns a
 * `number` (`particle/manager.ts:85`), so it exposes no handle on the texture load at all. That is a
 * shape shared by every caller -- `level-up-effect.ts`, `game-object-sparkle.ts`, the doodad lane and
 * both of this round's modules -- and it is reported here rather than worked around, because a local
 * wrapper would hide a manager-level property from the next caller. Its one visible consequence is
 * that an effect's first frames draw with `TextureLoader.PLACEHOLDER` until the texture lands.
 *
 * Fixing it properly means giving `register` a way to report texture readiness, which changes a
 * signature four lanes depend on -- a scoped round, not a line in this one.
 *
 * ## Materials are not written here, at all
 *
 * An effect model is often static, so it instances, and a clone then shares the SOURCE's batches --
 * writing one from an effect pass is a write into every other copy in the zone. `ownsBatches` is the
 * test and this module never needs it, because it sets no colour, no alpha and no tint: it positions,
 * parents, registers and removes. The reference's per-instance tint and material-animation lane
 * (`spell_fx/mod.rs`'s `FxTintAnims`, the white-hot flash cooling to red) is exactly the part that
 * WOULD need a per-instance material clone, and it is not attempted here.
 */

/** `AnimationData.dbc` 0 `Stand` -- the birth clip the client arms on a fresh effect model. */
const ANIM_STAND = 0;

/**
 * `AnimationData.dbc` 159 `Decay` -- the fade-out leg. A reaped instance keeps rendering for this
 * sequence's authored span (`lifecycle.rs:67`, the client's `0x5ff233` / `0x6141c0`).
 */
const ANIM_DECAY = 159;

/**
 * The attach cascade's two fallback tags, in order, after the requested one fails
 * (`spell_fx/mod.rs:21-22`). `0xf` then `0x13`; a miss on both leaves the unit's base, which for this
 * client means the model is parented to nothing and dropped.
 */
const ATTACH_CASCADE = [0xf, 0x13];

/**
 * How long a self-terminating instance lives when its model authors no sequence 0 at all.
 *
 * **Unexplained, and said so.** The reference's rule is "one pass of its model's sequence 0", which
 * presupposes one exists; a model with an empty or fully-quarantined sequence table gives no span. One
 * second is long enough for a particle burst to emit and short enough that a mashed cast cannot stack
 * many. It is used only for that residual case and the count of instances that take it is reported by
 * `stats.spanless`, so how often it matters is a number rather than a guess.
 */
const SPANLESS_MS = 1000;

/** What this module needs of `map.particleManager`. Same shape `level-up-effect.ts` declares. */
interface ParticleManager {
  register: (instance: unknown) => number;
  unregister: (instance: unknown) => void;
}

/** One live effect model. */
interface Instance {
  model: THREE.Object3D & { updateMatrix?: () => void };
  manager: ParticleManager | null;
  /** The owning unit's guid -- the reap key's other half, and what an owner-gone sweep matches. */
  guid: string;
  /** The spell that armed it: the reap is spell-id keyed (`mod.rs:742-748`). */
  spellId: number;
  /** Precast/channel (reaped by spell id) vs cast release (self-terminates). */
  persistent: boolean;
  /** Milliseconds until despawn, or null for a persistent instance that has not been reaped. */
  remaining: number | null;
  /** In the world scene (a plant) rather than on a bone -- decides how it is removed. */
  planted: boolean;
  /** Already reaped and playing its decay out: a second reap must not re-arm or double-remove. */
  decaying: boolean;
}

/**
 * The world plant's transform: **baked once at spawn and never updated.**
 *
 * The reference byte-pins all four halves (`spell_visual/mod.rs:110-120`, wow-re `kit30-effect-slot.md`
 * §5): `translate(owner position) * yaw(owner facing) * scale(owner scale)`, computed at spawn, and the
 * model does **not** ride a bone and does **not** turn with the unit afterwards. So a unit who walks
 * away leaves the ring where he cast it, which is the behaviour, not a bug to fix later.
 *
 * THE 180-DEGREE TERM IS INHERITED AND ITS OWN SOURCE IS UNSURE. A unit's body model is given
 * `rotation.z = Math.PI` inside `unit.view` by `Unit`'s model setter, above a comment that reads
 * "TODO: Figure out whether this 180 degree rotation is correct" (`classes/unit.ts:1410-1411`). Adding
 * it here makes a plant face the same way the body does, which is the only self-consistent choice
 * available; NOT adding it would make a directional ground effect point opposite the caster. Since the
 * convention it matches is itself unverified, this is recorded as consistent-with-the-body rather than
 * as correct, and the case that would expose it is a rotationally ASYMMETRIC ground effect -- most are
 * rings and cannot show the difference.
 *
 * Scale is read off the body model rather than recomputed: `Unit#renderScale` is private and
 * `applyRenderScale` has already resolved `objectScale ?? displayInfo.scale ?? 1` into
 * `model.scale`, so reading it is one number instead of a second copy of that rule.
 */
function plantTransform(unit: Unit, model: THREE.Object3D & { updateMatrix?: () => void }): void {
  model.position.copy(unit.position);
  model.rotation.z = unit.facing + Math.PI;
  const bodyScale = (unit.model as unknown as { scale?: THREE.Vector3 } | null)?.scale?.x;
  model.scale.setScalar(typeof bodyScale === 'number' && bodyScale > 0 ? bodyScale : 1);
  if (typeof model.updateMatrix === 'function') {
    model.updateMatrix();
  }
}

/**
 * The model's sequence-0 span in milliseconds, or null when it authors none.
 *
 * `resolve(id, false)` and not `resolve(id)`: the fallback arm would hand back the first playable
 * sequence for a model that has no `Stand` at all, and then a self-terminating instance would live for
 * the length of some unrelated clip. `character/dress.ts#armStand` uses the same resolver.
 */
function spanOf(model: unknown, animId: number): number | null {
  const seq = (model as { modelAnim?: { resolve?: (id: number, fallback: boolean) => { lengthMs?: number } | null } })
    ?.modelAnim?.resolve?.(animId, false);
  const ms = seq?.lengthMs;
  return typeof ms === 'number' && ms > 0 ? ms : null;
}

export class SpellKitEffects {
  private scene: THREE.Scene;

  private live: Instance[] = [];

  /**
   * THE INSTRUMENT. A spawn fails asynchronously and off the render path, so an absence is otherwise
   * the only symptom -- the reason `level-up-effect.ts` keeps its own `lastError`, and the reason a
   * silent catch there once cost a probe run.
   */
  public stats = {
    /** Emitters the kit asked for. */
    requested: 0,
    /** Models that reached a bone. */
    attached: 0,
    /** Models planted in the world. */
    planted: 0,
    /** Models the rig had no point for, even after the cascade. */
    unattachable: 0,
    /** Loads that threw. */
    failed: 0,
    /** Self-terminating instances whose model authored no sequence 0 (see `SPANLESS_MS`). */
    spanless: 0,
    /** Instances reaped that played a `Decay` out rather than going at once. */
    decayed: 0,
  };

  public lastError: string | null = null;

  /** How many instances are live. For the instrument; `live` is private. */
  public get liveCount(): number {
    return this.live.length;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Arm a kit on a unit.
   *
   * `persistent` is the stage: true for the precast/channel kit armed at `SMSG_SPELL_START`, false for
   * the cast release armed at `SMSG_SPELL_GO`. A persistent arm reaps this unit's live persistent
   * instances of the SAME spell first, which is the reference's replace-not-stack rule.
   */
  play(
    unit: Unit,
    spellId: number,
    kitId: number,
    persistent: boolean,
    particleManager: ParticleManager | null,
  ): void {
    // REAP FIRST, and before the empty check rather than after it. The reference's order is
    // reap-then-begin unconditionally (`mod.rs:698-705`), so a re-cast whose kit happens to resolve to
    // no emitters must still drop the previous arm's instances -- behind the early return they would
    // have survived a replacement that legitimately draws nothing.
    if (persistent) {
      this.reap(unit.guid, spellId);
    }
    const emitters = kitEmitters(kitId);
    if (emitters.length === 0) {
      return;
    }
    for (const emitter of emitters) {
      this.stats.requested += 1;
      this.spawn(unit, spellId, persistent, emitter, particleManager);
    }
  }

  private spawn(
    unit: Unit,
    spellId: number,
    persistent: boolean,
    emitter: KitEmitter,
    particleManager: ParticleManager | null,
  ): void {
    const guid = unit.guid;
    void M2Blueprint.load(emitter.modelPath)
      .then((model: THREE.Object3D & { updateMatrix?: () => void }) => {
        // The unit may have died, despawned or been replaced during the fetch -- the same
        // `stillWanted` re-check `attachCharacterItems` states, and for the same reason: without it
        // the previous unit's glow lands on whatever is there now, or on nothing.
        if (unit.model === null || unit.model === undefined || unit.guid !== guid) {
          M2Blueprint.unload(model as never);
          return;
        }

        const planted = emitter.tag === WORLD_EFFECT_TAG;
        if (planted) {
          plantTransform(unit, model);
          this.scene.add(model);
          model.updateMatrixWorld(true);
          this.stats.planted += 1;
        } else if (!this.attachWithCascade(unit, emitter, model)) {
          this.stats.unattachable += 1;
          M2Blueprint.unload(model as never);
          return;
        } else {
          this.stats.attached += 1;
        }

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

        // The birth clip, through the same resolver+arm pair `character/dress.ts#armStand` uses. It is
        // armed even though nothing advances it yet (see the header): the clock is then correct the
        // moment a poser exists, and an unarmed instance would have to be found again later.
        this.armBirth(model, emitter.modelPath);

        // Without this a PARTICLE model draws nothing at all -- `level-up-effect.ts`'s own note.
        particleManager?.register(model);

        this.live.push({
          model,
          manager: particleManager,
          guid,
          spellId,
          persistent,
          remaining: persistent ? null : this.selfTerminateMs(model),
          planted,
          decaying: false,
        });
      })
      .catch((e) => {
        // `M2Blueprint.load` logs its own failure; the reason is kept rather than swallowed.
        this.stats.failed += 1;
        this.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      });
  }

  /**
   * The requested tag, then `0xf`, then `0x13` -- the client's own walk (`spell_fx/mod.rs:21-22`).
   *
   * `M2#attachTo` is the one attachment resolver in this client and it already answers `false` for a
   * point the rig does not carry (`pipeline/m2/index.ts:1220-1238`), so each rung is one call. The
   * reference's last rung is "the unit's base", which would mean parenting to the unit's view rather
   * than to a bone; that is deliberately NOT done here -- a base-parented effect needs the plant path's
   * transform discipline and would silently ride the body's 180-degree flip, so the miss is reported
   * instead and the caller drops the model.
   */
  private attachWithCascade(
    unit: Unit,
    emitter: KitEmitter,
    model: THREE.Object3D,
  ): boolean {
    const body = unit.model as unknown as { attachTo?: (id: number, child: THREE.Object3D) => boolean };
    if (typeof body?.attachTo !== 'function') {
      return false;
    }
    if (body.attachTo(emitter.tag, model)) {
      return true;
    }
    for (const fallback of ATTACH_CASCADE) {
      if (fallback !== emitter.tag && body.attachTo(fallback, model)) {
        return true;
      }
    }
    // NAMED, not silent. Measured to be a real and expected outcome for a special slot -- Special2 and
    // Special3 are absent from all 23 rigs probed -- so this is the data being rig-specific rather
    // than anything broken, and the cascade above is what usually rescues it.
    warnOnce(
      `spell fx: no attachment ${emitter.tag} (nor 0xf, nor 0x13) on ${unit.guid}'s model for `
      + `effect ${emitter.effectId} (${emitter.modelPath}) -- slot ${emitter.slot} draws nothing`,
    );
    return false;
  }

  /** Arm sequence 0, or report that the model has none to arm. */
  private armBirth(model: unknown, modelPath: string): void {
    const holder = model as {
      modelAnim?: { resolve?: (id: number, fallback: boolean) => unknown };
      instanceAnim?: { arm?: (seq: unknown, ms: number) => void } | null;
    };
    const seq = holder.modelAnim?.resolve?.(ANIM_STAND, false) ?? null;
    if (seq !== null && holder.instanceAnim?.arm) {
      holder.instanceAnim.arm(seq, worldClock.ms);
      return;
    }
    // Not a defect: `instanceAnim` is null for exactly a non-animated model, and a pure particle
    // emitter often authors no sequence at all. Reported once per path so a MISSING animation is
    // distinguishable from a missing model.
    warnOnce(`spell fx: ${modelPath} has no armable sequence 0 -- it renders unposed`);
  }

  /** One pass of the model's sequence 0 (`mod.rs:15-19`), or the named residual span. */
  private selfTerminateMs(model: unknown): number {
    const span = spanOf(model, ANIM_STAND);
    if (span === null) {
      this.stats.spanless += 1;
      return SPANLESS_MS;
    }
    return span;
  }

  /**
   * The spell-id-keyed reap (`mod.rs:742-748`): every live PERSISTENT instance of this unit and spell.
   *
   * Non-persistent instances are untouched -- they own their own clock -- and an already-decaying one
   * is skipped, which is the reference's own guard against a second reap reaching it.
   */
  reap(guid: string, spellId: number): void {
    for (const instance of this.live) {
      if (instance.decaying || !instance.persistent) {
        continue;
      }
      if (instance.guid !== guid || instance.spellId !== spellId) {
        continue;
      }
      instance.decaying = true;
      const decay = spanOf(instance.model, ANIM_DECAY);
      if (decay === null) {
        // The reference's immediate-destroy gate: no `Decay` authored, so it goes now.
        instance.remaining = 0;
        continue;
      }
      this.stats.decayed += 1;
      instance.remaining = decay;
    }
  }

  /** Everything this unit owns, whatever spell armed it -- death, despawn, worldport. */
  dropUnit(guid: string): void {
    for (const instance of this.live) {
      if (instance.guid === guid) {
        instance.decaying = true;
        instance.remaining = 0;
      }
    }
  }

  /**
   * One frame. Returns immediately with nothing live -- see the header on the idle cost.
   *
   * `ownerGone` is asked per instance rather than kept as a subscription: a bone child dies with the
   * body that owns it, but `M2Blueprint.unload` is a REFERENCE COUNT and would never be called, so a
   * unit leaving the world without this leaks a model handle per effect. The world plant is the case
   * the reference tends explicitly (`tend_world_plants`, `mod.rs:636-647`) because a plant is a scene
   * child and would otherwise outlive its owner visibly.
   */
  update(
    deltaMs: number,
    ownerGone: (guid: string) => boolean,
    camera?: THREE.Camera,
  ): void {
    if (this.live.length === 0) {
      return;
    }
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const instance = this.live[i];

      if (ownerGone(instance.guid)) {
        this.remove(i);
        continue;
      }

      // THE BILLBOARD PASS -- see the header. One existing call, gated on the model actually having
      // billboarded bones, so a pure particle model (no bones) costs one array-length read. `camera`
      // is optional only so the two unit tests need not build one; the world always passes it.
      if (camera !== undefined) {
        const billboarded = instance.model as unknown as {
          billboards?: unknown[]; applyBillboards?: (c: THREE.Camera) => void;
        };
        if (billboarded.billboards !== undefined
          && billboarded.billboards.length > 0
          && typeof billboarded.applyBillboards === 'function') {
          billboarded.applyBillboards(camera);
        }
      }
      if (instance.remaining === null) {
        continue; // persistent and unreaped: its spell owns it
      }
      instance.remaining -= deltaMs;
      if (instance.remaining > 0) {
        continue;
      }
      this.remove(i);
    }
  }

  private remove(index: number): void {
    const instance = this.live[index];
    instance.manager?.unregister(instance.model);
    if (instance.planted) {
      this.scene.remove(instance.model);
    } else {
      // A bone child: its parent is a bone of the owner's skeleton, not the scene.
      instance.model.parent?.remove(instance.model);
    }
    // A refcount decrement, not a free -- another instance of the same path may still be live. Same
    // discipline `level-up-effect.ts` and `unit.ts#release` state.
    M2Blueprint.unload(instance.model as never);
    this.live.splice(index, 1);
  }

  /** Drop everything, for a worldport or a teardown. */
  dispose(): void {
    for (const instance of this.live) {
      instance.manager?.unregister(instance.model);
      if (instance.planted) {
        this.scene.remove(instance.model);
      } else {
        instance.model.parent?.remove(instance.model);
      }
      M2Blueprint.unload(instance.model as never);
    }
    this.live = [];
  }
}

export default SpellKitEffects;
