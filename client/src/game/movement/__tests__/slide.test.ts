/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { castCapsuleAgainstTriangles } from '../../collision/capsule-cast';
import { CastFn } from '../../collision/collision-world';
import { CastHit, Triangle } from '../../collision/types';
import { airborneHitResponse, groundedHitResponse, moveAndSlide } from '../slide';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeTri(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  normal: [number, number, number],
): Triangle {
  return {
    a: v3(...a), b: v3(...b), c: v3(...c),
    normal: v3(...normal).normalize(), source: {},
  };
}

/** A cast that never hits anything. */
const openWorld: CastFn = () => null;

/**
 * A cast against a single infinite plane through `point` with outward `normal`.
 *
 * The capsule is treated as a point here, which is what makes the expected distances arithmetic
 * rather than geometry -- the real capsule offsets are the cast's business and are tested there.
 */
function planeCast(point: THREE.Vector3, normal: THREE.Vector3, source: object = {}): CastFn {
  return (from, dir, maxDist) => {
    const denom = dir.dot(normal);
    if (denom >= -1e-9) {
      return null; // moving away from, or along, the plane
    }
    const t = normal.dot(point.clone().sub(from)) / denom;
    if (t < 0 || t > maxDist) {
      return null;
    }

    return { distance: t, normal: normal.clone(), source } as CastHit;
  };
}

describe('moveAndSlide', () => {
  it('travels the full velocity times dt when unobstructed', () => {
    const out = moveAndSlide(openWorld, v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

    expect(out.position.x).toBeCloseTo(0.7, 6);
    expect(out.contacts).toBe(0);
  });

  it('does not move and takes no contacts on zero velocity', () => {
    const cast = planeCast(v3(1, 0, 0), v3(-1, 0, 0));
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(0, 0, 0), 0.1, groundedHitResponse);

    expect(out.position.length()).toBeCloseTo(0, 9);
    expect(out.contacts).toBe(0);
  });

  it('stops at a head-on wall', () => {
    const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, airborneHitResponse);

    expect(out.position.x).toBeCloseTo(0.3, 4);
    expect(out.contacts).toBeGreaterThanOrEqual(1);
  });

  it('deflects the remaining motion along an angled wall', () => {
    const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 7, 0), 0.1, airborneHitResponse);

    expect(out.position.x).toBeCloseTo(0.3, 3);
    expect(out.position.y).toBeGreaterThan(0.3); // the along-wall component survived
  });

  it('rides a walkable ramp at full horizontal speed rather than clipping it', () => {
    // A 45 degree ramp contacted immediately. The grounded response must preserve the horizontal
    // distance travelled (0.7), not shorten it to 0.7 * cos^2(45) = 0.35.
    const r = Math.PI / 4;
    const n = v3(-Math.sin(r), 0, Math.cos(r));
    const out = moveAndSlide(planeCast(v3(0, 0, 0), n), v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

    expect(out.position.x).toBeCloseTo(0.7, 3);
    expect(out.position.z).toBeGreaterThan(0);
  });

  it('does not let a steep face lift a grounded push', () => {
    // A 70 degree face: the true-plane clip would manufacture upward motion out of a flat push.
    const r = (70 * Math.PI) / 180;
    const n = v3(-Math.sin(r), 0, Math.cos(r));
    const out = moveAndSlide(planeCast(v3(0, 0, 0), n), v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

    expect(out.position.z).toBeCloseTo(0, 3);
  });

  it('lets the callback rewrite the normal and the velocity it is handed', () => {
    const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
    let seen = 0;
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, (hit) => {
      seen += 1;
      hit.velocity.set(0, 7, 0); // redirect entirely sideways
      hit.normal.set(0, 0, 1);
    });

    expect(seen).toBeGreaterThanOrEqual(1);
    expect(out.position.y).toBeGreaterThan(0);
  });

  it('stops cleanly when the callback zeroes the velocity', () => {
    const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, (hit) => {
      hit.velocity.set(0, 0, 0);
    });

    expect(Number.isFinite(out.position.x)).toBe(true);
    expect(out.position.x).toBeCloseTo(0.3, 4);
  });

  it('bounds the work rather than looping forever', () => {
    // A cast that always reports a zero-distance contact: a corner the slide can never escape.
    const pathological: CastFn = () => ({
      distance: 0, normal: v3(0, 0, 1), source: {},
    } as CastHit);

    const out = moveAndSlide(pathological, v3(0, 0, 0), v3(7, 0, 0), 0.1, airborneHitResponse);

    expect(out.contacts).toBeLessThanOrEqual(4);
    expect(Number.isFinite(out.position.x)).toBe(true);
  });

  it('walks a full step UP a slope, against real swept geometry', () => {
    // The uphill dead stop, end to end and against the real cast rather than a plane stub.
    //
    // Resting on a slope, the horizontal sweep legitimately contacts the rising ground ahead. The
    // ride then redirects the velocity along the plane, and the SECOND iteration must be free to
    // travel -- the surface it now moves along has ~zero approach rate. When the body rests flush
    // at a zero gap that second iteration reports the same zero-distance contact instead, and four
    // iterations pass with the avatar pinned in place.
    const r = (9 * Math.PI) / 180;
    const k = Math.tan(r);
    const s = 50;
    const n: [number, number, number] = [-Math.sin(r), 0, Math.cos(r)];
    const slope: Triangle[] = [
      makeTri([-s, -s, -s * k], [s, -s, s * k], [s, s, s * k], n),
      makeTri([-s, -s, -s * k], [s, s, s * k], [-s, s, -s * k], n),
    ];

    const RADIUS = 1 / 3;
    const HALF_SEGMENT = 2.0277777 / 2 - RADIUS;
    const slopeCast: CastFn = (from, dir, maxDist, skin = 0) => castCapsuleAgainstTriangles(
      from, dir, maxDist, RADIUS, HALF_SEGMENT, slope, skin,
    );

    // Resting a skin above the surface, as the election snap now leaves us.
    const start = new THREE.Vector3(0, 0, HALF_SEGMENT + RADIUS + 0.02);
    const dt = 1 / 60;
    const out = moveAndSlide(slopeCast, start, v3(7, 0, 0), dt, groundedHitResponse);

    const travelled = Math.hypot(out.position.x - start.x, out.position.y - start.y);

    // Full horizontal speed up a walkable slope -- the whole point of the ride rule.
    expect(travelled).toBeGreaterThan(7 * dt * 0.9);
    expect(out.position.z).toBeGreaterThan(start.z);
  });

  it('does not mutate its inputs', () => {
    const from = v3(1, 2, 3);
    const velocity = v3(7, 0, 0);
    moveAndSlide(openWorld, from, velocity, 0.1, groundedHitResponse);

    expect(from.toArray()).toEqual([1, 2, 3]);
    expect(velocity.toArray()).toEqual([7, 0, 0]);
  });

  it('never travels further than the frame velocity allows', () => {
    // A deflection redirects motion; it must never manufacture extra distance.
    const cast = planeCast(v3(0.2, 0, 0), v3(-1, 0, 0));
    const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 3, 0), 0.1, airborneHitResponse);

    const budget = v3(7, 3, 0).length() * 0.1;
    expect(out.position.length()).toBeLessThanOrEqual(budget + 1e-6);
  });
});
