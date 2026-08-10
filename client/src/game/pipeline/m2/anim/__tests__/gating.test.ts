/** @jest-environment node */
import { BoneBudget, decimationPeriod, shouldPose } from '../gating';

describe('decimationPeriod', () => {
  it('poses near instances every frame', () => {
    expect(decimationPeriod(0)).toBe(1);
    expect(decimationPeriod(39)).toBe(1);
  });

  it('halves the rate at mid distance', () => {
    expect(decimationPeriod(40)).toBe(2);
    expect(decimationPeriod(119)).toBe(2);
  });

  it('quarters the rate far out', () => {
    expect(decimationPeriod(120)).toBe(4);
    expect(decimationPeriod(1000)).toBe(4);
  });

  /**
   * A NaN distance must take the SAFEST bucket, not the cheapest. Written as two `<` comparisons it
   * fell through to period 4, because every comparison against NaN is false -- so an uninitialised
   * position produced a doodad quietly animating at a quarter rate instead of an obvious one.
   */
  it('poses every frame when the distance is not a number', () => {
    expect(decimationPeriod(NaN)).toBe(1);
    expect(shouldPose(7, NaN, 3)).toBe(true);
  });

  it('poses every frame for a negative distance', () => {
    expect(decimationPeriod(-1)).toBe(1);
  });

  it('still decimates an infinite distance', () => {
    expect(decimationPeriod(Infinity)).toBe(4);
  });
});

describe('shouldPose', () => {
  it('always poses a near instance', () => {
    for (let f = 0; f < 8; ++f) {
      expect(shouldPose(3, 10, f)).toBe(true);
    }
  });

  it('poses a mid instance every second frame', () => {
    const posed = [0, 1, 2, 3].map((f) => shouldPose(0, 60, f));
    expect(posed).toEqual([true, false, true, false]);
  });

  /**
   * The stagger matters more than the decimation. Bucketing by instance id spreads updates across
   * frames; without it every instance lands on the same frame and the scheme CREATES the spike it
   * was meant to prevent.
   */
  it('staggers instances across frames rather than aligning them', () => {
    const perFrame = [0, 1, 2, 3].map(
      (f) => [0, 1, 2, 3, 4, 5, 6, 7].filter((id) => shouldPose(id, 200, f)).length,
    );
    // Eight instances, period 4: two per frame, never eight on one frame and zero on the rest.
    expect(perFrame).toEqual([2, 2, 2, 2]);
  });
});

describe('BoneBudget', () => {
  it('grants requests until the limit is reached', () => {
    const b = new BoneBudget(100);
    b.beginFrame();
    expect(b.request(40)).toBe(true);
    expect(b.request(40)).toBe(true);
    expect(b.request(40)).toBe(false);
    expect(b.spent).toBe(80);
  });

  it('resets each frame', () => {
    const b = new BoneBudget(100);
    b.beginFrame();
    b.request(100);
    expect(b.request(1)).toBe(false);
    b.beginFrame();
    expect(b.request(1)).toBe(true);
  });

  it('always grants the first request, however large, so a heavy model is never frozen', () => {
    const b = new BoneBudget(10);
    b.beginFrame();
    expect(b.request(500)).toBe(true);
  });
});
