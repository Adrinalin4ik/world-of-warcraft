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
 * The storm light blend `bcc = min(1, skyDensity * 4)` (benilla `weather`/`cloud_density_clamp
 * 0x6d4500`). The weather state machine's sky-density channel lives in the [0, 0.25] knee domain, so
 * a fully ramped storm gives exactly 1.0. This weight lerps the storm `LightParams` record over the
 * clear one across every band at once -- ambient, diffuse, sky stops, fog colour AND fog distances.
 */
export function stormBlend(skyDensity: number): number {
  return Math.min(1, Math.max(0, skyDensity * 4));
}
