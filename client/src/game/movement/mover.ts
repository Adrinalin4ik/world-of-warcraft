import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import {
  AIR_NUDGE_SPEED, CAPSULE_HEIGHT, FALL_FAR_DROP, FALL_FAR_TIME, GRAVITY, GROUND_COS, GROUND_PROBE,
  JUMP_SPEED, LAND_PROBE, STEP_SLOPE_RATIO, STEP_SNAP_SLACK, TERMINAL_VELOCITY, WEDGE_MIN_FALL,
  WEDGE_STALL_RATIO, WEDGE_STILL_FRAMES,
} from './constants';
import { moveTrace } from './move-trace';
import { PlayerMoveState } from './player-state';
import { airborneHitResponse, groundedHitResponse, moveAndSlide } from './slide';
import { stepUp, StepUpVerdict } from './step-up';

const _down = new THREE.Vector3(0, 0, -1);

/** The election snap's probe reach and what it found -- trace fodder. */
export interface SnapTrace {
  reach: number;
  hit: { distance: number; normalZ: number } | null;
}

/** What one grounded walk step resolved against the world came out as. */
export interface GroundedStep {
  /** The resolved capsule centre. */
  center: THREE.Vector3;
  /**
   * The collider of the walkable floor the election snap settled onto, when it ran and hit one.
   * `null` means "keep whatever the caller already believed" -- a step-up commit and a missed snap
   * both leave the support unchanged.
   */
  ground: object | null;
  /** The atomic step-up's committed height gain (yd), when the maneuver ran. */
  climb: number | null;
  /** Why the step-up did or did not commit. */
  stepUpVerdict: StepUpVerdict | null;
  /** The election snap's probe, or null when the step-up took the frame instead. */
  snap: SnapTrace | null;
}

/**
 * ONE GROUNDED WALK STEP, resolved against the world -- step-up, then slide, then the election
 * snap.
 *
 * The single place a walking body meets the terrain, and deliberately so: the reference drives
 * EVERY mover through one controller. When networking lands, a remote mover's dead reckoning will
 * call this same function for its extrapolated step. An extrapolator that ignored the world would
 * walk a watched player into a hillside and leave their height wherever the last packet put it.
 *
 * Airborne and swimming frames are NOT this function's: a jump is a ballistic arc and a swimmer's Z
 * is its depth, exactly as the reference's grounded fork excludes both.
 */
export function groundedStep(
  cast: CastFn,
  center: THREE.Vector3,
  horizVel: THREE.Vector3,
  dt: number,
): GroundedStep {
  const speed = horizVel.length();

  // The step-up is ATOMIC: a steep face in the way triggers rise -> advance -> settle, all
  // committed inside this one frame, or nothing happens and the plain slide runs below.
  let stepUpVerdict: StepUpVerdict | null = null;
  if (speed > 1e-6) {
    const dirH = horizVel.clone().divideScalar(speed);
    const stepped = stepUp(cast, center, dirH, speed * dt);
    stepUpVerdict = stepped.verdict;

    if (stepped.landed) {
      // The committed maneuver IS this frame's motion -- already settled on a walkable floor, so
      // the slide and the snap below are skipped entirely.
      return {
        center: stepped.landed,
        ground: null,
        climb: stepped.climb,
        stepUpVerdict,
        snap: null,
      };
    }
  }

  const slid = moveAndSlide(cast, center, horizVel, dt, groundedHitResponse).position;

  // Snap onto the surface so we follow downhill slopes and steps down -- the client's step-vs-fall
  // election. The probe reaches `travel * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + collisionHeight`
  // below the post-move position, and snaps only onto a WALKABLE floor.
  //
  // A deeper or steeper floor is NOT absorbed: no snap, the next frame's ground probe misses, and
  // the gap becomes a fall. A short ledge drop therefore reads as a quick continuous descent rather
  // than a teleport.
  //
  // Standing still the reach is slack + collision height, which is what re-grounds an IDLE body
  // every frame and takes out the small float a raw position leaves.
  const dx = slid.x - center.x;
  const dy = slid.y - center.y;
  const reach = Math.hypot(dx, dy) * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT;
  const hit = cast(slid, _down, reach);
  const snap: SnapTrace = {
    reach,
    hit: hit ? { distance: hit.distance, normalZ: hit.normal.z } : null,
  };

  let ground: object | null = null;
  if (hit && hit.normal.z >= GROUND_COS) {
    slid.z -= hit.distance;
    ground = hit.source;
  }

  return { center: slid, ground, climb: null, stepUpVerdict, snap };
}

