import { MoveFlag, sampleSpline, SplineRide } from './net-motion';
import { PlayerMoveState } from './player-state';

/**
 * **THE SELF-SPLINE RIDE: the frame a server-authored spline drives OUR OWN character.**
 *
 * Warrior Charge is the first case; a knockback path, a taxi flight and a fear flee are the same
 * mechanism. The server moves the *caster* with the same `MoveSpline` machinery it moves any
 * creature with, broadcasts an `SMSG_MONSTER_MOVE` naming our own guid, and -- for a player mover --
 * waits on `CMSG_MOVE_SPLINE_DONE` before it stops treating us as spline-controlled.
 *
 * This is a port of `samples/benilla/crates/benilla-app/src/player/server_ride.rs#drive_self_ride`,
 * whose module header states the division of labour this file keeps:
 *
 *  - the SPLINE is the sole position authority for the ride. A player owns its Z -- there is no
 *    creature terrain-reground -- and the server's ground path already carries a walkable Z;
 *  - the ride owns the WHOLE pose while it lasts: `pos`, `faceYaw`, `modelYaw`, and a forward-run
 *    flag word so the gait selector reads a run rather than Stand;
 *  - the frame the spline ends it emits the ack and clears the ride, so the mover resumes from the
 *    endpoint AT REST;
 *  - the caller's ride guard carries the follow camera onto the moving avatar and skips input,
 *    physics and the outbound movement stream (`player.rs:800-885`).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, AND IT IS THE ANSWER TO "WHAT HAPPENS TO COLLISION": nothing
 * here casts a capsule. While a ride runs the body is not resolved against the world at all -- it
 * is placed on the server's path, verbatim, every frame. That is the reference's own arrangement
 * (`sample_splines` writes the transform; the physics half of `control` is behind the ride guard)
 * and it is the only arrangement that cannot desync: the path was computed server-side and the
 * server will hold us at its endpoint whatever our own collision thinks. So a charge follows the
 * server's route through the world and CANNOT be stopped short by our geometry -- if the server
 * pathed us through a wall, we go through it. Resolving the ride against our own capsule instead
 * would fight the authority the ack is about to confirm, and would leave us somewhere the server
 * does not have us. The mover's own election takes the body back on the arrival frame
 * (`mover.ts:670-689` re-derives the airborne latches from a fresh ground probe), which is where a
 * ride that ended over a hole starts falling.
 *
 * Pure over `PlayerMoveState` plus a `SplineRide`: no scene, no packets, no clock of its own.
 */

/** What this frame's ride step was. Reported so the caller can log an edge exactly once. */
export type ServerRideVerdict =
  /** No ride, no outstanding stop: the ordinary movement frame owns everything. */
  | 'idle'
  /** The first frame of a ride -- the edge worth announcing. */
  | 'engaged'
  /** Mid-ride. */
  | 'riding'
  /** The spline reached its end this frame: the pose is the endpoint and an ack is owed. */
  | 'ended'
  /** A `Stop` for our guid with no ride behind it: the same wait, and the same answer. */
  | 'stopped'
  /** A teleport voided the ride. No ack -- the relocation IS the hand-back. */
  | 'aborted';

export interface ServerRideResult {
  verdict: ServerRideVerdict;
  /**
   * **True while the SPLINE owns the pose, i.e. the caller must not run input, the capsule mover or
   * the outbound stream this frame** -- only the camera seat.
   *
   * False on the `ended` frame as well as on `idle`: the endpoint pose is already written and the
   * mover resumes from it in the very same frame, which is the reference's ordering
   * (`drive_self_ride` clears `server_riding` in its ride-end arm and `control`, ordered after it,
   * then runs normally).
   */
  riding: boolean;
  /**
   * The `splineId` to acknowledge with `CMSG_MOVE_SPLINE_DONE`, or null when nothing is owed.
   * Non-null on exactly one frame per ride.
   */
  ackSplineId: number | null;
  /**
   * The caller must drop the ride (`Unit#clearSplinePath`). Set on `ended` -- the sampler has
   * already clamped the pose to the last point -- and on `aborted`.
   *
   * Keeping a finished ride would make `splineRide != null` stop meaning "actively moving", the
   * same reason the creature sampler drops its own (`unit.ts#updateSplineFollowing`).
   */
  clearRide: boolean;
}

