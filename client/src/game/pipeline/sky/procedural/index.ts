import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';

/**
 * Procedural Sky implementation (Method 2)
 * 
 * This renders a regular sphere/cube and uses lerp(mix), smoothstep
 * to manually interpolate between input colors using elevation as the blend factor.
 */
class ProceduralSky extends THREE.Mesh {
  private lightData: any = null;
  private uniforms: any = {};
  private mapLight: MapLight | null = null;

  constructor() {
    super();
    this.name = 'ProceduralSky';
    
    // Create the sphere geometry and material
    this.createGeometry();
    this.createMaterial();
    
    // Set up the sphere to be positioned at the camera
    this.position.set(0, 0, 0);
    this.frustumCulled = false; // Always render regardless of camera position
    this.renderOrder = -1000; // Render before everything else
  }

  /**
   * Creates a sphere geometry for the sky dome
   */
  private createGeometry(): void {
    const radius = 2000; // Much larger radius to ensure coverage
    const widthSegments = 32; // Reduced for better performance
    const heightSegments = 16; // Reduced for better performance
    
    const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
    
    // Flip the sphere inside out so we see it from the inside
    geometry.scale(-1, 1, 1);
    
    this.geometry = geometry;
  }

  /**
   * Creates the shader material for procedural sky rendering
   */
  private createMaterial(): void {
    this.uniforms = {
      skyTop: { value: new THREE.Color(0.4, 0.6, 0.9) },
      skyMiddle: { value: new THREE.Color(0.5, 0.7, 0.8) },
      skyBand1: { value: new THREE.Color(0.6, 0.5, 0.4) },
      skyBand2: { value: new THREE.Color(0.7, 0.4, 0.3) },
      skySmog: { value: new THREE.Color(0.8, 0.3, 0.2) },
      skyFog: { value: new THREE.Color(0.9, 0.2, 0.1) },
      sunDirection: { value: new THREE.Vector3(0, 1, 0) },
      time: { value: 0.0 }
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        varying vec3 vWorldPosition;
        varying vec3 vNormal;
        
        void main() {
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 skyTop;
        uniform vec3 skyMiddle;
        uniform vec3 skyBand1;
        uniform vec3 skyBand2;
        uniform vec3 skySmog;
        uniform vec3 skyFog;
        uniform vec3 sunDirection;
        uniform float time;
        
        varying vec3 vWorldPosition;
        varying vec3 vNormal;
        
        // Interpolation stops as specified by the user
        const float SKY_TOP_MAX = 1.0;
        const float SKY_TOP_MIN = 0.714;
        const float SKY_MIDDLE_MAX = 0.714;
        const float SKY_MIDDLE_MIN = 0.547;
        const float SKY_BAND1_MAX = 0.547;
        const float SKY_BAND1_MIN = 0.513;
        const float SKY_BAND2_MAX = 0.513;
        const float SKY_BAND2_MIN = 0.5;
        const float SKY_SMOG_MAX = 0.5;
        const float SKY_SMOG_MIN = 0.486;
        const float SKY_FOG_MAX = 0.486;
        const float SKY_FOG_MIN = 0.0;
        
        // Smooth interpolation function
        float smoothInterpolate(float t, float edge0, float edge1) {
          t = clamp((t - edge0) / (edge1 - edge0), 0.0, 1.0);
          return t * t * (3.0 - 2.0 * t);
        }
        
        // Calculate elevation from fragment direction
        float calculateElevation(vec3 fragDir) {
          vec3 upDir = vec3(0.0, 1.0, 0.0);
          float elevation = dot(fragDir, upDir); // -1 .. 1
          elevation = (1.0 + elevation) / 2.0;  // 0..1
          return elevation;
        }
        
        // Get color for elevation using smooth interpolation
        vec3 getSkyColor(float elevation) {
          // SkyTop - 1 <> 0.714
          if (elevation >= SKY_TOP_MIN && elevation <= SKY_TOP_MAX) {
            float factor = smoothInterpolate(elevation, SKY_TOP_MIN, SKY_TOP_MAX);
            return mix(skyMiddle, skyTop, factor);
          }
          
          // SkyMiddle - 0.714 <> 0.547
          if (elevation >= SKY_MIDDLE_MIN && elevation <= SKY_MIDDLE_MAX) {
            float factor = smoothInterpolate(elevation, SKY_MIDDLE_MIN, SKY_MIDDLE_MAX);
            return mix(skyBand1, skyMiddle, factor);
          }
          
          // SkyBand1 - 0.547 <> 0.513
          if (elevation >= SKY_BAND1_MIN && elevation <= SKY_BAND1_MAX) {
            float factor = smoothInterpolate(elevation, SKY_BAND1_MIN, SKY_BAND1_MAX);
            return mix(skyBand2, skyBand1, factor);
          }
          
          // SkyBand2 - 0.513 <> 0.5
          if (elevation >= SKY_BAND2_MIN && elevation <= SKY_BAND2_MAX) {
            float factor = smoothInterpolate(elevation, SKY_BAND2_MIN, SKY_BAND2_MAX);
            return mix(skySmog, skyBand2, factor);
          }
          
          // SkySmog - 0.5 <> 0.486
          if (elevation >= SKY_SMOG_MIN && elevation <= SKY_SMOG_MAX) {
            float factor = smoothInterpolate(elevation, SKY_SMOG_MIN, SKY_SMOG_MAX);
            return mix(skyFog, skySmog, factor);
          }
          
          // SkyFog - 0.486 <> 0
          if (elevation >= SKY_FOG_MIN && elevation <= SKY_FOG_MAX) {
            float factor = smoothInterpolate(elevation, SKY_FOG_MIN, SKY_FOG_MAX);
            return mix(vec3(0.0, 0.0, 0.0), skyFog, factor);
          }
          
          // Fallback
          return skyFog;
        }
        
        void main() {
          // Calculate fragment direction from world position
          vec3 fragDir = normalize(vWorldPosition);
          
          // Calculate elevation
          float elevation = calculateElevation(fragDir);
          
          // Get sky color based on elevation
          vec3 skyColor = getSkyColor(elevation);
          
          // Add some sun influence based on sun direction
          float sunInfluence = max(0.0, dot(fragDir, sunDirection));
          sunInfluence = pow(sunInfluence, 2.0); // Make it more focused
          
          // Brighten the sky near the sun
          skyColor += vec3(0.1, 0.1, 0.05) * sunInfluence;
          
          gl_FragColor = vec4(skyColor, 1.0);
        }
      `,
      side: THREE.BackSide, // Render from inside
      transparent: false,
      depthWrite: false, // Don't write to depth buffer
      depthTest: false,  // Don't test against depth buffer
    });
    
    this.material = material;
  }

  /**
   * Updates the sky colors based on current light data
   */
  public updateColors(lightData: any): void {
    if (!lightData || !this.uniforms) return;
    
    this.lightData = lightData;
    const skyColors = this.extractSkyColors(lightData);
    
    // Update shader uniforms
    this.uniforms.skyTop.value.copy(skyColors.skyTop);
    this.uniforms.skyMiddle.value.copy(skyColors.skyMiddle);
    this.uniforms.skyBand1.value.copy(skyColors.skyBand1);
    this.uniforms.skyBand2.value.copy(skyColors.skyBand2);
    this.uniforms.skySmog.value.copy(skyColors.skySmog);
    this.uniforms.skyFog.value.copy(skyColors.skyFog);
  }

  /**
   * Extracts sky colors from light data
   * Based on the LightData.db2 structure and the interpolation stops
   */
  private extractSkyColors(lightData: any): any {
    // Default sky colors if no light data is available - made more visible
    const defaultColors = {
      skyTop: new THREE.Color(0.2, 0.4, 0.8),      // Darker blue sky
      skyMiddle: new THREE.Color(0.3, 0.5, 0.7),   // Medium blue
      skyBand1: new THREE.Color(0.8, 0.4, 0.2),    // Bright orange band
      skyBand2: new THREE.Color(0.9, 0.3, 0.1),    // Bright red band
      skySmog: new THREE.Color(0.7, 0.2, 0.1),     // Dark red smog
      skyFog: new THREE.Color(0.5, 0.1, 0.05),     // Very dark red fog
    };

    if (!lightData || !lightData.colors || lightData.colors.length < 18) {
      return defaultColors;
    }

    // Extract colors from LightData.db2
    // Based on the structure: colors[0-17] contain different sky elements
    const colors = lightData.colors;
    
    return {
      skyTop: this.bgraToColor(colors[2] || 0xFF6B9D),      // SkyTop
      skyMiddle: this.bgraToColor(colors[3] || 0xFF8B6B),   // SkyMiddle  
      skyBand1: this.bgraToColor(colors[4] || 0xFF9B4B),    // SkyBand1
      skyBand2: this.bgraToColor(colors[5] || 0xFFAB3B),    // SkyBand2
      skySmog: this.bgraToColor(colors[6] || 0xFFBB2B),     // SkySmog
      skyFog: this.bgraToColor(colors[7] || 0xFFCB1B),      // SkyFog
    };
  }

  /**
   * Converts BGRA integer color to THREE.Color
   */
  private bgraToColor(bgra: number): THREE.Color {
    const r = ((bgra >> 16) & 0xFF) / 255.0;
    const g = ((bgra >> 8) & 0xFF) / 255.0;
    const b = (bgra & 0xFF) / 255.0;
    return new THREE.Color(r, g, b);
  }

  /**
   * Updates the sky based on current lighting conditions
   */
  public update(camera: THREE.Camera, mapID: number): void {
    // Position the sphere at the camera position
    this.position.copy(camera.position);
    
    // Make sure the sphere is always visible
    this.visible = true;
    
    // Update sun direction from MapLight
    if (this.mapLight) {
      this.uniforms.sunDirection.value.copy(this.mapLight.sunDir);
    }
    
    // Update time for potential animation
    this.uniforms.time.value = this.mapLight?.timeProgression || 0.0;
    
    // Update colors if we have light data
    if (this.mapLight) {
      // For now, use default colors until we implement proper light data access
      this.setDefaultColors();
    }
  }

  /**
   * Set default colors for the procedural sky
   */
  setDefaultColors(): void {
    // Set default sky colors
    this.uniforms.topColor.value.setHex(0x87CEEB); // Sky blue
    this.uniforms.bottomColor.value.setHex(0xE0F6FF); // Light blue
    this.uniforms.sunColor.value.setHex(0xFFFF00); // Yellow sun
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    
    // Update colors if we have light data
    if (this.mapLight) {
      // For now, use default colors until we implement proper light data access
      this.setDefaultColors();
    }
  }

  /**
   * Disposes of the procedural sky resources
   */
  public dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.material) {
      if (Array.isArray(this.material)) {
        this.material.forEach(material => material.dispose());
      } else {
        this.material.dispose();
      }
    }
  }
}

export default ProceduralSky;
