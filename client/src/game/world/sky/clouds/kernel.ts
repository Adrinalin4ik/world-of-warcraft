/**
 * The cloud coverage kernel -- a faithful port of
 * `samples/benilla/crates/benilla/src/clouds/kernel.rs` (wow-re `crates/lighting/src/clouds.rs`,
 * `WoW.exe 0x6cffc0`).
 *
 * The client maintains a scrolling 128x128 byte tile of cloud coverage, regenerated in 32-row bands
 * at ~10 Hz: 4-octave toroidal value noise (lacunarity 2, persistence 0.5) -> a raw accumulator,
 * thresholded by the authored Light.dbc cloud density `C` (`T = trunc((1-C)*255)`) and shaped
 * through a fixed 256-byte tone curve (gamma 0.96, frozen as `CURVE`). One field serves every
 * consumer: the glare occlusion (`occ1Sun`/`occ1Moon`) samples the same tile the visible dome
 * renders from -- splitting them would let a cloud dim the glare that is not the cloud on screen.
 *
 * The noise lattice is keyed by three axes: tile row (`rowKey`, advancing `freq` per row), tile
 * column (`colKey`, advancing `freq` per column), and time (the u16 `phase`, bumped once per full
 * tile wrap -- its high byte picks the permutation slice pair, its low byte the fade weight between
 * them). Band regeneration at an unchanged phase/threshold is idempotent (keys derive from absolute
 * tile coordinates), so the field only *moves* when the phase advances or density changes.
 *
 * Each regen fire ends with the color pass: the coverage bytes become RGBA texels (gradient +
 * sun-aligned glow, alpha = the coverage byte). The glow's per-cell surface normal comes from the
 * octave-2 derivative leg.
 *
 * FLOAT DISCIPLINE. The reference computes in f64 with specific f32 round-trips, two of which its
 * own comments flag as +/-1-ulp-significant in the byte diff: the `v8` round-trip in the noise walk
 * and the accumulator store. Every `as f32` in the Rust below is ported as an explicit
 * `Math.fround(...)` at exactly that point -- no more, no fewer. Persisted per-cell state (`accum`,
 * `deriv`, `prevrow`) lives in `Float32Array`s so a store into them is automatically f32-rounded,
 * matching the Rust struct fields' storage type; the transient per-octave scratch fields are plain
 * numbers, manually `fround`-ed at each point the Rust casts.
 *
 * FRAME CONVENTION -- two frames, named explicitly. `samples/benilla` (the reference) is Bevy,
 * +Y-up, and converts incoming WoW Z-up directions to that frame before use. This client does NOT:
 * `MapLight#updateSunDirection` (`client/src/game/world/light/MapLight.ts`) builds `sunDir` straight
 * off the raw WoW spherical formula (`x = sinPhi*cosTheta, y = sinPhi*sinTheta, z = cosPhi`, off
 * `SUN_PHI_TABLE`/`SUN_THETA_TABLE`) with no `wow_to_bevy` step, so `z` is this client's vertical
 * axis (`z > 0` is above the horizon) -- WoW's native Z-up frame, unpermuted. `moonDirection`
 * (`world/light/laws.ts`, Task 3) returns a vector in that same frame, so the sun and moon glow
 * bodies arrive consistently. This was confirmed against Task 3's landing (`58a525e`), not inferred.
 *
 * So this port stays in the client's native Z-up frame throughout and does NOT perform the
 * reference's Bevy conversion: everywhere benilla reads `dir.y` (its up axis) this port reads
 * `dir.z`; everywhere benilla reads its horizontal pair `(dir.x, dir.z)` this port reads
 * `(dir.x, dir.y)`. The axis this port treats as "up" is **z**, not y.
 *
 * Deviations from the bytes, all in never-hit or non-visual domains (mirrors the reference's own
 * recorded deviations): the `acos` argument is clamped to +/-1 (the reference NaNs above ~70
 * elevation, a domain its sun/moon never reach); LUT reads wrap toroidally instead of running off
 * the flat heap at the measure-zero `u == 1.0` edge; the gradient table uses the reference's
 * MSVC-LCG formula with a fixed seed (not visually load-bearing); and the color buffer seeds
 * alpha-0 instead of `0xFFFFFFFF` (no white flash before the first build).
 */

