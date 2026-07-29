import * as THREE from 'three';
import MapLight from '../../../world/light/MapLight';
import DBC from '../../dbc';

/**
 * Skybox implementation using LightSkybox DBC
 * 
 * This creates a traditional skybox using cube textures from the LightSkybox DBC.
 * The skybox is positioned at the camera and rotates with it.
 */
class Skybox extends THREE.Mesh {
  private lightData: any = null;
  private skyboxID: number | null = null;
  private textures: THREE.CubeTexture | null = null;
  private mapLight: MapLight | null = null;

  constructor() {
    super();
    this.name = 'Skybox';
    
    // Create the skybox geometry and material
    this.createGeometry();
    this.createMaterial();
    
    // Set up the skybox to be positioned at the camera
    this.position.set(0, 0, 0);
    this.frustumCulled = false; // Always render regardless of camera position
    this.renderOrder = -1000; // Render before everything else
    
    // Apply the same rotation as the working skybox implementation
    this.rotation.set(
      -Math.PI / 2,
      Math.PI,
      Math.PI,
    );
    
    // Ensure skybox is always visible and not affected by visibility manager
    this.visible = true;
    this.matrixAutoUpdate = false; // Don't auto-update matrix
  }

  /**
   * Creates a large box geometry for the skybox
   */
  private createGeometry(): void {
    const size = 2000; // Large size to cover the entire view
    const geometry = new THREE.BoxGeometry(size, size, size);
    
    // Don't flip the geometry - we'll handle orientation with rotation
    this.geometry = geometry;
  }

  /**
   * Creates the skybox material
   */
  private createMaterial(): void {
    // Create materials for each face with different colors for testing
    const materials = [
      new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide }), // Right - Red
      new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide }), // Left - Green
      new THREE.MeshBasicMaterial({ color: 0x0000ff, side: THREE.DoubleSide }), // Top - Blue
      new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide }), // Bottom - Yellow
      new THREE.MeshBasicMaterial({ color: 0xff00ff, side: THREE.DoubleSide }), // Front - Magenta
      new THREE.MeshBasicMaterial({ color: 0x00ffff, side: THREE.DoubleSide }), // Back - Cyan
    ];
    
    this.material = materials;
    console.log('Skybox material created with 6 different colors for testing');
  }

  /**
   * Creates a cube texture from an array of colors
   */
  private createCubeTextureFromColors(colors: THREE.Color[]): THREE.CubeTexture {
    const size = 1;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d')!;
    
    const cubeTexture = new THREE.CubeTexture();
    cubeTexture.format = THREE.RGBAFormat;
    cubeTexture.type = THREE.UnsignedByteType;
    
    const images: HTMLImageElement[] = [];
    
    for (let i = 0; i < 6; i++) {
      const color = colors[i] || new THREE.Color(0.5, 0.5, 0.5);
      
      // Fill canvas with color
      context.fillStyle = `rgb(${Math.floor(color.r * 255)}, ${Math.floor(color.g * 255)}, ${Math.floor(color.b * 255)})`;
      context.fillRect(0, 0, size, size);
      
      // Create image from canvas
      const image = new Image();
      image.src = canvas.toDataURL();
      images.push(image);
    }
    
    cubeTexture.images = images;
    cubeTexture.needsUpdate = true;
    
    return cubeTexture;
  }

  /**
   * Loads skybox textures from LightSkybox DBC
   */
  private async loadSkyboxTextures(skyboxID: number): Promise<void> {
    try {
      // Load LightSkybox DBC
      const lightSkyboxDBC = await DBC.load('LightSkybox');
      const skyboxRecord = lightSkyboxDBC[skyboxID];
      
      if (!skyboxRecord || !skyboxRecord.file) {
        console.warn(`No skybox record found for ID: ${skyboxID}`);
        console.log('Available skybox IDs:', Object.keys(lightSkyboxDBC));
        console.log('Using fallback colors instead');
        return;
      }
      
      console.log(`Loading skybox ID ${skyboxID}: ${skyboxRecord.file}`);
      
      // Check if the file is a texture (not .mdx)
      if (skyboxRecord.file.endsWith('.mdx')) {
        console.warn(`Skybox ID ${skyboxID} points to .mdx file, not texture: ${skyboxRecord.file}`);
        console.log('MDX files are 3D models, not textures. Using fallback colors instead.');
        return;
      }
      
      // For now, skip texture loading and use fallback colors
      console.log('Texture loading disabled for debugging. Using fallback colors.');
      return;
      
    } catch (error) {
      console.warn('Failed to load LightSkybox.dbc:', error);
      console.log('Using fallback colors instead');
    }
  }

  /**
   * Updates the skybox based on current lighting conditions
   */
  public update(camera: THREE.Camera, mapID: number): void {
    // Position skybox at camera position so it follows the camera
    this.position.copy(camera.position);
    
    // Force skybox to be visible - override any visibility manager changes
    this.visible = true;
    this.frustumCulled = false;
    
    // Update skybox if we have light data
    if (this.mapLight) {
      // For now, use default skybox until we implement proper light data access
      this.updateSkybox(null);
    }
  }

  /**
   * Set the map light system
   */
  setMapLight(mapLight: MapLight): void {
    this.mapLight = mapLight;
    
    // Update skybox if we have light data
    if (this.mapLight) {
      // For now, use default skybox until we implement proper light data access
      this.updateSkybox(null);
    }
  }

  /**
   * Updates the skybox based on light data
   */
  private updateSkybox(lightData: any): void {
    if (!lightData || !lightData.params) return;
    
    const skyboxID = lightData.params.lightSkyboxID;

    // Only load new skybox if the ID has changed
    if (skyboxID !== null && skyboxID !== undefined && skyboxID !== this.skyboxID) {
      this.skyboxID = skyboxID;
      this.loadSkyboxTextures(skyboxID);
    }
  }

  /**
   * Disposes of the skybox resources
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
    if (this.textures) {
      this.textures.dispose();
    }
  }
}

export default Skybox;
