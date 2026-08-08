/**
 * Floor (yd) on the world pivot height -- VERIFIED 5/6 (`0x50e570`'s `max(hi, target)` lower bound).
 */
export const CAM_PIVOT_FLOOR = 5 / 6;

/**
 * Pivot height used before the avatar model has attached: a human's approximate neck height, so the
 * first frames of third-person do not ride high. Replaced by the exact model-derived value the
 * moment the body attaches.
 */
export const CAM_PIVOT_FALLBACK = 1.8;

/**
 * World head height above a modeled unit's feet.
 *
 * The camera framing pivot -- the point the boom looks at and seats behind, and the first-person eye
 * at zoom 0 -- sits at `feet + H`, where H is MODEL-DERIVED rather than a fixed height: VERIFIED
 * `H = (attach17.z + 0.0972) * scale` from M2 attachment id 17 (`0x50cbc0`). That is about neck
 * height on every character -- roughly 1.90 for a human, 0.88 for a gnome -- with a
 * `0.9 * vertex-box` fallback for models lacking the attachment.
 *
 * A fixed height rides high on short races, which is the whole reason this is not a constant.
 *
 * `pivotLocal` is the per-model pre-scale height, or null before the body has attached.
 *
 * NOTE: M2 attachments are currently parsed as a bare offset/count with no struct, so attachment 17
 * is not yet reachable and callers pass the bounding-box fallback. That is a follow-up; this
 * function is already the single place both the third-person pivot and the audio listener would
 * read, so it does not have to change when the parser does.
 */
export function headHeight(pivotLocal: number | null, scale: number): number {
  if (pivotLocal === null) {
    return CAM_PIVOT_FALLBACK;
  }

  return Math.max(pivotLocal * scale, CAM_PIVOT_FLOOR);
}
