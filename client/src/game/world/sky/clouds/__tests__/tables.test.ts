import { PERM, CURVE, gradientTable, fadeTable } from '../tables';

describe('PERM', () => {
  it('is a permutation of 0..255 -- every value exactly once', () => {
    // A spot-check of a few entries would not catch a transcription slip (e.g. a duplicated or
    // dropped byte); counting every value's occurrences does.
    const seen = new Uint16Array(256);
    for (const v of PERM) {
      seen[v]++;
    }
    expect(PERM.length).toBe(256);
    expect(Array.from(seen)).toEqual(new Array(256).fill(1));
  });
});

describe('CURVE', () => {
  it('is monotonic non-decreasing, starts 0, ends 254', () => {
    expect(CURVE.length).toBe(256);
    expect(CURVE[0]).toBe(0);
    expect(CURVE[255]).toBe(254);
    for (let i = 1; i < CURVE.length; i++) {
      expect(CURVE[i]).toBeGreaterThanOrEqual(CURVE[i - 1]);
    }
  });
});

describe('gradientTable', () => {
  it('is 256 values within [-1, 1]', () => {
    const table = gradientTable();
    expect(table.length).toBe(256);
    for (const v of table) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (fixed seed = 1)', () => {
    expect(Array.from(gradientTable())).toEqual(Array.from(gradientTable()));
  });
});

describe('fadeTable', () => {
  it('matches the raised-cosine formula exactly -- fade[128] === 1 is NOT true', () => {
    const table = fadeTable();
    expect(table.length).toBe(256);
    expect(table[0]).toBe(0);
    // Verify against the formula at a handful of indices, not against the tempting-but-wrong
    // assumption that the midpoint index reads 1.0 (0.5*(1-cos(128*PI/256)) = 0.5*(1-cos(pi/2)) =
    // 0.5, not 1 -- the ease only reaches 1 at i = 256, which is out of range).
    const f32Pi = Math.fround(Math.PI);
    for (const i of [0, 1, 64, 128, 192, 255]) {
      const arg = Math.fround(Math.fround(Math.fround(i) * f32Pi) / 256.0);
      const want = Math.fround(0.5 * Math.fround(1.0 - Math.fround(Math.cos(arg))));
      expect(table[i]).toBeCloseTo(want, 6);
    }
    expect(table[128]).not.toBe(1);
  });
});
