import * as THREE from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';

import { CastHit, Triangle } from './types';

/** Convergence tolerance for the advance loop (yards). */
export const CAPSULE_CAST_EPS = 1e-4;

/**
 * How far off a face the verification pass still counts as a contact.
 *
 * The plane solution is exact; this only absorbs the float error of re-evaluating the distance at
 * the solved time, plus the sliver at a shared edge where neither adjacent face contains the
 * contact point cleanly.
 */
const CONTACT_TOLERANCE = 1e-3;

// `closestPointToSegment` lives on three-mesh-bvh's ExtendedTriangle, not core THREE.Triangle.
const _tri = new ExtendedTriangle();
const _line = new THREE.Line3();
const _closestOnTri = new THREE.Vector3();
const _closestOnSeg = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _toTri = new THREE.Vector3();

/**
 * Distance from the capsule's AXIS SEGMENT to a triangle, minus the radius: the signed gap between
 * the capsule SURFACE and the face. Negative while they overlap.
 *
 * `base` is the capsule centre; the axis runs +/- `halfSegment` along Z from it.
 */
export function closestDistanceCapsuleTriangle(
  base: THREE.Vector3,
  halfSegment: number,
  radius: number,
  triangle: Triangle,
  separationOut?: THREE.Vector3,
): number {
  _line.start.set(base.x, base.y, base.z - halfSegment);
  _line.end.set(base.x, base.y, base.z + halfSegment);

  _tri.a.copy(triangle.a);
  _tri.b.copy(triangle.b);
  _tri.c.copy(triangle.c);
  _tri.needsUpdate = true;

  const distance = _tri.closestPointToSegment(_line, _closestOnTri, _closestOnSeg);

  if (separationOut) {
    // Points from the face toward the capsule. Which SIDE we are on, derived from geometry rather
    // than from winding -- collision faces must block from both sides, and WoW's do not guarantee
    // a consistent outward normal.
    separationOut.subVectors(_closestOnSeg, _closestOnTri);
  }

  return distance - radius;
}

/** Scratch for the depenetration pass. */
const _separation = new THREE.Vector3();
const _push = new THREE.Vector3();

/**
 * PUSH A CAPSULE OUT OF WHAT IT IS INSIDE. Returns a corrected centre, or null when it is already free.
 *
 * **The owner asked for this and the trace agrees with him.** `moveTrace` on the abbey stairs showed
 * four slide iterations, every one `travelled: 0`, blocked at distance 0 by faces whose normal is
 * `(~0, ~0, -1)` -- DOWNWARD-facing, i.e. the underside of a tread. A capsule in contact with the
 * underside of a step is INSIDE the step, and no amount of sweeping gets it out: a sweep answers
 * "what would I hit going that way", and every way is already blocked. "Я просто провалился под
 * ступеньку... нужно выталкивания сделать" is exactly right.
 *
 * DEEPEST FIRST, iterated. Pushing out of one face can push into another (a stair is a wedge of
 * them), so this resolves the worst overlap, re-measures, and repeats. Taking them in arbitrary order
 * lets two faces fight and the position oscillate; taking the deepest converges, because each pass
 * strictly reduces the maximum penetration.
 *
 * THE DIRECTION COMES FROM GEOMETRY, not from the face normal, and that is the same rule the sweep
 * follows: `closestDistanceCapsuleTriangle`'s separation vector points from the face toward the
 * capsule axis, so it is correct whichever side the body ended up on. A WMO face carries no reliable
 * outward normal, so using `triangle.normal` here would push some bodies deeper.
 *
 * `skin` is added to the push so the body ends a hair OUTSIDE rather than exactly on the surface --
 * resting at a zero gap is what the sweep reports as a contact, which is the state this exists to
 * leave.
 *
 * Returns null when nothing overlaps, so the caller pays one distance evaluation per candidate and no
 * allocation in the ordinary case.
 */
