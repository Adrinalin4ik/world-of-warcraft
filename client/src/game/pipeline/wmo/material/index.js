import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';
// import fragmentShader from './shaders/fragment/main.glsl';
// import vertexShader from './shaders/vertex/main.glsl';


class WMOMaterial extends THREE.ShaderMaterial {

  constructor(def) {
    super();
    this.def = def;
    this.textures = [];
    console.log(def)
    this.uniforms = {
      BATCH_TYPE: { value: def.batchType },
      textures: { type: 'tv', value: [] },
      textureCount: { type: 'i', value: 0 },
      blendingMode: { type: 'i', value: def.blendingMode },

      useBaseColor: { type: 'i', value: 0 },
      baseColor: { type: 'c', value: new THREE.Color(0, 0, 0) },
      baseAlpha: { type: 'f', value: 0.0 },

      indoor: { type: 'i', value: 0 },

      // Managed by light manager
      lightModifier: { type: 'f', value: 1.0 },
      ambientLight: { type: 'c', value: new THREE.Color(0.5, 0.5, 0.5) },
      diffuseLight: { type: 'c', value: new THREE.Color(0.25, 0.5, 1.0) },

      // Managed by light manager
      fogModifier: { type: 'f', value: 1.0 },
      fogColor: { type: 'c', value: new THREE.Color(0.25, 0.5, 1.0) },
      fogStart: { type: 'f', value: 5.0 },
      fogEnd: { type: 'f', value: 400.0 }
    };

    if (def.useBaseColor) {
      const baseColor = new THREE.Color(
        def.baseColor.r / 255.0,
        def.baseColor.g / 255.0,
        def.baseColor.b / 255.0
      );

      const baseAlpha = def.baseColor.a / 255.0;

      this.uniforms.useBaseColor = { type: 'i', value: 1 };
      this.uniforms.baseColor = { type: 'c', value: baseColor };
      this.uniforms.baseAlpha = { type: 'f', value: baseAlpha };
    }

    // Tag lighting mode (based on group flags)
    if (def.indoor) {
      this.uniforms.indoor = { type: 'i', value: 1 };
    }

    // Flag 0x01 (unlit)
    // TODO: This is really only unlit at night. Needs to integrate with the light manager in
    // some fashion.
    if (def.flags & 0x10) {
      this.uniforms.lightModifier = { type: 'f', value: 0.0 };
    }

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
        const texture = TextureLoader.load(textureDef.path, this.wrapping, this.wrapping, false);
        textures.push(texture);
      }
    });

    this.textures = textures;

    // Update shader uniforms to reflect loaded textures.
    this.uniforms.textures = { type: 'tv', value: textures };
    this.uniforms.textureCount = { type: 'i', value: textures.length };
    // const texture1_color = textureDefs[0].textureData.color;
    // this.uniforms.baseColor = { type: 'c', value: new THREE.Color(texture1_color.r, texture1_color.g, texture1_color.b) }
    // const color = textureDefs[0].textureData.color;
    
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
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture);
    });
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