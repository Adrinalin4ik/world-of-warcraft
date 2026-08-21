import { ObjectType, PlayerField, getUpdateFieldName } from '../../enums';
import { emptyQuestLog, mergeQuestLog, QUEST_STATE } from '../quest-log';

/**
 * ACCEPTING AND ABANDONING ARE BOTH DESCRIPTOR EDGES, AND THE ABANDON IS A SLOT GOING TO ZERO.
 *
 * The whole quest log rests on this: there is no `SMSG` acknowledgement for either action, so if this
 * merge is wrong the log simply never changes and every diagnosis points at the packet that was never
 * sent. One test rather than five, because accept, abandon, a kill-counter tick and a completion bit
 * are all the same sparse-mask merge over the same five words -- enumerating them would test the mask,
 * not this.
 *
 * The three things asserted are the three the bridge depends on:
 *  1. a slot arriving is a quest with its counters UNPACKED from the u16 pairs;
 *  2. a packet that mentions nothing about a slot leaves it UNCHANGED (an update mask is sparse -- a
 *     health tick must not blank the log);
 *  3. a `questId` word of 0 DELETES the slot, which is the abandon confirmation and the only one.
 *
 * The keys are built through `getUpdateFieldName` exactly as `update-object/handler.ts:733` builds
 * them, including for the third counter word -- which `enums.ts` does not name, so both sides fall back
 * to the numeric index. That fallback agreeing is the reason this merge indexes off
 * `player_quest_log_1_1 + slot * 5` instead of naming fields.
 */

const key = (index: number) => getUpdateFieldName(index, ObjectType.Player) as string;

const BASE = PlayerField.player_quest_log_1_1;

test('a quest log slot arrives, survives an unrelated packet, and is deleted by a zero id', () => {
  const log = emptyQuestLog();

  // (1) Slot 0 arrives: quest 18, complete bit set, counters 3 and 5 packed into word 2.
  expect(mergeQuestLog(log, {
    [key(BASE + 0)]: 18,
    [key(BASE + 1)]: QUEST_STATE.COMPLETE,
    [key(BASE + 2)]: 3 | (5 << 16),
    [key(BASE + 3)]: 0,
    [key(BASE + 4)]: 0,
  }, ObjectType.Player)).toBe(true);
  expect(log.get(0)).toEqual({
    slot: 0, questId: 18, state: QUEST_STATE.COMPLETE, counters: [3, 5, 0, 0], expiry: 0,
  });

  // (2) A packet about something else entirely -- the sparse-mask case.
  expect(mergeQuestLog(log, { unit_field_health: 42 }, ObjectType.Player)).toBe(false);
  expect(log.get(0)?.questId).toBe(18);

  // (3) The abandon: the id word goes to zero and the slot is gone.
  expect(mergeQuestLog(log, { [key(BASE + 0)]: 0 }, ObjectType.Player)).toBe(true);
  expect(log.size).toBe(0);
});
