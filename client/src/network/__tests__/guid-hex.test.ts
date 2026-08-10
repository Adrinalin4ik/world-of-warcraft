/**
 * ONE assertion, happy path: the two guid representations reconcile.
 *
 * This is the blocker two prior task-9 rounds named and neither closed. `CharacterRecord.guid` is a
 * hex string (`decodeCharEnum`, whose type comment says why) and `Packet#readPackedGUID` used to OR
 * bytes into a JS Number, so `World#entities` -- a `Map<string, Unit>` -- was keyed by numbers for
 * wire objects and by a string for the player. They could never match, and the server's own
 * create-object for our character therefore made a SECOND `Unit` beside the one the world had placed.
 *
 * So what has to be true is not "readPackedGUID parses bytes" but "the ROSTER path and the WIRE path
 * answer the identical string for the identical guid". Both now go through `guidHex`
 * (`network/guid-hex.ts`), and this asserts the two ends against each other rather than either against
 * a literal -- a literal would pass for a formatter that both sides got wrong in the same way, which is
 * exactly the failure mode of two copies of one formatter.
 *
 * `0x59a6` is `Gesf`'s real guid, read off `logon.gladewow.ru`. `0xf10d33be` is the case the old code
 * got WRONG: its byte 3 has the high bit set, and `bit << 24` under `|` coerces to int32, which is how
 * a guid came back as the `-250601794` in the owner's log.
 */
import { guidHex } from '../guid-hex';
import Packet from '../net/packet';
import { encodeGuidBody } from '../protocol/wotlk/world-wire';

/** The roster's reading of a guid: 8 little-endian bytes, exactly as `decodeCharEnum` takes them. */
const fromRoster = (hex: string): string => guidHex(encodeGuidBody(hex));

/** The wire's reading: written packed, then read packed, through the real `Packet`. */
const throughThePackedWire = (hex: string): string => {
  const out = new Packet(0, 16, true);
  out.writePackedGUID(hex);
  const back = new Packet(0, out.raw.slice(0, out.index), false);
  return back.readPackedGUID();
};

describe('the guid representation', () => {
  it('reads the same string off the roster and off the packed wire', () => {
    for (const guid of [
      '0x59a6', // Gesf, live
      '0xf10d33be', // byte 3 high bit set -- the int32 case the old `|=` returned negative for
      '0xf130000000000123', // above 2^53, so no Number could have held it at all
      '0x0', // "none", which the wire sends for an absent transport and an empty target
    ]) {
      expect(fromRoster(guid)).toBe(guid);
      expect(throughThePackedWire(guid)).toBe(guid);
    }
  });
});
