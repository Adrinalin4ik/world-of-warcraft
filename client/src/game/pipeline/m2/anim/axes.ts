import * as THREE from 'three';

/**
 * Raw M2 axes -> engine axes, for an animated bone's local transform.
 *
 * The M2 pipeline mirrors the model on the way in. `M2#createGeometry` pushes each vertex as
 * `(X, Z, -Y)`, then applies `scale(-1, -1, 1)` and `rotateX(-90 deg)`; compose those and a raw
 * vertex `(X, Y, Z)` lands at `(-X, -Y, Z)`. `M2#createSkeleton` does the same thing directly, in
 * one step, storing each pivot as `(-p0, -p1, p2)`.
 *
 * So the whole engine transform is `D = diag(-1, -1, 1)`, and `D` is its own inverse.
 *
 * `InstanceAnim` samples keys in RAW file axes -- it reads `def.pivotPoint` and the raw translation
 * and rotation tracks untouched. A raw local transform `M` therefore has to be conjugated,
 * `M' = D M D`, before it can drive a bone that already lives in engine axes. Skipping this is not
 * a subtle error: a flag that should sway east sways west, and a rotation about X comes out
 * mirrored, while every intermediate value still inspects as plausible.
 *
 * `D` is not a reflection. `diag(-1, -1, 1)` is a proper rotation -- 180 degrees about Z,
 * determinant +1 -- which is why the conjugation collapses to sign flips rather than needing a
 * handedness fix:
 *
 *   * translation `(x, y, z)` -> `(-x, -y, z)`
 *   * quaternion `(x, y, z, w)` -> `(-x, -y, z, w)`   (conjugation by the unit quaternion `k`)
 *   * scale is untouched -- `D` and a diagonal scale commute, so `D S D = S`.
 */

/**
 * Write a bone's engine-space local translation.
 *
 * `bx, by, bz` is the bone's BIND offset from its parent, which `createSkeleton` already stored in
 * engine axes; `tx, ty, tz` is this frame's raw sampled translation.
 *
 * The two are added rather than composed because the M2 bone law
 * `parent * T(pivot) * TRS * T(-pivot)` reduces, per bone, to
 * `T(pivot_i - pivot_parent) * TRS` -- and a translation pre-multiplied onto a composed TRS is just
 * an offset on its position. That reduction is what lets the existing scene graph accumulate the
 * hierarchy for us instead of the solver doing it twice.
 */
export function toEngineTranslation(
  out: THREE.Vector3,
  bx: number, by: number, bz: number,
  tx: number, ty: number, tz: number,
): THREE.Vector3 {
  return out.set(bx - tx, by - ty, bz + tz);
}

/** Write a bone's engine-space local rotation from a raw sampled quaternion. */
export function toEngineQuaternion(
  out: THREE.Quaternion,
  x: number, y: number, z: number, w: number,
): THREE.Quaternion {
  return out.set(-x, -y, z, w);
}
