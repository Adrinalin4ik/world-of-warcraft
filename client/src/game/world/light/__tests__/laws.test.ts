/**
 * @jest-environment node
 */
import {
  cap96,
  dawnDuskCurve,
  evalProbe,
  floor112,
  floor168,
  interpDayNight,
  Lobe,
  propProbeCoeffs,
  quantizeGlow,
  RGB,
  sidnNightFraction,
  skyWarp,
  stormBlend,
  Vec3,
} from '../laws';

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

describe('MODD colour byte laws', () => {
  // Compare in bytes, which is how the reference's own golden values are recorded.
  const asBytes = (c: RGB) => c.map((v) => Math.round(v * 255));

  it('caps the ambient word at value 96, hue preserved', () => {
    expect(asBytes(cap96([78, 76, 134]))).toEqual([56, 55, 96]);
    expect(asBytes(cap96([90, 86, 141]))).toEqual([61, 59, 96]);
  });

  it('passes an ambient word whose max is already <= 96 straight through', () => {
    expect(asBytes(cap96([96, 40, 20]))).toEqual([96, 40, 20]);
  });

  it('rounds the cap scale half-to-even, not half-up', () => {
    // max = 160 makes 96*255/160 - 0.5 land exactly on 152.5 -- the one tie in the whole byte domain.
    // Round-half-to-even gives scale 152, so the max channel recombines to (160*152 + 255) >> 8 = 95.
    // Math.round would give 153 and a max of 96. Note the cap therefore does NOT always land the max
    // exactly on 96; the reference's own rounding is what decides, and here it lands a byte under.
    expect(asBytes(cap96([160, 160, 160]))).toEqual([95, 95, 95]);
    expect(asBytes(cap96([160, 80, 40]))).toEqual([95, 48, 24]);
  });

  it('raises a diffuse word below 112 by a truncating scale', () => {
    expect(asBytes(floor112([56, 28, 14]))).toEqual([112, 56, 28]);
  });

  it('passes a diffuse word at or above 112 through untouched', () => {
    expect(asBytes(floor112([78, 76, 134]))).toEqual([78, 76, 134]);
    expect(asBytes(floor112([90, 86, 141]))).toEqual([90, 86, 141]);
  });

  it('leaves black black rather than dividing by zero', () => {
    expect(asBytes(floor112([0, 0, 0]))).toEqual([0, 0, 0]);
  });

  it('truncates the entity threshold at 168 the same way', () => {
    // The reference's decoded abbey benches: truncation gives 127 where nearest would give 128.
    expect(asBytes(floor168([59, 65, 92]))).toEqual([107, 118, 168]);
    expect(asBytes(floor168([69, 63, 83]))).toEqual([139, 127, 168]);
  });
});

describe('interpDayNight', () => {
  it('lerps between adjacent keyframes', () => {
    const table: Array<[number, number]> = [
      [0.0, 0.0],
      [0.5, 10.0],
    ];
    expect(interpDayNight(table, 0.25)).toBeCloseTo(5.0, 5);
  });

  it('wraps around the end of the day', () => {
    // Between the 0.75 key and the 0.25 key going forwards through midnight: 0.0 is halfway.
    const table: Array<[number, number]> = [
      [0.25, 0.0],
      [0.75, 4.0],
    ];
    expect(interpDayNight(table, 0.0)).toBeCloseTo(2.0, 5);
  });

  it('reproduces the sun elevation table at its keyframes', () => {
    const phi: Array<[number, number]> = [
      [0.0, 2.2165682],
      [0.25, 1.9198623],
      [0.5, 2.2165682],
      [0.75, 1.9198623],
    ];
    expect(interpDayNight(phi, 0.0)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.25)).toBeCloseTo(1.9198623, 5);
    expect(interpDayNight(phi, 0.5)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.125)).toBeCloseTo(2.0682153, 4);
  });
});

describe('sidnNightFraction', () => {
  const at = (hour: number, minute: number) => sidnNightFraction(hour * 60 + minute);

  it('is full overnight', () => {
    expect(at(0, 0)).toBeCloseTo(1.0, 5);
    expect(at(6, 0)).toBeCloseTo(1.0, 5);
    expect(at(23, 0)).toBeCloseTo(1.0, 5);
  });

  it('ramps out over 06:00 to 07:00', () => {
    expect(at(6, 30)).toBeCloseTo(0.5, 5);
    expect(at(7, 0)).toBeCloseTo(0.0, 5);
  });

  it('is off all day', () => {
    expect(at(12, 0)).toBeCloseTo(0.0, 5);
    expect(at(20, 30)).toBeCloseTo(0.0, 5);
  });

  it('ramps in over 20:30 to 21:30', () => {
    expect(at(21, 0)).toBeCloseTo(0.5, 5);
    expect(at(21, 30)).toBeCloseTo(1.0, 4);
  });
});

describe('dawnDuskCurve and skyWarp', () => {
  it('is zero across midday and deep night', () => {
    expect(dawnDuskCurve(720)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(0)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(1080)).toBeCloseTo(0.0, 5);
  });

  it('spikes to ~1 at dawn and dusk', () => {
    expect(dawnDuskCurve(390)).toBeGreaterThan(0.99);
    expect(dawnDuskCurve(1290)).toBeGreaterThan(0.99);
  });

  it('is partway up the dawn ramp at 06:00', () => {
    const mid = dawnDuskCurve(360);
    expect(mid).toBeGreaterThan(0.0);
    expect(mid).toBeLessThan(1.0);
  });

  it('is identically zero in a highlightSky = 0 zone at every hour', () => {
    for (let minute = 0; minute < 1440; minute += 15) {
      expect(skyWarp(minute, 0)).toBe(0);
    }
  });

  it('passes the curve through at highlightSky = 1', () => {
    expect(skyWarp(390, 1)).toBeCloseTo(dawnDuskCurve(390), 5);
  });
});

describe('quantizeGlow and stormBlend', () => {
  it('quantizes glow to the byte the reference packs', () => {
    expect(quantizeGlow(0.65)).toBeCloseTo(0.647, 3);
    expect(quantizeGlow(1.0)).toBeCloseTo(1.0, 5);
    expect(quantizeGlow(0.0)).toBe(0);
  });

  it('saturates the storm blend at a quarter sky density', () => {
    expect(stormBlend(0)).toBe(0);
    expect(stormBlend(0.125)).toBeCloseTo(0.5, 5);
    expect(stormBlend(0.25)).toBeCloseTo(1.0, 5);
    // Clamped, so an out-of-domain density cannot overdrive the lerp.
    expect(stormBlend(1.0)).toBe(1);
  });
});