/**
 * ONE AIRBORNE STEP, resolved against the world -- the arc's slide and nothing else.
 *
 * No step-up and no election snap: the arc owns its own height (gravity carries it; the landing is
 * next frame's ground probe to call), so the only thing the world may do here is STOP it. Steep
 * faces get the same treatment they do on the ground.
 *
 * Exported alongside `groundedStep` for the same reason: when networking lands, a remote mover's
 * ballistic dead reckoning runs this, so a jump meets our walls whoever is jumping. Without it a
 * watched player who jumps into a building is drawn inside it for the length of the jump.
 */
export function airborneStep(
  cast: CastFn,
  center: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
): THREE.Vector3 {
  return moveAndSlide(cast, center, velocity, dt, airborneHitResponse).position;
}

/** This frame's movement intent, already resolved from keys and camera heading. */
export interface MoveInput {
  moving: boolean;
  /** Desired horizontal direction (world, Z-up). Need not be normalized. */
  dir: THREE.Vector3;
  /** Desired horizontal speed (yd/s). */
  speed: number;
  wantJump: boolean;
}

/**
 * What the step decided.
 *
 * This is the wire layer's ENTIRE integration surface: the reference builds its movement-flag diff,
 * its jump and land transitions and its heartbeat out of this plus the state fields. Returning it
 * now costs nothing and means networking does not reopen the mover.
 */
export interface Outcome {
  /** Settling after a teleport: frozen in place, gravity off. */
  held: boolean;
  /** On walkable ground and not rising this frame. */
  grounded: boolean;
  /** A jump took off this frame. */
  jumped: boolean;
  /** The standstill-jump air nudge fired. */
  airNudged: boolean;
  /** What we are standing on, if anything. */
  ground: object | null;
}

/**
 * Advance the player mover one frame.
 *
 * A thin kinematic controller over the swept cast:
 *  - probe down to classify the ground (walkable iff its normal is within ~50 degrees of up);
 *  - GROUNDED means on walkable ground AND not rising, so a jump cleanly leaves the ground and is
 *    not re-grounded the next frame -- the bug that ate most jumps. While airborne the probe
 *    tightens to LAND_PROBE, so the arc ends where the slide actually contacts;
 *  - grounded moves horizontally only, with NO gravity in the slide (gravity-in-the-slide was the
 *    downhill creep on micro-sloped terrain), then snaps onto the surface to follow it;
 *  - airborne, gravity carries the arc, with a one-shot nudge to steer a standstill jump;
 *  - a fall whose descent stalls -- a capsule wedged between steep faces -- LANDS there: standing,
 *    walking control live, instead of hanging in the falling pose forever.
 *
 * `now` is elapsed seconds; it drives the airborne clock.
 */
