import * as THREE from 'three';

import { toEngineQuaternion, toEngineTranslation } from './axes';
import { LOCAL_TRS_STRIDE } from './instance-anim';

/**
 * Write a solved local pose into a three.js bone hierarchy.
 *
 * WHY THE BONES AND NOT THE PALETTE DIRECTLY. The obvious shape -- copy `instanceAnim.palette` into
 * `skeleton.boneMatrices` and flag the bone texture -- does not work in three 0.185, for two
 * independent reasons, either of which alone is fatal:
 *
 *   1. `WebGLObjects.update` calls `skeleton.update()` once per frame for every skinned mesh it is
 *      about to draw (`node_modules/three/src/renderers/webgl/WebGLObjects.js:46-57`), and that
 *      recomputes every entry of `boneMatrices` from `bone.matrixWorld * boneInverse`. Anything
 *      written into `boneMatrices` before `render()` is overwritten during it. The write is not
 *      merely redundant -- it is invisible, and a counter incremented next to it reads as success.
 *   2. Billboarding is applied to BONES (`M2#applyBillboards` sets `bone.rotation`). A palette
 *      written straight from the solver knows nothing about it, so every billboarded bone on an
 *      animated model would lose its facing -- and the doodads with the most billboards are exactly
 *      the ones this exists to animate.
 *
 * Writing bone TRS keeps the proven render path: the scene walk in `World#updateDynamicMatrices`
 * accumulates the hierarchy, `skeleton.update()` builds the palette against the bind inverses
 * `poseBindSkeleton` computed, and billboarding composes on top simply by running afterwards.
 *
 * The accumulation is not duplicated work. The M2 bone law `parent * T(p) * TRS * T(-p)` reduces,
 * per bone, to `T(p_i - p_parent) * TRS` -- a LOCAL transform, which is what a bone slot holds. The
 * parent composition happens exactly once, in the scene graph.
 *
 * The invariant this upholds, and what `pose.test.ts` pins:
 *
 *     skeleton.boneMatrices  ==  D . instanceAnim.palette . D        (D = diag(-1, -1, 1))
 *
 * after `updateMatrixWorld(true)` and `skeleton.update()`. The solver works in raw file axes and
 * the hierarchy in engine axes; see `axes.ts`.
 *
 * Allocation-free: it writes through the bones' existing `position`/`quaternion`/`scale` objects.
 *
 * @param bones     the model's bones, file order -- index i pairs with bone def i
 * @param bind      each bone's BIND offset from its parent, engine axes, 3 floats per bone
 * @param localTRS  this frame's sampled locals, raw axes, `LOCAL_TRS_STRIDE` floats per bone
 */
export function applyLocalPose(
  bones: THREE.Bone[],
  bind: Float32Array,
  localTRS: Float32Array,
): void {
  for (let i = 0, len = bones.length; i < len; ++i) {
    const bone = bones[i];
    const o = i * LOCAL_TRS_STRIDE;
    const b = i * 3;

    toEngineTranslation(
      bone.position,
      bind[b], bind[b + 1], bind[b + 2],
      localTRS[o], localTRS[o + 1], localTRS[o + 2],
    );

    // A billboarded bone's rotation belongs to the camera, not to the keyframes. Writing the sampled
    // rotation here would fight `applyBillboards` -- and win on every frame the camera did not move,
    // since billboarding only runs on `cameraMoved`.
    if (bone.userData.billboarded !== true) {
      toEngineQuaternion(
        bone.quaternion,
        localTRS[o + 3], localTRS[o + 4], localTRS[o + 5], localTRS[o + 6],
      );
    }

    bone.scale.set(localTRS[o + 7], localTRS[o + 8], localTRS[o + 9]);
  }
}
