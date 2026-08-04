import * as THREE from 'three';

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
        // side effect, and applyBatches runs again whenever display-info textures resolve -- by
        // which time the bones have been moved into world space by the scene graph, so the bind
        // pose gets recomputed from the wrong state and the mesh is culled out of the frame.
        batchMesh.bind(this.skeleton, modelSpaceBindMatrix());
      } else {
        batchMesh = new THREE.Mesh(this.geometry, batchMaterial);
      }

      batchMesh.matrixAutoUpdate = this.matrixAutoUpdate;
      // ASSIGNS the slot, and this method runs again whenever display-info textures resolve. Any
      // handler installed on a batch mesh from outside -- `attachPerObjectLighting` is the one such
      // caller today, for WMO-interior doodads -- is un-installed by a re-run. The batch meshes are
      // rebuilt here anyway, so nothing outside can hold onto one; the hazard is an attacher that
      // ran against the PREVIOUS set. See the note on `attachPerObjectLighting`.
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

  dispose() {
    this.geometry.dispose();

    this.children.forEach((child) => {
      child.geometry.dispose();
      child.material.dispose();
    });
  }

}

export default Submesh;
