/**
 * Dimension of a mip level, clamped to a minimum of 1.
 *
 * The clamp matters for non-square textures: a 64x128 hair texture stores 8 mip levels, and at
 * level 7 an unclamped `64 >> 7` is 0, which yields a zero-byte mip that corrupts the chain when
 * uploaded. Mip dimensions bottom out at 1x1, they never reach zero.
 */
const getSizeAtMipLevel = (size: number, level: number) => Math.max(1, (size / (1 << level)) | 0);

/**
 * Pad or trim a mip level's bytes to exactly `size`.
 *
 * Some BLPs in the retail data set record a mip size that disagrees with what the dimensions imply,
 * usually by a few bytes on the smallest levels. The DXT decoders reject mismatched input outright,
 * and the GPU expects an exact block count, so normalize the length rather than fail the texture.
 */
const getResizedBytes = (bytes: Uint8Array, size: number) => {
  if (bytes.byteLength === size) {
    return bytes;
  }

  if (bytes.byteLength < size) {
    const padded = new Uint8Array(size);
    padded.set(bytes, 0);
    return padded;
  }

  const trimmed = new Uint8Array(size);
  trimmed.set(bytes.subarray(0, size), 0);
  return trimmed;
};

export { getSizeAtMipLevel, getResizedBytes };
