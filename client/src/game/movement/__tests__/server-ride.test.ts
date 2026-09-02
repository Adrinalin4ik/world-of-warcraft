import * as THREE from 'three';

import { makeSplineRide } from '../net-motion';
import { createPlayerMoveState } from '../player-state';
import { serverRideFrame } from '../server-ride';

/**
 * The two arms of the self-spline hand-off, taken from the reference's own tests for the same
 * system (`samples/benilla/crates/benilla-app/src/player/server_ride.rs:180-278`).
 *
 * Pure state, no scene and no packets: `serverRideFrame` is a function over `PlayerMoveState` plus
 * a `SplineRide`, which is the whole reason it was written that way. NOTE WHAT THIS DOES NOT COVER
 * -- the wire. Whether `CMSG_MOVE_SPLINE_DONE`'s body is the shape the server reads is settled by a
 * residual against real traffic, not here; these assert that the ack is ASKED FOR, with which id,
 * and that the mover resumes at rest.
 */

/** A 10-yard straight ride due east over one second, with stale pre-ride momentum on the state. */
function riding(startMs: number) {
  const state = createPlayerMoveState();
  // A strafe was held and a fall was under way when the spline took over -- the momentum that must
  // not leak into the resume.
  state.horizVel.set(5, 0, 0);
  state.velZ = -2;
  state.airborneSince = 1;

  const ride = makeSplineRide(
    [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }],
    1000,
    false,
    startMs,
    { id: 77, finalFacing: null },
  );
  if (ride === null) {
    throw new Error('the fixture ride must build');
  }
  return { state, ride };
}

test('a ride owns the pose, and its arrival acks the id and resumes at rest', () => {
  const { state, ride } = riding(0);

  // Mid-ride: the spline is the position authority and the pose is its sample.
  const mid = serverRideFrame(state, ride, 500);
  expect(mid.riding).toBe(true);
  expect(mid.verdict).toBe('engaged');
  expect(mid.ackSplineId).toBeNull();
  expect(state.serverRiding).toBe(true);
  expect(state.pos.x).toBeCloseTo(5, 3);
  expect(state.faceYaw).toBeCloseTo(0, 6);
  // A forward run, so the gait selector reads a run rather than Stand.
  expect(state.moveFlags).toBe(1);

  // The arrival frame: the sampler clamps to the last point, so the pose IS the server's endpoint.
  const end = serverRideFrame(state, ride, 1000);
  expect(end.verdict).toBe('ended');
  expect(end.ackSplineId).toBe(77);
  expect(end.clearRide).toBe(true);
  // `riding` is false on this frame: the mover resumes from the endpoint in the same frame.
  expect(end.riding).toBe(false);
  expect(state.pos.x).toBeCloseTo(10, 6);
  // At rest -- stale pre-ride momentum must not leak into the resume.
  expect(state.serverRiding).toBe(false);
  expect(state.velZ).toBe(0);
  expect(state.horizVel).toEqual(new THREE.Vector3(0, 0, 0));
  expect(state.airborneSince).toBeNull();
  expect(state.moveFlags).toBe(0);
});

test('a teleport aborts the ride without an ack', () => {
  const { state, ride } = riding(0);
  serverRideFrame(state, ride, 500);

  // The server relocated us at ITS end of the ride, so the relocation is the hand-back and no
  // `CMSG_MOVE_SPLINE_DONE` is owed.
  state.rideAbort = true;
  const aborted = serverRideFrame(state, ride, 600);
  expect(aborted.verdict).toBe('aborted');
  expect(aborted.ackSplineId).toBeNull();
  expect(aborted.clearRide).toBe(true);
  expect(state.serverRiding).toBe(false);

  // And the ride-end arm must not fire afterwards.
  const after = serverRideFrame(state, null, 700);
  expect(after.verdict).toBe('idle');
  expect(after.ackSplineId).toBeNull();
});
