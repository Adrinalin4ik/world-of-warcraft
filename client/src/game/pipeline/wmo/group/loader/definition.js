import MathUtil from '../../../../utils/math-util';

class WMOGroupDefinition {

  constructor(path, index, rootHeader, groupData) {
    // console.log(groupData.MLIQ)
    this.path = path;
    this.index = index;
    this.groupID = groupData.MOGP.groupID;
    this.interior = groupData.interior;
    // The LIGHTING class (MOGP/MOGI 0x48) — see group.js `lightingInterior`. Without this the
    // material never sees anything but `undefined` and silently falls back to `this.interior`.
    this.lightingInterior = groupData.lightingInterior;

    this.header = {
      batchCounts: groupData.MOGP.batchCounts,
      batchOffsets: groupData.MOGP.batchOffsets,
      portalCount: groupData.MOGP.portalCount,
      portalOffset: groupData.MOGP.portalOffset,
      flags: groupData.MOGP.flags,
      groupLiquid: groupData.MOGP.groupLiquid
    };

    this.doodadRefs = groupData.MODR ? groupData.MODR.doodadIndices : [];
    // Raw MOLT indices (via MOLR) this group's props want lit by. Resolved against
    // `root.lights` (kept positionally MOLT-aligned) at fold time -- see wmo-lights.ts. A group
    // with no MOLR chunk means no point light for anything it owns.
    this.lightRefs = groupData.MOLR ? groupData.MOLR.lightRefList : [];

    this.createBoundingBox(groupData.MOGP);

    this.createAttributes(rootHeader, groupData);
    this.createMaterialRefs(groupData);
    this.batches = groupData.MOBA.batches;

    this.bspNodes = groupData.MOBN.nodes;
    this.bspPlaneIndices = new Uint16Array(groupData.MOBR.indices);
    
    // Process liquid data if present
    this.liquidData = this.createLiquidData(rootHeader, groupData);
  }

  createBoundingBox(mogp) {
    const boundingBox = this.boundingBox = {};
    
    boundingBox.min = mogp.minBoundingBox;
    boundingBox.max = mogp.maxBoundingBox;
  }

  createAttributes(rootHeader, groupData) {
    const attributes = this.attributes = {};

    const indexCount = groupData.MOVI.triangles.length;
    const vertexCount = groupData.MOVT.vertices.length;

    const indices = attributes.indices = new Uint16Array(indexCount);
    this.assignIndices(indexCount, groupData.MOVI, indices);

    const positions = attributes.positions = new Float32Array(vertexCount * 3);
    this.assignVertexPositions(vertexCount, groupData.MOVT, positions);

    const uvs = attributes.uvs = new Float32Array(vertexCount * 2);
    this.assignUVs(vertexCount, groupData.MOTV, uvs);

    const normals = attributes.normals = new Float32Array(vertexCount * 3);
    this.assignVertexNormals(vertexCount, groupData.MONR, normals);

    // Manipulate vertex colors a la FixColorVertexAlpha
    this.fixVertexColors(vertexCount, rootHeader, groupData.MOGP, groupData.MOBA, groupData.MOCV);

    const colors = attributes.colors = new Float32Array(vertexCount * 4);
    this.assignVertexColors(vertexCount, rootHeader, groupData.MOGP, groupData.MOCV, colors);
  }

  assignVertexPositions(vertexCount, movt, attribute) {
    for (let index = 0; index < vertexCount; ++index) {
      const vertex = movt.vertices[index];
      
      attribute.set([vertex[0], vertex[1], vertex[2]], index * 3);
    }
  }

  assignUVs(vertexCount, motv, attribute) {
    for (let index = 0; index < vertexCount; ++index) {
      const uv = motv.textureCoords[index];

      attribute.set(uv, index * 2);
    }
  }

  assignVertexNormals(vertexCount, monr, attribute) {
    for (let index = 0; index < vertexCount; ++index) {
      const normal = monr.normals[index];

      attribute.set([normal[0], normal[1], normal[2]], index * 3);
    }
  }

  assignIndices(_indexCount, movi, attribute) {
    attribute.set(movi.triangles, 0);
  }

