/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import {
  CAPSULE_HEIGHT, FALL_FAR_DROP, FALL_FAR_TIME, GRAVITY, JUMP_SPEED, TERMINAL_VELOCITY,
  WEDGE_STILL_FRAMES,
} from '../constants';
import { step } from '../mover';
import { createPlayerMoveState } from '../player-state';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const HALF_H = CAPSULE_HEIGHT / 2;

const idle = { moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: false };
const walking = { moving: true, dir: v3(1, 0, 0), speed: 7, wantJump: false };
const jumping = { moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: true };

/** Open air everywhere. */
const air: CastFn = () => null;

/**
 * Solid ground at z = 0. Downward probes report the distance from the capsule's bottom cap to the
 * floor; everything else misses.
 */
const ground: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;
  if (gap < 0 || gap > maxDist) return null;

  return { distance: gap, normal: UP.clone(), source: 'floor' } as CastHit;
};

/** Feet on the floor. */
function standing() {
  const player = createPlayerMoveState();
  player.pos.set(0, 0, 0);
  return player;
}

describe('step: standing and falling', () => {
  it('reports a body on the floor as grounded with no vertical velocity', () => {
    const player = standing();
    const out = step(player, ground, idle, 1 / 60, 0);

    expect(out.grounded).toBe(true);
    expect(player.velZ).toBe(0);
    expect(player.airborneSince).toBeNull();
    expect(out.ground).toBe('floor');
  });

  it('accelerates a body in open air under gravity', () => {
    const player = standing();
    player.pos.set(0, 0, 100);
    const dt = 1 / 60;

    const out = step(player, air, idle, dt, 0);

    expect(out.grounded).toBe(false);
    expect(player.velZ).toBeCloseTo(-GRAVITY * dt, 5);
    expect(player.pos.z).toBeLessThan(100);
  });

  it('caps a long fall at terminal velocity', () => {
    const player = standing();
    player.pos.set(0, 0, 10000);
    for (let i = 0; i < 600; ++i) {
      step(player, air, idle, 1 / 60, i / 60);
    }

    expect(player.velZ).toBeCloseTo(-TERMINAL_VELOCITY, 3);
  });

  it('walks at the full input speed on flat ground', () => {
    const player = standing();
    step(player, ground, walking, 0.1, 0);

    expect(player.pos.x).toBeCloseTo(0.7, 3);
    expect(player.pos.z).toBeCloseTo(0, 3);
  });
});

describe('step: jumping', () => {
  it('takes off at the verified speed and leaves the ground', () => {
    const player = standing();
    const out = step(player, ground, jumping, 1 / 60, 0);

    expect(out.jumped).toBe(true);
    expect(player.jumpZSpeed).toBeCloseTo(JUMP_SPEED, 5);
    expect(player.airborneSince).not.toBeNull();
  });

  it('is not re-grounded on the very next frame', () => {
    // The bug that ate most jumps: "grounded" must mean on walkable ground AND not rising.
    const player = standing();
    step(player, ground, jumping, 1 / 60, 0);
    const second = step(player, ground, idle, 1 / 60, 1 / 60);

    expect(second.grounded).toBe(false);
    expect(player.velZ).toBeGreaterThan(0);
  });

  it('gives a standstill jump one air nudge', () => {
    const player = standing();
    step(player, ground, jumping, 1 / 60, 0);
    const nudged = step(player, air, { ...walking, wantJump: false }, 1 / 60, 1 / 60);

    expect(nudged.airNudged).toBe(true);
    expect(player.horizVel.length()).toBeGreaterThan(0);
  });

  it('keeps a moving jump momentum locked', () => {
    const player = standing();
    step(player, ground, walking, 1 / 60, 0);                        // build momentum
    step(player, ground, { ...walking, wantJump: true }, 1 / 60, 1 / 60);
    const locked = player.horizVel.clone();

    const after = step(
      player, air, { moving: true, dir: v3(0, 1, 0), speed: 7, wantJump: false }, 1 / 60, 2 / 60,
    );

    expect(after.airNudged).toBe(false);
    expect(player.horizVel.x).toBeCloseTo(locked.x, 5);
  });
});

