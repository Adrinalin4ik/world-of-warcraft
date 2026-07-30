/**
 * @jest-environment node
 */
import * as r from 'restructure';
import { DecodeStream } from 'restructure';

import FBlock, { decodeFixed16, FIXED16_SCALE } from '../part-track';

// An FBlock lives at offset 0 and points at its two arrays further into the buffer, exactly as it
// does inside a real M2: the struct itself is only the two 8-byte M2Array descriptors.
const buildFBlockBuffer = () => {
  const buffer = Buffer.alloc(64);

  // times: M2Array<fixed16> — 3 entries at offset 16
  buffer.writeUInt32LE(3, 0);
  buffer.writeUInt32LE(16, 4);

  // values: M2Array<uint16> — 3 entries at offset 24
  buffer.writeUInt32LE(3, 8);
  buffer.writeUInt32LE(24, 12);

  buffer.writeInt16LE(0, 16);
  buffer.writeInt16LE(16384, 18);
  buffer.writeInt16LE(FIXED16_SCALE, 20);

  buffer.writeUInt16LE(10, 24);
  buffer.writeUInt16LE(20, 26);
  buffer.writeUInt16LE(30, 28);

  return buffer;
};

describe('decodeFixed16', () => {
  it('maps 0 to 0 and 32767 to 1', () => {
    expect(decodeFixed16(0)).toBe(0);
    expect(decodeFixed16(FIXED16_SCALE)).toBe(1);
  });

  it('maps the midpoint to about a half', () => {
    expect(decodeFixed16(16384)).toBeCloseTo(0.5, 4);
  });
});

describe('FBlock', () => {
  it('decodes parallel time and value arrays into normalised keys', () => {
    const stream = new DecodeStream(buildFBlockBuffer());
    const block = FBlock(r.uint16le).decode(stream);

    expect(block.values).toEqual([10, 20, 30]);
    expect(block.keys.map((key) => key.value)).toEqual([10, 20, 30]);
    expect(block.keys[0].time).toBeCloseTo(0, 5);
    expect(block.keys[1].time).toBeCloseTo(0.5, 4);
    expect(block.keys[2].time).toBeCloseTo(1, 5);
  });

  it('consumes exactly sixteen bytes, being two M2Array descriptors', () => {
    const stream = new DecodeStream(buildFBlockBuffer());
    FBlock(r.uint16le).decode(stream);

    expect(stream.pos).toBe(16);
  });

  it('produces no keys when the block is empty', () => {
    const buffer = Buffer.alloc(32);
    const stream = new DecodeStream(buffer);
    const block = FBlock(r.uint16le).decode(stream);

    expect(block.keys).toEqual([]);
  });
});
