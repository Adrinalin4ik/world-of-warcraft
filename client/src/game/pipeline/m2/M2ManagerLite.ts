import * as THREE from 'three';
import { M2LightIntegration } from '../../world/light/M2LightIntegration';
import M2MaterialLite from './material/M2MaterialLite';

type M2ManagerLiteOptions = {
  camera: THREE.Camera;
  mapId?: number;
  viewDistance?: number;
};

type M2Instance = {
  id: string;
  mesh: THREE.Mesh;
  material: M2MaterialLite;
  position: THREE.Vector3;
  visible: boolean;
};

class M2ManagerLite {
  private camera: THREE.Camera;
  private m2LightIntegration: M2LightIntegration;
  private mapId: number;
  private viewDistance: number;

  // Simple instance tracking
  private instances = new Map<string, M2Instance>();
  private root: THREE.Group;

  constructor(options: M2ManagerLiteOptions) {
    this.camera = options.camera;
    this.mapId = options.mapId || 0;
    this.viewDistance = options.viewDistance || 1000;

    // Initialize light system
    this.m2LightIntegration = new M2LightIntegration(this.camera, this.mapId);

    // Create root group
    this.root = new THREE.Group();
    this.root.name = 'M2ManagerLite';
  }

  /**
   * Update the manager (call in render loop)
   */
  update(): void {
    this.updateLighting();
    this.cullInstances();
  }

  /**
   * Get the root group
   */
  getRoot(): THREE.Group {
    return this.root;
  }

  /**
   * Add an M2 instance
   */
  addInstance(id: string, geometry: THREE.BufferGeometry, texture?: THREE.Texture, position?: THREE.Vector3): M2Instance {
    // Create simple material
    const material = new M2MaterialLite({
      camera: this.camera,
      mapId: this.mapId,
      texture: texture,
      color: new THREE.Color(0.5, 0.5, 0.5)
    });

    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position || new THREE.Vector3());
    mesh.name = `M2_${id}`;

    // Create instance
    const instance: M2Instance = {
      id,
      mesh,
      material,
      position: mesh.position.clone(),
      visible: true
    };

    this.instances.set(id, instance);
    this.root.add(mesh);

    return instance;
  }

  /**
   * Remove an M2 instance
   */
  removeInstance(id: string): void {
    const instance = this.instances.get(id);
    if (instance) {
      this.root.remove(instance.mesh);
      
      // Dispose of resources
      if (instance.mesh.geometry) {
        instance.mesh.geometry.dispose();
      }
      if (instance.material) {
        instance.material.dispose();
      }
      
      this.instances.delete(id);
    }
  }

  /**
   * Get an M2 instance
   */
  getInstance(id: string): M2Instance | undefined {
    return this.instances.get(id);
  }

  /**
   * Set instance position
   */
  setInstancePosition(id: string, position: THREE.Vector3): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.mesh.position.copy(position);
      instance.position.copy(position);
    }
  }

  /**
   * Set instance visibility
   */
  setInstanceVisibility(id: string, visible: boolean): void {
    const instance = this.instances.get(id);
    if (instance) {
      instance.mesh.visible = visible;
      instance.visible = visible;
    }
  }

  /**
   * Set instance material properties
   */
  setInstanceMaterial(id: string, properties: {
    color?: THREE.Color;
    alpha?: number;
    texture?: THREE.Texture;
  }): void {
    const instance = this.instances.get(id);
    if (instance) {
      if (properties.color) {
        instance.material.setColor(properties.color);
      }
      if (properties.alpha !== undefined) {
        instance.material.setAlpha(properties.alpha);
      }
      if (properties.texture) {
        instance.material.setTexture(properties.texture);
      }
    }
  }

  /**
   * Set map ID
   */
  setMapId(mapId: number): void {
    this.mapId = mapId;
    this.m2LightIntegration.setMapId(mapId);
    
    // Update all instance materials
    for (const instance of this.instances.values()) {
      instance.material.setMapId(mapId);
    }
  }

  /**
   * Set lighting context
   */
  setLightingContext(location: 'exterior' | 'interior'): void {
    this.m2LightIntegration.setLocation(location);
    
    // Update all instance materials
    for (const instance of this.instances.values()) {
      instance.material.setLightLocation(location);
    }
  }

  /**
   * Set time of day
   */
  setTimeOfDay(time: number): void {
    this.m2LightIntegration.setTimeOverride(time);
    
    // Update all instance materials
    for (const instance of this.instances.values()) {
      instance.material.setTimeOverride(time);
    }
  }

  /**
   * Update lighting for all instances
   */
  private updateLighting(): void {
    this.m2LightIntegration.update();
    
    // Update all instance materials
    for (const instance of this.instances.values()) {
      instance.material.updateLightUniforms();
    }
  }

  /**
   * Cull instances based on distance
   */
  private cullInstances(): void {
    const cameraPosition = this.camera.position;
    
    for (const instance of this.instances.values()) {
      const distance = cameraPosition.distanceTo(instance.position);
      const shouldBeVisible = distance <= this.viewDistance;
      
      if (instance.visible !== shouldBeVisible) {
        instance.mesh.visible = shouldBeVisible;
        instance.visible = shouldBeVisible;
      }
    }
  }

  /**
   * Get instance count
   */
  getInstanceCount(): number {
    return this.instances.size;
  }

  /**
   * Get visible instance count
   */
  getVisibleInstanceCount(): number {
    let count = 0;
    for (const instance of this.instances.values()) {
      if (instance.visible) count++;
    }
    return count;
  }

  /**
   * Clear all instances
   */
  clear(): void {
    for (const id of this.instances.keys()) {
      this.removeInstance(id);
    }
  }

  /**
   * Dispose of the manager
   */
  dispose(): void {
    this.clear();
    this.root.clear();
  }
}

export default M2ManagerLite;