  assignVertexColors(vertexCount, rootHeader, mogp, mocv, attribute) {
    if (!mocv) {
      // Assign default vertex color.
      for (let index = 0; index < vertexCount; ++index) {
        const r = 127.0 / 255.0;
        const g = 127.0 / 255.0;
        const b = 127.0 / 255.0;
        const a = 1.0;

        attribute.set([r, g, b, a], index * 4);
      }

      return;
    }

    const mod = { r: 0, g: 0, b: 0, a: 0 };

    // For interior groups, add root ambient color to vertex colors.
    if (mogp.interior) {
      mod.r = rootHeader.ambientColor.r / 2.0;
      mod.g = rootHeader.ambientColor.g / 2.0;
      mod.b = rootHeader.ambientColor.b / 2.0;
    }

    for (let index = 0; index < vertexCount; ++index) {
      const color = mocv.colors[index];

      const r = (color.r + mod.r) / 255.0;
      const g = (color.g + mod.g) / 255.0;
      const b = (color.b + mod.b) / 255.0;
      const a = color.a / 255.0;

      attribute.set([r, g, b, a], index * 4);
    }
  }

  fixVertexColors(vertexCount, rootHeader, mogp, moba, mocv) {
    if (!mocv) {
      return;
    }

    const { batchCounts, batchOffsets } = mogp;

    let batchStartB = 0;

    if (batchCounts.a > 0) {
      const firstBatchB = moba.batches[batchOffsets.b];
      batchStartB = firstBatchB ? firstBatchB.firstVertex : vertexCount;
    }

    // Root Flag 0x08: something about outdoor groups
    if (rootHeader.flags & 0x08) {
      for (let index = batchStartB; index < vertexCount; ++index) {
        const color = mocv.colors[index];
        color.a = mogp.exterior ? 255 : 0;
      }

      return;
    }

    const mod = {};

    // Root Flag 0x02: skip ambient color when fixing vertex colors
    if (rootHeader.flags & 0x02) {
      mod.r = 0;
      mod.g = 0;
      mod.b = 0;
    } else {
      mod.r = rootHeader.ambientColor.r;
      mod.g = rootHeader.ambientColor.g;
      mod.b = rootHeader.ambientColor.b;
    }

    for (let index = 0; index < batchStartB; ++index) {
      const color = mocv.colors[index];
      const alpha = color.a / 255.0;

      color.r -= mod.r;
      color.g -= mod.g;
      color.b -= mod.b;

      color.r -= (alpha * color.r);
      color.g -= (alpha * color.g);
      color.b -= (alpha * color.b);

      color.r = MathUtil.clamp(color.r, 0, 255);
      color.g = MathUtil.clamp(color.g, 0, 255);
      color.b = MathUtil.clamp(color.b, 0, 255);

      color.r /= 2.0;
      color.g /= 2.0;
      color.b /= 2.0;
    }

    for (let index = batchStartB; index < vertexCount; ++index) {
      const color = mocv.colors[index];

      color.r = (color.r - mod.r) + ((color.r * color.a) >> 6);
      color.g = (color.g - mod.g) + ((color.g * color.a) >> 6);
      color.b = (color.b - mod.b) + ((color.b * color.a) >> 6);

      color.r /= 2.0;
      color.g /= 2.0;
      color.b /= 2.0;

      color.r = MathUtil.clamp(color.r, 0, 255);
      color.g = MathUtil.clamp(color.g, 0, 255);
      color.b = MathUtil.clamp(color.b, 0, 255);

      color.a = mogp.exterior ? 255 : 0;
    }
  }

  createMaterialRefs(groupData) {
    const refs = this.materialRefs = [];
    const { batchOffsets } = groupData.MOGP;
    const batchCount = groupData.MOBA.batches.length;
    
    for (let index = 0; index < batchCount; ++index) {
      const batch = groupData.MOBA.batches[index];

      const ref = {};

      ref.materialIndex = batch.materialID;
      ref.interior = groupData.MOGP.interior;
      // Same lighting-class value as `this.lightingInterior` above -- one derivation, not a second
      // read of the MOGP/MOGI flags, so the ref and the group definition can never disagree.
      ref.lightingInterior = this.lightingInterior;

      if (index >= batchOffsets.c) {
        ref.batchType = 3;
      } else if (index >= batchOffsets.b) {
        ref.batchType = 2;
      } else {
        ref.batchType = 1;
      }

      refs.push(ref);
    }
  }

