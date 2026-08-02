import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import { CAPSULE_HEIGHT, GROUND_COS, STEP_SLOPE_RATIO, STEP_SNAP_SLACK } from './constants';
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
