import * as THREE from 'three';
import { ModelAnim, Sequence } from './model-anim';
import { ClockLaw, clockLaw, cursorMs, isStep, sampleQuat, sampleVec3, trackFor } from './tracks';

// Module-level scratch objects -- the solver runs per bone per instance per frame and must not
// allocate.
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchPivot = new THREE.Vector3();
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
  arm(seq: Sequence, worldClockMs: number): void {
    this.ensureBuffers();
    this.current = seq;
    this.armedAtMs = worldClockMs;
    this.periodMs = seq.lengthMs;
    // A sequence-timeline channel: `globalSequenceID` -1 defers to the sequence's loop flag.
    this.law = clockLaw({ interpolationType: 1, globalSequenceID: -1, tracks: [] }, seq.loops);
  }

  /** Where this instance's own sequence clock stands at `worldClockMs`. */
  cursor(worldClockMs: number): number {
    if (this.current === null) {
      return 0;
    }
    return cursorMs(this.law, worldClockMs - this.armedAtMs, this.periodMs);
  }

  /** Has the current one-shot or loop reached the end of its play window? */
  windowElapsed(worldClockMs: number): boolean {
    if (this.current === null || this.periodMs <= 0) {
      return false;
    }
    return worldClockMs - this.armedAtMs >= this.periodMs;
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
