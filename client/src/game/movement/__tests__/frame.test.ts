/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT } from '../constants';
import { movementFrame } from '../frame';
import { createPlayerMoveState } from '../player-state';
import { restCap, SWIM_JUMP_SPEED, SWIM_SPEED, swimEnterDepth } from '../swim';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const H = 2.031;
const HALF_H = CAPSULE_HEIGHT / 2;
const SURFACE = 100;

const ground: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;
  if (gap < 0 || gap > maxDist) return null;

  return { distance: gap, normal: UP.clone(), source: 'floor' } as CastHit;
};

const dry = { cast: ground, surfaceAt: () => null };
const deep = { cast: ground, surfaceAt: () => SURFACE };

const idle = {
  moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: false, jumpPressed: false,
};
const swimmingForward = {
  moving: true, dir: v3(1, 0, 0), speed: SWIM_SPEED, wantJump: false, jumpPressed: false,
};

function player(feetZ: number) {
  const state = createPlayerMoveState();
  state.pos.set(0, 0, feetZ);
  state.collisionHeight = H;
  return state;
}

describe('movementFrame: regime selection', () => {
  it('runs the walk mover on dry land', () => {
    const state = player(0);
    const out = movementFrame(state, dry, idle, 1 / 60, 0);

    expect(state.swimming).toBe(false);
    expect(out.swim).toBeNull();
    expect(out.outcome.grounded).toBe(true);
  });

  it('switches to the swim mover in deep enough water', () => {
    const state = player(SURFACE - swimEnterDepth(H) - 1);
    const out = movementFrame(state, deep, idle, 1 / 60, 0);

    expect(state.swimming).toBe(true);
    expect(out.swim).not.toBeNull();
  });

  it('treats wading as walking -- there is no separate wade mode', () => {
    const state = player(SURFACE - swimEnterDepth(H) + 0.1);
    const out = movementFrame(state, deep, idle, 1 / 60, 0);

    expect(state.swimming).toBe(false);
    expect(out.swim).toBeNull();
  });

  it('resolves a swim into the shallows back onto the ground', () => {
    // Shallow water over a bed the feet can reach: the exit hysteresis hands us back to the walk
    // mover, which is how you get out onto land.
    const shallow = { cast: ground, surfaceAt: () => 0.5 };
    const state = player(0);
    state.swimming = true;

    const out = movementFrame(state, shallow, idle, 1 / 60, 0);

    expect(state.swimming).toBe(false);
    expect(out.swim).toBeNull();
  });
});

describe('movementFrame: the swim breach', () => {
  it('breaches instead of walking when jump is pressed while swimming', () => {
    const state = player(SURFACE - restCap(H));
    state.swimming = true;

    const out = movementFrame(
      state, deep, { ...idle, wantJump: true, jumpPressed: true }, 1 / 60, 0,
    );

    expect(out.outcome.jumped).toBe(true);
    expect(state.swimming).toBe(false);
    expect(state.velZ).toBeCloseTo(SWIM_JUMP_SPEED, 5);
  });

  it('seeds the arc so the hop is a real jump, not a step-off fall', () => {
    const state = player(SURFACE - restCap(H));
    state.swimming = true;

    movementFrame(state, deep, { ...idle, wantJump: true, jumpPressed: true }, 1 / 60, 0);

    expect(state.airborneSince).toBe(0);
    expect(state.jumpZSpeed).toBeCloseTo(SWIM_JUMP_SPEED, 5);
    expect(state.fallFar).toBe(false);
  });

  it('does not re-fire on a held key after the swim re-latch', () => {
    // One hop per PRESS: the breach is edge-triggered, not level-triggered.
    const state = player(SURFACE - restCap(H));
    state.swimming = true;
    const held = { ...idle, wantJump: true, jumpPressed: true };

    movementFrame(state, deep, held, 1 / 60, 0);
    state.swimming = true; // the re-latch
    const second = movementFrame(state, deep, { ...held, jumpPressed: false }, 1 / 60, 1 / 60);

    expect(second.outcome.jumped).toBe(false);
  });
});

describe('movementFrame: the swim stroke', () => {
  it('holds the swim pitch when unsteered', () => {
    const state = player(SURFACE - restCap(H) - 2);
    state.swimming = true;
    state.swimPitch = 0.6;

    movementFrame(state, deep, idle, 1 / 60, 0);

    expect(state.swimPitch).toBeCloseTo(0.6, 9);
  });

  it('pitches the travel by the swim pitch, so aiming up rises', () => {
    const state = player(SURFACE - restCap(H) - 5);
    state.swimming = true;
    state.swimPitch = 0.5;

    movementFrame(state, deep, swimmingForward, 0.1, 0);

    expect(state.pos.z).toBeGreaterThan(SURFACE - restCap(H) - 5);
  });

  it('descends when the swim pitch aims down', () => {
    const state = player(SURFACE - restCap(H) - 5);
    state.swimming = true;
    state.swimPitch = -0.5;

    movementFrame(state, deep, swimmingForward, 0.1, 0);

    expect(state.pos.z).toBeLessThan(SURFACE - restCap(H) - 5);
  });

  it('reports the stroke speed for the gait, and zeroes it when not swimming', () => {
    const swimmer = player(SURFACE - restCap(H) - 5);
    swimmer.swimming = true;
    movementFrame(swimmer, deep, swimmingForward, 1 / 60, 0);
    expect(swimmer.swimStrokeSpeed).toBeCloseTo(SWIM_SPEED, 5);

    const walker = player(0);
    movementFrame(walker, dry, { ...swimmingForward, speed: 7 }, 1 / 60, 0);
    expect(walker.swimStrokeSpeed).toBe(0);
  });

  it('swims backward slower than forward', () => {
    const state = player(SURFACE - restCap(H) - 5);
    state.swimming = true;
    state.faceYaw = 0; // facing +x

    movementFrame(state, deep, { ...swimmingForward, dir: v3(-1, 0, 0) }, 1 / 60, 0);

    expect(state.swimStrokeSpeed).toBeLessThan(SWIM_SPEED);
  });

  it('leaves an idle swimmer stroke speed at zero', () => {
    const state = player(SURFACE - restCap(H) - 5);
    state.swimming = true;

    movementFrame(state, deep, idle, 1 / 60, 0);

    expect(state.swimStrokeSpeed).toBe(0);
  });
});
