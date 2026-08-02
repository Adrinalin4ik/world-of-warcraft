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

/**
 * Distance from the capsule's AXIS SEGMENT to a triangle, minus the radius: the signed gap between
 * the capsule SURFACE and the face. Negative while they overlap.
 *
 * `base` is the capsule centre; the axis runs +/- `halfSegment` along Z from it.
 */
export function closestDistanceCapsuleTriangle(
  base: THREE.Vector3, halfSegment: number, radius: number, triangle: Triangle,
): number {
  _line.start.set(base.x, base.y, base.z - halfSegment);
  _line.end.set(base.x, base.y, base.z + halfSegment);

  _tri.a.copy(triangle.a);
  _tri.b.copy(triangle.b);
  _tri.c.copy(triangle.c);
  _tri.needsUpdate = true;

  return _tri.closestPointToSegment(_line, _closestOnTri, _closestOnSeg) - radius;
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
 * **Origin penetration is ignored.** A capsule already overlapping a face -- a head grazing a
 * ceiling, a body resting on the floor -- still casts outward instead of reporting an instant hit.
 * Any triangle whose gap is already negative at t = 0 is dropped for the whole sweep. Without this,
 * the down-probe that runs every grounded frame would stop dead at zero.
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

  const candidates: Triangle[] = [];
  for (let i = 0, len = triangles.length; i < len; ++i) {
    if (closestDistanceCapsuleTriangle(from, halfSegment, radius, triangles[i]) > 0) {
      candidates.push(triangles[i]);
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  let travelled = 0;
  for (let step = 0; step < MAX_ADVANCE_STEPS; ++step) {
    _probe.copy(dir).multiplyScalar(travelled).add(from);

    let nearestGap = Infinity;
    let nearest: Triangle | null = null;
    for (let i = 0, len = candidates.length; i < len; ++i) {
      const gap = closestDistanceCapsuleTriangle(_probe, halfSegment, radius, candidates[i]);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = candidates[i];
      }
    }

    if (nearest === null) {
      return null;
    }

    if (nearestGap <= CAPSULE_CAST_EPS) {
      return {
        distance: Math.max(0, travelled - skin),
        normal: nearest.normal.clone(),
        source: nearest.source,
      };
    }

    travelled += nearestGap;
    if (travelled > maxDist) {
      return null;
    }
  }

  // Did not converge within the ceiling. Report no hit rather than a wrong one: a missed contact
  // costs one frame of penetration that the next frame's cast corrects, while a fabricated one
  // wedges the mover in place.
  return null;
}
