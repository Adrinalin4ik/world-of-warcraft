import * as THREE from 'three';
import MapLight from '../../world/light/MapLight';
import WDT from './index';

type WDTManagerOptions = {
  camera: THREE.Camera;
  mapId?: number;
  viewDistance?: number;
  detailDistance?: number;
};

type MapArea = {
  id: number;
  areaX: number;
  areaY: number;
  chunkX: number;
  chunkY: number;
  loaded: boolean;
  loading: boolean;
  group: THREE.Group;
  terrain?: THREE.Mesh;
  doodads?: THREE.Group;
  wmo?: THREE.Group;
};

type MapSpec = {
  name: string;
  flags: number;
  tiles: number[];
  wmoRefs?: any[];
};

class WDTManager {
  private camera: THREE.Camera;
  private mapLight: MapLight;
  private mapId: number;
  private viewDistance: number;
  private detailDistance: number;

  // Map data
  private mapSpec: MapSpec | null = null;
  private mapPath: string = '';
  private root: THREE.Group;

  // Area management
  private areas = new Map<number, MapArea>();
  private loadingAreas = new Map<number, Promise<MapArea>>();
  private loadedAreas = new Map<number, MapArea>();

  // Culling
  private cullingProjection = new THREE.Matrix4();
  private cullingFrustum = new THREE.Frustum();
  private target = new THREE.Vector2();
  private targetAreaX: number = 0;
  private targetAreaY: number = 0;
  private targetChunkX: number = 0;
  private targetChunkY: number = 0;
  private targetArea: MapArea | null = null;
  private targetAreaTableId: number = 0;

  // Desired areas for loading
  private desiredAreas = new Set<number>();

  constructor(options: WDTManagerOptions) {

    this.camera = options.camera;
    this.mapId = options.mapId || 0;
    this.viewDistance = options.viewDistance || 1000;
    this.detailDistance = options.detailDistance || 500;

    // Initialize light system
    this.mapLight = new MapLight();
    this.mapLight.mapId = this.mapId;

    // Create root group
    this.root = new THREE.Group();
    this.root.name = 'WDTManager';

    // Update culling matrices
    this.updateCullingMatrices();
  }

  /**
   * Load a map by name
   */
  async loadMap(mapName: string): Promise<void> {
    this.mapPath = `World\\Maps\\${mapName}\\${mapName}.wdt`;
    
    try {
      const wdt = await WDT.load(this.mapPath);
      this.mapSpec = {
        name: mapName,
        flags: wdt.data.flags,
        tiles: wdt.data.tiles,
        wmoRefs: wdt.data.MWMO?.refs || []
      };

      this.emit('mapLoaded', { mapName, mapSpec: this.mapSpec });
    } catch (error) {
      console.error('Failed to load map:', error);
      throw error;
    }
  }

  /**
   * Update the manager (call in render loop)
   */
  update(): void {
    this.updateCullingMatrices();
    this.updateTargetArea();
    this.updateDesiredAreas();
    this.loadDesiredAreas();
    this.unloadDistantAreas();
    this.cullAreas();
    this.updateLighting();
  }

  /**
   * Get the root group for adding to scene
   */
  getRoot(): THREE.Group {
    return this.root;
  }

  /**
   * Set the map ID for light data
   */
  setMapId(mapId: number): void {
    this.mapId = mapId;
    this.mapLight.mapId = mapId;
  }

  /**
   * Set view distance
   */
  setViewDistance(distance: number): void {
    this.viewDistance = distance;
  }

  /**
   * Set detail distance
   */
  setDetailDistance(distance: number): void {
    this.detailDistance = distance;
  }

  /**
   * Get current map specification
   */
  getMapSpec(): MapSpec | null {
    return this.mapSpec;
  }

  /**
   * Get loaded areas
   */
  getLoadedAreas(): Map<number, MapArea> {
    return this.loadedAreas;
  }

  /**
   * Get area by ID
   */
  getArea(areaId: number): MapArea | undefined {
    return this.areas.get(areaId);
  }

