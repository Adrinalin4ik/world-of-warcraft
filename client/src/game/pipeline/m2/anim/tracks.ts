/**
 * M2 keyframe sampling.
 *
 * The sampling law is ported from benilla's `KeyAnim::sample_or`
 * (`samples/benilla/crates/benilla-formats/src/models/key_anim.rs`), which is byte-verified against
 * the 1.12.1 kernel. Its BAND MECHANICS are deliberately NOT ported: benilla parses the vanilla
 * track layout (one absolute key list plus a per-sequence `ranges` index window), while 3.3.5 stores
 * one key array per sequence outright -- see `blizzardry/src/lib/m2/animation-block.js`. The window
 * search benilla needs collapses here to a plain bracket search over the sequence's own keys.
 */

import * as THREE from 'three';

/** One sequence's keys within an animation block. `values` element type depends on the block. */
export interface SeqTrack {
  animationIndex: number;
  timestamps: number[];
  values: unknown[];
}

/** An M2 AnimationBlock as parsed by `wow-data-parser/m2/animation-block.js`. */
export interface AnimBlock {
  interpolationType: number;
  globalSequenceID: number;
  tracks: SeqTrack[];
}

/**
 * `interpolationType == 0` is STEP: hold each key until the next.
 *
 * Treating it as linear is not a rounding difference. Step tracks are used for quantities that were
 * never meant to take an in-between value -- a blink flag, a texture flipbook cell -- and lerping
 * one produces a value the artist never authored.
 */
export function isStep(block: AnimBlock): boolean {
  return block.interpolationType === 0;
}

/**
 * The track a given sequence slot plays, or `null` when it has nothing to say.
 *
 * Returns null rather than falling back to track 0 on purpose: a sequence with no track for a
 * channel is authored to leave that channel alone, and substituting another sequence's keys poses
 * it from an unrelated animation.
 */
export function trackFor(block: AnimBlock, seqIndex: number): SeqTrack | null {
  const track = block.tracks[seqIndex];
  if (!track || track.timestamps.length === 0 || track.values.length === 0) {
    return null;
  }
  return track;
}

/**
 * Clamp a bracket index into the `values` array.
 *
 * `bracket` only inspects `timestamps`. A track whose `values` array is shorter -- malformed but
 * real data -- therefore yields an index that is valid for `timestamps` and out of bounds for
 * `values`, and the read returns `undefined` typed as a number. Downstream that is NaN in a bone
 * matrix, which silently poisons an entire skeleton while every input still inspects as correct.
 *
 * Callers guarantee `valuesLength > 0` (each sampler returns early on an empty track), so this
 * cannot produce -1.
 */
function clampToValues(k0: number, valuesLength: number): number {
  return k0 < valuesLength - 1 ? k0 : valuesLength - 1;
}

/**
 * Index of the last key at or before `tMs`, clamped into range.
 *
 * Shared by every typed sampler so the bracketing rule exists once.
 */
function bracket(timestamps: number[], tMs: number): number {
  let k0 = 0;
  for (let i = 0, len = timestamps.length; i < len; ++i) {
    if (timestamps[i] <= tMs) {
      k0 = i;
    } else {
      break;
    }
  }
  return k0;
}

/**
 * Interpolation fraction between keys `k0` and `k0 + 1`, clamped to [0, 1].
 *
 * The clamp is a NAMED DEVIATION from the reference, taken from benilla (`key_anim.rs:135-148`):
 * the kernel computes the fraction unclamped and therefore extrapolates past a bracket. An
 * extrapolated value below zero on an alpha channel culls a batch on a data quirk rather than on
 * authoring, so we hold at the bracket instead of running past it.
 *
 * Returns 0 for a non-advancing pair, which makes duplicate timestamps hold instead of dividing by
 * zero.
 */
function fraction(timestamps: number[], k0: number, tMs: number): number {
  const ta = timestamps[k0];
  const tb = timestamps[k0 + 1];
  if (tb <= ta) {
    return 0;
  }
  const f = (tMs - ta) / (tb - ta);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** True when `k0` is the last key, i.e. there is nothing to interpolate toward. */
function atEnd(track: SeqTrack, k0: number): boolean {
  return k0 + 1 >= track.timestamps.length || k0 + 1 >= track.values.length;
}

export function sampleScalar(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  fallback: number,
): number {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return fallback;
  }

  const k0 = bracket(timestamps, tMs);
  const k0c = clampToValues(k0, values.length);
  const va = values[k0c] as number;

  // Step, or past the final key: HOLD. There is deliberately no wrap-lerp back toward key 0.
  if (step || atEnd(track, k0)) {
    return va;
  }

  const vb = values[k0c + 1] as number;
  return va + (vb - va) * fraction(timestamps, k0, tMs);
}

/** Scratch quaternion for the slerp target. Module-level: this runs per bone per frame. */
const scratchQuat = new THREE.Quaternion();

export function sampleVec3(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return out;
  }

  const k0 = bracket(timestamps, tMs);
  // Same guard `sampleScalar` carries: `bracket` only inspects `timestamps`, so a track whose
  // `values` array is shorter yields a `k0` out of bounds for `values`, and the read comes back
  // `undefined` -- which becomes NaN in a bone matrix and silently poisons a whole skeleton.
  const k0c = clampToValues(k0, values.length);
  const va = values[k0c] as ArrayLike<number>;

  if (step || atEnd(track, k0)) {
    return out.set(va[0], va[1], va[2]);
  }

  const vb = values[k0c + 1] as ArrayLike<number>;
  const f = fraction(timestamps, k0, tMs);

  return out.set(
    va[0] + (vb[0] - va[0]) * f,
    va[1] + (vb[1] - va[1]) * f,
    va[2] + (vb[2] - va[2]) * f,
  );
}

/**
 * Sample a rotation track.
 *
 * SLERP, never a component-wise lerp. Lerping four components independently produces a shorter,
 * non-unit quaternion at the midpoint, and a non-unit rotation scales the bone -- limbs visibly
 * shorten halfway through every swing while both endpoints look perfect, which is why this reads as
 * a rigging fault rather than a sampling one.
 *
 * Keys arrive already decompressed: `compfixed16` converts each component to a float in [-1, 1] at
 * parse time (`client/src/wow-data-parser/types/comp-fixed16.js`).
 */
export function sampleQuat(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return out;
  }

  const k0 = bracket(timestamps, tMs);
  const k0c = clampToValues(k0, values.length);
  const va = values[k0c] as ArrayLike<number>;
  out.set(va[0], va[1], va[2], va[3]);

  if (step || atEnd(track, k0)) {
    return out;
  }

  const vb = values[k0c + 1] as ArrayLike<number>;
  scratchQuat.set(vb[0], vb[1], vb[2], vb[3]);

  return out.slerp(scratchQuat, fraction(timestamps, k0, tMs));
}
