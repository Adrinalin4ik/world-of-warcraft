import * as THREE from 'three';

import M2Blueprint from '../pipeline/m2/blueprint';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import { forgetBillboards, sampleBillboards } from './billboard-probe';
import { kitEmitters, WORLD_EFFECT_TAG, KitEmitter } from '../classes/spell-kit-fx';
import { warnOnce } from '../ui/framexml/lua/methods/region';
import { spellFxParticleSize } from './spell-fx-scale';
import {
  poseEffectModel, advanceEffectLifecycle, armEffectDecay, EffectLifecycle,
} from './effect-pose';
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
 *    load-failure discipline are copied. **Its unconditional `model.visible = true` is not**: whether an
 *    effect model's mesh should draw depends on whether it HAS particle emitters, and that distinction
 *    cost three rounds in both directions -- see the visibility rule at the spawn site. An ITEM on a
 *    bone is always un-hidden because its geometry is the thing being drawn; an effect model's mesh is
 *    the thing being drawn only when it has no emitters to draw instead.
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
 * ## THE FLOATING-PROMISE WARNING, NOW CLOSED AT ITS SOURCE
 *
 * The owner's console used to carry, from this spawn path:
 *
 *     Warning: a promise was created in a handler at bundle.js:100618:89 but was not returned from it
 *       at new ParticleMaterial -> ParticleManager.register -> SpellKitEffects.spawn
 *
 * It was never an unhandled rejection: `ParticleMaterial` terminates its own texture chain with a
 * logging `.catch` (`particle/material.ts`). It was Bluebird's other report -- a promise begun inside
 * a `.then` handler and never returned, because `register` is synchronous and answered a `number`, so
 * no caller had a handle to return.
 *
 * `ParticleManager` now exposes one (`particle/manager.ts#ready`) and the spawn handler below RETURNS
 * it, which joins the chain rather than silencing the report. Nothing is suppressed: no Bluebird
 * config was touched and no `.catch` was added to quiet it.
 *
 * The same fix landed in every lane that registers from a handler -- `world/level-up-effect.ts`,
 * `world/doodad-manager.js`, `pipeline/wmo/index.js` and `world/spell-missile.ts`.
 * `world/game-object-sparkle.ts` needed none: it already defers registration to the frame tick, which
 * is the other valid answer to the same warning and is documented there.
 *
 * **The first frames are unchanged, deliberately.** The handle does not gate emission, so an effect
 * still opens with `TextureLoader.PLACEHOLDER` until its texture lands, exactly as before. Gating was
 * the alternative and it is the wrong trade here: a kit effect is a transient burst, so a cast's flash
 * would arrive after the cast that caused it. `manager.ts#ready` carries the reasoning.
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
/**
 * THE KIT-MESH A/B: `window.kitMeshControl.enabled = false` restores the pre-fix rule, where a model
 * with any particle emitter kept its MESH hidden.
 *
 * A knob because this changes every kit effect model that carries both a mesh and emitters, and one
 * console word is a cheaper comparison than a rebuild. Read at spawn, not per frame.
 */
export const kitMeshControl = { enabled: true };

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).kitMeshControl = kitMeshControl;
}

const SPANLESS_MS = 1000;

