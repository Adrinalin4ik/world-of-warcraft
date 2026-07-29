import * as THREE from 'three';

import MapLight from '../../../world/light/MapLight';
import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

class LiquidMaterial extends THREE.ShaderMaterial {

  textureType: any;
  textureIndex: number;
  textures = [];
  animationCounter: number;
  private mapLight: MapLight | null = null;
  
  constructor(type) {
    super();

    this.textureType = type;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.side = THREE.BackSide;
    this.transparent = true;

    this.textureIndex = 0;
    this.textures = [];

    // Extract colors from liquid type data
    let baseColor = new THREE.Color(0.4, 0.6, 0.7); // Fallback water color
    let fogColor = new THREE.Color(0.3, 0.5, 0.8);
    
    if (type.data.colors && type.data.colors.length >= 2) {
      const color1 = type.data.colors[0];
      const r1 = ((color1 >> 16) & 0xFF) / 255.0;
      const g1 = ((color1 >> 8) & 0xFF) / 255.0;
      const b1 = (color1 & 0xFF) / 255.0;
      
      
      // Check if DBC colors are black and use fallback if needed
      const brightness = (r1 + g1 + b1) / 3;
      if (brightness < 0.01) {
        baseColor = new THREE.Color(0.4, 0.6, 0.7);
        fogColor = new THREE.Color(0.3, 0.5, 0.8);
      } else {
        // Use the actual DBC colors
        baseColor = new THREE.Color(r1, g1, b1);
        fogColor = new THREE.Color(r1 * 0.8, g1 * 0.8, b1 * 0.9);
      }
    }

    // Default blend mode for liquids (0 = Combiners_Mod - multiply)
    const blendMode = type.blendMode !== undefined ? type.blendMode : 0;
    
    this.uniforms = {
      texture_sampler: { value: null },
      blendingMode: { value: blendMode },
      
      // Debug: Log the blending mode being used
      _debugBlendMode: { value: (() => {
        return blendMode;
      })() },
      

      useBaseColor: { value: 1 },
      baseColor: { value: baseColor },
      baseAlpha: { value: 0.1 },

       // Managed by light manager
      lightModifier: { value: 1.0 },
      ambientLight: { value: new THREE.Color(0.5, 0.6, 0.7) },
      diffuseLight: { value: new THREE.Color(0.3, 0.5, 0.7) },

       // Use light system's fog uniforms
      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      
      // Sun direction and colors from MapLight system
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },
      
      // WMO interior/exterior flag
      indoor: { value: 0 }
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
    // Slow down animation by only updating every 3rd frame
    if (this.animationCounter === undefined) {
      this.animationCounter = 0;
    }
    this.animationCounter++;
    
    if (this.animationCounter % 5 === 0) {
      ++this.textureIndex;
      const current = this.textures[this.textureIndex % this.textures.length];
      this.uniforms.texture_sampler.value = current;
    }
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
      this.uniforms.sunParams.value.copy(uniforms.sunDir.value);
      this.uniforms.sunDiffuseColor.value.copy(uniforms.sunDiffuseColor.value);
      this.uniforms.sunAmbientColor.value.copy(uniforms.sunAmbientColor.value);
    }
  }

  dispose() {
    super.dispose();

    this.textures.forEach((texture) => {
      TextureLoader.unload(texture);
    });
  }

 }

export default LiquidMaterial;