import { CURVE, PERM, gradientTable, fadeTable } from './tables';

/** Tile side at `SkyCloudLOD 0` (`cols = 128 << LOD`; the CVar clamps to [0,1] and defaults to 0).
 * This port implements LOD 0 only, as the reference does. */
export const COLS = 128;
/** `log2(COLS)` -- the row-pitch shift the sampler uses. */
export const SHIFT = 7;
/** Rows regenerated per fire. */
export const ROWS_PER_TICK = 32;
/** Octave count. */
export const OCTAVES = 4;
/** Regen countdown reset (seconds) -- the ~10 Hz cadence. */
export const REGEN_PERIOD = 0.1;
/** Per-octave lattice frequencies, LOD 0 row of the base table (`(16 >> LOD) << oct`). */
const BASE_FREQ: readonly number[] = [16, 32, 64, 128];

/** A structural direction/offset -- no three.js import in this pure module. Z-up (see the frame
 * convention note above). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Per-fire inputs to the color pass, resolved by the caller from the map's light state: the three
 * Light.dbc cloud palette rows, the weather blend, and the glow body (sun by day / moon by night,
 * with its own day envelope -- Task 3). */
export interface CloudFrame {
  /** Sun-glow palette (IntBand sub-10), sRGB 0..1. */
  sun: readonly [number, number, number];
  /** Gradient slope (IntBand sub-11). */
  slope: readonly [number, number, number];
  /** Gradient base (IntBand sub-12). */
  gbase: readonly [number, number, number];
  /** The weather storm blend `bcc` -- feeds the glow z-bias (`bcc*192 + 64`) and the dim
   * (`1 - 0.75*bcc`). */
  bcc: number;
  /** Camera-to-body (TOWARD the sun/moon) direction of the glow body, in this client's native Z-up
   * frame. This is the NEGATION of `MapLight`'s `sunDir`, which points from the sun down onto the
   * world, not the un-normalized offset toward it. */
  glowDir: Vec3Like;
  /** The glow day-envelope factor (Task 3's `cloudGlowTrack`). */
  glowTrack: number;
}

/** Shared 4-byte scratch for the bit tricks the reference's disassembly performs through the FPU's
 * float-store-as-int path (`bits(x) >> N`), rather than arithmetic. */
const scratch = new DataView(new ArrayBuffer(4));
function f32Bits(v: number): number {
  scratch.setFloat32(0, v, true);
  return scratch.getUint32(0, true);
}
function bitsF32(b: number): number {
  scratch.setUint32(0, b >>> 0, true);
  return scratch.getFloat32(0, true);
}

function perm(i: number): number {
  return PERM[i & 0xff];
}

/** Per-octave lattice walk state -- the reference's 0x54-byte stack record, kept as named fields. */
interface Octave {
  /** Lattice frequency. */
  freq: number;
  /** Row axis key (u16): starts at `scroll * freq`, advances `freq` per row. High byte = row
   * lattice cell, low byte = row fade index. */
  rowKey: number;
  /** Column axis key (u16): re-seeded to `phase` each row, advances `freq` per column. High byte =
   * column lattice cell, low byte = column fade index. */
  colKey: number;
  /** Octave amplitude `1 / 2^oct`. */
  amp: number;
  /** Per-row lattice corner seeds: row cell hashed through the phase-selected permutation slices
   * (`x*` = current time slice, `y*` = next). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Cached corner gradients + deltas for the current column cell, rebuilt lazily when the column
   * cell changes. */
  g00: number;
  g00d: number;
  g10: number;
  g10d: number;
  g01: number;
  g01d: number;
  g11: number;
  g11d: number;
  cached: number;
}

