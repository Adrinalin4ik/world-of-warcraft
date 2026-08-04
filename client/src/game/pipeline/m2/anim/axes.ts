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

/**
 * Per-element signs of `D M D` for a column-major 4x4, precomputed.
 *
 * `(D M D)[row][col] = d[row] * M[row][col] * d[col]` with `d = (-1, -1, 1, 1)`, and a
 * `THREE.Matrix4`'s `elements[k]` is `row = k % 4`, `col = (k / 4) | 0`. Rows 0-1 paired with
 * cols 0-1 (the in-plane rotation block) and rows 2-3 with cols 2-3 keep their sign; the two
 * off-diagonal blocks flip. Note element 12/13 -- the X and Y translation -- flipping, which is the
 * same `(-x, -y, z)` `toEngineTranslation` applies.
 *
 * A table rather than arithmetic so the conversion is a straight multiply per element with no
 * branch and no allocation; it runs once per single-bone submesh per posed frame.
 */
const D_CONJUGATION_SIGNS = new Int8Array([
  1, 1, -1, -1,
  1, 1, -1, -1,
  -1, -1, 1, 1,
  -1, -1, 1, 1,
]);

/**
 * Conjugate one raw-axis palette matrix into engine axes: `out = D . palette_i . D`.
 *
 * `InstanceAnim.palette` holds each bone's transform RELATIVE TO BIND POSE in raw file axes, while
 * the scene graph the result has to drive lives in engine axes. This is the matrix form of the same
 * `D` conjugation `toEngineTranslation`/`toEngineQuaternion` apply component-wise, and it is exactly
 * the invariant `anim/__tests__/pose.test.ts` pins against three's own palette:
 *
 *     skeleton.boneMatrices[i]  ==  D . instanceAnim.palette[i] . D
 *
 * Skipping it is nearly invisible: a swinging sign still swings, at the right rate, through the
 * right arc -- mirrored about the model's X/Y.
 *
 * Allocation-free: writes through `out.elements`.
 *
 * @param out      destination, overwritten
 * @param palette  `InstanceAnim.palette`, raw axes, 16 floats per bone
 * @param offset   element offset of the bone's entry, i.e. `boneIndex * 16`
 */
export function toEngineMatrix(
  out: THREE.Matrix4,
  palette: ArrayLike<number>,
  offset: number,
): THREE.Matrix4 {
  const e = out.elements;

  for (let k = 0; k < 16; ++k) {
    e[k] = D_CONJUGATION_SIGNS[k] * palette[offset + k];
  }

  return out;
}
