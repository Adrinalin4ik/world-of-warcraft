/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT, JUMP_SPEED } from '../constants';
import { createPlayerMoveState } from '../player-state';
import { breachStep, restCap, SWIM_JUMP_SPEED, SWIM_SPEED, swimStep } from '../swim';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const H = 2.031;
const HALF_H = CAPSULE_HEIGHT / 2;

const openWater: CastFn = () => null;

/** A named identity for the lakebed. */
const BED = { name: 'bed' };

/** Solid ground at z = 0, for the shallows cases. */
const lakebed: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;
  if (gap < 0 || gap > maxDist) return null;

  return { distance: gap, normal: UP.clone(), source: BED } as CastHit;
};

function swimmer(feetZ: number) {
  const player = createPlayerMoveState();
  player.pos.set(0, 0, feetZ);
  player.collisionHeight = H;
  player.swimming = true;
  return player;
}

describe('swimStep: the floating vertical', () => {
  it('freezes an idle swimmer depth -- no sink, no rise, no ease', () => {
    // The verified floating resolver bypasses gravity entirely. There is no buoyancy spring and no
    // resting seek: the vertical comes ONLY from the pitched travel velocity.
    const surface = 100;
    const player = swimmer(surface - restCap(H) - 3); // well below the rest line
    const before = player.pos.z;

    const out = swimStep(player, openWater, v3(0, 0, 0), surface, () => surface, 1 / 60);

    expect(player.pos.z).toBeCloseTo(before, 9);
    expect(player.velZ).toBe(0);
    expect(out.surfacePitch).toBeNull();
  });

  it('does not sink an idle swimmer over many frames', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H) - 3);
    for (let i = 0; i < 300; ++i) {
      swimStep(player, openWater, v3(0, 0, 0), surface, () => surface, 1 / 60);
    }

    expect(player.pos.z).toBeCloseTo(surface - restCap(H) - 3, 6);
  });

  it('moves horizontally at the stroke speed on a level stroke', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H) - 5);

    swimStep(player, openWater, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

    expect(player.pos.x).toBeCloseTo(SWIM_SPEED * 0.1, 4);
  });
});

describe('swimStep: the rest line', () => {
  it('stops a rising stroke three-quarters submerged', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H) - 0.02);

    swimStep(player, openWater, v3(0, 0, SWIM_SPEED), surface, () => surface, 0.1);

    expect(player.pos.z).toBeCloseTo(surface - restCap(H), 4);
  });

  it('redirects a stroke already at the line into level surface swimming', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H));

    const out = swimStep(player, openWater, v3(1, 0, 4), surface, () => surface, 0.1);

    expect(player.pos.z).toBeCloseTo(surface - restCap(H), 5);
    // Full speed level, not clipped to nothing.
    expect(player.pos.x).toBeGreaterThan(0.35);
    expect(out.surfacePitch).toBeCloseTo(0, 5);
  });

  it('never caps a dive', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H));

    swimStep(player, openWater, v3(0, 0, -SWIM_SPEED), surface, () => surface, 0.1);

    expect(player.pos.z).toBeLessThan(surface - restCap(H));
  });

  it('leaves an ascent free when there is no waterline at all', () => {
    // A null surface is GM flight: the constraint has nothing to constrain against.
    const player = swimmer(500);

    swimStep(player, openWater, v3(0, 0, 5), null, () => null, 0.1);

    expect(player.pos.z).toBeCloseTo(500.5, 4);
  });

  it('settles a stroke back onto a DESCENDING surface', () => {
    // The river case. The settle must run on the surface at the position the stroke REACHED, not
    // the one it started from.
    const startSurface = 100;
    const endSurface = 99.5;
    const player = swimmer(startSurface - restCap(H));

    swimStep(player, openWater, v3(SWIM_SPEED, 0, 0), startSurface, () => endSurface, 0.1);

    expect(player.pos.z).toBeCloseTo(endSurface - restCap(H), 4);
  });

  it('settles with a SWEPT drop, so a shallow bottom holds the feet higher', () => {
    // A position clamp here would override terrain collision, shove the feet onto the rest line
    // even where the bottom holds them up, and pin the depth so the shore exit could never fire.
    const surface = 1.0; // shallow water over a bed at z = 0
    const player = swimmer(0);

    swimStep(player, lakebed, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

    expect(player.pos.z).toBeGreaterThanOrEqual(-1e-3);
  });

  it('does not settle at all on an idle frame', () => {
    // The resolver's own outer gate: an idle floater is not resolved, so its depth stays frozen
    // even above the rest line.
    const surface = 100;
    const player = swimmer(surface - restCap(H) + 0.5);

    swimStep(player, openWater, v3(0, 0, 0), surface, () => surface, 0.1);

    expect(player.pos.z).toBeCloseTo(surface - restCap(H) + 0.5, 6);
  });
});

describe('swimStep: handing off', () => {
  it('reports standing on a shallow bottom', () => {
    const player = swimmer(0);
    const out = swimStep(player, lakebed, v3(0, 0, 0), 1.0, () => 1.0, 1 / 60);

    expect(out.grounded).toBe(true);
  });

  it('leaves a clean zero vertical for a fall that may follow', () => {
    const surface = 100;
    const player = swimmer(surface - restCap(H) - 2);
    player.velZ = -7;

    swimStep(player, openWater, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

    expect(player.velZ).toBe(0);
    expect(player.horizVel.z).toBe(0);
  });
});

describe('breachStep', () => {
  it('launches the fall arc at the swim jump speed', () => {
    const player = swimmer(50);
    player.horizVel.set(3, 0, 0);

    const out = breachStep(player, openWater, 1 / 60);

    expect(player.velZ).toBeCloseTo(SWIM_JUMP_SPEED, 6);
    expect(out.jumped).toBe(true);
    expect(out.grounded).toBe(false);
    expect(player.pos.z).toBeGreaterThan(50);
  });

  it('freezes horizontal momentum at takeoff, like every jump', () => {
    const player = swimmer(50);
    player.horizVel.set(3, 0, 0);

    breachStep(player, openWater, 1 / 60);

    expect(player.pos.x).toBeCloseTo(3 / 60, 5);
  });

  it('launches harder than a land jump', () => {
    // ~14% harder: enough to breach and hop onto a low bank.
    expect(SWIM_JUMP_SPEED).toBeGreaterThan(JUMP_SPEED);
    expect(SWIM_JUMP_SPEED / JUMP_SPEED).toBeCloseTo(1.14, 1);
  });
});
