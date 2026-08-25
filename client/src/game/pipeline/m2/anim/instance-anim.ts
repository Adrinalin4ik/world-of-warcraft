import * as THREE from 'three';
import { animCounters } from './counters';
import { ModelAnim, Sequence } from './model-anim';
import { ClockLaw, clockLaw, cursorMs, isStep, sampleQuat, sampleVec3, trackFor } from './tracks';

// Module-level scratch objects -- the solver runs per bone per instance per frame and must not
// allocate.
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchPivot = new THREE.Vector3();
// The OUTGOING sequence's sample, for the cross-fade. Module-level for the same reason the three
// above are: this runs per bone per instance per frame.
const blendPos = new THREE.Vector3();
const blendQuat = new THREE.Quaternion();
const blendScale = new THREE.Vector3();
const scratchLocal = new THREE.Matrix4();
const scratchPivotTo = new THREE.Matrix4();
const scratchPivotBack = new THREE.Matrix4();

/** Shared empty buffers, so an unarmed instance holds no per-bone storage at all. */
const EMPTY_F32 = new Float32Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** Floats per bone in `localTRS`: 3 position, 4 quaternion, 3 scale. */
export const LOCAL_TRS_STRIDE = 10;

/**
 * The sequence slot an UNARMED instance samples: a non-slot.
 *
 * Deliberately not 0. Slot 0 is a real sequence whose keys may be quarantined noise
 * (`model-anim.ts#hasInlineData`), and the pose paths solve an instance whether or not it ever
 * armed. `-1` indexes past the start of every `tracks` array, so `trackFor` returns null and every
 * channel holds its identity -- bind pose for bones, and for material channels their default value.
 * It is the one index that cannot itself be quarantined, now or after Task 20.
 */
export const UNARMED_SLOT = -1;

/**
 * The ceiling on a cross-fade, in ms.
 *
 * `AnimationData`'s own `blendTime` is the source and it is what is used -- 0, 150 and 250 are the
 * values that actually appear on the gaits this matters for. The cap only rejects a garbage value: a
 * blend longer than half a second is a smear rather than a transition, and a sequence whose
 * `blendTime` decoded wrongly would otherwise hold two poses mixed on screen indefinitely. A
 * judgement, not a measurement, and stated as one.
 */
const BLEND_MAX_MS = 500;

/**
 * The cross-fade's A/B switch: `window.blendControl.enabled = false` restores the hard cuts.
 *
 * Here for the same reason the reference keeps `WOW_REMOTE_SNAP=1` and `WOW_REMOTE_FLAT=1`, and the
 * same reason `frameTrace` is on `window`: a second weighted track is exactly the change that can
 * double per-bone work, and the only honest way to price it is A/B *within one session* on one
 * machine, interleaved -- this project has had a whole performance comparison voided by comparing two
 * runs. Read ONCE per solve (in `solveBones`), never per bone.
 */
export const blendControl = { enabled: true };

/**
 * THE MASKED UPPER-BODY OVERLAY'S A/B SWITCH: `window.overlayControl.enabled = false` makes the
 * overlay contribute NOTHING to the pose.
 *
 * PRECISELY what it does, because a first draft of this comment claimed it "sends every one-shot back
 * down the full-body route" and it does not -- SELF-REVIEW: the routing on `Unit` never reads this
 * flag, so with it off a masked swing is armed into a slot that is not sampled and the torso keeps the
 * gait. That is exactly the arm a cost A/B wants (the same frame's work minus the overlay's share) and
 * exactly NOT a "what would it look like without the feature" switch. It is a measurement control.
 *
 * A switch of its own rather than sharing `blendControl`, for the reason `blendControl` exists: the
 * overlay is a THIRD sampled track on the bones it covers and the only honest way to price it is A/B
 * within one session, interleaved. Sharing the flag would have made "the overlay costs X" and "the
 * cross-fade costs Y" the same measurement, which is exactly the kind of instrument this project has
 * been burned by. Read ONCE per solve, never per bone.
 */
export const overlayControl = { enabled: true };

/**
 * THE MASKED OVERLAY'S RELEASE FADE, in ms -- how long a FINISHED upper-body one-shot takes to hand
 * the torso back to the gait.
 *
 * A FIXED 150 ms, and deliberately NOT the sequence's own `blendTime`: the reference states exactly
 * that (`creature_anim/driver.rs:63-73`, decision 0878, wow-re `oneshot-lifecycle.md` §5.4) -- the
 * client's `CGUnit::OnAnimationFinished 0x5fc920` calls op4 with `param_3 = -1`, which seeds
 * `+0x100 = clock + 150`, `+0x104 = 1/150`, `+0x108 = 1.0` and disarms the primary "so the bone
 * inherits bone 0 again". `blendTime` is used only on the ARM path, which is what `armOverlay` does.
 *
 * WHAT THIS FADES AGAINST IS A STATED DEVIATION. The client snapshots the clip's held final frame
 * into the bone's secondary slot and decays that; this fades the LIVE overlay (whose clamp law holds
 * that same final frame -- `cursorMs`'s `CLAMP` leg) against the LIVE base. Same two poses, one of
 * them re-sampled rather than snapshotted, so no snapshot buffer per instance.
 */
