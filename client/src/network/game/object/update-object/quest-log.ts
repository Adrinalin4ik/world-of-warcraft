/**
 * THE QUEST LOG'S SLOTS -- `PLAYER_QUEST_LOG_1_1`, which is where the quest log actually LIVES.
 *
 * This is the answer to the question the round was told to establish rather than assume: **the quest
 * log's membership and its objective COUNTERS are descriptor words, not packets.** Nothing on the
 * wire says "you now have 25 quests"; the server writes the player's `PLAYER_QUEST_LOG_*` block and
 * the client reads it. Two consequences that shape every global in `game/ui/quest-bridge.ts`:
 *
 *  - **Abandon has no acknowledgement.** `CMSG_QUESTLOG_REMOVE_QUEST` is answered by the slot's words
 *    going to zero in the next `UPDATE_OBJECT` and by nothing else (benilla states the same law for
 *    1.12: `benilla-protocol/src/messages/quest/log.rs:98-102`, "there is no ack SMSG, the field
 *    update *is* the confirmation"). So a bridge that waited for a packet would never refresh.
 *  - **Accept is confirmed the same way.** `SMSG_QUESTGIVER_QUEST_DETAILS` is the OFFER; the quest is
 *    in the log when a slot carries its id.
 *
 * What is NOT here: the quest's title, description, objective text and reward list. Those are the
 * quest TEMPLATE and they arrive through `CMSG_QUEST_QUERY` -> `SMSG_QUEST_QUERY_RESPONSE`
 * (`network/game/object/quest.ts`). So the log frame reads BOTH: this file for which quests and how
 * far along, and the template cache for what they say.
 *
 * ## The block, and why 25 is derived rather than transcribed
 *
 * `player_quest_log_1_1` sits at `unit_end + 0x000a` and the next named field,
 * `player_visible_item_1_entryid`, at `unit_end + 0x0087` (`object/enums.ts:263,+`). The span is
 * 0x7d = 125 words and each slot is FIVE words, so the block holds exactly **25** slots. That agrees
 * with 3.3.5a's own `MAX_QUEST_LOG_SIZE`, and the derivation is the check on it -- the same way
 * `player-skills.ts` derives its 128 skills from the same table instead of quoting a constant.
 *
 * The five words, per slot:
 *
 *     word 0   questId
 *     word 1   state    -- the failed/complete bits, see QUEST_STATE_*
 *     word 2   counters 0 and 1, packed as two u16
 *     word 3   counters 2 and 3, packed as two u16
 *     word 4   time     -- the unix expiry of a timed quest, 0 for an untimed one
 *
 * **`enums.ts`' names for words 2-4 are inconsistent and the OFFSETS are what this file trusts.** The
 * table calls slot 1's fourth entry `player_quest_log_1_4` at +0x0e and slot 2's `player_quest_log_2_5`
 * at +0x13 -- different suffixes for the same word of their slot, and neither slot names its third
 * counter word at all (+0x0d, +0x12). Both are simply absent from the table. This file therefore
 * indexes off `player_quest_log_1_1 + slot * 5 + word` and reads the name through
 * `getUpdateFieldName`, exactly as `player-skills.ts` does, so a gap in the table costs nothing.
 *
 * ## FOUR counters per slot, and the packing is a u16 pair
 *
 * 3.3.5a's `QUEST_OBJECTIVES_COUNT` is 4 and the two counter words hold them as four u16s. That is the
 * same packing `player-skills.ts` documents for its triples, and it is why `GetQuestLogLeaderBoard`
 * can answer "3/8" from the descriptor alone without waiting for a `SMSG_QUESTUPDATE_ADD_KILL`.
 *
 * The counter for a kill objective is the kill count; for an ITEM objective the real client does not
 * use it and counts the player's bags instead (`RequiredItemCount` against `GetItemCount`). That
 * distinction belongs to the bridge, not here; this file reports the four numbers as they arrive.
 */
import { ObjectType, PlayerField, getUpdateFieldName } from '../enums';

/**
 * `MAX_QUEST_LOG_SIZE`, derived from the field table -- see the header. Not transcribed: the span
 * between `player_quest_log_1_1` and `player_visible_item_1_entryid` divided by the 5-word stride.
 */
export const MAX_QUEST_LOG_SIZE = 25;

/** Words per slot. Fixed by the same derivation as `MAX_QUEST_LOG_SIZE`. */
export const QUEST_LOG_STRIDE = 5;

/** `QUEST_OBJECTIVES_COUNT` -- four counters, packed two to a word. */
export const QUEST_OBJECTIVES_COUNT = 4;

