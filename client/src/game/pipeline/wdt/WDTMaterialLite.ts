import * as THREE from 'three';
import MapLight from '../../world/light/MapLight';

type WDTMaterialLiteOptions = {
  mapLight?: MapLight;
  texture?: THREE.Texture;
  color?: THREE.Color;
  alpha?: number;
};

class WDTMaterialLite extends THREE.MeshBasicMaterial {
  private mapLight: MapLight | null = null;
  private useNewLightSystem = false;

  constructor(options: WDTMaterialLiteOptions = {}) {
    super({
      map: options.texture,
      color: options.color || new THREE.Color(0.5, 0.5, 0.5),
      transparent: options.alpha !== undefined && options.alpha < 1.0,
      opacity: options.alpha || 1.0
    });

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
  }

  /**
   * Update light uniforms (for shader materials)
   */
  updateLightUniforms(): void {
    if (this.useNewLightSystem && this.mapLight) {
      // For basic material, we just update the color based on lighting
      const lightUniforms = this.mapLight.uniforms;
      const sunColor = lightUniforms.sunDiffuseColor.value;
      const ambientColor = lightUniforms.sunAmbientColor.value;
      
      // Simple lighting calculation
      const lightFactor = 0.5; // Simplified
      const finalColor = new THREE.Color().addColors(
        sunColor.clone().multiplyScalar(lightFactor),
        ambientColor
      );
      
      this.color = finalColor;
    }
  }

  /**
   * Set texture
   */
  setTexture(texture: THREE.Texture): void {
    this.map = texture;
  }

  /**
   * Set color
   */
  setColor(color: THREE.Color): void {
    this.color = color;
  }

  /**
   * Set alpha
   */
  setAlpha(alpha: number): void {
    this.opacity = alpha;
    this.transparent = alpha < 1.0;
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
}

export default WDTMaterialLite;


