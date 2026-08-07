import * as THREE from 'three';

import { toEngineMatrix } from './anim/axes';
import { modelSpaceBindMatrix } from './bind-pose';

/**
 * Push the owning placement's distance-fade alpha into the shared material, immediately before this
 * batch is drawn.
 *
 * It has to happen here, per draw, and not once per doodad: M2 materials are cached and shared
 * across every placement of a model (M2Blueprint.cache / M2#batches), so writing the uniform from a
 * per-doodad loop would leave every placement rendering with whichever one happened to write last.
 * The reference has the same shape -- a per-INSTANCE render-alpha slot (CM2Model+0x19c) feeding a
 * shared batch -- and `onBeforeRender` is three.js's equivalent seam.
 *
 * The walk up is two hops (batch mesh -> Submesh -> M2) and stops at whatever carries `fadeAlpha`.
 * Anything with no fade owner -- WMO-interior doodads, units -- renders fully opaque.
 *
 * Returns whether the uniform actually changed. See `applyUniformsBeforeRender` for what that is
 * for; writing `.value` alone never reaches the GPU.
 */
export function applyFadeAlphaBeforeRender(_renderer, _scene, _camera, _geometry, material) {
  if (!material || !material.uniforms || !material.uniforms.fadeAlpha) {
    return false;
  }

  let node = this;
  while (node && node.fadeAlpha === undefined) {
    node = node.parent;
  }

  const next = node ? node.fadeAlpha : 1.0;
  if (material.uniforms.fadeAlpha.value === next) {
    return false;
  }

  material.uniforms.fadeAlpha.value = next;
  return true;
}

/**
 * The identity a UV slot falls back to. Shared, and never mutated -- the slots are only ever
 * REPLACED, never written through.
 */
const IDENTITY_UV = new THREE.Matrix4();

/**
 * Push the owning placement's animated UV / transparency / vertex-colour values into the shared
 * material, immediately before this batch is drawn.
 *
 * Same reason as `applyFadeAlphaBeforeRender` directly above: M2 materials are cached and shared
 * across every placement, so writing these from a per-doodad loop would leave every placement
 * rendering with whichever one happened to write last. `onBeforeRender` is the per-draw seam, and it
 * is also cheaper -- a culled batch never pays for the write at all.
 *
 * EVERY slot the material declares is written on every call, including the ones this batch does not
 * animate. Skipping them would leave the previous placement's matrix in the shared uniform, which is
 * the exact failure this function exists to prevent.
 *
 * Returns whether anything changed -- see `applyUniformsBeforeRender`.
 */
