import * as r from 'restructure';

import { MAX_MIP_LEVELS } from './const';

/**
 * BLP2 file header.
 *
 * Fixed 1172-byte layout: 20 bytes of scalars, two 16-entry mip tables of 4 bytes each, and a
 * 1024-byte extended block. The extended block holds the color palette for COLOR_PAL images and
 * is unused padding for every other color format, but it is always present in the file, so mip
 * data begins at 1172 regardless.
 */
const header = new r.Struct({
  magic: new r.String(4),
  formatVersion: r.uint32le,
  colorFormat: r.uint8,
  alphaSize: r.uint8,
  preferredFormat: r.uint8,
  hasMips: r.uint8,
  width: r.uint32le,
  height: r.uint32le,
  mipOffsets: new r.Array(r.uint32le, MAX_MIP_LEVELS),
  mipSizes: new r.Array(r.uint32le, MAX_MIP_LEVELS),
  extended: new r.Buffer(1024)
});

export { header };
