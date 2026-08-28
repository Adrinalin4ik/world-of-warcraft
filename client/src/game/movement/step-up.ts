import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import { moveTrace } from './move-trace';
import {
  GROUND_COS, SKIN_WIDTH, STEP_SLOPE_RATIO, STEP_SNAP_SLACK, STEP_UP_HEIGHT,
} from './constants';

/**
 * Why the step-up did or did not commit.
 *
 * Trace fodder, and the whole diagnosis of a "it feels stuck here" report: reasoning alone cannot
 * distinguish a face that was too tall from one whose landing was too steep, and they want opposite
 * fixes.
 */
export type StepUpVerdict =
  | 'commit'
  | 'no-obstacle'
  | 'no-headroom'
  | 'no-floor'
  | 'steep-floor'
  | 'net-zero'
  | 'no-descent';

export interface StepUpResult {
  verdict: StepUpVerdict;
  /**
   * **THE RISE TO COMMIT -- VERTICAL, IN PLACE. This, and not `landed`, is what the frame does.**
   *
   * 0 unless certified. See the header for why committing `landed` was wrong in kind.
   */
  rise: number;
  /**
   * DIAGNOSTIC ONLY: where the certification's settle found floor, one full advance downrange.
   *
   * Committing this as the frame's position is the teleport the reference removed. It is kept
   * because the trace reads it, and named here so it cannot be re-adopted by accident.
   */
  landed: THREE.Vector3 | null;
  /** DIAGNOSTIC ONLY: the height the settle certified, i.e. the reference's `dy`. */
  climb: number;
  /**
   * The maneuver's INTERMEDIATE numbers, recorded only while `moveTrace.enabled`.
   *
   * **THE VERDICT ALONE CANNOT BE ACTED ON, WHICH IS WHY THIS EXISTS.** The owner walked a small
   * step he could not climb and the trace came back `net-zero` on 244 of 597 frames -- and
   * `net-zero` is the CORRECT answer for a wall, a graze and a too-tall face, so the count says
   * nothing about which of them he was standing at. The three want opposite fixes: a wall wants no
   * change at all, a blocked advance wants a longer ADVANCE, a mis-measured landing wants the
   * SETTLE looked at.
   *
   * `climb` is `rise - downDist` by construction, so the pair localises the failure exactly: on a
   * step of height h a healthy maneuver reads `rise` 0.7, `forward` the full travel and `downDist`
   * about `0.7 - h`. `forward` at 0 says the raised capsule could not advance -- the face is a wall
   * or the advance is too short to clear the tread. `downDist` at the full `rise` says it advanced
   * and then landed back on its own floor.
   *
   * Gated, because this allocates an object and copies a normal per call, and the step-up runs every
   * frame a walker has input. Off, it costs one boolean read.
   */
  detail?: {
    /** The opposing face: distance to it and its normal, as the RISE test saw them. */
    aheadDist: number;
    aheadN: [number, number, number];
    /** Free headroom taken, at most STEP_UP_HEIGHT. */
    rise: number;
    /** How far the raised capsule actually advanced, against `travel` asked for. */
    forward: number;
    travel: number;
    /** The body-scaled forward reach actually used. */
    advance: number;
    /** The settle: how far it descended, and the floor normal it found. */
    downDist: number | null;
    downNz: number | null;
  };
}

const _up = new THREE.Vector3(0, 0, 1);
const _down = new THREE.Vector3(0, 0, -1);