describe('step: the FALLINGFAR latch', () => {
  it('latches a jump arc on the distance leg once it descends below its launch', () => {
    const player = standing();
    step(player, ground, jumping, 1 / 60, 0);
    expect(player.fallFar).toBe(false);

    for (let i = 1; i < 120 && !player.fallFar; ++i) {
      step(player, air, idle, 1 / 60, i / 60);
    }

    expect(player.fallFar).toBe(true);
    expect(player.fallStartZ - player.pos.z).toBeGreaterThanOrEqual(FALL_FAR_DROP);
  });

  it('latches a step-off fall on the timer leg instead', () => {
    // Launch vz = 0 -- the walk election's StartFalling(0). The legs are exclusive on the launch vz.
    const player = standing();
    player.pos.set(0, 0, 1000);
    step(player, air, idle, 1 / 60, 0);
    expect(player.jumpZSpeed).toBe(0);

    let t = 0;
    for (let i = 1; i < 60; ++i) {
      t = i / 60;
      step(player, air, idle, 1 / 60, t);
    }

    expect(t).toBeGreaterThan(FALL_FAR_TIME);
    expect(player.fallFar).toBe(true);
  });

  it('does not latch a step-off fall before the timer elapses', () => {
    const player = standing();
    player.pos.set(0, 0, 1000);
    for (let i = 0; i < 10; ++i) {
      step(player, air, idle, 1 / 60, i / 60);
    }

    expect(player.fallFar).toBe(false);
  });

  it('clears the arc and the latch on landing', () => {
    const player = standing();
    player.pos.set(0, 0, 3);
    for (let i = 0; i < 120; ++i) {
      const out = step(player, ground, idle, 1 / 60, i / 60);
      if (out.grounded && i > 0) break;
    }

    expect(player.airborneSince).toBeNull();
    expect(player.fallFar).toBe(false);
    expect(player.pos.z).toBeCloseTo(0, 2);
  });
});

describe('step: the settle hold', () => {
  it('freezes the body with gravity off', () => {
    const player = standing();
    player.pos.set(0, 0, 500);
    player.settling = true;

    const out = step(player, air, walking, 1 / 60, 0);

    expect(out.held).toBe(true);
    expect(player.pos.z).toBeCloseTo(500, 6);
    expect(player.velZ).toBe(0);
    expect(player.horizVel.length()).toBe(0);
  });

  it('does not start an airborne arc while held', () => {
    const player = standing();
    player.pos.set(0, 0, 500);
    player.settling = true;
    step(player, air, idle, 1 / 60, 0);

    expect(player.airborneSince).toBeNull();
  });
});

describe('step: the wedge rest', () => {
  it('lands a stalled fall standing after the wedge frames', () => {
    // A capsule held between steep faces: gravity keeps feeding the arc, the contacts cancel it,
    // and without this the falling pose is permanent with mid-air control locked.
    // A pinch is a capsule that CANNOT descend: the funnel walls are already in contact, so every
    // probe reports zero distance. Letting it creep even a couple of centimetres per iteration
    // would beat the stall threshold honestly and would not be a wedge at all.
    const r = (78 * Math.PI) / 180;
    const funnelWall = v3(-Math.sin(r), 0, Math.cos(r));
    const wedge: CastFn = (_from, dir) => ({
      distance: 0,
      normal: dir.z < -0.5 ? funnelWall.clone() : v3(-1, 0, 0),
      source: 'funnel',
    } as CastHit);

    const player = standing();
    player.pos.set(0, 0, 50);
    player.velZ = -5; // already falling fast enough to qualify

    let grounded = false;
    for (let i = 0; i < WEDGE_STILL_FRAMES + 3 && !grounded; ++i) {
      grounded = step(player, wedge, idle, 1 / 60, i / 60).grounded;
    }

    expect(grounded).toBe(true);
    expect(player.wedged).toBe(true);
    expect(player.velZ).toBe(0);
  });

  it('does not trip on a free fall, which achieves its full intended descent', () => {
    const player = standing();
    player.pos.set(0, 0, 10000);
    for (let i = 0; i < 60; ++i) {
      step(player, air, idle, 1 / 60, i / 60);
    }

    expect(player.wedged).toBe(false);
  });

  it('does not trip at a jump apex, which is slower than the minimum fall speed', () => {
    const player = standing();
    step(player, ground, jumping, 1 / 60, 0);
    for (let i = 1; i < 30; ++i) {
      step(player, air, idle, 1 / 60, i / 60);
    }

    expect(player.wedged).toBe(false);
  });
});

describe('step: the outcome shape', () => {
  it('is the wire integration surface and is always returned', () => {
    const out = step(standing(), ground, idle, 1 / 60, 0);

    expect(out).toHaveProperty('held');
    expect(out).toHaveProperty('grounded');
    expect(out).toHaveProperty('jumped');
    expect(out).toHaveProperty('airNudged');
    expect(out).toHaveProperty('ground');
  });
});
