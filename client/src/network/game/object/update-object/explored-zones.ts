/**
 * THE EXPLORED-ZONES BITFIELD -- `PLAYER_EXPLORED_ZONES_1`, which is where "разведанные территории"
 * actually lives.
 *
 * Like the quest log, exploration is a DESCRIPTOR and not a packet: nothing on the wire says "you have
 * discovered Goldshire". `SMSG_EXPLORATION_EXPERIENCE` announces the xp reward, but the map's own
 * question -- may this overlay be drawn -- is answered by a bit in the player's field block, and by
 * nothing else. So a bridge that waited for a message would draw an empty zone for ever.
 *
 * ## 128 words, derived rather than transcribed
 *
 * `player_explored_zones_1` sits at `unit_end + 0x037d` and the next named field,
 * `player_rest_state_experience`, at `unit_end + 0x03fd` (`network/game/object/enums.ts:462-463`). The
 * span is 0x80 = **128 words**, i.e. 4096 bits, which is the same derivation `quest-log.ts` uses for
 * its 25 slots and `player-skills.ts` for its 128 skills. It agrees with 3.3.5a's own
 * `PLAYER_EXPLORED_ZONES_SIZE`, and the derivation is the check on the constant rather than a copy of
 * it.
 *
 * ## Which bit
 *
 * `AreaTable.areaBit` is the index: bit `areaBit & 31` of word `areaBit >> 5`. The DBC gives **-1** to
 * rows that have no bit, and that value is carried rather than clamped -- word 0 bit 0 is a real area,
 * so defaulting a bitless row to 0 would mark it explored the moment the player entered that one.
 *
 * ## Cost
 *
 * A `Uint32Array(128)` -- 512 bytes for the whole session, allocated once per player. The merge is at
 * most 128 compares on a values block that mentions the words, and none at all on one that does not,
 * because an absent name reads `undefined` and is skipped. `isExplored` is one shift, one index and
 * one mask; the map's overlay loop runs it a few dozen times per open and never per frame.
 */
import { ObjectType, PlayerField, getUpdateFieldName } from '../enums';

/**
 * `PLAYER_EXPLORED_ZONES_SIZE`, derived from the field table -- see the header. The span between
 * `player_explored_zones_1` and `player_rest_state_experience`.
 */
export const EXPLORED_ZONES_WORDS = 128;

export function emptyExploredZones(): Uint32Array {
  return new Uint32Array(EXPLORED_ZONES_WORDS);
}

/**
 * Merge a descriptor block onto the bitfield. Same contract as `mergeQuestLog`: a word the packet does
 * not mention is UNCHANGED, and the return says whether anything moved.
 *
 * **The return is the point, and a discarded one is a documented defect on this project.**
 * `applyUnitFields` gates its `unit:fields` emit on it, so an exploration that arrives on its own --
 * which is exactly what walking into a new subzone produces -- must make `changed` true or the map
 * never learns it has a new patch to draw.
 */
export function mergeExploredZones(
  into: Uint32Array,
  values: Record<string, number>,
  type: ObjectType,
): boolean {
  if (type !== ObjectType.Player) {
    return false;
  }
  let changed = false;
  for (let word = 0; word < EXPLORED_ZONES_WORDS; word += 1) {
    const raw = values[getUpdateFieldName(PlayerField.player_explored_zones_1 + word, type)];
    if (typeof raw !== 'number') {
      continue;
    }
    // `>>> 0` because a word with the high bit set arrives as a negative signed int, and the
    // comparison against the stored unsigned value would then be true on every single update.
    const next = raw >>> 0;
    if (into[word] !== next) {
      into[word] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether the area whose `AreaTable.areaBit` this is has been explored.
 *
 * A negative bit -- the DBC's "this row has none" -- is never explored, and neither is one past the
 * end of the block. Both answer false rather than throwing, because the caller is a draw path.
 */
export function isAreaExplored(zones: Uint32Array, areaBit: number): boolean {
  if (areaBit < 0) {
    return false;
  }
  const word = areaBit >>> 5;
  if (word >= EXPLORED_ZONES_WORDS) {
    return false;
  }
  return (zones[word] & (1 << (areaBit & 31))) !== 0;
}
