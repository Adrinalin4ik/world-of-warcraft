import * as THREE from 'three';
import MapLight from './MapLight';
import { LightLocation } from './types';

/**
 * Light integration for M2 models
 * Provides a bridge between the new modular light system and M2 materials
 */
export class M2LightIntegration {
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
   * Get uniforms for M2 material shaders
   * These uniforms match the structure expected by M2 shaders
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
      
      // Additional M2-specific uniforms
      materialParams: { value: [1, 1, 1, 1] },
      
      // Camera position for lighting calculations
      cameraPosition: { value: this.camera.position.clone() }
    };
  }

  /**
   * Apply uniforms to an M2 material
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
   * Check if the model should be lit (based on material flags)
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
}

export default M2LightIntegration;
