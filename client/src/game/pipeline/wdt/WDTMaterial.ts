import * as THREE from 'three';
import MapLight from '../../world/light/MapLight';

// Import shaders
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

type WDTMaterialOptions = {
  mapLight?: MapLight;
  textures?: {
    diffuse?: THREE.Texture;
    normal?: THREE.Texture;
    specular?: THREE.Texture;
    detail?: THREE.Texture;
  };
  material?: {
    diffuseColor?: THREE.Color;
    specularColor?: THREE.Color;
    shininess?: number;
    specular?: number;
    detail?: number;
    alpha?: number;
  };
  terrain?: {
    scale?: number;
    offset?: THREE.Vector2;
    detailScale?: number;
  };
};

class WDTMaterial extends THREE.ShaderMaterial {
  private mapLight: MapLight | null = null;
  private useNewLightSystem = false;

  constructor(options: WDTMaterialOptions = {}) {
    super();

    // Set shaders
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    // Initialize uniforms
    this.uniforms = {
      // Texture uniforms
      diffuseTexture: { value: options.textures?.diffuse || null },
      normalTexture: { value: options.textures?.normal || null },
      specularTexture: { value: options.textures?.specular || null },
      detailTexture: { value: options.textures?.detail || null },

      // Material uniforms
      materialParams: { 
        value: new THREE.Vector4(
          options.material?.shininess || 32.0,
          options.material?.specular || 0.0,
          options.material?.detail || 0.0,
          0.0
        )
      },
      diffuseColor: { value: options.material?.diffuseColor || new THREE.Color(1.0, 1.0, 1.0) },
      specularColor: { value: options.material?.specularColor || new THREE.Color(1.0, 1.0, 1.0) },
      alpha: { value: options.material?.alpha || 1.0 },

      // Terrain uniforms
      terrainScale: { value: options.terrain?.scale || 1.0 },
      terrainOffset: { value: options.terrain?.offset || new THREE.Vector2(0.0, 0.0) },
      detailScale: { value: options.terrain?.detailScale || 1.0 },

      // Animation uniforms
      time: { value: 0.0 },
      animatedVertexColor: { value: new THREE.Vector4(1.0, 1.0, 1.0, 1.0) },

      // Light system uniforms (will be set by light integration)
      sunDir: { value: new THREE.Vector3(-1.0, -1.0, -1.0) },
      sunDiffuseColor: { value: new THREE.Color(0.25, 0.5, 1.0) },
      sunAmbientColor: { value: new THREE.Color(0.5, 0.5, 0.5) },

      // Fog uniforms
      fogParams: { value: new THREE.Vector4(1.0 / 577.0, 577.0, 1.0, 1.0) },
      fogColor: { value: new THREE.Color(0.25, 0.5, 0.8) }
    };

    // Set material properties
    this.transparent = false;
    this.side = THREE.FrontSide;
    this.depthTest = true;
    this.depthWrite = true;

    // Initialize light system if provided
    if (options.mapLight) {
      this.setMapLight(options.mapLight);
    }
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    this.useNewLightSystem = true;
    this.updateLightUniforms();
  }

  /**
   * Update light uniforms
   */
  updateLightUniforms(): void {
    if (this.useNewLightSystem && this.mapLight) {
      const lightUniforms = this.mapLight.uniforms;
      
      this.uniforms.sunDir.value = lightUniforms.sunDir.value;
      this.uniforms.sunDiffuseColor.value = lightUniforms.sunDiffuseColor.value;
      this.uniforms.sunAmbientColor.value = lightUniforms.sunAmbientColor.value;
      this.uniforms.fogParams.value = lightUniforms.fogParams.value;
      this.uniforms.fogColor.value = lightUniforms.fogColor.value;
    }
  }

  /**
   * Set diffuse texture
   */
  setDiffuseTexture(texture: THREE.Texture): void {
    this.uniforms.diffuseTexture.value = texture;
  }

  /**
   * Set normal texture
   */
  setNormalTexture(texture: THREE.Texture): void {
    this.uniforms.normalTexture.value = texture;
  }

  /**
   * Set specular texture
   */
  setSpecularTexture(texture: THREE.Texture): void {
    this.uniforms.specularTexture.value = texture;
  }

  /**
   * Set detail texture
   */
  setDetailTexture(texture: THREE.Texture): void {
    this.uniforms.detailTexture.value = texture;
  }

  /**
   * Set material parameters
   */
  setMaterialParams(shininess: number, specular: number, detail: number): void {
    this.uniforms.materialParams.value.set(shininess, specular, detail, 0.0);
  }

  /**
   * Set diffuse color
   */
  setDiffuseColor(color: THREE.Color): void {
    this.uniforms.diffuseColor.value = color;
  }

  /**
   * Set specular color
   */
  setSpecularColor(color: THREE.Color): void {
    this.uniforms.specularColor.value = color;
  }

  /**
   * Set alpha
   */
  setAlpha(alpha: number): void {
    this.uniforms.alpha.value = alpha;
  }

  /**
   * Set terrain scale
   */
  setTerrainScale(scale: number): void {
    this.uniforms.terrainScale.value = scale;
  }

  /**
   * Set terrain offset
   */
  setTerrainOffset(offset: THREE.Vector2): void {
    this.uniforms.terrainOffset.value = offset;
  }

  /**
   * Set detail scale
   */
  setDetailScale(scale: number): void {
    this.uniforms.detailScale.value = scale;
  }

  /**
   * Update time for animations
   */
  updateTime(time: number): void {
    this.uniforms.time.value = time;
  }

  /**
   * Set animated vertex color
   */
  setAnimatedVertexColor(color: THREE.Vector4): void {
    this.uniforms.animatedVertexColor.value = color;
  }

  /**
   * Check if using new light system
   */
  isUsingNewLightSystem(): boolean {
    return this.useNewLightSystem;
  }

  /**
   * Get the map light instance
   */
  getMapLight(): MapLight | null {
    return this.mapLight;
  }

  /**
   * Clone the material
   */
  clone(): this {
    const cloned = new WDTMaterial();
    
    // Copy uniforms
    Object.keys(this.uniforms).forEach(key => {
      if (this.uniforms[key] && this.uniforms[key].value) {
        if (this.uniforms[key].value.clone) {
          cloned.uniforms[key].value = this.uniforms[key].value.clone();
        } else {
          cloned.uniforms[key].value = this.uniforms[key].value;
        }
      }
    });

    // Copy material properties
    cloned.transparent = this.transparent;
    cloned.side = this.side;
    cloned.depthTest = this.depthTest;
    cloned.depthWrite = this.depthWrite;

    // Copy light system
    if (this.mapLight) {
      cloned.setMapLight(this.mapLight);
    }

    return cloned as this;
  }
}

export default WDTMaterial;
