import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
// import fragmentShader from './shader.frag';
// import vertexShader from './shader.vert';
import fragmentShader from './shaders/fragment/main.glsl';
import vertexShader from './shaders/vertex/main.glsl';
import { decodeMaterialLighting } from './laws';


class WMOMaterial extends THREE.ShaderMaterial {

  constructor(def, groupData) {
    super();
    this.def = def;
    this.interior = def.interior || groupData.interior;
    this.textures = [];
    this.mapLight = null;

    this.uniforms = {
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      materialParams: { value: [1,1,1,1] },

      // Declared unconditionally: a uniform the shader reads but nobody supplies reads as ZERO,
      // which under the fragment law means "unlit". Only F_UNLIT materials should be 0.
      lightModifier: { value: 1.0 },
    };

    // Enable lighting.
    // Both were pinned to 0, which made the vertex shader take its unlit branch (light = 1.0) and
    // substitute a flat 0.5 grey for the vertex color, so WMOs ignored the map light entirely -- no
    // sun, no time of day, no baked interior shading. Every WMO geometry supplies both `normal` and
    // `acolor`, so there is data behind both paths.
    this.defines.USE_LIGHTING = 1;
    this.defines.USE_VERTEX_COLOR = 1;
    
    // Lighting takes the reference's 0x48 class; `this.interior` above stays the culling question.
    this.lightingInterior = groupData.lightingInterior === undefined
      ? this.interior
      : groupData.lightingInterior;

    if (this.lightingInterior) {
      this.defines.INTERIOR = 1;
    }

    // Define blending mode
    this.defines.BLENDING_MODE = def.blendingMode;
    this.defines.BATCH_TYPE = def.batchType;

    // Flag decode lives in laws.ts. Note this corrects a swap: the old code tested 0x10 (SIDN) as
    // though it were UNLIT, so it unlit exactly the materials that should glow at night.
    //
    // `def.sidnColor` comes from Task 7 -- MOMT slot 1's colour word, carried on the definition
    // directly. Do NOT read it off `def.textures[0]`: that list holds only the slots whose texture
    // path RESOLVED, so its index 0 is not reliably MOMT slot 0.
    //
    // Kept on the instance because Task 5 reads `sidnColor` and `window` off it, and because a
    // material's decoded lighting is worth inspecting from a breakpoint.
    this.lighting = decodeMaterialLighting(def.flags, def.sidnColor);
    const lighting = this.lighting;

    if (lighting.unlit) {
      this.uniforms.lightModifier.value = 0.0;
    }

    // Tag lighting mode (based on group flags)
    this.uniforms.interior = { type: 'i', value: this.interior ? 1 : 0 };

    // Transparent blending
    if (def.blendingMode === 1) {
      this.transparent = true;
      this.side = THREE.DoubleSide;
    }

    // Flag 0x04: no backface culling
    if (def.flags & 0x04) {
      this.side = THREE.DoubleSide;
    }

    // Flag 0x40: clamp to edge
    if (def.flags & 0x40) {
      this.wrapping = THREE.ClampToEdgeWrapping;
    } else {
      this.wrapping = THREE.RepeatWrapping;
    }

    switch(def.blendingMode) {
      case 0: // GxBlend_Opaque
      case 1: // GxBlend_AlphaKey
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.OneFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;
      case 2: // GxBlend_Alpha
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.SrcAlphaFactor;
        this.blendDst = THREE.OneMinusSrcAlphaFactor;
        this.blendSrcAlpha = THREE.OneFactor;
        this.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        break;
      case 3: // GxBlend_Add
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.SrcAlphaFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.ZeroFactor;
        this.blendDstAlpha = THREE.OneFactor;
        break;
      case 4: // GxBlend_Mod
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.DstColorFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.DstAlphaFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;
      case 5: // GxBlend_Mod2x
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.DstColorFactor;
        this.blendDst = THREE.SrcColorFactor;
        this.blendSrcAlpha = THREE.DstAlphaFactor;
        this.blendDstAlpha = THREE.SrcAlphaFactor;
        break;
      case 6: // GxBlend_ModAdd
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.DstColorFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.DstAlphaFactor;
        this.blendDstAlpha = THREE.OneFactor;
        break;
      case 7: // GxBlend_InvSrcAlphaAdd
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneMinusSrcAlphaFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.OneMinusSrcAlphaFactor;
        this.blendDstAlpha = THREE.OneFactor;
        break;
      case 8: // GxBlend_InvSrcAlphaAdd
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneMinusSrcAlphaFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.OneMinusSrcAlphaFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;
      case 9: // GxBlend_SrcAlphaOpaque
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.SrcAlphaFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.SrcAlphaFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;
      case 10: // GxBlend_NoAlphaAdd
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.ZeroFactor;
        this.blendDstAlpha = THREE.OneFactor;
        break;
      case 11: // GxBlend_ConstantAlpha
        break;
      case 12: // GxBlend_Screen
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneMinusDstColorFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.OneFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;
      case 13: // GxBlend_BlendAdd
        this.blending = THREE.CustomBlending;  
        this.blendEquation = THREE.AddEquation;
        this.blendSrc = THREE.OneFactor;
        this.blendDst = THREE.OneMinusSrcAlphaFactor;
        this.blendSrcAlpha = THREE.OneFactor;
        this.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        break;
    }


    if (this.def.blendingMode != 0) {
      let alphaTestVal = 0.878431;
      if ((this.def.flags & 0x80) > 0) {
        alphaTestVal = 0.2999999;
      }
      if ((this.def.flags & 0x01) > 0) {
        // alphaTestVal = 0.1; //TODO: confirm this
      }

      this.uniforms.alphaTestValue = { value: alphaTestVal };
    } else {
      this.uniforms.alphaTestValue = { value: -1.0 };
    }

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.loadTextures(def.textures);
  }

