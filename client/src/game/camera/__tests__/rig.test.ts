/**
 * @jest-environment node
 */
import { CAM_PIVOT_FALLBACK, CAM_PIVOT_FLOOR, headHeight } from '../pivot';
import {
  advanceZoom, applyLookDelta, applyZoomScroll, CAM_DIST_DEFAULT, CAM_DIST_MAX, CAM_DIST_MIN,
  CAM_MOVE_SPEED, CAM_NEAR, CAM_PITCH_LIMIT, createCameraControl, LOOK_SENSITIVITY, selfFadeAlpha,
} from '../rig';

describe('headHeight', () => {
  it('scales a model-derived pivot with the avatar', () => {
    // The pivot is about neck height on every character -- roughly 1.90 for a human, 0.88 for a
    // gnome. A fixed height rides high on short races, which is why this is not a constant.
    expect(headHeight(1.8, 1.0)).toBeCloseTo(1.8, 6);
    expect(headHeight(1.8, 0.5)).toBeCloseTo(0.9, 6);
    expect(headHeight(2.0, 1.15)).toBeCloseTo(2.3, 6);
  });

  it('floors the pivot so it never sits on the ground', () => {
    expect(headHeight(0.1, 1.0)).toBeCloseTo(CAM_PIVOT_FLOOR, 6);
    expect(headHeight(0, 1.0)).toBeCloseTo(CAM_PIVOT_FLOOR, 6);
    expect(CAM_PIVOT_FLOOR).toBeCloseTo(5 / 6, 6);
  });

  it('uses a neck-height fallback before the body attaches', () => {
    expect(headHeight(null, 1.0)).toBeCloseTo(CAM_PIVOT_FALLBACK, 6);
    expect(headHeight(null, 0.5)).toBeCloseTo(CAM_PIVOT_FALLBACK, 6);
  });
});

describe('the zoom', () => {
  it('starts at the default, already settled', () => {
    const rig = createCameraControl();

    expect(rig.distance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
    expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
    expect(CAM_DIST_DEFAULT).toBe(15);
  });

  it('moves the target one yard per wheel notch', () => {
    const rig = createCameraControl();

    applyZoomScroll(rig, 1);
    expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT - 1, 6);

    applyZoomScroll(rig, -3);
    expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT + 2, 6);
  });

  it('clamps to the vanilla range, first person included', () => {
    const rig = createCameraControl();

    applyZoomScroll(rig, 100);
    expect(rig.targetDistance).toBeCloseTo(CAM_DIST_MIN, 6);
    expect(CAM_DIST_MIN).toBe(0); // zoom-to-first-person

    applyZoomScroll(rig, -100);
    expect(rig.targetDistance).toBeCloseTo(CAM_DIST_MAX, 6);
    expect(CAM_DIST_MAX).toBe(30);
  });

  it('glides at a CONSTANT speed, not an exponential ease', () => {
    const rig = createCameraControl();
    rig.targetDistance = CAM_DIST_DEFAULT + 10;

    const before = rig.distance;
    advanceZoom(rig, 0.1);
    const firstStep = rig.distance - before;

    const mid = rig.distance;
    advanceZoom(rig, 0.1);
    const secondStep = rig.distance - mid;

    expect(firstStep).toBeCloseTo(CAM_MOVE_SPEED * 0.1, 5);
    expect(secondStep).toBeCloseTo(firstStep, 5);
  });

  it('lands exactly on the target and stops', () => {
    const rig = createCameraControl();
    rig.targetDistance = CAM_DIST_DEFAULT + 0.1;

    advanceZoom(rig, 1.0);
    expect(rig.distance).toBeCloseTo(rig.targetDistance, 9);

    advanceZoom(rig, 1.0);
    expect(rig.distance).toBeCloseTo(rig.targetDistance, 9);
  });

  it('glides inward as well as outward', () => {
    const rig = createCameraControl();
    rig.targetDistance = CAM_DIST_DEFAULT - 5;

    advanceZoom(rig, 0.1);

    expect(rig.distance).toBeLessThan(CAM_DIST_DEFAULT);
    expect(rig.distance).toBeCloseTo(CAM_DIST_DEFAULT - CAM_MOVE_SPEED * 0.1, 5);
  });
});

describe('the look deltas', () => {
  it('rotate yaw and pitch at the look sensitivity', () => {
    const rig = createCameraControl();
    const yawDelta = applyLookDelta(rig, 100, 0);

    expect(Math.abs(yawDelta)).toBeCloseTo(100 * LOOK_SENSITIVITY, 6);
    expect(rig.yaw).toBeCloseTo(yawDelta, 6);
  });

  it('clamp pitch at the verified 89 degrees, both ways', () => {
    const rig = createCameraControl();

    applyLookDelta(rig, 0, 100000);
    expect(Math.abs(rig.pitch)).toBeCloseTo(CAM_PITCH_LIMIT, 6);

    applyLookDelta(rig, 0, -200000);
    expect(Math.abs(rig.pitch)).toBeCloseTo(CAM_PITCH_LIMIT, 6);

    expect(CAM_PITCH_LIMIT).toBeCloseTo((89 * Math.PI) / 180, 6);
    expect(CAM_PITCH_LIMIT).toBeCloseTo(1.5533430576, 6);
  });

  it('apply the same clamp at every zoom level', () => {
    // The reference has NO distinct first-person look-down limit.
    const zoomedOut = createCameraControl();
    const firstPerson = createCameraControl();
    firstPerson.distance = 0;
    firstPerson.targetDistance = 0;

    applyLookDelta(zoomedOut, 0, 100000);
    applyLookDelta(firstPerson, 0, 100000);

    expect(firstPerson.pitch).toBeCloseTo(zoomedOut.pitch, 9);
  });

  it('do not wrap or clamp yaw -- it orbits freely', () => {
    const rig = createCameraControl();
    for (let i = 0; i < 10; ++i) {
      applyLookDelta(rig, 1000, 0);
    }

    expect(Math.abs(rig.yaw)).toBeGreaterThan(2 * Math.PI);
  });
});

describe('selfFadeAlpha', () => {
  it('is opaque in third person and gone at the pivot', () => {
    expect(selfFadeAlpha(CAM_DIST_DEFAULT)).toBeCloseTo(1, 6);
    expect(selfFadeAlpha(0)).toBeCloseTo(0, 6);
    expect(selfFadeAlpha(CAM_NEAR)).toBeLessThan(1);
  });

  it('is monotonic, so the fade cannot flicker as the boom eases', () => {
    let previous = -1;
    for (let d = 0; d <= 5; d += 0.25) {
      const alpha = selfFadeAlpha(d);
      expect(alpha).toBeGreaterThanOrEqual(previous);
      previous = alpha;
    }
  });

  it('finishes fading before the near plane would slice the model', () => {
    expect(selfFadeAlpha(CAM_NEAR)).toBeCloseTo(0, 6);
  });
});
