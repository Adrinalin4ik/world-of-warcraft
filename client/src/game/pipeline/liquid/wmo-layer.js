import * as THREE from 'three';

import LiquidType from './type';

class WMOLiquidLayer extends THREE.Mesh {

  // One eighth of an ADT chunk (33.33333 / 8), the unit MLIQ's tile grid is expressed in.
  static TILE_SIZE = 33.33333 / 8;

  constructor(data) {
    super();

    this.data = data;

    // WMO liquids don't use ADT chunk units - they use their own coordinate system
    // The liquidCorner provides the base position for the liquid grid
    const { liquidCorner, liquidVerts, liquidTiles, vertices, tiles } = this.data;

    const vertexCount = liquidVerts.x * liquidVerts.y;
    const perRow = liquidVerts.x;

    // MLIQ's liquidCorner is a C3Vector, so it has x/y/z -- not indices. Reading it as an array
    // yielded undefined for all three, which put the mesh at a NaN position; from there matrixWorld
    // was NaN, every vertex projected to NaN, and the surface never drew. That is why no WMO liquid
    // has ever been visible, whatever its type resolved to.
    //
    // Only X and Y are a base offset. SMOLVert.height is already an absolute height in group space
    // (the sheets measure out at exactly liquidCorner.z, well inside each group's bounding box), so
    // adding the corner's Z again would sink the surface by its own depth.
    //
    // Group vertices are consumed unswizzled in WMOGroupDefinition#assignVertexPositions, so the
    // liquid grid stays in the same raw WMO axes -- no Y/Z swap.
    this.position.set(liquidCorner.x, liquidCorner.y, 0);

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3);
    const alphas = new Float32Array(vertexCount);

    // Create vertex positions from MLIQ vertex data
    vertices.forEach((vertex, index) => {
      const y = Math.floor(index / perRow);
      const x = index % perRow;

      // A liquid tile is one eighth of an ADT chunk, the same unit MLIQ inherits from MCLQ. This had
      // been widened to 12.0 "for better appearance", which stretched every grid to ~2.9x its real
      // extent -- so a surface that did line up with its basin no longer did.
      const tileSize = WMOLiquidLayer.TILE_SIZE;

      positions[index * 3] = x * tileSize;
      positions[index * 3 + 1] = y * tileSize;
      positions[index * 3 + 2] = vertex.height;

      // A liquid sheet is planar and faces straight up. Without this attribute the shader's
      // `normalize(vertexWorldNormal)` was normalize(vec3(0)) -- a NaN that spread through the diffuse
      // dot product and the specular half vector. It went unnoticed only because the inverted fog was
      // overwriting the result outright.
      normals[index * 3 + 2] = 1.0;


      // A height of exactly 0 or 1 is ordinary for the flat water sheets inside a WMO, so warning on
      // those produced hundreds of lines per group and drowned out everything else in the console.
      // Only a genuinely out-of-range height says anything.
      if (Math.abs(vertex.height) > 10000) {
        console.warn(`WMO liquid vertex ${index} (${x},${y}) has out-of-range height ${vertex.height}`);
      }

      // One texture repeat per liquid tile, as the ADT layer does. Normalising across the whole grid
      // and then scaling by 0.3 stretched a third of a single repeat over the entire surface, so a
      // 121-unit lava pool showed a handful of magnified texels and read as one flat colour.
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

    // Create indices for filled tiles
    const indices = new Uint32Array(liquidTiles.x * liquidTiles.y * 6);
    let faceIndex = 0;

    for (let y = 0; y < liquidTiles.y; ++y) {
      for (let x = 0; x < liquidTiles.x; ++x) {
        if (this.isFilled(y, x)) {
          const index = y * perRow + x;
          
          // Two triangles per filled tile, wound so the upward face is the *back* face.
          //
          // LiquidMaterial renders THREE.BackSide. The ADT layer earns that by mapping (x,y) grid
          // coordinates to (-y,-x) world coordinates, a reflection that reverses winding as a side
          // effect. This grid maps straight through, so the same vertex order would present its
          // front face upward and be culled -- invisible from every angle a player can stand at.
          indices[faceIndex * 6] = index;
          indices[faceIndex * 6 + 1] = index + perRow;
          indices[faceIndex * 6 + 2] = index + 1;

          indices[faceIndex * 6 + 3] = index + perRow;
          indices[faceIndex * 6 + 4] = index + perRow + 1;
          indices[faceIndex * 6 + 5] = index + 1;


          faceIndex++;
        }
      }
    }

    const geometry = this.geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices.slice(0, faceIndex * 6), 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
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
      
      // Vertex colours carry only what LiquidType.dbc actually specifies. In 3.3.5a that pair is
      // zeroed for most types, and the tint is supplied instead by the light database through the
      // material's baseColor uniform, which the vertex shader adds on top of this.
      //
      // A hardcoded blue used to be written here whenever the DBC pair was zero, which was always.
      // Because it was baked straight into the attribute it also outranked the light database, so
      // every body of water in the game ended up the same flat colour regardless of zone or hour.
      const colors = type.data.colors;

      if (colors && colors.length >= 2) {
        const packed = colors[0];

        const red = ((packed >> 16) & 0xFF) / 255.0;
        const green = ((packed >> 8) & 0xFF) / 255.0;
        const blue = (packed & 0xFF) / 255.0;

        const colorAttribute = this.geometry.getAttribute('color');

        for (let index = 0; index < colorAttribute.count; index++) {
          colorAttribute.setXYZ(index, red, green, blue);
        }

        colorAttribute.needsUpdate = true;
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

    // SMOLTile.legacyLiquidType is a 4-bit *type*, not a fill flag, and 0x0F is the sentinel for
    // "no liquid here" -- the same convention MLIQ inherits from the ADT MCLQ chunk. A type of 0 is
    // perfectly valid and means the group's own liquid applies.
    //
    // The test used to be `legacyLiquidType > 0`, which rendered precisely the wrong half: across
    // Undercity's 8136 tiles the values are only ever 0 or 15, so it drew every empty tile and hid
    // every tile that actually holds slime.
    const legacyLiquidType = tile.flags & 0x0F;

    return legacyLiquidType !== 0x0F;
  }

}

export default WMOLiquidLayer;
