import * as THREE from 'three';

import { GRAVITY } from './constants';
import { PlayerMoveState } from './player-state';

/** Swim travel speed (yd/s) -- vanilla's default MOVE_SWIM (0.66x run). */
export const SWIM_SPEED = 4.722222;

/**
 * Backward swim speed (yd/s) -- vanilla's default MOVE_SWIM_BACK. A net-backward swim takes
 * `min(swimBack, swim)`, VERIFIED (`0x7c4c90`'s swim arm), byte-identical in template to the run
 * arm's `min(runBack, run)`. A strafe-only swim uses the forward speed.
 */
export const SWIM_BACK_SPEED = 2.5;

/**
 * Swim-jump take-off speed (yd/s) -- VERIFIED `0x7c6230`'s swim seed (`0xc1118c48` = -9.096748; the
 * client stores fall velocity down-positive, up for us).
 *
 * A swim jump launches ~14% harder than the land jump's 7.955547 -- enough to breach and hop onto a
 * low bank.
 */
export const SWIM_JUMP_SPEED = 9.096748;

/**
 * The fraction of the unit's collision height the water must cover to start swimming -- VERIFIED
 * 0.75 (`0x8012cc`, the compare at `0x6030c0`). Applied to the feet-referenced depth.
 */
export const SWIM_DEPTH_FRAC = 0.75;

/**
 * The enter/leave hysteresis band (yd) -- VERIFIED 1/36 (`0x7ff9d0`). Enter compares depth against
 * `0.75*h`, leave against `0.75*h - 1/36`, so between them the swim state holds.
 */
export const SWIM_HYSTERESIS = 1 / 36;

/**
 * Submersion depth (yd, water surface above the feet) to START swimming -- `0.75 * h` from the
 * feet, where h is THE UNIT'S OWN collision height. Water covering about three-quarters of its
 * collision box: chest or neck deep. Roughly 1.52 yd for a human male, 0.86 for a gnome female,
 * 1.83 for a night elf male.
 *
 * The FRACTION was always right; the height it multiplies is what matters. With one human-sized
 * constant, a gnome's rest line sits above her own head and she can never surface.
 *
 * This is also the WADE CEILING: wading is the implicit in-liquid-but-not-swimming state -- there
 * is no wade movement flag -- so "deepest water you can still wade" and "shallowest water you swim
 * in" are necessarily one number.
 */
export function swimEnterDepth(h: number): number {
  return SWIM_DEPTH_FRAC * h;
}

/**
 * Submersion depth (yd) below which swimming STOPS -- `0.75*h - 1/36`, the lower edge of the
 * hysteresis band. The band is an absolute 1/36 yd independent of h, so it is SUBTRACTED, never
 * scaled.
 */
export function swimExitDepth(h: number): number {
  return swimEnterDepth(h) - SWIM_HYSTERESIS;
}

/**
 * The hard TOP-CAP line (yd below the surface) a rising swimmer stops at -- feet at
 * `surface - 0.75*h`, about three-quarters submerged, head out. VERIFIED: the floating resolver's
 * collision top-cap plane (`0x632ba0` x0.75).
 *
 * The same `0.75*h` as the enter threshold, so a capped swimmer sits above the leave threshold and
 * cannot flicker out of the mode.
 */
export function restCap(h: number): number {
  return swimEnterDepth(h);
}

/**
 * How far the feet must sink to satisfy the rest-line constraint -- the excess above
 * `surface - 0.75*h`, or zero when already at or under it.
 *
 * The rest line is a CONSTRAINT, not a one-way cap. The common way a swimmer ends up above it is
 * the surface coming down to meet them on a river; with the vertical frozen, a stroke down a
 * surface that falls ~10% loses depth fast enough to cross the whole 1/36 yd hysteresis band every
 * few frames, which flaps the latch about ten times a second and spends half the swim inside the
 * fall mover.
 *
 * A swimmer BELOW the line is never pulled up: the verified floating resolver has no upward force
 * but your own stroke, and no downward one at all.
 */
export function settleToRest(feetZ: number, surfaceZ: number, h: number): number {
  return Math.max(0, feetZ - (surfaceZ - restCap(h)));
}

/**
 * Cap a rising stroke at the rest line -- and REDIRECT the capped speed level rather than bleed it
 * off. Reaching the surface flips a pitched-up swim into full-speed SURFACE SWIMMING.
 *
 * A plain slide against the top-cap plane leaves only `cos(pitch) * speed` -- about zero at a steep
 * aim -- pinning the swimmer under the waterline behind an invisible wall. The stroke's SPEED is
 * preserved instead: the upward component is clamped to `cap` (how much rise reaches the rest line
 * this frame) and the remainder rotates into the level travel direction.
 *
 * NAMED DIVERGENCE: the reference records that the exe's own-input resolver actually GRINDS a steep
 * aim at the cap, which contradicts the confirmed reference-client behaviour. This redirect is the
 * reference's own construction reproducing the validated feel, and it is carried across
 * deliberately rather than by oversight.
 *
 * Returns the velocity, and the effective travel pitch when the cap bit (null when it did not).
 */
export function capRedirect(
  inputVel: THREE.Vector3, cap: number,
): { velocity: THREE.Vector3; surfacePitch: number | null } {
  if (inputVel.z <= 0 || inputVel.z <= cap) {
    return { velocity: inputVel.clone(), surfacePitch: null };
  }

  const speed = inputVel.length();
  const levelDir = new THREE.Vector3(inputVel.x, inputVel.y, 0);
  if (levelDir.lengthSq() > 0) {
    levelDir.normalize();
  }
  const levelSpeed = Math.sqrt(Math.max(0, speed * speed - cap * cap));

  return {
    velocity: levelDir.multiplyScalar(levelSpeed).setZ(cap),
    surfacePitch: Math.atan2(cap, levelSpeed),
  };
}

/**
 * Update `state.swimming` from the water surface over the feet, with the verified enter/leave
 * hysteresis. Returns the new state. A null surface means not in liquid, which stops swimming.
 *
 * LEVITATING bails the whole decision -- the reference's very first instruction here
 * (`0x6030d2 test ah,4`). Neither the enter arm nor the stop arm runs, so the latch is left exactly
 * as it stands. This is not an optimisation, it IS the mechanism of GM flight: the server sets
 * SWIMMING and LEVITATING in one packet, and the second is what stops the dry ground under us
 * clearing the first on the very next frame.
 *
 * The enter arm carries the FALL RE-ENTRY GATE (VERIFIED `0x7c5de0`): a fresh launch is not
 * re-latched into swim until its upward velocity has decayed to HALF the launch value. Note the
 * release happens while STILL RISING -- the dolphin hop tops out around 1.6 yd, then swim re-latches
 * and the floating resolver freezes the depth, discarding the residual velocity.
 *
 * The latch deliberately does NOT touch `state.settling`: that release belongs to world residency,
 * in every mover mode alike, and clearing it here would race that judgement.
 */
export function updateSwimming(
  state: PlayerMoveState, surfaceZ: number | null, now: number,
): boolean {
  if (state.levitating) {
    return state.swimming;
  }

  if (surfaceZ === null) {
    state.swimming = false;
    return false;
  }

  const depth = surfaceZ - state.pos.z;
  const h = state.collisionHeight;

  if (state.swimming) {
    state.swimming = depth >= swimExitDepth(h);
  } else {
    const hopBlocked = state.velZ > 0
      && state.airborneSince !== null
      && now - state.airborneSince < state.jumpZSpeed / (2 * GRAVITY);
    state.swimming = depth > swimEnterDepth(h) && !hopBlocked;
  }

  return state.swimming;
}
