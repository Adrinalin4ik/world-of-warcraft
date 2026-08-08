/**
 * The reference accounting `M2Material#loadTextures` now depends on.
 *
 * WHY THIS ONE TEST AND NOT THE MATERIAL'S. The leak lives in the material -- `loadTextures()` takes
 * a fresh reference for every def it walks and, until this round, released nothing when it replaced
 * the previous set, so a re-supplied character material pinned every texture it holds for ever.
 * Measured on a real entry at Northshire: 3627 materials, 4634 `loadTextures()` calls, 1007 of them
 * redundant, and **728 loader references that could never reach zero**, which means
 * `backgroundUnload` never disposes those textures and a zone's GPU memory is not reclaimed when it
 * unloads.
 *
 * But the material cannot be constructed in a test environment -- it is an assembly of twenty-odd
 * GLSL imports and a shader table -- and the fix's whole correctness argument is about the LOADER's
 * counter, not about the material's bookkeeping. The material takes N references, then releases the
 * N keys it took last time, in that order. What has to be true for that to be safe is exactly what
 * is asserted here: releasing one of two references leaves the texture alive, and a key only becomes
 * eligible for disposal when the LAST holder lets go.
 */
import TextureLoader from '../texture-loader';

const PATH = 'Character\\Human\\Male\\HumanMaleSkin00_00.blp';

beforeEach(() => {
  jest.useFakeTimers();
  TextureLoader.cache.clear();
  TextureLoader.references.clear();
  TextureLoader.pendingUnload.clear();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('TextureLoader reference accounting', () => {
  it('keeps a texture alive while a second holder has it, and frees it when the last lets go', () => {
    const key = TextureLoader.keyFor(PATH);

    // Two holders -- the shape of a re-supply: the material takes its new reference BEFORE giving
    // the old one back, so the count goes 1 -> 2 -> 1 and never touches zero.
    TextureLoader.load(PATH);
    TextureLoader.load(PATH);
    expect(TextureLoader.references.get(key)).toBe(2);

    TextureLoader.releaseKey(key);

    // Still held. This is the assertion the take-then-release ordering exists for: had the material
    // released first, the count would have hit zero here, the key would be queued for disposal, and
    // a background sweep landing before the re-take would dispose a texture that is still on screen.
    expect(TextureLoader.references.get(key)).toBe(1);
    expect(TextureLoader.pendingUnload.has(key)).toBe(false);

    TextureLoader.releaseKey(key);

    // Last holder gone: eligible for disposal, and the count is DELETED rather than left stale.
    // Leaving it was the pre-existing off-by-one -- `load` resurrects a pending key by reading
    // `references.get(key) || 0`, so a stale 1 made the resurrected texture come back at 2 and it
    // could never be freed again.
    expect(TextureLoader.pendingUnload.has(key)).toBe(true);
    expect(TextureLoader.references.has(key)).toBe(false);
  });
});
