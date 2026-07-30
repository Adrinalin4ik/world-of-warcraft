import * as THREE from 'three';
import { M2LightIntegration } from '../../../world/light/M2LightIntegration';

/**
 * Enhanced M2 Material that can use either the old or new light system
 */
class M2MaterialNew extends THREE.ShaderMaterial {
  private lightIntegration: M2LightIntegration | null = null;
  private useNewLightSystem = false;
  
  // M2-specific properties
  public m2: any;
  public eventListeners: any[];
  public layer: any;
  public textureDefs: any;

  constructor(m2: any, def: any, camera?: THREE.Camera, mapId?: number) {
    super();

    this.m2 = m2;
    this.eventListeners = [];
    this.layer = def.layer;

    // Initialize uniforms with old system as default
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

      // Managed by light manager (old system)
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      materialParams: { value: [1, 1, 1, 1] }
    };

    this.defines.MAX_BONES = 200;
    this.defines.USE_LIGHTING = 1;
    
    this.applyRenderFlags(def.renderFlags);
    this.applyBlendingMode(def.blendingMode);

    this.assignShaders(def.shaderNames);

    this.textureDefs = def.textures;
    this.loadTextures();

    this.registerAnimations(def);

    // Initialize new light system if camera is provided
    if (camera) {
      this.enableNewLightSystem(camera, mapId);
    }
  }

  /**
   * Enable the new light system
   */
  enableNewLightSystem(camera: THREE.Camera, mapId?: number) {
    this.lightIntegration = new M2LightIntegration(camera, mapId);
    this.useNewLightSystem = true;
    
    // Update uniforms with new light system
    this.updateLightUniforms();
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
      this.lightIntegration.applyToMaterial(this);
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
    
    // Fallback to old system logic
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

  // ... rest of the original M2Material methods would go here
  // (applyRenderFlags, applyBlendingMode, assignShaders, etc.)
  
  applyRenderFlags(renderFlags: any) {
    // Implementation from original M2Material
  }

  applyBlendingMode(blendingMode: any) {
    // Implementation from original M2Material
  }

  assignShaders(shaderNames: any) {
    // Implementation from original M2Material
  }

  loadTextures() {
    // Implementation from original M2Material
  }

  registerAnimations(def: any) {
    // Implementation from original M2Material
  }

  enableBillboarding() {
    this.uniforms.billboarded = { value: '1.0' };
  }
}

export default M2MaterialNew;
