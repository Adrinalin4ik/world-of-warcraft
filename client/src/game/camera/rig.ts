import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';

/**
 * Third-person orbit-distance limits (yards). VERIFIED from WoW.exe 5875: max orbit is
 * `cameraDistanceMax x cameraDistanceMaxFactor`, hard-capped at 50; the low clamp is 0 --
 * zoom-to-first-person, where the eye sits at the framing pivot inside the head and the avatar
 * fades out.
 *
 * The out-of-box default max is 15; 30 is the "Max Camera Distance" setting fully raised. The
 * starting zoom is 15.
 */
export const CAM_DIST_MIN = 0;
export const CAM_DIST_MAX = 30;
export const CAM_DIST_DEFAULT = 15;

/** Yards the wheel moves the target per notch -- CameraZoomIn/Out's default amount. VERIFIED 1.0. */
export const CAM_ZOOM_STEP = 1.0;

/**
 * Camera zoom speed in YARDS PER SECOND -- `cameraDistanceMoveSpeed`, VERIFIED default 8.33.
 *
 * Vanilla glides the distance toward the wheel target at this CONSTANT velocity (linear,
 * frame-delta-scaled), NOT an exponential ease. The two feel different, and the ease is a common
 * mis-port.
 */
export const CAM_MOVE_SPEED = 8.33;

/** Mouse-look sensitivity: radians of camera rotation per pixel of mouse motion. */
export const LOOK_SENSITIVITY = 0.003;

/**
 * Camera pitch clamp (radians) -- VERIFIED +/-89.00 degrees (`0x8089d8` = 1.5533430576 rad). A
 * single uniform clamp at every zoom level: the reference has NO distinct first-person look-down
 * limit.
 */
export const CAM_PITCH_LIMIT = (89.0 * Math.PI) / 180;

/**
 * Camera-collision probe radius (yd): a small sphere swept from the head toward the desired camera
 * seat each frame. Its radius is the margin kept between the camera and the surface it stops at, so
 * the near plane does not poke through the wall. Smaller than the player capsule -- the camera
 * threads gaps the body cannot.
 */
export const CAM_COLLISION_RADIUS = 0.3;

/**
 * How fast the camera glides back out to the chosen zoom once an obstruction clears (1/s).
 *
 * Pull-IN is instant -- a wall must never sit between the camera and the character -- and only the
 * push-OUT eases. That asymmetry is the vanilla feel of snapping close past an obstacle and easing
 * back.
 */
export const CAM_RETURN_RATE = 6.0;

/**
 * The camera near-plane distance (yd), shared by the projection and the self-avatar fade so the
 * model finishes fading exactly as the near plane would begin to slice it.
 */
export const CAM_NEAR = 1.0;

/** How far in front of the near plane the avatar has fully faded (yd). */
export const SELF_FADE_WINDOW = 1.5;

/**
 * Accumulated cursor motion (logical px) past which a held mouse button becomes a DRAG (camera
 * orbit / character turn) rather than a CLICK (target select). Small: a click has near-zero jitter,
 * and any real drag crosses it in a frame or two.
 */
export const CLICK_DRAG_THRESHOLD = 4.0;

/** The active mouse-look mode. */
export type LookButton = 'right' | 'left';

export interface CameraControl {
  /** Current orbit distance (yd) -- eased toward `targetDistance` so the wheel zoom glides. */
  distance: number;
  /** Where the wheel set the orbit distance; `distance` chases this. */
  targetDistance: number;
  /**
   * Effective arm length after world collision. Pulled in instantly when geometry intrudes, eased
   * back out when it clears.
   *
   * Kept SEPARATE from `distance` so the player's chosen zoom is preserved while obstructed and
   * restored once the view is open again.
   */
  collisionDistance: number;
  /** The button currently held for look, or null. */
  look: LookButton | null;
  /** Camera yaw about Z (radians, world). */
  yaw: number;
  /** Camera pitch (radians, + is looking up). */
  pitch: number;
  /** The self-avatar's render alpha this frame: 1 third-person, ramping to 0 in first person. */
  selfFadeAlpha: number;
}

export function createCameraControl(): CameraControl {
  return {
    distance: CAM_DIST_DEFAULT,
    targetDistance: CAM_DIST_DEFAULT,
    collisionDistance: CAM_DIST_DEFAULT,
    look: null,
    yaw: 0,
    pitch: 0,
    selfFadeAlpha: 1,
  };
}

/** A wheel event: positive `notches` zooms IN. Moves the target; `advanceZoom` glides to it. */
export function applyZoomScroll(rig: CameraControl, notches: number): void {
  const next = rig.targetDistance - notches * CAM_ZOOM_STEP;
  rig.targetDistance = Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, next));
}

/** Advance the zoom glide one frame at the constant vanilla velocity. */
export function advanceZoom(rig: CameraControl, dt: number): void {
  const gap = rig.targetDistance - rig.distance;
  const stride = CAM_MOVE_SPEED * dt;

  rig.distance = Math.abs(gap) <= stride
    ? rig.targetDistance
    : rig.distance + Math.sign(gap) * stride;
}

/**
 * Apply this frame's accumulated mouse motion as look rotation. Returns the yaw delta applied,
 * which a right-drag also feeds into the character facing.
 */
export function applyLookDelta(rig: CameraControl, dxPx: number, dyPx: number): number {
  const yawDelta = -dxPx * LOOK_SENSITIVITY;
  rig.yaw += yawDelta;
  rig.pitch = Math.min(
    CAM_PITCH_LIMIT,
    Math.max(-CAM_PITCH_LIMIT, rig.pitch - dyPx * LOOK_SENSITIVITY),
  );

  return yawDelta;
}

/**
 * The self-avatar's render alpha from the REALIZED camera-to-pivot distance: 1 in third person,
 * ramping to 0 as the camera reaches the head.
 *
 * Keyed off the collision-pulled distance rather than the zoom, so backing into a wall also thins
 * you -- which is the faithful behaviour, not an accident.
 */
export function selfFadeAlpha(cameraToPivot: number): number {
  const t = (cameraToPivot - CAM_NEAR) / SELF_FADE_WINDOW;

  return Math.min(1, Math.max(0, t));
}
