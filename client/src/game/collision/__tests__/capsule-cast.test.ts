/**
 * @jest-environment node
 */
import * as THREE from 'three';

import {
  castCapsuleAgainstTriangles, closestDistanceCapsuleTriangle, depenetrateCapsule,
} from '../capsule-cast';
import { Triangle } from '../types';

const RADIUS = 1 / 3;
const HALF_SEGMENT = 2.0277777 / 2 - RADIUS;

function tri(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  normal: [number, number, number],
  source: object = {},
): Triangle {
  return {
    a: new THREE.Vector3(...a),
    b: new THREE.Vector3(...b),
    c: new THREE.Vector3(...c),
    normal: new THREE.Vector3(...normal).normalize(),
    source,
  };
}

/** A large flat floor at z = height, facing +Z. */
function floor(height: number, source: object = {}): Triangle[] {
  const s = 50;
  return [
    tri([-s, -s, height], [s, -s, height], [s, s, height], [0, 0, 1], source),
    tri([-s, -s, height], [s, s, height], [-s, s, height], [0, 0, 1], source),
  ];
}

/** A large vertical wall in the x = at plane, facing -X. */
function wall(at: number, source: object = {}): Triangle[] {
  const s = 50;
  return [
    tri([at, -s, -s], [at, s, -s], [at, s, s], [-1, 0, 0], source),
    tri([at, -s, -s], [at, s, s], [at, -s, s], [-1, 0, 0], source),
  ];
}

const cast = (
  from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, tris: Triangle[], skin = 0,
) => castCapsuleAgainstTriangles(from, dir, maxDist, RADIUS, HALF_SEGMENT, tris, skin);

describe('closestDistanceCapsuleTriangle', () => {
  it('measures the gap from the capsule SURFACE, not its axis', () => {
    const gap = closestDistanceCapsuleTriangle(
      new THREE.Vector3(0, 0, 5), HALF_SEGMENT, RADIUS, floor(0)[0],
    );

    expect(gap).toBeCloseTo(5 - HALF_SEGMENT - RADIUS, 6);
  });

  it('is negative while the capsule overlaps the face', () => {
    const gap = closestDistanceCapsuleTriangle(
      new THREE.Vector3(0, 0, 0), HALF_SEGMENT, RADIUS, floor(0)[0],
    );

    expect(gap).toBeLessThan(0);
  });
});

describe('castCapsuleAgainstTriangles', () => {
  it('stops a downward cast with the bottom cap touching the floor', () => {
    const hit = cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1), 10, floor(0));

    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5 - (HALF_SEGMENT + RADIUS), 3);
    expect(hit!.normal.z).toBeCloseTo(1, 5);
  });

  it('misses when the floor is beyond maxDist', () => {
    expect(cast(new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, -1), 1, floor(0))).toBeNull();
  });

  it('stops a horizontal cast one radius short of a wall', () => {
    const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 20, wall(10));

    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(10 - RADIUS, 3);
    expect(hit!.normal.x).toBeCloseTo(-1, 5);
  });

  it('holds the skin width back off the surface', () => {
    const from = new THREE.Vector3(0, 0, 0);
    const bare = cast(from, new THREE.Vector3(1, 0, 0), 20, wall(10), 0);
    const skinned = cast(from, new THREE.Vector3(1, 0, 0), 20, wall(10), 0.02);

    expect(skinned!.distance).toBeCloseTo(bare!.distance - 0.02, 4);
  });

  it('never reports a negative distance, even when the skin exceeds the gap', () => {
    const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 20, wall(0.34), 1.0);

    expect(hit!.distance).toBeGreaterThanOrEqual(0);
  });

  it('takes the nearest of several triangles and reports its source', () => {
    const near = {};
    const far = {};
    const hit = cast(
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 30, [...wall(15, far), ...wall(6, near)],
    );

    expect(hit!.distance).toBeCloseTo(6 - RADIUS, 3);
    expect(hit!.source).toBe(near);
  });

  it('misses a wall it travels parallel to', () => {
    const from = new THREE.Vector3(10 - RADIUS - 0.05, 0, 0);

    expect(cast(from, new THREE.Vector3(0, 1, 0), 20, wall(10))).toBeNull();
  });

  it('misses a surface it is moving away from', () => {
    expect(cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 1), 10, floor(0))).toBeNull();
  });

  it('ignores origin penetration, so a grazing body still casts outward', () => {
    // A capsule already overlapping a face -- a head grazing a ceiling -- must still be able to
    // cast. Reporting an instant hit would stop every probe dead the moment anything touched us.
    const from = new THREE.Vector3(10 - RADIUS * 0.5, 0, 0);

    expect(cast(from, new THREE.Vector3(-1, 0, 0), 20, wall(10))).toBeNull();
  });

  it('reports a ramp true normal rather than a flattened one', () => {
    const s = 50;
    const k = Math.tan(Math.PI / 6);
    const n: [number, number, number] = [-Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
    const ramp = [
      tri([-s, -s, -s * k], [s, -s, s * k], [s, s, s * k], n),
      tri([-s, -s, -s * k], [s, s, s * k], [-s, s, -s * k], n),
    ];

    const hit = cast(new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, -1), 20, ramp);

    expect(hit).not.toBeNull();
    expect(hit!.normal.z).toBeCloseTo(Math.cos(Math.PI / 6), 4);
  });

  it('still finds the floor it is RESTING on', () => {
    // The election snap lands the capsule exactly on the surface, so the gap is zero. An earlier
    // filter dropped anything at or below zero as "origin penetration", which threw away the very
    // floor the body stood on: the ground probe found nothing, the mover called itself airborne,
    // gravity pulled it deeper, and the avatar sank through the world a second after landing.
    const restingCentre = new THREE.Vector3(0, 0, HALF_SEGMENT + RADIUS);
    const hit = cast(restingCentre, new THREE.Vector3(0, 0, -1), 0.2, floor(0));

    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(0, 3);
    expect(hit!.normal.z).toBeCloseTo(1, 5);
  });

  it('does not let the floor it rests on block a horizontal step', () => {
    // The other half of the same problem: reporting that contact for a sideways sweep would pin the
    // body in place. A face the sweep runs parallel to has zero approach rate.
    const restingCentre = new THREE.Vector3(0, 0, HALF_SEGMENT + RADIUS);

    expect(cast(restingCentre, new THREE.Vector3(1, 0, 0), 0.5, floor(0))).toBeNull();
  });

  it('blocks a wall regardless of which way its winding faces', () => {
    // WoW collision faces carry no reliable outward normal, and a wall has to stop you from both
    // sides. Deriving approach from the winding would let you walk through half the world.
    const s = 50;
    const facingAway = [
      tri([10, -s, -s], [10, s, -s], [10, s, s], [1, 0, 0]),
      tri([10, -s, -s], [10, s, s], [10, -s, s], [1, 0, 0]),
    ];

    const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 20, facingAway);

    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(10 - RADIUS, 3);
    // The reported normal always opposes the motion, whichever way the face was wound.
    expect(hit!.normal.x).toBeLessThan(0);
  });

  it('keeps a floor contact normal pointing UP during a horizontal step along a slope', () => {
    // Orienting the contact normal against the direction of travel looks equivalent and is not.
    // Walking along a slope, the horizontal step closes on the floor underfoot and `dir . n` comes
    // out positive -- flipping the floor's normal to point down. walkableRideVelocity then stops
    // recognising it as ground, steepWallPlane does not apply either, and the slide dead stops:
    // the avatar cannot walk uphill at all.
    const s = 50;
    const r = (9 * Math.PI) / 180;
    const k = Math.tan(r);
    const n: [number, number, number] = [-Math.sin(r), 0, Math.cos(r)];
    const slope = [
      tri([-s, -s, -s * k], [s, -s, s * k], [s, s, s * k], n),
      tri([-s, -s, -s * k], [s, s, s * k], [-s, s, -s * k], n),
    ];

    // Resting on the slope, stepping uphill.
    const resting = new THREE.Vector3(0, 0, HALF_SEGMENT + RADIUS);
    const hit = cast(resting, new THREE.Vector3(1, 0, 0), 0.2, slope);

    if (hit) {
      expect(hit.normal.z).toBeGreaterThan(0);
      expect(hit.normal.z).toBeCloseTo(Math.cos(r), 3);
    }
  });

  it('misses on an empty candidate list', () => {
    expect(cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1), 10, [])).toBeNull();
  });

  it('does not mutate the origin or direction it is handed', () => {
    const from = new THREE.Vector3(0, 0, 5);
    const dir = new THREE.Vector3(0, 0, -1);
    cast(from, dir, 10, floor(0));

    expect(from.toArray()).toEqual([0, 0, 5]);
    expect(dir.toArray()).toEqual([0, 0, -1]);
  });
});

