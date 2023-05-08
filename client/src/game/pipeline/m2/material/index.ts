import * as THREE from 'three';

import M2 from '..';
import WorldLight from '../../../world/light';
import TextureLoader from '../../texture-loader';

class M2Material extends THREE.ShaderMaterial {

  static VERTEX_SHADERS = {
    'Diffuse_T1': require('./vertex/diffuse-t1.glsl'),
    'Diffuse_Env': require('./vertex/diffuse-env.glsl'),
    'Diffuse_T1_T2': require('./vertex/diffuse-t1-t2.glsl'),
    'Diffuse_T1_Env': require('./vertex/diffuse-t1-env.glsl'),
    'Diffuse_Env_Env': require('./vertex/diffuse-env-env.glsl'),
    'Discard': require('./vertex/discard.glsl')
  };

  static FRAGMENT_SHADERS = {
    'Combiners_Opaque': require('./fragment/combiners-opaque.glsl'),
    'Combiners_Mod': require('./fragment/combiners-mod.glsl'),
    'Combiners_Opaque_Opaque': require('./fragment/combiners-opaque-opaque.glsl'),
    'Combiners_Opaque_Add': require('./fragment/combiners-opaque-add.glsl'),
    'Combiners_Opaque_AddNA': require('./fragment/combiners-opaque-addna.glsl'),
    'Combiners_Opaque_AddAlpha': require('./fragment/combiners-opaque-addalpha.glsl'),
    'Combiners_Opaque_AddAlpha_Alpha': require('./fragment/combiners-opaque-addalpha-alpha.glsl'),
    'Combiners_Opaque_Mod': require('./fragment/combiners-opaque-mod.glsl'),
    'Combiners_Opaque_Mod2x': require('./fragment/combiners-opaque-mod2x.glsl'),
    'Combiners_Opaque_Mod2xNA': require('./fragment/combiners-opaque-mod2xna.glsl'),
    'Combiners_Opaque_Mod2xNA_Alpha': require('./fragment/combiners-opaque-mod2xna-alpha.glsl'),
    'Combiners_Mod_Opaque': require('./fragment/combiners-mod-opaque.glsl'),
    'Combiners_Mod_Mod': require('./fragment/combiners-mod-mod.glsl'),
    'Combiners_Mod_Mod2x': require('./fragment/combiners-mod-mod2x.glsl'),
    'Discard': require('./fragment/discard.glsl')
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

      // Managed by light manager
      sunParams: WorldLight.uniforms.sunParams,
      sunDiffuseColor: WorldLight.uniforms.sunDiffuseColor,
      sunAmbientColor: WorldLight.uniforms.sunAmbientColor,
      
      fogParams: WorldLight.uniforms.fogParams,
      fogColor: WorldLight.uniforms.fogColor,
      materialParams: { value: [1,1,1,1] }
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

    // Flag 0x02 (unfogged)
    if (renderFlags & 0x02) {
      this.uniforms.fogModifier = { value: '0.0' };
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

    this.vertexShader = M2Material.VERTEX_SHADERS.Diffuse_T1;
    this.fragmentShader = M2Material.FRAGMENT_SHADERS.Combiners_Opaque;
  }

  loadTextures() {
    const textureDefs = this.textureDefs;

    const textures = [];

    textureDefs.forEach((textureDef) => {
      textures.push(this.loadTexture(textureDef));
    });

    this.textures = textures;

    // Update shader uniforms to reflect loaded textures.
    this.uniforms.textures = { value: textures };
    this.uniforms.textureCount = { value: textures.length };
  }

  loadTexture(textureDef) {
    const wrapS = THREE.RepeatWrapping;
    const wrapT = THREE.RepeatWrapping;
    const flipY = false;

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

    if (path) {
      return TextureLoader.load(path, wrapS, wrapT, flipY);
    } else {
      return null;
    }
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
    this.eventListeners.forEach((entry) => {
      const [target, event, listener] = entry;
      target.removeListener(event, listener);
    });
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
}

export default M2Material;
