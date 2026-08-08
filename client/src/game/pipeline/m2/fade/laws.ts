/**
 * The faithful 1.12 world-doodad distance fade, ported from samples/benilla
 * `crates/benilla/src/model_fade.rs` (`doodad_fade_alpha`), which cites `FUN_00683f80` in
 * `WoW.exe` 5875 with verified operand bytes:
 *
 *   radius cutoffs  0x810188 = 0.5,  0x81018c = 2.5,  0x810190 = 7.0
 *   band ends       0x8101a0 = 50,   0x8101a4 = 125,  0x8101a8 = 200
 *   band ranges     0x810194 = 10,   0x810198 = 25,   0x81019c = 50
 *
 * The band is selected PURELY by the doodad's bounding-sphere radius -- big things stay, small
 * props fade near. Do not substitute a distance-only scheme; the size split is the mechanism.
 */

/** Radius above which a doodad never distance-fades (trees, buildings). Strictly greater. */
export const NEVER_FADE_RADIUS = 7.0;

/**
 * `(max_radius, band_start_yd, band_range_yd)`, ordered small to large. A doodad takes the first
 * bucket whose `max_radius` it does not exceed.
 */
export const FADE_BUCKETS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 40, 10],                 // <= 0.5 yd -> 40..50    fences, hay, pumpkins
  [2.5, 100, 25],                // <= 2.5 yd -> 100..125  mid props
  [NEVER_FADE_RADIUS, 150, 50],  // <= 7.0 yd -> 150..200  large props
];

/**
 * Per-object fade alpha for a doodad whose world bounding-sphere radius is `radius` yd (already
 * multiplied by the placement scale) and whose centre is `horizDist` yd from the camera **in the
 * horizontal plane** -- the reference ignores vertical offset.
 *
 *  - `1`         fully opaque; draw normally.
 *  - `0`         fully faded; the caller must CULL the object, not draw it transparent.
 *  - `0 < a < 1` feathering; draw blended so the fade reads as a gradient rather than a pop.
 */
export function doodadFadeAlpha(radius: number, horizDist: number): number {
  if (radius > NEVER_FADE_RADIUS) {
    return 1;
  }

  // Distance to the sphere's surface, not its centre: a bigger object therefore begins fading at a
  // greater centre distance.
  const d = horizDist - radius;

  let start = 150;
  let range = 50;
  for (const [maxRadius, bucketStart, bucketRange] of FADE_BUCKETS) {
    if (radius <= maxRadius) {
      start = bucketStart;
      range = bucketRange;
      break;
    }
  }

  const alpha = 1 - (d - start) / range;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}
