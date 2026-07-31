import * as THREE from 'three';

import M2 from '..';
import MapLight from '../../../world/light/MapLight';
import TextureLoader from '../../texture-loader';

// Shader sources are assembled HERE, in JS, rather than with `#pragma glslify: import(...)`.
//
// glslify-import is a source TRANSFORM: it reads the target with `fs` and splices the text in, so the
// spliced files never enter glslify's dependency tree and glslify-loader never calls addDependency for
// them. Webpack therefore does not watch them, and edits to a common chunk do NOT invalidate the
// variant that imports it -- a running dev server keeps serving the stale compiled shader.
//
// That defect silently discarded most of plan 2's WMO shader work. Do not "tidy" this back into
// pragmas.
import fragmentCommonHeader from './fragment/common-header.glsl';
import vertexCommonHeader from './vertex/common-header.glsl';
import vertexCommonMain from './vertex/common-main.glsl';

import vertexDiffuseT1 from './vertex/diffuse-t1.glsl';
import vertexDiffuseEnv from './vertex/diffuse-env.glsl';
import vertexDiffuseT1T2 from './vertex/diffuse-t1-t2.glsl';
import vertexDiffuseT1Env from './vertex/diffuse-t1-env.glsl';
import vertexDiffuseEnvEnv from './vertex/diffuse-env-env.glsl';
import vertexDiscard from './vertex/discard.glsl';

import fragmentCombinersOpaque from './fragment/combiners-opaque.glsl';
import fragmentCombinersMod from './fragment/combiners-mod.glsl';
import fragmentCombinersOpaqueOpaque from './fragment/combiners-opaque-opaque.glsl';
import fragmentCombinersOpaqueAdd from './fragment/combiners-opaque-add.glsl';
import fragmentCombinersOpaqueAddNA from './fragment/combiners-opaque-addna.glsl';
import fragmentCombinersOpaqueAddAlpha from './fragment/combiners-opaque-addalpha.glsl';
import fragmentCombinersOpaqueAddAlphaAlpha from './fragment/combiners-opaque-addalpha-alpha.glsl';
import fragmentCombinersOpaqueMod from './fragment/combiners-opaque-mod.glsl';
import fragmentCombinersOpaqueMod2x from './fragment/combiners-opaque-mod2x.glsl';
import fragmentCombinersOpaqueMod2xNA from './fragment/combiners-opaque-mod2xna.glsl';
import fragmentCombinersOpaqueMod2xNAAlpha from './fragment/combiners-opaque-mod2xna-alpha.glsl';
import fragmentCombinersModOpaque from './fragment/combiners-mod-opaque.glsl';
import fragmentCombinersModMod from './fragment/combiners-mod-mod.glsl';
import fragmentCombinersModMod2x from './fragment/combiners-mod-mod2x.glsl';
import fragmentDiscard from './fragment/discard.glsl';

/** Prepend the shared fragment header to a combiner variant. */
const assembleFragment = (body: string) => `${fragmentCommonHeader}\n${body}`;

/**
 * Assemble a vertex variant: prepend the shared header, and splice the shared main-body chunk in at
 * the variant's `// GLSLIFY_COMMON_MAIN` marker (it has to sit INSIDE main(), because it declares
 * locals -- `mvPosition`, `transformed`, `skinned` -- that the rest of main() uses).
 */
const assembleVertex = (body: string) => {
  if (!body.includes('// GLSLIFY_COMMON_MAIN')) {
    throw new Error('M2 vertex shader variant is missing its // GLSLIFY_COMMON_MAIN marker');
  }

  return `${vertexCommonHeader}\n${body.replace('// GLSLIFY_COMMON_MAIN', vertexCommonMain)}`;
};

class M2Material extends THREE.ShaderMaterial {

  private mapLight: MapLight | null = null;

