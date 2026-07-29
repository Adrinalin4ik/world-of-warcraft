class BatchManager {
  constructor(data, skinData) {
    this.data = data;
    this.skinData = skinData;

    this.calculateRuntimeValues();
  }

  stubDef() {
    const def = {
      flags: null,
      shaderID: null,
      shaderNames: {
        vertex: null,
        fragment: null
      },
      opCount: null,
      textureMapping: null,
      renderFlags: null,
      blendingMode: null,
      textures: [],
      textureIndices: [],
      uvAnimations: [],
      uvAnimationIndices: [],
      transparencyAnimation: null,
      transparencyAnimationIndex: null,
      vertexColorAnimation: null,
      vertexColorAnimationIndex: null
    };

    return def;
  }

  createDefs() {
    const defs = [];

    this.skinData.batches.forEach((batchData) => {
      const def = this.createDef(batchData);
      defs.push(def);
    });

    return defs;
  }

  resolveTextureIndices(batchData) {
    batchData.textureIndices = [];

    for (let opIndex = 0; opIndex < batchData.runtimeOpCount; opIndex++) {
      const textureIndex = this.data.textureLookups[batchData.textureLookup + opIndex];
      batchData.textureIndices.push(textureIndex);
    }
  }

  resolveUVAnimationIndices(batchData) {
    batchData.uvAnimationIndices = [];

    for (let opIndex = 0; opIndex < batchData.runtimeOpCount; opIndex++) {
      const uvAnimationIndex = this.data.uvAnimationLookups[batchData.uvAnimationLookup + opIndex];
      batchData.uvAnimationIndices.push(uvAnimationIndex);
    }
  }

  createDef(batchData) {
    const def = this.stubDef();

    const { textures } = this.data;
    const { vertexColorAnimations, transparencyAnimations, uvAnimations } = this.data;

    // Not everything has layered batches, so sub835E90 may not have run, and texures / uv
    // animations may still need to be resolved.
    if (!batchData.textureIndices) {
      this.resolveTextureIndices(batchData);
    }
    if (!batchData.uvAnimationIndices) {
      this.resolveUVAnimationIndices(batchData);
    }

    const { runtimeOpCount } = batchData;
    const { textureMappingIndex, materialIndex } = batchData;
    const { vertexColorAnimationIndex, transparencyAnimationLookup } = batchData;
    const { textureIndices, uvAnimationIndices } = batchData;

    // Batch flags
    def.flags = batchData.flags;

    // Submesh index and batch layer
    def.submeshIndex = batchData.submeshIndex;
    def.layer = batchData.layer;

    // Op count and shader ID
    def.opCount = batchData.runtimeOpCount;
    def.shaderID = batchData.runtimeShaderID;

    // Texture mapping
    // -1 => Env; 0 => T1; 1 => T2
    if (textureMappingIndex >= 0) {
      const textureMapping = this.data.textureMappings[textureMappingIndex];
      def.textureMapping = textureMapping;
    }

    // Material (render flags and blending mode)
    const material = this.data.materials[materialIndex];
    def.renderFlags = material.renderFlags;
    def.blendingMode = material.blendingMode;

    // Determine names of vertex and fragment shader for this batch
    def.shaderNames = this.lookupShaderNames(def.shaderID, def.opCount, def.textureMapping);

    // Vertex color animation block
    if (vertexColorAnimationIndex > -1 && vertexColorAnimations[vertexColorAnimationIndex]) {
      const vertexColorAnimation = vertexColorAnimations[vertexColorAnimationIndex];
      def.vertexColorAnimation = vertexColorAnimation;
      def.vertexColorAnimationIndex = vertexColorAnimationIndex;
    }

    // Transparency animation block
    // TODO: Do we load multiple values based on opCount?
    const transparencyAnimationIndex = this.data.transparencyAnimationLookups[transparencyAnimationLookup];
    if (transparencyAnimationIndex > -1 && transparencyAnimations[transparencyAnimationIndex]) {
      const transparencyAnimation = transparencyAnimations[transparencyAnimationIndex];
      def.transparencyAnimation = transparencyAnimation;
      def.transparencyAnimationIndex = transparencyAnimationIndex;
    }

    for (let opIndex = 0; opIndex < runtimeOpCount; ++opIndex) {
      // Texture
      // - already resolved to index in sub835E90
      const textureIndex = textureIndices[opIndex];
      const texture = textures[textureIndex];
      if (texture) {
        def.textures[opIndex] = texture;
        def.textureIndices[opIndex] = textureIndex;
      }

      // UV animation block
      // - already resolved to index in sub835E90
      const uvAnimationIndex = uvAnimationIndices[opIndex];
      const uvAnimation = uvAnimations[uvAnimationIndex];
      if (uvAnimation) {
        def.uvAnimations[opIndex] = uvAnimation;
        def.uvAnimationIndices[opIndex] = uvAnimationIndex;
      }
    }

    return def;
  }

  calculateRuntimeValues() {
    // Grab fresh copies of the original on-disk shader ID and op count.
    this.skinData.batches.forEach((batchData) => {
      batchData.runtimeShaderID = batchData.shaderID;
      batchData.runtimeOpCount = batchData.opCount;
    });

    this.sub836980();
    this.sub837680();
  }

  sub836980() {
    this.skinData.batches.forEach((batchData) => {
      // The shader ID is already calculated, so there's nothing to do.
      if (batchData.runtimeShaderID & 0x8000) {
        return;
      }

      const materialData = this.data.materials[batchData.materialIndex];

      if (!this.data.overrideBlending) {
        const textureMapping = this.data.textureMappings[batchData.textureMappingIndex];

        const envMapped = textureMapping === -1;
        const nonOpaqueBlendingMode = materialData.blendingMode !== 0;

        let newShaderID = 0;

        if (nonOpaqueBlendingMode) {
          newShaderID = 1;

          if (envMapped) {
            newShaderID |= 8;
          }
        }

        newShaderID *= 16;

        if (textureMapping === 1) {
          newShaderID |= 0x4000;
        }

        // Override shaderID
        batchData.runtimeShaderID = newShaderID;
      } else {
        // Shouldn't really happen, but client does check this, so it's perhaps a safeguard.
        if (batchData.runtimeOpCount === 0) {
          return;
        }

        const v19 = [0, 0];

        let blendingOverrideIndex = null;
        let blendingOverride = null;
        let textureMappingIndex = null;
        let textureMapping = null;
        let envMapped = null;

        let newShaderID = 0;

        for (let opIndex = 0; opIndex < batchData.runtimeOpCount; opIndex++) {
          blendingOverrideIndex = batchData.runtimeShaderID + opIndex;
          blendingOverride = this.data.blendingOverrides[blendingOverrideIndex];

          if (opIndex === 0 && materialData.blendingMode === 0) {
            blendingOverride = 0;
          }

          textureMappingIndex = batchData.textureMappingIndex + opIndex;
          textureMapping = this.data.textureMappings[textureMappingIndex];
          envMapped = textureMapping === -1;

          if (envMapped) {
            v19[opIndex] = blendingOverride | 8;
          } else {
            v19[opIndex] = blendingOverride;
          }

          if (textureMapping === 1 && opIndex + 1 === batchData.runtimeOpCount) {
            newShaderID |= 0x4000;
          }
        }

        // TODO: potentially need to LOWORD(v19[1])
        newShaderID |= v19[1] | (v19[0] * 16);

        // Override shaderID
        batchData.runtimeShaderID = newShaderID;
      }
    });
  }

  sub837680() {
    let nonLayeredBatchCount = 0;

    this.skinData.batches.forEach((batchData) => {
      if (batchData.layer <= 0) {
        nonLayeredBatchCount++;
      }
    });

    // If no batches are layered, there's nothing to do.
    if (nonLayeredBatchCount === this.skinData.batches.length) {
      return;
    }

    // Resolve texture and UV animation lookups to indices.
    this.sub835E90();

    let v31 = [0, 0];
    let v33 = 0;

    let sharedMaterials = false;

    let currentLayer = null;
    let firstLayer = null;
    let currentBatch = null;
    let previousBatch = null;
    let currentMaterial = null;
    let firstMaterial = null;
    let currentTextureMapping = null;
    let nextTextureMapping = null;

    // Do a bunch of shader, texture index, and UV animation index manipulations based on blending
    // modes, layering, etc.
    this.skinData.batches.forEach((batchData) => {
      currentLayer = batchData;
      currentBatch = batchData;

      // If the material hasn't changed from the last batch, iterate. We'll copy over the relevant
      // data from the previous batch after this loop.
      if (previousBatch && currentBatch.materialIndex === previousBatch.materialIndex) {
        sharedMaterials = true;
        return;
      }

      previousBatch = batchData;

      currentTextureMapping = this.data.textureMappings[currentLayer.textureMappingIndex];
      nextTextureMapping = this.data.textureMappings[currentLayer.textureMappingIndex + 1];

      const v26 = currentLayer.runtimeShaderID & 0x07;
      currentMaterial = this.data.materials[currentLayer.materialIndex];

      // First layer, do a few resets.
      if (currentLayer.layer === 0) {
        v31 = [0, 0];

        if (currentLayer.runtimeOpCount >= 1 && currentMaterial.blendingMode === 0) {
          currentLayer.runtimeShaderID &= 0xFF8F;
        }

        firstLayer = currentLayer;
      }

      firstMaterial = this.data.materials[firstLayer.materialIndex];

      const firstLayerTransparencyIndex = this.data.transparencyAnimationLookups[firstLayer.transparencyAnimationLookup];
      const currentLayerTransparencyIndex = this.data.transparencyAnimationLookups[currentLayer.transparencyAnimationLookup];

      let skip1 = false;

      if (v31[0] !== 0) {
        if (v31[0] === 1) {
          if (
            (currentMaterial.blendingMode === 2 || currentMaterial.blendingMode === 1)
            && currentLayer.runtimeOpCount === 1
            && !(((currentMaterial.renderFlags & 0xFF) ^ (firstMaterial.renderFlags & 0xFF)) & 0x01)
            && (currentLayer.textureIndices[0] === firstLayer.textureIndices[0])
          ) {
            if (firstLayerTransparencyIndex === currentLayerTransparencyIndex) {
              currentLayer.runtimeShaderID = 0x8000;
              firstLayer.runtimeShaderID = 0x8001;

              v31[0] = 3;

              return;
            }
          }

          v31[0] = 0;
        } else {
          // Workaround for GOTO LABEL_34
          skip1 = true;
        }
      }

      // Workaround for GOTO LABEL_34
      if (!skip1) {
        if (currentMaterial.blendingMode === 0 && currentLayer.runtimeOpCount === 2 && (v26 === 4 || v26 === 6)) {
          if (currentTextureMapping === 0 && nextTextureMapping === -1) {
            v31[0] = 1;
          }
        }
      }

      if (v31[1] !== 0) {
        if (v31[1] === 1) {
          if (
            (currentMaterial.blendingMode !== 4 && currentMaterial.blendingMode !== 6)
            || currentLayer.runtimeOpCount !== 1
            || (currentTextureMapping >= 0 && currentTextureMapping <= 2)
          ) {
            v31[1] = 0;
          } else {
            // If transparencies match, override the textures, UV animations, op count, and shader
            // ID.
            if (firstLayerTransparencyIndex === currentLayerTransparencyIndex) {
              v31[1] = 2;

              v33 = 1;

              currentLayer.runtimeShaderID = 0x8000;

              if (currentMaterial.blendingMode !== 4) {
                firstLayer.runtimeShaderID = 0xE;
              } else {
                firstLayer.runtimeShaderID = 0x8002;
              }

              firstLayer.runtimeOpCount = 2;

              // Override texture indices
              const firstLayerTextureIndices = [];
              firstLayerTextureIndices[0] = firstLayer.textureIndices[0];
              firstLayerTextureIndices[1] = currentLayer.textureIndices[0];
              firstLayer.textureIndices = firstLayerTextureIndices;

              // Override UV animation indices
              const firstLayerUVAnimationIndices = [];
              firstLayerUVAnimationIndices[0] = firstLayer.uvAnimationIndices[0];
              firstLayerUVAnimationIndices[1] = currentLayer.uvAnimationIndices[0];
              firstLayer.uvAnimationIndices = firstLayerUVAnimationIndices;

              // Iterate to next batch / layer
              return;
            }
          }
        } else {
          if (v31[1] !== 2) {
            // Iterate to next batch / layer
            return;
          }

          if (
            (currentMaterial.blendingMode !== 2 && currentMaterial.blendingMode !== 1)
            || currentLayer.runtimeOpCount !== 1
            || (((currentMaterial.renderFlags & 0xFF) ^ (firstMaterial.renderFlags & 0xFF)) & 0x01)
            || (firstLayer.textureIndices[0] !== currentLayer.textureIndices[0])
          ) {
            v31[1] = 0;
          } else {
            if (firstLayerTransparencyIndex === currentLayerTransparencyIndex) {
              v31[1] = 3;

              currentLayer.runtimeShaderID = 0x8000;

              // TODO: What's supposed to happen to negative values?
              firstLayer.runtimeShaderID = (2 * (firstLayer.runtimeShaderID === 0x8002 ? 1 : 0)) - 0x7FFF;

              // Iterate to next batch / layer
              return;
            }
          }
        }
      }

      if (currentMaterial.blendingMode === 0 && currentLayer.runtimeOpCount === 1 && currentTextureMapping === 0) {
        v31[1] = 1;
      }
    });

    if (v33 !== 0) {
      // TODO: Implement sub_837250
    }

    // TODO: Implement sub_8374A0 (LABEL_59)

    if (sharedMaterials) {
      currentBatch = null;
      previousBatch = null;

      this.skinData.batches.forEach((batchData) => {
        currentBatch = batchData;

        if (previousBatch !== null && currentBatch.materialIndex === previousBatch.materialIndex) {
          currentBatch.runtimeShaderID = previousBatch.runtimeShaderID;
          currentBatch.runtimeOpCount = previousBatch.runtimeOpCount;
          currentBatch.textureIndices = previousBatch.textureIndices;
          currentBatch.uvAnimationIndices = previousBatch.uvAnimationIndices;
        } else {
          previousBatch = currentBatch;
        }
      });
    }
  }

  // Convert texture lookups and UV animation lookups into texture indices and UV animation
  // indices. Seems to be capped at opCount == 2 in WotLK.
  sub835E90() {
    this.skinData.batches.forEach((batchData) => {
      const textureIndices = [];
      const uvAnimationIndices = [];

      for (let opIndex = 0; opIndex < batchData.runtimeOpCount; opIndex++) {
        const opTextureIndex = this.data.textureLookups[batchData.textureLookup + opIndex];
        const opUVAnimationIndex = this.data.uvAnimationLookups[batchData.uvAnimationLookup + opIndex];

        textureIndices[opIndex] = opTextureIndex;
        uvAnimationIndices[opIndex] = opUVAnimationIndex;
      }

      batchData.textureIndices = textureIndices;
      batchData.uvAnimationIndices = uvAnimationIndices;
    });
  }

  lookupShaderNames(shaderID, opCount, textureMapping) {
    let names = null;

    const tableLookup = !(shaderID & 0x8000);

    if (tableLookup) {
      names = this.shaderNamesFromTable(shaderID, opCount, textureMapping);

      if (!names) {
        names = this.shaderNamesFromTable(0x11, opCount, textureMapping);
      }
    } else {
      names = this.shaderNamesFromOther(shaderID);
    }

    return names;
  }

  shaderNamesFromOther(shaderID) {
    let names = null;

    switch (shaderID & 0x7FFF) {
      case 0:
        return null;

      case 1:
        names = {
          vertex: 'Diffuse_T1_Env',
          fragment: 'Combiners_Opaque_Mod2xNA_Alpha'
        };
        break;

      case 2:
        names = {
          vertex: 'Diffuse_T1_Env',
          fragment: 'Combiners_Opaque_AddAlpha'
        };
        break;

      case 3:
        names = {
          vertex: 'Diffuse_T1_Env',
          fragment: 'Combiners_Opaque_AddAlpha_Alpha'
        };
        break;

      default:
        break;
    }

    // TODO: Implement sub_876530 logic (which can throw back to the table based lookup)

    return names;
  }

  shaderNamesFromTable(shaderID, opCount, textureMapping) {
    let names = null;

    if (opCount === 1) {
      names = this.shaderNamesFromSingleOpTable(shaderID, textureMapping);
    } else {
      names = this.shaderNamesFromMultiOpTable(shaderID, textureMapping);
    }

    return names;
  }

  shaderNamesFromSingleOpTable(shaderID, textureMapping) {
    let names = null;
    let vertexName = null;
    let fragmentName = null;

    const t1FragmentMode = (shaderID >> 4) & 7;
    const t1EnvMapped = (shaderID >> 4) & 8;

    if (t1EnvMapped) {
      vertexName = 'Diffuse_Env';
    } else {
      if (textureMapping === 0) {
        vertexName = 'Diffuse_T1';
      } else {
        vertexName = 'Diffuse_T2';
      }
    }

    switch (t1FragmentMode) {
      case 0:
        fragmentName = 'Combiners_Opaque';
        break;

      case 1:
        fragmentName = 'Combiners_Mod';
        break;

      case 2:
        fragmentName = 'Combiners_Decal';
        break;

      case 3:
        fragmentName = 'Combiners_Add';
        break;

      case 4:
        fragmentName = 'Combiners_Mod2x';
        break;

      case 5:
        fragmentName = 'Combiners_Fade';
        break;

      default:
        fragmentName = 'Combiners_Mod';
        break;
    }

    names = {
      vertex: vertexName,
      fragment: fragmentName
    };

    return names;
  }

  shaderNamesFromMultiOpTable(shaderID, _textureMapping) {
    let names = null;
    let vertexName = null;
    let fragmentName = null;

    const t1FragmentMode = (shaderID >> 4) & 7;
    const t2FragmentMode = shaderID & 7;
    const t1EnvMapped = (shaderID >> 4) & 8;
    const t2EnvMapped = shaderID & 8;

    if (t1EnvMapped && t2EnvMapped) {
      vertexName = 'Diffuse_Env_Env';
    } else if (t1EnvMapped) {
      vertexName = 'Diffuse_Env_T2';
    } else if (t2EnvMapped) {
      vertexName = 'Diffuse_T1_Env';
    } else {
      vertexName = 'Diffuse_T1_T2';
    }

    if (t1FragmentMode === 0) {
      switch (t2FragmentMode) {
        case 0:
          fragmentName = 'Combiners_Opaque_Opaque';
          break;

        case 1:
          fragmentName = 'Combiners_Opaque_Mod';
          break;

        case 3:
          fragmentName = 'Combiners_Opaque_Add';
          break;

        case 4:
          fragmentName = 'Combiners_Opaque_Mod2x';
          break;

        case 6:
          fragmentName = 'Combiners_Opaque_Mod2xNA';
          break;

        case 7:
          fragmentName = 'Combiners_Opaque_AddNA';
          break;

        default:
          fragmentName = 'Combiners_Opaque_Mod';
          break;
      }
    } else if (t1FragmentMode === 1) {
      switch (t2FragmentMode) {
        case 0:
          fragmentName = 'Combiners_Mod_Opaque';
          break;

        case 3:
          fragmentName = 'Combiners_Mod_Add';
          break;

        case 4:
          fragmentName = 'Combiners_Mod_Mod2x';
          break;

        case 6:
          fragmentName = 'Combiners_Mod_Mod2xNA';
          break;

        case 7:
          fragmentName = 'Combiners_Mod_AddNA';
          break;

        default:
          fragmentName = 'Combiners_Mod_Mod';
          break;
      }
    } else if (t1FragmentMode === 3 && t2FragmentMode === 1) {
      fragmentName = 'Combiners_Add_Mod';
    } else if (t1FragmentMode === 4 && t2FragmentMode === 4) {
      fragmentName = 'Combiners_Mod2x_Mod2x';
    } else {
      return null;
    }

    names = {
      vertex: vertexName,
      fragment: fragmentName
    };

    return names;
  }
}

export default BatchManager;