  createLiquidData(rootHeader, groupData) {
    if (!groupData.MLIQ) {
      return null;
    }

    console.log('Processing MLIQ chunk for WMO group:', this.path, this.index);
    console.log('MLIQ data:', groupData.MLIQ);
    console.log('MLIQ vertices count:', groupData.MLIQ.vertices.length);
    console.log('MLIQ tiles count:', groupData.MLIQ.tiles.length);
    console.log('Sample vertex:', groupData.MLIQ.vertices[0]);
    console.log('Sample tile:', groupData.MLIQ.tiles[0]);

    const mliq = groupData.MLIQ;
    const mogp = groupData.MOGP;
    
    try {
      // Determine liquid type based on WMO flags and group liquid
      const liquidType = this.determineLiquidType(rootHeader, mogp, mliq);
      
      // Create liquid layer data compatible with existing liquid system
      const liquidLayer = {
        liquidTypeID: liquidType,
        liquidObjectID: 0, // Not used for WMO liquids
        
        minHeightLevel: mogp.minBoundingBox[2],
        maxHeightLevel: mogp.maxBoundingBox[2],
        
        offsetX: 0,
        offsetY: 0,
        width: mliq.liquidTiles.x,
        height: mliq.liquidTiles.y,
        
        vertexCount: mliq.vertexCount,
        
        // Pass interior flag for proper lighting
        interior: this.interior,
        
        // Create fill data from tile flags
        fill: this.createFillData(mliq),
        
        // Create vertex data from MLIQ vertices
        vertexData: {
          heights: mliq.vertices.map(vertex => vertex.height),
          alphas: new Array(mliq.vertexCount).fill(255) // Default alpha
        }
      };
      
      return {
        layers: [liquidLayer],
        layerCount: 1,
        // Add MLIQ-specific data for WMO liquid rendering
        liquidCorner: mliq.liquidCorner,
        liquidVerts: mliq.liquidVerts,
        liquidTiles: mliq.liquidTiles,
        vertices: mliq.vertices,
        tiles: mliq.tiles
      };
    } catch (error) {
      console.error('Error parsing MLIQ data:', error);
      
      // Fallback: create a simple liquid layer without detailed parsing
      console.log('Creating fallback liquid layer');
      const liquidLayer = {
        liquidTypeID: this.determineLiquidType(rootHeader, mogp, null),
        liquidObjectID: 0,
        
        minHeightLevel: mogp.minBoundingBox[2],
        maxHeightLevel: mogp.maxBoundingBox[2],
        
        offsetX: 0,
        offsetY: 0,
        width: 1,
        height: 1,
        
        vertexCount: 4,
        
        fill: new Uint8Array([0xFF]), // Single filled tile
        
        vertexData: {
          heights: [mogp.maxBoundingBox[2], mogp.maxBoundingBox[2], mogp.maxBoundingBox[2], mogp.maxBoundingBox[2]],
          alphas: [255, 255, 255, 255]
        }
      };
      
      return {
        layers: [liquidLayer],
        layerCount: 1
      };
    }
  }
  
  
  determineLiquidType(rootHeader, mogp, mliq) {
    // MOHD flag_use_liquid_type_dbc_id is 0x4. This used to test bit 31, which is never set, so every
    // WMO took the legacy path below regardless of what its root header said.
    const useLiquidTypeDbcId = rootHeader.flags & 0x4;
    const groupLiquid = mogp.groupLiquid;

    if (useLiquidTypeDbcId) {
      // Newer WMOs name a LiquidType.dbc row directly.
      if (groupLiquid < 21) { // LIQUID_FIRST_NONBASIC_LIQUID_TYPE
        return this.toWmoLiquid(groupLiquid - 1, mogp);
      } else {
        return groupLiquid;
      }
    }

    // Older WMOs carry their liquid type per MLIQ tile rather than on the group -- SMOLTile's
    // legacyLiquidType field exists precisely for this. Blackrock is the clear case: its groups all
    // report groupLiquid 0, which reads as plain water, while the tiles say 6 and the room is lava.
    const legacyFromTiles = this.determineLegacyLiquidType(mliq);

    if (legacyFromTiles !== null) {
      return legacyFromTiles;
    }

    // No tile data to go on, so fall back to the group's own value.
    if (groupLiquid < 20) { // LIQUID_END_BASIC_LIQUIDS
      return this.toWmoLiquid(groupLiquid, mogp);
    }

    return groupLiquid + 1;
  }
  
