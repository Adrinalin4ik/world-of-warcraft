/**
 * @jest-environment node
 */
import BatchManager from '../batch-manager';

// `lookupShaderNames` and the resolvers below it read nothing off `this` except each other, so an
// instance built off the prototype exercises the real code without the M2/skin data the constructor
// needs for `calculateRuntimeValues`.
const manager = () => Object.create(BatchManager.prototype);

/** The non-table path is taken when bit 0x8000 is set. */
const OTHER = 0x8000;

describe('BatchManager#lookupShaderNames', () => {
  it('resolves the table path as before', () => {
    // opCount 1, textureMapping 0, fragment mode 0 -> the plain single-texture opaque pair.
    expect(manager().lookupShaderNames(0x00, 1, 0)).toEqual({
      vertex: 'Diffuse_T1',
      fragment: 'Combiners_Opaque',
    });
  });

  it('resolves the non-table path\'s own low bits 1-3', () => {
    expect(manager().lookupShaderNames(OTHER | 2, 1, 0)).toEqual({
      vertex: 'Diffuse_T1_Env',
      fragment: 'Combiners_Opaque_AddAlpha',
    });
  });

  it('throws a non-table shader id it cannot resolve BACK to the table, never to nothing', () => {
    // The regression this guards. `shaderNamesFromOther` returns null for low bits 0 (and for
    // anything above 3), and the real client's `sub_876530` falls back to the table lookup rather
    // than rendering nothing. Returning null here means the material takes the `Discard` fallback:
    // the batch vanishes, AND -- because a fragment shader that writes no output fails draw-time
    // validation -- every draw call logs `GL_INVALID_OPERATION: Active draw buffers with missing
    // fragment shader outputs` until the context stops reporting.
    //
    // This was invisible for as long as `assignShaders` overwrote every selection with
    // Diffuse_T1/Combiners_Opaque, because that is coincidentally what the table returns for these
    // batches. Once the override was removed, 42 batches in Ironforge stopped drawing.
    const names = manager().lookupShaderNames(OTHER, 1, 0);

    expect(names).not.toBeNull();
    expect(names).toEqual({ vertex: 'Diffuse_T1', fragment: 'Combiners_Opaque' });
  });

  it('treats an ABSENT texture mapping as T1, not T2', () => {
    // `def.textureMapping` keeps `stubDef`'s `null` whenever the batch's `textureMappingIndex` is
    // negative, and the old `textureMapping === 0 ? T1 : T2` test sent every one of those to
    // `Diffuse_T2`, which would sample the wrong texcoord set. That `Diffuse_T2` now EXISTS
    // (`material/vertex/diffuse-t2.glsl`, backed by `uv2` from `M2#createSubmeshGeometry`) makes this
    // case less loud, not less wrong: an absent mapping means "no explicit mapping", which is T1.
    for (const absent of [null, undefined]) {
      expect(manager().lookupShaderNames(0x00, 1, absent)).toEqual({
        vertex: 'Diffuse_T1',
        fragment: 'Combiners_Opaque',
      });
    }
  });

  it('still names Diffuse_T2 for an explicit T2 mapping', () => {
    expect(manager().lookupShaderNames(0x00, 1, 1).vertex).toBe('Diffuse_T2');
  });

  it('never returns null for any non-table shader id, at either op count', () => {
    const m = manager();

    for (let low = 0; low <= 8; low++) {
      for (const opCount of [1, 2]) {
        const names = m.lookupShaderNames(OTHER | low, opCount, 0);

        expect(names).not.toBeNull();
        expect(typeof names.vertex).toBe('string');
        expect(typeof names.fragment).toBe('string');
      }
    }
  });
});
