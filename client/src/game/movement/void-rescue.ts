import { PlayerMoveState } from './player-state';

/**
 * How far under the terrain surface counts as "through the world" rather than "falling down a
 * canyon" (yd).
 *
 * The trigger is not the distance alone -- it is being below the TERRAIN SURFACE AT OUR OWN XY, which
 * a body in a canyon never is. The margin only keeps the check off a body that is a hair under the
 * heightmap because a WMO floor or a bridge legitimately sits below it, or because the interpolated
 * height and the collision triangle disagree by a skin width.
 */
export const VOID_DEPTH = 30;

/** Where the rescued body is placed relative to the surface (yd), so the mover's snap has something to close. */
export const VOID_CLEARANCE = 0.5;

/**
 * The rescue: put a body that has fallen out of the world back on the ground.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE SETTLE HOLD. The hold (see `SETTLE_STREAM_TIMEOUT`) stops the
 * fall from STARTING before there is ground. This is the other half of the brief's requirement -- the
 * body must also RECOVER if it falls anyway, and it can still do so: the hold's absolute cap can
 * expire on a world that never finishes loading, a zone change can move the ground out from under a
 * body that is already airborne, and a future server-driven teleport arrives with no hold at all.
 *
 * Without recovery the failure is permanent, not transient, and that is the whole severity of the bug
 * this fixes: streaming keys off the player's XY and keeps working perfectly (measured: 441 chunks,
 * 1289 doodads, all loaded while the body was 4400 yd below them), but nothing re-grounds a body that
 * the terrain is above. The fall never ends.
 *
 * `heightAt` is the terrain heightmap, NOT a cast, and that is the mechanism rather than an
 * optimisation: a cast sweeps from the body, and a body far below the world has no reach that finds
 * anything, so the very state we need to detect is the one a cast cannot see. `null` -- no registered
 * chunk over our XY -- means streaming has not reached here, so there is nothing to rescue onto yet
 * and the answer is "wait", not "teleport".
 *
 * Returns true when it moved the body, so the caller can re-arm the settle hold: the surface we just
 * placed onto is the interpolated heightmap, and letting the mover's own election snap close the last
 * fraction of a yard is what keeps this from becoming a second source of truth for ground height.
 */
export function rescueFromVoid(
  state: PlayerMoveState,
  heightAt: (x: number, y: number) => number | null,
): boolean {
  // Airborne only. A grounded body is on something by definition, and a swimmer's Z is its depth.
  if (state.airborneSince === null || state.swimming) {
    return false;
  }

  const surface = heightAt(state.pos.x, state.pos.y);
  if (surface === null || state.pos.z > surface - VOID_DEPTH) {
    return false;
  }

  state.pos.z = surface + VOID_CLEARANCE;
  state.velZ = 0;
  state.horizVel.set(0, 0, 0);
  state.airborneSince = null;
  state.fallFar = false;
  state.wedged = false;
  state.wedgeStill = 0;

  return true;
}
