/** @jest-environment node */
import { doodadFadeAlpha, NEVER_FADE_RADIUS } from '../laws';

describe('doodadFadeAlpha size bucketing', () => {
  it('never fades a doodad larger than 7.0 yd, however far away', () => {
    expect(doodadFadeAlpha(7.01, 10_000)).toBe(1);
    expect(NEVER_FADE_RADIUS).toBe(7.0);
  });

  it('puts a doodad of exactly 7.0 yd in the LARGE band, not the never-fade class', () => {
    // The cutoff is `radius <= max_r`, so 7.0 takes the (150, 50) bucket. d = 10000 - 7 is far past
    // the band end, so it culls.
    expect(doodadFadeAlpha(7.0, 10_000)).toBe(0);
  });

  it('puts a doodad of exactly 0.5 yd in the SMALL band', () => {
    // d = 40 - 0.5 = 39.5, which is below the 40 yd band start -> fully opaque.
    expect(doodadFadeAlpha(0.5, 40)).toBe(1);
    // d = 50.5 - 0.5 = 50, exactly the band end -> fully faded.
    expect(doodadFadeAlpha(0.5, 50.5)).toBe(0);
  });

  it('puts a doodad of exactly 2.5 yd in the MID band', () => {
    // d = 102.5 - 2.5 = 100, the band start -> still opaque.
    expect(doodadFadeAlpha(2.5, 102.5)).toBe(1);
    // d = 127.5 - 2.5 = 125, the band end -> fully faded.
    expect(doodadFadeAlpha(2.5, 127.5)).toBe(0);
  });
});

describe('doodadFadeAlpha ramp', () => {
  it('is fully opaque inside the band start', () => {
    expect(doodadFadeAlpha(0.25, 20)).toBe(1);
  });

  it('is exactly half way through the small band', () => {
    // radius 0 -> d == horizDist. Band 40 -> 50, so the midpoint is 45.
    expect(doodadFadeAlpha(0, 45)).toBeCloseTo(0.5, 10);
  });

  it('is fully faded past the band end', () => {
    expect(doodadFadeAlpha(0, 60)).toBe(0);
  });

  it('subtracts the radius, so a bigger doodad in the same band survives further out', () => {
    // Both take the mid band (100 -> 125). The larger one has a smaller d at the same distance.
    const small = doodadFadeAlpha(0.6, 112.5);
    const large = doodadFadeAlpha(2.4, 112.5);
    expect(large).toBeGreaterThan(small);
  });

  it('clamps to [0, 1] for a camera inside the doodad', () => {
    expect(doodadFadeAlpha(2.0, 0)).toBe(1);
  });
});
