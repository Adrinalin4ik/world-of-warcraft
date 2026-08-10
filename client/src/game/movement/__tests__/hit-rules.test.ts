/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { steepWallPlane, walkableRideVelocity } from '../slide';

/**
 * Ported from the reference's own suite (`player/mover.rs`), Z-up.
 *
 * These two rules are what make a walkable slope feel like flat ground and a steep face feel like a
 * wall. Both failure modes they prevent were real: half speed walking uphill, and a capsule
 * ratcheting up a tree trunk.
 */

/** Outward normal of a face rising toward +x, tilted `deg` from horizontal. Z-up. */
function face(deg: number): THREE.Vector3 {
  const r = (deg * Math.PI) / 180;
  return new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('walkableRideVelocity', () => {
  it('rides a walkable ramp at full horizontal speed', () => {
    // 45 degrees uphill at run speed: the ride keeps the 2D velocity exactly -- the true-plane clip
    // would halve it to h * cos^2(45) = 3.5 -- and lies in the plane, so the clip passes it.
    const n = face(45);
    const ride = walkableRideVelocity(n, v3(7, 0, 0));

    expect(ride).not.toBeNull();
    expect(ride!.x).toBeCloseTo(7, 6);
    expect(ride!.y).toBeCloseTo(0, 6);
    expect(ride!.z).toBeGreaterThan(0);
    expect(Math.abs(ride!.dot(n))).toBeLessThan(1e-6);
  });

  it('does not deflect a diagonal approach', () => {
    // Walking diagonally up a face rising toward +x: the true-plane clip bends the path toward
    // across-slope; the ride keeps both horizontal components untouched.
    const ride = walkableRideVelocity(face(40), v3(5, 5, 0));

    expect(ride!.x).toBeCloseTo(5, 6);
    expect(ride!.y).toBeCloseTo(5, 6);
  });

  it('recomputes a prior facet ride rather than stacking it', () => {
    // Crossing a facet boundary mid-slide: the incoming vertical (facet A's ride) is discarded and
    // rebuilt for facet B. The grounded mover owns no vertical of its own.
    const n = face(45);
    const ride = walkableRideVelocity(n, v3(7, 0, 3));

    expect(ride!.x).toBeCloseTo(7, 6);
    expect(ride!.y).toBeCloseTo(0, 6);
    expect(Math.abs(ride!.dot(n))).toBeLessThan(1e-6);
  });

  it('never rides a steep, flat or receding plane', () => {
    const push = v3(7, 0, 0);

    expect(walkableRideVelocity(face(60), push)).toBeNull();          // steep: the wall rule's
    expect(walkableRideVelocity(v3(0, 0, 1), push)).toBeNull();       // flat floor: no opposition
    expect(walkableRideVelocity(face(40), push.clone().negate())).toBeNull(); // receding
  });

  it('covers the walkable range right up to the gate', () => {
    const v = v3(7, 0, 0);
    const ride = walkableRideVelocity(face(49.9), v);

    expect(ride!.x).toBeCloseTo(7, 6);
    expect(ride!.z).toBeLessThanOrEqual(7 * Math.tan((50 * Math.PI) / 180) + 1e-3);
    expect(walkableRideVelocity(face(50.1), v)).toBeNull();
    expect(steepWallPlane(face(50.1), v)).not.toBeNull();
  });

  it('preserves horizontal SPEED, which is the invariant that matters', () => {
    // Restating the rule's purpose in its own terms: on every walkable surface the 2D speed is the
    // run speed. The true-plane clip fails this at every angle; the ride holds it.
    for (const deg of [5, 20, 35, 45, 49]) {
      const ride = walkableRideVelocity(face(deg), v3(7, 0, 0))!;
      expect(Math.hypot(ride.x, ride.y)).toBeCloseTo(7, 6);
    }
  });
});

describe('steepWallPlane', () => {
  it('clips a walk into a steep face as a wall', () => {
    const wall = steepWallPlane(face(60), v3(7, 0, 0));

    expect(wall).not.toBeNull();
    expect(wall!.z).toBeCloseTo(0, 9);
    expect(wall!.x).toBeLessThan(0);
    expect(wall!.length()).toBeCloseTo(1, 6);
  });

  it('flattens the wedge-misfire window', () => {
    // Falling slowly with locked forward momentum: the true-plane clip would end RISING -- the
    // descent-cancel that tripped the wedge rest into landing mid-face.
    expect(steepWallPlane(face(60), v3(7, 0, -1.3))).not.toBeNull();
  });

  it('keeps the true plane for a real fall', () => {
    // The natural slide down a steep surface must survive: descent-dominated clips stay on the true
    // plane, because flattening them hovers the fall mid-face.
    expect(steepWallPlane(face(60), v3(0, 0, -10))).toBeNull();
    expect(steepWallPlane(face(60), v3(7, 0, -20))).toBeNull();
  });

  it('removes the face manufactured boost but keeps the mover own lift', () => {
    // A jump rising along the face: the flatten removes the boost the plane would manufacture; the
    // mover's own +vz passes through the vertical wall untouched.
    const v = v3(7, 0, 8);
    const wall = steepWallPlane(face(60), v)!;
    const clipped = v.clone().sub(wall.clone().multiplyScalar(v.dot(wall)));

    expect(clipped.z).toBeCloseTo(v.z, 6);
  });

  it('leaves walkable, overhanging and receding faces alone', () => {
    const push = v3(7, 0, 0);

    expect(steepWallPlane(face(40), push)).toBeNull();                        // ordinary uphill
    expect(steepWallPlane(v3(-0.5, 0, -0.7).normalize(), push)).toBeNull();    // overhang
    expect(steepWallPlane(face(60), push.clone().negate())).toBeNull();        // receding
  });

  it('has nothing to fix on a truly vertical wall', () => {
    // An exactly vertical normal manufactures no lift, so the rule declines. Note `face(90)` is NOT
    // this case: cos(90 degrees) is 6.1e-17 in floating point, so it reads as very slightly
    // overhanging-free steep rather than vertical.
    expect(steepWallPlane(v3(-1, 0, 0), v3(7, 0, 0))).toBeNull();
  });

  it('is harmless on a near-vertical wall, where the flatten IS the true plane', () => {
    // The floating-point neighbourhood of vertical does engage the rule, and that costs nothing:
    // the plane it returns is the one the clip would have used anyway.
    const almost = face(90);
    const wall = steepWallPlane(almost, v3(7, 0, 0))!;

    expect(wall.x).toBeCloseTo(almost.x, 9);
    expect(wall.y).toBeCloseTo(almost.y, 9);
    expect(wall.z).toBeCloseTo(0, 9);
  });

  it('never manufactures lift across the whole steep range', () => {
    // The climbing ratchet, stated as the property: for every steep angle, a horizontal push
    // clipped against the returned plane must not gain height.
    for (const deg of [51, 60, 70, 80, 89]) {
      const v = v3(7, 0, 0);
      const wall = steepWallPlane(face(deg), v)!;
      const clipped = v.clone().sub(wall.clone().multiplyScalar(v.dot(wall)));
      expect(clipped.z).toBeCloseTo(0, 9);
    }
  });
});
