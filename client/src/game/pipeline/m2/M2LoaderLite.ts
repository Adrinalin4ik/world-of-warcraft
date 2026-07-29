import * as THREE from 'three';
import Loader from '../../net/loader';

type M2DataLite = {
  name: string;
  vertices: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  textures: string[];
  materials: any[];
};

type M2LoadOptions = {
  cache?: boolean;
  timeout?: number;
};

class M2LoaderLite {
  private loader: Loader;
  private cache = new Map<string, M2DataLite>();

  constructor() {
    this.loader = new Loader();
  }

  /**
   * Load M2 data from path (simplified)
   */
  async load(path: string, options: M2LoadOptions = {}): Promise<M2DataLite> {
    // Check cache first
    if (options.cache !== false && this.cache.has(path)) {
      return this.cache.get(path)!;
    }

    try {
      // For now, create a simple placeholder M2 data
      // In a real implementation, this would parse the actual M2 file
      const data = this.createPlaceholderM2Data(path);
      
      // Cache the result
      if (options.cache !== false) {
        this.cache.set(path, data);
      }
      
      return data;
    } catch (error) {
      console.error(`Failed to load M2 from ${path}:`, error);
      throw error;
    }
  }

  /**
   * Create placeholder M2 data for testing
   */
  private createPlaceholderM2Data(path: string): M2DataLite {
    // Create a simple cube geometry as placeholder
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    
    // Safely extract array data with type checking
    const positionAttr = geometry.attributes.position as THREE.BufferAttribute;
    const normalAttr = geometry.attributes.normal as THREE.BufferAttribute;
    const uvAttr = geometry.attributes.uv as THREE.BufferAttribute;
    
    return {
      name: path.split('/').pop() || 'unknown',
      vertices: positionAttr.array as Float32Array,
      normals: normalAttr.array as Float32Array,
      uvs: uvAttr.array as Float32Array,
      indices: geometry.index ? (geometry.index.array as Uint16Array) : new Uint16Array(),
      textures: ['placeholder_texture'],
      materials: [{
        diffuse: new THREE.Color(0.5, 0.5, 0.5),
        specular: new THREE.Color(0.1, 0.1, 0.1),
        shininess: 32
      }]
    };
  }

  /**
   * Create geometry from M2 data
   */
  createGeometry(data: M2DataLite): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    
    geometry.setAttribute('position', new THREE.BufferAttribute(data.vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    
    if (data.indices.length > 0) {
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    }
    
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    
    return geometry;
  }

  /**
   * Create material from M2 data
   */
  createMaterial(data: M2DataLite, materialIndex: number = 0): THREE.MeshBasicMaterial {
    const materialData = data.materials[materialIndex] || data.materials[0];
    
    return new THREE.MeshBasicMaterial({
      color: materialData.diffuse || new THREE.Color(0.5, 0.5, 0.5),
      transparent: true,
      opacity: 0.8
    });
  }

  /**
   * Get texture paths from M2 data
   */
  getTexturePaths(data: M2DataLite): string[] {
    return data.textures || [];
  }

  /**
   * Get material count
   */
  getMaterialCount(data: M2DataLite): number {
    return data.materials.length;
  }

  /**
   * Check if M2 has animations
   */
  hasAnimations(data: M2DataLite): boolean {
    // Simplified check - in real implementation would check animation data
    return false;
  }

  /**
   * Get bounding box from M2 data
   */
  getBoundingBox(data: M2DataLite): THREE.Box3 {
    const geometry = this.createGeometry(data);
    const box = new THREE.Box3();
    box.setFromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute);
    geometry.dispose();
    return box;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Preload M2 data
   */
  async preload(paths: string[]): Promise<void> {
    const promises = paths.map(path => this.load(path));
    await Promise.all(promises);
  }
}

export default M2LoaderLite;
