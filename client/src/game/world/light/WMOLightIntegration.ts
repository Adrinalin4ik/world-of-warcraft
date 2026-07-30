import * as THREE from 'three';
import MapLight from './MapLight';
import { LightLocation } from './types';

/**
 * Light integration for WMO (World Model Objects)
 * Provides a bridge between the new modular light system and WMO materials
 */
export class WMOLightIntegration {
  private mapLight: MapLight;
  private camera: THREE.Camera;
  private location: LightLocation = 'exterior';

  constructor(camera: THREE.Camera, mapId?: number) {
    this.camera = camera;
    this.mapLight = new MapLight();
    
    if (mapId !== undefined) {
      this.mapLight.mapId = mapId;
    }
  }

  /**
   * Update the light system with current camera position
   */
  update() {
    this.mapLight.update(this.camera);
  }

  /**
   * Set the map ID for light data loading
   */
  setMapId(mapId: number) {
    this.mapLight.mapId = mapId;
  }

  /**
   * Set the lighting context (exterior/interior)
   */
  setLocation(location: LightLocation) {
    this.location = location;
    this.mapLight.location = location;
  }

  /**
   * Get uniforms for WMO material shaders
   * These uniforms match the structure expected by WMO shaders
   */
  getUniforms() {
    const lightUniforms = this.mapLight.uniforms;
    
    return {
      // Sun direction and colors
      sunParams: lightUniforms.sunDir,
      sunDiffuseColor: lightUniforms.sunDiffuseColor,
      sunAmbientColor: lightUniforms.sunAmbientColor,
      
      // Fog parameters
      fogParams: lightUniforms.fogParams,
      fogColor: lightUniforms.fogColor,
      
      // Additional WMO-specific uniforms
      materialParams: { value: [1, 1, 1, 1] },
      
      // Interior flag
      interior: { type: 'i', value: this.location === 'interior' ? 1 : 0 },
      
      // Light direction for legacy shader compatibility
      lightDirection: { value: this.mapLight.sunDir.clone().negate() },
      
      // Ambient and diffuse light for legacy shader compatibility
      ambientLight: { value: this.mapLight.sunAmbientColor.clone() },
      diffuseLight: { value: this.mapLight.sunDiffuseColor.clone() }
    };
  }

  /**
   * Apply uniforms to a WMO material
   */
  applyToMaterial(material: THREE.ShaderMaterial) {
    const uniforms = this.getUniforms();
    
    // Update existing uniforms or add new ones
    Object.keys(uniforms).forEach(key => {
      if (material.uniforms[key]) {
        material.uniforms[key].value = uniforms[key].value;
      } else {
        material.uniforms[key] = uniforms[key];
      }
    });
  }

  /**
   * Set time override for testing different times of day
   */
  setTimeOverride(time: number | null) {
    this.mapLight.timeOverride = time;
  }

  /**
   * Get current time in half-minutes since midnight
   */
  getCurrentTime() {
    return this.mapLight.time;
  }

  /**
   * Get sun direction for custom lighting calculations
   */
  getSunDirection() {
    return this.mapLight.sunDir;
  }

  /**
   * Get fog parameters for custom fog calculations
   */
  getFogParams() {
    return {
      start: this.mapLight.fogStart,
      end: this.mapLight.fogEnd,
      color: this.mapLight.fogColor
    };
  }

  /**
   * Check if the WMO should be lit (based on material flags)
   */
  shouldApplyLighting(materialFlags: number): boolean {
    // Flag 0x10 means unlit
    return !(materialFlags & 0x10);
  }

  /**
   * Get light modifier value based on material flags
   */
  getLightModifier(materialFlags: number): number {
    return this.shouldApplyLighting(materialFlags) ? 1.0 : 0.0;
  }

  /**
   * Calculate vertex color attenuation for WMO groups
   * This is used for interior/exterior lighting transitions
   */
  calculateVertexColorAttenuation(
    vertexPosition: THREE.Vector3,
    closestPortal: { distance: number; portalRef: { groupIndex: number } } | null,
    groupFlags: number
  ): number {
    if (!closestPortal) {
      return 0.0;
    }

    const distance = closestPortal.distance;
    let attenuation = 0.0;

    // Check if the destination group has lighting flags
    if (groupFlags & (0x08 | 0x40)) {
      if (distance < 0.0) {
        attenuation = 1.0;
      } else {
        attenuation = 1.0 - (distance / 6.0);
      }
    }

    if (attenuation <= 0.001) {
      attenuation = 0.0;
    } else if (attenuation > 1.0) {
      attenuation = 1.0;
    }

    return attenuation;
  }

  /**
   * Apply vertex color attenuation to a color array
   */
  applyVertexColorAttenuation(
    color: Uint8Array,
    vertexIndex: number,
    attenuation: number
  ): void {
    if (attenuation <= 0.0) {
      color[vertexIndex * 4 + 3] = 0; // Set alpha to 0
      return;
    }

    const baseR = color[vertexIndex * 4 + 0] * 255.0;
    const baseG = color[vertexIndex * 4 + 1] * 255.0;
    const baseB = color[vertexIndex * 4 + 2] * 255.0;

    // Apply attenuation formula from original WMO implementation
    const newR = ((127.0 - baseR) * attenuation) + baseR;
    const newG = ((127.0 - baseG) * attenuation) + baseG;
    const newB = ((127.0 - baseB) * attenuation) + baseB;

    color[vertexIndex * 4 + 0] = newR / 255.0;
    color[vertexIndex * 4 + 1] = newG / 255.0;
    color[vertexIndex * 4 + 2] = newB / 255.0;
    color[vertexIndex * 4 + 3] = attenuation * 255.0;
  }
}

export default WMOLightIntegration;
