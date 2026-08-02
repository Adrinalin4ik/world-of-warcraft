/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAM_DIST_DEFAULT, createCameraControl, seatCamera } from '../rig';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const openWorld: CastFn = () => null;

/** A cast that reports an obstruction `at` yards along any sweep. */
const blockedAt = (at: number): CastFn => (_from, _dir, maxDist) => (
  at <= maxDist ? ({ distance: at, normal: v3(0, 0, 1), source: {} } as CastHit) : null
);

const PIVOT_HEIGHT = 1.9;
const HEAD_Z = 1.7;

function seat(rig: ReturnType<typeof createCameraControl>, cast: CastFn, dt = 1 / 60) {
  return seatCamera(rig, {
    feet: v3(0, 0, 0),
    head: v3(0, 0, HEAD_Z),
    pivotHeight: PIVOT_HEIGHT,
    cast,
    dt,
  });
}

const pivot = () => v3(0, 0, PIVOT_HEIGHT);

describe('seatCamera', () => {
  it('sits the full zoom distance behind the pivot when unobstructed', () => {
    const rig = createCameraControl();
    const out = seat(rig, openWorld, 1.0);

    expect(out.position.distanceTo(pivot())).toBeCloseTo(CAM_DIST_DEFAULT, 2);
  });

  it('looks at the pivot', () => {
    const rig = createCameraControl();
    const out = seat(rig, openWorld, 1.0);

    // The camera's -Z axis (its forward) should point at the pivot.
    const forward = v3(0, 0, -1).applyQuaternion(out.quaternion);
    const toPivot = pivot().sub(out.position).normalize();

    expect(forward.dot(toPivot)).toBeCloseTo(1, 4);
  });

  it('pulls in immediately when geometry intrudes', () => {
    // A wall must never sit between the camera and the character, so pull-in is instant.
    const rig = createCameraControl();
    const out = seat(rig, blockedAt(3), 1 / 60);

    expect(out.position.distanceTo(pivot())).toBeLessThan(CAM_DIST_DEFAULT);
    expect(rig.collisionDistance).toBeLessThanOrEqual(3.01);
  });

  it('eases back out rather than snapping', () => {
    const rig = createCameraControl();
    seat(rig, blockedAt(3), 1 / 60);
    const pulled = rig.collisionDistance;

    seat(rig, openWorld, 1 / 60); // obstruction cleared
    const afterOne = rig.collisionDistance;

    expect(afterOne).toBeGreaterThan(pulled);
    expect(afterOne).toBeLessThan(CAM_DIST_DEFAULT); // did not snap all the way back
  });

  it('preserves the chosen zoom while obstructed', () => {
    // collisionDistance is separate from distance precisely so the player's zoom survives.
    const rig = createCameraControl();
    seat(rig, blockedAt(2), 1 / 60);

    expect(rig.distance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
    expect(rig.collisionDistance).toBeLessThan(CAM_DIST_DEFAULT);
  });

  it('roots the boom at the head, not the pivot', () => {
    // Body collision keeps the head inside the room -- even mid-jump it cannot pass the ceiling --
    // so a boom swept from the head can never end up on the far side of a wall. Rooting it at the
    // pivot instead is what pushes the camera through the roof on a jump in a low room.
    const rig = createCameraControl();
    const origins: THREE.Vector3[] = [];
    const spy: CastFn = (from) => {
      origins.push(from.clone());
      return null;
    };

    seat(rig, spy, 1 / 60);

    expect(origins.length).toBeGreaterThan(0);
    expect(origins[0].z).toBeCloseTo(HEAD_Z, 6);
  });

  it('lets collision win outright, with no minimum-distance floor', () => {
    const rig = createCameraControl();
    seat(rig, blockedAt(0.2), 1 / 60);

    expect(rig.collisionDistance).toBeLessThanOrEqual(0.21);
  });

  it('sits on the pivot at zoom zero, with the avatar faded out', () => {
    // Do NOT pre-set collisionDistance: the head-to-pivot boom is shorter than the current arm, so
    // the rig's own instant pull-in takes it there in one frame. Forcing it to 0 first would
    // measure the ease-OUT instead, which is a camera mid-glide rather than a settled one.
    const rig = createCameraControl();
    rig.distance = 0;
    rig.targetDistance = 0;

    const out = seat(rig, openWorld, 1 / 60);

    expect(out.position.distanceTo(pivot())).toBeLessThan(0.05);
    expect(rig.selfFadeAlpha).toBeCloseTo(0, 3);
  });

  it('thins the avatar when a wall pulls the boom in', () => {
    // The fade is keyed off the REALIZED camera-to-pivot distance, collision-pulled -- which is the
    // faithful behaviour rather than an accident of zoom.
    const rig = createCameraControl();
    seat(rig, blockedAt(0.5), 1 / 60);

    expect(rig.selfFadeAlpha).toBeLessThan(1);
  });

  it('follows the yaw around the character', () => {
    const rig = createCameraControl();
    const behind = seat(rig, openWorld, 1.0).position.clone();

    rig.yaw = Math.PI;
    const opposite = seat(rig, openWorld, 1.0).position;

    expect(opposite.x).toBeCloseTo(-behind.x, 3);
    expect(opposite.y).toBeCloseTo(-behind.y, 3);
  });
});
