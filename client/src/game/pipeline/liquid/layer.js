import * as THREE from 'three';

import Chunk from '../adt/chunk';
import LiquidType from './type';

class LiquidLayer extends THREE.Mesh {

  constructor(data) {
    super();

    this.data = data;

    const unitSize = Chunk.UNIT_SIZE;

    const { offsetX, offsetY, vertexCount, width } = this.data;
    const perRow = width + 1;

    this.position.y = -(offsetX * unitSize);
    this.position.x = -(offsetY * unitSize);

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);

    this.data.vertexData.heights.forEach((height, index) => {
      const y = Math.floor(index / perRow);
      const x = index % perRow;

       // Mirror geometry over X and Y axes
      positions[index * 3] = -(y * unitSize);
      positions[index * 3 + 1] = -(x * unitSize);
      positions[index * 3 + 2] = height;

      // Faces up. Mirroring over X and Y leaves +Z as up, so this is unaffected by it. The shader
      // normalizes this varying, and without the attribute that was normalize(vec3(0)) -- NaN through
      // the diffuse dot product and the specular half vector alike.
      normals[index * 3 + 2] = 1.0;



      // Scale UV coordinates to make texture patterns larger and less dense
      uvs[index * 2] = x;
      uvs[index * 2 + 1] = y;
      
      // Set default water color (more accurate blue-green)
      colors[index * 3] = 0.3;     // Red
      colors[index * 3 + 1] = 0.6; // Green  
      colors[index * 3 + 2] = 0.9; // Blue
      
      // Use alpha from vertex data if available, otherwise default to less transparent
      alphas[index] = this.data.vertexData && this.data.vertexData.alphas ? 
        Math.max(this.data.vertexData.alphas[index] / 255.0, 0.8) : 0.9;
    });

    const height = this.data.height;
    const indices = new Uint32Array(width * height * 4 * 3);

    let faceIndex = 0;
    const addFace = (index1, index2, index3) => {
      indices[faceIndex * 3] = index1;
      indices[faceIndex * 3 + 1] = index2;
      indices[faceIndex * 3 + 2] = index3;
      faceIndex++;
    };

    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        if (this.isFilled(y, x)) {
          const index = y * perRow + x;
          addFace(index, index + 1, index + perRow);
          addFace(index + perRow, index + 1, index + perRow + 1);
        }
      }
    }

    const geometry = this.geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

    geometry.computeBoundsTree();

    LiquidType.load(this.data.liquidTypeID).then((type) => {
      this.material = type.material;
      
      
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
        
        
        // Check if DBC colors are black (0,0,0) and use fallback if needed
        const brightness = (r1 + g1 + b1) / 3;
        let finalR = r1, finalG = g1, finalB = b1;
        
        if (brightness < 0.01) {
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
        console.log('No colors found in LiquidType data, using default colors');
      }
    });
  }

  isFilled(y, x) {
    const fill = this.data.fill;
    if (!fill) {
      return true;
    }

    const index = y * this.data.width + x;
    const byte = Math.floor(index / 8);
    const bit = index % 8;

    return fill[byte] >>> bit & 1;
  }

 }

export default LiquidLayer;