const OVERLAY_RELEASE_FADE_MS = 150;

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).blendControl = blendControl;
  (window as unknown as Record<string, unknown>).overlayControl = overlayControl;
}

/**
 * Per-placement animation state: a clock, and nothing else that could have lived on the model.
 *
 * Sampling is CLOCK-INDEXED (`cursor = worldClock - armedAt`), never delta-accumulated
 * (benilla `doodad_anim.rs:14-16`). That is not a stylistic choice -- it is what makes the
 * offscreen gating in `gating.ts` correct. A delta-accumulated clock falls behind by exactly the
 * time it was skipped, so a doodad that leaves the frustum for ten seconds resumes ten seconds
 * behind every other copy of the same model, and the whole set drifts apart permanently. A
 * clock-indexed one resumes to the pose the shared clock dictates: pausing costs nothing and
 * drifts nothing.
 */
export class InstanceAnim {
  readonly model: ModelAnim;

  current: Sequence | null = null;
  armedAtMs = 0;

  /**
   * The model's `mergeVersion` at the moment arming last gave up, or -1 if it never has.
   *
   * A version rather than a bare `false`. See `armable`.
   */
  private unarmableAtVersion = -1;

  /**
   * False once arming has been attempted and found the model owns nothing to play.
   *
   * Memoised because the failure is a permanent property of the MODEL, while the attempt costs a
   * draw from the SHARED rng stream. `cycleDoodad` re-arms whenever `current` is null, so without
   * this a model with no animation id 0 perturbs the one stream every other doodad de-syncs off,
   * every frame, for as long as it stays loaded.
   *
   * It stopped being permanent the moment external `.anim` data could arrive. A model whose only
   * id-0 variations were quarantined latched here, and nothing un-latched it -- so once the real
   * keys merged, the doodad would have stood in bind pose for ever with correct data sitting in the
   * table beside it. Silently: no error, no wrong pose, just something that never moves.
   *
   * So the latch is stored AGAINST THE MODEL'S MERGE VERSION rather than as a boolean, and a merge
   * clears it everywhere at once. No instance registry (which would keep every placement alive), no
   * per-frame scan, and no notification anybody has to remember to send.
   *
   * A `model` without a `mergeVersion` -- a hand-built test double -- degrades correctly:
   * `undefined !== -1` is armable, and after `armable = false` `undefined !== undefined` is not.
   */
  get armable(): boolean {
    return this.unarmableAtVersion !== this.model.mergeVersion;
  }

  set armable(value: boolean) {
    this.unarmableAtVersion = value ? -1 : this.model.mergeVersion;
  }

  /** Cached from `current`, so the per-frame path does not re-derive it. */
  private law: ClockLaw = 0;
  private periodMs = 0;

  /**
   * THE SECOND WEIGHTED TRACK -- the OUTGOING sequence, kept alive only for the length of a
   * cross-fade, with everything its own clock needs.
   *
   * WHY THIS EXISTS. `blendTimeMs` has been parsed off every sequence since the table was written
   * (`model-anim.ts:374`, from `AnimationData`'s `blendTime`) and NOTHING READ IT, so every animation
   * change in this client was a hard cut between two unrelated poses. Mostly invisible -- Stand to
   * Walk share a silhouette -- and unmistakable where the poses are far apart, which is the owner's
   * report: "при прыжке назад не хватает плавного перехода в бег назад". MEASURED as `13 WalkBackwards
   * -> 37 JumpStart -> 13` with no landing clip between them (this round's report, section 6), against
   * the forward jump's `5 -> 37 -> 40 -> 187 -> 5`. The cascade is the reference's own `jump_land_pick`
   * and is correct; the missing thing is the transition itself.
   *
   * A FADE, NOT A GENERAL TWO-TRACK MIXER, and that distinction is the frame budget. The outgoing slot
   * exists only between `arm()` and `armedAt + blendMs`, so a unit in a steady gait samples exactly one
   * sequence per bone as before and only the handful mid-transition pay for two. A persistent second
   * track -- which is what the sword grip's masked `HandsClosed` overlay needs -- would double the
   * per-bone work for every unit for ever, and is deliberately NOT what this is.
   *
   * The outgoing clip keeps RUNNING as it fades (its own cursor advances off its own `armedAt` and
   * rate), which is what makes a walk fading into a run look like a change of pace rather than a
   * freeze-and-swap.
   *
   * TWO LIMITS, from a self-review of this diff rather than from a guess:
   *
   *  - A FADE INTERRUPTED BY A FADE does not chain. Arm A, then B, then C before B's fade ends, and C
   *    fades from B's own pure sample rather than from the A/B mixture that was actually on screen -- a
   *    pop of whatever the unconverged residual was. It needs a third slot or a pose snapshot to fix
   *    properly, and the case is a gait change inside 150 ms of another one.
   *  - ONLY BONES ARE BLENDED. Material and texture channels (`material-channels.ts`) sample `current`
   *    on their own path, so a clip change that also changes a texture transform still pops there. Not
   *    reachable on the gaits this was built for, which animate bones only.
   *
   * A GATED instance retires its fade correctly and needs no help: `blendWeight` is clock-indexed like
   * everything else here, so an instance skipped for a second resumes with the weight already at 1
   * rather than replaying a stale fade.
   */
  private prev: Sequence | null = null;

  private prevArmedAtMs = 0;