  static VERTEX_SHADERS = {
    'Diffuse_T1': assembleVertex(vertexDiffuseT1),
    'Diffuse_Env': assembleVertex(vertexDiffuseEnv),
    'Diffuse_T1_T2': assembleVertex(vertexDiffuseT1T2),
    'Diffuse_T1_Env': assembleVertex(vertexDiffuseT1Env),
    'Diffuse_Env_Env': assembleVertex(vertexDiffuseEnvEnv),
    'Discard': vertexDiscard
  };

  static FRAGMENT_SHADERS = {
    'Combiners_Opaque': assembleFragment(fragmentCombinersOpaque),
    'Combiners_Mod': assembleFragment(fragmentCombinersMod),
    'Combiners_Opaque_Opaque': assembleFragment(fragmentCombinersOpaqueOpaque),
    'Combiners_Opaque_Add': assembleFragment(fragmentCombinersOpaqueAdd),
    'Combiners_Opaque_AddNA': assembleFragment(fragmentCombinersOpaqueAddNA),
    'Combiners_Opaque_AddAlpha': assembleFragment(fragmentCombinersOpaqueAddAlpha),
    'Combiners_Opaque_AddAlpha_Alpha': assembleFragment(fragmentCombinersOpaqueAddAlphaAlpha),
    'Combiners_Opaque_Mod': assembleFragment(fragmentCombinersOpaqueMod),
    'Combiners_Opaque_Mod2x': assembleFragment(fragmentCombinersOpaqueMod2x),
    'Combiners_Opaque_Mod2xNA': assembleFragment(fragmentCombinersOpaqueMod2xNA),
    'Combiners_Opaque_Mod2xNA_Alpha': assembleFragment(fragmentCombinersOpaqueMod2xNAAlpha),
    'Combiners_Mod_Opaque': assembleFragment(fragmentCombinersModOpaque),
    'Combiners_Mod_Mod': assembleFragment(fragmentCombinersModMod),
    'Combiners_Mod_Mod2x': assembleFragment(fragmentCombinersModMod2x),
    'Discard': fragmentDiscard
    /*
    'Combiners_Mod':              'frag/mod.frag',
    'Combiners_Decal':            'frag/decal.frag',
    'Combiners_Add':              'frag/add.frag',
    'Combiners_Mod2x':            'frag/mod2x.frag',
    'Combiners_Fade':             'frag/fade.frag',
    'Combiners_Opaque_Opaque':    'frag/opaque-opaque.frag',
    'Combiners_Opaque_Mod':       'frag/opaque-mod.frag',
    'Combiners_Opaque_Add':       '',
    'Combiners_Opaque_Mod2x':     9,
    'Combiners_Opaque_Mod2xNA':   10,
    'Combiners_Opaque_AddNA':     11,
    'Combiners_Mod_Opaque':       12,
    'Combiners_Mod_Mod':          13
    'Combiners_Mod_Add':          14,
    'Combiners_Mod_Mod2x':        15,
    'Combiners_Mod_Mod2xNA':      16,
    'Combiners_Mod_AddNA':        17,
    'Combiners_Add_Mod':          18,
    'Combiners_Mod2x_Mod2x':      19
    */
  };

  m2: M2;
  eventListeners = [];
  layer;
  skins = {
    skin1: null,
    skin2: null,
    skin3: null,
  };
  textures = [];
  textureDefs;
  shaderNames = {
    vertex: null,
    fragment: null,
  };
  constructor(m2, def) {
    super();
    // if (def.useSkinning) {
    //   super({ skinning: true });
    // } else {
    //   super({ skinning: false });
    // }

    this.m2 = m2;

    this.eventListeners = [];

    this.layer = def.layer;

    this.uniforms = {
      textureCount: { value: 0 },
      textures: { value: [] },

      billboarded: { value: 0.0 },

      // Animated vertex colors
      animatedVertexColorRGB: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      animatedVertexColorAlpha: { value: 1.0 },

      // Animated transparency
      animatedTransparency: { value: 1.0 },

      // Animated texture coordinate transform matrices
      animatedUVs: {
        value: [
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4()
        ]
      },

      // WMO point lights (MOLT) affecting this model, in world space. Assigned by the WMO that owns
      // the doodad; models outside a WMO keep a count of zero and skip the loop entirely.
      wmoLightCount: { value: 0 },
      wmoLightPosition: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      wmoLightColor: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },

      // Managed by light manager
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },

      // The interior fog triple (MapLight's resolved camera-in-WMO-room haze), pulled the same way
      // the WMO material does. Only consumed when `interiorFog` (below) is set for this draw --
      // defaults here just keep the material sane before the first `updateLightUniforms()` call.
      wmoFogParams: { value: new THREE.Vector4(1.0 / 577.0, 577.0, 1.0, 1.0) },
      wmoFogColor: { value: new THREE.Color(0.25, 0.5, 0.8) },

      // Cleared by render flag 0x02 (unfogged). Declared here so fogged materials -- the majority --
      // have it set: applyRenderFlags only ever assigned it for the unfogged case, and a uniform the
      // shader declares but nobody supplies reads as zero, which would have unfogged everything.
      fogModifier: { value: 1.0 },

      materialParams: { value: [1,1,1,1] },

      // The per-object block (per-object-light.ts). Declared with safe defaults: a uniform the shader
      // reads but nobody supplies reads as zero, and for `sunIntensity` that would flatten the sun.
      sunIntensity: { value: 1.0 },
      interiorProbe: { value: 0 },
      // Per-object, pushed by per-object-light.ts alongside interiorProbe -- but a SEPARATE question
      // from it (see PerObjectLighting.interiorFog). Selects the interior fog triple above instead of
      // the scene triple in applyFog.
      interiorFog: { value: 0 },
      // A flat Float32Array of 7 vec4s. See per-object-light.ts for why this is not Vector4[].
      probeCoeffs: { value: new Float32Array(28) },
    };

    this.defines.MAX_BONES = 200;
    this.defines.USE_LIGHTING = 1;
    
    this.applyRenderFlags(def.renderFlags);
    this.applyBlendingMode(def.blendingMode);

    this.assignShaders(def.shaderNames);

    // Loaded by calling updateSkinTextures()

    this.textureDefs = def.textures;
    this.loadTextures();

    this.registerAnimations(def);
  }

  enableBillboarding() {
    // TODO: Make billboarding happen in the vertex shader.
    this.uniforms.billboarded = { value: '1.0' };

    // TODO: Shouldn't this be FrontSide? Billboarding logic currently seems to flips the mesh
    // backward.
    this.side = THREE.DoubleSide;
  }

  applyRenderFlags(renderFlags) {
    // Flag 0x01 (unlit)
    if (renderFlags & 0x01) {
      this.uniforms.lightModifier = { value: '0.0' };
    }

    // Flag 0x02 (unfogged). Numeric, not the string '0.0' this used to assign -- and the shader now
    // actually reads it. Torch flames and glow billboards carry this flag, and ignoring it is what let
    // fog tint them.
    if (renderFlags & 0x02) {
      this.uniforms.fogModifier.value = 0.0;
    }

    // Flag 0x04 (no backface culling)
    if (renderFlags & 0x04) {
      this.side = THREE.DoubleSide;
      this.transparent = true;
    }

    // Flag 0x10 (no z-buffer write)
    if (renderFlags & 0x10) {
      this.depthWrite = false;
    }
  }

  applyBlendingMode(blendingMode) {
    this.defines.BLENDING_MODE = blendingMode;

    if (blendingMode === 1) {
      this.uniforms.alphaKey = { value: 1.0 };
    } else {
      this.uniforms.alphaKey = { value: 0.0 };
    }

    if (blendingMode >= 1) {
      this.transparent = true;
      this.blending = THREE.CustomBlending;
    }

    switch (blendingMode) {
      case 0:
        this.blending = THREE.NoBlending;
        this.blendSrc = THREE.OneFactor;
        this.blendDst = THREE.ZeroFactor;
        break;

      case 1:
        this.alphaTest = 0.5;
        this.side = THREE.DoubleSide;

        this.blendSrc = THREE.OneFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.OneFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;

      case 2:
        this.blendSrc = THREE.SrcAlphaFactor;
        this.blendDst = THREE.OneMinusSrcAlphaFactor;
        this.blendSrcAlpha = THREE.SrcAlphaFactor;
        this.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        break;

      case 3:
        this.blendSrc = THREE.SrcColorFactor;
        this.blendDst = THREE.DstColorFactor;
        this.blendSrcAlpha = THREE.SrcAlphaFactor;
        this.blendDstAlpha = THREE.DstAlphaFactor;
        break;

      case 4:
        this.blendSrc = THREE.SrcAlphaFactor;
        this.blendDst = THREE.OneFactor;
        this.blendSrcAlpha = THREE.SrcAlphaFactor;
        this.blendDstAlpha = THREE.OneFactor;
        break;

      case 5:
        this.blendSrc = THREE.DstColorFactor;
        this.blendDst = THREE.ZeroFactor;
        this.blendSrcAlpha = THREE.DstAlphaFactor;
        this.blendDstAlpha = THREE.ZeroFactor;
        break;

      case 6:
        this.blendSrc = THREE.DstColorFactor;
        this.blendDst = THREE.SrcColorFactor;
        this.blendSrcAlpha = THREE.DstAlphaFactor;
        this.blendDstAlpha = THREE.SrcAlphaFactor;
        break;

      default:
        break;
    }
  }

  assignShaders(shaderNames) {
    /*
    let vertex, fragment;

    if (!shaderNames) {
      // TODO: warn somehow?
      console.log('missing shader names, assigning defaults');

      vertex = 'Diffuse_T1';
      fragment = 'Combiners_Opaque';
    } else {
      vertex = shaderNames.vertex;
      fragment = shaderNames.fragment;
    }

    this.shaderNames = {
      vertex: vertex,
      fragment: fragment
    };
    */

    this.shaderNames = shaderNames;

    if (this.shaderNames) {
      this.vertexShader = M2Material.VERTEX_SHADERS[shaderNames.vertex];
      this.fragmentShader = M2Material.FRAGMENT_SHADERS[shaderNames.fragment];

      if (!M2Material.FRAGMENT_SHADERS[shaderNames.fragment]) {
        console.warn('MISSING SHADERS FOR M2: ', this.m2.name, this.shaderNames.fragment);
      }
    } else {
      this.vertexShader = M2Material.VERTEX_SHADERS['Discard'];
      this.fragmentShader = M2Material.FRAGMENT_SHADERS['Discard'];
    }
  }

  loadTextures() {
    const textureDefs = this.textureDefs;

    const textures = [];

    textureDefs.forEach((textureDef, index) => {
      const path = this.resolveTexturePath(textureDef);

      if (!path) {
        textures[index] = null;
        return;
      }

      // Claim the slot so `textureCount` and the uniform array keep their shape; the entry is
      // replaced in place once the texture has been fetched and decoded.
      textures[index] = TextureLoader.PLACEHOLDER;

      TextureLoader.load(path, THREE.RepeatWrapping, THREE.RepeatWrapping)
        .then((texture) => {
          textures[index] = texture;
        })
        .catch((error) => {
          console.error(`Failed to load M2 texture ${path}:`, error);
        });
    });

    this.textures = textures;

    // Update shader uniforms to reflect loaded textures.
    this.uniforms.textures = { value: textures };
    this.uniforms.textureCount = { value: textures.length };
  }

  resolveTexturePath(textureDef) {
    let path = null;

    switch (textureDef.type) {
      case 0:
        // Hardcoded texture
        path = textureDef.filename;
        break;

      case 11:
        if (this.skins.skin1) {
          path = this.skins.skin1;
        }
        break;

      case 12:
        if (this.skins.skin2) {
          path = this.skins.skin2;
        }
        break;

      case 13:
        if (this.skins.skin3) {
          path = this.skins.skin3;
        }
        break;

      default:
        break;
    }

    return path;
  }

  registerAnimations(def) {
    const { uvAnimationIndices, transparencyAnimationIndex, vertexColorAnimationIndex } = def;

    this.registerUVAnimations(uvAnimationIndices);
    this.registerTransparencyAnimation(transparencyAnimationIndex);
    this.registerVertexColorAnimation(vertexColorAnimationIndex);
  }

  registerUVAnimations(uvAnimationIndices) {
    if (uvAnimationIndices.length === 0) {
      return;
    }

    const { animations, uvAnimationValues } = this.m2;

    const updater = () => {
      uvAnimationIndices.forEach((uvAnimationIndex, opIndex) => {
        const target = this.uniforms.animatedUVs;
        const source = uvAnimationValues[uvAnimationIndex];

        target.value[opIndex] = source.matrix;
      });
    };

    // animations.on('update', updater);

    this.eventListeners.push([animations, 'update', updater]);
  }

  registerTransparencyAnimation(transparencyAnimationIndex) {
    if (transparencyAnimationIndex === null || transparencyAnimationIndex === -1) {
      return;
    }

    const { animations, transparencyAnimationValues } = this.m2;

    const target = this.uniforms.animatedTransparency;
    const source = transparencyAnimationValues;
    const valueIndex = transparencyAnimationIndex;

    const updater = () => {
      target.value = source[valueIndex];
    };

    // animations.on('update', updater);

    this.eventListeners.push([animations, 'update', updater]);
  }

  registerVertexColorAnimation(vertexColorAnimationIndex) {
    if (vertexColorAnimationIndex === null || vertexColorAnimationIndex === -1) {
      return;
    }

    const { animations, vertexColorAnimationValues } = this.m2;

    const targetRGB = this.uniforms.animatedVertexColorRGB;
    const targetAlpha = this.uniforms.animatedVertexColorAlpha;
    const source = vertexColorAnimationValues;
    const valueIndex = vertexColorAnimationIndex;

    const updater = () => {
      targetRGB.value = source[valueIndex].color;
      targetAlpha.value = source[valueIndex].alpha;
    };

    // animations.on('update', updater);

    this.eventListeners.push([animations, 'update', updater]);
  }

  detachEventListeners() {
    // this.eventListeners.forEach((entry) => {
    //   const [target, event, listener] = entry;
    //   target.removeListener(event, listener);
    // });
  }

  updateSkinTextures(skin1, skin2, skin3) {
    this.skins.skin1 = skin1;
    this.skins.skin2 = skin2;
    this.skins.skin3 = skin3;

    this.loadTextures();
  }

  dispose() {
    super.dispose();

    this.detachEventListeners();
    this.eventListeners = [];

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture);
    });
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    this.updateLightUniforms();
  }

  /**
   * Update light uniforms from the map light system
   */
  updateLightUniforms(): void {
    if (this.mapLight) {
      const uniforms = this.mapLight.uniforms;
      this.uniforms.fogParams.value.copy(uniforms.fogParams.value);
      this.uniforms.fogColor.value.copy(uniforms.fogColor.value);
      this.uniforms.wmoFogParams.value.copy(uniforms.wmoFogParams.value);
      this.uniforms.wmoFogColor.value.copy(uniforms.wmoFogColor.value);
      // World-space sun direction: this shader lights against worldVertexNormal. `uniforms.sunDir`
      // carries the view-space variant, which rotates with the camera.
      this.uniforms.sunParams.value.copy(this.mapLight.sunDir);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);
    }
  }
}

export default M2Material;



