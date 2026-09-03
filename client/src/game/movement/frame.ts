import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import { MAX_SUBSTEP_TRAVEL, MAX_SUBSTEPS } from './constants';
import { MoveInput, Outcome, step } from './mover';
import { notePhase } from './move-phases';
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
  /**
   * The push-out for a body that is INSIDE geometry -- see `mover.ts#step`.
   *
   * OPTIONAL, so a caller with no world (every movement test) and the swim paths are unchanged. It is
   * a closure like the other two, which is what keeps this module testable with nothing loaded.
   */
  depenetrate?: (center: THREE.Vector3, skin?: number) => THREE.Vector3 | null;
}

/** `MoveInput` plus the jump key's PRESS edge, which the swim breach is triggered on. */
export interface FrameInput extends MoveInput {
  /** True only on the frame the jump key went down. */
  jumpPressed: boolean;
  /**
   * The unit's live SWIM speeds off the wire (`MSG_MOVE_SET_SWIM_SPEED` /
   * `SMSG_FORCE_SWIM_SPEED_CHANGE`, held on `Unit#speeds`), or omitted to keep the vanilla defaults.
   *
   * On `input` rather than on `PlayerMoveState` because that is what the two already are: `speed`
   * lives here for exactly the same reason -- it is "how fast the player may go this frame", an
   * input to the step, where the state holds what the step DECIDED (`swimStrokeSpeed` is an output
   * on the state and must not be confused with these). Optional so every existing caller and every
   * movement test keeps compiling and keeps the defaults it was written against.
   */
  swimSpeed?: number;
  swimBackSpeed?: number;
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
  // PHASE TIMING -- see `move-phases.ts` on the 100 us clock and why these accumulate.
  const tFrame = performance.now();
  const tSurface = tFrame;
  const surfaceZ = deps.surfaceAt(state.pos);
  notePhase('surfaceAt', (performance.now() - tSurface) * 1000);
  updateSwimming(state, surfaceZ, now);

  if (!state.swimming) {
    state.swimStrokeSpeed = 0;

    /**
     * **SUBSTEPPING: the body meets the world in steps of the same SIZE whatever the frame rate is.**
     *
     * This is the owner's actual requirement -- "не проваливаться под текстуры даже с низким фпс" --
     * and the reason a swept mover still needs it. The sweep itself cannot tunnel at any `dt`; what
     * breaks at low frame rates is that every OTHER quantity in a step is scaled by the travel. The
     * slide gets four iterations however far it goes, the step-up looks one frame ahead, the descent
     * cap is `travel * 1.849`. At 27 fps his travel measured 0.35 yd against 0.12 at 60, so the same
     * stair was met with a third of the resolution -- and his uneven descent was exactly that.
     *
     * The count comes from the DISTANCE the frame intends, not from its duration, so a stationary
     * body never pays for a long frame and a sprint on a good one still takes a single step.
     *
     * JUMP FIRES ONCE. `wantJump` is an edge, and handing it to three substeps would apply the
     * take-off impulse three times. The first substep keeps it; the rest are handed a copy with it
     * cleared, which is also how the arc then belongs to gravity rather than to the key.
     *
     * The LAST outcome is the frame's: each substep resolves against the world in turn, so the final
     * one holds the position, the grounded verdict and the support the caller needs. `held` and
     * `jumped` are OR-ed, because a settle hold or a take-off anywhere in the frame is true of the
     * frame.
     */
    const speed = input.moving ? input.speed : 0;
    const intended = speed * dt;
    const substeps = Math.min(
      MAX_SUBSTEPS,
      Math.max(1, Math.ceil(intended / MAX_SUBSTEP_TRAVEL)),
    );

    if (substeps === 1) {
      const outcome = step(state, deps.cast, input, dt, now, deps.depenetrate);
      notePhase('total', (performance.now() - tFrame) * 1000);
      return { outcome, swim: null };
    }

    const slice = dt / substeps;
    // Allocated only when the frame actually splits, which is a low-frame-rate frame by definition.
    const later: FrameInput = { ...input, wantJump: false, jumpPressed: false };
    let outcome = step(state, deps.cast, input, slice, now, deps.depenetrate);
    for (let i = 1; i < substeps; ++i) {
      const next = step(state, deps.cast, later, slice, now, deps.depenetrate);
      outcome = {
        ...next,
        held: outcome.held || next.held,
        jumped: outcome.jumped || next.jumped,
      };
    }
    notePhase('total', (performance.now() - tFrame) * 1000);
    return { outcome, swim: null };
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

    notePhase('total', (performance.now() - tFrame) * 1000);
    return { outcome, swim: null };
  }

  // A net-backward swim takes min(swimBack, swim), like the run arm's min(runBack, run); a
  // strafe-only swim uses the forward speed.
  // THE WIRE'S SWIM SPEEDS, falling back to vanilla's defaults -- the same defect as the run speed
  // (`controls.tsx`'s `speed`), in the same class: `SMSG_FORCE_SWIM_SPEED_CHANGE` is decoded, acked
  // and stored on `Unit#speeds.swim`, and this branch read a compile-time constant instead, so a
  // swim-speed effect could not move the body. `> 0` guards a speed set that has not arrived and a
  // zero the validator let through.
  const swimFwd = input.swimSpeed !== undefined && input.swimSpeed > 0 ? input.swimSpeed : SWIM_SPEED;
  const swimBack = input.swimBackSpeed !== undefined && input.swimBackSpeed > 0
    ? input.swimBackSpeed
    : SWIM_BACK_SPEED;
  let speed = 0;
  if (input.moving && input.dir.lengthSq() > 1e-12) {
    _forward.set(Math.cos(state.faceYaw), Math.sin(state.faceYaw), 0);
    // `min(back, forward)` is the reference's own rule and is kept: a net-backward swim takes the
    // slower of the two, so a buff that raises only the forward speed cannot make backstroking fast.
    speed = input.dir.dot(_forward) < 0
      ? Math.min(swimBack, swimFwd)
      : swimFwd;
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

  notePhase('total', (performance.now() - tFrame) * 1000);
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
