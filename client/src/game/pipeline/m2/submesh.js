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
 */
function applyFadeAlphaBeforeRender(_renderer, _scene, _camera, _geometry, material) {
  if (!material || !material.uniforms || !material.uniforms.fadeAlpha) {
    return;
  }

  let node = this;
  while (node && node.fadeAlpha === undefined) {
    node = node.parent;
  }

  material.uniforms.fadeAlpha.value = node ? node.fadeAlpha : 1.0;
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
 */
function applyAnimatedUniformsBeforeRender(_renderer, _scene, _camera, _geometry, material) {
  if (!material || !material.uniforms) {
    return;
  }

  const def = material.animationDef;
  if (!def) {
    return;
  }

  // Two hops (batch mesh -> Submesh -> M2), stopping at whatever carries the value slots.
  let node = this;
  while (node && node.uvAnimationValues === undefined) {
    node = node.parent;
  }
  if (!node) {
    return;
  }

  const { uniforms } = material;

  if (uniforms.animatedUVs) {
    const slots = uniforms.animatedUVs.value;
    const indices = def.uvAnimationIndices;
    for (let i = 0, len = slots.length; i < len; ++i) {
      const source = i < indices.length ? node.uvAnimationValues[indices[i]] : undefined;
      slots[i] = source ? source.matrix : IDENTITY_UV;
    }
  }

  if (uniforms.animatedTransparency && def.transparencyAnimationIndex >= 0) {
    const value = node.transparencyAnimationValues[def.transparencyAnimationIndex];
    uniforms.animatedTransparency.value = value === undefined ? 1.0 : value;
  }

  if (uniforms.animatedVertexColorRGB && def.vertexColorAnimationIndex >= 0) {
    const source = node.vertexColorAnimationValues[def.vertexColorAnimationIndex];
    const rgb = uniforms.animatedVertexColorRGB.value;
    if (source) {
      rgb.set(source.color[0], source.color[1], source.color[2]);
      uniforms.animatedVertexColorAlpha.value = source.alpha;
    } else {
      rgb.set(1.0, 1.0, 1.0);
      uniforms.animatedVertexColorAlpha.value = 1.0;
    }
  }
}

/**
 * The batch meshes' single `onBeforeRender`. A named module-level function rather than a closure per
 * batch mesh, so chaining the two handlers costs no allocation per batch.
 */
function applyUniformsBeforeRender(renderer, scene, camera, geometry, material, group) {
  applyFadeAlphaBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
  applyAnimatedUniformsBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
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
