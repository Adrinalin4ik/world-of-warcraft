import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

class LiquidMaterial extends THREE.ShaderMaterial {

  textureType: any;
  textureIndex: number;
  textures = [];
  
  constructor(type) {
    super();

    this.textureType = type;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.side = THREE.BackSide;
    this.transparent = true;

    this.textureIndex = 0;
    this.textures = [];

    this.uniforms = {
      texture_sampler: { value: null },
      blendingMode: { value: type.blendMode },

      useBaseColor: { value: 0 },
      baseColor: { value: new THREE.Color(0, 0, 0) },
      baseAlpha: { value: 0.0 },

       // Managed by light manager
      lightModifier: { value: 1.0 },
      ambientLight: { value: new THREE.Color(0.5, 0.5, 0.5) },
      diffuseLight: { value: new THREE.Color(0.25, 0.5, 1.0) },

       // Managed by light manager
      fogModifier: {  value: 1.0 },
      fogColor: { value: new THREE.Color(0.25, 0.5, 1.0) },
      fogStart: { value: 5.0 },
      fogEnd: { value: 400.0 }
    };

    const textures = this.loadTextures(this.textureType.texturePaths);
    this.uniforms.texture_sampler.value = textures[0];
  }

  loadTextures(texturePaths) {
    this.textures = texturePaths.map((path) => {
      return TextureLoader.load(path);
    });

    return this.textures;
  }

  animate() {
    ++this.textureIndex;
    const current = this.textures[this.textureIndex % this.textures.length];
    this.uniforms.texture_sampler.value = current;
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture);
    });
  }

 }

export default LiquidMaterial;
