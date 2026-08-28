import * as THREE from 'three';

import { DEFAULT_COLLISION_HEIGHT } from './constants';

/**
 * The avatar's mutable movement state -- the reference's `Player` resource, minus the parts that
 * belong to systems this client does not have yet.
 *
 * Several fields are maintained but not yet read. They are the wire's entire integration surface,
 * and each is written by a behaviour being ported anyway, so leaving them out would mean deleting
 * working logic and putting it back when networking lands.
 */
export interface PlayerMoveState {
  /** Feet position (world, Z-up). The capsule centre is this plus CAPSULE_HEIGHT/2 on Z. */
  pos: THREE.Vector3;

  /** Vertical velocity (yd/s, +Z up) for gravity, jump and fall. Zeroed while grounded. */
  velZ: number;

  /**
   * Horizontal velocity (yd/s). Live from input while grounded; while airborne it is the take-off
   * momentum, so a moving jump keeps its trajectory -- the WoW feel. Zero when standing still.
   */
  horizVel: THREE.Vector3;

  /**
   * The character's FACING (yaw about Z, radians) -- the aim, kept in sync with the camera by
   * right-drag and by movement. This is the orientation the server would be told, and the basis
   * movement input is expressed in.
   */
  faceYaw: number;

  /**
   * The rendered BODY heading (yaw about Z, radians). While strafing it eases off `faceYaw`; moving
   * without a strafe it snaps to it; standing it chases at STATIONARY_CHASE_RATE.
   *
   * Deliberately a separate field from `faceYaw`: they diverge while strafing, and `faceYaw` is
   * what the wire carries. Collapsing them is the change that would have to be undone later.
   */
  modelYaw: number;

  /** Elapsed seconds when the current airborne phase began, else null on the ground. */
  airborneSince: number | null;

  /**
   * The take-off vertical speed snapshotted when the airborne phase began: JUMP_SPEED for a jump,
   * EXACTLY 0 for a step-off (the walk election's `StartFalling(0)`). The FALLINGFAR latch splits
   * its distance and timer legs on this value, so the zero is load-bearing.
   */
  jumpZSpeed: number;

  /** Launch height (world Z) snapshotted when the airborne arc began. */
  fallStartZ: number;

  /** MOVEFLAG_FALLINGFAR latched for this arc. Latched once; only landing clears it. */
  fallFar: boolean;

  /**
   * At rest wedged between steep faces: treated as standing, with walking control live, while a
   * close down-probe still finds support. Cleared by real ground, by jumping, or by walking off the
   * support into open air.
   */
  wedged: boolean;

  /**
   * **A STEP-DOWN STILL IN PROGRESS: the floor is in SIGHT but further than one frame may
   * descend.** Treated as standing -- gravity off, walking control live -- exactly as `wedged`
   * above is, and self-clearing the same way: it is re-decided from the snap every frame, so
   * walking off into open air drops it and a normal fall elects.
   *
   * It exists because the descent is now capped (see the snap in `mover.ts`) and the ordinary
   * ground probe is only 0.2 yd. Without this flag a capped descent would leave the body above the
   * probe's reach, be classified airborne, and fall -- which is the dive the cap was added to
   * prevent, arriving by the other route.
   */
  stepDown: boolean;

  /** Consecutive stalled airborne frames (see WEDGE_STALL_RATIO). */
  wedgeStill: number;

  /**
   * Settling after a teleport or login: the streamed world arrives over several frames, so the
   * collision under the destination is not there the instant we snap to it. While settling, gravity
   * is OFF and the body is frozen, so we do not fall through the not-yet-loaded floor.
   */
  settling: boolean;

  /** Elapsed-seconds deadline to give up settling and release. */
  settleDeadline: number;

  /** In swim mode: the avatar floats and swims in 3D instead of walking. */
  swimming: boolean;

  /**
   * The swim pitch (radians, +up). HELD when unsteered -- an idle floater keeps its pitch and is
   * never auto-levelled. Steered by mouselook as a DIRECT set of the camera aim pitch, with no
   * integrator and no rate limit, which is what makes aiming up and swimming forward feel immediate.
   */
  swimPitch: number;

  /** This frame's flag-scalar swim travel speed (yd/s) -- the swim stroke's playback-rate numerator. */
  swimStrokeSpeed: number;

  /**
   * The unit's OWN collision height (yd) -- `CreatureModelData.collisionHeight x displayScale`.
   *
   * Every swim depth line is a fraction of it, which is why a gnome floats with her head out and a
   * night elf sits deeper. NOT the movement capsule height, which is a constant feel knob.
   *
   * Defaults to DEFAULT_COLLISION_HEIGHT rather than 0 precisely because at zero every depth line
   * collapses to 0 and the avatar swims on dry land.
   */
  collisionHeight: number;

  /**
   * The server put us in free flight (MOVEFLAG_LEVITATING, GM `.cheat fly`). Always false until the
   * wire lands.
   *
   * It does exactly one thing, and it does it by SUPPRESSION: while set, the water/depth decision
   * does not run at all -- neither arm. So a server-granted swim stays on with no water under it,
   * which IS GM flight, and symmetrically real water can no longer grant one. Not an optimisation:
   * it is the mechanism.
   */
  levitating: boolean;

  /** The CMovement moveFlags last streamed. Maintained for the wire; nothing reads it yet. */
  moveFlags: number;

  /** The facing as of last frame -- the reference's facing-change detector. */
  lastFacing: number;
}

export function createPlayerMoveState(): PlayerMoveState {
  return {
    pos: new THREE.Vector3(),
    velZ: 0,
    horizVel: new THREE.Vector3(),
    faceYaw: 0,
    modelYaw: 0,
    airborneSince: null,
    jumpZSpeed: 0,
    fallStartZ: 0,
    fallFar: false,
    wedged: false,
    stepDown: false,
    wedgeStill: 0,
    settling: false,
    settleDeadline: 0,
    swimming: false,
    swimPitch: 0,
    swimStrokeSpeed: 0,
    collisionHeight: DEFAULT_COLLISION_HEIGHT,
    levitating: false,
    moveFlags: 0,
    lastFacing: 0,
  };
}
