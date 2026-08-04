import * as THREE from 'three';

/** Everything `buildBoneHierarchy` derives from a model's bone defs. */
export interface BoneHierarchy {
  /** File order -- index i pairs with bone def i, and with palette/localTRS slot i. */
  bones: THREE.Bone[];
  rootBones: THREE.Bone[];
  billboards: THREE.Bone[];
  /** Each bone's BIND offset from its parent, engine axes, 3 floats per bone. */
  bindPositions: Float32Array;
  /** True if any bone carries TRS keys or is billboarded -- the parser's own `bone.animated`. */
  useSkinning: boolean;
}

/**
 * Build a model's bone hierarchy from its parsed bone defs.
 *
 * Extracted from `M2#createSkeleton` so that `anim/__tests__/pose.test.ts` can exercise the REAL
 * construction rather than a hand-mirrored copy of it. That matters more than it looks: the pose
 * test's whole value is that it pins `applyLocalPose` against three's own palette, and a hand-copied
 * fixture would drift away from production silently -- nothing would fail, the test would simply
 * stop describing the code. `M2` is untestable directly (its constructor reaches for
 * `collisionWorld` and `ObjectsManager`), so the seam had to move here.
 *
 * Two things worth naming, because both are load-bearing and neither is obvious:
 *
 *   * The pivot mirror `(-p0, -p1, p2)` is the engine-axis transform `D = diag(-1, -1, 1)` that the
 *     geometry also gets, in one step rather than three. See `anim/axes.ts`.
 *   * The parent subtraction walks the WHOLE ancestor chain, subtracting each ancestor's ALREADY
 *     ADJUSTED position. Those telescope, so the result is `D(pivot_i) - D(pivot_parent)` -- the
 *     offset from the immediate parent, which is what a three.js bone slot holds. It reads like a
 *     bug and is not one.
 */
export function buildBoneHierarchy(boneDefs: any[]): BoneHierarchy {
  const bones: THREE.Bone[] = [];
  const rootBones: THREE.Bone[] = [];
  const billboards: THREE.Bone[] = [];
  let useSkinning = false;

  for (let boneIndex = 0, len = boneDefs.length; boneIndex < len; ++boneIndex) {
    const boneDef = boneDefs[boneIndex];
    const bone = new THREE.Bone();

    bones.push(bone);

    // M2 bone positioning is mirrored on X and Y -- the same `D` the geometry takes.
    const { pivotPoint } = boneDef;
    bone.position.set(-pivotPoint[0], -pivotPoint[1], pivotPoint[2]);

    if (boneDef.parentID > -1) {
      const parent = bones[boneDef.parentID];
      parent.add(bone);

      // Telescopes to `position - parentPosition`; see the doc above.
      let up: any = bone;
      while ((up = up.parent)) {
        bone.position.sub(up.position);
      }
    } else {
      bone.userData.isRoot = true;
      rootBones.push(bone);
    }

    // Enable skinning support on this M2 if we have bone animations.
    if (boneDef.animated) {
      useSkinning = true;
    }

    // Flag billboarded bones
    if (boneDef.billboarded) {
      bone.userData.billboarded = true;
      bone.userData.billboardType = boneDef.billboardType;

      billboards.push(bone);
    }

    // No per-bone track registration here. Bone TRS keyframes live once per model on
    // `ModelAnim.boneDefs`, and `InstanceAnim#solveBones` reads them directly -- see the M2
    // constructor for why registering them per clone was the original defect.
  }

  // Snapshot the bind offsets before anything poses them. `M2#applyPose` adds each frame's sampled
  // translation onto these, so reading them back off `bone.position` later would compound.
  const bindPositions = new Float32Array(bones.length * 3);
  for (let i = 0, len = bones.length; i < len; ++i) {
    const p = bones[i].position;
    bindPositions[i * 3] = p.x;
    bindPositions[i * 3 + 1] = p.y;
    bindPositions[i * 3 + 2] = p.z;
  }

  return { bones, rootBones, billboards, bindPositions, useSkinning };
}

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

/** What M2 bone weights are stored as: four bytes per vertex, summing to 255. */
const M2_BONE_WEIGHT_SCALE = 255;

/**
 * Convert an M2 vertex's bone weights into the normalized form three.js skinning expects.
 *
 * The format stores them as four `uint8` summing to **255**; three's skinning sums the weighted
 * bone matrices and expects them to sum to **1**. Handing the raw bytes straight to a
 * `skinWeight` attribute scales every vertex by ~255.
 *
 * That does not look like a weighting bug from the outside. The mesh balloons to hundreds of times
 * its size, its skinned bounding sphere lands tens of thousands of yards from the model, the
 * frustum test drops it, and the body renders as nothing at all -- while its geometry, its
 * skeleton, its materials and its world matrix all inspect as perfectly correct.
 *
 * Weights that are already normalized are passed through, so this is safe to apply to any source.
 */
export function normalizeBoneWeights(weights: ArrayLike<number>): [number, number, number, number] {
  const w0 = weights[0] ?? 0;
  const w1 = weights[1] ?? 0;
  const w2 = weights[2] ?? 0;
  const w3 = weights[3] ?? 0;

  const sum = w0 + w1 + w2 + w3;
  if (sum === 0) {
    // An unweighted vertex. Bind it fully to its first bone rather than collapsing it to the
    // origin, which is what a zero weight vector would do.
    return [1, 0, 0, 0];
  }

  const scale = sum > 1.5 ? 1 / sum : 1 / Math.max(sum, 1e-6);

  return [w0 * scale, w1 * scale, w2 * scale, w3 * scale];
}

export { M2_BONE_WEIGHT_SCALE };
