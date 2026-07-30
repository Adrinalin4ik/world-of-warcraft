import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';

/**
 * Sky Cone implementation following the Blizzard method (Method 1)
 * 
 * This generates a mesh at runtime that looks like an inverted cone,
 * with vertex colors set based on LightData.db2 values, allowing
 * automatic color blending by the shader.
 */
class SkyCone extends THREE.Mesh {
  private lightData: any = null;
  private isInitialized: boolean = false;
  private mapLight: MapLight | null = null;

  constructor() {
    super();
    this.name = 'SkyCone';
    
    // Create the cone geometry and material
    this.createGeometry();
    this.createMaterial();
    
    // Set up the cone to be positioned at the camera
    this.position.set(0, 0, 0);
    this.frustumCulled = false; // Always render regardless of camera position
    this.renderOrder = -1000; // Render before everything else
  }

  /**
   * Creates the inverted cone geometry with proper subdivisions
   * Based on the reference image showing a dense mesh at the top
   */
  private createGeometry(): void {
    const radius = 2000; // Much larger radius to ensure coverage
    const height = 2000; // Much larger height
    const radialSegments = 32; // Reduced for better performance
    const heightSegments = 16; // Reduced for better performance
    
    const geometry = new THREE.ConeGeometry(radius, height, radialSegments, heightSegments);
    
    // Invert the cone (apex at bottom, base at top)
    geometry.rotateX(Math.PI);
    
    // Move the cone so the base is at the top and apex is below camera
    geometry.translate(0, height / 2, 0);
    
    // Add color attribute for vertex colors
    const colorAttribute = new THREE.BufferAttribute(
      new Float32Array(geometry.attributes.position.count * 3), 
      3
    );
    geometry.setAttribute('color', colorAttribute);
    
    this.geometry = geometry;
  }

  /**
   * Creates the shader material for the sky cone
   */
  private createMaterial(): void {
    const material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vColor;
        varying vec3 vWorldPosition;
        
        void main() {
          vColor = color;
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying vec3 vWorldPosition;
        
        void main() {
          gl_FragColor = vec4(vColor, 1.0);
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
   * Updates the sky cone colors based on current light data
   */
  public updateColors(lightData: any): void {
    if (!lightData || !this.geometry) return;
    
    this.lightData = lightData;
    const colorAttribute = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const positionAttribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    
    // Get sky colors from light data
    const skyColors = this.extractSkyColors(lightData);
    
    // Update vertex colors based on elevation
    for (let i = 0; i < positionAttribute.count; i++) {
      const y = positionAttribute.getY(i);
      const elevation = this.calculateElevation(y);
      const color = this.getColorForElevation(elevation, skyColors);
      
      colorAttribute.setXYZ(i, color.r, color.g, color.b);
    }
    
    colorAttribute.needsUpdate = true;
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
   * Calculates elevation factor from Y position
   * Converts from -1..1 range to 0..1 range
   */
  private calculateElevation(y: number): number {
    // Normalize Y position to elevation factor
    // Y = 0 is the base (top of cone), Y = -height is the apex (bottom)
    const normalizedY = (y + 500) / 1000; // Normalize to 0..1
    return Math.max(0, Math.min(1, normalizedY));
  }

  /**
   * Gets the appropriate color for a given elevation
   * Based on the interpolation stops from the user's specification
   */
  private getColorForElevation(elevation: number, skyColors: any): THREE.Color {
    // Interpolation stops as specified by the user
    const stops = {
      skyTop: { min: 1.0, max: 0.714 },
      skyMiddle: { min: 0.714, max: 0.547 },
      skyBand1: { min: 0.547, max: 0.513 },
      skyBand2: { min: 0.513, max: 0.5 },
      skySmog: { min: 0.5, max: 0.486 },
      skyFog: { min: 0.486, max: 0.0 }
    };

    // Find which band this elevation falls into
    for (const [bandName, range] of Object.entries(stops)) {
      if (elevation >= range.max && elevation <= range.min) {
        // Calculate interpolation factor within this band
        const bandRange = range.min - range.max;
        const factor = bandRange > 0 ? (elevation - range.max) / bandRange : 0;
        
        // Get the color for this band
        const color = skyColors[bandName];
        
        // For now, return the base color (we could add smooth interpolation between bands)
        return color;
      }
    }

    // Fallback to sky fog color
    return skyColors.skyFog;
  }

  /**
   * Updates the sky cone based on current lighting conditions
   */
  public update(camera: THREE.Camera, mapID: number): void {
    // Position the cone at the camera position
    this.position.copy(camera.position);
    
    // Make sure the cone is always visible
    this.visible = true;
    
    // Update colors if we have light data
    if (this.mapLight) {
      // For now, use default colors until we implement proper light data access
      this.setDefaultColors();
    } else {
      // Set default colors if no light data
      this.setDefaultColors();
    }
  }

  /**
   * Sets default sky colors for testing
   */
  private setDefaultColors(): void {
    if (!this.geometry) return;
    
    const colorAttribute = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const positionAttribute = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    
    // Set default colors based on Y position
    for (let i = 0; i < positionAttribute.count; i++) {
      const y = positionAttribute.getY(i);
      const normalizedY = (y + 1000) / 2000; // Normalize to 0..1
      
      let color: THREE.Color;
      if (normalizedY > 0.7) {
        color = new THREE.Color(0.2, 0.4, 0.8); // Darker blue sky
      } else if (normalizedY > 0.5) {
        color = new THREE.Color(0.8, 0.4, 0.2); // Bright orange band
      } else if (normalizedY > 0.3) {
        color = new THREE.Color(0.9, 0.3, 0.1); // Bright red band
      } else {
        color = new THREE.Color(0.7, 0.2, 0.1); // Dark red smog
      }
      
      colorAttribute.setXYZ(i, color.r, color.g, color.b);
    }
    
    colorAttribute.needsUpdate = true;
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
   * Disposes of the sky cone resources
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

export default SkyCone;