/**
 * **THE RIDE'S OWN INSTRUMENT.** Exported so a live probe can read it as
 * `window.worldRuntime`-free plain state: `import { serverRideStats }`, or through the world debug
 * snapshot which mirrors it.
 *
 * WHY THESE FIELDS AND NOT A PER-FRAME TIMING. Two `performance.now()` reads around a dozen float
 * operations measure the clock's own 5 us quantisation and nothing else, so a per-frame number here
 * would be noise wearing a decimal point. What IS measurable, and what actually settles whether the
 * ride is faithful, is the ride as a whole: `lastRideMs` against the duration the packet itself
 * declared (`SMSG_MONSTER_MOVE`'s `durationMs` -- 965 ms for the charge in the owner's report) says
 * the sampler tracked the SERVER's clock rather than the frame rate, and `lastRideFrames` divided
 * by it says at what frame rate. A ride that finishes early or late by more than a frame is a sampler
 * bug; the two numbers are the only way to see it from outside.
 *
 * The counters are integer increments on ride frames only -- zero cost when nothing is riding.
 */
export const serverRideStats = {
  /** Rides engaged. */
  rides: 0,
  /** Frames spent riding, over the session. */
  frames: 0,
  /** Frames the most recent ride took. */
  lastRideFrames: 0,
  /** Wall milliseconds the most recent ride took, engage edge to ack. */
  lastRideMs: 0,
  /** `CMSG_MOVE_SPLINE_DONE` acks this module asked for -- rides plus bare stops. */
  acks: 0,
  /** Rides voided by a teleport, which owe no ack. */
  aborts: 0,
};

/** `performance.now()` at the current ride's engage edge; 0 when not riding. */
let rideStartedMs = 0;

const IDLE: ServerRideResult = {
  verdict: 'idle', riding: false, ackSplineId: null, clearRide: false,
};

/**
 * Hand the body back to the local mover **at rest**.
 *
 * The reference's ride-end arm, verbatim on the fields it clears (`server_ride.rs:135-146`) and
 * with its reason: "the mover re-derives them only when it reads grounded; a ride ending a hair
 * above our terrain (navmesh Z vs ours) would otherwise inherit the pre-ride momentum -- e.g. a
 * strafe-engaged charge sliding sideways out of its landing."
 *
 * `fallFar`, `fallStartZ` and `jumpZSpeed` are deliberately NOT cleared here: clearing
 * `airborneSince` is enough, because the mover re-seeds all three the next time an airborne phase
 * opens and clears them on any grounded frame (`mover.ts:670-689`). Zeroing them here as well would
 * be a second, redundant authority over the same latch.
 */
function resumeAtRest(state: PlayerMoveState): void {
  state.serverRiding = false;
  state.moveFlags = 0;
  state.airborneSince = null;
  state.velZ = 0;
  state.horizVel.set(0, 0, 0);
}

/**
 * One frame of the self-spline ride. Writes `state` in place and says what the caller owes.
 *
 * `ride` is the player unit's own `splineRide`, set by the `SMSG_MONSTER_MOVE` handler when the
 * packet named our guid; `nowMs` must be the `performance.now()` clock the ride was built against
 * -- the ride's clock is the SERVER's, back-dated for a walk already in progress, so a dropped
 * frame must not slow the walk down.
 */
