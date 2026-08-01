/**
 * Pure lighting laws, ported from `samples/benilla` (a from-scratch WoW 1.12.1 client whose lighting
 * is derived from WoW.exe 5875 disassembly and apitrace captures).
 *
 * This module imports NOTHING -- no three.js, no project modules. That is deliberate: it keeps the
 * maths testable under jest's `node` environment and reusable from a worker. Callers convert to and
 * from THREE types at the boundary.
 *
 * Every constant here is traceable to a named function or table in the reference; the citations in
 * comments are the reference's own module paths.
 */

export type RGB = [number, number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** One directional lobe: a toward-light direction (need not be normalized) and its colour. */
export type Lobe = { dir: Vec3; color: RGB };

/**
 * Seven rows of order-2 SH coefficients, laid out to match the shader's evaluation basis:
 *   rows 0-2  per channel: xyz = the linear band, w = the DC term
 *   rows 3-5  per channel: the quadratic band over (n.xy, n.yz, n.z^2, n.xz)
 *   row  6    xyz = the per-channel (n.x^2 - n.y^2) coefficient; w is unused padding
 */
export type ProbeCoeffs = Vec4[];

/** The reference's accumulate scale: 16*pi/17 on the standard real-SH basis reduces to this. */
const K = 4 / 17;

/**
 * Fold ambient plus any number of directional lobes into a 7-row order-2 SH probe.
 *
 * This is the closed form of the shipped `Model2.bls` vertex program's lighting block
 * (benilla `lighting/sh.rs::prop_probe_coeffs`). Per lobe, with colour C and toward-light unit u:
 *
 *   DC     += C * (4/17) * (0.375 + 0.9375 * (ux^2 + uy^2))
 *   linear += C * (8/17) * u
 *   n.xy   += C * (15/17) * ux*uy            (n.yz and n.xz alike)
 *   n.z^2  += C * (7.5/17) * (uz^2 - 0.5 * (ux^2 + uy^2))
 *   x2y2   += C * (7.5/34) * (ux^2 - uy^2)
 *
 * The band ratios are exactly 1 : 2/3 : 1/4 and the linear coefficient exactly 8/17, which together
 * make the response peak at exactly 1.0 * C when mu = n.u = 1. Side-on leaves 0.0882 * C and fully
 * away 0.0588 * C -- an authored soft wrap, deliberately NOT a hard max(N.L, 0).
 */
export function propProbeCoeffs(ambient: RGB, lobes: Lobe[]): ProbeCoeffs {
  const c: ProbeCoeffs = [];
  for (let row = 0; row < 7; ++row) {
    c.push([0, 0, 0, 0]);
  }

  // Ambient rides the DC lane at weight 1.
  for (let ch = 0; ch < 3; ++ch) {
    c[ch][3] = ambient[ch];
  }
  // Mirrors the reference's row-6 w. Unused by the evaluation; kept so a packed row is bit-comparable.
  c[6][3] = 1;

  for (const lobe of lobes) {
    const len = Math.hypot(lobe.dir[0], lobe.dir[1], lobe.dir[2]);
    if (len === 0) {
      continue;
    }
    const ux = lobe.dir[0] / len;
    const uy = lobe.dir[1] / len;
    const uz = lobe.dir[2] / len;

    const horiz = ux * ux + uy * uy;
    const dc = K * (0.375 + 0.9375 * horiz);
    const z2 = 1.875 * K * (uz * uz - 0.5 * horiz);
    const x2y2 = 0.9375 * K * (ux * ux - uy * uy);

    for (let ch = 0; ch < 3; ++ch) {
      const s = lobe.color[ch];

      c[ch][0] += 2 * K * s * ux;
      c[ch][1] += 2 * K * s * uy;
      c[ch][2] += 2 * K * s * uz;
      c[ch][3] += s * dc;

      c[3 + ch][0] += 3.75 * K * s * ux * uy;
      c[3 + ch][1] += 3.75 * K * s * uy * uz;
      c[3 + ch][2] += s * z2;
      c[3 + ch][3] += 3.75 * K * s * ux * uz;

      c[6][ch] += s * x2y2;
    }
  }

  return c;
}

/**
 * Evaluate a probe at a surface normal. This mirrors the shader's basis exactly and exists so the
 * tests and the GLSL cannot drift apart: if you change one, this is the thing that fails.
 *
 * The result is NOT clamped -- the caller clamps the whole light sum, never a term, because the SH
 * response legitimately dips slightly negative around mu = -0.53 and that dip is part of the
 * authored response.
 */
export function evalProbe(coeffs: ProbeCoeffs, normal: Vec3): RGB {
  const [x, y, z] = normal;
  const n1: Vec4 = [x, y, z, 1];
  const quad: Vec4 = [x * y, y * z, z * z, x * z];
  const x2y2 = x * x - y * y;

  const dot4 = (a: Vec4, b: Vec4) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  const out: RGB = [0, 0, 0];
  for (let ch = 0; ch < 3; ++ch) {
    out[ch] = dot4(coeffs[ch], n1) + dot4(coeffs[3 + ch], quad) + coeffs[6][ch] * x2y2;
  }
  return out;
}

/**
 * Round half to even ("banker's rounding"), which is what Rust's `round_ties_even` and the
 * reference's float-to-int conversion do. JS `Math.round` rounds halves UP, and the two disagree on
 * exactly one input that matters here: a MODD colour whose max channel is 160 makes the cap scale
 * land on 152.5, where this gives 152 and `Math.round` gives 153.
 */
function roundTiesEven(value: number): number {
  const rounded = Math.round(value);
  const isTie = Math.abs(value % 1) === 0.5;
  return isTie && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

/**
 * The AMBIENT-word cap of the reference's colour splitter (benilla `benilla-assets/src/wmo.rs::cap96`,
 * from `0x6a77e0`): a colour whose max channel exceeds 96 is scaled down so the max lands on 96, hue
 * and saturation preserved. Input is 0..255 bytes; output is normalized 0..1.
 *
 * The arithmetic is integer on purpose -- an 8.8 fixed-point scale and a `>> 8` recombine. Doing it in
 * floats drifts by a byte on some inputs.
 */
export function cap96(bytes: Vec3): RGB {
  const max = Math.max(bytes[0], bytes[1], bytes[2]);
  if (max <= 96) {
    return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
  }
  const scale = roundTiesEven((96 * 255) / max - 0.5);
  return [
    ((bytes[0] * scale + 255) >> 8) / 255,
    ((bytes[1] * scale + 255) >> 8) / 255,
    ((bytes[2] * scale + 255) >> 8) / 255,
  ];
}

/**
 * The DIFFUSE-word FLOOR of the same splitter (benilla `wmo.rs::floor_raise`): a colour whose max
 * channel falls BELOW `threshold` is raised so the max lands exactly on it, hue preserved -- and the
 * per-channel scale TRUNCATES.
 *
 * Truncation is load-bearing, not incidental: the reference's decoded abbey benches need
 * 63 * 168 / 83 = 127.52 to land on 127, which truncation gives and nearest-rounding does not.
 */
function floorRaise(bytes: Vec3, threshold: number): RGB {
  const max = Math.max(bytes[0], bytes[1], bytes[2]);
  if (max >= threshold || max === 0) {
    return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
  }
  return [
    Math.floor((bytes[0] * threshold) / max) / 255,
    Math.floor((bytes[1] * threshold) / max) / 255,
    Math.floor((bytes[2] * threshold) / max) / 255,
  ];
}

/** [`floorRaise`] at the MODD create site's threshold 112 -- the interior-prop diffuse word. */
export function floor112(bytes: Vec3): RGB {
  return floorRaise(bytes, 112);
}

/**
 * [`floorRaise`] at the entity/footprint attach site's threshold 168 -- the GameObject M2 lane.
 * Unused by this plan; ported alongside its twin because they are one law with two thresholds and
 * splitting them across plans would invite a divergent second implementation.
 */
export function floor168(bytes: Vec3): RGB {
  return floorRaise(bytes, 168);
}

/**
 * Vanilla `DayNight::InterpTable` -- wrap-around linear interpolation of a (dayFraction, value) table
 * over [0, 1) (benilla `lighting/daynight.rs::interp_daynight`). Both of the client's return branches
 * reduce to a plain lerp, so this is one.
 *
 * Wrapping matters: several of these tables have their first keyframe well after midnight, and the
 * value at 00:30 comes from interpolating the LAST key forward into the first.
 */
export function interpDayNight(table: Array<[number, number]>, dayFraction: number): number {
  const n = table.length;
  if (n === 0) {
    return 0;
  }

  let ahead = 0;
  while (ahead < n && dayFraction > table[ahead][0]) {
    ahead += 1;
  }

  // Off either end of the table means we are in the wrap span between its last and first keys.
  let a: number;
  let b: number;
  if (ahead === n || ahead === 0) {
    a = ahead === n ? 0 : ahead;
    b = n - 1;
  } else {
    a = ahead;
    b = ahead - 1;
  }

  let span = table[a][0] - table[b][0];
  if (span < 0) {
    span += 1;
  }
  let into = dayFraction - table[b][0];
  if (into < 0) {
    into += 1;
  }

  const t = span !== 0 ? into / span : 0;
  return table[b][1] + t * (table[a][1] - table[b][1]);
}

/**
 * The SIDN self-illumination night schedule (benilla `daynight.rs::SIDN_NIGHT_CURVE`, track
 * `0xce9a34`): 1.0 overnight, 0.0 all day, linear ramps 20:30 -> 21:30 and 06:00 -> 07:00. Every WMO
 * SIDN material's authored emissive colour is multiplied by this, which is the windows-glow-at-night
 * ramp.
 */
const SIDN_NIGHT_CURVE: Array<[number, number]> = [
  [0.25, 1.0], // 06:00 -- still full night glow
  [0.2916667, 0.0], // 07:00 -- faded out for the day
  [0.8541667, 0.0], // 20:30 -- starts ramping in
  [0.8958333, 1.0], // 21:30 -- full glow (wraps forward to 06:00 holding 1.0)
];

/** The SIDN night fraction at a game minute-of-day (0..1439). See [`SIDN_NIGHT_CURVE`]. */
export function sidnNightFraction(minute: number): number {
  return interpDayNight(SIDN_NIGHT_CURVE, minute / 1440);
}

/**
 * The cloud sun-glow envelope (benilla `daynight.rs::cloud_glow_track`, the internal static 8-key
 * track at `0xce9ab8`, built once by `0x6ce390` from constants -- NOT a Light.dbc band). ~1.0 across
 * the full day, notching to 0 at the twilight boundaries.
 *
 * The key array is stored NON-MONOTONIC ON PURPOSE: keys 6 and 7 sit before key 5 in time. Do NOT
 * sort this table. The array-order scan in [`interpDayNight`] advances past every key strictly less
 * than the query and stops at the first one that isn't, so once the scan has passed key 4 (21:30) and
 * key 5 (22:10, the dusk notch), keys 6 and 7 are behind the cursor and can never be selected again
 * that lap -- they are structurally unreachable, not merely small. A query just past 22:10 therefore
 * runs off the end of the array (`ahead === n`) and wraps to interpolate from key 5 (0.0) forward to
 * key 0 (1.0, 04:00) -- the seam that snaps deep night back to full glow. That wrap is byte-verified
 * in the reference; only the *intent* behind storing unreachable keys is flagged INFERRED there.
 */
const CLOUD_GLOW_CURVE: Array<[number, number]> = [
  [0.16667, 1.0], // 04:00 -- full
  [0.19444, 0.0], // 04:40 -- dawn notch
  [0.20139, 0.0], // 04:50
  [0.22917, 1.0], // 05:30 -- full through the day
  [0.89583, 1.0], // 21:30
  [0.92361, 0.0], // 22:10 -- dusk notch
  [0.88889, 0.0], // structurally unreachable -- stored order kept, see the doc comment above
  [0.91667, 1.0], // ditto; this is the seam the >22:10 wrap lands on
];

/** The cloud glow envelope at a game minute-of-day. See [`CLOUD_GLOW_CURVE`]. */
export function cloudGlowTrack(minute: number): number {
  return interpDayNight(CLOUD_GLOW_CURVE, minute / 1440);
}

/**
 * The cloud glow's body pick (benilla `daynight.rs::cloud_glow_is_sun`, `0x6cfb00` setup): the SUN
 * drives the glow while the day fraction sits in `[0.2013889, 0.9236111]` (~04:50-22:10), the MOON
 * otherwise. Both bounds are inclusive, matching the reference's `RangeInclusive::contains`.
 */
export function cloudGlowIsSun(minute: number): boolean {
  const dp = minute / 1440;
  return dp >= 0.2013889 && dp <= 0.9236111;
}

/**
 * The visible WHITE moon direction (benilla `daynight.rs::moon_direction`, elevation table
 * `0xce8d24`, VERIFIED off `0x6d3b80`): polar angle from the up axis sweeps 35 degrees (overhead at
 * midnight) to 100 degrees (parked below the horizon 04:00 through 22:00), azimuth a constant 45
 * degrees -- the sun's own bearing (table `0xce8d0c`).
 *
 * Frame: this client keeps the WoW spherical formula in WoW's OWN frame, unpermuted -- established
 * from `MapLight#updateSunDirection`, which builds `x = sinPhi*cosTheta, y = sinPhi*sinTheta,
 * z = cosPhi` straight from `SUN_PHI_TABLE`/`SUN_THETA_TABLE` with no axis swap and no Y-up
 * conversion (the reference is Bevy/+Y-up and applies `wow_to_bevy`; this client never does that
 * permutation for the sun, so the moon must match it, not the reference's raw numbers). This returns
 * the to-moon direction in that same frame: `z = cosPhi > 0` is above the WoW-frame horizon (z-up),
 * matching `MapLight`'s existing convention where `z = cosPhi` is negative for the sun's downward
 * travel direction while the sun itself sits above the horizon.
 */
export function moonDirection(minute: number): Vec3 {
  const ELEV_TABLE: Array<[number, number]> = [
    [0.0, Math.PI * 0.194444], // 35 deg -- midnight (overhead)
    [0.003472, Math.PI * 0.194444], // 35 deg
    [0.166667, Math.PI * 0.555556], // 100 deg -- 04:00 (sets below the horizon)
    [0.916667, Math.PI * 0.555556], // 100 deg -- 22:00 (still below the horizon)
    [0.996528, Math.PI * 0.194444], // 35 deg -- risen again before midnight
  ];
  const THETA = Math.PI * 0.25; // 45 deg, constant -- shares the sun's bearing

  const phi = interpDayNight(ELEV_TABLE, minute / 1440);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  return [sinPhi * Math.cos(THETA), sinPhi * Math.sin(THETA), cosPhi];
}

/**
 * The visible CELESTIAL sun direction (benilla `daynight.rs::celestial_sun_direction`, elevation
 * table `0xce8d64`, VERIFIED off `0x6d3b80`) -- the sky BODY the player sees rise and set, a
 * SEPARATE system from `MapLight#sunDir` (the near-fixed lighting/shadow sun, `SUN_PHI_TABLE`/
 * `SUN_THETA_TABLE`, elevation only ~20-37 degrees all day, never near the horizon). Confusing the
 * two is the celestial-sky plan's own Risk: `MapLight.cloudGlowDir` (the negated lighting sun) is
 * NOT this -- it shares the lighting sun's narrow elevation band and would place the sun disc far
 * too high, never touching the horizon and defeating both the 2x horizon-size curve and the
 * horizon clip+fade. The polar angle sweeps 100 degrees (10 below the horizon, parked there all
 * night) to 5 degrees (near zenith, solar noon); azimuth is a constant 45 degrees, the lighting
 * sun's own bearing, so the bright disc sits in the lit direction.
 *
 * Returns the to-sun direction (camera->body) in this client's unpermuted WoW frame (Z up),
 * matching `moonDirection`'s own convention: `z = cosPhi > 0` is above the horizon.
 */
export function celestialSunDirection(minute: number): Vec3 {
  const ELEV_TABLE: Array<[number, number]> = [
    [0.2291667, Math.PI * 0.555556], // 100 deg -- near horizon, dawn/sunrise
    [0.4965278, Math.PI * 0.027778], // 5 deg -- near zenith, rising into noon
    [0.5, Math.PI * 0.027778], // 5 deg -- solar noon
    [0.5034722, Math.PI * 0.027778], // 5 deg -- near zenith, falling out of noon
    [0.8958333, Math.PI * 0.555556], // 100 deg -- near horizon, dusk/sunset
  ];
  const THETA = Math.PI * 0.25; // 45 deg, constant -- the to-sun azimuth (shares the lighting sun's bearing)

  const phi = interpDayNight(ELEV_TABLE, minute / 1440);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  return [sinPhi * Math.cos(THETA), sinPhi * Math.sin(THETA), cosPhi];
}

/**
 * Sun-disc size-multiplier curve (benilla `daynight.rs::SUN_SIZE_CURVE`, vanilla size table
 * `0xce8cac`, VERIFIED): the disc grows to 2x at the dawn/dusk horizon (06:00 / 21:00) and is 1x
 * across midday -- the baked "huge sun at the horizon". The sun's own base multiplier is 1x, so
 * this curve IS its disc scale.
 */
const SUN_SIZE_CURVE: Array<[number, number]> = [
  [0.25, 2.0], // 06:00 -- sunrise at the horizon (largest)
  [0.28125, 1.0], // 06:45 -- risen -> the midday plateau
  [0.84375, 1.0], // 20:15 -- still small
  [0.875, 2.0], // 21:00 -- sunset at the horizon (largest)
];

/** The sun disc's size multiplier at a game minute-of-day: 1.0 midday, up to 2.0 at the dawn/dusk
 * horizon. See [`SUN_SIZE_CURVE`]. */
export function sunDiscScale(minute: number): number {
  return interpDayNight(SUN_SIZE_CURVE, minute / 1440);
}

/**
 * Star-field global-alpha curve (celestial-sky plan, Task 3; benilla `daynight.rs::STAR_CURVE`,
 * vanilla star curve `0xce9a98`, VERIFIED off `WoW.exe`): the `Stars.m2` model-global alpha
 * (`[stars+0xb]/255`) fades on this exact schedule -- full all deep night, off all day, fading in
 * 22:30->00:00 and out 03:00->04:30. This is the raw 0..1 curve; [`starGlobalAlpha`] applies the
 * reference's own byte quantization + skip-below-2 rule on top.
 */
const STAR_CURVE: Array<[number, number]> = [
  [0.0, 1.0], // 00:00 -- full (deep night)
  [0.125, 1.0], // 03:00 -- still full
  [0.1875, 0.0], // 04:30 -- fully out
  [0.9375, 0.0], // 22:30 -- start fading in (wraps forward to 00:00)
];

/** The raw star curve at a game minute-of-day: 1.0 deep night, 0.0 all day. See [`STAR_CURVE`]. */
export function starAlpha(minute: number): number {
  return interpDayNight(STAR_CURVE, minute / 1440);
}

/**
 * The star dome's actual per-frame global alpha (benilla `sun/follow.rs::follow_stars`): the
 * reference quantizes [`starAlpha`] to a model-global BYTE (`trunc(curve*254 + 1)`) and skips the
 * draw entirely once that byte falls below 2 (`0x6d1b50`/`0x7e6120`) -- so the curve's own near-zero
 * tail (just above/below the fade boundary) reads as exactly off, matching the reference's byte
 * quantization rather than a smooth float tail past it. Each star patch then multiplies its own
 * authored transparency weight under this.
 */
export function starGlobalAlpha(minute: number): number {
  const curve = starAlpha(minute);
  const byte = Math.trunc(curve * 254 + 1);
  return byte < 2 ? 0 : byte / 255;
}

/**
 * Sun lens-flare day/night envelope curve (celestial-sky plan, Task 5; benilla
 * `daynight.rs::SUN_FLARE_DN_CURVE`, the per-body inline 4-key dnCurve table at `[glare+0x70]`,
 * sun `0xce9818`, VERIFIED -- Addendum #5, decision 0508): a factor of the sun glare's flare-intensity
 * slew target -- the flare exists only by day, 0 until 06:30, full 07:30->19:30, gone by 21:00. Dusk
 * (21:00->22:45) and dawn (03:15->06:30) are flare dead-bands for BOTH bodies.
 */
const SUN_FLARE_DN_CURVE: Array<[number, number]> = [
  [0.2708333, 0.0], // 06:30 -- still off
  [0.3125, 1.0], // 07:30 -- full day flare
  [0.8125, 1.0], // 19:30 -- still full
  [0.875, 0.0], // 21:00 -- off before the sun sets
];

/** The sun glare's flare dnCurve at a game minute-of-day. See [`SUN_FLARE_DN_CURVE`]. */
export function sunFlareDn(minute: number): number {
  return interpDayNight(SUN_FLARE_DN_CURVE, minute / 1440);
}

/**
 * Moon lens-flare night envelope curve (celestial-sky plan, Task 5; benilla
 * `daynight.rs::MOON_FLARE_DN_CURVE`, moon dnCurve table `0xce9768`, VERIFIED -- Addendum #5,
 * decision 0508): flat ZERO from 03:15 to 22:45 -- the whole day *and* early evening -- ramping in
 * 22:45->24:00 (23:00 ~ 0.20, 23:30 ~ 0.61), full 00:00->02:00, out by 03:15. A 22:30 moonrise has
 * NO halo; it first lights at 22:45 and peaks near midnight.
 */
const MOON_FLARE_DN_CURVE: Array<[number, number]> = [
  [0.0833333, 1.0], // 02:00 -- still full
  [0.1354167, 0.0], // 03:15 -- out
  [0.9479167, 0.0], // 22:45 -- first light
  [0.999306, 1.0], // ~23:59 -- full (the wrap to 02:00 holds 1.0 across midnight)
];

/** The moon glare's flare dnCurve at a game minute-of-day. See [`MOON_FLARE_DN_CURVE`]. */
export function moonFlareDn(minute: number): number {
  return interpDayNight(MOON_FLARE_DN_CURVE, minute / 1440);
}

/**
 * Moon-disc size-multiplier curve (benilla `daynight.rs::MOON_SIZE_CURVE`, shared table `0xce8c8c`,
 * VERIFIED): 1.5x at moonrise/moonset (the horizon, ~22:00 / ~04:00) shrinking to 1.0x overhead
 * (~01:00) -- the same horizon-enlargement the sun disc gets. BOTH moon discs (white and moon02)
 * sample this same curve; only their own base multiplier differs (white x1.75, moon02 x1.0) and, for
 * moon02, which phase fraction it is sampled at (see [`moon02State`]).
 */
const MOON_SIZE_CURVE: Array<[number, number]> = [
  [0.041667, 1.0], // 01:00 -- overhead (smallest)
  [0.166667, 1.5], // 04:00 -- moonset horizon
  [0.916667, 1.5], // 22:00 -- moonrise horizon
  [0.999306, 1.0], // 23:59 -- wraps toward 01:00 (overhead)
];

/** The moon disc's size multiplier at a game minute-of-day: 1.0 overhead (~01:00) to 1.5 at
 * moonrise/moonset. Multiply by the per-disc base (white x1.75, moon02 x1.0). See
 * [`MOON_SIZE_CURVE`]. */
export function moonDiscScale(minute: number): number {
  return interpDayNight(MOON_SIZE_CURVE, minute / 1440);
}

/**
 * moon02 -- the engine's third disc (`moon02.blp`) -- direction + size scale (benilla
 * `daynight.rs::moon02_state`, VERIFIED): drawn every frame but vertex-BLACK, its colour field
 * (`[0xce98a4]`) has no writer in the binary, so it can never read as a second moon (see this
 * module's own header / the celestial-sky plan's Task 4). Ported anyway because it is in the
 * reference's draw order and omitting it silently changes what is on screen.
 *
 * Its tracks run on a phase-precessed clock separate from the game clock:
 * `phase = fmod(dayCounter + todPhase, 1.7)` (`0x6d41b9`, `dayContinuous` = that server-synced sum in
 * this client's stand-in, continuous whole+fractional days), which the track kernel (`0x6cf6c0`)
 * clamps to `[0, 1]` -- so across the whole `[1.0, 1.7)` leg BOTH tracks park frozen on their `r=1`
 * value (azimuth 165 degrees, polar 35 degrees = elevation +55 degrees). Azimuth sweeps 135 -> 150 ->
 * 165 degrees (table `0xce8ccc`); elevation shares the white moon's own curve shape (35 <-> 100
 * degrees, table `0xce8ce4`); size samples [`MOON_SIZE_CURVE`] on the SAME phase, base x1.0.
 *
 * Returns the to-body direction in this client's unpermuted WoW frame (Z up, matching
 * [`moonDirection`]'s own convention) and the size-curve multiplier (before the x1.0 base, which is
 * folded in by the caller alongside the disc's own alpha-0 gate).
 */
export function moon02State(dayContinuous: number): { dir: Vec3; sizeScale: number } {
  const AZ_TABLE: Array<[number, number]> = [
    [0.0, Math.PI * 0.75], // 135 deg
    [0.166667, Math.PI * 0.833333], // 150 deg
    [0.916667, Math.PI * 0.916667], // 165 deg
  ];
  const ELEV_TABLE: Array<[number, number]> = [
    [0.0, Math.PI * 0.194444], // 35 deg -- phase 0 (overhead, +55 deg)
    [0.003472, Math.PI * 0.194444], // 35 deg
    [0.166667, Math.PI * 0.555556], // 100 deg -- below the horizon (clipped away)
    [0.916667, Math.PI * 0.555556], // 100 deg
    [0.996528, Math.PI * 0.194444], // 35 deg
  ];

  // The kernel clamp: fmod into [0, 1.7), then anything past 1.0 evaluates AT 1.0 (`0x6cf6c0`).
  const wrapped = dayContinuous - Math.floor(dayContinuous / 1.7) * 1.7;
  const phase = Math.min(wrapped, 1.0);

  const theta = interpDayNight(AZ_TABLE, phase);
  const phi = interpDayNight(ELEV_TABLE, phase);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  return {
    dir: [sinPhi * Math.cos(theta), sinPhi * Math.sin(theta), cosPhi],
    sizeScale: interpDayNight(MOON_SIZE_CURVE, phase),
  };
}

/**
 * The dawn/dusk sky-dome warp strength curve (benilla `daynight.rs::SKY_WARP_CURVE`, table
 * `0xce9b2c`): two triangular spikes at sunrise (~06:29) and sunset (~21:29), and zero everywhere
 * else -- all of midday AND deep night.
 */
const SKY_WARP_CURVE: Array<[number, number]> = [
  [0.125, 0.0], // 03:00
  [0.2708, 1.0], // 06:29 -- dawn spike
  [0.2917, 0.0], // 07:00
  [0.8542, 0.0], // 20:30
  [0.8958, 1.0], // 21:29 -- dusk spike
  [0.9993, 0.0], // 23:59
];

/** The raw dawn/dusk warp curve at a game minute-of-day. See [`SKY_WARP_CURVE`]. */
export function dawnDuskCurve(minute: number): number {
  return interpDayNight(SKY_WARP_CURVE, minute / 1440);
}

/**
 * Sky-dome warp strength `S` = curve x the zone's `highlightSky` flag. Zero across midday and night,
 * and zero at EVERY hour in a highlightSky = 0 zone (Duskwood), so the warp is identity there. At
 * S = 0 the daytime sky stays byte-faithful.
 */
export function skyWarp(minute: number, highlightSky: number): number {
  return dawnDuskCurve(minute) * highlightSky;
}

/**
 * Quantize a raw `LightParams.glow` to the byte the reference packs into its composite-quad colour:
 * `floor(g * 255) / 255`. Elwynn's authored 0.65 becomes 0.647.
 */
export function quantizeGlow(glow: number): number {
  return Math.floor(glow * 255) / 255;
}

/**
 * Sun-relative azimuth phase -> glow factor `g` for the sky dome's dawn/dusk azimuthal warp (benilla
 * `sky.wgsl::azimuth_glow`, table `0xce9af8` off writer `FUN_006d0f50`/`FUN_006ce210`). Six wrap-around
 * keyframes, piecewise-linear, symmetric about phase 0.625.
 *
 * `g = +1.0` at phase 0.125 is the IDENTITY case (see [`warpSkyRingColor`]) and that phase is where the
 * SUN bearing lands, so the sun side is the bright, unwarped stop. `g` troughs at -0.7 (phase 0.625),
 * the anti-sun side, which pulls the ring toward the dark zenith.
 */
export function skyWarpAzimuthGlow(phase: number): number {
  const p = phase - Math.floor(phase);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  if (p < 0.125) {
    return mix(0.0, 1.0, (p + 0.125) / 0.25); // wraps 0.875 -> 1.125
  }
  if (p < 0.375) {
    return mix(1.0, 0.0, (p - 0.125) / 0.25);
  }
  if (p < 0.5) {
    return mix(0.0, -0.5, (p - 0.375) / 0.125);
  }
  if (p < 0.625) {
    return mix(-0.5, -0.7, (p - 0.5) / 0.125);
  }
  if (p < 0.75) {
    return mix(-0.7, -0.5, (p - 0.625) / 0.125);
  }
  if (p < 0.875) {
    return mix(-0.5, 0.0, (p - 0.75) / 0.125);
  }
  return mix(0.0, 1.0, (p - 0.875) / 0.25); // wraps 0.875 -> 1.125
}

const mixRGB = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * One mid sky-ring's warped colour for a single glow factor `g` and warp strength `s`
 * (benilla `sky.wgsl::warp_one`, `FUN_006d0f50`, dusk-capture reconciled).
 *
 * `g >= 0` (sun-facing half): desaturate toward `warm` (the first authored stop below the zenith) by
 * `(1 - g) * s^2` -- at `g = 1` (the sun's own bearing) this is exactly identity, which is why the
 * sunset glow reads as the unwarped stop rather than something brightened.
 *
 * `g < 0` (anti-sun half): a prepass toward `warm` by `s`, then toward `dark` (the zenith stop) by
 * `0.7 * -g * s^2` -- the darkest, most desaturated point of the ring. `0.7` is the reference's own
 * constant (binary `0x7ffd7c`).
 *
 * At `s = 0` this returns `base` unchanged for every `g` -- the identity case Task 4's brief calls out
 * by name, verified directly in `laws.test.ts` rather than only by eyeballing the dome.
 */
export function warpSkyRingColor(base: RGB, warm: RGB, dark: RGB, g: number, s: number): RGB {
  const s2 = s * s;
  if (g >= 0) {
    return mixRGB(base, warm, (1 - g) * s2);
  }
  const prepass = mixRGB(base, warm, s);
  return mixRGB(prepass, dark, 0.7 * -g * s2);
}

/**
 * The full per-fragment azimuthal warp (benilla `sky.wgsl`'s fragment body): quantizes the fragment's
 * sun-relative bearing to the reference's 24 azimuth segments (matching the binary's per-vertex dome,
 * which bakes the warp at 24 segments and Gouraud-interpolates between them) and lerps between the two
 * bracketing segments' warped colours.
 *
 * `fragAzimuth`/`sunAzimuth` are both `atan2`-style bearings in radians, in the SAME horizontal plane
 * convention the caller uses for both (this client is Z-up, so that means `atan2(y, x)`; benilla is
 * Y-up and uses `atan2(z, x)` -- the maths here is convention-agnostic, only the caller's inputs commit
 * to one).
 *
 * `s <= 0` short-circuits to `base` with no maths at all -- the S = 0 identity case, true for all of
 * midday and deep night and for every hour in a `highlightSky = 0` zone. This must never change the
 * daytime sky, which is why it is the first thing this function checks and the first thing
 * `laws.test.ts` asserts.
 */
export function applySkyAzimuthWarp(
  base: RGB,
  warm: RGB,
  dark: RGB,
  fragAzimuth: number,
  sunAzimuth: number,
  s: number,
): RGB {
  if (s <= 0) {
    return base;
  }

  const TAU = Math.PI * 2;
  let az = (fragAzimuth - sunAzimuth) / TAU + 0.125;
  az -= Math.floor(az);

  const seg = az * 24;
  const seg0 = Math.floor(seg);
  const f = seg - seg0;

  const g0 = skyWarpAzimuthGlow(seg0 / 24);
  const g1 = skyWarpAzimuthGlow((seg0 + 1) / 24);

  const c0 = warpSkyRingColor(base, warm, dark, g0, s);
  const c1 = warpSkyRingColor(base, warm, dark, g1, s);

  return mixRGB(c0, c1, f);
}

/**
 * The storm light blend `bcc = min(1, skyDensity * 4)` (benilla `weather`/`cloud_density_clamp
 * 0x6d4500`). The weather state machine's sky-density channel lives in the [0, 0.25] knee domain, so
 * a fully ramped storm gives exactly 1.0. This weight lerps the storm `LightParams` record over the
 * clear one across every band at once -- ambient, diffuse, sky stops, fog colour AND fog distances.
 */
export function stormBlend(skyDensity: number): number {
  return Math.min(1, Math.max(0, skyDensity * 4));
}

/**
 * The FIXED engine axis an interior prop's diffuse word is committed on -- never the day/night sun,
 * which is why an interior prop's light is day/night independent (benilla
 * `benilla-assets/src/wmo.rs`, the `0x6a77e0` create site).
 *
 * Expressed toward-light in the same WoW-space convention `SUN_PHI_TABLE` / `SUN_THETA_TABLE` produce
 * and the shaders consume unpermuted. VERIFY THIS IN A REAL INTERIOR before trusting it: the client's
 * world frame versus the WoW frame is only implicitly documented (`MapLight` permutes axes for light
 * positions but not for sun direction), so this constant is inferred from the sun's working
 * convention rather than measured. `foldInteriorProbe` takes the axis as an argument so a correction
 * here never touches the fold.
 */
export const INTERIOR_LIGHT_AXIS: Vec3 = [0.30822, 0.30822, 0.9];

/** One MOLR-referenced omni light as the interior fold consumes it. Colour is pre-multiplied by intensity. */
export type PropLobeLight = {
  position: Vec3;
  color: RGB;
  attenStart: number;
  attenEnd: number;
};

/**
 * Fold one interior prop's committed light into its 7-row SH probe: the ambient word, plus the
 * diffuse word as a directional on the fixed axis, plus each MOLR lobe gated by its own disk window
 * measured from `refPoint` (benilla `terrain_stream.rs::fold_interior_probe`, falloff `0x69e1c0`).
 *
 * The gate is: at or inside `attenStart` full gain; at or beyond `attenEnd` excluded entirely;
 * linear in between. A group with no MOLR lights means NO point light at all -- its own flame
 * included.
 *
 * Deliberately takes no time-of-day argument. An interior prop's light is filled once at create and
 * does not track the clock.
 */
export function foldInteriorProbe(
  ambient: RGB,
  diffuse: RGB,
  refPoint: Vec3,
  lights: PropLobeLight[],
  axis: Vec3 = INTERIOR_LIGHT_AXIS,
): ProbeCoeffs {
  const lobes: Lobe[] = [{ dir: axis, color: diffuse }];

  for (const light of lights) {
    const dx = light.position[0] - refPoint[0];
    const dy = light.position[1] - refPoint[1];
    const dz = light.position[2] - refPoint[2];
    const distance = Math.hypot(dx, dy, dz);

    let gain: number;
    if (distance <= light.attenStart) {
      gain = 1;
    } else if (distance >= light.attenEnd || light.attenEnd <= light.attenStart) {
      gain = 0;
    } else {
      gain = 1 - (distance - light.attenStart) / (light.attenEnd - light.attenStart);
    }
    if (gain <= 0) {
      continue;
    }

    const safe = Math.max(distance, 1e-4);
    lobes.push({
      dir: [dx / safe, dy / safe, dz / safe],
      color: [light.color[0] * gain, light.color[1] * gain, light.color[2] * gain],
    });
  }

  return propProbeCoeffs(ambient, lobes);
}

/**
 * Pick the point lights a receiver actually gets: the NEAREST few to the receiving object's own
 * position (benilla `wow_model.wgsl::point_light_sum`, gather `0x71bf90`). The reference commits at
 * most three and drops the fourth.
 *
 * Two things about this are easy to get wrong:
 *  - The anchor is the RECEIVING OBJECT's position -- never the camera, never the vertex. Selecting
 *    against the camera lights fixtures from sideways lamps the real client never commits.
 *  - Ranking is by plain distance, NOT by estimated contribution. A light's own range bounds
 *    candidacy, but once selected it reaches the whole object with no distance cutoff, so selection
 *    pops at object granularity -- which is the authored behaviour, not an artifact.
 */
export function selectPointLights<T extends { position: Vec3; attenEnd: number }>(
  anchor: Vec3,
  lights: T[],
  max = 3,
): T[] {
  const candidates: Array<{ light: T; d2: number }> = [];

  for (const light of lights) {
    const dx = light.position[0] - anchor[0];
    const dy = light.position[1] - anchor[1];
    const dz = light.position[2] - anchor[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > light.attenEnd * light.attenEnd) {
      continue;
    }
    candidates.push({ light, d2 });
  }

  candidates.sort((first, second) => first.d2 - second.d2);
  return candidates.slice(0, max).map((entry) => entry.light);
}
