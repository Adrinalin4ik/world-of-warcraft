import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import {
  AIR_NUDGE_SPEED, CAPSULE_HEIGHT, SKIN_WIDTH, FALL_FAR_DROP, FALL_FAR_TIME, GRAVITY, GROUND_COS, GROUND_PROBE,
  JUMP_SPEED, LAND_PROBE, STEP_SLOPE_RATIO, STEP_SNAP_SLACK, TERMINAL_VELOCITY, WEDGE_MIN_FALL,
  WEDGE_STALL_RATIO, WEDGE_STILL_FRAMES,
  STEP_UP_ADVANCE,
} from './constants';
import { MoveTraceFrame, moveTrace } from './move-trace';
import { PlayerMoveState } from './player-state';
import { airborneHitResponse, groundedHitResponse, moveAndSlide, SlideIteration } from './slide';
import { stepUp, StepUpResult, StepUpVerdict } from './step-up';

const _down = new THREE.Vector3(0, 0, -1);


/** The election snap's probe reach and what it found -- trace fodder. */
export interface SnapTrace {
  reach: number;
  /** The nearest WALKABLE contact -- what the snap acts on. */
  hit: { distance: number; normalZ: number } | null;
  /**
   * The nearest contact of ANY kind, recorded only while `moveTrace.enabled`.
   *
   * Without this the trace would be blind to the defect it was used to find. `hit` is now
   * walkable-filtered, so a steep face shadowing the floor at distance zero -- 727 of 744 latch
   * frames in the `JW2` capture -- can no longer appear in it at all. `nearest` differing from
   * `hit` is precisely "something non-walkable is closer than the floor", which is the reading that
   * diagnosed this and would diagnose its return.
   */
  nearest?: { distance: number; normalZ: number } | null;
}

/** What one grounded walk step resolved against the world came out as. */
export interface GroundedStep {
  /** The resolved capsule centre. */
  center: THREE.Vector3;
  /** The snap saw a walkable floor further below than this frame was allowed to descend. */
  stepDown: boolean;
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
  /** The step-up's intermediate numbers, present only while the trace is on. */
  stepUpDetail?: StepUpResult['detail'];
  /** The election snap's probe, or null when the step-up took the frame instead. */
  snap: SnapTrace | null;
  /** How many contacts the slide resolved, and what the first one was. Trace fodder. */
  contacts: number;
  blockedBy: { normalZ: number; distance: number } | null;
  /** Per-iteration slide record, populated only while `moveTrace.enabled`. */
  slide: SlideIteration[] | null;
}

/**
 * The election snap's probe REACH for a step that travelled `travelXY` yards horizontally.
 *
 * Extracted so the peer path can run the snap alone (`snapToGround`) under the same law the local
 * mover's full step uses. Two copies of this expression is how the two silently stop agreeing.
 */
export function snapReach(travelXY: number): number {
  return travelXY * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT;
}

/**
 * THE ELECTION SNAP ALONE: how far below `center` the walkable floor is, or null if none is in reach.
 *
 * One cast. This is the cheap half of `groundedStep` and it is the half that supplies HEIGHT -- the
 * step-vs-fall election that makes a walker follow a slope and a step down instead of holding the last
 * height it was told.
 *
 * WHY IT EXISTS SEPARATELY, measured rather than assumed. A peer's dead-reckoned step was first run
 * through the whole of `groundedStep`, as the reference does (decision 0626). Interleaved A/B on one
 * live session, 83 entities and ONE observed peer: `anim` p50 1.5 -> 7.2 ms and `world.animate` p50
 * 4.9 -> 10.8 ms, i.e. 5.7 ms of frame time for one peer. `groundedStep` is six to eight swept casts
 * (step-up's rise/advance/settle, the slide's up-to-four iterations, then this snap) and every cast
 * re-gathers candidate triangles over its own broadphase box; the reference pays for that on Avian's
 * persistent BVH and this client does not have one. Five peers would have eaten the whole frame.
 *
 * So a peer gets THIS and nothing else, and what that costs him is stated plainly at the call site:
 * no step-up and no swept slide, so our invented step is not stopped by our walls. That is the other
 * half of the reference's own `WOW_REMOTE_FLAT` behaviour and it is knowingly retained -- the owner
 * reported the height (a peer "teleporting" every half second and sinking into the ground), not a peer
 * inside a building, and the height is what one cast buys.
 *
 * `skin` DEFAULTS to `SKIN_WIDTH` for the local mover, which wants to rest a hair above the floor --
 * resting at a zero gap is what dead-stopped every uphill step (see `groundedStep`). A peer wants ZERO,
 * and the difference is measurable: with a 0.02 yd skin the cast returns distance 0 for any frame whose
 * ground change is smaller than the skin, so a walker on a gentle slope accumulates height error inside
 * that dead band until a packet clears it -- measured, the rendered Z's per-frame p50 was exactly 0 and
 * the tail still carried 0.89 yd steps at packet arrivals. A peer does no horizontal sweep here, so the
 * dead-stop the skin protects against cannot arise for him.
 */