  private prevRate = 1;

  private prevLaw: ClockLaw = 0;

  private prevPeriodMs = 0;

  private prevFrozenElapsedMs = 0;

  /** `worldClock.ms` at which the current cross-fade began, and how long it lasts. */
  private blendStartMs = 0;

  private blendMs = 0;

  /**
   * This frame's blend weight, resolved ONCE per solve rather than per bone: 1 means "no fade, sample
   * only `current`". Held on the instance because `solveBone` recurses and threading it through would
   * add a parameter to the hottest call in the renderer.
   */
  private frameBlend = 1;

  /**
   * Bone matrices relative to bind pose, 16 floats each, RAW M2 model axes.
   *
   * Not engine axes -- the sampler reads `pivotPoint` and the translation/rotation tracks exactly as
   * the file stores them, while the geometry and the bone hierarchy were both mirrored by
   * `diag(-1, -1, 1)` on the way in. Anything driving three.js from this must conjugate first; see
   * `anim/axes.ts`.
   *
   * Allocated on first `arm()`, and then never again.
   */
  palette: Float32Array = EMPTY_F32;

  /**
   * This frame's sampled LOCAL transform per bone -- 3 position, 4 quaternion, 3 scale, raw axes.
   *
   * The palette above is the accumulated, parent-composed form. This is the un-composed form, and
   * it is what actually reaches the screen: `M2#applyPose` writes it into the three.js bone
   * hierarchy, which then does the accumulation itself. Recording it here costs ten stores per bone
   * inside a pass that was already sampling exactly these three values, so nothing is sampled twice.
   */
  localTRS: Float32Array = EMPTY_F32;

  /**
   * THE PERSISTENT MASKED SLOT -- a one-shot playing on the UPPER BODY ONLY, beside whatever the base
   * is doing. This is "the legs run, the upper body fights".
   *
   * WHY IT IS A THIRD SLOT AND NOT THE FADE ABOVE. `prev` is a time-limited, globally weighted
   * cross-fade: it covers every bone and it converges to nothing. This one covers a SUBSET of bones,
   * holds its weight for the length of a clip, and the base keeps playing underneath it the whole
   * time. `STATE.md` recorded that distinction as the reason the sword grip could not ride the blend
   * layer ("a masked `HandsClosed` needs a persistent per-bone weighted slot"); this is that slot.
   *
   * THE MECHANISM IS THE CLIENT'S, not an approximation of it. A requested one-shot is routed per
   * play from the unit's live state -- masked when the lower body is committed (moving / turning /
   * swimming / seated, or a combat id while airborne), full-body when standing idle -- which is
   * `route_oneshot` (`creature_anim/select.rs:941-961`, the client's `esi` decision
   * `0x5fe6c8..0x5fe74d`, decision 0087). The routing lives on `Unit`, which is where the live flags
   * are; this class only holds the slot and mixes it.
   *
   * ON THE MASKED BONES THE OVERLAY REPLACES THE BASE at full weight, and that is the CLIENT's
   * behaviour rather than the reference's: the reference blends base and overlay at an 8:1 weight and
   * says so explicitly -- "the base clip is *not* masked out of that subtree ... this makes the
   * overlay dominate approximately 8:1 ..., a small bleed the cost of Bevy's weighted blend"
   * (`driver.rs:53-59`). Our solver samples per bone, so it can do what the client does: arm the
   * key-bone's primary slot, and the subtree stops inheriting bone 0 until the release fade disarms
   * it (`driver.rs:66-72`). No bleed, and one fewer weighted lerp per bone.
   *
   * COST. Zero for an instance with no overlay: `overlaySeq === null` is one comparison per solve
   * (the retire/weight resolve) plus one per bone, the same shape as the `prev` check beside it. An
   * instance WITH one pays a second sample on the masked bones only, for the length of one clip.
   *
   * LIMITS, stated:
   *  - ONE overlay slot. A swing arriving over a live swing does not chain; the arm blends from
   *    whatever the subtree holds, which is the same limit the cross-fade documents above.
   *  - ONE-SHOTS ONLY, because retirement is "the clip's window elapsed, then 150 ms". A LOOPING
   *    masked clip -- the reference's moving cast hold (`driver.rs:1136`) and the weapon grip -- has
   *    no window, so it needs an explicit stow the callers do not have yet. `Unit` refuses to route
   *    a loop here for exactly that reason.
   *  - Material and texture channels are not masked (they are not per bone at all), same as the
   *    cross-fade.
   */
  private overlaySeq: Sequence | null = null;

  private overlayArmedAtMs = 0;

  private overlayRate = 1;

  private overlayLaw: ClockLaw = 0;

  private overlayPeriodMs = 0;

  private overlayBlendMs = 0;

  /**
   * The bones the overlay drives -- `ModelAnim#upperBodyMask()`, one byte per bone. Held by
   * reference: it is one shared array per model, never per instance.
   */
  private overlayMask: Uint8Array | null = null;

  /** This frame's overlay weight, resolved ONCE per solve. 0 means "no overlay this frame". */
  private frameOverlay = 0;

  /** This frame's overlay cursor, resolved once per solve beside its weight. Valid only when > 0. */
  private overlayCursorMs = 0;

