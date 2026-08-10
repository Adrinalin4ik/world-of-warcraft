import * as THREE from 'three';

import { CastFn } from '../collision/collision-world';
import { GROUND_COS, MAX_SLIDE_ITERATIONS, SKIN_WIDTH } from './constants';

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

/**
 * One contact, handed to the slide callback.
 *
 * Both fields are MUTABLE: a callback rewrites `velocity` to change what the remainder of the move
 * does, and `normal` to change which plane the clip happens against. That is the contract the two
 * hit rules above are applied through.
 */
export interface SlideHit {
  normal: THREE.Vector3;
  velocity: THREE.Vector3;
  source: object;
}

export type SlideCallback = (hit: SlideHit) => void;

/**
 * Collide-and-slide a capsule through the world for one frame.
 *
 * The reference delegates this to its physics engine, so this is the one piece of the mover with no
 * line-for-line source. Its required behaviour is fixed instead by the callback contract: at each
 * contact the callback may rewrite the normal and the velocity, then the remaining motion is
 * clipped onto the resulting plane and the sweep continues.
 *
 * Neither input vector is mutated.
 */
export function moveAndSlide(
  cast: CastFn,
  from: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
  onHit: SlideCallback,
): { position: THREE.Vector3; contacts: number } {
  const position = from.clone();
  const vel = velocity.clone();
  const dir = new THREE.Vector3();
  let remainingTime = dt;
  let contacts = 0;

  for (let i = 0; i < MAX_SLIDE_ITERATIONS; ++i) {
    const speed = vel.length();
    if (remainingTime <= 1e-9 || speed < 1e-6) {
      break;
    }

    const distance = speed * remainingTime;
    dir.copy(vel).divideScalar(speed);

    const hit = cast(position, dir, distance, SKIN_WIDTH);
    if (!hit) {
      position.addScaledVector(dir, distance);
      break;
    }

    contacts += 1;
    const travelled = Math.max(0, hit.distance);
    position.addScaledVector(dir, travelled);
    remainingTime -= travelled / speed;

    // Hand the contact to the caller's rule set. It may redirect the velocity outright (the
    // walkable ride) or flatten the plane we are about to clip against (the steep wall).
    const slideHit: SlideHit = { normal: hit.normal.clone(), velocity: vel, source: hit.source };
    onHit(slideHit);

    // Clip whatever velocity survived onto the (possibly rewritten) plane. The walkable ride
    // deliberately returns a velocity already lying IN its plane, so this passes it untouched --
    // which is how the ride keeps full horizontal speed rather than being re-clipped away.
    vel.addScaledVector(slideHit.normal, -vel.dot(slideHit.normal));
  }

  return { position, contacts };
}

/**
 * The GROUNDED contact response: ride an opposing walkable plane at full horizontal speed, else
 * flatten a steep face so it cannot lift us. This is the order the reference applies them in.
 */
export function groundedHitResponse(hit: SlideHit): void {
  const ride = walkableRideVelocity(hit.normal, hit.velocity);
  if (ride) {
    hit.velocity.copy(ride);
    return;
  }

  const wall = steepWallPlane(hit.normal, hit.velocity);
  if (wall) {
    hit.normal.copy(wall);
  }
}

/**
 * The AIRBORNE contact response: steep faces get the same wall treatment as on the ground, but
 * there is no ride. An arc owns its own height, so the only thing the world may do to it is stop
 * it, and a landing should still slide naturally down a walkable plane.
 */
export function airborneHitResponse(hit: SlideHit): void {
  const wall = steepWallPlane(hit.normal, hit.velocity);
  if (wall) {
    hit.normal.copy(wall);
  }
}
