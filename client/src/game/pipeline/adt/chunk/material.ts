import * as THREE from 'three';

import MapLight from '../../../world/light/MapLight';
import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';
// import fragmentShader from './shaders/fragment/main.glsl';
// import vertexShader from './shaders/vertex/main.glsl';

class AdtMaterial extends THREE.ShaderMaterial {

  layers = [];
  rawAlphaMaps = [];
  textureNames: string[] = [];
  private mapLight: MapLight | null = null;

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
      fogModifier: { value: '1.0' },
      // fogColor: { value: new THREE.Color(0.25, 0.5, 1.0) },
      // fogStart: { value: 5.0 },
      // fogEnd: { value: 400.0 },

      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      materialParams: { value: [1,1,1,1] }
    };

    this.needsUpdate = true;
    this.defines.USE_LIGHTING = 1;
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

    this.layers.forEach((layer, index) => {
      const filename = this.textureNames[layer.textureID];

      // Claim the slot up front. The array is handed to the `textures` uniform by reference, so the
      // layer appears as soon as its texture is swapped in; until then it samples as transparent.
      textures[index] = TextureLoader.PLACEHOLDER;

      TextureLoader.load(filename, THREE.RepeatWrapping, THREE.RepeatWrapping)
        .then((texture) => {
          textures[index] = texture;
        })
        .catch((error) => {
          console.error(`Failed to load ADT texture ${filename}:`, error);
        });
    });

    this.textures = textures;
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
      // mapLight.sunDir, not uniforms.sunDir: the latter exposes SceneLightParams' sunDirView, which
      // is re-derived from the camera's view matrix every frame. This shader dots the sun against a
      // world-space normal, so feeding it the view-space vector made the sun swing around with the
      // camera and the terrain change colour on rotation alone.
      this.uniforms.sunParams.value.copy(this.mapLight.sunDir);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);
    }
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
