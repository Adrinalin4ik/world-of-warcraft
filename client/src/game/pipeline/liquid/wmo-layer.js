import * as THREE from 'three';

import LiquidType from './type';

class WMOLiquidLayer extends THREE.Mesh {

  constructor(data) {
    super();

    this.data = data;

    // WMO liquids don't use ADT chunk units - they use their own coordinate system
    // The liquidCorner provides the base position for the liquid grid
    const { liquidCorner, liquidVerts, liquidTiles, vertices, tiles } = this.data;
    
    const vertexCount = liquidVerts.x * liquidVerts.y;
    const perRow = liquidVerts.x;

    // Position the liquid mesh at the liquid corner
    // Note: WMO coordinates might need transformation similar to ADT chunks
    // For now, using direct coordinates - may need adjustment based on testing
    this.position.set(liquidCorner[0], liquidCorner[2], liquidCorner[1]);

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);

    // Create vertex positions from MLIQ vertex data
    vertices.forEach((vertex, index) => {
      const y = Math.floor(index / perRow);
      const x = index % perRow;

      // WMO liquid coordinates are in world space
      // Increase tile size to make water patterns less dense and more natural
      // Original spec: 33.33333 / 8 = 4.16667, but we'll use larger tiles for better appearance
      const tileSize = 12.0;
      
      positions[index * 3] = x * tileSize;
      positions[index * 3 + 1] = y * tileSize;
      positions[index * 3 + 2] = vertex.height;
      
      // Debug: Check for unusual height values that might cause rendering artifacts
      if (vertex.height === 0 || vertex.height === 1 || Math.abs(vertex.height) > 1000) {
        console.log(`WMO Unusual height at vertex ${index} (${x},${y}): ${vertex.height}`);
      }

      // Scale UV coordinates to make texture patterns larger and less dense
      uvs[index * 2] = (x / (liquidVerts.x - 1)) * 0.3;
      uvs[index * 2 + 1] = (y / (liquidVerts.y - 1)) * 0.3;
      
      // Set default water color (more accurate blue-green)
      colors[index * 3] = 0.3;     // Red
      colors[index * 3 + 1] = 0.6; // Green  
      colors[index * 3 + 2] = 0.9; // Blue
      
      // Use alpha from vertex data if available, otherwise default to less transparent
      alphas[index] = this.data.vertexData && this.data.vertexData.alphas ? 
        Math.max(this.data.vertexData.alphas[index] / 255.0, 0.8) : 0.9;
    });

    // Create indices for filled tiles
    const indices = new Uint32Array(liquidTiles.x * liquidTiles.y * 6);
    let faceIndex = 0;

    for (let y = 0; y < liquidTiles.y; ++y) {
      for (let x = 0; x < liquidTiles.x; ++x) {
        if (this.isFilled(y, x)) {
          const index = y * perRow + x;
          
          // Create two triangles for each filled tile
          indices[faceIndex * 6] = index;
          indices[faceIndex * 6 + 1] = index + 1;
          indices[faceIndex * 6 + 2] = index + perRow;
          
          indices[faceIndex * 6 + 3] = index + perRow;
          indices[faceIndex * 6 + 4] = index + 1;
          indices[faceIndex * 6 + 5] = index + perRow + 1;
          
          faceIndex++;
        }
      }
    }

    const geometry = this.geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices.slice(0, faceIndex * 6), 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    geometry.computeBoundsTree();

    // Load liquid material
    LiquidType.load(this.data.liquidTypeID).then((type) => {
      this.material = type.material;
      
      console.log('WMO LiquidType loaded:', type.data);
      console.log('WMO LiquidType colors:', type.data.colors);
      console.log('WMO LiquidType name:', type.data.name);
      console.log('WMO liquidTypeID:', this.data.liquidTypeID);
      console.log('WMO blend mode:', type.blendMode);
      
      // Set indoor uniform based on WMO group type
      // WMO groups can be interior or exterior
      this.material.uniforms.indoor.value = this.data.interior ? 1 : 0;
      
      // Update vertex colors with actual liquid type colors
      if (type.data.colors && type.data.colors.length >= 2) {
        // Convert uint32 colors to RGB (0-1 range)
        const color1 = type.data.colors[0];
        const color2 = type.data.colors[1];
        
        const r1 = ((color1 >> 16) & 0xFF) / 255.0;
        const g1 = ((color1 >> 8) & 0xFF) / 255.0;
        const b1 = (color1 & 0xFF) / 255.0;
        
        const r2 = ((color2 >> 16) & 0xFF) / 255.0;
        const g2 = ((color2 >> 8) & 0xFF) / 255.0;
        const b2 = (color2 & 0xFF) / 255.0;
        
        console.log('WMO Color1 (uint32):', color1, 'RGB:', r1, g1, b1);
        console.log('WMO Color2 (uint32):', color2, 'RGB:', r2, g2, b2);
        
        console.log('WMO Using LiquidType DBC colors:', r1, g1, b1);
        
        // Check if DBC colors are black (0,0,0) and use fallback if needed
        const brightness = (r1 + g1 + b1) / 3;
        let finalR = r1, finalG = g1, finalB = b1;
        
        if (brightness < 0.01) {
          console.log('WMO DBC colors are black, using fallback water color');
          finalR = 0.4;
          finalG = 0.6;
          finalB = 0.7;
        }
        
        // Use the colors (either from DBC or fallback)
        const geometry = this.geometry;
        const colorAttribute = geometry.getAttribute('color');
        
        for (let i = 0; i < colorAttribute.count; i++) {
          colorAttribute.setXYZ(i, finalR, finalG, finalB);
        }
        colorAttribute.needsUpdate = true;
      } else {
        console.log('WMO: No colors found in LiquidType data, using default colors');
      }
    });
  }

  isFilled(y, x) {
    const tiles = this.data.tiles;
    if (!tiles) {
      return true;
    }

    const index = y * this.data.liquidTiles.x + x;
    if (index >= tiles.length) {
      return false;
    }

    const tile = tiles[index];
    const legacyLiquidType = tile.flags & 0x0F; // First 4 bits
    
    // Check if tile should be filled based on liquid type
    // According to spec: legacyLiquidType <= 20 means it's a basic liquid type
    // legacyLiquidType > 0 means the tile has liquid
    return legacyLiquidType > 0;
  }

}

export default WMOLiquidLayer;
