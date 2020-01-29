import MathUtil from '../../../../utils/math-util';

class WMOGroupDefinition {

  constructor(path, index, rootHeader, groupData) {
    this.path = path;
    this.index = index;
    this.groupID = groupData.MOGP.groupID;

    this.header = {
      batchCounts: groupData.MOGP.batchCounts,
      batchOffsets: groupData.MOGP.batchOffsets,
      portalCount: groupData.MOGP.portalCount,
      portalOffset: groupData.MOGP.portalOffset,
      flags: groupData.MOGP.flags
    };

    this.doodadRefs = groupData.MODR ? groupData.MODR.doodadIndices : [];

    this.createBoundingBox(groupData.MOGP);

    this.createAttributes(rootHeader, groupData);
    this.createMaterialRefs(groupData);
    this.batches = groupData.MOBA.batches;

    this.bspNodes = groupData.MOBN.nodes;
    this.bspPlaneIndices = new Uint16Array(groupData.MOBR.indices);
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
      
      attribute.set([-vertex[0], -vertex[1], vertex[2]], index * 3);
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

    return list;
  }

}

export default WMOGroupDefinition;