export function depenetrateCapsule(
  center: THREE.Vector3,
  radius: number,
  halfSegment: number,
  triangles: Triangle[],
  skin = 0,
  maxPasses = 4,
  /**
   * **WHAT the body is inside, filled in from the FIRST pass -- the deepest overlap, which is the
   * one worth naming.**
   *
   * The scan already picks that triangle out and then discards everything about it but a direction.
   * Yet "which subsystem put a face here" is the question left after four rounds: the sweep gathered
   * this triangle, measured it, and did not treat it as an obstacle, while this scan calls it a
   * 0.165 yd overlap. One of them is wrong about the same triangle, and its SOURCE says which file
   * to open -- terrain, a named WMO group, or a doodad hull.
   */
  infoOut?: { source: object | null; normalZ: number; gap: number },
  /**
   * **THE DEADBAND: an overlap shallower than this is RESTING, not stuck.**
   *
   * A body on a slope lies TANGENT to it. The election snap descends until the sweep reports zero
   * and cannot lift, so the resting clearance it aims for is only ever restored by this push-out --
   * which, asked every frame, then lifts by the skin while the snap puts it straight back. Measured
   * on the abbey stairs, whose collision is a 26-degree RAMP (`normalZ` 0.898, group 5): `fired`
   * 6816 with `freed` **231**. One frame in thirty getting a real positional correction is not a
   * body being rescued, it is two subsystems taking turns -- and the owner sees it as jitter and a
   * LANDING animation replaying on a step.
   *
   * `CAPSULE_CAST_EPS` by default, which preserves every existing caller. The mover passes its skin,
   * so a genuine 0.17 yd sinking still resolves while tangency does not.
   */
  deadband = CAPSULE_CAST_EPS,
): THREE.Vector3 | null {
  if (triangles.length === 0) {
    return null;
  }
  const at = center.clone();
  let moved = false;

  for (let pass = 0; pass < maxPasses; ++pass) {
    let worstGap = 0;
    let worstTriangle: Triangle | null = null;

    for (let i = 0; i < triangles.length; ++i) {
      const gap = closestDistanceCapsuleTriangle(at, halfSegment, radius, triangles[i]);
      if (gap < worstGap) {
        worstGap = gap;
        worstTriangle = triangles[i];
      }
    }

    // The FIRST pass owns the report: it holds the deepest overlap, before any push has changed it.
    if (infoOut && pass === 0) {
      infoOut.source = worstTriangle === null ? null : worstTriangle.source;
      infoOut.normalZ = worstTriangle === null ? 0 : worstTriangle.normal.z;
      infoOut.gap = worstGap;
    }
    if (worstTriangle === null || worstGap >= -deadband) {
      break;
    }

    // Re-measured for the separation vector: the loop above discards it to keep the scan cheap.
    closestDistanceCapsuleTriangle(at, halfSegment, radius, worstTriangle, _separation);
    const length = _separation.length();
    if (length < 1e-9) {
      // The axis passes exactly through the face and there is no direction to push along. Refusing
      // is right: an invented direction here is as likely to push deeper as out.
      break;
    }
    _push.copy(_separation).divideScalar(length).multiplyScalar(-worstGap + skin);
    at.add(_push);
    moved = true;
  }

  return moved ? at : null;
}

/**
 * Time of impact of the swept capsule against ONE triangle's plane, or null.
 *
 * Exact, closed form, no iteration: the capsule's support along the face normal is
 * `radius + halfSegment * |n.z|`, so the gap along the normal shrinks linearly with travel and the
 * contact time is a single division. This is the semantics the reference gets from its physics
 * engine's shape cast -- an exact time of impact per collider, minimum taken over the set.
 *
 * The plane solution is then VERIFIED against the real capsule-triangle distance, because a plane
 * is infinite and a triangle is not: a sweep can reach the plane well outside the face. One
 * distance evaluation settles it, and neighbouring faces of a closed mesh cover the edges.
 */
function planeTimeOfImpact(
  from: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  radius: number,
  halfSegment: number,
  triangle: Triangle,
): { t: number; side: number } | null {
  const n = triangle.normal;

  // How far the capsule reaches along the face normal: the radius, plus the axis projected onto it.
  const support = radius + halfSegment * Math.abs(n.z);

  _toTri.subVectors(from, triangle.a);
  const centreDistance = _toTri.dot(n);
  const side = centreDistance >= 0 ? 1 : -1;
  const gap = side * centreDistance - support;

  // Closing speed along the normal, from whichever side we are on.
  const closing = -side * dir.dot(n);

  if (gap <= CAPSULE_CAST_EPS) {
    // Already touching or overlapping. A contact only counts if we are still driving into the face;
    // otherwise a body resting on the floor could never cast away from it.
    return closing > 1e-9 ? { t: 0, side } : null;
  }

  if (closing <= 1e-9) {
    return null; // parallel, or receding -- can never be reached
  }

  const t = gap / closing;

  return t <= maxDist ? { t, side } : null;
}