  /** Per-bone "already solved this frame" flags, cleared at the top of each solve. */
  private solved: Uint8Array = EMPTY_U8;

  /** Scratch matrices, one per bone, so composition never allocates. */
  private readonly matrices: THREE.Matrix4[] = [];

  private allocated = false;

  constructor(model: ModelAnim) {
    this.model = model;
  }

  /**
   * Allocate the per-bone buffers, once, on first use.
   *
   * Deliberately NOT done in the constructor. Every animated placement owns an `InstanceAnim`, and
   * a 40-bone model's buffers run to roughly 8 KB -- but one of those placements is
   * `M2Blueprint.cache`'s prototype, which exists only to be cloned and is never placed, never
   * armed and never rendered. Streaming a zone builds one prototype per model path plus one
   * instance per placement, and the prototypes' share of that is pure waste. Deferring to `arm()`
   * also means a doodad that is only in the per-frame set for BILLBOARDING pays nothing here.
   */
  private ensureBuffers(): void {
    if (this.allocated) {
      return;
    }
    this.allocated = true;

    const boneCount = this.model.boneDefs.length;
    this.palette = new Float32Array(boneCount * 16);
    this.localTRS = new Float32Array(boneCount * LOCAL_TRS_STRIDE);
    this.solved = new Uint8Array(boneCount);
    for (let i = 0; i < boneCount; ++i) {
      this.matrices.push(new THREE.Matrix4());
    }
  }

  /**
   * Start a sequence at `worldClockMs`.
   *
   * The clock law is resolved once, here, from the sequence's own loop flag -- never per sample.
   */
  arm(seq: Sequence, worldClockMs: number, rate: number = 1): void {
    this.ensureBuffers();

    // OPEN A CROSS-FADE from whatever was playing. `blendTimeMs` is the INCOMING sequence's, which is
    // how the file expresses it: `AnimationData.blendTime` answers "how long does it take to blend INTO
    // this animation". Zero means a deliberate hard cut and is respected as one -- a death, and any
    // sequence the authors gave 0 -- so this never invents a transition the data did not ask for.
    //
    // Re-arming the SAME sequence never opens a fade: that is a restart of a one-shot (a swing at the
    // next weapon tick), and fading a clip into itself would ghost the first frames against the last.
    if (this.current !== null && this.current !== seq && seq.blendTimeMs > 0) {
      this.prev = this.current;
      this.prevArmedAtMs = this.armedAtMs;
      this.prevRate = this.rate;
      this.prevLaw = this.law;
      this.prevPeriodMs = this.periodMs;
      this.prevFrozenElapsedMs = this.frozenElapsedMs;
      this.blendStartMs = worldClockMs;
      this.blendMs = Math.min(seq.blendTimeMs, BLEND_MAX_MS);
    } else {
      this.prev = null;
    }

    this.current = seq;
    this.armedAtMs = worldClockMs;
    this.periodMs = seq.lengthMs;
    this.rate = rate;
    // A sequence-timeline channel: `globalSequenceID` -1 defers to the sequence's loop flag.
    this.law = clockLaw({ interpolationType: 1, globalSequenceID: -1, tracks: [] }, seq.loops);
  }

  /** The masked one-shot currently on the upper body, or null. Read by the router and the probe. */
  get overlay(): Sequence | null {
    return this.overlaySeq;
  }

  /** The overlay's live playback multiplier -- the whiff slow-down reads it to halve it. */
  get overlayPlaybackRate(): number {
    return this.overlayRate;
  }

  /**
   * The overlay's weight as of the LAST SOLVE -- 0 when there is none.
   *
   * For the instrument, and it is the one number that says the split is actually on screen: a probe
   * that reads `overlay` alone cannot tell an armed slot from a contributing one. Read only, resolved
   * during `solveBones`, so asking costs nothing and cannot change what the frame did (this project
   * has shipped an instrument a fix would have blinded; a getter over the value the solver already
   * used cannot be that).
   */
  get overlayWeightLastSolve(): number {
    return this.frameOverlay;
  }

  /**
   * Arm a one-shot on the UPPER BODY, leaving the base track -- the gait -- running underneath.
   *
   * `mask` is the model's split mask (`ModelAnim#upperBodyMask()`); a caller with `null` there has a
   * rig with no split key-bone and must route full body instead, which is the client's `-1` sentinel
   * behaviour and is enforced at the call site rather than silently here.
   *
   * The arm is BLENDED over the INCOMING clip's own `blendTime`, which is where that field is used and
   * the only place it is: "the re-arm is **blended** (op4 `blendFlag = 1`) ... this clip rises over its
   * own blendTime (`0x7125f2` -- the INCOMING sequence's `M2Sequence+0x20`), so a masked swing never
   * swaps the torso in one frame" (`creature_anim/driver.rs:929-934`). A clip authored `blendTime 0`
   * is a deliberate hard cut and gets one, exactly as on the base path.
   */
  armOverlay(seq: Sequence, mask: Uint8Array, worldClockMs: number): void {
    this.ensureBuffers();
    this.overlaySeq = seq;
    this.overlayMask = mask;
    this.overlayArmedAtMs = worldClockMs;
    this.overlayRate = 1;
    this.overlayPeriodMs = seq.lengthMs;
    this.overlayBlendMs = Math.min(Math.max(seq.blendTimeMs, 0), BLEND_MAX_MS);
    this.overlayLaw = clockLaw({ interpolationType: 1, globalSequenceID: -1, tracks: [] }, seq.loops);
  }

