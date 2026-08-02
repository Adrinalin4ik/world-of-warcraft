/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { castCapsuleAgainstTriangles, closestDistanceCapsuleTriangle } from '../capsule-cast';
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
