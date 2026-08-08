import { FIXED16_SCALE } from '../../../../wow-data-parser/m2/particle/part-track';

/**
 * Track evaluation for M2 particle emitters.
 *
 * Two unrelated kinds of track are involved, and conflating them is the easy mistake:
 *
 *   FBlock (M2PartTrack) is keyed on a fraction of a single particle's lifetime, 0 to 1. Its `keys`
 *   are already normalised by the parser. Colour, alpha, scale and cell index come from these.
 *
 *   AnimationBlock (M2Track) is keyed on animation time in milliseconds and holds one sub-track per
 *   animation. The emitter's inputs -- emission rate, speed, gravity, lifespan and so on -- come from
 *   these.
 */

interface Key<T> { time: number; value: T; }
interface Block<T> { keys: Array<Key<T>>; }

/** Locate the bracketing keys for `t` and the 0-1 blend between them. */
const bracket = <T>(keys: Array<Key<T>>, t: number) => {
  if (t <= keys[0].time) {
    return { a: 0, b: 0, mix: 0 };
  }

  const last = keys.length - 1;

  if (t >= keys[last].time) {
    return { a: last, b: last, mix: 0 };
  }

  let b = 1;
  while (b < last && keys[b].time < t) {
    b++;
  }

  const a = b - 1;
  const span = keys[b].time - keys[a].time;

  return { a, b, mix: span > 0 ? (t - keys[a].time) / span : 0 };
};

const lerp = (from: number, to: number, mix: number) => from + (to - from) * mix;

export const evaluateFBlockScalar = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 0;
  }

  const { a, b, mix } = bracket(keys, t);

  return lerp(keys[a].value, keys[b].value, mix);
};

/** Raw int16 in 0..32767. Absent means fully opaque, which is the sane default for a missing track. */
export const evaluateFBlockAlpha = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 1;
  }

  const { a, b, mix } = bracket(keys, t);

  return lerp(keys[a].value, keys[b].value, mix) / FIXED16_SCALE;
};

/** Values are {x,y,z} with each channel 0..255. Absent means white, so the texture passes through. */
export const evaluateFBlockColor = (
  block: Block<{ x: number; y: number; z: number }> | undefined,
  t: number,
  out: { r: number; g: number; b: number },
) => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    out.r = 1;
    out.g = 1;
    out.b = 1;
    return out;
  }

  const { a, b, mix } = bracket(keys, t);

  out.r = lerp(keys[a].value.x, keys[b].value.x, mix) / 255;
  out.g = lerp(keys[a].value.y, keys[b].value.y, mix) / 255;
  out.b = lerp(keys[a].value.z, keys[b].value.z, mix) / 255;

  return out;
};

/** Values are 2-element arrays, not objects. Absent means unit scale. */
export const evaluateFBlockVec2 = (
  block: Block<number[]> | undefined,
  t: number,
  out: { x: number; y: number },
) => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    out.x = 1;
    out.y = 1;
    return out;
  }

  const { a, b, mix } = bracket(keys, t);

  out.x = lerp(keys[a].value[0], keys[b].value[0], mix);
  out.y = lerp(keys[a].value[1], keys[b].value[1], mix);

  return out;
};

/**
 * Texture cell index. Floored rather than interpolated: a blended cell index would sample a
 * meaningless sub-rect between two frames of the flipbook, and real clients hold the lower
 * bracketing frame for the whole interval rather than switching early at the midpoint.
 */
export const evaluateFBlockCell = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 0;
  }

  const { a } = bracket(keys, t);

  return keys[a].value;
};

/**
 * Evaluate an AnimationBlock at a time in milliseconds.
 *
 * Falls back to animation 0 when the requested animation has no sub-track, and to `fallback` when the
 * block holds nothing at all -- emitters routinely leave inputs unanimated, and the caller knows the
 * right constant far better than this function does.
 */
export const evaluateAnimationTrack = (
  block: { tracks?: Array<{ animationIndex: number; timestamps: number[]; values: number[] }> } | undefined,
  animationIndex: number,
  timeMs: number,
  fallback: number,
): number => {
  const tracks = block && block.tracks;
  if (!tracks || tracks.length === 0) {
    return fallback;
  }

  const track = tracks.find((candidate) => candidate.animationIndex === animationIndex) || tracks[0];

  const { timestamps, values } = track;
  if (!timestamps || !values || values.length === 0) {
    return fallback;
  }

  if (values.length === 1 || timeMs <= timestamps[0]) {
    return values[0];
  }

  const last = values.length - 1;
  if (timeMs >= timestamps[last]) {
    return values[last];
  }

  let b = 1;
  while (b < last && timestamps[b] < timeMs) {
    b++;
  }

  const a = b - 1;
  const span = timestamps[b] - timestamps[a];

  return lerp(values[a], values[b], span > 0 ? (timeMs - timestamps[a]) / span : 0);
};

/**
 * Evaluate an AnimationBlock at a time in milliseconds, without interpolation.
 *
 * Some AnimationBlocks are flags rather than continuous quantities -- `enabledIn` is an
 * `AnimationBlock(uint8)` holding only 0 or 1 -- and lerping between an ON key and an OFF key
 * would yield 0.5, a value the flag was never meant to take. This holds the lower bracketing
 * key's value for the whole interval instead, matching how a boolean gate actually behaves.
 *
 * Bracketing and clamping are identical to `evaluateAnimationTrack`; only the interpolation step
 * differs.
 */
export const evaluateAnimationTrackStep = (
  block: { tracks?: Array<{ animationIndex: number; timestamps: number[]; values: number[] }> } | undefined,
  animationIndex: number,
  timeMs: number,
  fallback: number,
): number => {
  const tracks = block && block.tracks;
  if (!tracks || tracks.length === 0) {
    return fallback;
  }

  const track = tracks.find((candidate) => candidate.animationIndex === animationIndex) || tracks[0];

  const { timestamps, values } = track;
  if (!timestamps || !values || values.length === 0) {
    return fallback;
  }

  if (values.length === 1 || timeMs <= timestamps[0]) {
    return values[0];
  }

  const last = values.length - 1;
  if (timeMs >= timestamps[last]) {
    return values[last];
  }

  let b = 1;
  while (b < last && timestamps[b] < timeMs) {
    b++;
  }

  const a = b - 1;

  return values[a];
};