  // TODO: Handle texture flags and color.
  loadTextures(textureDefs) {
    // if (this.def.index != 6) return; // black
    // if (this.def.index != 15) return;
    const textures = [];
    textureDefs.forEach((textureDef) => {
      if (textureDef !== null) {
        // Slots are claimed in order and filled in place, so TEXTURE_COUNT and the uniform array
        // are correct immediately even though each texture is still being fetched and decoded.
        const index = textures.length;
        textures.push(TextureLoader.PLACEHOLDER);

        TextureLoader.load(textureDef.path, this.wrapping, this.wrapping)
          .then((texture) => {
            textures[index] = texture;
          })
          .catch((error) => {
            console.error(`Failed to load WMO texture ${textureDef.path}:`, error);
          });
      }
    });

    this.textures = textures;

    // Update shader uniforms to reflect loaded textures.
    this.defines.TEXTURE_COUNT = textures.length;
    this.uniforms.textures = { type: 'tv', value: textures };
    this.uniforms.textureCount = { type: 'i', value: textures.length };
    // const texture1_color = textureDefs[0].textureData.color;
    // this.uniforms.baseColor = { type: 'c', value: new THREE.Color(texture1_color.r, texture1_color.g, texture1_color.b) }
    const color = textureDefs[0].textureData.color;
    this.uniforms.emissiveColor = new THREE.Uniform(new Float32Array([color.r, color.g, color.b, color.a]));
    
    // if (this.def.blendingMode != 0) {
    //   let alphaTestVal = 0.878431;
    //   if ((this.def.flags & 0x80) > 0) {
    //     alphaTestVal = 0.2999999;
    //   }
    //   if ((this.def.flags & 0x01) > 0) {
    //     // alphaTestVal = 0.1; //TODO: confirm this
    //   }

    //   this.uniforms.alphaTestValue = { value: alphaTestVal };
    // } else {
    //   this.uniforms.alphaTestValue = { value: -1.0 };
    // }

    // this.uniforms.alphaTest = { value: [color.r, color.g, color.b, color.a]}
    this.needsUpdate = true;
  }

  unloadTextures() {
    // Unload textures in the loader
    for (const texture of this.textures) {
      TextureLoader.unload(texture);
    }

    // Clear array
    this.textures.splice(0);

    // Update texture count
    this.defines.TEXTURE_COUNT = 0;

    // Ensure changes propagate to renderer
    this.needsUpdate = true;
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight) {
    this.mapLight = mapLight;
    this.updateLightUniforms();
  }