  /**
   * Update culling matrices
   */
  private updateCullingMatrices(): void {
    this.cullingProjection.copy(this.camera.projectionMatrix);
    this.cullingFrustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.cullingProjection, this.camera.matrixWorldInverse)
    );
  }

  /**
   * Update target area based on camera position
   */
  private updateTargetArea(): void {
    const cameraPosition = this.camera.position;
    
    // Convert world position to area coordinates
    this.targetAreaX = Math.floor((cameraPosition.x + 17066.666) / 533.333);
    this.targetAreaY = Math.floor((cameraPosition.z + 17066.666) / 533.333);
    
    // Convert to chunk coordinates
    this.targetChunkX = Math.floor((cameraPosition.x + 17066.666) / 33.333);
    this.targetChunkY = Math.floor((cameraPosition.z + 17066.666) / 33.333);
    
    // Get area ID
    const areaId = this.getAreaId(this.targetAreaX, this.targetAreaY);
    this.targetArea = this.areas.get(areaId) || null;
    this.targetAreaTableId = areaId;
  }

  /**
   * Update desired areas based on view distance
   */
  private updateDesiredAreas(): void {
    this.desiredAreas.clear();
    
    if (!this.mapSpec) return;

    const areasInRange = Math.ceil(this.viewDistance / 533.333);
    
    for (let x = -areasInRange; x <= areasInRange; x++) {
      for (let y = -areasInRange; y <= areasInRange; y++) {
        const areaX = this.targetAreaX + x;
        const areaY = this.targetAreaY + y;
        
        if (areaX >= 0 && areaX < 64 && areaY >= 0 && areaY < 64) {
          const areaId = this.getAreaId(areaX, areaY);
          const tileIndex = areaY * 64 + areaX;
          
          // Check if tile exists in WDT
          if (this.mapSpec.tiles[tileIndex] !== 0) {
            this.desiredAreas.add(areaId);
          }
        }
      }
    }
  }

  /**
   * Load desired areas
   */
  private loadDesiredAreas(): void {
    for (const areaId of this.desiredAreas) {
      if (!this.loadedAreas.has(areaId) && !this.loadingAreas.has(areaId)) {
        this.loadArea(areaId);
      }
    }
  }

  /**
   * Unload distant areas
   */
  private unloadDistantAreas(): void {
    for (const [areaId, area] of this.loadedAreas) {
      if (!this.desiredAreas.has(areaId)) {
        this.unloadArea(areaId);
      }
    }
  }

  /**
   * Cull areas based on frustum
   */
  private cullAreas(): void {
    for (const [areaId, area] of this.loadedAreas) {
      if (area.group) {
        const visible = this.cullingFrustum.intersectsObject(area.group);
        area.group.visible = visible;
      }
    }
  }

  /**
   * Update lighting for all areas
   */
  private updateLighting(): void {
    this.mapLight.update(this.camera);
    
    // Update lighting for all loaded areas
    for (const [areaId, area] of this.loadedAreas) {
      if (area.terrain) {
        this.updateAreaLighting(area);
      }
    }
  }

  /**
   * Update lighting for a specific area
   */
  private updateAreaLighting(area: MapArea): void {
    if (!area.terrain) return;

    const material = area.terrain.material as THREE.ShaderMaterial;
    if (material && material.uniforms) {
      // Update light uniforms
      const lightUniforms = this.mapLight.uniforms;
      
      if (material.uniforms.sunDir) {
        material.uniforms.sunDir.value = lightUniforms.sunDir.value;
      }
      if (material.uniforms.sunDiffuseColor) {
        material.uniforms.sunDiffuseColor.value = lightUniforms.sunDiffuseColor.value;
      }
      if (material.uniforms.sunAmbientColor) {
        material.uniforms.sunAmbientColor.value = lightUniforms.sunAmbientColor.value;
      }
      if (material.uniforms.fogParams) {
        material.uniforms.fogParams.value = lightUniforms.fogParams.value;
      }
      if (material.uniforms.fogColor) {
        material.uniforms.fogColor.value = lightUniforms.fogColor.value;
      }
    }
  }

  /**
   * Load an area
   */
  private async loadArea(areaId: number): Promise<MapArea> {
    const loading = this.loadingAreas.get(areaId);
    if (loading) {
      return loading;
    }

    const promise = this._loadArea(areaId);
    this.loadingAreas.set(areaId, promise);
    
    try {
      const area = await promise;
      this.loadedAreas.set(areaId, area);
      this.emit('areaLoaded', { areaId, area });
      return area;
    } finally {
      this.loadingAreas.delete(areaId);
    }
  }

  /**
   * Internal area loading
   */
  private async _loadArea(areaId: number): Promise<MapArea> {
    const { areaX, areaY } = this.getAreaIndex(areaId);
    
    const area: MapArea = {
      id: areaId,
      areaX,
      areaY,
      chunkX: areaX * 16,
      chunkY: areaY * 16,
      loaded: false,
      loading: true,
      group: new THREE.Group()
    };

    area.group.name = `Area_${areaX}_${areaY}`;
    this.root.add(area.group);

    // Load terrain
    try {
      area.terrain = await this.loadAreaTerrain(areaX, areaY);
      if (area.terrain) {
        area.group.add(area.terrain);
      }
    } catch (error) {
      console.warn(`Failed to load terrain for area ${areaX},${areaY}:`, error);
    }

    // Load doodads
    try {
      area.doodads = await this.loadAreaDoodads(areaX, areaY);
      if (area.doodads) {
        area.group.add(area.doodads);
      }
    } catch (error) {
      console.warn(`Failed to load doodads for area ${areaX},${areaY}:`, error);
    }

    // Load WMO
    try {
      area.wmo = await this.loadAreaWMO(areaX, areaY);
      if (area.wmo) {
        area.group.add(area.wmo);
      }
    } catch (error) {
      console.warn(`Failed to load WMO for area ${areaX},${areaY}:`, error);
    }

    area.loaded = true;
    area.loading = false;
    this.areas.set(areaId, area);

    return area;
  }

  /**
   * Load terrain for an area
   */
  private async loadAreaTerrain(areaX: number, areaY: number): Promise<THREE.Mesh | null> {
    // This would load the actual terrain mesh
    // For now, return a placeholder
    const geometry = new THREE.PlaneGeometry(533.333, 533.333, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
    const mesh = new THREE.Mesh(geometry, material);
    
    mesh.position.set(
      areaX * 533.333 - 17066.666,
      0,
      areaY * 533.333 - 17066.666
    );
    
    return mesh;
  }

  /**
   * Load doodads for an area
   */
  private async loadAreaDoodads(areaX: number, areaY: number): Promise<THREE.Group | null> {
    // This would load doodads for the area
    // For now, return null
    return null;
  }

  /**
   * Load WMO for an area
   */
  private async loadAreaWMO(areaX: number, areaY: number): Promise<THREE.Group | null> {
    // This would load WMO objects for the area
    // For now, return null
    return null;
  }

  /**
   * Unload an area
   */
  private unloadArea(areaId: number): void {
    const area = this.loadedAreas.get(areaId);
    if (!area) return;

    if (area.group) {
      this.root.remove(area.group);
      area.group.clear();
    }

    this.loadedAreas.delete(areaId);
    this.areas.delete(areaId);
    
    this.emit('areaUnloaded', { areaId });
  }

  /**
   * Get area ID from coordinates
   */
  private getAreaId(areaX: number, areaY: number): number {
    return areaY * 64 + areaX;
  }

  /**
   * Get area coordinates from ID
   */
  private getAreaIndex(areaId: number): { areaX: number; areaY: number } {
    return {
      areaX: areaId % 64,
      areaY: Math.floor(areaId / 64)
    };
  }

  /**
   * Emit event (placeholder for future event system)
   */
  private emit(eventName: string, data?: any): void {
    // TODO: Implement proper event system
    console.log(`WDTManager event: ${eventName}`, data);
  }

  /**
   * Dispose of the manager
   */
  dispose(): void {
    // Unload all areas
    for (const areaId of this.loadedAreas.keys()) {
      this.unloadArea(areaId);
    }

    // Clear root group
    this.root.clear();
  }
}

export default WDTManager;