/** The cloud coverage field: the byte tile, the colored texture, and the regen state. */
export class CloudKernel {
  /** The coverage byte tile, `COLS^2` row-major. `byte/255 = R in [0,1]`. */
  #tile = new Uint8Array(COLS * COLS);
  /** The float accumulation tile. `Float32Array` so every store auto-rounds to f32, matching the
   * reference's persisted `Vec<f32>`. */
  #accum = new Float32Array(COLS * COLS);
  /** The per-cell shape derivative pairs (2 f32/cell) -- written by the octave-2 leg, consumed by
   * the color pass as the glow surface normal `S = (dx, dy, 1)`. */
  #deriv = new Float32Array(COLS * COLS * 2);
  /** The previous-row scratch (`COLS` f32) feeding the row derivative. */
  #prevrow = new Float32Array(COLS);
  /** The colored RGBA texels (4 B/cell: gradient+glow RGB, alpha = the coverage byte) -- this is
   * what the visible-layer texture upload reads (Task 5). Seeded alpha-0 (recorded deviation: the
   * reference inits 0xFFFFFFFF; alpha-0 means an unprimed dome can never flash white). */
  #rgba = new Uint8Array(COLS * COLS * 4).fill(0);
  /** Scroll position -- the tile row the next band starts at. */
  #scroll = 0;
  /** Noise-space phase (u16) -- +1 per full tile wrap; the time axis. */
  #phase = 0;
  /** Regen countdown; starts expired so the first tick fires. */
  #countdown = 0;
  /** The gradient table -- 256 x f32 in [-1, 1], built once. */
  #gradient = gradientTable();
  /** The fade table -- `0.5*(1 - cos(i*PI/256))`, built once. */
  #fade = fadeTable();

  constructor() {
    for (let i = 0; i < this.#rgba.length; i += 4) {
      this.#rgba[i] = 255;
      this.#rgba[i + 1] = 255;
      this.#rgba[i + 2] = 255;
      this.#rgba[i + 3] = 0;
    }
  }

  /** Advance the countdown and regenerate one 32-row band when it expires (the self-throttle: fire
   * when the decremented countdown <= 0, reset to 0.1). Returns whether the tile changed. */
  tick(dt: number, density: number, frame: CloudFrame): boolean {
    this.#countdown -= dt;
    if (this.#countdown > 0.0) {
      return false;
    }
    this.#countdown = REGEN_PERIOD;
    this.#regen(density, ROWS_PER_TICK, frame);
    return true;
  }

  /** Full-tile rebuild: regenerate every row at once -- the reference runs this on discontinuities
   * (init / zone / LOD change) by forcing the row count to `cols`. */
  rebuild(density: number, frame: CloudFrame): void {
    this.#scroll = 0;
    this.#regen(density, COLS, frame);
    this.#countdown = REGEN_PERIOD;
  }

  /** Re-run the color pass over the whole tile without touching the coverage -- the path when only
   * the palette/sun/weather inputs moved. */
  recolor(frame: CloudFrame): void {
    this.#colorBand(0, COLS, frame);
  }

  /** One regeneration fire: `rows` tile rows starting at `#scroll` (noise + quantize + the color
   * pass, in that order), then the scroll/phase advance. */
  #regen(density: number, rows: number, frame: CloudFrame): void {
    // Threshold refresh, called at the top of every fire: T = trunc((1-C)*255). The reference does
    // not clamp C; authored bands stay in [0,1] and we clamp for safety. All f32 arithmetic
    // (density arrives as an f32-typed parameter in the reference).
    const cClamped = Math.fround(Math.min(Math.max(density, 0.0), 1.0));
    const oneMinusC = Math.fround(1.0 - cClamped);
    const thresholdF = Math.fround(oneMinusC * 255.0);
    const threshold = Math.trunc(thresholdF);