  /**
   * THE TRANSPLANT (`0x5fe919`) -- move the clip currently on the BASE track up onto the upper body,
   * **at exactly the frame it was on**, so the base is free for a locomotion request.
   *
   * This is the other half of the composition model, and the reference names the case it exists for:
   * "A base **locomotion** clip requested while bone 0 still plays a live CAST or COMBAT one-shot does
   * not replace it: the client copies the bone-0 descriptor -- its id, its rate, and `+0x08` the clip's
   * **live elapsed position** -- onto the key-bone with `blendFlag = 0`, then hands bone 0 the request.
   * The cast therefore keeps running on the torso *at exactly the frame it was on*, with no cross-fade
   * and no restart, while the legs take the jump or the run. This is the director's **'jump right after
   * a cast: the legs jump, the arms finish the cast'**" (`creature_anim/driver.rs:194-208`, wow-re
   * `oneshot-lifecycle.md` section 3a, decision 0878).
   *
   * `blendFlag = 0` is the whole point of the arithmetic here: `overlayBlendMs` is 0 (no ramp -- the
   * clip is already on screen at full weight, so ramping it up would fade the pose out and back in) and
   * `overlayArmedAtMs` is BACK-DATED so the overlay's cursor equals the base's cursor this instant. The
   * clip does not restart, does not jump, and its window still ends when it always would.
   *
   * Returns false and changes nothing when there is nothing to move or nowhere to move it: no base
   * clip, the overlay already occupied (the reference's own no-op -- "`0x5fe912` then jumps straight to
   * `0x5fe930`: request -> bone 0, key-bone untouched"), or a base clip whose window has already
   * elapsed (the client's descriptor probe reports a completed slot as id -1, so "the transplant
   * predicates never see it" -- `driver/mode.rs:313-317`).
   *
   * WHICH clips may be moved is NOT decided here -- that is `isCastAnim`/`isCombatAnim` on the caller,
   * because it is a question about the animation id and this class knows nothing about ids.
   */
  transplantToOverlay(mask: Uint8Array, worldClockMs: number): boolean {
    const seq = this.current;
    if (seq === null || this.overlaySeq !== null || this.periodMs <= 0) {
      return false;
    }
    if (this.windowElapsed(worldClockMs)) {
      return false;
    }
    const cursor = this.cursor(worldClockMs);
    const rate = this.rate > 0 ? this.rate : 1;

    this.overlaySeq = seq;
    this.overlayMask = mask;
    this.overlayRate = rate;
    this.overlayPeriodMs = this.periodMs;
    this.overlayLaw = this.law;
    // `blendFlag = 0`: no ramp at all. See the doc -- a ramp here would fade a pose that is already
    // fully on screen.
    this.overlayBlendMs = 0;
    // The live elapsed position, expressed the only way a clock-indexed slot can express it.
    this.overlayArmedAtMs = worldClockMs - cursor / rate;
    return true;
  }

  /** Change the overlay's playback rate, holding its pose -- `setRate`'s logic on the masked slot. */
  setOverlayRate(rate: number, worldClockMs: number): void {
    if (rate === this.overlayRate || this.overlaySeq === null || rate <= 0) {
      return;
    }
    const elapsed = (worldClockMs - this.overlayArmedAtMs) * this.overlayRate;
    this.overlayArmedAtMs = worldClockMs - elapsed / rate;
    this.overlayRate = rate;
  }

  /**
   * Has the masked one-shot finished its play window? True when there is no overlay at all.
   *
   * The combat fast-path asks this: a swing requested while the SAME swing is still in flight doubles
   * the in-flight clip's rate rather than re-arming it (`driver.rs:864-872`, the client's
   * `0x5fe43c`-`0x5fe48b`).
   */
  overlayWindowElapsed(worldClockMs: number): boolean {
    if (this.overlaySeq === null) {
      return true;
    }
    return worldClockMs >= this.overlayEndMs();
  }

  /**
   * When the overlay's window closes, on the WORLD clock -- derived, never stored, so a rate change
   * and a gated frame both come out right (the same reason every clock here is `clock - armedAt`).
   *
   * A zero-length clip ends the instant it is armed, which is "already finished" and is what
   * `windowElapsedOrInstant` says about it on the base path too.
   */
  private overlayEndMs(): number {
    // A NON-POSITIVE RATE IS UNREACHABLE and the guard stays anyway: `armOverlay` always sets 1 and
    // `setOverlayRate` refuses anything <= 0, so nothing today can divide by zero here. Said plainly
    // rather than left to read as a live case -- the base track's `setRate` DOES accept 0 (the
    // reference's airborne freeze), and someone extending that to the overlay would land here.
    if (this.overlayRate <= 0) {
      return Infinity;
    }
    return this.overlayArmedAtMs + this.overlayPeriodMs / this.overlayRate;
  }

