/**
 * @jest-environment node
 */
import {
  AIR_NUDGE_SPEED, CAPSULE_HEIGHT, CAPSULE_RADIUS, DEFAULT_COLLISION_HEIGHT, FALL_FAR_DROP,
  FALL_FAR_TIME, GRAVITY, GROUND_COS, GROUND_PROBE, JUMP_SPEED, LAND_PROBE, MOUSELOOK_PITCH_CLAMP,
  RUN_BACK_RATIO, RUN_SPEED, SKIN_WIDTH, STATIONARY_CHASE_RATE, STEP_SLOPE_RATIO, STEP_SNAP_SLACK,
  STEP_UP_HEIGHT, TERMINAL_VELOCITY, TURN_RATE, TURN_RATE_MOVING, WEDGE_MIN_FALL,
  WEDGE_STALL_RATIO, WEDGE_STILL_FRAMES, capsuleHalfSegment,
} from '../constants';
import { createPlayerMoveState } from '../player-state';

/**
 * These are binary-derived vanilla values, ported from the reference's player/state.rs. They are
 * pinned by test because a typo in one of them is a feel regression nobody can diagnose from the
 * symptom: a jump that is subtly wrong reads as "the physics is off", not "GRAVITY has a transposed
 * digit".
 */
describe('the verified vanilla constants', () => {
  it('have their exact values', () => {
    expect(GRAVITY).toBeCloseTo(19.291105, 6);
    expect(JUMP_SPEED).toBeCloseTo(7.955547, 6);
    expect(TERMINAL_VELOCITY).toBeCloseTo(60.148003, 6);
    expect(GROUND_COS).toBeCloseTo(0.642788, 6);
    expect(STEP_SLOPE_RATIO).toBeCloseTo(1.849399, 6);
    expect(STEP_SNAP_SLACK).toBeCloseTo(1 / 36, 9);
    expect(CAPSULE_HEIGHT).toBeCloseTo(2.0277777, 6);
    expect(DEFAULT_COLLISION_HEIGHT).toBeCloseTo(2.0277777, 6);
    expect(CAPSULE_RADIUS).toBeCloseTo(1 / 3, 9);
    expect(FALL_FAR_DROP).toBeCloseTo(1 / 9, 5);
    expect(FALL_FAR_TIME).toBeCloseTo(0.5, 6);
    expect(MOUSELOOK_PITCH_CLAMP).toBeCloseTo(1.553343, 6);
    expect(RUN_BACK_RATIO).toBeCloseTo(4.5 / 7.0, 9);
    expect(RUN_SPEED).toBeCloseTo(7.0, 6);
  });

  it('put GROUND_COS at the cosine of the 50 degree walkable limit', () => {
    expect(GROUND_COS).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 5);
  });

  it('put the mouselook clamp at 89 degrees, not 90', () => {
    // 90 would be the pitch-KEY integrator's clamp, which belongs to default-unbound keys.
    expect(MOUSELOOK_PITCH_CLAMP).toBeCloseTo((89 * Math.PI) / 180, 5);
    expect(MOUSELOOK_PITCH_CLAMP).toBeLessThan(Math.PI / 2);
  });

  it('absorb a slope well above the walkable limit through the snap ratio', () => {
    // atan(1.8494) ~= 61.6 degrees, comfortably steeper than the 50 degree walk gate -- which is
    // what lets the snap follow terrain down without also absorbing a cliff.
    const absorbed = (Math.atan(STEP_SLOPE_RATIO) * 180) / Math.PI;
    expect(absorbed).toBeGreaterThan(50);
    expect(absorbed).toBeLessThan(70);
  });
});

describe('the tunable feel knobs', () => {
  it('are at their reference values', () => {
    expect(GROUND_PROBE).toBeCloseTo(0.2, 6);
    expect(LAND_PROBE).toBeCloseTo(0.05, 6);
    expect(STEP_UP_HEIGHT).toBeCloseTo(0.7, 6);
    expect(SKIN_WIDTH).toBeCloseTo(0.02, 6);
    expect(AIR_NUDGE_SPEED).toBeCloseTo(2.5, 6);
    expect(WEDGE_STILL_FRAMES).toBe(3);
    expect(WEDGE_STALL_RATIO).toBeCloseTo(0.15, 6);
    expect(WEDGE_MIN_FALL).toBeCloseTo(1.0, 6);
    expect(TURN_RATE).toBeCloseTo(Math.PI, 6);
    expect(TURN_RATE_MOVING).toBeCloseTo(0.75, 6);
    expect(STATIONARY_CHASE_RATE).toBeCloseTo(8.0, 6);
  });

  it('keep the landing probe tighter than the walking one', () => {
    // Otherwise the arc ends early and the gap closes as a same-frame snap: a visible pop at every
    // silent landing.
    expect(LAND_PROBE).toBeLessThan(GROUND_PROBE);
  });

  it('keep the step-up ceiling low enough that fences slide', () => {
    // Deliberately NOT the reference client's ~2 yd body-height budget. Fence collision tops sit
    // at 1.8-2.3 yd, so a modest ceiling is what keeps them slide-only.
    expect(STEP_UP_HEIGHT).toBeLessThan(1.0);
    expect(STEP_UP_HEIGHT).toBeLessThan(CAPSULE_HEIGHT / 2);
  });

  it('keep the air nudge slower than a walking jump', () => {
    expect(AIR_NUDGE_SPEED).toBeLessThan(RUN_SPEED);
  });
});

describe('capsuleHalfSegment', () => {
  it('is the axis length between the two cap centres, not half the total height', () => {
    expect(capsuleHalfSegment()).toBeCloseTo(CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS, 9);
    expect(capsuleHalfSegment()).toBeGreaterThan(0);
    expect(capsuleHalfSegment()).toBeLessThan(CAPSULE_HEIGHT / 2);
  });
});

describe('createPlayerMoveState', () => {
  it('starts at rest, on the ground, not swimming', () => {
    const player = createPlayerMoveState();

    expect(player.velZ).toBe(0);
    expect(player.horizVel.length()).toBe(0);
    expect(player.airborneSince).toBeNull();
    expect(player.swimming).toBe(false);
    expect(player.levitating).toBe(false);
    expect(player.wedged).toBe(false);
    expect(player.fallFar).toBe(false);
  });

  it('never starts at a zero collision height', () => {
    // At zero every swim depth line collapses to 0 and the avatar swims on dry land.
    const player = createPlayerMoveState();

    expect(player.collisionHeight).toBeCloseTo(DEFAULT_COLLISION_HEIGHT, 6);
    expect(player.collisionHeight).toBeGreaterThan(0);
  });

  it('keeps faceYaw and modelYaw as separate fields', () => {
    // The aim and the rendered body heading diverge while strafing, and faceYaw is what the wire
    // will carry. Collapsing them now is the change that would have to be undone later.
    const player = createPlayerMoveState();
    player.faceYaw = 1.0;

    expect(player.modelYaw).toBe(0);
  });

  it('hands out independent vectors per state', () => {
    const a = createPlayerMoveState();
    const b = createPlayerMoveState();
    a.pos.set(5, 5, 5);

    expect(b.pos.toArray()).toEqual([0, 0, 0]);
  });
});