export function serverRideFrame(
  state: PlayerMoveState,
  ride: SplineRide | null,
  nowMs: number,
): ServerRideResult {
  // THE ABORT IS TAKEN FIRST, exactly as the reference takes it (`server_ride.rs:77-92`): a
  // teleport landed since last frame, so the server has already relocated us and is not waiting for
  // an ack. Mirroring the still-present spline this frame would clobber the snap.
  if (state.rideAbort) {
    state.rideAbort = false;
    state.rideStopSplineId = null;
    if (state.serverRiding || ride !== null) {
      resumeAtRest(state);
      serverRideStats.aborts += 1;
      rideStartedMs = 0;
      return { verdict: 'aborted', riding: false, ackSplineId: null, clearRide: true };
    }
    return IDLE;
  }

  if (ride !== null) {
    const engaged = !state.serverRiding;
    const sample = sampleSpline(ride, nowMs, state.pos);
    if (sample.facing !== null) {
      // The ride owns the aim as well as the body: a charge faces where it travels. `faceYaw` is
      // what the wire carries and `modelYaw` is what is drawn, and on a forward run the two are the
      // same -- the display-facing law's moving-forward case snaps the body onto the aim, so there
      // is no strafe gap to hold (`server_ride.rs:120-127`; `controls.tsx` step 6's `moving` arm).
      state.faceYaw = sample.facing;
      state.modelYaw = sample.facing;
    }

    if (sample.done) {
      // The sampler clamps to the last point, so the pose written above IS the server's endpoint --
      // exactly, not nearly. A `finalFacing` from the packet's facing block overrides the travel
      // tangent, the same precedence the creature path applies.
      if (ride.finalFacing !== null) {
        state.faceYaw = ride.finalFacing;
        state.modelYaw = ride.finalFacing;
      }
      // WHOSE ID? The one the server is actually waiting on -- a stop that cut the ride short is
      // the newest spline and `HandleMoveSplineDone` matches against that (see
      // `PlayerMoveState#rideStopSplineId`).
      const ackSplineId = state.rideStopSplineId ?? ride.id;
      state.rideStopSplineId = null;
      resumeAtRest(state);
      serverRideStats.lastRideMs = rideStartedMs > 0 ? nowMs - rideStartedMs : 0;
      serverRideStats.acks += 1;
      rideStartedMs = 0;
      return { verdict: 'ended', riding: false, ackSplineId, clearRide: true };
    }

    state.serverRiding = true;
    state.rideSplineId = ride.id;
    if (engaged) {
      serverRideStats.rides += 1;
      serverRideStats.lastRideFrames = 0;
      rideStartedMs = nowMs;
    }
    serverRideStats.frames += 1;
    serverRideStats.lastRideFrames += 1;
    // A forward run: the charge reads as a fast run because the gait selector keys on the FORWARD
    // flag plus the speed (`unit.ts#locomotionFlags` reads `move.moveFlags` for the player). It
    // also gives the resume and any observer a sane baseline. Note this word is NOT streamed --
    // the caller's ride guard skips the outbound stream, so nothing sends it; it exists to be read.
    state.moveFlags = MoveFlag.FORWARD;
    // **AND THE SPEED, WITHOUT WHICH THE FLAG PICKS NOTHING.** The gait selector keys on the
    // FORWARD flag PLUS the speed, and for the player `locomotionSpeed` reads `move.horizVel`
    // (`unit.ts:2312-2313` -- an INTENDED velocity, deliberately, which is exactly what this is).
    // Leaving it alone would run the charge at whatever the pre-ride frame's momentum was: Stand
    // for a standing caster, which is the reference's `motion.speed = spline.speed()` omitted
    // (`server_ride.rs:114-119`, "the gait selector keys on the FORWARD flag + speed"). The spline's
    // speed is its own length over its own duration, the same definition the creature leg uses.
    //
    // `velZ` goes to zero with it (`motion.vertical_speed = 0.0`): a ride is not a fall, and a
    // leftover descent would put FALLING on the first resumed frame's wire word.
    const rideSpeed = ride.total / Math.max(1e-3, ride.durationMs / 1000);
    state.horizVel.set(Math.cos(state.faceYaw) * rideSpeed, Math.sin(state.faceYaw) * rideSpeed, 0);
    state.velZ = 0;
    // NAMED, NOT HANDLED: `state.swimming` is not touched here, because nothing in this frame runs
    // the swim latch (`frame.ts#updateSwimming` lives inside the parked mover). A ride that begins
    // while swimming therefore keeps the swim gait for its duration and the stroke speed the last
    // swimming frame left. No charge is castable while swimming in 3.3.5a, so this is reachable
    // only by a knockback or a taxi over water, and neither is wired yet.
    return {
      verdict: engaged ? 'engaged' : 'riding',
      riding: true,
      ackSplineId: null,
      clearRide: false,
    };
  }

  // The ride vanished without ever reporting `done` -- a fresh packet cleared it, or the ride was
  // rejected as degenerate after we had already engaged. The server is still waiting, so the same
  // answer is owed from wherever the body now stands.
  if (state.serverRiding) {
    const ackSplineId = state.rideStopSplineId ?? state.rideSplineId;
    state.rideStopSplineId = null;
    resumeAtRest(state);
    serverRideStats.lastRideMs = rideStartedMs > 0 ? nowMs - rideStartedMs : 0;
    serverRideStats.acks += 1;
    rideStartedMs = 0;
    return { verdict: 'ended', riding: false, ackSplineId, clearRide: false };
  }

  // A stop with no ride behind it: the server halting a body it was already holding still (a fear
  // that ends between flee paths, a possession's opening `StopMoving`). "It arms the same wait and
  // owes the same answer" -- `server_ride.rs:163-176`.
  if (state.rideStopSplineId !== null) {
    const ackSplineId = state.rideStopSplineId;
    state.rideStopSplineId = null;
    serverRideStats.acks += 1;
    return { verdict: 'stopped', riding: false, ackSplineId, clearRide: false };
  }

  return IDLE;
}
