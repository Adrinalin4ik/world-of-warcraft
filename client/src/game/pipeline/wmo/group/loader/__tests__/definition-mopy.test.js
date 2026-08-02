import WMOGroupDefinition from '../definition';

/**
 * MOPY carries one byte of flags per triangle, and it is what tells the two collision audiences
 * apart: the player body collides with WMO faces minus DETAIL (0x04), the camera with faces minus
 * NOCAMCOLLIDE (0x02). So the camera stops at the forge pipes you walk under, and threads the
 * railings you stand on.
 *
 * The chunk was parsed all along -- it just never made it into the attributes the worker transfers,
 * so nothing downstream had anything to filter on.
 *
 * Exercises `createAttributes` directly rather than the constructor, matching definition.test.js:
 * the constructor reads a dozen unrelated MOGP fields, and a fixture for all of them would drift.
 */
describe('WMOGroupDefinition#createAttributes MOPY flags', () => {
  function makeGroupData(flags) {
    const triangleCount = flags.length;
    const vertexCount = 3;

    return {
      MOGP: {
        batchCounts: { a: 0, b: 0, c: 0 },
        batchOffsets: { a: 0, b: 0, c: 0 }
      },
      MOPY: { triangles: flags.map((f) => ({ flags: f, materialID: 0 })) },
      MOVI: { triangles: new Array(triangleCount * 3).fill(0) },
      MOVT: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
      MONR: { normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] },
      MOTV: { textureCoords: [[0, 0], [1, 0], [0, 1]] },
      MOBA: { batches: [] },
      MOCV: null,
      exterior: true,
      vertexCount
    };
  }

  function buildAttributes(flags) {
    const definition = Object.create(WMOGroupDefinition.prototype);

    definition.createAttributes({ flags: 0x08 }, makeGroupData(flags));

    return definition.attributes;
  }

  it('copies one flags byte per triangle', () => {
    const attributes = buildAttributes([0x00, 0x04, 0x02, 0x24]);

    expect(attributes.triangleFlags).toBeInstanceOf(Uint8Array);
    expect(Array.from(attributes.triangleFlags)).toEqual([0x00, 0x04, 0x02, 0x24]);
  });

  it('sizes the array from the index count, so it stays aligned with the triangles', () => {
    const attributes = buildAttributes([0x00, 0x04]);

    expect(attributes.triangleFlags.length).toBe(attributes.indices.length / 3);
  });

  it('defaults a missing MOPY entry to no flags rather than undefined', () => {
    // A short MOPY would otherwise put `undefined` in a Uint8Array slot, which coerces to 0 --
    // right answer, wrong reason. Be explicit, so a genuinely truncated chunk collides with
    // everything instead of silently becoming walk-through.
    const definition = Object.create(WMOGroupDefinition.prototype);
    const groupData = makeGroupData([0x04, 0x02]);
    groupData.MOPY.triangles = [{ flags: 0x04, materialID: 0 }];

    definition.createAttributes({ flags: 0x08 }, groupData);

    expect(Array.from(definition.attributes.triangleFlags)).toEqual([0x04, 0x00]);
  });
});

describe('WMOGroupDefinition#transferable', () => {
  it('lists the flags buffer so it survives postMessage', () => {
    const definition = Object.create(WMOGroupDefinition.prototype);

    definition.createAttributes({ flags: 0x08 }, {
      MOGP: { batchCounts: { a: 0, b: 0, c: 0 }, batchOffsets: { a: 0, b: 0, c: 0 } },
      MOPY: { triangles: [{ flags: 0x04, materialID: 0 }] },
      MOVI: { triangles: [0, 0, 0] },
      MOVT: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
      MONR: { normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] },
      MOTV: { textureCoords: [[0, 0], [1, 0], [0, 1]] },
      MOBA: { batches: [] },
      MOCV: null,
      exterior: true
    });
    definition.bspPlaneIndices = new Uint16Array(0);
    definition.liquidData = null;

    expect(definition.transferable).toContain(definition.attributes.triangleFlags.buffer);
  });
});
