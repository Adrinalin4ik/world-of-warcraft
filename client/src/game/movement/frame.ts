import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import { MoveInput, Outcome, step } from './mover';
import { PlayerMoveState } from './player-state';
import {
  breachStep, SWIM_BACK_SPEED, SWIM_SPEED, SwimOutcome, swimStep, updateSwimming,
} from './swim';

/**
 * The world access one movement frame needs. Both are closures, which is what keeps this testable
 * with nothing loaded.
 */
export interface FrameDeps {
  cast: CastFn;
  surfaceAt(feet: THREE.Vector3): number | null;
}

/** `MoveInput` plus the jump key's PRESS edge, which the swim breach is triggered on. */
export interface FrameInput extends MoveInput {
  /** True only on the frame the jump key went down. */
  jumpPressed: boolean;
}

export interface FrameResult {
  outcome: Outcome;
  /** Non-null only on a swimming frame. */
  swim: SwimOutcome | null;
}

const _forward = new THREE.Vector3();

/**
 * One movement frame: decide the regime, then run it.
 *
 * The swim latch runs FIRST, because whether we are swimming decides which mover owns the frame.
 *
 * A jump while swimming breaches out at ANY depth -- at the surface it hops onto the bank,
 * submerged it is the dolphin hop -- and it is EDGE-triggered, so a held key does not re-fire after
 * the swim re-latch. One hop per press.
 */
export function movementFrame(
  state: PlayerMoveState,
  deps: FrameDeps,
  input: FrameInput,
  dt: number,
  now: number,
): FrameResult {
  const surfaceZ = deps.surfaceAt(state.pos);
  updateSwimming(state, surfaceZ, now);

  if (!state.swimming) {
    state.swimStrokeSpeed = 0;
    return { outcome: step(state, deps.cast, input, dt, now), swim: null };
  }

  if (input.jumpPressed) {
    // Jump clears SWIMMING unconditionally and hands the arc to the walk/fall machinery. The arc is
    // seeded here rather than in `step`, because the breach never runs through it.
    state.swimming = false;
    const outcome = breachStep(state, deps.cast, dt);
    state.airborneSince = now;
    state.jumpZSpeed = state.velZ;
    state.fallStartZ = state.pos.z;
    state.fallFar = false;

    return { outcome, swim: null };
  }

  // A net-backward swim takes min(swimBack, swim), like the run arm's min(runBack, run); a
  // strafe-only swim uses the forward speed.
  let speed = 0;
  if (input.moving && input.dir.lengthSq() > 1e-12) {
    _forward.set(Math.cos(state.faceYaw), Math.sin(state.faceYaw), 0);
    speed = input.dir.dot(_forward) < 0
      ? Math.min(SWIM_BACK_SPEED, SWIM_SPEED)
      : SWIM_SPEED;
  }
  state.swimStrokeSpeed = speed;

  const inputVel = new THREE.Vector3();
  if (speed > 0) {
    // Pitch the travel by the swim pitch: aiming up with the mouse and swimming forward is how you
    // rise. `swimPitch` itself is written by the camera, and is HELD when unsteered.
    inputVel.copy(input.dir).setZ(0).normalize();
    const level = Math.cos(state.swimPitch);
    inputVel.multiplyScalar(level).setZ(Math.sin(state.swimPitch));
    inputVel.normalize().multiplyScalar(speed);
  }

  const swim = swimStep(state, deps.cast, inputVel, surfaceZ, deps.surfaceAt, dt);

  return {
    outcome: {
      held: state.settling,
      grounded: swim.grounded,
      jumped: false,
      airNudged: false,
      ground: null,
    },
    swim,
  };
}
