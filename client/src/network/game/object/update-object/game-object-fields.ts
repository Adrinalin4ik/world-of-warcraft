/**
 * A GAMEOBJECT'S DESCRIPTOR BLOCK -- `GAMEOBJECT_DISPLAYID` and the three words that decide how it
 * looks and behaves.
 *
 * Step 2 of the arc `pipeline/dbc/game-object-display-data.ts` opens. What that file assumed and this
 * one confirms: **the objects were already arriving.** `applyUpdates` builds a bare `Unit` and calls
 * `world.add` for every create block regardless of type, so a bush has been sitting in
 * `World#entities` all along -- with no display id, no model and no state, because `applyUnitFields`
 * is gated on `Unit`/`Player` and nothing else read the block. So this is not "let them through"; it
 * is "read what already arrived".
 *
 * ## THE OFFSETS ARE 3.3.5a's AND THEY WERE ALREADY IN THE TABLE
 *
 * `enums.ts#GameObjectField` carries the whole block and matches 3.3.5a's `UpdateFields.h` exactly:
 * `created_by` at `object_end + 0x0000` (a guid, two words), `displayid` at `+0x0002`, `flags` at
 * `+0x0003`, `parentrotation` at `+0x0004` (four words), `dynamic` at `+0x0008`, `faction` at
 * `+0x0009`, `level` at `+0x000a`, `bytes_1` at `+0x000b`, and the block ends at `+0x000c`. Twelve
 * words, and the arithmetic closes -- 0x0004 + 4 == 0x0008, so `parentrotation` neither overlaps
 * `dynamic` nor leaves a hole. That is the check on the table rather than a restatement of it, the same
 * derivation `quest-log.ts` does for its 25 slots.
 *
 * The field-name map already listed `[ObjectType.GameObject, [ObjectField, GameObjectField]]`, so
 * `getUpdateFieldName` has been able to name these words the whole time.
 *
 * ## WHAT EACH WORD IS FOR HERE
 *
 *  - **`displayid`** -> `GameObjectDisplayInfo` -> the `.m2`. Without it there is nothing to draw.
 *  - **`dynamic`** is the SPARKLE, and it is the reason this decodes more than the display id. The
 *    owner asked for it by name ("не забудь про анимацию над объектами целями... там партиклы должны
 *    быть"). The low half is a flag word the server sets per-player, so the same crate sparkles for
 *    whoever needs it and not for anyone else -- which is exactly why it cannot be derived from the
 *    quest log on our side and has to be read off the wire.
 *  - **`bytes_1`** packs the object's STATE in its low byte -- ready versus already used, which is a
 *    door standing open or a chest already looted. A used object must not keep offering itself.
 *  - **`flags`** carries the no-interact bit the cursor leg needs.
 *  - **`level`** and **`faction`** are read for completeness and are unused so far; they matter to the
 *    reference's `go_reaction` term, which is step 5.
 *
 * `entry` comes from the shared `ObjectField` block, not this one, and is the `gameobject_template`
 * id -- the key `CMSG_GAMEOBJECT_QUERY` asks a name for.
 *
 * ## A DISCARDED RETURN WOULD HIDE THIS ENTIRELY
 *
 * `changed` is returned and the caller must use it. `CLAUDE.md` records this defect twice already --
 * `mergeQuestLog`'s boolean was thrown away and an accepted quest wrote a correct map that nothing ever
 * rebuilt from. Here the same mistake would mean a crate whose state moved to "used" keeps its sparkle
 * and stays clickable for the rest of the session, with the map correct throughout.
 */
import {
  GameObjectField, ObjectField, ObjectType, getUpdateFieldName,
} from '../enums';

