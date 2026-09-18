import { PlayerMoveState } from './player-state';

/**
 * The seam between the mover and the wire.
 *
 * `Controls` owns the input and runs the movement frame; the network session owns the socket. This
 * module is the only thing that knows about both, and it knows about neither directly: the network
 * side REGISTERS a sink, `Controls` calls `streamMovement` every frame, and if no session has
 * entered the world the call is a no-op. That is what keeps `/game?offline=1` and every existing
 * movement test working with nothing connected -- and it is why this is a module singleton rather
 * than a prop threaded through `Controls`, which would have to be constructed differently offline.
 *
 * `PlayerMoveState.moveFlags` was declared with the comment "maintained for the wire; nothing reads
 * it yet". This is the reader.
 */

/** The input the flag word is derived from -- `Controls`' own axes, before they become velocity. */
export interface MovementInput {
  /** +1 forward, -1 backward, 0 neither. */
  forward: number;
  /** +1 strafe left, -1 strafe right, 0 neither. */
  strafe: number;
  /** +1 turning left, -1 turning right, 0 neither. */
  turning: number;
}

/**
 * 3.3.5a `MovementFlags`, duplicated from `network/game/movement-info.ts` on purpose.
 *
 * `game/` does not import from `network/` anywhere else, and inverting that for four constants
 * would make the movement layer -- which every movement test constructs -- depend on the packet
 * layer. The four values are pinned by the wire and cannot drift silently: `movementFlagsFor`'s
 * output is written straight into a packet, so a mismatch is a desync on the first step taken.
 */
const FLAG_FORWARD = 0x00000001;
const FLAG_BACKWARD = 0x00000002;
const FLAG_STRAFE_LEFT = 0x00000004;
const FLAG_STRAFE_RIGHT = 0x00000008;
const FLAG_TURN_LEFT = 0x00000010;
const FLAG_TURN_RIGHT = 0x00000020;
const FLAG_FALLING = 0x00001000;
const FLAG_FALLING_FAR = 0x00002000;
const FLAG_SWIMMING = 0x00200000;

/** The whole flag word for this frame, from the input and the mover's own latches. */
export function movementFlagsFor(state: PlayerMoveState, input: MovementInput): number {
  let flags = 0;
  if (input.forward > 0) flags |= FLAG_FORWARD;
  if (input.forward < 0) flags |= FLAG_BACKWARD;
  if (input.strafe > 0) flags |= FLAG_STRAFE_LEFT;
  if (input.strafe < 0) flags |= FLAG_STRAFE_RIGHT;
  if (input.turning > 0) flags |= FLAG_TURN_LEFT;
  if (input.turning < 0) flags |= FLAG_TURN_RIGHT;
  if (state.swimming) flags |= FLAG_SWIMMING;
  // Airborne is FALLING whether we jumped or walked off a ledge -- `airborneSince` is set by both,
  // and the server's fall damage leg keys on the flag plus `fallTime`, not on how the arc started.
  if (state.airborneSince !== null && !state.swimming) {
    flags |= FLAG_FALLING;
    if (state.fallFar) flags |= FLAG_FALLING_FAR;
  }
  return flags;
}

/**
 * What a sink is handed each frame. `nowSeconds` is `Controls`' elapsed-seconds clock -- the SAME
 * clock `state.airborneSince` and `state.settleDeadline` are stamped in, which is the only reason
 * the sink can turn `airborneSince` into the wire's `fallTime`.
 */
export interface MovementSink {
  streamMovement(state: PlayerMoveState, flags: number, nowSeconds: number): void;
  /**
   * Acknowledge a finished server-driven spline (`CMSG_MOVE_SPLINE_DONE`) -- see
   * `movement/server-ride.ts`. The server holds us spline-controlled and DROPS EVERY MOVEMENT
   * PACKET WE SEND until this arrives, so it is not optional in behaviour; it is optional in the
   * interface only so a sink written before the ride existed still satisfies the type.
   */
  sendSplineDone?(state: PlayerMoveState, splineId: number): void;
}

let sink: MovementSink | null = null;

export function setMovementSink(next: MovementSink | null) {
  sink = next;
}

/**
 * Publish this frame's movement state. Computes and STORES `state.moveFlags` whether or not a sink
 * is attached, so the field is true offline too and the debug panel can show it.
 */
export function streamMovement(
  state: PlayerMoveState,
  input: MovementInput,
  nowSeconds: number,
): void {
  state.moveFlags = movementFlagsFor(state, input);
  if (sink) {
    sink.streamMovement(state, state.moveFlags, nowSeconds);
  }
  state.lastFacing = state.faceYaw;
}

/**
 * Publish the `CMSG_MOVE_SPLINE_DONE` a finished self-spline owes, through the same sink seam.
 *
 * NOT routed through `streamMovement`: the ride guard skips that call for the whole ride (the
 * reference parks the outbound stream behind it, `player.rs:827` / `player.rs:882-886`), and the
 * ack is a one-shot at the endpoint rather than a frame report. `state.moveFlags` is deliberately
 * left as `serverRideFrame` set it -- 0, at rest -- rather than re-derived from an input word the
 * ride never read.
 *
 * A no-op with no sink attached, exactly like `streamMovement`: that is what keeps
 * `/game?offline=1` and every movement test working with nothing connected.
 */
export function streamSplineDone(state: PlayerMoveState, splineId: number): void {
  sink?.sendSplineDone?.(state, splineId);
}