export function applyAnimatedUniformsBeforeRender(_renderer, _scene, _camera, _geometry, material) {
  if (!material || !material.uniforms) {
    return false;
  }

  const def = material.animationDef;
  if (!def) {
    return false;
  }

  // Two hops (batch mesh -> Submesh -> M2), stopping at whatever carries the value slots.
  let node = this;
  while (node && node.uvAnimationValues === undefined) {
    node = node.parent;
  }
  if (!node) {
    return false;
  }

  const { uniforms } = material;
  let changed = false;

  if (uniforms.animatedUVs) {
    const slots = uniforms.animatedUVs.value;
    const indices = def.uvAnimationIndices;
    for (let i = 0, len = slots.length; i < len; ++i) {
      const source = i < indices.length ? node.uvAnimationValues[indices[i]] : undefined;
      const next = source ? source.matrix : IDENTITY_UV;

      if (slots[i] !== next) {
        slots[i] = next;
        changed = true;
      } else if (source) {
        // Same object as last draw, but its CONTENTS were resampled since -- `evaluateMaterialChannels`
        // rewrites the matrix in place every frame. A reference compare cannot see that, and a
        // 16-float compare to find out would cost more than it could ever save on a slot that is
        // animated by definition. An identity slot, which is the overwhelmingly common case, still
        // reports clean.
        changed = true;
      }
    }
  }

  if (uniforms.animatedTransparency && def.transparencyAnimationIndex >= 0) {
    const value = node.transparencyAnimationValues[def.transparencyAnimationIndex];
    const next = value === undefined ? 1.0 : value;
    if (uniforms.animatedTransparency.value !== next) {
      uniforms.animatedTransparency.value = next;
      changed = true;
    }
  }

  if (uniforms.animatedVertexColorRGB && def.vertexColorAnimationIndex >= 0) {
    const source = node.vertexColorAnimationValues[def.vertexColorAnimationIndex];
    const rgb = uniforms.animatedVertexColorRGB.value;

    const r = source ? source.color[0] : 1.0;
    const g = source ? source.color[1] : 1.0;
    const b = source ? source.color[2] : 1.0;
    const a = source ? source.alpha : 1.0;

    // This compare is only meaningful because the uniform holds its OWN `Vector3` -- see
    // `material/index.ts` and `material/M2MaterialNew.ts`, both of which initialise the slot with a
    // fresh `new THREE.Vector3(1, 1, 1)`, and `rgb.set(...)` below writes through that copy rather
    // than swapping in the source. If the slot were ever made to ALIAS the sampled value (as
    // `M2MaterialNewShaders#updateAnimatedVertexColor` does -- `uniforms.animatedVertexColorRGB.value
    // = rgb` -- assigning the caller's object straight into the slot), this becomes a self-compare:
    // `rgb` would already be the source, the three tests would always be false, the material would
    // report permanently clean, `uniformsNeedUpdate` would never be raised for it, and the animated
    // colour would freeze on whatever reached the GPU first.
    if (rgb.x !== r || rgb.y !== g || rgb.z !== b) {
      rgb.set(r, g, b);
      changed = true;
    }
    if (uniforms.animatedVertexColorAlpha.value !== a) {
      uniforms.animatedVertexColorAlpha.value = a;
      changed = true;
    }
  }

  return changed;
}

/**
 * The batch meshes' single `onBeforeRender`.
 *
 * `uniformsNeedUpdate` is the load-bearing line, for exactly the reason
 * `material/per-object-light.ts` already documents: three.js re-uploads a ShaderMaterial's uniforms
 * only when the material changes between draws (`WebGLRenderer#setProgram`: the upload sits behind
 * `refreshMaterial`, which needs a program swap or a different `material.id`) or when this flag is
 * set. Two placements of one model share a material and sort adjacently, so without the flag every
 * placement after the first draws with the FIRST one's UV matrix, transparency and colour -- the
 * same class of bug this whole file exists to prevent, moved from "last writer wins" to "first
 * drawer wins". It was missing from the fade push too, so that has never reached the GPU for a
 * second placement either.
 *
 * CONDITIONAL rather than the unconditional raise `applyPerObjectLighting` does. The flag re-uploads
 * the material's ENTIRE uniform list -- textures, a 28-float `probeCoeffs`, three light arrays -- and
 * the great majority of M2 batches animate no channel at all and sit at a constant fade alpha, so
 * for them this is a pure cost with nothing to show. A batch that genuinely animates reports dirty
 * every frame and pays the same as an unconditional raise would.
 *
 * Both handlers run before the flag is decided: `||` would short-circuit and skip the second push.
 *
 * A named module-level function rather than a closure per batch mesh, so chaining costs no
 * allocation per batch.
 */
export function applyUniformsBeforeRender(renderer, scene, camera, geometry, material, group) {
  const fadeChanged =
    applyFadeAlphaBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
  const animatedChanged =
    applyAnimatedUniformsBeforeRender.call(this, renderer, scene, camera, geometry, material, group);

  if (fadeChanged || animatedChanged) {
    material.uniformsNeedUpdate = true;
  }
}

class Submesh extends THREE.Group {