/** What this module needs of `map.particleManager`. Same shape `level-up-effect.ts` declares. */
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
  /** The ribbon lane this model registered with, so removal releases it too. */
  ribbons: RibbonManagerLike | null;
  /**
   * Where this instance sits in the reference's `Stand` -> `Hold` -> `Decay` lifecycle.
   *
   * `birth` until its armed span elapses, then `settled` (on `Hold` if the model authors one, else
   * parked on the birth clip -- the reference's explicit do-nothing). `decaying` once reaped.
   * See `world/effect-pose.ts`.
   */
  lifecycle: EffectLifecycle;
  /**
   * `worldClock.ms` at the push. Purely instrumental, and it is what finds a STUCK instance: a
   * non-persistent instance whose age exceeds its own `remaining` deadline by any margin is by
   * definition one the removal path never reached, and no other field can say that.
   */
  bornAt: number;
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
    /**
     * IMPACT-STAGE plays, split by which route reached them -- the instrument for the one thing the
     * speedless-impact fix could not settle statically.
     *
     * `impactPlayed` counts every impact kit armed, by any route. `impactSelfFallback` counts the
     * times a projectile-less spell's GO carried an EMPTY hit list and the caster was used instead.
     * A self-buff's `SMSG_SPELL_GO` should name the caster as its own target, but that is a claim
     * about the wire this client cannot verify without a capture, so it is COUNTED rather than
     * assumed: after one Demon Skin cast, `impactSelfFallback` 0 means the hit list carried him and
     * the fallback is dead code; 1 means it did not and the fallback is what made the shield appear.
     * Either way the visual works and the wire shape stops being a guess.
     */
    impactPlayed: 0,
    impactSelfFallback: 0,
    /**
     * THE LEAK INSTRUMENT, and it did not exist until the owner reported one.
     *
     * `armed` counts instances PUSHED into `live`; `reaped` counts instances the spell-id-keyed reap
     * actually matched; `removed` counts instances that left `live` by any route. So:
     *
     *   `armed - removed` must equal `liveCount`, always. If it does not, `remove` is being skipped.
     *   `liveDetail()` names WHICH instance is stuck and by how long -- see its own doc.
     *   `armed` growing per cast while `reaped` stays flat means the reap KEY never matches --
     *   which is the neighbour-interaction hypothesis, and it is now falsifiable rather than argued.
     *
     * Worth stating because it was assumed to exist already: `stats` had no `armed` and no `reaped`.
     * The `reaped` counter that does exist is `aura-visuals.ts`'s `applied.reaped`, a DIFFERENT
     * object counting aura-diff decisions rather than kit instances -- so it can report a healthy
     * reap decision for a spell whose instance was never touched, which is precisely the failure
     * being hunted. Three integers, incremented on paths that already run; no per-frame cost.
     */
    armed: 0,
    reaped: 0,
    removed: 0,
  };

  /**
   * EVERY live instance, described -- persistent and self-terminating alike.
   *
   * ## The blind spot this replaces, because it was the exact shape this project keeps losing arms to
   *
   * The first version of this was `persistentLive()`, and it filtered `!instance.persistent` OUT. A
   * CAST kit is armed `persistent: false`. So if the leak were ever a cast-kit instance -- which was
   * the live suspect when this was written -- the instrument would have reported **an empty object
   * while the leak was plainly on screen**, and reported it confidently. An instrument with a blind
   * spot over the suspect is worse than no instrument: it produces a clean number that ends the
   * investigation. It is replaced rather than extended so the filtered version cannot be called.
   *
   * ## What each field is for
   *
   * `remaining` is the deadline in ms (`null` = persistent, owned by its spell's reap). `ageMs` is
   * how long it has actually been alive. **`stuck` is the diagnosis**: a non-persistent instance
   * whose age has passed its deadline should have been removed, so `stuck: true` on any row is proof
   * the removal path did not run for it, independently of what the deadline says. That is the one
   * question neither a count nor a key can answer.
   *
   * `key` is `(guid:spellId)`, and a duplicate key among PERSISTENT rows is itself proof of a
   * defect: `play` reaps this unit's live persistent instances of the same spell before beginning.
   */
  public liveDetail(): Array<{
    key: string; persistent: boolean; decaying: boolean; planted: boolean;
    remaining: number | null; ageMs: number; stuck: boolean; lifecycle: string;
  }> {
    const now = worldClock.ms;
    return this.live.map((instance) => {
      const ageMs = Math.round(now - instance.bornAt);
      return {
        key: `${instance.guid}:${instance.spellId}`,
        persistent: instance.persistent,
        decaying: instance.decaying,
        planted: instance.planted,
        remaining: instance.remaining === null ? null : Math.round(instance.remaining),
        ageMs,
        stuck: instance.remaining !== null && ageMs > instance.remaining + 1000,
        lifecycle: instance.lifecycle,
      };
    });
  }

  public lastError: string | null = null;

  /** How many instances are live. For the instrument; `live` is private. */
  public liveModels(): Array<{ particleSizeScale?: number }> {
    return this.live
      .map((entry) => entry.model as unknown as { particleSizeScale?: number })
      .filter((model) => model !== null && model !== undefined);
  }

  /**
   * WHERE EACH LIVE EFFECT ACTUALLY IS, in world space, for `window.worldSpellFx()`.
   *
   * This is the measurement that three separate symptoms turn on, and it is the one thing a headless
   * probe could never answer. A billboard quad has ONE depth -- its centre's, because
   * `particle/shader.vert` adds the corner offset in VIEW space and leaves z alone -- so for a rock
   * 40 units away to occlude a hand effect, the effect's particles have to be FARTHER than the rock.
   * Not depth-biased: farther. And a correctly-sized 0.6-unit sprite seen from far away is a few
   * pixels, which is "крошечные точки" exactly.
   *
   * So position is the common cause candidate for the tiny dots, the bad occlusion and possibly the
   * invisible projectile too (`ParticleManager.CULL_DISTANCE` is 120, and anything left near a map
   * origin is thousands of units out and silently culled). `matrixWorld` is what `ParticleManager`
   * packs every particle through, so this reports exactly the number that decides it.
   */
  public liveTransforms(): Array<{ slot: number; spellId: number; planted: boolean; at: number[] }> {
    return this.live.map((entry) => {
      const m = (entry.model as unknown as { matrixWorld?: THREE.Matrix4 }).matrixWorld;
      const at = new THREE.Vector3();
      if (m) {
        at.setFromMatrixPosition(m);
      }
      return {
        slot: entry.planted ? -1 : 0,
        spellId: entry.spellId,
        planted: entry.planted,
        at: [Math.round(at.x * 100) / 100, Math.round(at.y * 100) / 100, Math.round(at.z * 100) / 100],
      };
    });
  }

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
    ribbonManager: RibbonManagerLike | null = null,
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
      this.spawn(unit, spellId, persistent, emitter, particleManager, ribbonManager);
    }
  }

  private spawn(
    unit: Unit,
    spellId: number,
    persistent: boolean,
    emitter: KitEmitter,
    particleManager: ParticleManager | null,
    ribbonManager: RibbonManagerLike | null = null,
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

        // The birth clip, through the same resolver+arm pair `character/dress.ts#armStand` uses. It is
        // armed even though nothing advances it yet (see the header): the clock is then correct the
        // moment a poser exists, and an unarmed instance would have to be found again later.
        this.armBirth(model, emitter.modelPath);

        // THE PARTICLE SIZE MULTIPLIER, read by `ParticleBatch#pack` every frame. Defaults to 1,
        // i.e. the size the asset authors -- `world/spell-fx-scale.ts` carries the measurement that
        // says 1 is what the game's own data asks for, and why no other number is picked here.
        (model as unknown as { particleSizeScale?: number }).particleSizeScale = spellFxParticleSize();
        // Without this a PARTICLE model draws nothing at all -- `level-up-effect.ts`'s own note.
        const emitterCount = particleManager?.register(model) ?? 0;
        // RIBBON TRAILS. Additive to the particle registration, not an alternative: a lightning
        // bolt's model carries 3 ribbons AND 116 mesh vertices, and the real client draws both. So
        // this does NOT change the visibility rule above -- the rule keys on PARTICLE emitters
        // because that is what decides whether the mesh is the only thing the model can draw.
        ribbonManager?.register(model);
        // THE VISIBILITY RULE. Data-driven, and BOTH of its original justifications have since
        // expired -- which is why it now has a second arm.
        //
        // `register` returns how many particle emitters it took. The rule used to be "emitters > 0
        // -> stay hidden", on two grounds:
        //
        //  1. "Un-hiding would reveal a mesh NOTHING POSES" -- true when written, and **closed**:
        //     `0f06488` added `poseEffectModel` to this file's per-frame `update`, and `60bede3`
        //     fixed the bone path to honour `globalSequenceID`. A posable effect mesh is now posed.
        //  2. "This client renders no ribbon emitters at all -- nothing in `pipeline/m2` references
        //     them" -- **also closed**, by the ribbon port (`pipeline/m2/ribbon/`). That sentence is
        //     corrected here rather than left standing.
        //
        // WHAT THE OLD RULE COST, measured on the owner's report "Сумон визуализация слишком низко":
        // `Spells\SummonPet_Impact_Base.mdx` is **200 vertices spanning Z 0.063 to 3.650** with 18
        // bones (10 animated) AND 6 particle emitters; `SummonPet_Cast_Impact_Base` is 200 vertices,
        // 17 bones (13 animated) and 4 emitters. `emitterCount > 0` on both, so their mesh was never
        // shown -- **the entire 3.6-unit column of the summon effect was not being drawn**, leaving
        // only the particle cloud, whose authored volume reaches 1.358 units BELOW the origin. That
        // reads exactly as "too low": the high part was missing, not mis-placed.
        //
        // So the mesh is shown when it can be POSED, which is the precondition the old first ground
        // was really about. The predicate is `poseEffectModel`'s own gate (`world/effect-pose.ts`):
        // `useSkinning` plus an armable `instanceAnim`. Both summon models satisfy it (one inline
        // animation, animId 0, 1100 / 1667 ms), so showing them cannot produce a bind-pose sheet.
        //
        // AND THE OLD GUARD IS KEPT for exactly the case it was written for: a mesh with emitters
        // that CANNOT be posed stays hidden, because that is still an unposed pale sheet
        // (`ThunderClap_Cast_Base` 178 vertices in a 12.7 x 13.0 x 8.7 box, `Frost_Nova_state` 614 in
        // 9.7 x 9.7 x 2.7 -- neither is lifted by this change unless it poses).
        //
        // `emitters == 0` still MUST be visible: then the mesh is the only thing the model can draw,
        // and hiding it draws nothing at all -- the arm that cost the owner his projectile
        // (`LightningBolt_Missile` registers 0 emitters and carries 116 vertices and 3 ribbons).
        const posable = (model as unknown as {
          useSkinning?: boolean; instanceAnim?: { armable?: boolean } | null;
        });
        const canPose = posable.useSkinning === true && posable.instanceAnim?.armable === true;
        if (emitterCount === 0 || (kitMeshControl.enabled && canPose)) {
          model.visible = true;
        }

        this.stats.armed += 1;
        this.live.push({
          model,
          manager: particleManager,
          guid,
          spellId,
          persistent,
          remaining: persistent ? null : this.selfTerminateMs(model),
          planted,
          decaying: false,
          ribbons: ribbonManager,
          lifecycle: 'birth',
          bornAt: worldClock.ms,
        });

        // RETURNED, NOT ORPHANED, and this line is the whole point of the round. `register` above
        // starts a texture load per emitter and this runs inside a `.then` handler, so without
        // returning something Bluebird reports "a promise was created in a handler ... but was not
        // returned from it" -- the warning the owner has now pasted three times. Returning the
        // readiness handle JOINS the chain rather than silencing the report. It never rejects and it
        // does not gate emission; `ParticleManager#ready` carries both reasons.
        return particleManager?.ready(model);
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
      instance.lifecycle = 'decaying';
      this.stats.reaped += 1;
      // ARMS the clip as well as reading its span, which is the half that was missing: the reap knew
      // how long a decay lasts and never played it, so a reaped shield held its pose while it waited
      // out a fade it was not performing. `armEffectDecay` does both (`world/effect-pose.ts`), and
      // never repeats the clip whatever the sequence flags say -- the instance dies at its end.
      const decay = armEffectDecay(instance.model);
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
    // The gate phases on it, so it must be the world's own counter rather than a local tick count --
    // `shouldPose` staggers instances against this exact number for every other animated population.
    const frameIndex = worldClock.frameIndex;
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const instance = this.live[i];

      if (ownerGone(instance.guid)) {
        this.remove(i);
        continue;
      }

      // THE BILLBOARD PASS -- see the header. One existing call, gated on the model actually having
      // billboarded bones, so a pure particle model (no bones) costs one array-length read. `camera`
      // is optional only so the two unit tests need not build one; the world always passes it.
      // THE BILLBOARD CHAIN READS CORRECT END TO END, and five candidates for "billboarding is
      // simply absent" on `DemonArmor_Impact_Head` are refuted rather than untested. Recorded so the
      // next round does not re-walk them:
      //
      //  1. WRONG LIST / SPAWNED ELSEWHERE. No: `playImpactKit` -> `playSpellKit` -> `play` pushes
      //     into `this.live`, the single collection this loop iterates, and there is exactly one
      //     `live.push` in the file. `camera` IS passed (`world/index.ts`'s `spellKitEffects.update`
      //     call), so the pass below is not skipped.
      //  2. AN UNIMPLEMENTED BILLBOARD TYPE. No: the model's two billboarded bones are bone 0
      //     flags 0x0040 = cylindrical-Z and bone 2 flags 0x0008 = spherical. BOTH are implemented;
      //     the unimplemented one is type 2 cylindrical-Y and nothing here authors it.
      //  3. THE WRITER'S `bone.skin` GUARD. `applySphericalBillboard` returns early on `!bone.skin`,
      //     and `skin` is published only to ROOT bones (`m2/index.ts:613-615`). Both billboarded
      //     bones here have `parentID = -1`, so both are roots and both get it.
      //  4. THE POSE CLOBBERING IT. No: `anim/pose.ts:61` deliberately withholds rotation for a
      //     billboarded bone -- "rotation here would fight `applyBillboards` -- and win on every
      //     frame the camera did not move" -- and its own test pins that. Order is not the issue.
      //  5. `bone.rotation` BEING INERT under `matrixAutoUpdate = false`, this project's own recorded
      //     trap. No: that flag is set on the M2, its submeshes and the skeleton
      //     (`m2/index.ts:244/405/472/625`), and `m2/index.ts:835` passes it to the SUBMESH, not to
      //     bones. Bones keep three's default `true`, so the Euler reaches `bone.matrix` on the
      //     `updateMatrixWorld(true)` walk below.
      //
      // AND THE MESH IS ON THE PALETTE THAT CARRIES THE BILLBOARD: all 64 of its vertices weight to
      // bone 1 alone, whose parent bone 0 is billboarded, so `chainBillboarded` forces
      // `SCOPE_SKINNED` for that submesh (`anim/skinning-scope.ts:213-218`) precisely so it rides
      // three's palette -- built from `bone.matrixWorld`, which has the facing -- instead of
      // `InstanceAnim.palette`, which does not.
      //
      // SO THE OBSERVATION NEEDS RE-TAKING BEFORE ANYTHING ELSE IS HUNTED. It was made on a build
      // where this same model's EMITTERS were swinging by up to a full unit as the camera moved
      // (`87f9180`: a model-space offset was being rotated by a spherical billboard). A corona
      // sliding relative to a static shield reads as "the shield does not billboard" just as
      // readily as the reverse, and that motion is now gone.
      let billboardsMoved = false;
      if (camera !== undefined) {
        const billboarded = instance.model as unknown as {
          billboards?: unknown[]; applyBillboards?: (c: THREE.Camera) => void;
        };
        if (billboarded.billboards !== undefined
          && billboarded.billboards.length > 0
          && typeof billboarded.applyBillboards === 'function') {
          billboarded.applyBillboards(camera);
          billboardsMoved = true;
          // STAGE 1 of the last-hop probe: the bone's own quaternion, immediately after the writer
          // wrote it and BEFORE any world walk. See `billboard-probe.ts`.
          sampleBillboards(instance.model, instance.guid + ':' + String(instance.spellId), 'writer');
        }
      }

      // THE POSE PASS. `world/effect-pose.ts` carries the whole reasoning; the two things that matter
      // at this call site are that it samples the MATERIAL CHANNELS unconditionally -- which is what
      // stops a transparency-only shield drawing at full additive alpha -- and that a true return
      // means the bones moved, so the subtree needs re-accumulating.
      // `|| billboardsMoved` IS THE LAST HOP, and without it the billboard pass above was computed
      // and thrown away for a whole class of model. `applyBillboards` writes bone ROTATIONS and
      // nothing else (`pipeline/m2/index.ts:1011-1026` -- no `updateMatrix`, no `updateMatrixWorld`);
      // this `updateMatrixWorld(true)` is the only thing that accumulates them. But it used to be
      // reached only when `poseEffectModel` returned TRUE, and that returns false for any model
      // without `useSkinning`, without an `instanceAnim`, or not `armable` -- so exactly the models
      // whose billboards are their only animation got every billboard discarded, and read as flat
      // sheets held in bind orientation. The owner's "возможно билбординга не хватает" on the warlock
      // summon is that symptom.
      //
      // TWO ROTATIONS AT TWO LEVELS, and they are not in conflict -- the distinction matters because
      // conflating them is how this project's orientation defects happen. A PLANT's own transform
      // (translate + yaw + scale) is baked once at spawn and deliberately never re-applied, so a
      // plant does not turn with its owner; that is `plantTransform` and it is untouched here. Its
      // BILLBOARDED BONES are a level below that, inside the model, and must face the camera every
      // frame like any other model's. This line only re-accumulates the subtree; it never rewrites
      // the plant's own baked matrix.
      if (poseEffectModel(instance.model, camera, frameIndex) || billboardsMoved) {
        instance.model.updateMatrixWorld(true);
      }
      if (billboardsMoved) {
        // STAGE 2: what the SKINNING PALETTE sees, after the world walk. The pair is the whole
        // measurement -- `paletteRotChangeDeg` staying ~0 while `writerRotChangeDeg` moves is proof
        // the billboard never reached the vertex, whatever the bone's own fields say.
        sampleBillboards(instance.model, instance.guid + ':' + String(instance.spellId), 'palette');
      }
      // AND THE HANDOVER: `Stand` -> `Hold` once the birth span elapses. Without it a state kit holds
      // its birth pose for the whole life of the buff, which for a shield is minutes.
      instance.lifecycle = advanceEffectLifecycle(instance.model, instance.lifecycle);
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
    this.stats.removed += 1;
    forgetBillboards(instance.guid + ':' + String(instance.spellId));
    instance.manager?.unregister(instance.model);
    instance.ribbons?.unregister(instance.model);
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
