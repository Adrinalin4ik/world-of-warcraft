import Packet from '../packet';

// THE ROOT CAUSE OF TWO DECODE DEFECTS, pinned. `byte-buffer`'s own `readCString` returns null WITHOUT
// consuming the terminator when the string is empty, so a decoder reading a fixed number of strings
// loses one byte per empty one and every field after it lands early. It cost the item query its
// quality and display id, and `SMSG_CREATURE_QUERY_RESPONSE` its `rank` -- the value the elite/rare
// border on nameplates is drawn from.
//
// The shape below is that packet's string run: one populated name, three empty name slots, an empty
// subname and an empty icon name, then the u32 tail. Six strings, five of them empty -- which is
// exactly the five bytes `rank` used to be read early by.
describe('Packet#readCStr', () => {
  it('consumes an empty string\'s terminator, so a u32 after six strings lands on the right bytes', () => {
    const body = [
      0x57, 0x6f, 0x6c, 0x66, 0x00, // "Wolf"
      0x00, 0x00, 0x00, // three empty name slots
      0x00, // empty SubName
      0x00, // empty IconName
      0x2a, 0x00, 0x00, 0x00, // the u32 that must decode as 42
    ];
    const packet = new Packet(0, new Uint8Array(body).buffer, false);

    expect(packet.readCStr()).toBe('Wolf');
    for (let i = 0; i < 5; ++i) {
      expect(packet.readCStr()).toBe('');
    }
    expect(packet.readUnsignedInt() >>> 0).toBe(42);
    expect(packet.available).toBe(0);
  });
});
