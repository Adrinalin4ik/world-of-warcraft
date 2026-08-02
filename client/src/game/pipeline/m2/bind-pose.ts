import * as THREE from 'three';

/**
 * Bind a skeleton to its MODEL-SPACE bind pose.
 *
 * `THREE.Skeleton` derives its bone inverses from each bone's `matrixWorld` at construction, and a
 * freshly built bone hierarchy has never been through `updateMatrixWorld` -- every bone still
 * carries the identity it was created with, so every inverse comes out identity too.
 *
 * An identity inverse is not a harmless approximation. Each palette entry becomes the bone's FULL
 * WORLD matrix instead of its delta from bind pose, and that breaks the mesh in a way that looks
 * nothing like a skinning bug:
 *
 *   `SkinnedMesh.computeBoundingSphere()` skins the vertices with the palette, so the sphere it
 *   computes is centred on the model's WORLD position -- while still being treated as a LOCAL
 *   bound. The frustum test then multiplies it by `matrixWorld`, adding that position a second
 *   time, and the sphere lands roughly twice as far from the origin as the model itself. three
 *   culls the mesh, `setProgram` never runs for it, its bone texture is never created, and the
 *   body is present, visible, correctly placed, and draws nothing at all.
 *
 * Posing the roots first puts the hierarchy in model space, which is exactly the space the inverses
 * should be taken from.
 */
export function poseBindSkeleton(rootBones: THREE.Bone[], bones: THREE.Bone[]): THREE.Skeleton {
  for (let i = 0, len = rootBones.length; i < len; ++i) {
    rootBones[i].updateMatrixWorld(true);
  }

  return new THREE.Skeleton(bones);
}

/**
 * The bind matrix every M2 mesh binds with.
 *
 * `SkinnedMesh.bind(skeleton)` called WITHOUT a bind matrix re-runs `skeleton.calculateInverses()`
 * as a side effect, re-deriving the inverses from wherever the bones happen to be at that moment.
 * That is fine exactly once, at construction; it is destructive every time afterwards, because by
 * then the bones have been moved into world space by the scene graph. The M2 pipeline rebinds on
 * every `applyBatches`, which happens again whenever display-info textures resolve -- so the
 * inverses were being recomputed long after the bind pose was gone.
 *
 * Passing an explicit bind matrix takes that branch out entirely. Identity is the correct value:
 * the geometry and the bind pose are both in model space, and `AttachedBindMode` recomputes
 * `bindMatrixInverse` from the live `matrixWorld` each frame regardless, so nothing is lost.
 */
export function modelSpaceBindMatrix(): THREE.Matrix4 {
  return new THREE.Matrix4();
}
