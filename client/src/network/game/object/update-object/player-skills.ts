/**
 * THE SKILLS TAB'S DATA -- `PLAYER_SKILL_INFO_1_1`, which was arriving and being discarded.
 *
 * The owner: "Reputation skills and pet tab are still don't work." This is the skills third of that,
 * and it is the cheapest of the three because **nothing new has to be fetched**: the 384 words are
 * already in every one of our own character's descriptor updates, and `readUnitFields` keeps a named
 * subset and throws the rest away. Same situation, and same remedy, as `character-stats.ts` beside it.
 *
 * ## The block, and why 128 is derived rather than transcribed
 *
 * `player_skill_info_1_1` sits at `unit_end + 0x01e8` and the next named field,
 * `player_character_points1`, at `unit_end + 0x0368` (`enums.ts:440-441`). The span is 0x180 = 384
 * words, and each skill is a TRIPLE, so the block holds exactly **128** skills. That agrees with
 * 3.3.5a's own `PLAYER_MAX_SKILLS`, and the derivation is the check on it -- the same way
 * `container-bridge.ts` derives its bag sizes from the field table instead of quoting a constant.
 *
 * ## Each triple, and the packing
 *
 *     word 0   skillId | (step  << 16)
 *     word 1   value   | (max   << 16)
 *     word 2   temporary bonus | (permanent bonus << 16)
 *
 * Low half first in all three, which is `MAKE_PAIR32(a, b) = a | (b << 16)` -- the macro TrinityCore
 * 3.3.5 writes every one of these fields through (`Player::SetSkill`). The two bonus halves are the
 * `numTempPoints` and `skillModifier` that `GetSkillLineInfo` reports separately, which is the reason
 * they are split here rather than summed: `SkillFrame_SetStatusBar` adds the temporary one to the rank
 * and draws it as a lighter section of the bar (`skillframe.lua:27-28`), so the two cannot be merged.
 *
 * ## Sparse, and MERGED
 *
 * An update mask carries only what moved -- one skill-up moves one word -- so like `character-stats.ts`
 * this merges per slot instead of rebuilding the array. A skill whose id word is 0 is an EMPTY slot,
 * not a skill with id 0: the server compacts nothing, so a character with 12 skills has 12 occupied
 * slots scattered through the 128 and the rest zero.
 */
import { ObjectType, PlayerField, getUpdateFieldName } from '../enums';

/**
 * 128 -- derived from the field table's own span. See the header.
 *
 * `/ 3` because each skill occupies three consecutive words.
 */
export const MAX_SKILLS = (PlayerField.player_character_points1
  - PlayerField.player_skill_info_1_1) / 3;

/** One occupied slot of the block. Every value is a raw descriptor half. */
export interface SkillSlot {
  /** `SkillLine.dbc` id. Never 0 -- a 0 id means the slot is empty and is not reported. */
  id: number;
  /** The profession "step" (rank tier). Not read by the Skills tab; kept because it costs nothing. */
  step: number;
  /** Current rank. */
  value: number;
  /** Maximum rank at this step. */
  max: number;
  /** `numTempPoints` -- a temporary buff to the skill. */
  tempBonus: number;
  /** `skillModifier` -- a permanent bonus (an enchant, say). */
  permBonus: number;
}

/** One buffer, reused. The skill block is all integers, so this is only here for symmetry -- unused. */
export function emptySkills(): Map<number, SkillSlot> {
  return new Map<number, SkillSlot>();
}

/**
 * Merge whatever this packet carried into `into`, keyed by descriptor SLOT INDEX (0..127).
 *
 * Keyed by slot rather than by skill id because a slot can be REASSIGNED -- unlearning a profession
 * frees its slot and the next skill learned takes it -- and a map keyed by skill id would keep the old
 * entry alive for ever. The Skills tab reads the values out, so slot order is also the only order the
 * wire offers.
 *
 * A slot whose id word arrives as 0 is DELETED from the map rather than stored: that is how the server
 * says a skill is gone, and leaving a zero-id entry would put a nameless row in the list.
 *
 * Mutates the map it was given -- the caller owns it (it hangs off the `Unit`).
 *
 * **Returns WHETHER ANYTHING CHANGED, and it used to return the map.** Same reason as
 * `character-stats.ts#mergeCharacterStats`: `readUnitFields` or-s this into the flag
 * `update-object/handler.ts:267,381` gates `world.emit('unit:fields', unit)` on, and a skill-point tick
 * writes only its own slot's words. With the map returned instead, that packet fired no event and the
 * Skills tab kept the previous reading until something else moved.
 */
export function mergePlayerSkills(
  into: Map<number, SkillSlot>,
  values: Record<string, number>,
  type: ObjectType,
): boolean {
  if (type !== ObjectType.Player) {
    return false;
  }
  let changed = false;
  const at = (index: number): number | undefined => {
    const raw = values[getUpdateFieldName(index, type)];
    return typeof raw === 'number' ? raw : undefined;
  };
  const low = (word: number): number => word & 0xffff;
  const high = (word: number): number => (word >>> 16) & 0xffff;

  for (let slot = 0; slot < MAX_SKILLS; slot += 1) {
    const base = PlayerField.player_skill_info_1_1 + slot * 3;
    const idWord = at(base);
    const valueWord = at(base + 1);
    const bonusWord = at(base + 2);
    if (idWord === undefined && valueWord === undefined && bonusWord === undefined) {
      // Nothing about this slot in this packet: unchanged.
      continue;
    }
    if (idWord !== undefined && low(idWord) === 0) {
      // `delete` answers whether the slot was actually there, which is the change: a zero id for a slot
      // we never held is the server describing an empty slot, not a skill being unlearned.
      changed = into.delete(slot) || changed;
      continue;
    }
    const existing = into.get(slot);
    const next: SkillSlot = existing !== undefined ? { ...existing } : {
      id: 0, step: 0, value: 0, max: 0, tempBonus: 0, permBonus: 0,
    };
    if (idWord !== undefined) {
      next.id = low(idWord);
      next.step = high(idWord);
    }
    if (valueWord !== undefined) {
      next.value = low(valueWord);
      next.max = high(valueWord);
    }
    if (bonusWord !== undefined) {
      next.tempBonus = low(bonusWord);
      next.permBonus = high(bonusWord);
    }
    if (next.id === 0) {
      // A bonus or value word arrived for a slot whose id we have never seen. Not storable as a skill:
      // the name comes from the id. Dropped rather than kept as a nameless row.
      continue;
    }
    if (existing === undefined
      || existing.id !== next.id || existing.step !== next.step
      || existing.value !== next.value || existing.max !== next.max
      || existing.tempBonus !== next.tempBonus || existing.permBonus !== next.permBonus) {
      changed = true;
    }
    into.set(slot, next);
  }
  return changed;
}
