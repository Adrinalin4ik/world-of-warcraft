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

  it('LEAVES an interior group\'s alpha alone -- it carries data', () => {
    // This test used to assert alpha 0 here, which is what the code did and what the shader could not
    // survive. Per samples/benilla `wmo/group.rs`, the alpha->0xFF fixup is the EXTERIOR case; on an
    // interior group the alpha is the TRANS lit<->bake lerp factor and the INT self-illumination mask
    // (`tex x mocv x (1 + 4 x alpha)`). Measured on NIGHTELFSMALLHOUSE_WSG_001: all 1587 vertices came
    // out at alpha exactly 0, so both interior lanes were reading a wiped mask.
    const definition = Object.create(WMOGroupDefinition.prototype);
    const mocv = makeMocv(3);

    definition.fixVertexColors(3, { flags: 0x08 }, makeMogp(), { batches: [] }, mocv, false);

    for (const color of mocv.colors) {
      expect(color.a).toBe(99);
    }
  });

  it('forces alpha opaque on an exterior group through the long path too', () => {
    // The non-0x08 path stamped the same 255-or-0 at the end of its second loop.
    const definition = Object.create(WMOGroupDefinition.prototype);
    const mocv = makeMocv(3);

    definition.fixVertexColors(
      3, { flags: 0x02 }, makeMogp(), { batches: [] }, mocv, true,
    );

    for (const color of mocv.colors) {
      expect(color.a).toBe(255);
    }
  });

  it('preserves an interior alpha through the long path too', () => {
    const definition = Object.create(WMOGroupDefinition.prototype);
    const mocv = makeMocv(3);

    definition.fixVertexColors(
      3, { flags: 0x02 }, makeMogp(), { batches: [] }, mocv, false,
    );

    for (const color of mocv.colors) {
      expect(color.a).toBe(99);
    }
  });
});

describe('WMOGroupDefinition.applyOutdoorVertexAlpha', () => {
  const mocvOf = (alphas) => ({ colors: alphas.map((a) => ({ r: 1, g: 2, b: 3, a })) });

  it('opaques from the given offset only', () => {
    const mocv = mocvOf([10, 20, 30, 40]);

    WMOGroupDefinition.applyOutdoorVertexAlpha(mocv, 2, 4, true);

    expect(mocv.colors.map((c) => c.a)).toEqual([10, 20, 255, 255]);
  });

  it('does nothing at all for an interior group', () => {
    const mocv = mocvOf([10, 20, 30, 40]);

    WMOGroupDefinition.applyOutdoorVertexAlpha(mocv, 0, 4, false);

    expect(mocv.colors.map((c) => c.a)).toEqual([10, 20, 30, 40]);
  });

  it('never touches rgb', () => {
    const mocv = mocvOf([10]);

    WMOGroupDefinition.applyOutdoorVertexAlpha(mocv, 0, 1, true);

    expect(mocv.colors[0]).toMatchObject({ r: 1, g: 2, b: 3 });
  });

  it('tolerates a count past the end of the colour array', () => {
    const mocv = mocvOf([10]);

    expect(() => WMOGroupDefinition.applyOutdoorVertexAlpha(mocv, 0, 8, true)).not.toThrow();
    expect(mocv.colors[0].a).toBe(255);
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

describe('WMOGroupDefinition.usableVertexColors', () => {
  // The reference's own guard (samples/benilla wmo/group.rs): colours must be parallel to positions,
  // or the group counts as having none and every vertex falls back to the neutral default. We had no
  // such check -- a short chunk indexes past its end, and a long one is not simply a longer version of
  // the same data, so reading its leading entries assigns other vertices' colours.
  const mocvOf = (count) => ({
    colors: Array.from({ length: count }, () => ({ r: 40, g: 40, b: 40, a: 255 })),
  });

  let warn;

  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('passes MOCV through when it is parallel to the vertices', () => {
    const mocv = mocvOf(2016);

    expect(WMOGroupDefinition.usableVertexColors(mocv, 2016, 'X.WMO', 0)).toBe(mocv);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a chunk with FEWER colours than vertices', () => {
    expect(WMOGroupDefinition.usableVertexColors(mocvOf(100), 2016, 'X.WMO', 0)).toBeNull();
  });

  it('rejects a chunk with MORE colours than vertices', () => {
    expect(WMOGroupDefinition.usableVertexColors(mocvOf(4032), 2016, 'X.WMO', 0)).toBeNull();
  });

  it('names the file, the group and both counts, since that is the whole evidence', () => {
    WMOGroupDefinition.usableVertexColors(mocvOf(4032), 2016, 'NIGHTELF.WMO', 1);

    const message = warn.mock.calls[0][0];
    expect(message).toMatch(/NIGHTELF\.WMO/);
    expect(message).toMatch(/group 1/);
    expect(message).toMatch(/4032/);
    expect(message).toMatch(/2016/);
  });

  it('returns null for an absent chunk without complaining', () => {
    // A group with no MOCV at all is ordinary, not a mismatch.
    expect(WMOGroupDefinition.usableVertexColors(null, 2016, 'X.WMO', 0)).toBeNull();
    expect(WMOGroupDefinition.usableVertexColors({}, 2016, 'X.WMO', 0)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a group with no vertices and no colours', () => {
    expect(WMOGroupDefinition.usableVertexColors(mocvOf(0), 0, 'X.WMO', 0)).not.toBeNull();
  });
});

describe('WMOGroupDefinition.usableVertexColors on the unified render path', () => {
  // MOHD 0x02 (`use_unified_render_path`): MOCV is not the shade multiplier there, so the group is
  // treated as carrying no colours -- neutral, which the shader's x2 turns into white. A deliberate
  // divergence from the reference, which reads no MOHD flags for lighting; see
  // WMORootFlags.UNIFIED_RENDER_PATH for the five in-game measurements behind it.
  const mocvOf = (count) => ({
    colors: Array.from({ length: count }, () => ({ r: 3, g: 3, b: 3, a: 255 })),
  });

  it('drops parallel MOCV when the bit is set', () => {
    const mocv = mocvOf(8);

    expect(WMOGroupDefinition.usableVertexColors(mocv, 8, 'X.WMO', 0, { flags: 0x02 })).toBeNull();
  });

  it('drops it for the real observed flag word too', () => {
    // NIGHTELFSMALLHOUSE_WSG carries 0xf.
    expect(WMOGroupDefinition.usableVertexColors(mocvOf(8), 8, 'X.WMO', 0, { flags: 0xf }))
      .toBeNull();
  });

  it('keeps MOCV for the flag words that render correctly', () => {
    // CTFORC_A, CTFNIGHTELF_A and ORCHUT_WSG all carry 0x5, and none of them is black.
    const mocv = mocvOf(8);

    expect(WMOGroupDefinition.usableVertexColors(mocv, 8, 'X.WMO', 0, { flags: 0x5 })).toBe(mocv);
    expect(WMOGroupDefinition.usableVertexColors(mocv, 8, 'X.WMO', 0, { flags: 0x0 })).toBe(mocv);
  });

  it('keeps MOCV when no root header is supplied at all', () => {
    const mocv = mocvOf(8);

    expect(WMOGroupDefinition.usableVertexColors(mocv, 8, 'X.WMO', 0)).toBe(mocv);
  });

  it('still rejects a non-parallel chunk regardless of the bit', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(WMOGroupDefinition.usableVertexColors(mocvOf(4), 8, 'X.WMO', 0, { flags: 0x0 }))
      .toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
