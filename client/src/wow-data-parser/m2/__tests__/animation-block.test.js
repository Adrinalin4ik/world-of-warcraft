/** @jest-environment node */
import { DecodeStream } from 'restructure';

import AnimationBlock from '../animation-block';
import { color16 } from '../../types';

/**
 * One animation block, laid out exactly as an M2 stores it, decoded from byte 0.
 *
 * Header (20 bytes): interpolationType u16, globalSequenceID i16, then `(count, offset)` for the
 * timestamp array and for the value array. Each of those offsets points at a run of PER-TRACK
 * `(count, offset)` pairs, and each of THOSE offsets points at the keys. Offsets are absolute from
 * the start of the file, which is what makes them reinterpretable against a sibling `.anim`
 * buffer -- see `game/pipeline/m2/anim/external-anim-data.ts`.
 */
function buildBlock() {
  const buffer = Buffer.alloc(80);
  buffer.writeUInt16LE(1, 0);        // interpolationType
  buffer.writeInt16LE(-1, 2);        // globalSequenceID
  buffer.writeUInt32LE(2, 4);        // 2 timestamp tracks
  buffer.writeUInt32LE(20, 8);       // ...at offset 20
  buffer.writeUInt32LE(2, 12);       // 2 value tracks
  buffer.writeUInt32LE(36, 16);      // ...at offset 36

  buffer.writeUInt32LE(2, 20);       // track 0: 2 timestamps
  buffer.writeUInt32LE(52, 24);      // ...at offset 52
  buffer.writeUInt32LE(1, 28);       // track 1: 1 timestamp
  buffer.writeUInt32LE(60, 32);      // ...at offset 60

  buffer.writeUInt32LE(2, 36);       // track 0: 2 values
  buffer.writeUInt32LE(64, 40);      // ...at offset 64
  buffer.writeUInt32LE(1, 44);       // track 1: 1 value
  buffer.writeUInt32LE(68, 48);      // ...at offset 68

  buffer.writeUInt32LE(100, 52);
  buffer.writeUInt32LE(500, 56);
  buffer.writeUInt32LE(250, 60);

  buffer.writeUInt16LE(32767, 64);   // color16 0.5
  buffer.writeUInt16LE(0, 66);       // color16 0.0
  buffer.writeUInt16LE(32767, 68);

  const type = AnimationBlock(color16, 'color16');
  return type.decode(new DecodeStream(buffer));
}

describe('AnimationBlock', () => {
  it('still decodes keys per track as before', () => {
    const block = buildBlock();
    expect(block.tracks).toHaveLength(2);
    expect(block.tracks[0].timestamps).toEqual([100, 500]);
    expect(block.tracks[1].timestamps).toEqual([250]);
    expect(block.tracks[0].values[0]).toBeCloseTo(1.0, 4);
    expect(block.tracks[0].values[1]).toBe(0);
  });

  // Kills dropping the ref capture, and kills capturing the COUNT word as the offset (they are
  // adjacent, and for track 0 here they are 2 and 52 -- distinguishable).
  it('records each track raw (count, offset) for the external-anim merge', () => {
    const block = buildBlock();
    expect(block.tracks[0].timestampsRef).toEqual({ count: 2, offset: 52 });
    expect(block.tracks[0].valuesRef).toEqual({ count: 2, offset: 64 });
  });

  // Kills capturing one ref for the whole block and reusing it for every track -- which is exactly
  // what the block header offers, and exactly the wrong granularity: a `.anim` merge addresses ONE
  // sequence slot.
  it('records refs PER TRACK, not per block', () => {
    const block = buildBlock();
    expect(block.tracks[1].timestampsRef).toEqual({ count: 1, offset: 60 });
    expect(block.tracks[1].valuesRef).toEqual({ count: 1, offset: 68 });
  });

  // Kills forgetting to tag the block, which would make every one of its tracks unmergeable.
  it('carries the value type name the merge decodes with', () => {
    expect(buildBlock().valueTypeName).toBe('color16');
    expect(AnimationBlock(color16).decode(new DecodeStream(Buffer.alloc(80))).valueTypeName)
      .toBe(null);
  });
});
