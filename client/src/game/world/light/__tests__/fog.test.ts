/**
 * @jest-environment node
 */
import {
  FogTriple,
  MfogRecord,
  packFogParams,
  selectWmoFogTarget,
  stageMfog,
  unpackFogParams,
  WmoFogRamp,
  WmoFogRecord,
} from '../fog';

const scene: FogTriple = { color: [0.2, 0.2, 0.2], start: -139, end: 278 };
const room: MfogRecord = { color: [1.0, 0.5, 0.0], end: 194.4, startScalar: 0.25 };

describe('stageMfog', () => {
  it('clamps the record end to the farclip and scales start off the CLAMPED end', () => {
    const staged = stageMfog({ color: [1, 1, 1], end: 444.4, startScalar: 0.25 }, 300);
    expect(staged.end).toBeCloseTo(300, 4);
    expect(staged.start).toBeCloseTo(75, 4);
  });

  it('treats the record start as a FRACTION of end, not an absolute distance', () => {
    const staged = stageMfog({ color: [0, 0, 0], end: 200, startScalar: 0.5 }, 1000);
    expect(staged.start).toBeCloseTo(100, 4);
  });
});

describe('packFogParams / unpackFogParams', () => {
  const bands: Array<[number, number]> = [
    [125, 500],
    [0, 200],
    [400, 410], // narrow -- where a wrong denominator still looks right on a wide band
  ];

  it('round-trips start/end through pack then unpack', () => {
    for (const [start, end] of bands) {
      const [x, y] = packFogParams(start, end);
      const { start: gotStart, end: gotEnd } = unpackFogParams(x, y);
      expect(gotStart).toBeCloseTo(start, 4);
      expect(gotEnd).toBeCloseTo(end, 4);
    }
  });

  it('packs the actual shader contract: f1 = d*x + y is 1 at start and 0 at end, with x negative', () => {
    for (const [start, end] of bands) {
      const [x, y] = packFogParams(start, end);
      expect(x).toBeLessThan(0);
      expect(start * x + y).toBeCloseTo(1, 4);
      expect(end * x + y).toBeCloseTo(0, 4);
    }
  });

  it('guards the degenerate zero-width band instead of producing NaN/Infinity', () => {
    const [x, y, z, w] = packFogParams(300, 300);

    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
    expect(Number.isFinite(w)).toBe(true);
    expect(Number.isNaN(x)).toBe(false);
    expect(Number.isNaN(y)).toBe(false);

    // Round-tripping a degenerate band is not expected to recover the exact original values (the
    // span was floored, not preserved) -- what matters is that unpacking it ALSO stays finite.
    const { start, end } = unpackFogParams(x, y);
    expect(Number.isFinite(start)).toBe(true);
    expect(Number.isFinite(end)).toBe(true);
  });
});

