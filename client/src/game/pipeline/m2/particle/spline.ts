/**
 * A SPLINE (emitterType 3) emitter's authored curve.
 *
 * `M2Particle.splinePoints` is a flattened **cubic Bezier chain**: K segments over 3K+1 control
 * points, laid out `P, outTangent, inTangent, P, outTangent, inTangent, P, ...` so consecutive
 * segments share their endpoint.
 *
 * The chain is **arc-length parameterized**. The reference client computes per-segment arc lengths
 * into a knot array when the model loads -- the knots are not on disk -- and the spawn kernel's
 * `t` then walks the chain by *normalized arc length* rather than by segment index. That distinction
 * is the whole point: a chain whose first segment is 1 yard and second is 3 yards puts its segment
 * boundary at t = 0.25, not t = 0.5, so particles are distributed evenly along the curve instead of
 * bunching up on the short segment.
 *
 * Per-segment length here is a 16-chord subdivision. The reference's own method is untraced, but any
 * smooth-curve length approximation lands within a fraction of a percent of it.
 *
 * Cross-checked against samples/benilla (crates/benilla-formats/src/particles.rs, `SplineData`).
 */
export class ParticleSpline {

  /** Chords per segment used to approximate its arc length. */
  static LENGTH_SUBDIVISIONS = 16;

  /** Control points in model-local WoW axes, 3K+1 of them. */
  readonly points: ReadonlyArray<{ x: number; y: number; z: number }>;

  /** Cumulative normalized arc length at each segment boundary: K+1 entries running 0 -> 1. */
  private readonly knots: number[];

  private constructor(
    points: ReadonlyArray<{ x: number; y: number; z: number }>, knots: number[],
  ) {
    this.points = points;
    this.knots = knots;
  }

  /**
   * Build from raw control points, or return null when they cannot form at least one whole cubic
   * segment. A malformed or absent chain is ordinary in game data, and the caller falls back to the
   * plane kernel rather than treating it as an error.
   */
  static create(rawPoints: any): ParticleSpline | null {
    if (!rawPoints || !rawPoints.length) {
      return null;
    }

    const points = [];
    for (const point of rawPoints) {
      if (!point || !isFinite(point.x) || !isFinite(point.y) || !isFinite(point.z)) {
        return null;
      }
      points.push({ x: point.x, y: point.y, z: point.z });
    }

    const segments = (points.length - 1) / 3;
    if (segments < 1 || points.length !== 3 * segments + 1) {
      return null;
    }

    const knots = [0];
    for (let segment = 0; segment < segments; segment++) {
      const base = segment * 3;
      let length = 0;
      let previous = ParticleSpline.bezier(points, base, 0);

      for (let step = 1; step <= ParticleSpline.LENGTH_SUBDIVISIONS; step++) {
        const current = ParticleSpline.bezier(
          points, base, step / ParticleSpline.LENGTH_SUBDIVISIONS,
        );
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const dz = current.z - previous.z;
        length += Math.sqrt(dx * dx + dy * dy + dz * dz);
        previous = current;
      }

      knots.push(knots[segment] + length);
    }

    const total = knots[knots.length - 1];
    if (total > 0) {
      for (let i = 0; i < knots.length; i++) {
        knots[i] /= total;
      }
    }

    return new ParticleSpline(points, knots);
  }

  private static bezier(
    points: ReadonlyArray<{ x: number; y: number; z: number }>, base: number, u: number,
  ) {
    const v = 1 - u;
    const w0 = v * v * v;
    const w1 = 3 * u * v * v;
    const w2 = 3 * u * u * v;
    const w3 = u * u * u;

    const p0 = points[base];
    const p1 = points[base + 1];
    const p2 = points[base + 2];
    const p3 = points[base + 3];

    return {
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
      z: w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z,
    };
  }

  private static bezierDerivative(
    points: ReadonlyArray<{ x: number; y: number; z: number }>, base: number, u: number,
  ) {
    const v = 1 - u;
    const w0 = -3 * v * v;
    const w1 = 3 * v * (1 - 3 * u);
    const w2 = 3 * u * (2 - 3 * u);
    const w3 = 3 * u * u;

    const p0 = points[base];
    const p1 = points[base + 1];
    const p2 = points[base + 2];
    const p3 = points[base + 3];

    return {
      x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
      y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
      z: w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z,
    };
  }

  /** Locate the segment and its local parameter for a normalized arc fraction. */
  private locate(t: number): { segment: number; u: number } {
    const last = this.knots.length - 1;

    let segment = last - 1;
    for (let i = 1; i < last; i++) {
      if (t < this.knots[i]) {
        segment = i - 1;
        break;
      }
    }

    const a = this.knots[segment];
    const b = this.knots[segment + 1];
    const span = Math.max(b - a, 1e-6);

    return { segment, u: Math.min(Math.max((t - a) / span, 0), 1) };
  }

  /** The curve point at arc fraction `t`, clamped to the endpoints outside [0, 1]. */
  eval(t: number) {
    if (t <= 0) {
      return { ...this.points[0] };
    }
    if (t >= 1) {
      return { ...this.points[this.points.length - 1] };
    }

    const { segment, u } = this.locate(t);
    return ParticleSpline.bezier(this.points, segment * 3, u);
  }

  /** The unnormalized curve tangent at arc fraction `t`. Callers renormalize. */
  tangent(t: number) {
    const { segment, u } = this.locate(Math.min(Math.max(t, 0), 1));
    return ParticleSpline.bezierDerivative(this.points, segment * 3, u);
  }

}