  constructor(opts) {
    super();

    this.matrixAutoUpdate = opts.matrixAutoUpdate;

    this.useSkinning = opts.useSkinning;

    /**
     * The one bone this submesh rides, or -1.
     *
     * Set only when `useSkinning` is false BECAUSE the submesh was found rigid under a single bone
     * (`anim/skinning-scope.ts`), never for a genuinely static submesh. `applySoleBone` below is
     * what makes the two paths equivalent; the derivation lives in that module's header.
     */
    this.soleBoneIndex = opts.soleBoneIndex === undefined ? -1 : opts.soleBoneIndex;

    this.rootBone = null;
    this.billboarded = false;

    if (this.useSkinning) {
      // Preserve the rootBone for the submesh such that its skin property can be assigned to the
      // first child batch mesh.
      this.rootBone = opts.rootBone;
      this.billboarded = opts.rootBone.userData.billboarded;

      // Preserve the skeleton for use in applying batches.
      this.skeleton = opts.skeleton;
    }

    // Preserve the geometry for use in applying batches.
    this.geometry = opts.geometry;
  }

  /**
   * Drive a single-bone submesh from its one bone's palette entry.
   *
   * No skeleton, no bone texture, no skinning shader variant -- the bone's transform relative to
   * bind pose IS this submesh's local matrix. `anim/skinning-scope.ts` derives why that substitution
   * is EXACT rather than an approximation, including why the bind-pose inverse is already folded in
   * (an `InstanceAnim` palette entry is relative to bind pose by construction) and the two cases
   * where it does not hold, which that module refuses up front.
   *
   * The source is the PALETTE, and it cannot be `skeleton.boneMatrices[i]` instead. Those two are not
   * the same matrix: three writes `boneMatrices[i] = bone.matrixWorld . boneInverse_i`, which carries
   * the M2's world matrix `W`, while what belongs in a LOCAL matrix here is the `W`-free
   * `P_i . B_i^-1`. They agree only where `W = I`, which is every unit test and no real placement --
   * so the substitution looks green and puts the submesh at roughly the square of its world
   * placement in game.
   *
   * The conjugation is load-bearing. `InstanceAnim.palette` is in RAW M2 axes while the scene graph
   * is in engine axes, so it goes through `toEngineMatrix` (`anim/axes.ts`), the matrix form of the
   * same `D = diag(-1, -1, 1)` the bone path applies component-wise. Taking the palette entry
   * straight would leave the submesh mirrored about X and Y: still animating, at the right rate,
   * through the right arc, swinging the wrong way.
   *
   * The `matrix` write is what actually reaches the screen -- `matrixAutoUpdate` is false on the
   * whole M2 subtree, so `World#updateDynamicMatrices`' forced `updateMatrixWorld(true)` composes
   * `this.matrix` as written. The decompose keeps `position`/`quaternion`/`scale` honest for anything
   * that inspects them (and would keep this correct if the subtree ever went auto-update); it uses
   * three's module-level scratch and allocates nothing.
   *
   * Called from `M2#applyPose`, i.e. only for instances actually posed this frame. A gated instance
   * simply keeps last frame's matrix -- exactly what its bones would have done.
   */
  applySoleBone(palette) {
    if (this.soleBoneIndex < 0) {
      return;
    }

    toEngineMatrix(this.matrix, palette, this.soleBoneIndex * 16);
    this.matrix.decompose(this.position, this.quaternion, this.scale);
    this.matrixWorldNeedsUpdate = true;
  }