export function snapToGround(
  cast: CastFn,
  center: THREE.Vector3,
  travelXY: number,
  skin: number = SKIN_WIDTH,
): number | null {
  const hit = cast(center, _down, snapReach(travelXY), skin, GROUND_COS);
  if (!hit || hit.normal.z < GROUND_COS) {
    return null;
  }
  return hit.distance;
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

  // The height the certification promised, for the trace only -- what the frame actually gains is
  // the pop above minus whatever the settle below takes back.
  let climbCertified: number | null = null;

  /**
   * **THE STEP-UP CERTIFIES; THIS FRAME RISES IN PLACE AND THEN WALKS.**
   *
   * It used to return the probe's own landing as the whole of the frame's motion, skipping the
   * slide and the snap. Two things were wrong with that and the reference corrected both
   * (`step-up.ts`'s header carries the citations):
   *
   *  - the landing sits one full ADVANCE downrange, so committing it teleports the body a body
   *    length forward in one frame -- ten frames of travel at ten times walking speed;
   *  - the advance was this frame's travel, which is shorter than the capsule is wide, so the
   *    settle could not see over a lip and a small step never certified at all. That is the defect
   *    the owner reported, measured: `fwd` = `travel` = 0.18, elevated sweep entirely free, settle
   *    descending 0.6991 of a 0.7 rise back onto its own floor, `climb` 0.0009, refused.
   *
   * So the maneuver now reaches a body length to DECIDE, and the frame commits only the vertical
   * rise. Everything after this is the ordinary flat-ground path, which is the point: there is no
   * second movement code path to disagree with the first, and a certification that turns out wrong
   * is undone by the snap below rather than stranding the body in the air.
   */
  let stepUpVerdict: StepUpVerdict | null = null;
  let stepUpDetail: StepUpResult['detail'];
  let start = center;
  if (speed > 1e-6) {
    const dirH = horizVel.clone().divideScalar(speed);
    const travel = speed * dt;
    // The look-ahead is the frame; the advance is the body. `travel` still wins when it is longer,
    // so a very low frame rate never steps you less far than you asked to walk.
    const stepped = stepUp(cast, center, dirH, travel, Math.max(travel, STEP_UP_ADVANCE));
    stepUpVerdict = stepped.verdict;
    stepUpDetail = stepped.detail;

    if (stepped.rise > 0) {
      start = center.clone();
      start.z += stepped.rise;
      climbCertified = stepped.climb;
    }
  }

  let firstContact: { normalZ: number; distance: number } | null = null;
  // Allocated only while the trace is on, so a normal frame still allocates nothing here.
  const iterations: SlideIteration[] | null = moveTrace.enabled ? [] : null;
  const slide = moveAndSlide(cast, start, horizVel, dt, (hit) => {
    if (firstContact === null) {
      firstContact = { normalZ: hit.normal.z, distance: 0 };
    }
    groundedHitResponse(hit);
  }, iterations ?? undefined);
  const slid = slide.position;

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
  // Measured from `start`, not from `center`: after a pop those differ by the rise, and a reach
  // computed from the pre-pop centre would be a reach for a horizontal distance never travelled.
  const dx = slid.x - start.x;
  const dy = slid.y - start.y;
  const reach = snapReach(Math.hypot(dx, dy));
  // SKIN_WIDTH, so the body settles a hair ABOVE the floor rather than exactly on it.
  //
  // Resting at a zero gap is what dead-stopped every uphill step: the horizontal sweep reported a
  // contact with the floor underfoot at distance zero, the ride redirected the velocity along the
  // plane, and the next iteration reported the same zero-distance contact again -- because on a
  // slope the approach rate along the surface is ~1e-3, small but not zero, so the face is never
  // skipped. Four iterations, no movement. A skin gap makes the same sweep clear the floor by a
  // wide margin.
  // Walkable-filtered for the same reason the grounded test is (see `step`): this asks where the
  // FLOOR is, and taking the nearest hit instead let a steep face touching the capsule at distance
  // zero refuse the snap, leaving the body up to the slide's ride-lift above the ground it is
  // standing on -- which is the other half of what latched it airborne.
  const hit = cast(slid, _down, reach, SKIN_WIDTH, GROUND_COS);
  const snap: SnapTrace = {
    reach,
    hit: hit ? { distance: hit.distance, normalZ: hit.normal.z } : null,
  };

  // Diagnostic only, and it costs a second cast -- so it runs ONLY while the trace is on, which is
  // never in a normal session. See `SnapTrace#nearest`.
  if (moveTrace.enabled) {
    const nearest = cast(slid, _down, reach, SKIN_WIDTH);
    snap.nearest = nearest
      ? { distance: nearest.distance, normalZ: nearest.normal.z }
      : null;
  }

  // Kept alongside the filter for the same reason the grounded test keeps its own -- see `step`.
  let ground: object | null = null;
  /**
   * **THE REACH IS HOW FAR WE CAN SEE; THE DESCENT IS HOW FAR WE MAY GO. They were the same
   * number, and that is a teleport.**
   *
   * Measured on the owner's own fall, the frame that tripped the drop trap: nine frames climbing a
   * `normalZ` 0.90 surface at 0.09 yd a frame with the snap probe reporting distance 0.000 -- resting
   * exactly on it -- and then ONE frame where the nearest walkable floor was **1.518 yd below**, taken
   * whole. 1.426 yd of height gone in a single frame, which is what "я проваливаюсь под текстуры"
   * looks like from the inside.
   *
   * The reference names this exactly and it is about OUR body, not its own: its mover is a cone at the
   * foot, so stepping off an edge its skirt stays in contact the whole way down and the descent comes
   * out at the cone's own slope without any cap being needed -- the geometry IS the cap. A capsule
   * touches the edge side-on and then hangs clear, so the identical instruction sees the entire
   * remaining drop and spends it at once. Same law, different body, opposite look. So we port the
   * cone's EFFECT: one cone's worth of descent per frame
   * (`samples/benilla/crates/benilla-app/src/player/mover.rs:665-690`, decision 1132).
   *
   * The REACH is deliberately left alone at `snapReach`, deep. Seeing further and falling further are
   * different questions, and the deep reach is what keeps the body grounded on a face steeper than
   * one frame can follow -- which is what stops the cap from becoming a dive.
   *
   * A KNOWN DIVERGENCE, stated rather than discovered later: the reference collapses its REACH to the
   * slack alone when standing still, so an idle body far above a floor is never re-grounded and simply
   * falls. Ours still sees it and now descends at the slack per frame instead of snapping. The case
   * needs a body dislocated vertically with no input, which `settling` already freezes; after an
   * ordinary landing the drop is a skin width and costs about three frames. Taking the conditional
   * reach (decision 1129) as well belongs in its own change: it alters what is SEEN, and a pending
   * measurement in this very area asks exactly that question.
   */
  const coneReach = Math.hypot(dx, dy) * STEP_SLOPE_RATIO + STEP_SNAP_SLACK;
  let stepDown = false;
  if (hit && hit.normal.z >= GROUND_COS) {
    slid.z -= Math.min(hit.distance, coneReach);
    ground = hit.source;
    // Further than the cone could rest, but in sight: the next frames finish it, and the caller
    // keeps the body grounded meanwhile rather than letting the fall elect.
    stepDown = hit.distance > coneReach;
  }

  return {
    center: slid, ground, stepDown, climb: climbCertified, stepUpVerdict, stepUpDetail, snap,
    contacts: slide.contacts, blockedBy: firstContact, slide: iterations,
  };
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
  /**
   * The push-out, or undefined to go without one.
   *
   * OPTIONAL so every existing caller and every movement test is unchanged -- the rule set is
   * unit-tested with no world loaded, which is the property that made this whole module diagnosable
   * from a console trace.
   */
  depenetrate?: (center: THREE.Vector3, skin?: number, count?: boolean) => THREE.Vector3 | null,
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
  // "Is there walkable ground under me", NOT "is the nearest thing under me walkable". The two
  // differ exactly where this defect lived. `castCapsuleAgainstTriangles` reports `distance: 0` for
  // any face already touching the capsule that the probe is driving into, and for a downward probe
  // that is every face with `n.z > 0` -- so a near-vertical wall the capsule's flank is brushing
  // wins the minimum at zero distance and HIDES the grass under the feet. The old form then read
  // `normal.z = 0.08 < GROUND_COS`, called it not walkable, and latched the body airborne.
  //
  // MEASURED, walking four bearings as `Gesf` with `moveTrace` on: 744 frames reported
  // `onWalkable: false`, and 727 of them had the snap probe finding a face at distance 0.000 with
  // `normalZ = 0.080`. ZERO of the 744 had no hit at all, i.e. not one was a real ledge, and 731 of
  // them did not descend. Two of those latches reached the wire as `MSG_MOVE_JUMP` /
  // `MSG_MOVE_FALL_LAND` pairs 214 ms and 85 ms apart with dz -0.126 and 0.000 -- a character who
  // an observer sees hop while walking. The previous round's capture has the same fingerprint at a
  // different spot: two pairs 23 ms apart with dz +0.001 and -0.003 (`B1-wire.json`).
  //
  // Passing the walkability threshold INTO the cast keeps this at one probe per frame. Nothing is
  // suppressed: a body with no walkable face within reach still latches airborne and still sends
  // the jump, which is what the phase-B jumps in the same capture confirm.
  // The `>= GROUND_COS` test is KEPT rather than left to the filter. `minNormalZ` is a hint to a
  // `CastFn`, and a CastFn is an interface -- every movement unit test supplies its own, and none of
  // them honour it. The rule must live where it can be tested, and the filter must not be the only
  // thing standing between a steep face and "grounded".
  const classify = cast(center, _down, groundReach, 0, GROUND_COS);
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
  // `stepDown` joins `wedged` for the same reason and on the same terms: a descent still in
  // progress is standing, not falling. It is re-decided from every grounded frame's snap below, so
  // it cannot latch -- walking off into open air leaves the snap with no hit and clears it.
  let grounded = onFloor || state.wedged || state.stepDown;

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
  let stepUpDetail: StepUpResult['detail'];
  let contacts = 0;
  let blockedBy: { normalZ: number; distance: number } | null = null;
  let slideIterations: SlideIteration[] | null = null;
  let pushOutReason: MoveTraceFrame['pushOutReason'];

  if (!held && grounded && !jumped) {
    const resolved = groundedStep(cast, center, state.horizVel, dt);
    center = resolved.center;
    climb = resolved.climb;
    snap = resolved.snap;
    stepUpVerdict = resolved.stepUpVerdict;
    stepUpDetail = resolved.stepUpDetail;
    contacts = resolved.contacts;
    blockedBy = resolved.blockedBy;
    slideIterations = resolved.slide;
    state.stepDown = resolved.stepDown;
    if (resolved.ground) {
      groundEntity = resolved.ground;
    }

    /**
     * **STUCK: PUSH OUT.** Only here, and only on this condition.
     *
     * The owner, under the abbey stairs: "я просто провалился под ступеньку... нужно выталкивания
     * сделать". The trace agrees -- four slide iterations, every one `travelled: 0`, every contact
     * against a face whose normal is `(~0, ~0, -1)`. A capsule touching the UNDERSIDE of a tread is
     * inside the tread, and a sweep cannot recover from that: it answers what lies along a
     * direction, and while inside, every direction is blocked at distance zero.
     *
     * THE CONDITION IS THE WHOLE COST CONTROL. A push-out needs the candidate SET and a
     * capsule-triangle distance per candidate -- 60 to 240 of them at the abbey, times up to four
     * passes. Run every frame that is a real per-frame bill for a state that is rare; run only when
     * the body ASKED to move, CONTACTED something and travelled nothing, and the ordinary frame pays
     * one subtraction.
     *
     * Wanting to move is part of the test on purpose: a body standing still against a wall also
     * travels nothing, and it is not stuck -- it is standing.
     *
     * The correction lands on the position and takes effect next frame; nothing is re-run here. That
     * keeps this a recovery rather than a second movement path, and it is why one frame of visible
     * stall is the worst case.
     */
    /**
     * WHY IT DID NOT RUN IS AS DIAGNOSTIC AS WHETHER IT RAN, and the first reading proved it: the
     * owner walked a step he could not climb and came back with `fired: 0` beside 234 frames that
     * had a contact and travelled nothing. Four different things produce that -- the closure never
     * reached the mover, there was no contact, there was no input, or the centre DID move -- and
     * only one of them is a defect in this gate. A bare zero cannot say which.
     *
     * **THE READING CAME BACK `moved` ON ALL 532 OF THEM, so the gate is fixed and this note records
     * that it was earned rather than guessed.** `before` was the full 3D centre, and the snap re-seats
     * Z by a hair every frame, so a body horizontally PINNED still cleared a 3D threshold -- the
     * push-out was unreachable code in the only state it exists for. It now measures horizontal
     * displacement, which is what "stuck" means for a walker.
     */
    if (moveTrace.enabled) {
      if (depenetrate === undefined) {
        pushOutReason = 'absent';
      } else if (resolved.contacts === 0) {
        pushOutReason = 'no-contact';
      } else {
        pushOutReason = 'ran';
      }
    }

    /**
     * **MEASURE THE PENETRATION; DO NOT INFER IT FROM "DID NOT MOVE". I gated this on movement three
     * times and it failed to reach the state three times.**
     *
     * The record, because the pattern is the lesson:
     *
     *  1. 3D displacement under `1e-12` -- declined 532 of 532, because the election snap re-seats Z by
     *     a hair every frame while the body is horizontally pinned;
     *  2. HORIZONTAL displacement under `1e-6` -- declined 18 of 18 at the abbey, where the measured
     *     creep was 0.0006 yd a frame, six hundred times the threshold;
     *  3. horizontal under `1e-3` -- and then the fence: "он упирается в забор и камера дергается то
     *     туда то обратно... микро сдвиг". A thin rail has two OPPOSED faces, so a body inside it is
     *     pushed alternately by each and travels a millimetre every frame, forever. Five seconds of it
     *     produced `stallFrames: 0`.
     *
     * Each gate was a better guess than the last and all three were the same mistake: "did not move" is
     * not what "inside geometry" means. An oscillating body moves constantly and is exactly as stuck as
     * a still one.
     *
     * So the condition is now the measurement itself. `depenetrateCapsule` returns null when the body is
     * free -- its first pass IS the overlap scan -- so asking it is the same work as testing whether to
     * ask, and there is no threshold left to be wrong about.
     *
     * COST, stated: a candidate gather plus one capsule-triangle distance per candidate, on every
     * grounded frame that resolved a contact. At the abbey that is 255 WMO triangles; the four slide
     * iterations the same frame already sweep the same set, so it is roughly a quarter more collision
     * work while brushing geometry, and nothing at all on open ground. The frame budget here is already
     * marginal (p50 16.6 against 16.7), so if this shows up it is the first thing to bound -- by
     * running it every other frame, or only while a contact persists. I have not measured it live and
     * am not claiming otherwise.
     */
    if (depenetrate !== undefined && resolved.contacts > 0) {
      const freed = depenetrate(center, SKIN_WIDTH);
      if (freed !== null) {
        pushOutReason = 'freed';
        center = freed;
      }
    }
  } else {
    // **THE DESCENT FLAG IS CLEARED HERE, and leaving it out was a latch I wrote and caught.** It is
    // only ever SET from a grounded frame's snap, so an airborne, jumping or held frame that never
    // reaches that assignment would carry the last grounded frame's `true` for the whole arc -- and
    // `grounded` reads it, so a jump would report standing in mid-air. `wedged` beside it has its own
    // explicit clear for the same reason.
    state.stepDown = false;

    // Held zeroed both terms already, but say it outright. Jumping and airborne frames let gravity
    // carry the arc.
    const velocity = held
      ? new THREE.Vector3()
      : new THREE.Vector3(state.horizVel.x, state.horizVel.y, state.velZ);
    const beforeAir = center.z;
    center = airborneStep(cast, center, velocity, dt);

    /**
     * **A JUMP THAT WENT NOWHERE IS PROOF OF PENETRATION, and it is the only proof available while
     * the body is standing still.**
     *
     * The owner, at a fence: "не могу прыгать, он упирается в забор и не прыгает вверх. Даже без
     * зажатой w... при этом анимация проигрывается." That last clause is the measurement. The jump was
     * ELECTED -- `velZ` set, the event dispatched, the animation running -- and the world refused the
     * motion. An upward sweep is refused at distance zero only by a face the capsule is already inside.
     *
     * The grounded push-out cannot reach this state and never will: it needs a CONTACT, and a slide
     * with no velocity resolves none, so a body standing still inside geometry reports `no-contact`
     * every frame (measured: 30 of 30 on his own dump). Without input there is nothing to notice the
     * penetration WITH -- except a motion the player asked for and did not get.
     *
     * So the jump doubles as the recovery gesture, which is also how it reads to a player: press space,
     * come unstuck. HALF the expected rise is the bar rather than zero, because a legitimate jump into
     * a low ceiling is clipped part-way and is not penetration.
     *
     * Cost is confined to rising frames -- a fraction of a second per jump -- and to those where the
     * rise was actually refused.
     */
    if (depenetrate !== undefined
      && velocity.z > 0
      && center.z - beforeAir < velocity.z * dt * 0.5) {
      const freed = depenetrate(center, SKIN_WIDTH);
      if (freed !== null) {
        center = freed;
        if (moveTrace.enabled) {
          pushOutReason = 'freed';
        }
      } else if (moveTrace.enabled) {
        pushOutReason = 'ran';
      }
    }
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

  /**
   * The penetration MEASUREMENT -- see `MoveTraceFrame#penetration`. Trace-only, and deliberately
   * outside the stuck gate: the state it exists to expose is one the gate cannot reach.
   *
   * `skin` 0, so this reports the overlap itself rather than the overlap plus a clearance.
   */
  let penetration: number | undefined;
  if (moveTrace.enabled && depenetrate !== undefined) {
    const centre = state.pos.clone();
    centre.z += halfH;
    const freed = depenetrate(centre, 0, false);
    penetration = freed === null ? 0 : freed.distanceTo(centre);
  }

  moveTrace.frame({
    penetration,
    zIn: preMove.z - halfH,
    zOut: state.pos.z,
    speed: state.horizVel.length(),
    x: state.pos.x,
    y: state.pos.y,
    grounded,
    onWalkable,
    velZ: state.velZ,
    snap,
    climb,
    stepUpVerdict,
    stepUpDetail,
    pushOutReason,
    contacts,
    blockedBy,
    slide: slideIterations ?? undefined,
    travelXY: Math.hypot(state.pos.x - (preMove.x), state.pos.y - (preMove.y)),
  });

  return {
    held,
    grounded,
    jumped,
    airNudged,
    ground: grounded && !held ? groundEntity : null,
  };
}
