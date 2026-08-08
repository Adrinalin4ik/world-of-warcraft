/**
 * @jest-environment node
 */
import { ParticleSpline } from '../spline';

const x = (v: number) => ({ x: v, y: 0, z: 0 });

describe('ParticleSpline', () => {
  // Mirrors benilla's own arc-length test (crates/benilla-formats/src/particles.rs). Two straight
  // segments of length 1 and 3 -- control points at exact thirds, so each cubic degenerates to a
  // straight line. Arc-length parameterization puts the segment boundary at t = 0.25; indexing by
  // segment instead would put it at 0.5 and bunch three quarters of the particles onto the short
  // first segment.
  const straightChain = () => ParticleSpline.create([
    x(0), x(1 / 3), x(2 / 3), x(1), // segment 0: 1 unit long
    x(2), x(3), x(4),               // segment 1: 3 units long
  ]);

  it('places the segment boundary by arc length, not segment index', () => {
    const spline = straightChain();

    expect(spline).not.toBeNull();
    expect(spline!.eval(0.25).x).toBeCloseTo(1, 3);
  });

  it('walks the long segment proportionally', () => {
    const spline = straightChain();

    // t = 0.625 is halfway through the second segment: 1 + 3 * 0.5 = 2.5.
    expect(spline!.eval(0.625).x).toBeCloseTo(2.5, 3);
  });

  it('clamps to the endpoints outside [0, 1]', () => {
    const spline = straightChain();

    expect(spline!.eval(-0.5).x).toBeCloseTo(0, 6);
    expect(spline!.eval(1.5).x).toBeCloseTo(4, 6);
  });

  it('reports a tangent along the curve direction', () => {
    const spline = straightChain();
    const tangent = spline!.tangent(0.1);

    expect(tangent.x).toBeGreaterThan(0);
    expect(tangent.y).toBeCloseTo(0, 6);
    expect(tangent.z).toBeCloseTo(0, 6);
  });

  it('rejects a chain below one whole segment', () => {
    // A cubic chain needs 3K+1 points. Anything else is malformed data, and the emitter falls back
    // to the plane kernel rather than throwing.
    expect(ParticleSpline.create([x(0)])).toBeNull();
    expect(ParticleSpline.create([x(0), x(1), x(2)])).toBeNull();
    expect(ParticleSpline.create([])).toBeNull();
    expect(ParticleSpline.create(null)).toBeNull();
  });

  it('survives a degenerate zero-length chain', () => {
    // Every control point identical: total arc length is zero, so the normalization divisor would be
    // zero. The knots stay unnormalized rather than becoming NaN, and eval still returns the point.
    const spline = ParticleSpline.create([x(2), x(2), x(2), x(2)]);

    expect(spline).not.toBeNull();
    expect(spline!.eval(0.5).x).toBeCloseTo(2, 6);
    expect(Number.isFinite(spline!.eval(0.5).x)).toBe(true);
  });
});