  toWmoLiquid(basicType, mogp) {
    const basic = basicType & 3; // liquid_basic_types_MASK
    const isOcean = mogp.flags & 0x80000; // is_not_water_but_ocean
    
    switch (basic) {
      case 0: // liquid_basic_types_water
        return isOcean ? 14 : 13; // LIQUID_WMO_Ocean : LIQUID_WMO_Water
      case 1: // liquid_basic_types_ocean
        return 14; // LIQUID_WMO_Ocean
      case 2: // liquid_basic_types_magma
        return 19; // LIQUID_WMO_Magma
      case 3: // liquid_basic_types_slime
        return 20; // LIQUID_WMO_Slime
      default:
        return 13; // Default to water
    }
  }
  
  /**
   * Liquid type of a legacy WMO, read from its MLIQ tiles.
   *
   * The low nibble of each tile is a legacy liquid type, and the LiquidType.dbc ids run one ahead of
   * it: the first twelve rows are (water, ocean, magma, slime) repeated for normal, slow and fast
   * flow, so legacy 6 is row 7, "Slow Magma". 0x0F marks a tile with no liquid and is ignored.
   *
   * The dominant type wins, since a single surface is one liquid even where stray tiles disagree.
   *
   * Returns null when there is nothing to go on, leaving the caller to fall back to the group value.
   */
  determineLegacyLiquidType(mliq) {
    if (!mliq || !mliq.tiles || mliq.tiles.length === 0) {
      return null;
    }

    const counts = new Map();

    for (const tile of mliq.tiles) {
      const legacyType = tile.flags & 0x0F;

      if (legacyType === 0x0F) {
        continue;
      }

      counts.set(legacyType, (counts.get(legacyType) || 0) + 1);
    }

    if (counts.size === 0) {
      return null;
    }

    let dominant = null;
    let dominantCount = -1;

    for (const [legacyType, count] of counts) {
      if (count > dominantCount) {
        dominant = legacyType;
        dominantCount = count;
      }
    }

    return dominant + 1;
  }
  
  createFillData(mliq) {
    const fill = new Uint8Array(mliq.tiles.length);
    
    for (let i = 0; i < mliq.tiles.length; i++) {
      const tile = mliq.tiles[i];

      // 0x0F is the "no liquid here" sentinel; every other value is a real liquid type, including 0.
      // Same inversion that was in WMOLiquidLayer.isFilled -- testing `> 0` filled the empty tiles
      // and emptied the filled ones.
      const legacyLiquidType = tile.flags & 0x0F;

      fill[i] = legacyLiquidType === 0x0F ? 0x00 : 0xFF;
    }
    
    return fill;
  }

  // Returns an array of references to typed arrays that we'd like to transfer across worker
  // boundaries.
  get transferable() {
    const list = [];

    list.push(this.attributes.indices.buffer);
    list.push(this.attributes.positions.buffer);
    list.push(this.attributes.uvs.buffer);
    list.push(this.attributes.normals.buffer);
    list.push(this.attributes.colors.buffer);

    list.push(this.bspPlaneIndices.buffer);
    
    // Add liquid data buffers if present
    if (this.liquidData) {
      this.liquidData.layers.forEach(layer => {
        if (layer.fill) {
          list.push(layer.fill.buffer);
        }
      });
    }

    return list;
  }

}

export default WMOGroupDefinition;