/**
 * PUSHING A CAPSULE OUT OF WHAT IT IS INSIDE.
 *
 * The state this exists for, measured on the abbey stairs: four slide iterations, every one
 * `travelled: 0`, all blocked at distance 0 by faces whose normal is `(~0, ~0, -1)` -- the underside
 * of a tread. A capsule touching the underside of a step is inside the step, and a sweep cannot
 * recover: it answers "what would I hit going that way", and every way is blocked.
 *
 * The assertions are the two that matter: a body genuinely inside comes out on the near side and ends
 * clear, and a body already free is left EXACTLY alone -- null, not a copy. The second is what keeps
 * this out of the ordinary frame: a caller that got a new position every frame would have to compare
 * it, and a moving body would jitter.
 */
describe('depenetrateCapsule', () => {
  const SKIN = 0.02;

  it('leaves a free capsule alone', () => {
    const free = new THREE.Vector3(0, 0, 10);
    expect(depenetrateCapsule(free, RADIUS, HALF_SEGMENT, floor(0), SKIN)).toBeNull();
  });

  it('pushes a capsule sunk into the floor back above it', () => {
    // Centre below where it can rest: the capsule bottom is HALF_SEGMENT + RADIUS under the axis, so
    // resting means centre.z = HALF_SEGMENT + RADIUS. Start a third of a yard lower than that.
    const rest = HALF_SEGMENT + RADIUS;
    const sunk = new THREE.Vector3(0, 0, rest - 0.33);
    const fixed = depenetrateCapsule(sunk, RADIUS, HALF_SEGMENT, floor(0), SKIN);

    expect(fixed).not.toBeNull();
    // Out along +Z, and clear of the surface by about the skin.
    expect(fixed!.z).toBeGreaterThan(rest);
    expect(fixed!.z).toBeLessThan(rest + 3 * SKIN);
    // And it really is free afterwards -- the property, not the arithmetic.
    expect(closestDistanceCapsuleTriangle(fixed!, HALF_SEGMENT, RADIUS, floor(0)[0]))
      .toBeGreaterThan(0);
  });

  it('pushes a capsule buried in a wall out sideways', () => {
    const buried = new THREE.Vector3(0.2, 0, 10);
    const fixed = depenetrateCapsule(buried, RADIUS, HALF_SEGMENT, wall(0), SKIN);

    expect(fixed).not.toBeNull();
    // The wall is at x = 0 and the body was on the +X side, so it comes out further +X.
    expect(fixed!.x).toBeGreaterThan(RADIUS);
    expect(fixed!.z).toBeCloseTo(10, 6);
  });
});
