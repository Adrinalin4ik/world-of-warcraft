import {
  billboardPosition,
  CELESTIAL_DISTANCE,
  horizonClipFade,
  HORIZON_FADE_SCALE,
  viewLerp,
  flareHorizonGate,
  flareSlew,
  SUN_FLARE_RISE,
  MOON_FLARE_RISE,
  FLARE_FALL,
} from '../laws';

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

describe('viewLerp (celestial-sky plan, Task 5 -- the glare lens-flare view lerp)', () => {
  it('is 0 looking straight at the body\'s opposite (cosTheta = -1)', () => {
    expect(viewLerp({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBe(0);
  });

  it('is 0 up to cosTheta = 0.7 (~45 degrees off the body)', () => {
    expect(viewLerp({ x: 1, y: 0, z: 0 }, { x: 0.7, y: Math.sqrt(1 - 0.49), z: 0 })).toBeCloseTo(0, 6);
    expect(viewLerp({ x: 1, y: 0, z: 0 }, { x: 0.5, y: Math.sqrt(0.75), z: 0 })).toBe(0);
  });

  it('is 1 looking dead-on at the body (cosTheta = 1)', () => {
    expect(viewLerp({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(1);
  });

  it('ramps linearly across the [0.7, 1.0] cosTheta band', () => {
    // cosTheta = 0.85 is halfway across the [0.7, 1.0] band -> f = 0.5.
    expect(viewLerp({ x: 1, y: 0, z: 0 }, { x: 0.85, y: Math.sqrt(1 - 0.7225), z: 0 })).toBeCloseTo(0.5, 5);
  });
});

describe('flareHorizonGate (celestial-sky plan, Task 5 -- the glare\'s own below-horizon smoothstep)', () => {
  it('is 0 at and below the horizon', () => {
    expect(flareHorizonGate(0)).toBe(0);
    expect(flareHorizonGate(-0.1)).toBe(0);
  });

  it('is 1 well above the ~2-degree gate band', () => {
    expect(flareHorizonGate(0.035)).toBeCloseTo(1, 6);
    expect(flareHorizonGate(0.5)).toBe(1);
  });

  it('smoothsteps (not linearly ramps) inside the band', () => {
    const half = flareHorizonGate(0.0175); // dirZ/0.035 = 0.5
    // smoothstep(0.5) = 0.5*0.5*(3-1) = 0.5, but the curve is NOT linear either side of it.
    expect(half).toBeCloseTo(0.5, 6);
    const quarter = flareHorizonGate(0.00875); // dirZ/0.035 = 0.25
    // Smoothstep flattens near its ends, so t=0.25 reads BELOW the linear 0.25 a plain lerp would give.
    expect(quarter).toBeLessThan(0.25);
  });
});

describe('flareSlew (celestial-sky plan, Task 5 -- the asymmetric linear envelope slew)', () => {
  it('rises at the caller-supplied rate, capped at the step', () => {
    expect(flareSlew(0, 1, SUN_FLARE_RISE, FLARE_FALL, 0.1)).toBeCloseTo(0.4, 6); // 4.0 * 0.1
  });

  it('falls at the shared (slower) rate regardless of the rise rate passed', () => {
    const fell = flareSlew(1, 0, SUN_FLARE_RISE, FLARE_FALL, 0.1);
    expect(fell).toBeCloseTo(1 - FLARE_FALL * 0.1, 6);
  });

  it('never overshoots the target', () => {
    expect(flareSlew(0.9, 1, SUN_FLARE_RISE, FLARE_FALL, 1)).toBe(1);
    expect(flareSlew(0.1, 0, SUN_FLARE_RISE, FLARE_FALL, 1)).toBe(0);
  });

  it('the moon rises slower than the sun', () => {
    expect(MOON_FLARE_RISE).toBeLessThan(SUN_FLARE_RISE);
    expect(MOON_FLARE_RISE).toBeCloseTo(100 / 33, 4);
  });
});
