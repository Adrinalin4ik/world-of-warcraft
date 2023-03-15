import * as THREE from 'three';
import M2 from '..';

import TextureLoader from '../../texture-loader';

import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

class M2Material extends THREE.ShaderMaterial {

  m2: M2;
  eventListeners = [];
  textureDefs: any;
  textures = [];
  skins: any = {};
  shaderID: number;

  constructor(m2, def) {
    super();
    // if (def.useSkinning) {
    //   super({ clipping: true });
    // } else {
    //   super({ clipping: false });
    // }
    // console.log(def)
    this.m2 = m2;

    const vertexShaderMode = this.vertexShaderModeFromID(def.shaderID, def.opCount);
    const fragmentShaderMode = this.fragmentShaderModeFromID(def.shaderID, def.opCount);

    this.uniforms = {
      textureCount: { value: 0 },
      textures: { value: [] },

      blendingMode: { value: 0 },
      vertexShaderMode: { value: vertexShaderMode },
      fragmentShaderMode: { value: fragmentShaderMode },

      billboarded: { value: 0.0 },

      // Animated vertex colors
      animatedVertexColorRGB: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      animatedVertexColorAlpha: { value: 1.0 },

      // Animated transparency
      animatedTransparency: { value: 10.0 },

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
      lightModifier: { value: '1.0' },
      ambientLight: { value: new THREE.Color(0.5, 0.5, 0.5) },
      diffuseLight: { value: new THREE.Color(0.25, 0.5, 1.0) },

      // Managed by light manager
      fogModifier: { value: '1.0' },
      fogColor: {  value: new THREE.Color(0.25, 0.5, 1.0) },
      fogStart: { value: 5.0 },
      fogEnd: { value: 400.0 }
    };

    // this.vertexShader = [
    //   "varying vec2 vUv;",
    //   "void main() {",
    //       "vUv = uv;",
    //       "gl_PointSize = 8.0;",
    //       "gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    //   "}",
    // ].join("\n"),

    // this.fragmentShader = [
    //         "varying vec2 vUv;",
    //         "uniform sampler2D textures;",
    //         "void main() {",
    //             "gl_FragColor = texture2D(textures, vUv);",
    //         "}",
    // ].join("\n")
    this.wireframe = false;
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.applyRenderFlags(def.renderFlags);
    this.applyBlendingMode(def.blendingMode);
    // Shader ID is a masked int that determines mode for vertex and fragment shader.
    this.shaderID = def.shaderID;

    // Loaded by calling updateSkinTextures()
    this.skins = {};
    this.skins.skin1 = null;
    this.skins.skin2 = null;
    this.skins.skin3 = null;

    this.textures = [];
    this.textureDefs = def.textures;
    this.loadTextures();

    this.registerAnimations(def);
  }

  // TODO: Fully expand these lookups.
  vertexShaderModeFromID(shaderID, opCount) {
    if (opCount === 1) {
      return 0;
    }

    if (shaderID === 0) {
      return 1;
    }

    return -1;
  }

  // TODO: Fully expand these lookups.
  fragmentShaderModeFromID(shaderID, opCount) {
    if (opCount === 1) {
      // fragCombinersWrath1Pass
      return 0;
    }

    if (shaderID === 0) {
      // fragCombinersWrath2Pass
      return 1;
    }

    // Unknown / unhandled
    return -1;
  }

  enableBillboarding() {
    // TODO: Make billboarding happen in the vertex shader.
    this.uniforms.billboarded = { value: '1.0' };

    // TODO: Shouldn't this be FrontSide? Billboarding logic currently seems to flips the mesh
    // backward.
    this.side = THREE.BackSide;
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
    this.uniforms.blendingMode.value = blendingMode;

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

  loadTextures() {
    const textureDefs = this.textureDefs;

    const textures = [];

    textureDefs.forEach((textureDef) => {
      if (!textureDef.filename.includes("TEMP")) {
        textures.push(this.loadTexture(textureDef));
      } else {
        this.visible = false;
      }
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

    const { animationManager, uvAnimationValues } = this.m2;

    const updater = () => {
      uvAnimationIndices.forEach((uvAnimationIndex, opIndex) => {
        const target = this.uniforms.animatedUVs;
        const source = uvAnimationValues[uvAnimationIndex];

        target.value[opIndex] = source.matrix;
      });
    };

    animationManager.on('update', updater);

    this.eventListeners.push([animationManager, 'update', updater]);
  }

  registerTransparencyAnimation(transparencyAnimationIndex) {
    if (transparencyAnimationIndex === null || transparencyAnimationIndex === -1) {
      return;
    }

    const { animationManager, transparencyAnimationValues } = this.m2;

    const target = this.uniforms.animatedTransparency;
    const source = transparencyAnimationValues;
    const valueIndex = transparencyAnimationIndex;

    const updater = () => {
      target.value = source[valueIndex];
    };

    animationManager.on('update', updater);

    this.eventListeners.push([animationManager, 'update', updater]);
  }

  registerVertexColorAnimation(vertexColorAnimationIndex) {
    if (vertexColorAnimationIndex === null || vertexColorAnimationIndex === -1) {
      return;
    }

    const { animationManager, vertexColorAnimationValues } = this.m2;

    const targetRGB = this.uniforms.animatedVertexColorRGB;
    const targetAlpha = this.uniforms.animatedVertexColorAlpha;
    const source = vertexColorAnimationValues;
    const valueIndex = vertexColorAnimationIndex;

    const updater = () => {
      targetRGB.value = source[valueIndex].color;
      targetAlpha.value = source[valueIndex].alpha;
    };

    animationManager.on('update', updater);

    this.eventListeners.push([animationManager, 'update', updater]);
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