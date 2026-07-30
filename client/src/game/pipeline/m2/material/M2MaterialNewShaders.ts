import * as THREE from 'three';
import { M2LightIntegration } from '../../../world/light/M2LightIntegration';

// Import the new shaders
import fragmentShader from './shader-new.frag';
import vertexShader from './shader-new.vert';

/**
 * Enhanced M2 Material with new shaders and light system integration
 */
class M2MaterialNewShaders extends THREE.ShaderMaterial {
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

    // Initialize uniforms with new light system structure
    this.uniforms = {
      // Texture uniforms
      textureCount: { value: 0 },
      textures: { value: [] },

      // Material uniforms
      materialParams: { value: new THREE.Vector4(1.0, 0.0, 1.0, 1.0) }, // [alpha, alphaTest, lighting, fog]

      // New light system uniforms
      sunDir: { value: new THREE.Vector3(-1.0, -1.0, -1.0) },
      sunDiffuseColor: { value: new THREE.Color(0.25, 0.5, 1.0) },
      sunAmbientColor: { value: new THREE.Color(0.5, 0.5, 0.5) },

      // Fog uniforms
      fogParams: { value: new THREE.Vector4(1.0 / 577.0, 577.0, 1.0, 1.0) },
      fogColor: { value: new THREE.Color(0.25, 0.5, 0.8) },

      // Animation uniforms
      animatedVertexColorRGB: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
      animatedVertexColorAlpha: { value: 1.0 },
      animatedTransparency: { value: 1.0 },
      animatedUVs: {
        value: [
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4(),
          new THREE.Matrix4()
        ]
      },

      // Skinning uniforms
      boneMatrices: { value: [] },
      boneTexture: { value: null },
      boneTextureSize: { value: 0 }
    };

    // Set shaders
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    // Set defines
    this.defines.MAX_BONES = 200;
    this.defines.USE_LIGHTING = 1;

    this.applyRenderFlags(def.renderFlags);
    this.applyBlendingMode(def.blendingMode);

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

  /**
   * Apply render flags to material
   */
  applyRenderFlags(renderFlags: any) {
    // Implementation from original M2Material
    // This would set various material properties based on render flags
  }

  /**
   * Apply blending mode to material
   */
  applyBlendingMode(blendingMode: any) {
    // Implementation from original M2Material
    // This would set blending properties
  }

  /**
   * Load textures for the material
   */
  loadTextures() {
    // Implementation from original M2Material
    // This would load and assign textures
  }

  /**
   * Register animations for the material
   */
  registerAnimations(def: any) {
    // Implementation from original M2Material
    // This would set up material animations
  }

  /**
   * Enable billboarding
   */
  enableBillboarding() {
    // Implementation from original M2Material
  }

  /**
   * Update material parameters
   */
  updateMaterialParams(alpha: number, alphaTest: number, lighting: number, fog: number) {
    this.uniforms.materialParams.value.set(alpha, alphaTest, lighting, fog);
  }

  /**
   * Set texture count
   */
  setTextureCount(count: number) {
    this.uniforms.textureCount.value = count;
  }

  /**
   * Set textures
   */
  setTextures(textures: THREE.Texture[]) {
    this.uniforms.textures.value = textures;
  }

  /**
   * Update animated vertex color
   */
  updateAnimatedVertexColor(rgb: THREE.Vector3, alpha: number) {
    this.uniforms.animatedVertexColorRGB.value = rgb;
    this.uniforms.animatedVertexColorAlpha.value = alpha;
  }

  /**
   * Update animated transparency
   */
  updateAnimatedTransparency(transparency: number) {
    this.uniforms.animatedTransparency.value = transparency;
  }

  /**
   * Update animated UV transforms
   */
  updateAnimatedUVs(uvs: THREE.Matrix4[]) {
    this.uniforms.animatedUVs.value = uvs;
  }
}

export default M2MaterialNewShaders;
