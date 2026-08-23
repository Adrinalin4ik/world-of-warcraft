import { dxt1ToAbgr8888, getDxt1Size } from '../dxt';

/**
 * ONE test, on the level that used to THROW: a mip smaller than a DXT block.
 *
 * DXT stores whole 4x4 blocks, so a 2x2 level is one full block of which only the top-left corner is
 * part of the image. `getDxt1Size` has always agreed (it is written with `Math.ceil`); the decoder threw
 * on the same input. Every mip chain that reaches 2x2 ends in two levels it rejected -- which is how the
 * minimap player arrow failed to load, since `MinimapArrow.blp` is DXT with a chain down to 1x1.
 *
 * The block is built by hand rather than read from a file so the expected pixels are known exactly:
 * `color0` is pure red, `color1` is black, and every 2-bit index is 0, so all sixteen pixels of the
 * block decode to red. Only the four inside the 2x2 image may be written.
 */
function redBlock(): Uint8Array {
  const block = new Uint8Array(8);
  // color0 = RGB565 red (0xF800), little-endian; color1 = 0 (black). Indices (4 bytes) all 0 -> color0.
  block[0] = 0x00;
  block[1] = 0xf8;
  return block;
}

test('a DXT level smaller than one block decodes instead of throwing', () => {
  // The size function's own answer: a 2x2 level is one 8-byte DXT1 block.
  expect(getDxt1Size(2, 2)).toBe(8);

  const out = dxt1ToAbgr8888(2, 2, redBlock());

  // Exactly the 2x2 image, not the 4x4 block the encoder had to emit.
  expect(out.byteLength).toBe(2 * 2 * 4);
  // RGBA order, so every pixel is opaque red.
  expect(Array.from(out)).toEqual([
    255, 0, 0, 255, 255, 0, 0, 255,
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
});
