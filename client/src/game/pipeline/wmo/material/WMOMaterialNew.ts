import * as THREE from 'three';
import { WMOLightIntegration } from '../../../world/light/WMOLightIntegration';

/**
 * Enhanced WMO Material that can use either the old or new light system
 */
class WMOMaterialNew extends THREE.ShaderMaterial {
  private lightIntegration: WMOLightIntegration | null = null;
  private useNewLightSystem = false;
  private interior: boolean;
  
  // WMO-specific properties
  public def: any;
  public textures: any[];

  constructor(def: any, groupData: any, camera?: THREE.Camera, mapId?: number) {
    super();

    this.def = def;
    this.interior = def.interior || groupData.interior;
    this.textures = [];

    // Initialize uniforms with old system as default
    this.uniforms = {
      sunParams: { value: new THREE.Vector4() },
      sunDiffuseColor: { value: new THREE.Color() },
      sunAmbientColor: { value: new THREE.Color() },

      fogParams: { value: new THREE.Vector4() },
      fogColor: { value: new THREE.Color() },
      materialParams: { value: [1, 1, 1, 1] }
    };

    // Enable lighting
    this.defines.USE_LIGHTING = 0;
    this.defines.USE_VERTEX_COLOR = 0;
    
    // Define interior
    if (this.interior) {
      this.defines.INTERIOR = 1;
    }
    
    // Define blending mode
    this.defines.BLENDING_MODE = def.blendingMode;
    this.defines.BATCH_TYPE = def.batchType;
    
    if (def.flags & 0x10) {
      this.uniforms.sunParams.value[3] = 0.0;
    }

    // Tag lighting mode (based on group flags)
    this.uniforms.interior = { value: this.interior ? 1 : 0 };

    // Flag 0x01 (unlit)
    if (def.flags & 0x10) {
      this.uniforms.lightModifier = { value: 0.0 };
    }

    // Transparent blending
    if (def.blendingMode === 1) {
      this.transparent = true;
      this.side = THREE.DoubleSide;
    }

    // Flag 0x04: no backface culling
    if (def.flags & 0x04) {
      this.side = THREE.DoubleSide;
    }

    // Flag 0x40: clamp to edge
    if (def.flags & 0x40) {
      // Implementation for texture clamping
    }

    this.vertexShader = this.getVertexShader();
    this.fragmentShader = this.getFragmentShader();

    // Initialize new light system if camera is provided
    if (camera) {
      this.enableNewLightSystem(camera, mapId);
    }
  }

  /**
   * Enable the new light system
   */
  enableNewLightSystem(camera: THREE.Camera, mapId?: number) {
    this.lightIntegration = new WMOLightIntegration(camera, mapId);
    this.useNewLightSystem = true;
    
    // Set the correct location based on interior flag
    this.lightIntegration.setLocation(this.interior ? 'interior' : 'exterior');
    
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
  getLightIntegration(): WMOLightIntegration | null {
    return this.lightIntegration;
  }

  /**
   * Calculate vertex color attenuation for WMO groups
   */
  calculateVertexColorAttenuation(
    vertexPosition: THREE.Vector3,
    closestPortal: { distance: number; portalRef: { groupIndex: number } } | null,
    groupFlags: number
  ): number {
    if (this.lightIntegration) {
      return this.lightIntegration.calculateVertexColorAttenuation(
        vertexPosition,
        closestPortal,
        groupFlags
      );
    }
    
    // Fallback to old system logic
    return 0.0;
  }

  /**
   * Apply vertex color attenuation to a color array
   */
  applyVertexColorAttenuation(
    color: Uint8Array,
    vertexIndex: number,
    attenuation: number
  ): void {
    if (this.lightIntegration) {
      this.lightIntegration.applyVertexColorAttenuation(color, vertexIndex, attenuation);
    }
  }

  /**
   * Get vertex shader source
   */
  private getVertexShader(): string {
    // Return the vertex shader source
    // This would be the same as the original WMO vertex shader
    return `
      // WMO Vertex Shader
      // Implementation would go here
    `;
  }

  /**
   * Get fragment shader source
   */
  private getFragmentShader(): string {
    // Return the fragment shader source
    // This would be the same as the original WMO fragment shader
    return `
      // WMO Fragment Shader
      // Implementation would go here
    `;
  }
}

export default WMOMaterialNew;