    // Phase-selected permutation slice pair: the time axis. `seed` = phase HIGH byte.
    const seed = (this.#phase >> 8) & 0xff;
    const sliceA = perm(seed); // current time slice
    const sliceB = perm(seed + 1); // next time slice
    const fadeT = this.#fade[this.#phase & 0xff]; // time fraction (f64::from an f32 table entry)

    const scroll = this.#scroll;
    const oct: Octave[] = [];
    for (let c = 0; c < OCTAVES; c++) {
      const freq = BASE_FREQ[c];
      oct.push({
        freq,
        // Absolute-row keyed init -- what makes band regeneration idempotent at a fixed phase.
        rowKey: (scroll * freq) & 0xffff,
        colKey: 0,
        amp: Math.fround(1.0 / (1 << c)),
        x0: 0,
        x1: 0,
        y0: 0,
        y1: 0,
        g00: 0,
        g00d: 0,
        g10: 0,
        g10d: 0,
        g01: 0,
        g01d: 0,
        g11: 0,
        g11d: 0,
        cached: -1,
      });
    }

    // Float-tile zero-clear over the band.
    const bandEnd = Math.min(scroll + rows, COLS);
    this.#accum.fill(0, scroll * COLS, bandEnd * COLS);

    for (let row = 0; row < rows; row++) {
      const base = (scroll + row) * COLS;
      // Per-row lattice setup: hash the row cell (row_key high byte) through the two time slices;
      // re-seed the column walk from the phase; invalidate the corner cache.
      for (const o of oct) {
        const bv = (o.rowKey >> 8) & 0xff;
        o.x0 = perm(sliceA + bv);
        o.x1 = perm(sliceA + bv + 1);
        o.y0 = perm(bv + sliceB);
        o.y1 = perm(bv + 1 + sliceB);
        o.colKey = this.#phase;
        o.cached = -1;
      }
      // The previous column's third-octave partial sum -- reset per row.
      let prevAccum = 0;
      for (let col = 0; col < COLS; col++) {
        const cell = base + col;
        for (let oi = 0; oi < oct.length; oi++) {
          const o = oct[oi];
          const fadeRow = this.#fade[o.rowKey & 0xff]; // f_a
          const cz = (o.colKey >> 8) & 0xff; // column lattice cell
          if (cz !== o.cached) {
            o.cached = cz;
            const g = (s: number) => this.#gradient[perm(s)];
            const s0 = o.x0 + cz;
            const s1 = o.x1 + cz;
            const s2 = o.y0 + cz;
            const s3 = o.y1 + cz;
            o.g00 = g(s0);
            o.g00d = Math.fround(g(s0 + 1) - o.g00);
            o.g10 = g(s1);
            o.g10d = Math.fround(g(s1 + 1) - o.g10);
            o.g01 = g(s2);
            o.g01d = Math.fround(g(s2 + 1) - o.g01);
            o.g11 = g(s3);
            o.g11d = Math.fround(g(s3 + 1) - o.g11);
          }
          // The fade-interpolated bilinear + time lerp, mirroring the binary's f64 in-register
          // chain with its one f32 round-trip (`v8` -- +/-1-ulp-significant per the reference's own
          // comment).
          const fx = this.#fade[o.colKey & 0xff];
          const v7 = fx * o.g00d + o.g00;
          const v8 = Math.fround(fx * o.g01d + o.g01); // the flagged round-trip.
          const v7b = (fx * o.g10d + o.g10 - v7) * fadeRow + v7;
          const v8b = (fx * o.g11d + o.g11 - v8) * fadeRow + v8;
          o.colKey = (o.colKey + o.freq) & 0xffff;
          const acc = this.#accum[cell];
          const stored = Math.fround(((v8b - v7b) * fadeT + v7b) * o.amp + acc);
          this.#accum[cell] = stored;
          // The octave-2 derivative leg: the column/row slopes of the three-octave partial sum,
          // into the pair buffer the color pass reads as the glow surface normal. `scale =
          // 1 << (SHIFT - 7)` -- 1 at LOD 0.
          if (oi === 2) {
            const scale = Math.fround(1 << ((SHIFT - 7) & 0x1f));
            this.#deriv[cell * 2] = Math.fround((prevAccum - stored) * scale);
            const pr = this.#prevrow[col];
            this.#deriv[cell * 2 + 1] = Math.fround((pr - stored) * scale);
            prevAccum = stored;
            this.#prevrow[col] = stored;
          }
        }
      }
      // Per-row key advance: walks the row axis one `freq` step.
      for (const o of oct) {
        o.rowKey = (o.rowKey + o.freq) & 0xffff;
      }
    }

    // Palette-quantize the band into the byte tile: the binary's float-bits pack (fmul 64; fadd
    // 128; fadd 512; fstp then bits >> 14), threshold, tone curve.
    for (let cell = scroll * COLS; cell < bandEnd * COLS; cell++) {
      const packed = Math.fround(this.#accum[cell] * 64.0 + 128.0 + 512.0);
      const bits = f32Bits(packed);
      const idx = ((bits >>> 14) & 0xff) - threshold;
      this.#tile[cell] = idx >= 0 ? CURVE[idx] : 0;
    }

    // The color pass over the same band, called before the scroll advance.
    this.#colorBand(scroll, rows, frame);

    // Scroll advance with wrap: the wrap bumps the noise-space phase -- the time axis moves.
    this.#scroll += rows;
    if (this.#scroll >= COLS) {
      this.#phase = (this.#phase + 1) & 0xffff;
      this.#scroll = 0;
    }
  }

  /** The color pass -- per cell `t` = the coverage byte -- `t === 0` copies the previous cell's RGB
   * with alpha 0 (the filtering-friendly hole fill, order-dependent: iterate columns ascending,
   * skip the copy at `col === 0`); else the gradient `slope*p + gbase` with
   * `p = (((255-t)>>1) + 64)/255`, plus the sun-aligned glow `sun*(cosTheta*intensity)` where
   * `cosTheta` aligns the cell-to-body vector against the cell's shape normal `(dx, dy, 1)` through
   * the binary's integer fast-inverse-sqrt. Channels clamp at 1 with no lower clamp; alpha = `t`. */
  #colorBand(start: number, rows: number, frame: CloudFrame): void {
    const zBias = Math.fround(frame.bcc * 192.0 + 64.0);
    const intensity = Math.fround(frame.glowTrack * (1.0 - frame.bcc * 0.75));
    const body = bodyCells(frame.glowDir);
    const end = Math.min(start + rows, COLS);
    for (let row = start; row < end; row++) {
      const rowBase = row;
      for (let col = 0; col < COLS; col++) {
        const g = row * COLS + col;
        const t = this.#tile[g];
        if (t === 0) {
          if (col !== 0) {
            const p = (g - 1) * 4;
            const q = g * 4;
            this.#rgba[q] = this.#rgba[p];
            this.#rgba[q + 1] = this.#rgba[p + 1];
            this.#rgba[q + 2] = this.#rgba[p + 2];
            this.#rgba[q + 3] = 0;
          }
          continue;
        }
        // The angle byte: n = (((255 - t) >> 1) + 0x40), t in 1..255 so no u8 wrap.
        const n = ((255 - t) >>> 1) + 0x40;
        const p = INV_255 * n; // stays f64 through the channel calc -- not rounded to f32 here.
        const ch: [number, number, number] = [
          Math.fround(frame.slope[0] * p + frame.gbase[0]),
          Math.fround(frame.slope[1] * p + frame.gbase[1]),
          Math.fround(frame.slope[2] * p + frame.gbase[2]),
        ];
        if (body) {
          // V = (Su - col, Sv - row, zBias); S = (dx, dy, 1). Accumulation and product order per
          // the bytes (+/-1-ulp load-bearing in the reference's diff).
          const [su, sv] = body;
          const vx = Math.fround(su - col);
          const vy = Math.fround(sv - rowBase);
          const vz = zBias;
          const s0 = this.#deriv[g * 2];
          const s1 = this.#deriv[g * 2 + 1];
          const lenVSq = Math.fround(vz * vz + vy * vy + vx * vx);
          const lenSSq = Math.fround(s0 * s0 + s1 * s1 + 1.0);
          const dot = vx * s0 + vy * s1 + vz; // stays f64 -- no cast.
          const cosT = dot * (fisr(lenVSq) * fisr(lenSSq)); // stays f64.
          if (cosT > 0.0) {
            const m = cosT * intensity;
            ch[0] = Math.fround(frame.sun[0] * m + ch[0]);
            ch[1] = Math.fround(frame.sun[1] * m + ch[1]);
            ch[2] = Math.fround(frame.sun[2] * m + ch[2]);
          }
        }
        const q = g * 4;
        this.#rgba[q] = packChannel(ch[0]);
        this.#rgba[q + 1] = packChannel(ch[1]);
        this.#rgba[q + 2] = packChannel(ch[2]);
        this.#rgba[q + 3] = t;
      }
    }
  }