  /**
   * The overlay's weight this frame, and its RETIREMENT.
   *
   * Three phases: rise over the incoming clip's `blendTime`, hold at 1 for the clip, then the fixed
   * 150 ms release fade (`OVERLAY_RELEASE_FADE_MS`). Past the fade the slot is dropped here -- the one
   * place that knows the fade is over -- so a retired overlay costs one null check per bone again.
   *
   * Called ONCE per solve. It mutates on retirement, which is why it is not a getter.
   */
  private overlayWeight(worldClockMs: number): number {
    if (this.overlaySeq === null) {
      return 0;
    }
    const end = this.overlayEndMs();
    if (worldClockMs >= end) {
      const fading = worldClockMs - end;
      if (fading >= OVERLAY_RELEASE_FADE_MS) {
        this.overlaySeq = null;
        this.overlayMask = null;
        return 0;
      }
      return 1 - fading / OVERLAY_RELEASE_FADE_MS;
    }
    const rising = worldClockMs - this.overlayArmedAtMs;
    if (this.overlayBlendMs > 0 && rising < this.overlayBlendMs) {
      return rising <= 0 ? 0 : rising / this.overlayBlendMs;
    }
    return 1;
  }

  /** Where the overlay's own clock stands -- `cursor`'s arithmetic on the masked slot. */
  private overlayCursor(worldClockMs: number): number {
    const elapsed = (worldClockMs - this.overlayArmedAtMs) * this.overlayRate;
    return cursorMs(this.overlayLaw, elapsed, this.overlayPeriodMs);
  }

  /**
   * Playback rate. 1 is the authored speed; the locomotion driver scales a gait by
   * `groundSpeed / sequence.moveSpeed` so a walk cycle's feet match the ground
   * (`Unit#locomotionRate`, the reference's `scaled_rate`, `select.rs:1053-1056`).
   *
   * Read through `setRate`, never assigned: the cursor is `(clock - armedAt) * rate`, so changing
   * the multiplier without re-anchoring `armedAtMs` would jump the whole elapsed time and snap the
   * pose. A run that gradually accelerates changes rate on most frames.
   */
  private rate = 1;

  /** The live playback multiplier, for the instrumentation. Written only through `setRate`/`arm`. */
  get playbackRate(): number {
    return this.rate;
  }

  /** Change the playback rate, holding the pose: re-anchor so the current cursor is unchanged. */
  setRate(rate: number, worldClockMs: number): void {
    if (rate === this.rate) {
      return;
    }
    const elapsed = (worldClockMs - this.armedAtMs) * this.rate;
    // A zero rate freezes the pose where it stands (the reference's airborne snapshot). Re-anchoring
    // through a division by it is the one case that has no inverse, so anchor from the old elapsed.
    this.armedAtMs = rate !== 0 ? worldClockMs - elapsed / rate : worldClockMs;
    if (rate === 0) {
      this.frozenElapsedMs = elapsed;
    }
    this.rate = rate;
  }

  /** The elapsed time held while `rate` is 0, so a frozen pose does not collapse to the first key. */
  private frozenElapsedMs = 0;

  /** Where this instance's own sequence clock stands at `worldClockMs`. */
  cursor(worldClockMs: number): number {
    if (this.current === null) {
      return 0;
    }
    const elapsed = this.rate === 0
      ? this.frozenElapsedMs
      : (worldClockMs - this.armedAtMs) * this.rate;
    return cursorMs(this.law, elapsed, this.periodMs);
  }

  /**
   * Where the OUTGOING sequence's own clock stands -- the same arithmetic as `cursor`, against the
   * clock state stashed at `arm`. Split out rather than parameterised on `cursor` because the two are
   * read from different places and a shared helper with six arguments reads worse than this.
   */
  private prevCursor(worldClockMs: number): number {
    const elapsed = this.prevRate === 0
      ? this.prevFrozenElapsedMs
      : (worldClockMs - this.prevArmedAtMs) * this.prevRate;
    return cursorMs(this.prevLaw, elapsed, this.prevPeriodMs);
  }

  /**
   * How much of the INCOMING sequence to show: 0 at the moment of the arm, 1 once `blendTimeMs` has
   * passed. 1 whenever there is nothing to fade from.
   *
   * LINEAR, and that is a stated gap: the reference cross-fades with its own envelope
   * (`creature_anim/driver.rs`'s overlay fade and `WOUND_AMPLITUDE`), which this does not transcribe.
   * A linear ramp over the file's own blend time is what removes the hard cut; the shape of the ramp is
   * the next refinement, not this one.
   */
  private blendWeight(worldClockMs: number): number {
    if (this.prev === null || this.blendMs <= 0) {
      return 1;
    }
    const w = (worldClockMs - this.blendStartMs) / this.blendMs;
    return w >= 1 ? 1 : (w <= 0 ? 0 : w);
  }

  /**
   * Has the current one-shot or loop reached the end of its play window?
   *
   * `periodMs <= 0` answers FALSE, and that is load-bearing rather than an oversight: this is also
   * the cursor's "is there a timeline here at all" test, and a zero-length sequence answering true
   * would make `cycleDoodad` re-arm -- redrawing from the shared variation rng -- every frame for as
   * long as the doodad stayed loaded.
   *
   * A caller asking the ONE-SHOT question ("may I hand the body back / restart this?") wants the
   * other reading, where no window means nothing to wait for. That is `windowElapsedOrInstant`
   * below; do not fold it in here.
   */
  windowElapsed(worldClockMs: number): boolean {
    if (this.current === null || this.periodMs <= 0) {
      return false;
    }
    // Scaled by `rate` for the same reason `cursor` is: a one-shot played at half speed has not
    // finished when half its authored length has passed. A frozen clip never elapses, which is what
    // "frozen" means.
    if (this.rate === 0) {
      return false;
    }
    return (worldClockMs - this.armedAtMs) * this.rate >= this.periodMs;
  }