describe('selectWmoFogTarget', () => {
  // Helper matching WMORootDefinition.createFogs's shape: pos/radiusInner/radiusOuter/flags in
  // WMO-local space, alongside the MfogRecord fields fog.ts already knows how to stage.
  const rec = (
    overrides: Partial<WmoFogRecord> = {},
  ): WmoFogRecord => ({
    color: [0, 0, 0],
    end: 200,
    startScalar: 0.25,
    pos: { x: 0, y: 0, z: 0 },
    radiusInner: 0,
    radiusOuter: 0,
    flags: 0,
    ...overrides,
  });

  it('is glue for a root with two MFOG records and a group fogOffsets that point at them: the '
    + 'engaged candidate is selected', () => {
    const fogs: WmoFogRecord[] = [
      rec({ end: 200, color: [0, 0, 0] }),
      rec({ end: 80, color: [1, 1, 1], pos: { x: 10, y: 0, z: 0 }, radiusInner: 5, radiusOuter: 25 }),
    ];

    // Camera standing exactly at the positioned record -- full weight, the room fog verbatim.
    const target = selectWmoFogTarget(fogs, [1, 0, 0, 0], { x: 10, y: 0, z: 0 });

    expect(target).not.toBeNull();
    expect(target!.end).toBeCloseTo(80, 4);
    expect(target!.color[0]).toBeCloseTo(1, 5);
  });

  it('a single-record root yields no interior fog -- the count == 1 bail', () => {
    const fogs: WmoFogRecord[] = [rec({ end: 444.4 })];

    expect(selectWmoFogTarget(fogs, [0, 0, 0, 0], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('an out-of-range offset is skipped, not treated as an abort -- the seed still resolves', () => {
    const fogs: WmoFogRecord[] = [
      rec({ end: 194.4, color: [0.5, 0.5, 0.5] }),
      rec({ end: 83.3, pos: { x: 12.3, y: -0.6, z: 2.8 }, radiusInner: 0, radiusOuter: 3.36 }),
    ];

    // Offset 7 does not index any real record on this root.
    const target = selectWmoFogTarget(fogs, [7, 0, 0, 0], { x: 0, y: 0, z: 0 });

    expect(target).not.toBeNull();
    expect(target!.end).toBeCloseTo(194.4, 4);
  });

  it('excludes an infinite-radius (flags & 1) candidate, leaving the seed', () => {
    const fogs: WmoFogRecord[] = [
      rec({ end: 194.4, color: [0.98, 0.85, 0.56] }),
      rec({ end: 83.3, flags: 1, pos: { x: 12.3, y: -0.6, z: 2.8 }, radiusOuter: 3.36 }),
    ];

    const target = selectWmoFogTarget(fogs, [1, 0, 0, 0], { x: 12.3, y: -0.6, z: 2.8 });

    expect(target).not.toBeNull();
    expect(target!.end).toBeCloseTo(194.4, 4);
  });

  it('blends a candidate toward the seed by radius-band proximity, nearest winning most', () => {
    const fogs: WmoFogRecord[] = [
      rec({ end: 200, color: [0, 0, 0] }),
      rec({ end: 80, color: [1, 1, 1], pos: { x: 10, y: 0, z: 0 }, radiusInner: 5, radiusOuter: 25 }),
    ];

    // Half-way through the falloff band (d = 15 -> weight 0.5) -> the midpoint.
    const midpoint = selectWmoFogTarget(fogs, [1, 0, 0, 0], { x: 25, y: 0, z: 0 });
    expect(midpoint!.end).toBeCloseTo(140, 3);

    // Beyond the outer radius -> the seed alone.
    const outOfBand = selectWmoFogTarget(fogs, [1, 0, 0, 0], { x: 40, y: 0, z: 0 });
    expect(outOfBand!.end).toBeCloseTo(200, 4);
  });

  it('a root with no MFOG records at all yields no interior fog', () => {
    expect(selectWmoFogTarget([], [0, 0, 0, 0], { x: 0, y: 0, z: 0 })).toBeNull();
    expect(selectWmoFogTarget(null, [0, 0, 0, 0], { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('WmoFogRamp', () => {
  it('fades in over four seconds', () => {
    const ramp = new WmoFogRamp();
    const half = ramp.blend(room, scene, 1000, 2);
    expect(half.end).toBeCloseTo(scene.end + (room.end - scene.end) * 0.5, 3);
    const full = ramp.blend(room, scene, 1000, 2);
    expect(full.end).toBeCloseTo(room.end, 3);
    expect(full.color[0]).toBeCloseTo(1.0, 5);
  });

  it('latches the staged fog so leaving fades FROM the room, not from nothing', () => {
    const ramp = new WmoFogRamp();
    ramp.blend(room, scene, 1000, 4);
    // No target now -- but the room's fog must still be the thing we fade away from.
    const out = ramp.blend(null, scene, 1000, 2);
    expect(out.end).toBeCloseTo(scene.end + (room.end - scene.end) * 0.5, 3);
  });

  it('returns the scene triple verbatim once fully faded out, and releases the latch', () => {
    const ramp = new WmoFogRamp();
    ramp.blend(room, scene, 1000, 4);
    ramp.blend(null, scene, 1000, 2);
    const out = ramp.blend(null, scene, 1000, 2);
    expect(out).toEqual(scene);
    expect(ramp.blend(null, scene, 1000, 2)).toEqual(scene);
  });

  it('is the scene triple while the camera has never been inside', () => {
    const ramp = new WmoFogRamp();
    expect(ramp.blend(null, scene, 1000, 0.016)).toEqual(scene);
  });

  it('re-stages the latched record against farclip on every call, not just on entry', () => {
    const ramp = new WmoFogRamp();
    // Fade fully in with a farclip that does NOT clamp the room's 194.4 end.
    ramp.blend(room, scene, 1000, 4);
    // A farclip change while still latched (e.g. the view-distance slider) -- 100 DOES clamp.
    const clamped = ramp.blend(room, scene, 100, 0);
    expect(clamped.end).toBeCloseTo(100, 4);
  });
});