/**
 * **THE STEP-UP IS A CERTIFICATION, NOT A MOVE -- two corrections, both measured, both the
 * reference's own.**
 *
 * 1. **`look` and `advance` are different questions.** "Is there a steep face in my way NOW" is
 *    about this frame, so the look-ahead is this frame's travel. "How far must I reach to see the
 *    tread I would stand on" is about the BODY, so the advance is at least `STEP_UP_ADVANCE`
 *    whatever the frame rate or the gait. Passing travel for both is what made a small step
 *    unclimbable: the settle never got past the lip and landed back on its own floor
 *    (`constants.ts#STEP_UP_ADVANCE` carries the owner's trace and the arithmetic).
 *
 * 2. **What the frame commits is a RISE, never this probe's landing.** Committing `landed` puts a
 *    full advance of horizontal teleport into every step-up -- ten frames of travel in one frame,
 *    at ten times walking speed -- and the reference's own reading says it is wrong in KIND and not
 *    merely in magnitude: `0x636193`'s length is never added to a position, every position write in
 *    the walk resolver is RELATIVE, and what the certified arm commits is a free vertical segment
 *    after which the caller's own heading resumes with the budget that is left
 *    (`samples/benilla/crates/benilla-app/src/player/mover.rs:511-536`, decision 1130).
 *
 *    So the caller rises in place and lets the ordinary slide and the ordinary settle own the
 *    frame, exactly as they do on flat ground. The settle cannot strand the body up there: its
 *    reach always reads back past the height just gained, so it finds the obstacle's top or the
 *    ground we left -- which makes a WRONG certification self-correcting rather than a stall.
 *
 * NOT PORTED, and named so the gap is not silent: the foot-cone RIDE (`mover.rs:487-509`, decision
 * 1123). The real client's movement solid is a cone below `FOOT_CONE_HEIGHT`, so a low edge meets a
 * slanted skirt and is ridden up over several frames instead of popped. Without it a low step takes
 * the atomic pop, which is a coarser look and not a stall. The cone-capped descent (decision 1132)
 * is absent for the same reason.
 *
 * ---
 *
 * The maneuver itself: a steep opposing face within
 * this frame's travel triggers RISE, ADVANCE, SETTLE, committed whole inside one frame, or nothing
 * happens and the plain slide runs.
 *
 * - RISE by the free headroom, at most STEP_UP_HEIGHT -- the deliberately low ceiling that scopes
 *   this to stairs, doorsteps and low rocks, and keeps fences and walls slide-only.
 * - ADVANCE `advance` along the INPUT direction at the raised height, clipped by whatever is in
 *   the way -- so the reach only ever spends the clear air that is actually there.
 * - SETTLE back down by the walk election's own reach; commit ONLY onto a walkable floor that is
 *   actually higher.
 *
 * The atomicity is the design, not an implementation detail. Case by case: a square push at a low
 * step lands on its top this frame; a grazing rub settles back onto the same floor, nets zero, and
 * reads as sliding along; a face taller than the ceiling leaves no forward clearance at the raised
 * height, so the settle lands back on the origin floor and it slides; a pinch between two tree
 * trunks offers only steep landings, so it can NEVER commit.
 *
 * The wedge-and-bounce class of bugs is therefore impossible by construction rather than by guard:
 * there is no intermediate mid-climb state to be caught in.
 *
 * `dirH` must be a unit horizontal vector.
 */
