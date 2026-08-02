import * as THREE from 'three';

import { GROUND_COS } from './constants';

/**
 * The even-speed ramp ride: a walkable slope never slows or deflects the grounded walk.
 *
 * The real client's walk step is TWO-DIMENSIONAL -- the resolver takes speed*dt as a HORIZONTAL
 * distance and a normalized 2D direction, and Z follows purely through the snap/step machinery
 * (`0x6367b0`'s own signature) -- so on every walkable (< 50 degree) surface the horizontal speed is
 * exactly the run speed.
 *
 * Collide-and-slide's true-plane clip breaks that invariant: `v' = v - (v.n)n` shortens the
 * horizontal part to `h * cos^2(theta)` -- half speed at 45 degrees -- and bends a diagonal
 * approach off the input line.
 *
 * So when the grounded slide meets an opposing WALKABLE plane, replace the clip with the
 * vertical-lift projection: keep the horizontal velocity exactly, and set the vertical so the
 * motion rides along the plane (`v'.n = 0`, which means the plane's own clip then passes it
 * untouched). Unreal's `bMaintainHorizontalGroundVelocity` is the same standard treatment.
 *
 * Returns null when the rule does not apply: steep faces are `steepWallPlane`'s, airborne contacts
 * keep the true clip so a landing still slides naturally, and a receding plane opposes nothing. Any
 * height the ride manufactures is bounded by the end-of-frame snap, which only ever settles onto a
 * walkable floor.
 */
export function walkableRideVelocity(
  n: THREE.Vector3, v: THREE.Vector3,
): THREE.Vector3 | null {
  if (n.z < GROUND_COS || v.dot(n) >= 0) {
    return null;
  }

  // Walkability bounds n.z >= cos50 > 0, so an opposing contact makes the recomputed vertical
  // strictly positive and at most h * tan50. A prior facet's ride vertical is DISCARDED rather than
  // stacked: the grounded mover owns no vertical of its own.
  return new THREE.Vector3(v.x, v.y, -(v.x * n.x + v.y * n.y) / n.z);
}

/**
 * The steep-face wall rule: a steep (non-walkable, non-overhanging) face must never LIFT the mover.
 *
 * Collide-and-slide clips velocity onto each contact plane, and on a tilted plane that clip
 * manufactures upward motion out of a horizontal push (`v'.z - v.z = -(v.n) * n.z`, positive for
 * every opposing contact). That walks a capsule straight up 50-80 degree trunks and hillsides, and,
 * while falling with locked forward momentum, cancels enough of the descent to trip the wedge rest
 * into landing mid-face. Together: a climbing ratchet.
 *
 * When the true-plane clip would leave the mover moving UPWARD, return the face's vertical-wall
 * flatten to clip against instead -- the push slides along the wall line and only the mover's own
 * vertical motion survives. A DESCENDING clip keeps the true plane: that is the natural slide down
 * a steep surface, and flattening those stalls real falls against the face. Walkable floors and
 * overhangs (`n.z < 0`) always keep their plane.
 *
 * This is the standard controller treatment (Unreal `HandleSlopeBoosting`, Godot
 * `floor_block_on_wall`). Penetration safety is untouched: the slide's sweeps still stop at the
 * real surface, and the plane only shapes the deflection.
 */
export function steepWallPlane(n: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 | null {
  if (!(n.z >= 0 && n.z < GROUND_COS)) {
    return null;
  }

  const vn = v.dot(n);
  if (vn >= 0 || v.z - vn * n.z <= 0) {
    return null;
  }

  // Steepness bounds the horizontal part below by sin 50, so the normalize is safe.
  return new THREE.Vector3(n.x, n.y, 0).normalize();
}
