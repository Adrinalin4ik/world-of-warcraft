import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
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
  | 'net-zero';

export interface StepUpResult {
  /** The resolved capsule centre, non-null only on `'commit'`. */
  landed: THREE.Vector3 | null;
  verdict: StepUpVerdict;
  /** Height gained (yd), 0 unless committed. */
  climb: number;
}

const _up = new THREE.Vector3(0, 0, 1);
const _down = new THREE.Vector3(0, 0, -1);

/**
 * The atomic step-up -- the standard kinematic-controller maneuver: a steep opposing face within
 * this frame's travel triggers RISE, ADVANCE, SETTLE, committed whole inside one frame, or nothing
 * happens and the plain slide runs.
 *
 * - RISE by the free headroom, at most STEP_UP_HEIGHT -- the deliberately low ceiling that scopes
 *   this to stairs, doorsteps and low rocks, and keeps fences and walls slide-only.
 * - ADVANCE this frame's own travel along the INPUT direction at the raised height. Never a
 *   probe-length lunge.
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
  travel: number,
): StepUpResult {
  const miss = (verdict: StepUpVerdict): StepUpResult => ({ landed: null, verdict, climb: 0 });

  // A steep, non-overhanging face opposing the motion, within this frame's travel. No incidence
  // gate -- the verified reference has none, and a grazing contact nets zero through the settle
  // instead, which is what makes it read as sliding along rather than dead-stopping.
  const ahead = cast(center, dirH, travel);
  if (!ahead) {
    return miss('no-obstacle');
  }

  const n = ahead.normal;
  if (n.z >= GROUND_COS || n.z < 0 || n.dot(dirH) >= 0) {
    return miss('no-obstacle');
  }

  // RISE: the free headroom, at most STEP_UP_HEIGHT.
  const upHit = cast(center, _up, STEP_UP_HEIGHT);
  const rise = upHit ? upHit.distance : STEP_UP_HEIGHT;
  if (rise < 1e-3) {
    return miss('no-headroom');
  }

  // ADVANCE: this frame's travel along the input direction, swept at the raised height.
  const raised = center.clone().addScaledVector(_up, rise);
  const forwardHit = cast(raised, dirH, travel);
  const forward = forwardHit ? forwardHit.distance : travel;
  const over = raised.clone().addScaledVector(dirH, forward);

  // SETTLE: the walk election's reach below the advanced point -- the rise undone, plus the
  // travel-scaled step-down allowance -- onto a WALKABLE floor only.
  const reach = rise + travel * STEP_SLOPE_RATIO + STEP_SNAP_SLACK;
  // Same skin as the election snap: a committed step must not land flush against its floor.
  const downHit = cast(over, _down, reach, SKIN_WIDTH);
  if (!downHit) {
    return miss('no-floor');
  }
  if (downHit.normal.z < GROUND_COS) {
    return miss('steep-floor');
  }

  const landed = over.clone().addScaledVector(_down, downHit.distance);
  const climb = landed.z - center.z;

  // Commit only a landing that actually gained a floor. A net-zero maneuver -- grazing a face,
  // pushing a too-tall wall, the tree pinch's gap grass -- belongs to the plain slide: its
  // deflection is what "sliding along the fence" IS, and committing here would dead-stop it.
  if (climb <= 0.05) {
    return miss('net-zero');
  }

  return { landed, verdict: 'commit', climb };
}