export function stepUp(
  cast: CastFn,
  center: THREE.Vector3,
  dirH: THREE.Vector3,
  /** The look-ahead: this frame's travel. */
  travel: number,
  /** The forward reach of the rise/settle probe -- a body length, not a frame. */
  advance: number,
): StepUpResult {
  // The trace record, filled in as the maneuver proceeds so a MISS carries whatever it had reached.
  // Undefined when the trace is off, and every write below is guarded by that.
  const detail: StepUpResult['detail'] = moveTrace.enabled
    ? {
      aheadDist: -1, aheadN: [0, 0, 0], rise: 0, forward: 0, travel, advance, downDist: null, downNz: null,
    }
    : undefined;

  const miss = (verdict: StepUpVerdict): StepUpResult => ({
    landed: null, verdict, climb: 0, rise: 0, detail,
  });

  // A steep, non-overhanging face opposing the motion, within this frame's travel. No incidence
  // gate -- the verified reference has none, and a grazing contact nets zero through the settle
  // instead, which is what makes it read as sliding along rather than dead-stopping.
  const ahead = cast(center, dirH, travel);
  if (!ahead) {
    return miss('no-obstacle');
  }

  const n = ahead.normal;
  if (detail) {
    detail.aheadDist = ahead.distance;
    detail.aheadN = [n.x, n.y, n.z];
  }
  if (n.z >= GROUND_COS || n.z < 0 || n.dot(dirH) >= 0) {
    return miss('no-obstacle');
  }

  // RISE: the free headroom, at most STEP_UP_HEIGHT.
  const upHit = cast(center, _up, STEP_UP_HEIGHT);
  const rise = upHit ? upHit.distance : STEP_UP_HEIGHT;
  if (detail) {
    detail.rise = rise;
  }
  if (rise < 1e-3) {
    return miss('no-headroom');
  }

  // ADVANCE: this frame's travel along the input direction, swept at the raised height.
  const raised = center.clone().addScaledVector(_up, rise);
  const forwardHit = cast(raised, dirH, advance);
  const forward = forwardHit ? forwardHit.distance : advance;
  if (detail) {
    detail.forward = forward;
  }
  const over = raised.clone().addScaledVector(dirH, forward);

  // SETTLE: the walk election's reach below the advanced point -- the rise undone, plus the
  // travel-scaled step-down allowance -- onto a WALKABLE floor only.
  const reach = rise + advance * STEP_SLOPE_RATIO + STEP_SNAP_SLACK;
  // Same skin as the election snap: a committed step must not land flush against its floor.
  const downHit = cast(over, _down, reach, SKIN_WIDTH);
  if (!downHit) {
    return miss('no-floor');
  }
  if (detail) {
    detail.downDist = downHit.distance;
    detail.downNz = downHit.normal.z;
  }
  if (downHit.normal.z < GROUND_COS) {
    return miss('steep-floor');
  }

  // A SETTLE THAT DID NOT DESCEND IS NOT A LANDING.
  //
  // `distance === 0` does not mean "the floor is exactly here". `castCapsuleAgainstTriangles`
  // reports zero for any face already within `CAPSULE_CAST_EPS` that the probe is driving into
  // (`capsule-cast.ts#planeTimeOfImpact`, the `gap <= CAPSULE_CAST_EPS` branch) -- so it means the
  // RAISED, ADVANCED capsule is already in contact at that height, i.e. rise+advance has put it
  // somewhere no sweep ever showed to be free. And because the reported normal is oriented toward
  // the capsule it points UP, sailing through the `GROUND_COS` test above as a perfect floor.
  //
  // Committing then hands the body `over` itself: `climb` comes out equal to the full `rise`, which
  // clears the `net-zero` bar below, and the mover teleports the capsule `rise` yards up INTO the
  // collider. THIS IS THE COLLISION STALL. Measured in the offline world walking into
  // `ELWYNNWOODFENCE01`'s hull: two consecutive frames with `climb = 0.7000000000000028` --
  // bit-for-bit `STEP_UP_HEIGHT`, which forces `downHit.distance === 0` -- lifting the body 1.4 yd
  // and taking its deepest gap against the plank from 0.000 to -0.134. Inside a thin plank both of
  // its opposed faces touch, so every horizontal direction is blocked (measured: 0 of 36 bearings
  // free) and the walk dead-stops for as long as the key is held.
  //
  // THIS GUARD IS OURS AND HAS NO SOURCE. The reference's `step_up`
  // (`samples/benilla/crates/benilla/src/player/mover.rs:602-643`) is structurally identical -- same
  // rise/advance/settle, same `up_t < 1e-3`, same `down.normal1.y < GROUND_COS`, same `dy <= 0.05`
  // -- and has NO zero-distance guard. It does not need one: it runs on Avian's shape cast, which
  // does not report a landing this way. **The reference's step-up assumes a shape cast cannot return
  // a zero-distance landing; ours can, deliberately, so that a body resting on the floor is still
  // detected.** That seam is the defect, not a drift in the port.
  //
  // The cost of the guard is that a step EXACTLY `STEP_UP_HEIGHT` tall, whose settle legitimately
  // lands at distance zero, now slides instead of climbing. That is the conservative failure, it is
  // bounded by a ceiling that is OURS and TUNABLE rather than a game value (`constants.ts`), and
  // sliding along a 0.7 yd step is a great deal better than being deposited inside a fence.
  if (downHit.distance <= 0) {
    return miss('no-descent');
  }

  const landed = over.clone().addScaledVector(_down, downHit.distance);
  const climb = landed.z - center.z;

  // Commit only a landing that actually gained a floor. A net-zero maneuver -- grazing a face,
  // pushing a too-tall wall, the tree pinch's gap grass -- belongs to the plain slide: its
  // deflection is what "sliding along the fence" IS, and committing here would dead-stop it.
  if (climb <= 0.05) {
    return miss('net-zero');
  }

  return { landed, verdict: 'commit', climb, rise, detail };
}