  // Submeshes get one mesh per batch, which allows them to effectively simulate multiple
  // render passes. Batch mesh rendering order should be handled properly by the three.js
  // renderer.
  applyBatches(batches) {
    this.clearBatches();

    const batchLen = batches.length;
    for (let batchIndex = 0; batchIndex < batchLen; ++batchIndex) {
      const batchMaterial = batches[batchIndex];

      // If the submesh is billboarded, flag the material as billboarded.
      if (this.billboarded) {
        batchMaterial.enableBillboarding();
      }

      let batchMesh;

      // Only use a skinned mesh if the submesh uses skinning.
      if (this.useSkinning) {
        batchMesh = new THREE.SkinnedMesh(this.geometry, batchMaterial);
        // EXPLICIT bind matrix. `bind(skeleton)` alone re-runs skeleton.calculateInverses() as a
        // side effect, which is destructive on any call after the first: by then the bones have been
        // moved into world space by the scene graph, so the bind pose would be recomputed from the
        // wrong state and the mesh culled out of the frame.
        //
        // As the code stands TODAY there is no second call -- `applyBatches` has exactly one caller,
        // `M2#createSubmesh`, during construction, and the display-info path
        // (`Submesh#set displayInfo`) mutates the existing materials' textures without rebuilding
        // batch meshes. The explicit bind matrix is kept because it costs nothing and it is what
        // makes a re-run SAFE: give `applyBatches` a second caller -- a real display-info rebuild, a
        // batch-order change, an LOD swap -- and the hazard is live again the same day.
        batchMesh.bind(this.skeleton, modelSpaceBindMatrix());
      } else {
        batchMesh = new THREE.Mesh(this.geometry, batchMaterial);
      }

      batchMesh.matrixAutoUpdate = this.matrixAutoUpdate;
      // ASSIGNS the slot outright, so any handler installed on a batch mesh from outside --
      // `attachPerObjectLighting` is the one such caller today, for WMO-interior doodads -- would be
      // un-installed by a re-run of this method.
      //
      // No re-run happens today: `applyBatches` has exactly one caller, `M2#createSubmesh`, during
      // construction, and the display-info path (`Submesh#set displayInfo`) updates the existing
      // materials' textures in place rather than rebuilding batch meshes. So the ordering hazard is
      // currently theoretical. It becomes real the moment `applyBatches` gains a second caller, and
      // the fix then is a real handler list on the mesh rather than one slot with three claimants.
      // See the matching note on `attachPerObjectLighting`.
      batchMesh.onBeforeRender = applyUniformsBeforeRender;

      this.add(batchMesh);
    }

    if (this.useSkinning) {
      this.rootBone.skin = this.children[0];
    }
  }

  // Remove any existing child batch meshes.
  clearBatches() {
    const childrenLength = this.children.length;
    for (let childIndex = 0; childIndex < childrenLength; ++childIndex) {
      const child = this.children[childIndex];
      this.remove(child);
    }

    if (this.useSkinning) {
      // If all batch meshes are cleared, there is no longer a skin to associate with the
      // root bone.
      this.rootBone.skin = null;
    }
  }

  // Update all existing batch mesh materials to point to the new skins (textures).
  set displayInfo(displayInfo) {
    const { path } = displayInfo.modelData;

    const skin1 = `${path}${displayInfo.skin1}.blp`;
    const skin2 = `${path}${displayInfo.skin2}.blp`;
    const skin3 = `${path}${displayInfo.skin3}.blp`;

    const childrenLength = this.children.length;
    for (let childIndex = 0; childIndex < childrenLength; ++childIndex) {
      const child = this.children[childIndex];
      child.material.updateSkinTextures(skin1, skin2, skin3);
    }
  }

  // The character body skin (texture type 1), hair sheet (type 6) and cloak sheet (type 2), for every
  // batch of this submesh. All three in one call -- see `M2Material#updateCharacterTextures` for why
  // that matters.
  set characterTextures({ body, hair, cape }) {
    const childrenLength = this.children.length;
    for (let childIndex = 0; childIndex < childrenLength; ++childIndex) {
      this.children[childIndex].material.updateCharacterTextures(body, hair, cape);
    }
  }

  dispose() {
    this.geometry.dispose();

    this.children.forEach((child) => {
      child.geometry.dispose();
      child.material.dispose();
    });
  }

}

export default Submesh;
