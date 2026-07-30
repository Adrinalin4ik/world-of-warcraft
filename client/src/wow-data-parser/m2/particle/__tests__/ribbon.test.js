/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import Ribbon, { RIBBON_SIZE } from '../ribbon';

describe('Ribbon struct', () => {
  it('consumes exactly its documented size', () => {
    const buffer = Buffer.alloc(RIBBON_SIZE * 2);
    const stream = new DecodeStream(buffer);

    Ribbon.decode(stream);

    expect(stream.pos).toBe(RIBBON_SIZE);
  });

  it('reads bone index and position', () => {
    const buffer = Buffer.alloc(RIBBON_SIZE);
    buffer.writeUInt32LE(9, 0x04);      // boneIndex
    buffer.writeFloatLE(1.5, 0x08);     // position.x

    const ribbon = Ribbon.decode(new DecodeStream(buffer));

    expect(ribbon.boneIndex).toBe(9);
    expect(ribbon.position.x).toBeCloseTo(1.5, 5);
  });
});
