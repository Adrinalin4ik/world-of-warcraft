import * as THREE from 'three';
import MapLight from '../../world/light/MapLight';

type WDTManagerLiteOptions = {
  camera: THREE.Camera;
  mapId?: number;
  viewDistance?: number;
};

class WDTManagerLite {
  private camera: THREE.Camera;
  private mapLight: MapLight;
  private mapId: number;
  private viewDistance: number;

  // Simple area tracking
  private loadedAreas = new Map<string, THREE.Group>();
  private currentAreas = new Set<string>();

  // Root group
  private root: THREE.Group;

  constructor(options: WDTManagerLiteOptions) {
    this.camera = options.camera;
    this.mapId = options.mapId || 0;
    this.viewDistance = options.viewDistance || 1000;

    // Initialize light system
    this.mapLight = new MapLight();
    this.mapLight.mapId = this.mapId;

    // Create root group
    this.root = new THREE.Group();
    this.root.name = 'WDTManagerLite';
  }

  /**
   * Update the manager (call in render loop)
   */
  update(): void {
    this.updateAreas();
    this.updateLighting();
  }

  /**
   * Get the root group
   */
  getRoot(): THREE.Group {
    return this.root;
  }

  /**
   * Set map ID
   */
  setMapId(mapId: number): void {
    this.mapId = mapId;
    this.mapLight.mapId = mapId;
  }

  /**
   * Update areas based on camera position
   */
  private updateAreas(): void {
    const cameraPos = this.camera.position;
    const areasInRange = Math.ceil(this.viewDistance / 533.333);
    
    const newAreas = new Set<string>();
    
    // Calculate which areas should be loaded
    for (let x = -areasInRange; x <= areasInRange; x++) {
      for (let y = -areasInRange; y <= areasInRange; y++) {
        const areaX = Math.floor((cameraPos.x + 17066.666) / 533.333) + x;
        const areaY = Math.floor((cameraPos.z + 17066.666) / 533.333) + y;
        
        if (areaX >= 0 && areaX < 64 && areaY >= 0 && areaY < 64) {
          newAreas.add(`${areaX}_${areaY}`);
        }
      }
    }

    // Unload areas that are no longer needed
    for (const areaKey of this.currentAreas) {
      if (!newAreas.has(areaKey)) {
        this.unloadArea(areaKey);
      }
    }

    // Load new areas
    for (const areaKey of newAreas) {
      if (!this.currentAreas.has(areaKey)) {
        this.loadArea(areaKey);
      }
    }

    this.currentAreas = newAreas;
  }

  /**
   * Load an area (simple placeholder)
   */
  private loadArea(areaKey: string): void {
    if (this.loadedAreas.has(areaKey)) return;

    const [areaX, areaY] = areaKey.split('_').map(Number);
    
    // Create simple terrain placeholder
    const geometry = new THREE.PlaneGeometry(533.333, 533.333, 8, 8);
    const material = new THREE.MeshBasicMaterial({ 
      color: 0x00ff00, 
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      areaX * 533.333 - 17066.666,
      0,
      areaY * 533.333 - 17066.666
    );
    mesh.name = `Area_${areaKey}`;

    this.root.add(mesh);
    this.loadedAreas.set(areaKey, this.root); // Store reference to root for simplicity
  }

  /**
   * Unload an area
   */
  private unloadArea(areaKey: string): void {
    const mesh = this.root.getObjectByName(`Area_${areaKey}`);
    if (mesh && mesh instanceof THREE.Mesh) {
      this.root.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(mat => mat.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    }
    this.loadedAreas.delete(areaKey);
  }

  /**
   * Update lighting for all areas
   */
  private updateLighting(): void {
    this.mapLight.update(this.camera);
    
    // Simple lighting update - just update the light system
    // Individual materials would handle their own uniform updates
  }

  /**
   * Get loaded area count
   */
  getLoadedAreaCount(): number {
    return this.loadedAreas.size;
  }

  /**
   * Clear all areas
   */
  clear(): void {
    for (const areaKey of this.currentAreas) {
      this.unloadArea(areaKey);
    }
    this.currentAreas.clear();
  }

  /**
   * Dispose of the manager
   */
  dispose(): void {
    this.clear();
    this.root.clear();
  }
}

export default WDTManagerLite;