  /**
   * Solve every bone into `palette` and return how many were solved.
   *
   * Lazy and parent-first, following WebWoWViewer's `calcBones`: a bone is solved at most once per
   * frame however many children ask for it, and the recursion means an unanimated branch costs one
   * flag check rather than a matrix compose.
   */
  solveBones(worldClockMs: number): number {
    this.ensureBuffers();

    const count = this.model.boneDefs.length;
    this.solved.fill(0);

    // ONCE PER SOLVE, not once per bone -- and the fade is RETIRED here rather than in `cursor`, so a
    // finished blend costs exactly one comparison per solve and then nothing at all. A unit that is not
    // mid-transition samples one sequence per bone, exactly as before this existed.
    this.frameBlend = blendControl.enabled ? this.blendWeight(worldClockMs) : 1;
    if (this.frameBlend >= 1) {
      this.prev = null;
    }

    // The masked overlay, resolved the same way and for the same reason: once per solve, and the slot
    // is RETIRED inside `overlayWeight` so a finished one-shot stops costing anything at all. The A/B
    // switch is read here and nowhere per-bone.
    this.frameOverlay = overlayControl.enabled ? this.overlayWeight(worldClockMs) : 0;
    if (this.frameOverlay > 0) {
      this.overlayCursorMs = this.overlayCursor(worldClockMs);
      animCounters.overlays += 1;
    }

    for (let i = 0; i < count; ++i) {
      this.solveBone(i, worldClockMs);
    }

    for (let i = 0; i < count; ++i) {
      this.matrices[i].toArray(this.palette, i * 16);
    }

    return count;
  }