/** What a GameObject's descriptor block says about it. */
export interface GameObjectState {
  /** `gameobject_template` id, off the shared `ObjectField` block. The name query's key. */
  entry: number;
  /** `GAMEOBJECT_DISPLAYID` -- the `GameObjectDisplayInfo` row, i.e. which model. */
  displayId: number;
  /** `GAMEOBJECT_FLAGS`. Carries the no-interact bit. */
  flags: number;
  /** `GAMEOBJECT_DYNAMIC`. The per-player sparkle word -- see the header. */
  dynamic: number;
  /** `GAMEOBJECT_BYTES_1`. Low byte is the state: ready, or already used. */
  bytes1: number;
  /** `GAMEOBJECT_FACTION`, for the reaction term. Unused so far. */
  faction: number;
  /** `GAMEOBJECT_LEVEL`. Unused so far. */
  level: number;
}

export function emptyGameObjectState(): GameObjectState {
  return {
    entry: 0, displayId: 0, flags: 0, dynamic: 0, bytes1: 0, faction: 0, level: 0,
  };
}

/**
 * `GO_STATE_ACTIVE` is 0 and `GO_STATE_READY` is 1 in 3.3.5a's `GOState`, with `ACTIVE_ALTERNATIVE`
 * at 2. The word is a byte pack and the state is its LOWEST byte.
 *
 * Named rather than inlined because the sense is counter-intuitive: **0 means active/used and 1 means
 * ready**, so a naive `state !== 0` test reads a fresh object as spent. A door standing open is 0.
 */
export const GO_STATE = { ACTIVE: 0, READY: 1, ACTIVE_ALTERNATIVE: 2 } as const;

/** The state byte out of `bytes_1`. See `GO_STATE` for why the sense is worth naming. */
export function goState(bytes1: number): number {
  return bytes1 & 0xff;
}

/**
 * `GO_DYNFLAG_LO_ACTIVATE` -- the bit that makes an object sparkle and offer itself.
 *
 * **The `dynamic` word is TWO `u16`s, and the flags are the LOW half.** The high half is a per-object
 * pathing/animation progress value on some types, so testing the whole word for a bit would read that
 * progress as a flag. This is the same `u16` pair packing `quest-log.ts` documents for its counters.
 *
 * The value is 0x0001 and it is what the reference's `highlightable_flags` calls
 * `GO_DYNFLAG_ACTIVATE` (`cursor_mode.rs`, the `INTERACT_COND`/`ACTIVATE` pair) -- a GameObject whose
 * template requires a condition is highlightable only while this is set. For a quest objective that
 * condition is "you have the quest", which is why the server sets it per-player.
 */
export const GO_DYNFLAG_ACTIVATE = 0x0001;

/** Whether this object should sparkle and offer itself to us right now. See `GO_DYNFLAG_ACTIVATE`. */
export function goIsActivatable(dynamic: number): boolean {
  return ((dynamic & 0xffff) & GO_DYNFLAG_ACTIVATE) !== 0;
}

/**
 * Merge a descriptor block onto a GameObject's state.
 *
 * Same contract as every other merge here: a word the packet does not carry is UNCHANGED, because a
 * values block sends only what moved. Returns whether anything did -- see the header on why that
 * return is not optional.
 */
export function mergeGameObjectFields(
  into: GameObjectState,
  values: Record<string, number>,
  type: ObjectType,
): boolean {
  if (type !== ObjectType.GameObject) {
    return false;
  }
  const at = (index: number): number | undefined => {
    const raw = values[getUpdateFieldName(index, type)];
    return typeof raw === 'number' ? raw >>> 0 : undefined;
  };

  const words: [keyof GameObjectState, number][] = [
    ['entry', ObjectField.object_field_entry],
    ['displayId', GameObjectField.gameobject_displayid],
    ['flags', GameObjectField.gameobject_flags],
    ['dynamic', GameObjectField.gameobject_dynamic],
    ['bytes1', GameObjectField.gameobject_bytes_1],
    ['faction', GameObjectField.gameobject_faction],
    ['level', GameObjectField.gameobject_level],
  ];

  let changed = false;
  for (const [key, index] of words) {
    const value = at(index);
    if (value !== undefined && into[key] !== value) {
      into[key] = value;
      changed = true;
    }
  }
  return changed;
}

export default mergeGameObjectFields;