  /** Sample the coverage `R in [0,1]` toward a camera-relative offset `d` (this client's native
   * Z-up frame) -- project onto the tile, read the byte. `d` is the un-normalized body offset -- the
   * glare samples at its 12-unit sky point, so the zenith shift contributes `cos45/|d|`. */
  coverage(d: Vec3Like): number {
    const projected = projectCells(d);
    if (!projected) {
      return this.#tile[(COLS / 2) * COLS + COLS / 2] / 255.0;
    }
    const [u, v] = projected;
    const col = Math.trunc(u);
    const row = Math.trunc(v);
    // Toroidal mask (the reference reads the flat heap unchecked; `u == 1.0` is measure-zero).
    const cell = ((row & (COLS - 1)) << SHIFT) + (col & (COLS - 1));
    return this.#tile[cell] / 255.0;
  }

  /** The colored RGBA texels for the visible-layer texture upload, `COLS*COLS*4` bytes. */
  rgba(): Uint8Array {
    return this.#rgba;
  }

  /** The raw coverage byte tile -- a diagnostic accessor (tests, and Task 6's readouts: the tile
   * mean is what distinguishes "the field is empty" from "the field is fine and the dome is not
   * drawing"). */
  tile(): Uint8Array {
    return this.#tile;
  }

  /** The noise-space phase -- a diagnostic accessor (tests, and Task 6's readouts). */
  phase(): number {
    return this.#phase;
  }

