import WMOGroupDefinition from '../definition';

describe('WMOGroupDefinition.resolveOutdoorVertexAlpha', () => {
  it('is 255 when exterior', () => {
    expect(WMOGroupDefinition.resolveOutdoorVertexAlpha(true)).toBe(255);
  });

  it('is 0 when not exterior', () => {
    expect(WMOGroupDefinition.resolveOutdoorVertexAlpha(false)).toBe(0);
    expect(WMOGroupDefinition.resolveOutdoorVertexAlpha(undefined)).toBe(0);
  });
});

describe('WMOGroupDefinition#fixVertexColors outdoor branch (root flag 0x08)', () => {
  // Exercises the actual consumer, not just the helper: this is the test that would have caught
  // groupData.MOGP.exterior being undefined even after `exterior` existed on the parser's outer
  // object -- the field has to actually reach this method's `exterior` parameter.
  function makeMocv(count) {
    const colors = [];

    for (let i = 0; i < count; ++i) {
      colors.push({ r: 10, g: 20, b: 30, a: 99 });
    }

    return { colors };
  }

  function makeMogp() {
    return {
      batchCounts: { a: 0, b: 0, c: 0 },
      batchOffsets: { a: 0, b: 0, c: 0 }
    };
  }

  it('sets alpha 255 on an exterior group', () => {
    const definition = Object.create(WMOGroupDefinition.prototype);
    const mocv = makeMocv(3);

    definition.fixVertexColors(3, { flags: 0x08 }, makeMogp(), { batches: [] }, mocv, true);

    for (const color of mocv.colors) {
      expect(color.a).toBe(255);
    }
  });

  it('sets alpha 0 on an interior group', () => {
    const definition = Object.create(WMOGroupDefinition.prototype);
    const mocv = makeMocv(3);

    definition.fixVertexColors(3, { flags: 0x08 }, makeMogp(), { batches: [] }, mocv, false);

    for (const color of mocv.colors) {
      expect(color.a).toBe(0);
    }
  });
});