/**
 * The bits of word 1.
 *
 * **A SERVER-side definition, labelled as such** -- `QuestDef.h`'s `QUEST_STATE_*`, TrinityCore
 * 3.3.5. Nothing the client ships names them: no DBC carries a quest state and no FrameXML file
 * mentions the numbers. Read `IsCurrentQuestFailed`'s and `GetQuestLogTitle`'s use of them as the
 * only check available -- a wrong bit costs a "(Failed)" suffix or a completion tick, never an action.
 */
export const QUEST_STATE = {
  NONE: 0x0000,
  COMPLETE: 0x0001,
  FAIL: 0x0002,
} as const;

/** One occupied slot of the log. */
export interface QuestLogSlot {
  /** The descriptor slot, 0..24. `CMSG_QUESTLOG_REMOVE_QUEST` carries this, not the quest id. */
  slot: number;
  questId: number;
  /** Word 1 raw. Test it with `QUEST_STATE`. */
  state: number;
  /** Four objective counters, `QUEST_OBJECTIVES_COUNT` long, unpacked from words 2 and 3. */
  counters: number[];
  /** Word 4 -- the unix second a timed quest expires, or 0. */
  expiry: number;
}

export function emptyQuestLog(): Map<number, QuestLogSlot> {
  return new Map<number, QuestLogSlot>();
}

/**
 * Merge a descriptor block onto the log. Same contract as `mergePlayerSkills`: a slot the packet does
 * not mention is UNCHANGED, and a slot whose `questId` word arrives as 0 is REMOVED.
 *
 * Returns whether anything changed, so the bridge can decide whether to fire `QUEST_LOG_UPDATE`
 * rather than repainting the list on every health tick. That is the same edge `skills-bridge.ts` uses,
 * and it is the whole reason the offscreen UI target stays clean during combat.
 */
export function mergeQuestLog(
  into: Map<number, QuestLogSlot>,
  values: Record<string, number>,
  type: ObjectType,
): boolean {
  if (type !== ObjectType.Player) {
    return false;
  }
  const at = (index: number): number | undefined => {
    const raw = values[getUpdateFieldName(index, type)];
    return typeof raw === 'number' ? raw : undefined;
  };
  const low = (word: number): number => word & 0xffff;
  const high = (word: number): number => (word >>> 16) & 0xffff;

  let changed = false;

  for (let slot = 0; slot < MAX_QUEST_LOG_SIZE; slot += 1) {
    const base = PlayerField.player_quest_log_1_1 + slot * QUEST_LOG_STRIDE;
    const idWord = at(base);
    const stateWord = at(base + 1);
    const counterWord0 = at(base + 2);
    const counterWord1 = at(base + 3);
    const timeWord = at(base + 4);
    if (idWord === undefined && stateWord === undefined && counterWord0 === undefined
      && counterWord1 === undefined && timeWord === undefined) {
      // Nothing about this slot in this packet: unchanged.
      continue;
    }
    if (idWord !== undefined && (idWord >>> 0) === 0) {
      // The abandon confirmation, and the only one there is. See the header.
      if (into.delete(slot)) {
        changed = true;
      }
      continue;
    }
    const existing = into.get(slot);
    const next: QuestLogSlot = existing !== undefined
      ? { ...existing, counters: existing.counters.slice() }
      : {
        slot, questId: 0, state: 0, counters: [0, 0, 0, 0], expiry: 0,
      };
    if (idWord !== undefined) {
      next.questId = idWord >>> 0;
    }
    if (stateWord !== undefined) {
      next.state = stateWord >>> 0;
    }
    if (counterWord0 !== undefined) {
      next.counters[0] = low(counterWord0);
      next.counters[1] = high(counterWord0);
    }
    if (counterWord1 !== undefined) {
      next.counters[2] = low(counterWord1);
      next.counters[3] = high(counterWord1);
    }
    if (timeWord !== undefined) {
      next.expiry = timeWord >>> 0;
    }
    if (next.questId === 0) {
      // A counter or state word for a slot whose id we have never seen. Not storable: every global
      // the log frame calls is keyed on the quest id. Dropped rather than kept as a nameless row --
      // the same decision `player-skills.ts` takes for a bonus word with no skill id.
      continue;
    }
    if (existing !== undefined
      && existing.questId === next.questId
      && existing.state === next.state
      && existing.expiry === next.expiry
      && existing.counters.every((value, i) => value === next.counters[i])) {
      continue;
    }
    into.set(slot, next);
    changed = true;
  }

  return changed;
}

export default mergeQuestLog;
