/**
 * The two things about the world cursor that are pure law and that a live probe cannot pin down.
 *
 * The classifier itself is verified LIVE (`scratchpad/t23-cursor.js`: a neutral wolf at 6.27 yd ->
 * `Attack`, the same wolf at 63.67 yd -> `UnableAttack`, a friendly NPC -> `Point`, a widget under the
 * pointer -> `Point`, and the whole ladder driven through injected `UNIT_NPC_FLAGS`). What that run
 * could NOT settle is the two rows whose evidence is an ABSENCE, because Northshire has no unit
 * carrying them: the REPAIR bit being skipped and `Point` having no grayed twin.
 */
import {
  CURSOR_POINT, NPC_FLAG, cursorStem, questgiverHasQuest, serviceCursor,
} from '../cursor-mode';
import { DIALOG_STATUS } from '../../../network/game/object/quest';

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

/**
 * THE GATE THAT MADE ONE NPC UNTALKABLE.
 *
 * A QUESTGIVER-only NPC (`npcflag = 2`) classifies off bit 1 alone, and `pages/game/index.tsx`
 * dispatches the interact off that classification -- so this boolean gates the cursor AND the
 * `CMSG_GOSSIP_HELLO` together. It was hard-coded `false`, and Northshire's Eagan Peltskinner could be
 * selected but never spoken to while a gold `?` sat over his head.
 *
 * The predicate is the reference's verbatim (`cursor_mode.rs:642-645`); the two statuses it excludes
 * are named through our own 3.3.5a enum.
 */
test('a questgiver with a real status can be spoken to; NONE, UNAVAILABLE and never-sent cannot', () => {
  expect(questgiverHasQuest(DIALOG_STATUS.REWARD)).toBe(true);
  expect(questgiverHasQuest(DIALOG_STATUS.AVAILABLE)).toBe(true);
  // Never sent reads as no quest -- the reference's own rule, since the server volunteers the status.
  expect(questgiverHasQuest(undefined)).toBe(false);
  expect(questgiverHasQuest(DIALOG_STATUS.NONE)).toBe(false);
  // UNAVAILABLE draws a grey `!` and still gets no Speak: the marker and the cursor answer different
  // questions. See `quest-markers.ts#modelFor`.
  expect(questgiverHasQuest(DIALOG_STATUS.UNAVAILABLE)).toBe(false);

  // End to end through the ladder: the same flags, the two answers.
  expect(serviceCursor(NPC_FLAG.QUESTGIVER, questgiverHasQuest(DIALOG_STATUS.REWARD))).toBe('Speak');
  expect(serviceCursor(NPC_FLAG.QUESTGIVER, questgiverHasQuest(undefined))).toBeNull();
});
