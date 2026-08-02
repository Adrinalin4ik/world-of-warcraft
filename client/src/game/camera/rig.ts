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

const _up = new THREE.Vector3(0, 0, 1);

/**
 * Orient the camera and orbit it behind the avatar, with world collision.
 *
 * The framing PIVOT is `feet + pivotHeight` (model-derived, about neck height). The camera looks at
 * it and, at zoom 0, sits ON it -- the first-person eye inside the head.
 *
 * Camera collision is a single sweep of the probe sphere from the player's HEAD, not the pivot, out
 * to the ideal seat. Rooting the arm at the head is what makes it robust: body collision keeps the
 * head inside the room -- even mid-jump it cannot pass the ceiling -- so the swept camera can never
 * end up on the far side of a wall. That is why a jump in a low room does not push it through the
 * roof; the sweep just stops under the ceiling.
 *
 * Pull-in is instant and collision wins outright: there is no minimum-distance floor forcing the
 * camera past a too-close hit. Push-out eases at CAM_RETURN_RATE.
 *
 * `cast` must be the CAMERA audience's cast, not the walking one.
 */
export function seatCamera(
  rig: CameraControl,
  opts: {
    feet: THREE.Vector3;
    head: THREE.Vector3;
    pivotHeight: number;
    cast: CastFn;
    dt: number;
  },
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const {
    feet, head, pivotHeight, cast, dt,
  } = opts;

  // Z-up forward from yaw (about Z) and pitch.
  const cosPitch = Math.cos(rig.pitch);
  const forward = new THREE.Vector3(
    Math.cos(rig.yaw) * cosPitch,
    Math.sin(rig.yaw) * cosPitch,
    Math.sin(rig.pitch),
  );

  const pivot = feet.clone();
  pivot.z += pivotHeight;

  const seat = pivot.clone().addScaledVector(forward, -rig.distance);
  const boom = seat.clone().sub(head);
  const boomLength = Math.max(boom.length(), 1e-3);
  const boomDir = boom.clone().divideScalar(boomLength);

  const hit = cast(head, boomDir, boomLength);
  const open = hit ? hit.distance : boomLength;

  if (open < rig.collisionDistance) {
    // Instant: a wall must never sit between the camera and the character.
    rig.collisionDistance = open;
  } else {
    const t = 1 - Math.exp(-CAM_RETURN_RATE * dt);
    rig.collisionDistance += (open - rig.collisionDistance) * t;
  }

  const frac = Math.min(1, Math.max(0, rig.collisionDistance / boomLength));
  const position = head.clone().addScaledVector(boom, frac);

  rig.selfFadeAlpha = selfFadeAlpha(position.distanceTo(pivot));

  // In first person -- zoom 0, or the boom pulled all the way in -- the camera sits ON the pivot,
  // and `lookAt` toward a target it is already standing at is degenerate: the view direction
  // collapses and the orientation flips to whatever the up vector leaves. Aim along the look
  // direction instead, which is what the eye should do anyway once it is inside the head.
  const target = position.distanceToSquared(pivot) > 1e-4
    ? pivot
    : position.clone().add(forward);

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(position, target, _up),
  );

  return { position, quaternion };
}

export interface LookButtons {
  left: boolean;
  right: boolean;
}

export interface LookSessionResult {
  /** Yaw rotation applied this frame (radians). A right-drag also feeds this to the facing. */
  yawDelta: number;
  /** This frame's look turns the CHARACTER (right-drag or both-button run), not just the camera. */
  turnsCharacter: boolean;
  /** Both buttons are held: vanilla's both-button forward run. */
  bothButtonsRun: boolean;
  /** A left press and release that never dragged -- a target select. */
  leftClick: boolean;
  /** A right press and release that never turned -- the context action. */
  rightClick: boolean;
}

/** Accumulated drag distance per button while a press is being classified. */
interface PendingClicks {
  left: number | null;
  right: number | null;
}

export function createPendingClicks(): PendingClicks {
  return { left: null, right: null };
}

/**
 * The mouse-look session state machine: start, stop and hand-off between the two look modes, plus
 * the click-versus-drag tests.
 *
 * Right-drag turns the character and engages INSTANTLY on press -- turning must feel immediate --
 * so its click test just rides the session and the release decides. Left-drag orbits the camera and
 * is DEFERRED: a left click selects a target instead, so the orbit only engages once the cursor
 * drags past CLICK_DRAG_THRESHOLD. Both buttons held is vanilla's forward run, steering like a
 * right-drag, and is never a click.
 *
 * `pending` is caller-owned so two rigs cannot share click state.
 */
export function runLookSession(
  rig: CameraControl,
  buttons: LookButtons,
  motion: { dx: number; dy: number },
  prev: LookButtons,
  pending: PendingClicks,
): LookSessionResult {
  const bothButtonsRun = buttons.left && buttons.right;
  let leftClick = false;
  let rightClick = false;

  // Press edges start a click test.
  if (buttons.right && !prev.right) {
    pending.right = 0;
  }
  if (buttons.left && !prev.left) {
    pending.left = 0;
  }

  // A left+right gesture is a run or a turn, never a target select. Cancel the pending left test
  // the instant the right button joins in, so releasing out of a both-button move fires nothing.
  if (buttons.right) {
    pending.left = null;
  }
  if (buttons.left && buttons.right) {
    pending.right = null;
  }

  const moved = Math.hypot(motion.dx, motion.dy);
  if (pending.right !== null) {
    pending.right += moved;
  }
  if (pending.left !== null) {
    pending.left += moved;
  }

  if (rig.look) {
    const held = rig.look === 'right' ? buttons.right : buttons.left;
    if (!held) {
      if (rig.look === 'right' && pending.right !== null && pending.right < CLICK_DRAG_THRESHOLD) {
        rightClick = true;
      }
      pending[rig.look] = null;

      // Hand off to the other button if it is still held rather than ending the session -- vanilla
      // keeps turning or orbiting seamlessly, cursor staying hidden throughout.
      const other: LookButton = rig.look === 'right' ? 'left' : 'right';
      const otherHeld = other === 'right' ? buttons.right : buttons.left;
      rig.look = otherHeld ? other : null;
    }
  } else if (buttons.right) {
    rig.look = 'right'; // instant on press
  } else if (buttons.left && pending.left !== null && pending.left >= CLICK_DRAG_THRESHOLD) {
    rig.look = 'left'; // deferred past the drag threshold
  }

  // Releases with a pending, never-dragged test are clicks.
  if (!buttons.left && prev.left && pending.left !== null) {
    leftClick = pending.left < CLICK_DRAG_THRESHOLD;
    pending.left = null;
  }
  if (!buttons.right && prev.right) {
    if (pending.right !== null && pending.right < CLICK_DRAG_THRESHOLD) {
      rightClick = true;
    }
    pending.right = null;
  }

  const yawDelta = rig.look ? applyLookDelta(rig, motion.dx, motion.dy) : 0;

  return {
    yawDelta,
    turnsCharacter: rig.look === 'right' || bothButtonsRun,
    bothButtonsRun,
    leftClick,
    rightClick,
  };
}
