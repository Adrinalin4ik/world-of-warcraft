import * as THREE from 'three';

import WorldLight from '../../../world/light';
import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';
// import fragmentShader from './shaders/fragment/main.glsl';
// import vertexShader from './shaders/vertex/main.glsl';

class AdtMaterial extends THREE.ShaderMaterial {

  layers = [];
  rawAlphaMaps = [];
  textureNames: string[] = [];

  vertexShader = vertexShader;
  fragmentShader = fragmentShader;

  side = THREE.BackSide;

  layerCount = 0;
  textures = [];
  alphaMaps = [];

  constructor(data, textureNames) {
    super();
    this.layers = data.MCLY.layers;
    this.rawAlphaMaps = data.MCAL.alphaMaps;
    this.textureNames = textureNames;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.loadLayers();
    this.uniforms = {
      layerCount: { value: this.layerCount },
      alphaMaps: { value: this.alphaMaps },
      textures: { value: this.textures },

      // Managed by light manager
      lightModifier: { value: '1.0' },
      ambientLight: { value: new THREE.Color(0.5, 0.5, 0.5) },
      diffuseLight: { value: new THREE.Color(0.25, 0.5, 1.0) },

      // Managed by light manager
      // fogModifier: { value: '1.0' },
      // fogColor: { value: new THREE.Color(0.25, 0.5, 1.0) },
      // fogStart: { value: 5.0 },
      // fogEnd: { value: 400.0 }

      sunParams: WorldLight.uniforms.sunParams,
      sunDiffuseColor: WorldLight.uniforms.sunDiffuseColor,
      sunAmbientColor: WorldLight.uniforms.sunAmbientColor,
      
      fogParams: WorldLight.uniforms.fogParams,
      fogColor: WorldLight.uniforms.fogColor,
      materialParams: { value: [1,1,1,1] }
    };

    // this.uniforms = {
    //   sunParams: WorldLight.uniforms.sunParams,
    //   sunDiffuseColor: WorldLight.uniforms.sunDiffuseColor,
    //   sunAmbientColor: WorldLight.uniforms.sunAmbientColor,
      
    //   fogParams: WorldLight.uniforms.fogParams,
    //   fogColor: WorldLight.uniforms.fogColor,
    //   materialParams: { value: [1,1,1,1] }
    // };

    this.needsUpdate = true;
  }

  loadLayers() {
    this.layerCount = this.layers.length;

    this.loadAlphaMaps();
    this.loadTextures();
  }

  loadAlphaMaps() {
    const alphaMaps = [];

    this.rawAlphaMaps.forEach((raw) => {
      const texture = new THREE.DataTexture(raw, 64, 64);
      // texture.format = THREE.LuminanceFormat;
      texture.format = THREE.RedFormat;
      texture.type = THREE.UnsignedByteType;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;

      alphaMaps.push(texture);
    });

    // Texture array uniforms must have at least one value present to be considered valid.
    if (alphaMaps.length === 0) {
      alphaMaps.push(new THREE.Texture());
    }

    this.alphaMaps = alphaMaps;
  }

  loadTextures() {
    const textures = [];

    this.layers.forEach((layer) => {
      const filename = this.textureNames[layer.textureID];
      const texture = TextureLoader.load(filename);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;

      textures.push(texture);
    });

    this.textures = textures;
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture.sourceFile);
    });

    this.alphaMaps.forEach((alphaMap) => {
      alphaMap.dispose();
    });
  }
}

export default AdtMaterial;