  /** The scroll row the next band starts at -- a diagnostic accessor (tests, and Task 6's
   * readouts). */
  scroll(): number {
    return this.#scroll;
  }

  /** Force the phase (tests only, mirrors the reference's `#[cfg(test)] set_phase`). */
  setPhaseForTest(phase: number): void {
    this.#phase = phase & 0xffff;
  }
}

/**
 * The azimuthal tile projection: camera-relative offset -> fractional tile cell `(col, row)`. LUT
 * centre = zenith, radius grows with the angle off a `+cos(pi/4)`-shifted zenith axis, saturating at
 * 45 degrees (the rim; below-horizon directions clamp there). `null` for a degenerate zero offset.
 *
 * Frame convention: this port's "up" axis is `z` (see the module header) -- everywhere the
 * reference reads `d.y` this reads `d.z`, and its horizontal pair `(d.x, d.z)` becomes
 * `(d.x, d.y)`.
 */
function projectCells(d: Vec3Like): [number, number] | null {
  const dx = Math.fround(d.x);
  const dy = Math.fround(d.y);
  const dz = Math.fround(d.z);
  const lenSq = Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy) + Math.fround(dz * dz));
  const len = Math.fround(Math.sqrt(lenSq)); // Vec3::length, f32.
  if (len < 1e-6) {
    return null;
  }
  const quarterPi = FRAC_PI_4_F32;
  const c = dz + COS_FRAC_PI_4; // f64::from(d.z) + f64::from(cos(FRAC_PI_4 as f32)) -- both exact
  // promotions of f32 values, the addition itself is f64 (no cast).
  const ratio = Math.max(-1, Math.min(1, c / len)); // Recorded deviation: the reference feeds this
  // to acos unclamped and NaNs above ~70 degrees elevation, a domain its bodies never reach.
  const theta = Math.acos(ratio);
  const phase = (Math.min(theta, quarterPi) / quarterPi) * 0.5;
  const hyp = Math.sqrt(dx * dx + dy * dy); // f64 throughout, no f32 cast.
  let cx = 0;
  let cy = 0;
  if (hyp > 1e-5) {
    const inv = Math.fround(1.0 / hyp);
    cx = inv * dx;
    cy = inv * dy;
  }
  const col = Math.fround((cx * phase + 0.5) * COLS);
  const row = Math.fround((cy * phase + 0.5) * COLS);
  return [col, row];
}

/**
 * The glow body's tile cell: intersect the camera-to-body ray with the unit sky dome (the
 * `-cos(pi/4)`-shifted sphere, larger quadratic root) and project the hit point onto the tile.
 * `null` on the degenerate no-root / zero-direction case.
 */
