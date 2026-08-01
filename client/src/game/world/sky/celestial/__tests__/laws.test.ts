import { billboardPosition, CELESTIAL_DISTANCE, horizonClipFade, HORIZON_FADE_SCALE } from '../laws';

describe('horizonClipFade', () => {
  it('clips to 0 at and below the horizon', () => {
    expect(horizonClipFade(0)).toBe(0);
    expect(horizonClipFade(-0.01)).toBe(0);
    expect(horizonClipFade(-1)).toBe(0);
  });

  it('is fully opaque at and above the ~1.9-degree fade band (dirZ = 1/scale)', () => {
    expect(horizonClipFade(1 / HORIZON_FADE_SCALE)).toBeCloseTo(1, 6);
    expect(horizonClipFade(0.5)).toBe(1);
    expect(horizonClipFade(1)).toBe(1);
  });

  it('ramps linearly inside the band', () => {
    const half = 0.5 / HORIZON_FADE_SCALE;
    expect(horizonClipFade(half)).toBeCloseTo(0.5, 6);
  });

  it('the scale is exactly 30 -- 2.5 * the shared 12-unit near-sphere radius', () => {
    expect(HORIZON_FADE_SCALE).toBe(30);
  });

  it('accepts a caller-supplied scale for testing off the default radius', () => {
    expect(horizonClipFade(0.1, 10)).toBeCloseTo(1, 6);
    expect(horizonClipFade(0.05, 10)).toBeCloseTo(0.5, 6);
  });
});

describe('billboardPosition', () => {
  it('places the body at cam + distance*dir, world space', () => {
    const cam = { x: 1, y: 2, z: 3 };
    const dir = { x: 0, y: 0, z: 1 };
    const pos = billboardPosition(cam, dir, 12);
    expect(pos).toEqual({ x: 1, y: 2, z: 15 });
  });

  it('defaults to the shared 12-unit near-sphere radius', () => {
    const cam = { x: 0, y: 0, z: 0 };
    const dir = { x: 1, y: 0, z: 0 };
    expect(billboardPosition(cam, dir)).toEqual({ x: CELESTIAL_DISTANCE, y: 0, z: 0 });
  });

  it('handles an arbitrary unit direction', () => {
    const cam = { x: 0, y: 0, z: 0 };
    const dir = { x: 0.6, y: 0, z: 0.8 };
    const pos = billboardPosition(cam, dir, 10);
    expect(pos.x).toBeCloseTo(6, 6);
    expect(pos.y).toBeCloseTo(0, 6);
    expect(pos.z).toBeCloseTo(8, 6);
  });
});