  /**
   * Update light uniforms from the map light system
   */
  updateLightUniforms() {
    if (this.mapLight) {
      // Matches AdtMaterial: MapLight exposes `uniforms`, not a getUniforms() method, and it carries
      // the sun direction as `sunDir` rather than `sunParams`. This previously read the older shape,
      // which threw as soon as a WMO material was actually handed a MapLight.
      const uniforms = this.mapLight.uniforms;
      this.uniforms.fogParams.value.copy(uniforms.fogParams.value);
      this.uniforms.fogColor.value.copy(uniforms.fogColor.value);
      // World-space sun direction: `uniforms.sunDir` carries the view-space variant, which rotates
      // with the camera and would make lighting depend on where you are looking.
      this.uniforms.sunParams.value.copy(this.mapLight.sunDir);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);
    }
  }

  dispose() {
    super.dispose();
    this.unloadTextures();
  }
}

export default WMOMaterial;

// import * as THREE from 'three';

// import TextureLoader from '../../texture-loader';
// import fragmentShader from './shaders/fragment/main.glsl';
// import vertexShader from './shaders/vertex/main.glsl';

// class WMOMaterial extends THREE.ShaderMaterial {

//   constructor(def) {
//     super();

//     this.key = def.key;

//     this.loadTextures(def.textures);

//     this.uniforms = {
//       textures: { type: 'tv', value: this.textures },

//       // Light Params: [dir.x, dir.y, dir.z, modifier]
//       lightParams: { type: '4fv', value: new Float32Array([-1.0, -1.0, -1.0, 1.0]) },
//       ambientColor: { type: '3fv', value: new Float32Array([0.5, 0.5, 0.5]) },
//       diffuseColor: { type: '3fv', value: new Float32Array([0.25, 0.5, 1.0]) },

//       // Fog Params: [start, end, modifier]
//       fogParams: { type: '3fv', value: new Float32Array([5.0, 400.0, 1.0]) },
//       fogColor: { type: '3fv', value: new Float32Array([0.25, 0.5, 1.0]) }
//     };

//     // Enable lighting
//     this.defines.USE_LIGHTING = 0;
//     this.defines.USE_VERTEX_COLOR = 0;

//     // Define interior
//     if (def.interior) {
//       this.defines.INTERIOR = 1;
//     }

//     // Define blending mode
//     this.defines.BLENDING_MODE = def.blendingMode;

//     // Define batch type
//     this.defines.BATCH_TYPE = def.batchType;

//     // Flag 0x10: unlit
//     // TODO: This is potentially only unlit at night.
//     if (def.flags & 0x10) {
//       this.uniforms.lightParams.value[3] = 0.0;
//     }

//     // Transparent blending
//     if (def.blendingMode === 1) {
//       this.transparent = true;
//       this.side = THREE.DoubleSide;
//     }

//     // Flag 0x04: no backface culling
//     if (def.flags & 0x04) {
//       this.side = THREE.DoubleSide;
//     }

//     // Flag 0x40: clamp to edge
//     if (def.flags & 0x40) {
//       this.wrapping = THREE.ClampToEdgeWrapping;
//     } else {
//       this.wrapping = THREE.RepeatWrapping;
//     }

//     this.vertexShader = vertexShader;
//     this.fragmentShader = fragmentShader;
//   }

//   // TODO: Handle texture flags and color.
//   loadTextures(defs) {
//     const textures = this.textures = this.textures || [];

//     // Ensure any existing textures are unloaded in the event we're changing to new textures.
//     this.unloadTextures();

//     for (let index = 0, textureCount = defs.length; index < textureCount; ++index) {
//       const def = defs[index];

//       if (def) {
//         const texture = TextureLoader.load(def.path, this.wrapping, this.wrapping, false);
//         textures.push(texture);
//       }
//     }

//     // Update texture count
//     this.defines.TEXTURE_COUNT = textures.length;

//     // Ensure changes propagate to renderer
//     this.needsUpdate = true;
//   }

//   unloadTextures() {
//     // Unload textures in the loader
//     for (const texture of this.textures) {
//       TextureLoader.unload(texture);
//     }

//     // Clear array
//     this.textures.splice(0);

//     // Update texture count
//     this.defines.TEXTURE_COUNT = 0;

//     // Ensure changes propagate to renderer
//     this.needsUpdate = true;
//   }

//   dispose() {
//     super.dispose();
//     this.unloadTextures();
//   }
// }

// export default WMOMaterial;