import * as THREE from 'three';
import { M2LightIntegration } from '../../../world/light/M2LightIntegration';

type M2MaterialLiteOptions = {
  m2?: any;
  def?: any;
  camera?: THREE.Camera;
  mapId?: number;
  texture?: THREE.Texture;
  color?: THREE.Color;
  alpha?: number;
};

class M2MaterialLite extends THREE.MeshBasicMaterial {
  private lightIntegration: M2LightIntegration | null = null;
  private useNewLightSystem = false;
  
  // M2-specific properties
  public m2: any;
  public eventListeners: any[];
  public layer: any;
  public textureDefs: any;

  constructor(options: M2MaterialLiteOptions = {}) {
    super({
      map: options.texture,
      color: options.color || new THREE.Color(0.5, 0.5, 0.5),
      transparent: options.alpha !== undefined && options.alpha < 1.0,
      opacity: options.alpha || 1.0
    });

    this.m2 = options.m2;
    this.eventListeners = [];
    this.layer = options.def?.layer;

    // Initialize new light system if camera is provided
    if (options.camera) {
      this.enableNewLightSystem(options.camera, options.mapId);
    }
  }

  /**
   * Enable the new light system
   */
  enableNewLightSystem(camera: THREE.Camera, mapId?: number) {
    this.lightIntegration = new M2LightIntegration(camera, mapId);
    this.useNewLightSystem = true;
  }

  /**
   * Disable the new light system
   */
  disableNewLightSystem() {
    this.lightIntegration = null;
    this.useNewLightSystem = false;
  }

  /**
   * Update light uniforms (call this in your render loop)
   */
  updateLightUniforms() {
    if (this.useNewLightSystem && this.lightIntegration) {
      this.lightIntegration.update();
      
      // Simple lighting calculation for basic material
      const lightUniforms = this.lightIntegration.getUniforms();
      const sunColor = lightUniforms.sunDiffuseColor.value;
      const ambientColor = lightUniforms.sunAmbientColor.value;
      
      // Simple lighting factor
      const lightFactor = 0.5;
      const finalColor = new THREE.Color().addColors(
        sunColor.clone().multiplyScalar(lightFactor),
        ambientColor
      );
      
      this.color = finalColor;
    }
  }

  /**
   * Set the map ID for light data loading
   */
  setMapId(mapId: number) {
    if (this.lightIntegration) {
      this.lightIntegration.setMapId(mapId);
    }
  }

  /**
   * Set the lighting context (exterior/interior)
   */
  setLightLocation(location: 'exterior' | 'interior') {
    if (this.lightIntegration) {
      this.lightIntegration.setLocation(location);
    }
  }

  /**
   * Set time override for testing different times of day
   */
  setTimeOverride(time: number | null) {
    if (this.lightIntegration) {
      this.lightIntegration.setTimeOverride(time);
    }
  }

  /**
   * Get light modifier based on material flags
   */
  getLightModifier(materialFlags: number): number {
    if (this.lightIntegration) {
      return this.lightIntegration.getLightModifier(materialFlags);
    }
    
    // Fallback to simple logic
    return (materialFlags & 0x10) ? 0.0 : 1.0;
  }

  /**
   * Check if using the new light system
   */
  isUsingNewLightSystem(): boolean {
    return this.useNewLightSystem;
  }

  /**
   * Get the light integration instance
   */
  getLightIntegration(): M2LightIntegration | null {
    return this.lightIntegration;
  }

  /**
   * Set texture
   */
  setTexture(texture: THREE.Texture) {
    this.map = texture;
  }

  /**
   * Set color
   */
  setColor(color: THREE.Color) {
    this.color = color;
  }

  /**
   * Set alpha
   */
  setAlpha(alpha: number) {
    this.opacity = alpha;
    this.transparent = alpha < 1.0;
  }

  /**
   * Apply render flags to material
   */
  applyRenderFlags(renderFlags: any) {
    // Simple implementation for basic material
    if (renderFlags && renderFlags.transparent) {
      this.transparent = true;
      this.opacity = 0.5;
    }
  }

  /**
   * Apply blending mode to material
   */
  applyBlendingMode(blendingMode: any) {
    // Simple implementation for basic material
    switch (blendingMode) {
      case 0: // Opaque
        this.transparent = false;
        break;
      case 1: // Alpha key
        this.transparent = true;
        this.opacity = 0.5;
        break;
      case 2: // Alpha
        this.transparent = true;
        this.opacity = 0.7;
        break;
      case 3: // Add
        this.blending = THREE.AdditiveBlending;
        this.transparent = true;
        break;
      default:
        this.transparent = false;
    }
  }

  /**
   * Load textures for the material
   */
  loadTextures() {
    // Simple implementation - just set a default texture if none provided
    if (!this.map) {
      // Could create a simple colored texture here
    }
  }

  /**
   * Register animations for the material
   */
  registerAnimations(def: any) {
    // Simple implementation - no complex animations for lite version
  }

  /**
   * Enable billboarding
   */
  enableBillboarding() {
    // Simple implementation - could set a flag for billboard behavior
  }
}

export default M2MaterialLite;
