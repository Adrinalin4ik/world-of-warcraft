import * as THREE from 'three';
import { ExtendedTriangle } from 'three-mesh-bvh';

import { CastHit, Triangle } from './types';

/** Convergence tolerance for the advance loop (yards). */
export const CAPSULE_CAST_EPS = 1e-4;

/**
 * Iteration ceiling for conservative advancement. Each step advances by the full free gap, so the
 * loop converges geometrically; 48 is far above what any real candidate set needs and exists only
 * so a degenerate triangle cannot spin the frame.
 */
const MAX_ADVANCE_STEPS = 48;

// `closestPointToSegment` lives on three-mesh-bvh's ExtendedTriangle, not core THREE.Triangle.
const _tri = new ExtendedTriangle();
const _line = new THREE.Line3();
const _closestOnTri = new THREE.Vector3();
const _closestOnSeg = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _sep = new THREE.Vector3();

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

/**
 * Sweep a vertical capsule from `from` along unit `dir` for at most `maxDist`, returning the first
 * contact. This is the one world primitive the whole movement and camera stack is built on.
 *
 * **Conservative advancement.** At each step the smallest gap over the candidate triangles is the
 * furthest the capsule can possibly travel without touching anything: `dir` is unit length, so the
 * gap can shrink at most one yard per yard travelled. Advance by exactly that and repeat. This is
 * exact at convergence and needs no substep tuning, and it is affordable precisely because the
 * candidate list is small -- tens of triangles, gathered from the acceleration structures the WoW
 * files already ship.
 *
 * **Side is taken from geometry, not winding.** Collision faces must block from both sides, and
 * WoW's carry no reliable outward normal, so "am I approaching this face" comes from the separation
 * direction between capsule and triangle. A face the sweep runs parallel to has zero approach rate
 * and cannot be hit -- which is what lets a capsule resting on the floor still walk along it, while
 * a downward probe from that same rest still finds the floor.
 *
 * `skin` is subtracted from the reported distance so the caller stops that far off the surface; the
 * result is clamped at 0. Returns null when nothing is reached within `maxDist`.
 */
export function castCapsuleAgainstTriangles(
  from: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  radius: number,
  halfSegment: number,
  triangles: Triangle[],
  skin = 0,
): CastHit | null {
  if (triangles.length === 0 || maxDist <= 0) {
    return null;
  }

  let travelled = 0;

  for (let step = 0; step < MAX_ADVANCE_STEPS; ++step) {
    _probe.copy(dir).multiplyScalar(travelled).add(from);

    let soonest = Infinity;
    let nearest: Triangle | null = null;

    for (let i = 0, len = triangles.length; i < len; ++i) {
      const triangle = triangles[i];
      const gap = closestDistanceCapsuleTriangle(_probe, halfSegment, radius, triangle, _sep);

      // Are we moving TOWARD this face? Taken from the separation direction, not the triangle's
      // winding: collision geometry has to block from both sides, and WoW's faces carry no reliable
      // outward normal. A face we run parallel to has zero approach rate and cannot be hit -- which
      // is exactly what lets a capsule resting on the floor still walk along it.
      const separation = _sep.lengthSq();
      const approach = separation > 1e-12
        ? -dir.dot(_sep) / Math.sqrt(separation)
        : Math.abs(dir.dot(triangle.normal));

      if (approach <= 1e-6) {
        continue;
      }

      if (gap <= CAPSULE_CAST_EPS) {
        // Touching, or overlapping and still driving in. Either way this is the contact.
        //
        // Reporting a hit at zero gap is what the earlier "drop anything we start inside" filter
        // got wrong: it also dropped the floor a body was RESTING on, because the election snap
        // lands the capsule exactly on the surface. The ground probe then found nothing, the mover
        // called itself airborne, gravity pulled it deeper, and each frame made the overlap worse
        // -- the avatar sank through the world a second after landing.
        const along = dir.dot(triangle.normal);
        return {
          distance: Math.max(0, travelled - skin),
          normal: along > 0 ? triangle.normal.clone().negate() : triangle.normal.clone(),
          source: triangle.source,
        };
      }

      // How far the sweep may safely advance before this face could be reached. Dividing by the
      // approach rate rather than stepping the raw gap converges in one or two iterations on planar
      // geometry, instead of creeping along a surface it runs beside.
      const reach = gap / approach;
      if (reach < soonest) {
        soonest = reach;
        nearest = triangle;
      }
    }

    if (nearest === null || !Number.isFinite(soonest)) {
      return null;
    }

    travelled += Math.max(soonest, CAPSULE_CAST_EPS);
    if (travelled > maxDist) {
      return null;
    }
  }

  // Did not converge within the ceiling. Report no hit rather than a wrong one: a missed contact
  // costs one frame of penetration that the next frame's cast corrects, while a fabricated one
  // wedges the mover in place.
  return null;
}
