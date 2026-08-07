/**
 * A body that fell out of the world is put back on it, and nothing else is.
 *
 * Happy path plus the two "leave it alone" cases that make it safe, because they are the whole design:
 * the rescue is a teleport, and a teleport that fires on an ordinary cliff fall would be a worse bug
 * than the one it fixes. `heightAt` returning `null` -- streaming has not reached this XY -- must mean
 * "wait", never "there is no ground, drop".
 *
 * Measured motivation, on a live entry as `Gesf` with the ADT fetches delayed past the settle hold:
 * `z` -4400 and still going at -60.15 yd/s with all 441 terrain chunks and 1289 doodads loaded. The
 * mover's ground probe reaches 1.9 yd; from below the terrain nothing ever re-grounds the body.
 */
import * as THREE from 'three';

import { createPlayerMoveState } from '../player-state';
import { VOID_CLEARANCE, VOID_DEPTH, rescueFromVoid } from '../void-rescue';

const falling = (z: number) => {
  const state = createPlayerMoveState();
  state.pos.set(-8952.5, -129.8, z);
  state.velZ = -60.15;
  state.horizVel = new THREE.Vector3(1, 0, 0);
  state.airborneSince = 3;
  state.fallStartZ = 83.24;
  state.fallFar = true;
  return state;
};

describe('rescueFromVoid', () => {
  it('replaces a body below the terrain onto the surface and ends the fall', () => {
    const state = falling(-5087);

    expect(rescueFromVoid(state, () => 83.24)).toBe(true);
    expect(state.pos.z).toBeCloseTo(83.24 + VOID_CLEARANCE, 5);
    expect(state.velZ).toBe(0);
    expect(state.airborneSince).toBeNull();
    expect(state.fallFar).toBe(false);
  });

  it('leaves an ordinary fall alone, however fast', () => {
    // Well inside VOID_DEPTH of the surface: a real drop, on its way to a real landing.
    const state = falling(83.24 - VOID_DEPTH * 0.5);

    expect(rescueFromVoid(state, () => 83.24)).toBe(false);
    expect(state.airborneSince).toBe(3);
  });

  it('waits rather than teleporting when the terrain here has not streamed in', () => {
    const state = falling(-5087);

    expect(rescueFromVoid(state, () => null)).toBe(false);
    expect(state.pos.z).toBe(-5087);
  });
});
