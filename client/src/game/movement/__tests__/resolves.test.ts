/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT, STEP_SLOPE_RATIO, STEP_SNAP_SLACK } from '../constants';
import { airborneStep, groundedStep } from '../mover';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);

/** No geometry anywhere. */
const empty: CastFn = () => null;

/**
 * A cast that only answers DOWNWARD probes, with a floor `drop` below the probe origin. Horizontal
 * probes miss, so the step-up finds no obstacle and the slide runs unobstructed -- which isolates
 * the election snap.
 */
function floorBelow(drop: number, normal = UP, source: object = {}): CastFn {
  return (_from, dir, maxDist) => {
    if (dir.z > -0.5) return null;
    if (drop > maxDist) return null;

    return { distance: drop, normal: normal.clone(), source } as CastHit;
  };
}

describe('groundedStep', () => {
  it('travels the full horizontal distance when unobstructed', () => {
    const out = groundedStep(empty, v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.center.x).toBeCloseTo(0.7, 5);
    expect(out.center.z).toBeCloseTo(10, 5);
    expect(out.climb).toBeNull();
    expect(out.ground).toBeNull();
  });

  it('follows a floor down and reports what it stood on', () => {
    const ground = {};
    const out = groundedStep(floorBelow(0.4, UP, ground), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.center.z).toBeCloseTo(10 - 0.4, 5);
    expect(out.ground).toBe(ground);
    expect(out.snap).not.toBeNull();
  });

  it('scales the snap reach with horizontal travel plus the collision height', () => {
    const out = groundedStep(floorBelow(0.1), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    const expected = 0.7 * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT;
    expect(out.snap!.reach).toBeCloseTo(expected, 5);
  });

  it('still re-grounds an idle body standing still', () => {
    const out = groundedStep(floorBelow(0.01), v3(0, 0, 10), v3(0, 0, 0), 0.1);

    expect(out.snap!.reach).toBeCloseTo(STEP_SNAP_SLACK + CAPSULE_HEIGHT, 5);
    expect(out.center.z).toBeCloseTo(10 - 0.01, 5);
  });

  it('makes the absorbed SLOPE the constant, not the absorbed distance', () => {
    // Twice the travel means twice the reach, so the same hillside is followed at any frame rate.
    const slow = groundedStep(floorBelow(0.01), v3(0, 0, 10), v3(3.5, 0, 0), 0.1);
    const fast = groundedStep(floorBelow(0.01), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    const slowSlopeTerm = slow.snap!.reach - STEP_SNAP_SLACK - CAPSULE_HEIGHT;
    const fastSlopeTerm = fast.snap!.reach - STEP_SNAP_SLACK - CAPSULE_HEIGHT;
    expect(fastSlopeTerm).toBeCloseTo(slowSlopeTerm * 2, 5);
  });

  it('does not absorb a floor deeper than the reach -- that gap becomes a fall', () => {
    const deep = 0.7 * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT + 5;
    const out = groundedStep(floorBelow(deep), v3(0, 0, 100), v3(7, 0, 0), 0.1);

    expect(out.center.z).toBeCloseTo(100, 5);
    expect(out.ground).toBeNull();
  });

  it('does not absorb a steep floor either, but still reports the probe', () => {
    const r = (70 * Math.PI) / 180;
    const steep = v3(-Math.sin(r), 0, Math.cos(r));
    const out = groundedStep(floorBelow(0.4, steep), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.center.z).toBeCloseTo(10, 5);
    expect(out.ground).toBeNull();
    // Reporting the probe is what makes a feel report diagnosable.
    expect(out.snap!.hit).not.toBeNull();
    expect(out.snap!.hit!.normalZ).toBeCloseTo(Math.cos(r), 4);
  });

  it('reports a missed snap as a miss, not as a zero-distance hit', () => {
    // "reach 3.10, hit none" is a fall about to start; "reach 3.10, hit at 0.00" is standing on the
    // floor. Confusing them sends a diagnosis in exactly the wrong direction.
    const out = groundedStep(empty, v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.snap).not.toBeNull();
    expect(out.snap!.hit).toBeNull();
  });

  it('lets a committed step-up BE the frame, skipping the slide and the snap', () => {
    const r = (70 * Math.PI) / 180;
    const steepFace = v3(-Math.sin(r), 0, Math.cos(r));
    let horizontalProbes = 0;

    const cast: CastFn = (_from, dir) => {
      if (dir.z > 0.5) return null;
      if (dir.z < -0.5) return { distance: 0.4, normal: UP, source: {} } as CastHit;
      horizontalProbes += 1;
      return horizontalProbes === 1
        ? ({ distance: 0.05, normal: steepFace, source: {} } as CastHit)
        : null;
    };

    const out = groundedStep(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1);

    expect(out.climb).not.toBeNull();
    expect(out.climb!).toBeGreaterThan(0);
    expect(out.stepUpVerdict).toBe('commit');
    expect(out.snap).toBeNull();
  });

  it('carries the step-up verdict through even when it did not commit', () => {
    // The verdict is the whole diagnosis of a stuck report, so it must survive the fall-through.
    const out = groundedStep(floorBelow(0.1), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.stepUpVerdict).toBe('no-obstacle');
  });
});

describe('airborneStep', () => {
  it('is the arc slide and nothing else', () => {
    const out = airborneStep(empty, v3(0, 0, 10), v3(7, 0, -5), 0.1);

    expect(out.x).toBeCloseTo(0.7, 5);
    expect(out.z).toBeCloseTo(9.5, 5);
  });

  it('never snaps down onto a floor below it', () => {
    // The arc owns its own height: landing is next frame's ground probe to decide, not this one's.
    const out = airborneStep(floorBelow(0.4), v3(0, 0, 10), v3(7, 0, 0), 0.1);

    expect(out.z).toBeCloseTo(10, 5);
  });
});

describe('both resolves', () => {
  it('do not mutate their inputs', () => {
    const center = v3(1, 2, 3);
    const vel = v3(7, 0, 0);
    groundedStep(empty, center, vel, 0.1);
    airborneStep(empty, center, vel, 0.1);

    expect(center.toArray()).toEqual([1, 2, 3]);
    expect(vel.toArray()).toEqual([7, 0, 0]);
  });
});