/**
 * Sweep a vertical capsule from `from` along unit `dir` for at most `maxDist`, returning the first
 * contact. The one world primitive the whole movement and camera stack is built on.
 *
 * **Exact time of impact, minimum over the set** -- the semantics the reference gets from its
 * physics engine's `cast_move`. Each face contributes a closed-form contact time; the nearest wins.
 * There is no iteration and therefore no iteration ceiling.
 *
 * That ceiling is what the earlier conservative-advancement version died on. It advanced by the
 * smallest free gap, so a single grazing face -- of which a WMO interior offers hundreds -- throttled
 * every step down to the convergence epsilon, the step budget ran out, and the sweep reported NO
 * HIT. Measured in a real building: 776 walk faces and 1446 camera faces within six yards. The
 * camera flew through walls and the body could not climb a stair, both from the same cause.
 *
 * **Side comes from geometry, not winding.** Collision faces must block from both sides and WoW's
 * carry no reliable outward normal, so the contact normal is oriented by which side of the plane the
 * capsule is on, and the reported normal always opposes the approach.
 *
 * `skin` is subtracted from the reported distance so the caller stops that far off the surface; the
 * result is clamped at 0. Returns null when nothing is reached within `maxDist`.
 *
 * `minNormalZ` restricts the minimum to faces whose CONTACT normal points up at least that much,
 * i.e. it answers "where is the floor" instead of "what is nearest". Defaulting to `-Infinity`
 * leaves every existing caller exactly as it was. It exists because "nearest" is the wrong question
 * for the grounded test: a face already touching the capsule reports `distance: 0` whenever the
 * probe is driving into it (the `gap <= CAPSULE_CAST_EPS` branch above), and for a DOWNWARD probe
 * that is every face with `n.z > 0` -- including a near-vertical wall the capsule's flank is
 * brushing. Such a face wins the minimum at zero distance and hides the floor under the feet.
 */
export function castCapsuleAgainstTriangles(
  from: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  radius: number,
  halfSegment: number,
  triangles: Triangle[],
  skin = 0,
  minNormalZ = -Infinity,
): CastHit | null {
  if (triangles.length === 0 || maxDist <= 0) {
    return null;
  }

  let bestT = Infinity;
  let best: Triangle | null = null;
  let bestSide = 1;

  for (let i = 0, len = triangles.length; i < len; ++i) {
    const triangle = triangles[i];

    const solution = planeTimeOfImpact(from, dir, maxDist, radius, halfSegment, triangle);
    if (solution === null || solution.t >= bestT) {
      continue;
    }

    // `minNormalZ` turns "what do I hit first" into "what is the first thing I hit OF THIS KIND",
    // and the only caller that wants it is the mover asking WHERE THE FLOOR IS. It is applied to
    // the CONTACT normal -- the one this function is about to report, oriented by `side` -- not to
    // the triangle's stored normal, which carries no reliable outward direction (see the header).
    if (minNormalZ > -Infinity) {
      const contactNormalZ = solution.side > 0 ? triangle.normal.z : -triangle.normal.z;
      if (contactNormalZ < minNormalZ) {
        continue;
      }
    }

    // The plane is infinite; the face is not. Confirm the capsule actually meets THIS triangle at
    // that time rather than its plane somewhere off the edge.
    _probe.copy(dir).multiplyScalar(solution.t).add(from);
    const gap = closestDistanceCapsuleTriangle(_probe, halfSegment, radius, triangle);
    if (gap > CONTACT_TOLERANCE) {
      continue;
    }

    bestT = solution.t;
    best = triangle;
    bestSide = solution.side;
  }

  if (best === null) {
    return null;
  }

  return {
    distance: Math.max(0, bestT - skin),
    normal: bestSide > 0 ? best.normal.clone() : best.normal.clone().negate(),
    source: best.source,
  };
}
