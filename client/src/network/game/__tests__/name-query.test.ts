import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes } from '../../guid-hex';

// The owner reported a targeted PLAYER with an empty name twice, the second time after a commit that
// fixed four real defects in the handler. Two of the remaining causes are pinned here; the third
// (`Unit#isPlayer` false for every streamed player, so the guard that sends this query never fired)
// lives in `update-object/handler.ts` and needs a whole create block to exercise.
describe('CMSG_NAME_QUERY', () => {
  // THE DEFECT: the unit path passes the normalised hex STRING every guid in this client is, and
  // `writeGUID` writes `guid.raw` -- undefined for a string, which `byte-buffer` THROWS on. So the
  // very first name query from a unit would have taken out its caller rather than reaching the wire.
  it('writeGUID throws on a hex string; guidBytes writes 8 LE bytes after the header', () => {
    expect(() => new GamePacket(GameOpcode.CMSG_NAME_QUERY, 64)
      .writeGUID('0000000000000102' as never)).toThrow(/not a sequence/);

    const app = new GamePacket(GameOpcode.CMSG_NAME_QUERY, 64);
    app.write(Array.from(guidBytes('0807060504030201')));

    const bytes = new Uint8Array(app.buffer);
    const start = GamePacket.HEADER_SIZE_OUTGOING;
    expect(Array.from(bytes.slice(start, start + 8)))
      .toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  });
});

// SMSG_NAME_QUERY_RESPONSE's realm name is a lone `uint8(0)` for a same-realm player, and
// `byte-buffer`'s `readCString` does not consume the terminator of an EMPTY string. Reading the tail
// with `readCString` therefore shifted race, gender and class each one byte early. `readCStr` is the
// project's fixed reader; this pins that the fields land where the server put them.
describe('SMSG_NAME_QUERY_RESPONSE tail', () => {
  it('reads race, gender and class after an empty realm name', () => {
    const gp = new GamePacket(GameOpcode.SMSG_NAME_QUERY_RESPONSE, 64);
    gp.index = 0;
    // `writeCString` writes the bytes AND the terminator. NOT `writeString`, which exists on the
    // `byte-buffer` object at runtime but not in its type declarations -- jest passed on it while
    // `tsc` failed, which is exactly the split `CLAUDE.md` says to run both checks for.
    gp.writeCString('Fdsh');
    gp.writeUnsignedByte(0); // realm name: an empty C-string, i.e. the terminator alone
    gp.writeUnsignedByte(1); // race   -- Human
    gp.writeUnsignedByte(0); // gender -- male
    gp.writeUnsignedByte(4); // class  -- Rogue
    gp.index = 0;

    expect(gp.readCStr()).toBe('Fdsh');
    expect(gp.readCStr()).toBe('');
    expect(gp.readUnsignedByte()).toBe(1);
    expect(gp.readUnsignedByte()).toBe(0);
    expect(gp.readUnsignedByte()).toBe(4);
  });
});