function bodyCells(dir: Vec3Like): [number, number] | null {
  const dx = Math.fround(dir.x);
  const dy = Math.fround(dir.y);
  const dz = Math.fround(dir.z);
  // k = -cos(0.25*PI), the quarter-arc constant both functions open with (computed in f64, unlike
  // project_cells' f32-cos constant -- the reference itself uses two different precision paths for
  // the "same" constant at these two call sites, and this port keeps them distinct rather than
  // unifying them).
  const k = K_BODY;
  const a = Math.fround(dx * dx + dy * dy + dz * dz);
  // `fchs; fmul v.up; fadd st,st` -- (-k*up) doubled. Frame convention: "up" is `dz` here (see the
  // module header).
  const nk = -k * dz;
  const b = Math.fround(nk + nk);
  const c = Math.fround(k * k - 1.0);
  const t2 = quadraticLargerRoot(a, b, c);
  if (t2 === null) {
    return null;
  }
  const hit: Vec3Like = {
    x: Math.fround(t2 * dx),
    y: Math.fround(t2 * dy),
    z: Math.fround(t2 * dz),
  };
  return projectCells(hit);
}

/** The cmath quadratic solver: larger root of `a*t^2 + b*t + c = 0`, Vieta-stable exactly as the
 * binary rounds it; `null` on the no-root leg (`b^2 <= 4ac` or unordered/NaN). */
function quadraticLargerRoot(a: number, b: number, c: number): number | null {
  const g = a * c * 4.0;
  const h = b * b;
  if (Number.isNaN(h) || Number.isNaN(g) || h <= g) {
    return null;
  }
  const q = Math.sqrt(h - g);
  const bpm = b > 0.0 ? b + q : b - q;
  const s = bpm * -0.5;
  const inv = 1.0 / (a * s);
  const invF32 = Math.fround(inv);
  const rootB = Math.fround(inv * s * s);
  const rootA = Math.fround(invF32 * a * c);
  if (Number.isNaN(rootB) || rootB >= rootA) {
    return rootB;
  }
  return rootA;
}

/** `1/255` as the binary stores it (`0x3b808081`), not `1/255` computed in f64. */
const INV_255 = bitsF32(0x3b808081);

/** `std::f32::consts::FRAC_PI_4` -- PI/4 rounded to the nearest f32. */
const FRAC_PI_4_F32 = Math.fround(Math.PI / 4);
/** `FRAC_PI_4.cos()` -- project_cells' constant, an f32 cosine of the f32 FRAC_PI_4 constant.
 * Approximated (no bit-exact f32 libm available in JS) as the f64 cosine of the f32-rounded
 * argument, rounded back to f32 -- the standard approximation this port uses for non-gating trig. */
const COS_FRAC_PI_4 = Math.fround(Math.cos(FRAC_PI_4_F32));
/** `-(0.25 * PI_f32_const).cos()`, computed in f64 throughout (body_cells' own constant --
 * deliberately a different precision path from `COS_FRAC_PI_4` above; the reference itself computes
 * these two "same" constants differently at their two call sites, and this port preserves that
 * rather than unifying them). */
const K_BODY = -Math.cos(0.25 * Math.fround(Math.PI));

/** The binary's integer fast-inverse-sqrt leaf: a one-shot seed, NO Newton step -- deterministic
 * bit manipulation, ported verbatim (the approximation error is part of the reference's glow
 * shape). Do NOT replace with `1/Math.sqrt(x)`. */
function fisr(x: number): number {
  const bits = f32Bits(x);
  const seedBits = (0x5f3997bb - ((bits >>> 1) & 0x3fffffff)) >>> 0;
  return bitsF32(seedBits);
}

/** Pack one color channel to a byte exactly as the binary does: clamp `<= 1.0` (no lower clamp),
 * then the `bits(ch*255 + 512) >> 14` trick -- `floor(ch*255)` after f32 rounding. */
function packChannel(ch: number): number {
  const clamped = ch < 1.0 ? ch : 1.0;
  const bits = f32Bits(Math.fround(clamped * 255.0 + 512.0));
  return (bits >>> 14) & 0xff;
}

/** Sun glare cloud occlusion (`occ1Sun = 1 - R`): a cloud over the sun dims the flare linearly with
 * coverage. */
export function occ1Sun(r: number): number {
  return 1.0 - r;
}

/** Moon glare cloud occlusion -- the tent `1 - |2(R - 0.5)|`: zero at R=0 *and* R=1. The reference's
 * moon halo is a thin-cloud effect -- off in a perfectly clear patch of sky, blooming when a wisp
 * crosses the moon. */
export function occ1Moon(r: number): number {
  return 1.0 - Math.abs(2.0 * (r - 0.5));
}
