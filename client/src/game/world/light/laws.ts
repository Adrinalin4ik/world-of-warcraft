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
