/**
 * The two things about the world cursor that are pure law and that a live probe cannot pin down.
 *
 * The classifier itself is verified LIVE (`scratchpad/t23-cursor.js`: a neutral wolf at 6.27 yd ->
 * `Attack`, the same wolf at 63.67 yd -> `UnableAttack`, a friendly NPC -> `Point`, a widget under the
 * pointer -> `Point`, and the whole ladder driven through injected `UNIT_NPC_FLAGS`). What that run
 * could NOT settle is the two rows whose evidence is an ABSENCE, because Northshire has no unit
 * carrying them: the REPAIR bit being skipped and `Point` having no grayed twin.
 */
import { CURSOR_POINT, NPC_FLAG, cursorStem, serviceCursor } from '../cursor-mode';

describe('the world cursor', () => {
  it('skips the REPAIR bit and takes the lowest set service bit', () => {
    // REPAIR alone is NOT a service: the ladder never tests bit 12, so the unit falls out and lands on
    // the attack/Point leg. Verified live too (an injected `0x1000` at 8.46 yd resolved `Attack`).
    expect(serviceCursor(NPC_FLAG.REPAIR, false)).toBeNull();
    // Lowest bit wins: a gossiping vendor talks rather than sells.
    expect(serviceCursor(NPC_FLAG.GOSSIP | NPC_FLAG.VENDOR, false)).toBe('Speak');
    // A vendor shows the POUCH, not a coin -- the row a guess gets wrong.
    expect(serviceCursor(NPC_FLAG.VENDOR, false)).toBe('Pickup');
    // The QUESTGIVER bit alone needs its quest-status gate, which is a declared gap answering false.
    expect(serviceCursor(NPC_FLAG.QUESTGIVER, false)).toBeNull();
    expect(serviceCursor(NPC_FLAG.QUESTGIVER, true)).toBe('Speak');
  });

  it('has no grayed twin for Point and one for everything else', () => {
    // `unablepoint.blp` is not served (measured round 22), so an out-of-range Point stays Point.
    expect(cursorStem({ ...CURSOR_POINT, unable: true })).toBe('Point');
    expect(cursorStem({ kind: 'Attack', unable: true })).toBe('UnableAttack');
    expect(cursorStem({ kind: 'Attack', unable: false })).toBe('Attack');
  });
});
