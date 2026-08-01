/**
 * The frozen cloud noise tables -- ported verbatim from
 * `samples/benilla/crates/benilla/src/clouds/tables.rs` (wow-re `scratch/cloud-coverage-pipeline.md`
 * S1b/S1d). Pure data plus two one-time builders; imports nothing.
 */

/**
 * The static permutation table (`0x86f2d0`, `.rdata`) -- 256 bytes, a permutation of 0..255, always
 * indexed `& 0xff`. There is NO doubled-512 layout -- do not "helpfully" duplicate it. Dumped
 * verbatim from the binary (via the reference's `PERM`).
 */
// prettier-ignore
export const PERM: Readonly<Uint8Array> = new Uint8Array([
  225, 155, 210, 108, 175, 199, 221, 144, 203, 116,  70, 213,  69, 158,  33, 252,
    5,  82, 173, 133, 222, 139, 174,  27,   9,  71,  90, 246,  75, 130,  91, 191,
  169, 138,   2, 151, 194, 235,  81,   7,  25, 113, 228, 159, 205, 253, 134, 142,
  248,  65, 224, 217,  22, 121, 229,  63,  89, 103,  96, 104, 156,  17, 201, 129,
   36,   8, 165, 110, 237, 117, 231,  56, 132, 211, 152,  20, 181, 111, 239, 218,
  170, 163,  51, 172, 157,  47,  80, 212, 176, 250,  87,  49,  99, 242, 136, 189,
  162, 115,  44,  43, 124,  94, 150,  16, 141, 247,  32,  10, 198, 223, 255,  72,
   53, 131,  84,  57, 220, 197,  58,  50, 208,  11, 241,  28,   3, 192,  62, 202,
   18, 215, 153,  24,  76,  41,  15, 179,  39,  46,  55,   6, 128, 167,  23, 188,
  106,  34, 187, 140, 164,  73, 112, 182, 244, 195, 227,  13,  35,  77, 196, 185,
   26, 200, 226, 119,  31, 123, 168, 125, 249,  68, 183, 230, 177, 135, 160, 180,
   12,   1, 243, 148, 102, 166,  38, 238, 251,  37, 240, 126,  64,  74, 161,  40,
  184, 149, 171, 178, 101,  66,  29,  59, 146,  61, 254, 107,  42,  86, 154,   4,
  236, 232, 120,  21, 233, 209,  45,  98, 193, 114,  78,  19, 206,  14, 118, 127,
   48,  79, 147,  85,  30, 207, 219,  54,  88, 234, 190, 122,  95,  67, 143, 109,
  137, 214, 145,  93,  92, 100, 245,   0, 216, 186,  60,  83, 105,  97, 204,  52,
]);

/**
 * The tone curve (`0xce91d8`) -- built once at init by `dn_tone_curve 0x6d0900` (gamma 0.96, init
 * threshold 101: `curve[i] = ftol(255 - 255*0.96^(i*0.6015625))`) and fixed thereafter. Frozen to
 * the reference's exact bytes rather than recomputed through `Math.pow` -- the reference froze it
 * deliberately for cross-platform determinism, and recomputing it reintroduces exactly the drift
 * it avoided.
 */
// prettier-ignore
export const CURVE: Readonly<Uint8Array> = new Uint8Array([
    0,   6,  12,  18,  23,  29,  34,  40,  45,  50,  55,  60,  65,  69,  74,  78,
   82,  87,  91,  95,  98, 102, 106, 110, 113, 116, 120, 123, 126, 129, 132, 135,
  138, 141, 144, 147, 149, 152, 154, 157, 159, 161, 164, 166, 168, 170, 172, 174,
  176, 178, 180, 182, 183, 185, 187, 188, 190, 192, 193, 195, 196, 197, 199, 200,
  202, 203, 204, 205, 206, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218,
  219, 220, 220, 221, 222, 223, 224, 224, 225, 226, 227, 227, 228, 229, 229, 230,
  230, 231, 232, 232, 233, 233, 234, 234, 235, 235, 236, 236, 237, 237, 237, 238,
  238, 239, 239, 239, 240, 240, 240, 241, 241, 241, 242, 242, 242, 243, 243, 243,
  243, 244, 244, 244, 245, 245, 245, 245, 245, 246, 246, 246, 246, 247, 247, 247,
  247, 247, 247, 248, 248, 248, 248, 248, 248, 249, 249, 249, 249, 249, 249, 249,
  249, 250, 250, 250, 250, 250, 250, 250, 250, 250, 251, 251, 251, 251, 251, 251,
  251, 251, 251, 251, 251, 252, 252, 252, 252, 252, 252, 252, 252, 252, 252, 252,
  252, 252, 252, 252, 252, 252, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253,
  253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253, 253,
  253, 253, 253, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254,
  254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254, 254,
]);

/**
 * The gradient table build (`0x6d0c90` loop 1): `gradient[i] = 1 - 2*rand()/32767` with MSVC's LCG
 * (`seed = seed*214013 + 2531011; (seed >> 16) & 0x7fff`). The reference's real seed is whatever the
 * process `srand` state was -- not visually load-bearing (any uniform table in [-1, 1] is
 * equivalent) -- so, like the reference, we fix `seed = 1` (the CRT default) for run-to-run
 * determinism.
 *
 * JS hazard: `seed * 214013` overflows the f64 integer-exact range (2^53) after a few iterations,
 * so the multiply MUST run through `Math.imul` (true 32-bit multiply, silently wraps).
 *
 * The Rust builder computes the whole expression `1.0 - 2.0 * (r as f32) / 32767.0` in f32 (the
 * function's return type infers it), so every operation below is `Math.fround`-ed individually to
 * reproduce that f32 arithmetic chain rather than doing the whole thing in f64 and rounding once.
 */
export function gradientTable(): Float32Array {
  const table = new Float32Array(256);
  let seed = 1 >>> 0;
  for (let i = 0; i < 256; i++) {
    seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
    const r = (seed >>> 16) & 0x7fff;
    const rf = Math.fround(r);
    const doubled = Math.fround(2.0 * rf);
    const divided = Math.fround(doubled / 32767.0);
    table[i] = Math.fround(1.0 - divided);
  }
  return table;
}

/**
 * The fade table build (`0x6d0c90` loop 2): the raised-cosine ease `0.5*(1 - cos(i*PI/256))`, all
 * f32 arithmetic in the reference (the array element type is `f32`). `std::f32::consts::PI` is the
 * f64 constant PI rounded to the nearest representable f32, which is exactly what
 * `Math.fround(Math.PI)` produces.
 *
 * `f32::cos` itself cannot be reproduced bit-exact in JS (no f32 libm here); this computes the
 * f64 cosine of the f32-rounded argument and rounds the result back to f32, the standard
 * approximation used throughout this port for the (non-gating) trig calls.
 */
export function fadeTable(): Float32Array {
  const table = new Float32Array(256);
  const f32Pi = Math.fround(Math.PI);
  for (let i = 0; i < 256; i++) {
    const iF = Math.fround(i);
    const arg = Math.fround(Math.fround(iF * f32Pi) / 256.0);
    const cosv = Math.fround(Math.cos(arg));
    const oneMinus = Math.fround(1.0 - cosv);
    table[i] = Math.fround(0.5 * oneMinus);
  }
  return table;
}
