/**
 * @jest-environment node
 */
import { batchClassOf, decodeMaterialLighting, isLightingInterior, MOMT_FLAG } from '../laws';

const NO_COLOR = { r: 0, g: 0, b: 0, a: 0 };

describe('decodeMaterialLighting', () => {
  it('reads UNLIT from 0x01, not 0x10', () => {
    // 0x01 is F_UNLIT and 0x10 is F_SIDN. The old material code had these swapped, so it
    // force-unlit exactly the materials that were supposed to glow at night.
    expect(decodeMaterialLighting(0x01, NO_COLOR).unlit).toBe(true);
    expect(decodeMaterialLighting(0x10, NO_COLOR).unlit).toBe(false);
  });

  it('reads SIDN from 0x10', () => {
    expect(decodeMaterialLighting(0x10, NO_COLOR).sidn).toBe(true);
    expect(decodeMaterialLighting(0x01, NO_COLOR).sidn).toBe(false);
  });

  it('reads WINDOW from 0x20', () => {
    expect(decodeMaterialLighting(0x20, NO_COLOR).window).toBe(true);
    expect(decodeMaterialLighting(0x00, NO_COLOR).window).toBe(false);
  });

  it('normalizes the SIDN colour from bytes to 0..1', () => {
    // MOMT stores CImVector bytes. Uploading them raw makes any emissive term saturate instantly.
    const decoded = decodeMaterialLighting(MOMT_FLAG.SIDN, { r: 255, g: 128, b: 0, a: 255 });
    expect(decoded.sidnColor[0]).toBeCloseTo(1, 5);
    expect(decoded.sidnColor[1]).toBeCloseTo(128 / 255, 5);
    expect(decoded.sidnColor[2]).toBeCloseTo(0, 5);
  });

  it('zeroes the SIDN colour on a material without the SIDN flag', () => {
    // An authored colour in the chunk must not glow unless the flag says it is a SIDN material.
    const decoded = decodeMaterialLighting(0x00, { r: 255, g: 255, b: 255, a: 255 });
    expect(decoded.sidnColor).toEqual([0, 0, 0]);
  });

  it('reads the culling and clamp flags', () => {
    expect(decodeMaterialLighting(0x04, NO_COLOR).twoSided).toBe(true);
    expect(decodeMaterialLighting(0x40, NO_COLOR).clampS).toBe(true);
    expect(decodeMaterialLighting(0x80, NO_COLOR).clampT).toBe(true);
    const none = decodeMaterialLighting(0x00, NO_COLOR);
    expect([none.twoSided, none.clampS, none.clampT]).toEqual([false, false, false]);
  });

  it('decodes combined flags independently', () => {
    const decoded = decodeMaterialLighting(0x01 | 0x10 | 0x20 | 0x04, { r: 10, g: 20, b: 30, a: 255 });
    expect(decoded.unlit).toBe(true);
    expect(decoded.sidn).toBe(true);
    expect(decoded.window).toBe(true);
    expect(decoded.twoSided).toBe(true);
    expect(decoded.sidnColor[0]).toBeCloseTo(10 / 255, 5);
  });
});

describe('batchClassOf', () => {
  it('maps MOBA batch ranges to their lighting law', () => {
    // MOBA batches are ordered trans, int, ext; the loader numbers those ranges 1, 2, 3.
    expect(batchClassOf(1)).toBe('trans');
    expect(batchClassOf(2)).toBe('int');
    expect(batchClassOf(3)).toBe('ext');
  });

  it('treats an unknown or absent batch type as exterior', () => {
    // An exterior group's batches carry no meaningful class; exterior is the plain law.
    expect(batchClassOf(0)).toBe('ext');
    expect(batchClassOf(99)).toBe('ext');
  });
});

describe('isLightingInterior', () => {
  it('is interior when neither EXTERIOR nor EXTERIOR_LIT is set', () => {
    expect(isLightingInterior(0x0000)).toBe(true);
    expect(isLightingInterior(0x2000)).toBe(true);
  });

  it('is exterior when EXTERIOR (0x8) is set', () => {
    expect(isLightingInterior(0x0008)).toBe(false);
    expect(isLightingInterior(0x2008)).toBe(false);
  });

  it('is exterior when EXTERIOR_LIT (0x40) is set, even with INTERIOR also set', () => {
    // This is the case the old rule got wrong: an EXTERIOR_LIT porch flagged INTERIOR read as
    // indoors and took the interior law, where the reference lights it as outdoors.
    expect(isLightingInterior(0x0040)).toBe(false);
    expect(isLightingInterior(0x2040)).toBe(false);
  });

  it('ignores unrelated flag bits', () => {
    // 0x1 BSP, 0x4 vertex colours, 0x200 lights, 0x800 doodads -- none of them classify lighting.
    expect(isLightingInterior(0x0001 | 0x0004 | 0x0200 | 0x0800)).toBe(true);
  });
});