  private solveBone(index: number, worldClockMs: number): void {
    if (this.solved[index]) {
      return;
    }
    // Marked BEFORE recursing: a malformed parent cycle would otherwise recurse until the stack
    // blows, and a cycle in shipped data should degrade to a wrong pose, not a crash.
    this.solved[index] = 1;

    const def = this.model.boneDefs[index];
    // UNARMED reads slot -1, a non-slot, NOT slot 0. Nothing on the pose paths checks `current` --
    // `poseGatedInstance` calls `solveBones` unconditionally and its callers gate on `inst !== null`
    // -- so an instance that never armed still gets solved every eligible frame. Slot 0 is not
    // guaranteed inline, and a model whose id-0 variations are all external (so `armDoodad` latched
    // unarmable, or `resolve` returned null) would sample exactly the quarantined noise
    // `hasInlineData` exists to withhold. `trackFor` returns null for -1, so every channel falls to
    // bind pose, which is the correct unarmed appearance anyway.
    const seqIndex = this.current ? this.current.index : UNARMED_SLOT;
    const t = this.cursor(worldClockMs);

    scratchPos.set(0, 0, 0);
    scratchQuat.set(0, 0, 0, 1);
    scratchScale.set(1, 1, 1);

    const translation = trackFor(def.translation, seqIndex);
    if (translation) {
      sampleVec3(translation, isStep(def.translation), t, scratchPos);
    }

    const rotation = trackFor(def.rotation, seqIndex);
    if (rotation) {
      sampleQuat(rotation, isStep(def.rotation), t, scratchQuat);
    }

    const scaling = trackFor(def.scaling, seqIndex);
    if (scaling) {
      sampleVec3(scaling, isStep(def.scaling), t, scratchScale);
    }

    // THE CROSS-FADE. The outgoing sequence is sampled from ITS OWN slot at ITS OWN cursor and mixed
    // toward the incoming one by this frame's weight. `1 - w` is the alpha because three's `lerp`/`slerp`
    // move the RECEIVER toward the argument, and the receiver here already holds the incoming pose --
    // so at w=0 the result is entirely `prev` and at w=1 entirely `current`.
    //
    // A bone with no track in one of the two slots still blends correctly: its scratch holds the
    // identity (bind pose) for that slot, which is exactly what "this sequence does not animate this
    // bone" means, and is why the fade also smooths a change between clips that animate different bones.
    //
    // ALL OF THIS BEFORE THE PARENT RECURSION BELOW, for the reason that recursion's own comment gives:
    // every scratch object here is module-level and the recursive call overwrites all six.
    const prevSeq = this.prev;
    if (prevSeq !== null) {
      const w = this.frameBlend;
      const pt = this.prevCursor(worldClockMs);
      const ps = prevSeq.index;

      blendPos.set(0, 0, 0);
      blendQuat.set(0, 0, 0, 1);
      blendScale.set(1, 1, 1);

      const prevTranslation = trackFor(def.translation, ps);
      if (prevTranslation) {
        sampleVec3(prevTranslation, isStep(def.translation), pt, blendPos);
      }
      const prevRotation = trackFor(def.rotation, ps);
      if (prevRotation) {
        sampleQuat(prevRotation, isStep(def.rotation), pt, blendQuat);
      }
      const prevScaling = trackFor(def.scaling, ps);
      if (prevScaling) {
        sampleVec3(prevScaling, isStep(def.scaling), pt, blendScale);
      }

      const alpha = 1 - w;
      scratchPos.lerp(blendPos, alpha);
      scratchQuat.slerp(blendQuat, alpha);
      scratchScale.lerp(blendScale, alpha);
    }

    // THE MASKED UPPER-BODY OVERLAY. On a bone inside the split subtree the overlay REPLACES the base
    // at full weight once its arm blend has risen -- the client arms the key-bone's primary slot and
    // the subtree stops inheriting bone 0 until the release fade disarms it (`driver.rs:66-72`). Outside
    // the subtree the mask is 0 and this costs one array read: that is what leaves the legs on the gait.
    //
    // AFTER the cross-fade above, so a torso mid-gait-transition still gets its swing: the two mix in
    // the order the client's slots do -- the base (including its own outgoing fade) is what the overlay
    // is composed over. Reuses the same three module-level scratch objects the fade just finished with.
    const ovSeq = this.overlaySeq;
    const ovMask = this.overlayMask;
    if (ovSeq !== null && this.frameOverlay > 0 && ovMask !== null && ovMask[index] !== 0) {
      const ot = this.overlayCursorMs;
      const os = ovSeq.index;

      blendPos.set(0, 0, 0);
      blendQuat.set(0, 0, 0, 1);
      blendScale.set(1, 1, 1);

      const ovTranslation = trackFor(def.translation, os);
      if (ovTranslation) {
        sampleVec3(ovTranslation, isStep(def.translation), ot, blendPos);
      }
      const ovRotation = trackFor(def.rotation, os);
      if (ovRotation) {
        sampleQuat(ovRotation, isStep(def.rotation), ot, blendQuat);
      }
      const ovScaling = trackFor(def.scaling, os);
      if (ovScaling) {
        sampleVec3(ovScaling, isStep(def.scaling), ot, blendScale);
      }

      // Toward the OVERLAY by its weight -- the opposite direction from the cross-fade above, where the
      // receiver already held the incoming pose. Here the receiver holds the base and the overlay is
      // the argument, so weight 1 is entirely the overlay and 0 entirely the base.
      const w = this.frameOverlay;
      if (w >= 1) {
        scratchPos.copy(blendPos);
        scratchQuat.copy(blendQuat);
        scratchScale.copy(blendScale);
      } else {
        scratchPos.lerp(blendPos, w);
        scratchQuat.slerp(blendQuat, w);
        scratchScale.lerp(blendScale, w);
      }
    }

    // Record the un-composed local TRS BEFORE recursing into the parent -- the scratch objects are
    // module-level and the recursive call below overwrites all three of them.
    const trs = this.localTRS;
    const o = index * LOCAL_TRS_STRIDE;
    trs[o] = scratchPos.x;
    trs[o + 1] = scratchPos.y;
    trs[o + 2] = scratchPos.z;
    trs[o + 3] = scratchQuat.x;
    trs[o + 4] = scratchQuat.y;
    trs[o + 5] = scratchQuat.z;
    trs[o + 6] = scratchQuat.w;
    trs[o + 7] = scratchScale.x;
    trs[o + 8] = scratchScale.y;
    trs[o + 9] = scratchScale.z;

    // M2 animates AROUND the pivot: translate to the pivot, apply the animated TRS, translate back.
    const pivot = def.pivotPoint;
    scratchPivot.set(pivot[0], pivot[1], pivot[2]);
    scratchPivotTo.makeTranslation(scratchPivot.x, scratchPivot.y, scratchPivot.z);
    scratchPivotBack.makeTranslation(-scratchPivot.x, -scratchPivot.y, -scratchPivot.z);

    scratchLocal.compose(scratchPos, scratchQuat, scratchScale);

    const out = this.matrices[index];
    out.copy(scratchPivotTo).multiply(scratchLocal).multiply(scratchPivotBack);

    if (def.parentID > -1 && def.parentID < this.model.boneDefs.length) {
      this.solveBone(def.parentID, worldClockMs);
      out.premultiply(this.matrices[def.parentID]);
    }
  }
}

/**
 * "This sequence's play window is over, OR it never had one." The one-shot predicate.
 *
 * ONE helper for BOTH one-shot sites, because they are the same question and were answered
 * differently: `Unit#updateLocomotion` spelled the degenerate case out (`lengthMs > 0 && ...`) while
 * `Unit#setAnimation` did not, so a zero-length one-shot could be played exactly once and then never
 * replayed -- the request was swallowed for ever by a window that can never elapse.
 *
 * Zero-length sequences are real: an alias row, an authoring stub, and any `.anim`-backed sequence
 * whose `lengthMs` the file records as 0. `windowElapsed` cannot answer this itself -- see its doc
 * for what its `false` protects.
 *
 * `seq` is a parameter rather than read off `inst.current` so the caller states WHICH sequence it is
 * asking about. Both sites have already established `inst.current === seq`; passing it makes that
 * explicit and keeps the helper honest if one day they have not.
 */
export function windowElapsedOrInstant(
  inst: InstanceAnim,
  seq: Sequence,
  worldClockMs: number,
): boolean {
  if (seq.lengthMs <= 0) {
    return true;
  }
  return inst.windowElapsed(worldClockMs);
}
