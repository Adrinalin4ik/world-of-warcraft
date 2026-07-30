/**
 * @jest-environment node
 */
import { evalProbe, Lobe, propProbeCoeffs, RGB, Vec3 } from '../laws';

// benilla's golden case: the abbey stand MODD[24]. ambient/diffuse are its decoded colour words, and
// `AXIS` is an arbitrary unit direction -- the fold's identities hold in any frame, because the
// response depends only on mu = n.u. The frame-specific constant lives in INTERIOR_LIGHT_AXIS (Task 4).
const AMBIENT: RGB = [61 / 255, 59 / 255, 96 / 255];
const DIFFUSE: RGB = [90 / 255, 86 / 255, 141 / 255];

const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

const AXIS = normalize([-0.30822, 0.9, -0.30822]);

const expectClose = (got: RGB, want: RGB) => {
  for (let ch = 0; ch < 3; ++ch) {
    expect(got[ch]).toBeCloseTo(want[ch], 5);
  }
};

describe('propProbeCoeffs', () => {
  it('returns exactly ambient + diffuse facing the lobe (mu = 1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    expectClose(evalProbe(c, AXIS), [
      AMBIENT[0] + DIFFUSE[0],
      AMBIENT[1] + DIFFUSE[1],
      AMBIENT[2] + DIFFUSE[2],
    ]);
  });

  it('wraps to ambient + 0.0588 x diffuse facing away (mu = -1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.25;
    const away: Vec3 = [-AXIS[0], -AXIS[1], -AXIS[2]];
    expectClose(evalProbe(c, away), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('gives ambient + 0.0882 x diffuse side-on (mu = 0)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.375;
    // Perpendicular to AXIS by construction: dot([az, 0, -ax], [ax, ay, az]) == 0.
    const side = normalize([AXIS[2], 0, -AXIS[0]]);
    expectClose(evalProbe(c, side), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('is flat ambient with no lobes at all', () => {
    const c = propProbeCoeffs(AMBIENT, []);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
    expectClose(evalProbe(c, [1, 0, 0]), AMBIENT);
  });

  it('is additive across lobes', () => {
    const second: Lobe = { dir: [0, 1, 0], color: [0.1, 0.2, 0.3] };
    const both = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }, second]);
    const first = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const secondOnly = propProbeCoeffs([0, 0, 0], [second]);
    const a = evalProbe(both, AXIS);
    const b = evalProbe(first, AXIS);
    const c2 = evalProbe(secondOnly, AXIS);
    for (let ch = 0; ch < 3; ++ch) {
      expect(a[ch]).toBeCloseTo(b[ch] + c2[ch], 5);
    }
  });

  it('ignores a zero-length lobe direction rather than emitting NaN', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: [0, 0, 0], color: DIFFUSE }]);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
  });
});
