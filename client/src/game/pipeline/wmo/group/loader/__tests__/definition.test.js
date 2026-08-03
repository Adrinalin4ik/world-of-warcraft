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

describe('WMOGroupDefinition#assignVertexColors ambient branch', () => {
  // Same class of defect the exterior tests above guard, on the other flag: `interior` is a getter on
  // the parser's OUTER chunked object (group.js reads `this.flags`, which MOGP does not expose), so
  // handing this method `groupData.MOGP` made the test read `undefined` and the root ambient was never
  // added to any interior group in the game. The ambient is the only ADDITIVE term a WMO surface gets,
  // and every brightness control in this renderer is a multiply -- so the faces stayed black and
  // turning brightness up lit only what already had colour.
  const ROOT = { ambientColor: { r: 80, g: 90, b: 100 } };

  const makeMocv = (count, value = 12) => ({
    colors: Array.from({ length: count }, () => ({ r: value, g: value, b: value, a: 255 })),
  });

  function assign(interior, mocv, count = 2) {
    const definition = Object.create(WMOGroupDefinition.prototype);
    const attribute = new Float32Array(count * 4);

    definition.assignVertexColors(count, ROOT, interior, mocv, attribute);

    return attribute;
  }

  it('adds half the root ambient for an interior group', () => {
    const colors = assign(true, makeMocv(2));

    // (12 + 80 / 2) / 255
    expect(colors[0]).toBeCloseTo(52 / 255, 6);
    expect(colors[1]).toBeCloseTo(57 / 255, 6);
    expect(colors[2]).toBeCloseTo(62 / 255, 6);
    expect(colors[3]).toBeCloseTo(1, 6);
  });

  it('adds nothing for an exterior group', () => {
    const colors = assign(false, makeMocv(2));

    expect(colors[0]).toBeCloseTo(12 / 255, 6);
    expect(colors[1]).toBeCloseTo(12 / 255, 6);
  });

  it('lifts a black interior face off zero -- the whole point', () => {
    // A multiply cannot rescue zero, which is why this is the field that matters.
    const colors = assign(true, makeMocv(1, 0), 1);

    expect(colors[0]).toBeGreaterThan(0);
  });

  it('leaves a black exterior face at zero', () => {
    const colors = assign(false, makeMocv(1, 0), 1);

    expect(colors[0]).toBe(0);
  });

  it('would read a MOGP sub-struct as not-interior, which is the bug it replaced', () => {
    // Passing `groupData.MOGP` supplies an object with `flags` and no `interior`, so this is exactly
    // what the old call site produced. Pinned so the parameter cannot quietly become an object again.
    const colors = assign({ flags: 0x2000 }.interior, makeMocv(1, 0), 1);

    expect(colors[0]).toBe(0);
  });

  it('falls back to mid grey when the group carries no MOCV at all', () => {
    const colors = assign(true, null);

    expect(colors[0]).toBeCloseTo(127 / 255, 6);
    expect(colors[3]).toBeCloseTo(1, 6);
  });
});