export function step(
  state: PlayerMoveState,
  cast: CastFn,
  input: MoveInput,
  dt: number,
  now: number,
): Outcome {
  const inputHoriz = input.moving && input.speed > 0
    ? input.dir.clone().normalize().multiplyScalar(input.speed)
    : new THREE.Vector3();

  const halfH = CAPSULE_HEIGHT * 0.5;
  let center = state.pos.clone();
  center.z += halfH;

  // While airborne, "on the ground" means where the slide actually contacts (LAND_PROBE). The wider
  // walking probe would end the arc up to 0.2 yd early and close the gap with a same-frame snap --
  // the visible pop at every silent landing.
  const groundReach = state.airborneSince !== null ? LAND_PROBE : GROUND_PROBE;
  const classify = cast(center, _down, groundReach);
  const onWalkable = !!classify && classify.normal.z >= GROUND_COS;
  let groundEntity: object | null = onWalkable && classify ? classify.source : null;

  // Settle hold: the streamed world arrives over several frames, so the ground under a teleport
  // destination is not there yet. Gravity OFF and frozen in place until it is.
  const held = state.settling;
  const onFloor = !held && onWalkable && state.velZ <= 0;

  // The wedged rest stands until real ground takes over or the support vanishes -- we walked off
  // the funnel wall into open air, which resumes a normal fresh fall.
  if (state.wedged && (onFloor || held || cast(center, _down, LAND_PROBE) === null)) {
    state.wedged = false;
  }
  let grounded = onFloor || state.wedged;

  let jumped = false;
  if (held) {
    state.velZ = 0;
    state.horizVel.set(0, 0, 0);
  } else if (grounded) {
    state.velZ = 0;
    if (input.wantJump) {
      state.velZ = JUMP_SPEED;
      state.wedged = false;
      jumped = true;
    }
  } else {
    state.velZ = Math.max(state.velZ - GRAVITY * dt, -TERMINAL_VELOCITY);
  }

  let airNudged = false;
  if (grounded) {
    state.horizVel.copy(inputHoriz);
  } else if (!held && input.moving && state.horizVel.lengthSq() < 0.01) {
    // Air control: one nudge to steer a jump taken from a standstill. A jump taken with momentum
    // keeps it locked, because horizVel is already non-zero.
    const dir = input.dir.clone();
    if (dir.lengthSq() > 1e-12) {
      state.horizVel.copy(dir.normalize().multiplyScalar(AIR_NUDGE_SPEED));
      airNudged = true;
    }
  }

  const preMove = center.clone();
  let climb: number | null = null;
  let snap: SnapTrace | null = null;
  let stepUpVerdict: StepUpVerdict | null = null;

  if (!held && grounded && !jumped) {
    const resolved = groundedStep(cast, center, state.horizVel, dt);
    center = resolved.center;
    climb = resolved.climb;
    snap = resolved.snap;
    stepUpVerdict = resolved.stepUpVerdict;
    if (resolved.ground) {
      groundEntity = resolved.ground;
    }
  } else {
    // Held zeroed both terms already, but say it outright. Jumping and airborne frames let gravity
    // carry the arc.
    const velocity = held
      ? new THREE.Vector3()
      : new THREE.Vector3(state.horizVel.x, state.horizVel.y, state.velZ);
    center = airborneStep(cast, center, velocity, dt);
  }

  // Wedge-rest detection: airborne, already falling fast, yet the descent achieved is a sliver of
  // what gravity intended. WEDGE_STILL_FRAMES in a row is a capsule held between steep faces -- a
  // ball in a V-groove; flaring tree-trunk bases form exactly this funnel, with contact normals
  // barely above horizontal, so there is no downward exit. Land it.
  //
  // Free fall achieves ~100% of its intent and a steep-slope slide >=75%, and a jump apex is slower
  // than WEDGE_MIN_FALL, so neither can trip this. Measuring against the INTENT -- which keeps
  // growing while the funnel eats the motion -- catches the pinch as it happens rather than after a
  // visible decelerating-millimetre tail in the falling pose.
  if (
    !held && !grounded && !jumped
    && state.velZ < -WEDGE_MIN_FALL
    && preMove.z - center.z < -state.velZ * dt * WEDGE_STALL_RATIO
  ) {
    state.wedgeStill += 1;
    if (state.wedgeStill >= WEDGE_STILL_FRAMES) {
      state.wedged = true;
      state.wedgeStill = 0;
      state.velZ = 0;
    }
  } else {
    state.wedgeStill = 0;
  }

  // The frame that detects the wedge reports grounded immediately, so the falling pose ends now and
  // the wire will see a normal landing this frame rather than next.
  grounded = grounded || state.wedged;

  state.pos.copy(center);
  state.pos.z -= halfH;

  // Airborne bookkeeping: the arc's clock, its launch snapshot, and the FALLINGFAR latch.
  //
  // `jumped` has to be part of the test, not just `!grounded`. On the takeoff frame the body is
  // still standing on the floor it is leaving, so `grounded` is true -- and treating that as "on
  // the ground" clears the arc the instant it begins. The next frame then re-opens it as a fresh
  // STEP-OFF fall with a launch speed of 0, which sends a jump down the FALLINGFAR timer leg
  // instead of its distance leg, and latches it near the apex while still rising.
  const airborne = !held && (jumped || !grounded);
  if (airborne) {
    if (state.airborneSince === null) {
      state.airborneSince = now;
      // A jump launches with JUMP_SPEED; a step-off fall launches with EXACTLY 0 -- the walk
      // election's StartFalling(0). The two FALLINGFAR legs are exclusive on this value.
      state.jumpZSpeed = jumped ? JUMP_SPEED : 0;
      state.fallStartZ = state.pos.z;
      state.fallFar = false;
    }
    if (!state.fallFar) {
      state.fallFar = state.jumpZSpeed !== 0
        ? state.fallStartZ - state.pos.z >= FALL_FAR_DROP
        : now - state.airborneSince >= FALL_FAR_TIME;
    }
  } else if (!held) {
    // Landing clears the arc, exactly as the client's StopFalling does.
    state.airborneSince = null;
    state.fallFar = false;
  }

  moveTrace.frame({
    zIn: preMove.z - halfH,
    zOut: state.pos.z,
    grounded,
    onWalkable,
    velZ: state.velZ,
    snap,
    climb,
    stepUpVerdict,
  });

  return {
    held,
    grounded,
    jumped,
    airNudged,
    ground: grounded && !held ? groundEntity : null,
  };
}
