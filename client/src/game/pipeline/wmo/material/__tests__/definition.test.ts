/**
 * @jest-environment node
 */
import WMOMaterialDefinition from '../loader/definition';

// Regression coverage for the WMO material cache-key collision: `interior` (portal culling) and
// `lightingInterior` (the reference's MOGI/MOGP 0x48 lighting class) are deliberately distinct
// notions, but the cache key only ever encoded `interior`. Two groups sharing an `index`,
// `batchType` and `interior` -- e.g. a genuine interior room and its attached EXTERIOR_LIT porch --
// would collide on one cached WMOMaterial instance despite needing different INTERIOR shader
// defines. See client/src/game/pipeline/wmo/material/loader/definition.js.

function makeDef(index = 0) {
  return new WMOMaterialDefinition(index, 0, 0, 0, [], { r: 0, g: 0, b: 0, a: 0 });
}

function refFor({ index = 0, batchType = 1, interior = true, lightingInterior = true } = {}) {
  return makeDef(index).forRef({ batchType, interior, lightingInterior });
}

describe('WMOMaterialDefinition#key', () => {
  it('differs when lightingInterior differs but index/batchType/interior match', () => {
    // The exact realistic collision: an interior room (lightingInterior true) and an attached
    // EXTERIOR_LIT porch (lightingInterior false) that both claim the camera (interior true).
    const room = refFor({ interior: true, lightingInterior: true });
    const porch = refFor({ interior: true, lightingInterior: false });

    expect(room.key).not.toBe(porch.key);
  });

  it('matches when all four of index/batchType/interior/lightingInterior match', () => {
    const a = refFor({ index: 3, batchType: 2, interior: true, lightingInterior: false });
    const b = refFor({ index: 3, batchType: 2, interior: true, lightingInterior: false });

    expect(a.key).toBe(b.key);
  });

  it('omits the lightingInterior component when it is null, like interior does', () => {
    const def = makeDef(5);

    expect(def.interior).toBeNull();
    expect(def.lightingInterior).toBeNull();
    expect(def.key).toBe('5');
  });
});
