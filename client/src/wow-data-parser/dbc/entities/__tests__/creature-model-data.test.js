import * as r from 'restructure';

import CreatureModelData from '../creature-model-data';

/**
 * `collisionHeight` (field 15) is what every swim depth line is a fraction of: the water must cover
 * 0.75 of the unit's OWN collision box for it to start swimming, and a surfacing swimmer rests
 * 0.75 of it below the waterline. Using one human-sized constant for every race puts a gnome's rest
 * line above her own head, so she can never surface.
 *
 * It sat inside a `Reserved(22)` block and was unreachable.
 *
 * These tests encode raw little-endian bytes and decode them, so they pin the field OFFSETS rather
 * than trusting the struct declaration to be internally consistent -- an off-by-one in the reserved
 * split would otherwise read `collisionWidth` or `mountHeight` and look perfectly plausible.
 */
describe('CreatureModelData', () => {
  const FIELD_COUNT = 28;

  function encode(fields) {
    const buffer = Buffer.alloc(FIELD_COUNT * 4);

    for (const { index, float, uint } of fields) {
      if (float !== undefined) {
        buffer.writeFloatLE(float, index * 4);
      } else {
        buffer.writeUInt32LE(uint, index * 4);
      }
    }

    return CreatureModelData.decode(new r.DecodeStream(buffer));
  }

  it('decodes collisionWidth and collisionHeight from fields 14 and 15', () => {
    const record = encode([
      { index: 0, uint: 42 },
      { index: 3, uint: 1 },
      { index: 4, float: 1.15 },
      { index: 14, float: 0.75 },
      { index: 15, float: 2.031 }
    ]);

    expect(record.id).toBe(42);
    expect(record.scale).toBeCloseTo(1.15, 5);
    expect(record.collisionWidth).toBeCloseTo(0.75, 5);
    expect(record.collisionHeight).toBeCloseTo(2.031, 5);
  });

  it('does not confuse collisionHeight with the neighbouring fields', () => {
    // soundID (13) sits immediately before collisionWidth, mountHeight (16) immediately after
    // collisionHeight. An off-by-one in either direction reads one of these instead.
    const record = encode([
      { index: 13, uint: 999 },
      { index: 14, float: 1.5 },
      { index: 15, float: 2.5 },
      { index: 16, float: 3.5 }
    ]);

    expect(record.collisionWidth).toBeCloseTo(1.5, 5);
    expect(record.collisionHeight).toBeCloseTo(2.5, 5);
  });

  it('keeps the record 28 fields wide, so the DBC row stride is unchanged', () => {
    expect(CreatureModelData.size()).toBe(FIELD_COUNT * 4);
  });

  it('still decodes the fields that were already reachable', () => {
    const record = encode([
      { index: 0, uint: 7 },
      { index: 1, uint: 0x10 },
      { index: 3, uint: 2 },
      { index: 4, float: 1.0 },
      { index: 5, uint: 3 }
    ]);

    expect(record.id).toBe(7);
    expect(record.flags).toBe(0x10);
    expect(record.sizeClass).toBe(2);
    expect(record.bloodID).toBe(3);
  });
});
