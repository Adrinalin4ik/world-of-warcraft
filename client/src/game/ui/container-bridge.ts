/**
 * THE BAG GLOBALS -- the engine half of `ContainerFrame`, which is the client's own XML and Lua and
 * draws itself the moment these answer.
 *
 * Nothing is drawn here. `ContainerFrame.xml` declares thirteen frames of item buttons and
 * `ContainerFrame.lua` fills them; every one of its calls was nil before this file, which is why the
 * backpack opened onto nothing. The whole deliverable is the answers.
 *
 * ## Where a bag slot's contents actually live, which is three joins deep
 *
 * There is no "inventory packet". A bag slot is reached by walking descriptor fields:
 *
 *   1. **the bag itself** -- `PLAYER_FIELD_INV_SLOT_HEAD + slot*2` on our own character, a u64 item
 *      guid per inventory slot. Slots 0-18 are worn equipment and **19-22 are the four bag slots**.
 *   2. **the slot's item** -- for the backpack, `PLAYER_FIELD_PACK_SLOT_1 + (n-1)*2`, also on our own
 *      character; for a real bag, `CONTAINER_FIELD_SLOT_1 + (n-1)*2` on the CONTAINER object, which is
 *      a separate object with its own guid and its own create block.
 *   3. **the item's identity** -- `OBJECT_FIELD_ENTRY` and `ITEM_FIELD_STACK_COUNT` on the item object,
 *      then `network/game/object/items.ts` for the template and `pipeline/dbc/item-data.ts` for the
 *      icon.
 *
 * **Every count below is READ OFF THIS CLIENT'S OWN FIELD TABLE, not chosen.** `enums.ts:427-431`
 * puts `player_field_pack_slot_1` at `unit_end + 0x0de` and `player_field_bank_slot_1` at `+ 0x0fe`, a
 * gap of 0x20 words = **16 backpack slots**; `player_field_keyring_slot_1` at `+ 0x15c` against
 * `player_field_currencytoken_slot_1` at `+ 0x19c` is 0x40 words = **32 keyring slots**; and
 * `ContainerField.container_field_slot_1` to `container_end` (`enums.ts:128-133`) is 0x48 words = a
 * **36-slot** maximum container. Those are the descriptor layout's own numbers.
 *
 * ## The field-name trap, and it is a real one
 *
 * `parseUpdateValues` keys its result by `getUpdateFieldName(index, type)`, which answers a NAME for a
 * modelled index and the bare NUMBER for anything else (`enums.ts:634`). The field tables name only
 * the FIRST entry of each array -- `player_field_pack_slot_1`, `container_field_slot_1` -- so slot 1
 * arrives under a string key and slots 2..n under numeric ones. Reading `bag.player_field_pack_slot_1`
 * in a loop would therefore find the first slot and nothing else. `fieldAt` below asks
 * `getUpdateFieldName` for the key at every index instead, which is correct for both cases and keeps
 * one copy of the table.
 *
 * ## What is NOT here, and why each is named rather than stubbed
 *
 * `locked` is a CURSOR state -- an item is locked while it is being moved -- and this client has no
 * item on its cursor, so it is nil for every slot rather than false-by-guess. The pickup/split family
 * needs that same cursor and is declared. `GetContainerItemCooldown` needs `SMSG_ITEM_COOLDOWN`, which
 * has no subscriber. Each goes through `notImplemented` so the load report names it.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { setCoinage, setItemTooltipSource, ItemTooltipInfo } from './framexml/lua/api/items';
import { CursorItemSource, getCursor, getCursorItem, setCursorItem } from './framexml/lua/api/cursor';
import { GlueArt } from './art';
import {
  ContainerField, ItemField, ObjectField, ObjectType, PlayerField,
  getUpdateFieldName,
} from '../../network/game/object/enums';
import { guidBytes, guidHex, GUID_BYTES } from '../../network/guid-hex';
import { itemData } from '../pipeline/dbc/item-data';
import { spellData } from '../pipeline/dbc/spell-data';
import { itemTooltipLines } from './item-tooltip';
import type { ItemHandler, ItemTemplate } from '../../network/game/object/items';
import GameOpcode from '../../network/game/opcode';
import GamePacket from '../../network/game/packet';

/** `BACKPACK_CONTAINER` (`containerframe.lua` addresses bag 0 as the backpack throughout). */
const BACKPACK_CONTAINER = 0;
/** `NUM_BAG_SLOTS` -- the four equipped bag slots, bag ids 1..4. */
const NUM_BAG_SLOTS = 4;
/** `KEYRING_CONTAINER`, the id `containerframe.lua:847-882` passes for the keyring. */
const KEYRING_CONTAINER = -2;

/** 16, and the number is `enums.ts`' own pack-slot block width. See the header. */
const BACKPACK_SLOTS = (PlayerField.player_field_bank_slot_1
  - PlayerField.player_field_pack_slot_1) / 2;
/** 32, from the keyring block's width in the same table. */
const KEYRING_SLOTS = (PlayerField.player_field_currencytoken_slot_1
  - PlayerField.player_field_keyring_slot_1) / 2;
/** 36, from `ContainerField`'s own span. A container never reports more than this. */
const MAX_CONTAINER_SLOTS = (ContainerField.container_end
  - ContainerField.container_field_slot_1) / 2;

/**
 * The first inventory slot a BAG occupies, 0-based, on our own character.
 *
 * 19, and it is derived rather than transcribed: `player_field_inv_slot_head` runs to
 * `player_field_inv_slot_fixme22` -- 23 slots, 0..22 -- and the last four of those are the bag slots,
 * so the first is 23 - 4 = 19. That agrees with the reference's `SLOT_BAG_FIRST`
 * (`benilla-protocol/src/messages/items.rs:562`), which is the corroboration rather than the source.
 */
const INV_SLOT_BAG_FIRST = ((PlayerField.player_field_pack_slot_1
  - PlayerField.player_field_inv_slot_head) / 2) - NUM_BAG_SLOTS;

/**
 * The wire's bag index for "not in a real bag" -- the backpack and the equipped slots.
 *
 * 255. From the reference's `BAG_PLAYER_INVENTORY` (`items.rs:558`) and unchanged in 3.3.5a; it is a
 * SERVER-side convention, not a value any served file states, and is labelled as such here.
 */
const BAG_PLAYER_INVENTORY = 255;

/**
 * The wire's slot number for the first BACKPACK slot, 0-based.
 *
 * 23 -- the descriptor slot immediately after the 23 inventory slots, which is exactly where
 * `player_field_pack_slot_1` sits in the field table. Corroborated by the reference's
 * `SLOT_PACK_FIRST` (`items.rs:560`).
 */
const WIRE_SLOT_PACK_FIRST = (PlayerField.player_field_pack_slot_1
  - PlayerField.player_field_inv_slot_head) / 2;

/**
 * THE SENTINEL that folds the player's WORN slots into the same cursor space as a bag's slots.
 *
 * -100, and both the value and the reason are the reference's: a `CursorItem` whose `bag` is this
 * addresses `slot` as a 1-based `GetInventorySlotInfo` id rather than as a bag's contents, and the
 * number is chosen to be disjoint from every real container id -- including the negative ones
 * (`BANK_CONTAINER` -1, the keyring -2) which are real API surface
 * (`benilla-ui/src/script/cursor.rs:26-36`). It never crosses the Lua boundary as a value.
 *
 * ONE space rather than two is what lets `PickupContainerItem` and `PickupInventoryItem` share a
 * transition, so a bag-to-paperdoll drag and a paperdoll-to-bag drag are the same code path.
 */
const EQUIPMENT_BAG = -100;

/**
 * A live-API `(bag, 1-based slot)` to the wire's `(bagIndex, 0-based slot)`, or null when the pair is
 * not a position on this wire.
 *
 * Ported from `benilla/src/ui_items/mod.rs:144-163`, minus the bank and keyring arms this client has no
 * feed for. The three arms it keeps:
 *  - bag 0 (the backpack) -> bag index 255, slot `WIRE_SLOT_PACK_FIRST + n - 1`;
 *  - bags 1..4 -> the equipped bag's own inventory slot `INV_SLOT_BAG_FIRST + bag - 1`, slot `n - 1`;
 *  - `EQUIPMENT_BAG` -> bag index 255, slot `n - 1` (the worn slots ARE the front of the player array).
 *
 * `UseContainerItem` computes the first two inline and predates this; they agree by construction now
 * that both read the same three constants, and the arithmetic is stated once here.
 */
function wirePos(bag: number, slot: number): [number, number] | null {
  const zero = slot - 1;
  if (!Number.isInteger(zero) || zero < 0) {
    return null;
  }
  if (bag === BACKPACK_CONTAINER) {
    return zero < BACKPACK_SLOTS ? [BAG_PLAYER_INVENTORY, WIRE_SLOT_PACK_FIRST + zero] : null;
  }
  if (bag >= 1 && bag <= NUM_BAG_SLOTS) {
    // `MAX_CONTAINER_SLOTS` (36) is the descriptor's own ceiling, not this bag's size: the exact bound
    // is the equipped bag's `CONTAINER_FIELD_NUM_SLOTS`, and the server refuses a position past it. A
    // tighter check here would need the bag object, which `wirePos` deliberately does not take.
    return zero < MAX_CONTAINER_SLOTS ? [INV_SLOT_BAG_FIRST + (bag - 1), zero] : null;
  }
  if (bag === EQUIPMENT_BAG) {
    // 1..23: the nineteen worn slots plus the four equipped-bag icons. Slot 0 is `AmmoSlot`, which is
    // not a position in the player array at all (`api/items.ts#GetInventorySlotInfo` gives it id 0) and
    // is loaded by entry through `CMSG_SET_AMMO` -- out of this space, as in the reference.
    return slot >= 1 && slot <= 23 ? [BAG_PLAYER_INVENTORY, zero] : null;
  }
  return null;
}

/**
 * Which 1-based inventory slots an item of this `inventoryType` may be EQUIPPED into. Empty = not
 * equippable.
 *
 * Transcribed from `benilla/src/ui_items/mod.rs:735-793`, which itself transcribes the SERVER's own
 * `Player::FindEquipSlot` / `ItemPrototype::GetAllowedEquipSlots` -- so the authority is the server that
 * referees the move, and `SMSG_INVENTORY_CHANGE_FAILURE` is what corrects it if a row is wrong. The ids
 * are the same 1-based numbering `GetInventorySlotInfo` answers (`api/items.ts`'s `SLOTS` table), which
 * is the check on them: head 1, chest 5, main hand 16, tabard 19, the four bags 20..23.
 *
 * INVTYPE_WEAPON (13) offers BOTH hands, which is the reference's stated simplification: whether the
 * character may actually dual-wield is a class/skill rule this client does not decode, and the server
 * refuses the move if not. INVTYPE_RELIC (28) and INVTYPE_QUIVER (27) answer empty for the same reason
 * `UnitHasRelicSlot` is a declared gap.
 */
function equipSlotsFor(inventoryType: number): number[] {
  switch (inventoryType) {
    case 1: return [1]; // HEAD
    case 2: return [2]; // NECK
    case 3: return [3]; // SHOULDERS
    case 4: return [4]; // BODY -- the shirt
    case 5: case 20: return [5]; // CHEST / ROBE, the same slot
    case 6: return [6]; // WAIST
    case 7: return [7]; // LEGS
    case 8: return [8]; // FEET
    case 9: return [9]; // WRISTS
    case 10: return [10]; // HANDS
    case 11: return [11, 12]; // FINGER
    case 12: return [13, 14]; // TRINKET
    case 13: return [16, 17]; // WEAPON -- both hands, see the note
    case 14: return [17]; // SHIELD
    case 15: return [18]; // RANGED
    case 16: return [15]; // CLOAK -> back
    case 17: return [16]; // 2HWEAPON -> main hand only
    case 18: return [20, 21, 22, 23]; // BAG
    case 19: return [19]; // TABARD
    case 21: return [16]; // WEAPONMAINHAND
    case 22: return [17]; // WEAPONOFFHAND
    case 23: return [17]; // HOLDABLE
    case 25: return [18]; // THROWN
    case 26: return [18]; // RANGEDRIGHT
    default: return [];
  }
}

/**
 * THE REFUSAL MESSAGE: `SMSG_INVENTORY_CHANGE_FAILURE`'s reason byte -> the client's own GlobalStrings
 * key, resolved to text through the VM's own `GlobalStrings.lua` and never written here.
 *
 * The owner: "there're not alerts when I'm trying to do something restrictive, like wearing a mail while
 * mage etc." Wearing mail as a mage is reason **8**, `EQUIP_ERR_PROFICIENCY_NEEDED`, and the line the
 * game prints is `ERR_PROFICIENCY_NEEDED` = "You do not have the required proficiency for that item."
 * (`globalstrings.lua:3401`).
 *
 * ## The table is the enum, and the key is derived rather than transcribed
 *
 * Below is TrinityCore 3.3.5's `InventoryResult` (`Entities/Item/ItemDefines.h`) with the `EQUIP_ERR_`
 * prefix dropped, in wire order, index == value. The GlobalStrings key is `'ERR_' + name`, and that
 * derivation is not a guess: **21 of 22 spot-checked names resolve to a real key in the served
 * `globalstrings.lua`**, including the awkward ones -- `ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS`,
 * `ERR_SHAPESHIFT_FORM_CANNOT_EQUIP`, `ERR_2HANDED_EQUIPPED`, `ERR_INV_FULL`. The one that does not is
 * `ERR_OK`, which is right: reason 0 is not a refusal and never reaches here.
 *
 * **The `_2`/`_3`/`_4`/`_5` suffixes are the enum's ALIASES, not separate messages.**
 * `EQUIP_ERR_BAG_FULL_2` has no `ERR_BAG_FULL_2` string (checked: absent), and the real client prints
 * "That bag is full." for all of them -- so a trailing `_<digit>` is stripped and the base key tried.
 * Verified absent for `_2` on BAG_FULL, WRONG_BAG_TYPE, NO_SLOT_AVAILABLE, ITEM_NOT_FOUND,
 * CANT_EQUIP_EVER, VENDOR_SOLD_OUT, CANT_STACK and INTERNAL_BAG_ERROR, and for `_3`/`_5` on BAG_FULL.
 *
 * ## Silence is what an unresolvable key does, and that is the mechanism rather than an accident
 *
 * This is the reference's law, ported (`benilla/src/ui_items/equip_error.rs:14-24`): the engine maps the
 * reason through a table and calls its display sink unconditionally, and the sink returns on an empty
 * string. So reasons whose key is simply not in `GlobalStrings.lua` print nothing WITHOUT any
 * control-flow special case -- and the one that matters is **83, `EQUIP_ERR_NONE`**, which the server
 * sends as a pure "clear the item's grey pending lock" sentinel ALONGSIDE a real message. `ERR_NONE` is
 * absent from the served strings (checked), so it is silent for free. `ERR_CANT_BE_DISENCHANTED` (59)
 * and `ERR_EVENT_AUTOEQUIP_BIND_CONFIRM` (81) are absent too, and are meant to be.
 *
 * **benilla's own numbering is NOT used and must not be**: its table is the 67-wide 1.12 enum, where
 * `PROFICIENCY_NEEDED` is 8 by coincidence but `INV_FULL` is 50 against a different neighbourhood, and
 * its reason 59 is the sentinel that is 83 here. Mechanism from the reference, numbers from this build.
 *
 * ## What is NOT read off the wire
 *
 * Two strings carry a format specifier the packet's tail would fill -- `ERR_CANT_EQUIP_LEVEL_I` ("You
 * must reach level %d to use that item.") and `ERR_PURCHASE_LEVEL_TOO_LOW`. `handleEquipError` consumes
 * only the reason byte (see its own note), so those two print with the specifier still in them. Stated
 * rather than papered over: substituting a number this client has not read would be worse than showing
 * the format.
 */
const EQUIP_ERR_NAMES: readonly string[] = [
  'OK', 'CANT_EQUIP_LEVEL_I', 'CANT_EQUIP_SKILL', 'WRONG_SLOT', 'BAG_FULL', 'BAG_IN_BAG',
  'TRADE_EQUIPPED_BAG', 'AMMO_ONLY', 'PROFICIENCY_NEEDED', 'NO_SLOT_AVAILABLE', 'CANT_EQUIP_EVER',
  'CANT_EQUIP_EVER_2', 'NO_SLOT_AVAILABLE_2', '2HANDED_EQUIPPED', '2HSKILLNOTFOUND', 'WRONG_BAG_TYPE',
  'WRONG_BAG_TYPE_2', 'ITEM_MAX_COUNT', 'NO_SLOT_AVAILABLE_3', 'CANT_STACK', 'NOT_EQUIPPABLE', 'CANT_SWAP',
  'SLOT_EMPTY', 'ITEM_NOT_FOUND', 'DROP_BOUND_ITEM', 'OUT_OF_RANGE', 'TOO_FEW_TO_SPLIT', 'SPLIT_FAILED',
  'SPELL_FAILED_REAGENTS_GENERIC', 'NOT_ENOUGH_MONEY', 'NOT_A_BAG', 'DESTROY_NONEMPTY_BAG', 'NOT_OWNER',
  'ONLY_ONE_QUIVER', 'NO_BANK_SLOT', 'NO_BANK_HERE', 'ITEM_LOCKED', 'GENERIC_STUNNED', 'PLAYER_DEAD',
  'CLIENT_LOCKED_OUT', 'INTERNAL_BAG_ERROR', 'ONLY_ONE_BOLT', 'ONLY_ONE_AMMO', 'CANT_WRAP_STACKABLE',
  'CANT_WRAP_EQUIPPED', 'CANT_WRAP_WRAPPED', 'CANT_WRAP_BOUND', 'CANT_WRAP_UNIQUE', 'CANT_WRAP_BAGS',
  'LOOT_GONE', 'INV_FULL', 'BANK_FULL', 'VENDOR_SOLD_OUT', 'BAG_FULL_2', 'ITEM_NOT_FOUND_2',
  'CANT_STACK_2', 'BAG_FULL_3', 'VENDOR_SOLD_OUT_2', 'OBJECT_IS_BUSY', 'CANT_BE_DISENCHANTED',
  'NOT_IN_COMBAT', 'NOT_WHILE_DISARMED', 'BAG_FULL_4', 'CANT_EQUIP_RANK', 'CANT_EQUIP_REPUTATION',
  'TOO_MANY_SPECIAL_BAGS', 'LOOT_CANT_LOOT_THAT_NOW', 'ITEM_UNIQUE_EQUIPPABLE', 'VENDOR_MISSING_TURNINS',
  'NOT_ENOUGH_HONOR_POINTS', 'NOT_ENOUGH_ARENA_POINTS', 'ITEM_MAX_COUNT_SOCKETED', 'MAIL_BOUND_ITEM',
  'INTERNAL_BAG_ERROR_2', 'BAG_FULL_5', 'ITEM_MAX_COUNT_EQUIPPED_SOCKETED',
  'ITEM_UNIQUE_EQUIPPABLE_SOCKETED', 'TOO_MUCH_GOLD', 'NOT_DURING_ARENA_MATCH', 'TRADE_BOUND_ITEM',
  'CANT_EQUIP_RATING', 'EVENT_AUTOEQUIP_BIND_CONFIRM', 'NOT_SAME_ACCOUNT', 'NONE',
  'ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS', 'ITEM_MAX_LIMIT_CATEGORY_SOCKETED_EXCEEDED_IS',
  'SCALING_STAT_ITEM_LEVEL_EXCEEDED', 'PURCHASE_LEVEL_TOO_LOW', 'CANT_EQUIP_NEED_TALENT',
  'ITEM_MAX_LIMIT_CATEGORY_EQUIPPED_EXCEEDED_IS', 'SHAPESHIFT_FORM_CANNOT_EQUIP',
  'ITEM_INVENTORY_FULL_SATCHEL',
];

/**
 * The `ERR_*` text for a refusal reason, out of the VM's own GlobalStrings, or null.
 *
 * Null for an unknown reason and for a key the strings do not define -- both mean "print nothing", which
 * is the engine's own behaviour. See `EQUIP_ERR_NAMES`.
 */
function equipErrorText(vm: LuaVM, reason: number): string | null {
  const name = EQUIP_ERR_NAMES[reason];
  if (name === undefined) {
    return null;
  }
  const exact = vm.getGlobal(`ERR_${name}`);
  if (typeof exact === 'string' && exact !== '') {
    return exact;
  }
  // An alias -- `BAG_FULL_2` and friends. See the header.
  const base = name.replace(/_\d+$/, '');
  if (base === name) {
    return null;
  }
  const aliased = vm.getGlobal(`ERR_${base}`);
  return typeof aliased === 'string' && aliased !== '' ? aliased : null;
}

/** A decoded descriptor bag, as `ItemHandler` stores one. */
type FieldBag = Record<string | number, number>;

/**
 * One descriptor word, addressed by INDEX rather than by name. See the header's field-name trap.
 *
 * Absent is 0, which is the right answer for every field here: an empty inventory slot's guid words
 * are genuinely zero on the wire, and a stack count that has not arrived is not a stack.
 */
function fieldAt(bag: FieldBag | null, type: ObjectType, index: number): number {
  if (bag === null) {
    return 0;
  }
  const value = bag[getUpdateFieldName(index, type) as keyof FieldBag];
  return typeof value === 'number' ? value >>> 0 : 0;
}

/**
 * A u64 guid held as two consecutive descriptor words -> the normalised hex string.
 *
 * The low word first, the high word second, both little-endian into the byte array `guidHex` reads.
 * Assembling this as a Number would be the exact defect `guid-hex.ts` exists to prevent.
 */
function guidAt(bag: FieldBag | null, type: ObjectType, index: number): string {
  const low = fieldAt(bag, type, index);
  const high = fieldAt(bag, type, index + 1);
  const bytes = new Uint8Array(GUID_BYTES);
  for (let i = 0; i < 4; ++i) {
    bytes[i] = (low >>> (i * 8)) & 0xff;
    bytes[i + 4] = (high >>> (i * 8)) & 0xff;
  }
  return guidHex(bytes);
}

/** `0x0` is the wire's "nothing here". */
const EMPTY_GUID = '0x0';

/**
 * `inventoryType` -> the `INVTYPE_*` token `GetItemInfo` answers ninth.
 *
 * **The ORDER is engine-side and is transcribed, not read from a served file** -- said plainly per the
 * project rule. What IS sourced is the token SET and the fact that these are token names rather than
 * display strings: `globalstrings.lua` defines `INVTYPE_HEAD`, `INVTYPE_WEAPONMAINHAND` and the rest as
 * localized strings, and FrameXML looks the API's answer up in `_G` to print it -- so answering a
 * display string here would print nothing. Index 0 is "not equippable" and answers nil.
 */
const INVENTORY_TYPE_TOKENS: ReadonlyArray<string | null> = [
  null, 'INVTYPE_HEAD', 'INVTYPE_NECK', 'INVTYPE_SHOULDER', 'INVTYPE_BODY', 'INVTYPE_CHEST',
  'INVTYPE_WAIST', 'INVTYPE_LEGS', 'INVTYPE_FEET', 'INVTYPE_WRIST', 'INVTYPE_HAND', 'INVTYPE_FINGER',
  'INVTYPE_TRINKET', 'INVTYPE_WEAPON', 'INVTYPE_SHIELD', 'INVTYPE_RANGED', 'INVTYPE_CLOAK',
  'INVTYPE_2HWEAPON', 'INVTYPE_BAG', 'INVTYPE_TABARD', 'INVTYPE_ROBE', 'INVTYPE_WEAPONMAINHAND',
  'INVTYPE_WEAPONOFFHAND', 'INVTYPE_HOLDABLE', 'INVTYPE_AMMO', 'INVTYPE_THROWN',
  'INVTYPE_RANGEDRIGHT', 'INVTYPE_QUIVER', 'INVTYPE_RELIC',
];

/**
 * `ITEM_FLAG_LOOTABLE` -- an item that can be opened for loot (a lockbox, a container).
 *
 * `0x4`, from the reference's constant (`benilla-protocol/src/messages/items.rs:274`). The bit's value
 * is a SERVER-side definition and this client has nothing to check it against; it is used only for
 * `GetContainerItemInfo`'s sixth return, which `containerframe.lua` reads once, so a wrong reading
 * mislabels a lockbox and nothing else.
 */
const ITEM_FLAG_LOOTABLE = 0x4;

/** What one occupied slot resolves to. */
interface SlotItem {
  guid: string;
  entry: number;
  count: number;
  template: ItemTemplate | null;
}

export function attachContainerBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const items: ItemHandler = world.game.objectHandler.itemHandler;

  // -- Reading the three joins ------------------------------------------------------------------

  /** The equipped bag in bag id 1..4, as an item guid. `0x0` when that slot is empty. */
  const bagGuid = (bagId: number): string => {
    if (bagId < 1 || bagId > NUM_BAG_SLOTS) {
      return EMPTY_GUID;
    }
    const slot = INV_SLOT_BAG_FIRST + (bagId - 1);
    return guidAt(items.player(), ObjectType.Player,
      PlayerField.player_field_inv_slot_head + slot * 2);
  };

  /** `GetContainerNumSlots`' answer, per the header's derivation of each number. */
  const numSlots = (bagId: number): number => {
    if (bagId === BACKPACK_CONTAINER) {
      return BACKPACK_SLOTS;
    }
    if (bagId === KEYRING_CONTAINER) {
      return KEYRING_SLOTS;
    }
    if (bagId < 1 || bagId > NUM_BAG_SLOTS) {
      // Bank bags (5..11) are a real part of the id space `containerframe.lua` walks, and this client
      // decodes no bank. Zero is the honest answer and is what the client's own bag-bar loop
      // (`containerframe.lua:804`) already tests for.
      return 0;
    }
    const guid = bagGuid(bagId);
    if (guid === EMPTY_GUID) {
      return 0;
    }
    // The CONTAINER object's own field. The template's `containerSlots` is the same number and is
    // available earlier, so it stands in until the container object's create block lands -- a bag that
    // is equipped is always sent, but not necessarily before the first repaint.
    const declared = fieldAt(items.object(guid), ObjectType.Container,
      ContainerField.container_field_num_slots);
    if (declared > 0) {
      return Math.min(declared, MAX_CONTAINER_SLOTS);
    }
    const entry = fieldAt(items.object(guid), ObjectType.Container, ObjectField.object_field_entry);
    const template = entry > 0 ? items.template(entry, guid) : null;
    return Math.min(template?.containerSlots ?? 0, MAX_CONTAINER_SLOTS);
  };

  /** The item guid in one bag slot, 1-based as every FrameXML caller passes it. */
  const slotGuid = (bagId: number, slot: number): string => {
    if (slot < 1) {
      return EMPTY_GUID;
    }
    if (bagId === BACKPACK_CONTAINER) {
      return slot > BACKPACK_SLOTS ? EMPTY_GUID : guidAt(items.player(), ObjectType.Player,
        PlayerField.player_field_pack_slot_1 + (slot - 1) * 2);
    }
    if (bagId === KEYRING_CONTAINER) {
      return slot > KEYRING_SLOTS ? EMPTY_GUID : guidAt(items.player(), ObjectType.Player,
        PlayerField.player_field_keyring_slot_1 + (slot - 1) * 2);
    }
    const container = bagGuid(bagId);
    if (container === EMPTY_GUID || slot > numSlots(bagId)) {
      return EMPTY_GUID;
    }
    return guidAt(items.object(container), ObjectType.Container,
      ContainerField.container_field_slot_1 + (slot - 1) * 2);
  };

  /**
   * Resolve one item guid to what a bag row needs.
   *
   * `items.template` is the call that ISSUES the query on a cold entry (see its own doc), so this is
   * where a bag first asks the server for a name -- and it returns null that first time, which is why
   * `templatesChanged` re-fires `BAG_UPDATE` below.
   */
  const itemAt = (guid: string): SlotItem | null => {
    if (guid === EMPTY_GUID) {
      return null;
    }
    const bag = items.object(guid);
    if (bag === null) {
      return null;
    }
    const entry = fieldAt(bag, ObjectType.Item, ObjectField.object_field_entry);
    if (entry === 0) {
      return null;
    }
    return {
      guid,
      entry,
      count: fieldAt(bag, ObjectType.Item, ItemField.item_field_stack_count),
      template: items.template(entry, guid),
    };
  };

  /**
   * The icon path for an item, wire answer preferred.
   *
   * Two roads, both real: the query response's `displayInfoId` is authoritative, and `Item.dbc`'s own
   * column answers before the query lands. See `item-data.ts`' header.
   */
  const iconFor = (item: SlotItem): string | null => {
    const fromWire = item.template !== null && item.template.displayInfoId > 0
      ? itemData.iconForDisplayId(item.template.displayInfoId)
      : null;
    return fromWire ?? itemData.iconForEntry(item.entry);
  };

  /**
   * The `|Hitem:...|h[Name]|h` hyperlink `GetContainerItemLink` and `GetItemInfo` answer.
   *
   * The twelve numeric fields after the entry are enchant, three gems, a suffix, a unique id, the
   * player's level and three reforge/upgrade words. This client decodes none of them and writes zeros,
   * which is what an unenchanted, ungemmed item's link genuinely is -- so the link is correct for the
   * common case and understates a socketed one. `HandleModifiedItemClick` and the tooltip parse the
   * entry out of position 2, which is the part that has to be right.
   */
  const itemLink = (item: SlotItem): string | null => {
    if (item.template === null) {
      return null;
    }
    const quality = item.template.quality;
    const answer = vm.runExpr(
      `local _,_,_,hex = GetItemQualityColor(${quality}) return hex`, 'item-link.lua',
    ) as { value?: unknown } | null;
    const hex = String(answer?.value ?? '|cffffffff');
    return `${hex}|Hitem:${item.entry}:0:0:0:0:0:0:0:0:0:0|h[${item.template.name}]|h|r`;
  };

  // -- The globals --------------------------------------------------------------------------------

  vm.registerFunction('GetContainerNumSlots', (args) => [numSlots(Number(args[0]))]);

  /**
   * `GetContainerItemInfo(bagID, slot)` -> `texture, itemCount, locked, quality, readable, lootable,
   * itemLink`.
   *
   * SEVEN returns, and the count is read off the client's own two call sites rather than assumed:
   * `containerframe.lua:281` takes the first five and `:684` takes the seventh
   * (`refundItemTexture, _, _, _, _, _, refundItemLink`).
   *
   * An EMPTY slot answers nothing at all -- not a row of nils. `ContainerFrame_Update:298` branches on
   * `if ( texture )`, and `PutKeyInKeyRing` (`:882`) finds an empty keyring slot the same way.
   */
  vm.registerFunction('GetContainerItemInfo', (args) => {
    const bagId = Number(args[0]);
    const slotId = Number(args[1]);
    const item = itemAt(slotGuid(bagId, slotId));
    if (item === null) {
      return [];
    }
    const lootable = item.template !== null
      && (item.template.flags & ITEM_FLAG_LOOTABLE) !== 0;
    // `locked` -- TRUE while this slot is the cursor's SOURCE, which is what dims the icon the instant
    // the item is picked up. `ContainerFrame_Update` passes it to `SetItemButtonDesaturated`
    // (`containerframe.lua:281,306`). It used to be nil with the note "no cursor, so no locked slot";
    // there is a cursor now (see the item-cursor section), and this is the bag twin of
    // `IsInventoryItemLocked`. Still nil rather than false when nothing is held, because the real
    // client's own pending-move lock is not modelled and a hard false would assert more than we know.
    const heldHere = (() => {
      const held = getCursorItem(vm);
      return held !== null && held.bag === bagId && held.slot === slotId ? 1 : null;
    })();
    return [
      iconFor(item),
      item.count,
      heldHere,
      item.template?.quality ?? null,
      // `readable` -- a book or a scroll with page text. `pageText` is read off the wire but not kept
      // (`items.ts#readTemplateBody`), so this is nil rather than wrong.
      null,
      lootable ? 1 : null,
      itemLink(item),
    ];
  });

  vm.registerFunction('GetContainerItemLink', (args) => {
    const item = itemAt(slotGuid(Number(args[0]), Number(args[1])));
    return [item === null ? null : itemLink(item)];
  });

  /**
   * `ContainerIDToInventoryID(bagID)` -> the 1-BASED inventory slot id, i.e. `INVSLOT_BAG1` = 20.
   *
   * The off-by-one is the API's, not ours: the descriptor table is 0-based (bag 1 is descriptor slot
   * 19) and `GetInventoryItemTexture` takes the 1-based id, so the two differ by exactly one and the
   * conversion has to happen somewhere. It happens here, once.
   */
  vm.registerFunction('ContainerIDToInventoryID', (args) => {
    const bagId = Number(args[0]);
    if (bagId < 1 || bagId > NUM_BAG_SLOTS) {
      return [null];
    }
    return [INV_SLOT_BAG_FIRST + bagId];
  });

  /** `GetBagName(bagID)` -> the bag's item name. The backpack has none; `containerframe.lua:506`
   * sets the frame title from this and the backpack's frame is titled by the XML instead. */
  vm.registerFunction('GetBagName', (args) => {
    const bagId = Number(args[0]);
    if (bagId < 1 || bagId > NUM_BAG_SLOTS) {
      return [null];
    }
    const item = itemAt(bagGuid(bagId));
    return [item?.template?.name ?? null];
  });

  /**
   * `GetInventoryItemTexture(unit, invSlot)` -> the icon for a WORN item.
   *
   * Only `"player"` answers: no other unit's inventory guids reach this client (a peer's gear arrives
   * as `player_visible_item_*` ENTRY ids, which `character-identity.ts` reads for dressing and which
   * carry no guid at all). The bag bar's four buttons are the caller that matters here.
   */
  vm.registerFunction('GetInventoryItemTexture', (args) => {
    if (String(args[0]).toLowerCase() !== 'player') {
      return [null];
    }
    const invId = Number(args[1]);
    if (!Number.isFinite(invId) || invId < 1) {
      return [null];
    }
    const item = itemAt(guidAt(items.player(), ObjectType.Player,
      PlayerField.player_field_inv_slot_head + (invId - 1) * 2));
    return [item === null ? null : iconFor(item)];
  });

  /**
   * `GetItemInfo(itemID|itemLink|itemName)` -> eleven returns.
   *
   * Only the ID and the LINK forms resolve. A NAME lookup would need a name->entry index over every
   * item the server has ever described, and this client has only the entries it has actually seen; a
   * partial name index would answer for some items and silently not for others, which is worse than
   * not answering.
   *
   * **`itemType` and `itemSubType` (returns 6 and 7) are a DECLARED GAP.** They are the localized
   * `ItemClass.dbc` / `ItemSubClass.dbc` names, both of which are served and neither of which this
   * client joins yet. They come back nil rather than as the raw numbers, because the callers
   * concatenate them into a tooltip line and a number there would read as a wrong name rather than as
   * a missing one.
   */
  vm.registerFunction('GetItemInfo', (args) => {
    const raw = args[0];
    let entry = Number(raw);
    if (!Number.isFinite(entry) || entry <= 0) {
      const match = /\|Hitem:(\d+)/.exec(String(raw ?? ''));
      entry = match === null ? 0 : Number(match[1]);
    }
    if (entry <= 0) {
      return [];
    }
    const template = items.template(entry);
    if (template === null) {
      // Pending or answered-unknown; either way there is nothing to say yet. The caller re-runs on
      // `BAG_UPDATE`, which `templatesChanged` fires.
      return [];
    }
    const item: SlotItem = { guid: EMPTY_GUID, entry, count: 1, template };
    return [
      template.name,
      itemLink(item),
      template.quality,
      template.itemLevel,
      template.requiredLevel,
      null, // itemType -- declared gap, see the doc above
      null, // itemSubType -- ditto
      template.stackable,
      INVENTORY_TYPE_TOKENS[template.inventoryType] ?? null,
      iconFor(item),
      template.sellPrice,
    ];
  });

  /**
   * `GetItemCount(itemID|link[, includeBank[, includeCharges]])` -> how many the player holds.
   *
   * Walks the backpack, the four bags and the keyring. The bank is not decoded, so `includeBank` is
   * accepted and cannot change the answer -- named here rather than silently ignored.
   */
  vm.registerFunction('GetItemCount', (args) => {
    let entry = Number(args[0]);
    if (!Number.isFinite(entry) || entry <= 0) {
      const match = /\|Hitem:(\d+)/.exec(String(args[0] ?? ''));
      entry = match === null ? 0 : Number(match[1]);
    }
    if (entry <= 0) {
      return [0];
    }
    let total = 0;
    for (const bagId of [BACKPACK_CONTAINER, 1, 2, 3, 4, KEYRING_CONTAINER]) {
      for (let slot = 1; slot <= numSlots(bagId); ++slot) {
        const item = itemAt(slotGuid(bagId, slot));
        if (item !== null && item.entry === entry) {
          total += Math.max(1, item.count);
        }
      }
    }
    return [total];
  });

  /**
   * `GetContainerNumFreeSlots(bagID)` -> `freeSlots, bagType`.
   *
   * `bagType` is the item's `BagFamily`, which `readTemplateBody` reads and does not keep, so it is 0
   * -- the value that means "holds anything", and the one the backpack genuinely has.
   * `MainMenuBarBackpackButton` sums the first return across the bags to print the free-bag-slot count.
   */
  vm.registerFunction('GetContainerNumFreeSlots', (args) => {
    const bagId = Number(args[0]);
    const size = numSlots(bagId);
    let free = 0;
    for (let slot = 1; slot <= size; ++slot) {
      if (slotGuid(bagId, slot) === EMPTY_GUID) {
        free += 1;
      }
    }
    return [free, 0];
  });

  /**
   * `CMSG_USE_ITEM` (**0x0AB**) -- the "use" gesture, for anything a right-click does not EQUIP.
   *
   * ## The layout, and where it comes from
   *
   * LABELLED, per this project's rule: the body's field order is transcribed from a SERVER
   * implementation (TrinityCore 3.3.5's `WorldSession::HandleUseItemOpcode`), the same source the loot
   * family's layouts are credited to at `network/game/object/loot.ts`. The opcode number itself is this
   * client's own table (`network/game/opcode.js:173`).
   *
   *     u8  bagIndex        the wire bag index -- 255 for the backpack and the equipped slots
   *     u8  slot            the wire slot within that bag
   *     u8  castCount       the cast id the server echoes back; any value, and 1 is ours
   *     u32 spellId         WHICH of the item's five spells to use -- see below
   *     u64 itemGUID        the item instance, FULL and not packed
   *     u32 glyphIndex      0 for anything that is not a glyph
   *     u8  castFlags       0 -- the pending-cast/proc flags, none of which a plain use sets
   *     ... SpellCastTargets
   *
   * ## `SpellCastTargets`, which is the whole reason this was a declared gap
   *
   * `SpellCastTargets::Read` begins with a `u32` target MASK and then reads one packed guid or one
   * coordinate triple per flag set in it -- unit, gameobject, item, corpse, a source location, a
   * destination location, a string. **A self-cast sets NO flags**: `TARGET_FLAG_SELF` is 0 in 3.3.5a,
   * so the whole block for "use this on myself" is one zero word, and every conditional read is
   * skipped. That is what is written here, and it is why the block is four bytes rather than a
   * structure.
   *
   * **What is NOT built is a TARGETED use** -- a bandage on a party member, a key on a chest, an
   * enchant on an item in a bag. Those set `TARGET_FLAG_UNIT` / `TARGET_FLAG_GAMEOBJECT` /
   * `TARGET_FLAG_ITEM` and carry a packed guid, and they arrive through the item CURSOR
   * (`SpellCanTargetItem`, `PickupContainerItem`), which is a separate declared gap. `notImplemented`
   * names it below.
   *
   * ## `spellId` is a lookup, not a constant
   *
   * The server checks the id against the item's own five spell blocks and refuses anything else, so it
   * cannot be 0. The one used is the item's first ON_USE spell -- `spellTrigger == 0`, the same
   * `ITEM_SPELL_TRIGGER_ONUSE` value `ui/item-tooltip.ts` labels -- and an item with none is not
   * usable at all, which is why that case sends nothing rather than sending a zero.
   */
  const sendUseItem = (
    wireBag: number,
    wireSlot: number,
    guid: string,
    template: ItemTemplate,
  ): void => {
    const onUse = template.spells.find((spell) => spell.trigger === 0);
    if (onUse === undefined) {
      // Not a failure and not a gap: an item with no on-use spell has nothing to do when right-clicked,
      // and the real client does nothing either.
      return;
    }
    const body = 1 + 1 + 1 + 4 + 8 + 4 + 1 + 4;
    const gp = new GamePacket(
      GameOpcode.CMSG_USE_ITEM, GamePacket.HEADER_SIZE_OUTGOING + body,
    );
    gp.writeUnsignedByte(wireBag & 0xff);
    gp.writeUnsignedByte(wireSlot & 0xff);
    // The cast count. OURS: the server only echoes it back in `SMSG_SPELL_START`/`GO`, and nothing here
    // reads that echo yet, so a constant is honest. 0 is avoided because the client's own casts number
    // from 1 and a zero would be indistinguishable from an unset field on a capture.
    gp.writeUnsignedByte(1);
    gp.writeUnsignedInt(onUse.id >>> 0);
    // FULL, not packed -- the same reasoning `ItemHandler#requestTemplate` records for its own guid.
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(0); // glyphIndex
    gp.writeUnsignedByte(0); // castFlags
    // `SpellCastTargets`: the mask alone, all flags clear = TARGET_FLAG_SELF. See the header.
    gp.writeUnsignedInt(0);
    world.game.send(gp);
  };

  /**
   * `UseInventoryItem(slot)` -- the right-click on a PAPERDOLL slot, i.e. on a WORN item.
   *
   * `PaperDollItemSlotButton_OnClick` calls it (`paperdollframe.lua`) and it was registered NOWHERE, so
   * the paperdoll right-click raised on a nil global. It is a USE and never an equip: the item is
   * already worn, so a right-click fires its on-use effect -- a trinket, a tabard toggle -- and an
   * equipped item with no on-use spell does nothing, which `sendUseItem` already handles.
   *
   * The wire pair for a worn item is bag 255 with the ZERO-BASED equipment slot. `slot` arrives 1-based
   * because that is what `GetInventorySlotInfo` answers and what the button's `SetID` stored (see
   * `api/items.ts#GetInventorySlotInfo`), so it is the same `- 1` the tooltip's `'inventory'` kind does.
   */
  vm.registerFunction('UseInventoryItem', (args) => {
    const slot = Number(args[0]);
    if (!Number.isFinite(slot) || slot < 1) {
      return [];
    }
    const item = itemAt(guidAt(items.player(), ObjectType.Player,
      PlayerField.player_field_inv_slot_head + (slot - 1) * 2));
    if (item === null || item.template === null) {
      return [];
    }
    sendUseItem(BAG_PLAYER_INVENTORY, slot - 1, item.guid, item.template);
    return [];
  });

  /**
   * `UseContainerItem(bagID, slot)` -- the right-click. BOTH arms are real now.
   *
   * **THE EQUIP ARM WAS ALREADY CORRECT AND WAS NEVER REACHED.** The owner reported "вещи не
   * надеваются" and the diagnosis handed down was the `SpellCastTargets` gap below; it was wrong.
   * `ContainerFrameItemButton_OnClick` (`containerframe.lua:693`) branches on its `button` argument,
   * and `ui/input.ts` reported EVERY click as `"LeftButton"` -- so a right-click took the LEFT branch,
   * `PickupContainerItem`, which is the declared item-cursor gap. `CMSG_AUTOEQUIP_ITEM` was built and
   * sent by code nothing could call. See `Widget#clickButtons`.
   *
   * An equippable item goes out as `CMSG_AUTOEQUIP_ITEM` (**0x10A**), whose body is two bytes -- the
   * wire bag index and the wire slot -- and which the server resolves entirely on its own.
   *
   * The two wire numbers are NOT the Lua ones. The backpack and the equipped slots use bag index 255
   * with a slot numbered from 23; a real bag uses its own inventory slot (19..22) with a slot numbered
   * from 0. Both constants are derived from this client's field table above and corroborated against
   * the reference (`items.rs:558-562`).
   */
  vm.registerFunction('UseContainerItem', (args) => {
    const bagId = Number(args[0]);
    const slot = Number(args[1]);
    const item = itemAt(slotGuid(bagId, slot));
    if (item === null || item.template === null) {
      return [];
    }
    // THE WIRE PAIR IS COMPUTED BEFORE THE ARMS SPLIT, because both of them need it. `CMSG_USE_ITEM`
    // takes the same bag/slot pair `CMSG_AUTOEQUIP_ITEM` does -- passing the LUA numbers to one and the
    // wire numbers to the other would have used the wrong slot for every consumable in the backpack.
    let wireBag: number;
    let wireSlot: number;
    if (bagId === BACKPACK_CONTAINER) {
      wireBag = BAG_PLAYER_INVENTORY;
      wireSlot = WIRE_SLOT_PACK_FIRST + (slot - 1);
    } else if (bagId >= 1 && bagId <= NUM_BAG_SLOTS) {
      wireBag = INV_SLOT_BAG_FIRST + (bagId - 1);
      wireSlot = slot - 1;
    } else {
      return [];
    }
    if (item.template.inventoryType === 0) {
      // The USE arm: a consumable, a quest item, anything not equippable. `CMSG_USE_ITEM` and the
      // `SpellCastTargets` block it ends with are both built in `sendUseItem` above.
      sendUseItem(wireBag, wireSlot, item.guid, item.template);
      return [];
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_AUTOEQUIP_ITEM, GamePacket.HEADER_SIZE_OUTGOING + 2,
    );
    gp.writeUnsignedByte(wireBag & 0xff);
    gp.writeUnsignedByte(wireSlot & 0xff);
    world.game.send(gp);
    return [];
  });

  // -- THE ITEM CURSOR: pick up, put down, and tell the server -----------------------------------
  //
  // The owner's report was "drag and drop не работает" -- in the bags and in the character window. The
  // gesture was never missing: `ui/input.ts` has driven `OnDragStart`/`OnReceiveDrag` since the
  // action-bar round, and BOTH ends are the client's own Lua on BOTH surfaces --
  // `containerframe.xml:61-66` routes each to `ContainerFrameItemButton_OnDrag`, which is one line
  // calling `ContainerFrameItemButton_OnClick(self, "LeftButton")` (`containerframe.lua:623-625`), and
  // `paperdollframe.xml:57-62` routes both to `PaperDollItemSlotButton_OnClick(self, "LeftButton")`
  // directly. Each of those ends in `PickupContainerItem` / `PickupInventoryItem`.
  // What was missing is that `PickupContainerItem` was a DECLARED GAP and `PickupInventoryItem` was
  // registered nowhere -- there was no item on this client's cursor to pick anything up onto -- so both
  // the left-click and the drag ended in a stub or a nil global.
  //
  // The state and the payload type live in `api/cursor.ts` (one payload space, three kinds); every
  // transition lives here, because every transition needs the world: the descriptor read that resolves
  // a slot to an item, and the socket that tells the server. See `api/cursor.ts`' header.
  //
  // THE RULES BELOW ARE THE REFERENCE'S, arm for arm
  // (`benilla-ui/src/script/container.rs:229-297` for the bag seam,
  // `benilla-ui/src/script/cursor/doll.rs:35-110` for the paperdoll one):
  //   empty cursor + an occupied slot  -> pick it up
  //   holding + the SAME slot          -> cancel, put it back
  //   holding + another slot           -> queue the move and CLEAR (the displaced item does NOT hop
  //                                       onto the cursor -- bag placements are server-authoritative;
  //                                       only the ACTION bar hops, which is `api/cursor.ts`' arm)
  //   holding a spell or an action     -> refuse, keep holding

  /** The picked-up payload for a live item, or null when the slot is empty or unresolved. */
  const payloadFor = (bag: number, slot: number, item: SlotItem): CursorItemSource => ({
    bag,
    slot,
    itemId: item.entry,
    link: itemLink(item),
    // The two `DELETE_ITEM_CONFIRM` arguments, captured HERE and not at the drop -- see
    // `CursorItemSource`.
    //
    // **A LIMITATION, STATED: quality 0 for an unresolved template DOWNGRADES the prompt.** The stern
    // "type DELETE" dialogue is chosen on `>= 3` (`uiparent.lua:611`), so an item whose template has
    // not arrived gets the plain Yes/No instead. That window is small -- the row cannot be drawn
    // without its template, so anything the player can see and pick up has one -- but it is real, and
    // the alternative (defaulting to 3 so the stern prompt always wins) would make every grey item ask
    // the player to type a word, which is not the game's behaviour either. Not papered over.
    name: item.template?.name ?? null,
    quality: item.template?.quality ?? 0,
    equipSlots: item.template === null ? [] : equipSlotsFor(item.template.inventoryType),
  });

  /**
   * `ITEM_LOCK_CHANGED(bag, slot)` -- the source slot dims the instant it is picked up.
   *
   * `ContainerFrameItemButton_OnEvent` and `PaperDollItemSlotButton_OnEvent` both answer it
   * (`containerframe.lua`, `paperdollframe.lua:1197-1199`), and the reference fires it on both ends of
   * every move for the same reason (`benilla/src/ui_items/drain.rs:522-531`). The paperdoll arm reports
   * the LUA slot id with no bag, which is the shape `PaperDollItemSlotButton_OnEvent` tests
   * (`not arg2 and arg1 == self:GetID()`).
   */
  const lockChanged = (bag: number, slot: number): void => {
    if (bag === EQUIPMENT_BAG) {
      fireEvent(vm, 'ITEM_LOCK_CHANGED', [slot]);
      return;
    }
    fireEvent(vm, 'ITEM_LOCK_CHANGED', [bag, slot]);
  };

  /**
   * The move, on the wire. Both ends map through `wirePos`; which opcode goes out is decided exactly as
   * the reference decides it (`benilla/src/ui_items/drain.rs:449-505`):
   *
   *  - both ends in the player's own array (bag index 255 -- equipment, the bag buttons and the
   *    backpack) -> `CMSG_SWAP_INV_ITEM` (**0x10D**);
   *  - otherwise (either end an equipped bag) -> `CMSG_SWAP_ITEM` (**0x10C**).
   *
   * **BOTH BODIES ARE DESTINATION-FIRST, and the first version of this function got `SWAP_INV_ITEM`
   * backwards -- measured, not reasoned: the packet went out, the server answered nothing at all, and
   * the sword stayed on the character.** That is the exact signature of a swap whose SOURCE resolved to
   * an empty slot: `Player::SwapItem` returns silently when `GetItemByPos(src)` is null, so a reversed
   * body is a no-op with no error.
   *
   * The order is 3.3.5a's own, read off the server that referees it -- TrinityCore 3.3.5
   * `Server/Packets/ItemPackets.cpp` `SwapInvItem::Read` is `_worldPacket >> Slot2 >> Slot1` while
   * `Handlers/ItemHandler.cpp#HandleSwapInvItemOpcode` computes `src` from **Slot1** and `dst` from
   * Slot2; `SwapItem::Read` is `>> ContainerSlotB >> SlotB >> ContainerSlotA >> SlotA` with `src` from
   * **A**. So both are `dst..., src...` on the wire.
   *
   * **This is where the reference is version-wrong and CLAUDE.md's rule applies.**
   * `benilla-protocol/src/messages/items.rs:699-701` builds `swap_inv_item` as `vec![src_slot,
   * dst_slot]`, verified against vmangos for 1.12.1. Its `swap_item` is already destination-first and
   * agrees with 3.3.5a. Mechanism from the reference, numbers from this build's own server.
   *
   * An empty destination is still a swap on either wire: a move is a swap with nothing on one side.
   */
  const sendMove = (from: CursorItemSource, toBag: number, toSlot: number): boolean => {
    const src = wirePos(from.bag, from.slot);
    const dst = wirePos(toBag, toSlot);
    if (src === null || dst === null) {
      return false;
    }
    if (src[0] === BAG_PLAYER_INVENTORY && dst[0] === BAG_PLAYER_INVENTORY) {
      const gp = new GamePacket(
        GameOpcode.CMSG_SWAP_INV_ITEM, GamePacket.HEADER_SIZE_OUTGOING + 2,
      );
      // DESTINATION FIRST. See the doc comment: `SwapInvItem::Read` is `>> Slot2 >> Slot1` and the
      // handler's `src` is Slot1.
      gp.writeUnsignedByte(dst[1] & 0xff);
      gp.writeUnsignedByte(src[1] & 0xff);
      world.game.send(gp);
    } else {
      const gp = new GamePacket(
        GameOpcode.CMSG_SWAP_ITEM, GamePacket.HEADER_SIZE_OUTGOING + 4,
      );
      gp.writeUnsignedByte(dst[0] & 0xff);
      gp.writeUnsignedByte(dst[1] & 0xff);
      gp.writeUnsignedByte(src[0] & 0xff);
      gp.writeUnsignedByte(src[1] & 0xff);
      world.game.send(gp);
    }
    lockChanged(from.bag, from.slot);
    lockChanged(toBag, toSlot);
    return true;
  };

  /** Put an item on the cursor, or take it off. `null` clears; both fire `CURSOR_UPDATE`. */
  const holdItem = (source: CursorItemSource | null, texture: string | null): void => {
    setCursorItem(vm, source === null ? null : {
      kind: 'item',
      // 0: an item is not a spell. `api/cursor.ts`'s `GetCursorInfo` reads `item`, never this.
      spellId: 0,
      bookSlot: null,
      sourceSlot: null,
      // What `world-ui.ts#drawCursorIcon` draws at the pointer -- the item's icon rides for free.
      texture,
      item: source,
    });
  };

  /**
   * The ONE transition, shared by both surfaces. `bag`/`slot` is where the click landed.
   *
   * Returns nothing: every caller is a Lua global whose own return value the client ignores.
   */
  const pickOrPlace = (bag: number, slot: number): void => {
    if (wirePos(bag, slot) === null) {
      return;
    }
    const held = getCursorItem(vm);
    if (held === null) {
      // A SPELL or ACTION payload refuses an item slot outright and stays on the cursor -- the
      // reference's own final arm. `getCursorItem` answers null for those, so the guard is the
      // `getCursor` read rather than `held`.
      if (getCursor(vm) !== null) {
        return;
      }
      const item = itemAt(bag === EQUIPMENT_BAG
        ? guidAt(items.player(), ObjectType.Player,
          PlayerField.player_field_inv_slot_head + (slot - 1) * 2)
        : slotGuid(bag, slot));
      if (item === null) {
        return;
      }
      holdItem(payloadFor(bag, slot, item), iconFor(item));
      lockChanged(bag, slot);
      return;
    }
    if (held.bag === bag && held.slot === slot) {
      // Dropped back where it came from: put it down, send nothing.
      holdItem(null, null);
      lockChanged(bag, slot);
      return;
    }
    // **THERE IS NO CLIENT-SIDE FIT CHECK ON A PLACEMENT, and its removal is the point.**
    //
    // Two earlier versions of this line refused a paperdoll drop whose `equipSlots` did not contain the
    // slot -- first outright, then fail-open when the list was empty. Both were wrong for one reason:
    // **a refusal this client invents is a refusal with nothing to say.** The player sees the item snap
    // back and cannot tell a rule of the game from a bug in the client, which is exactly the confusion
    // the owner reported ("there're not alerts when I'm trying to do something restrictive") and which
    // has already cost this project one false bug report.
    //
    // The real client does not check either: `PaperDollItemSlotButton_OnClick` calls
    // `PickupInventoryItem` unconditionally (`paperdollframe.lua:1237`), and `CursorCanGoInSlot` exists
    // only to drive `CURSOR_UPDATE`'s slot highlight -- which is still what `equipSlots` is carried for.
    // The server referees, and `SMSG_INVENTORY_CHANGE_FAILURE` comes back with a reason that
    // `EQUIP_ERR_NAMES` turns into the game's own red line: a belt on the head slot answers
    // `EQUIP_ERR_WRONG_SLOT` -> "That item does not go in that slot." That is strictly more information
    // than a silent snap-back, and none of the text is ours.
    if (sendMove(held, bag, slot)) {
      holdItem(null, null);
    }
  };

  /**
   * `PickupContainerItem(bagID, slot)` -- WAS A DECLARED GAP and is the left arm of every bag click and
   * every bag drag (`containerframe.lua:715`, `containerframe.xml:63`).
   */
  vm.registerFunction('PickupContainerItem', (args) => {
    pickOrPlace(Number(args[0]), Number(args[1]));
    return [];
  });

  /**
   * `PickupInventoryItem(invSlot)` -- the paperdoll slot's left click and drag
   * (`paperdollframe.lua:1237`, `RegisterForDrag("LeftButton")` at `:1131`). Registered NOWHERE before.
   */
  vm.registerFunction('PickupInventoryItem', (args) => {
    pickOrPlace(EQUIPMENT_BAG, Number(args[0]));
    return [];
  });

  /**
   * `EquipCursorItem(invSlot)` -- the same transition as dropping the held item onto that slot, which is
   * why it routes there rather than repeating it (`benilla-ui/src/script/cursor/doll.rs:117-119`).
   */
  vm.registerFunction('EquipCursorItem', (args) => {
    pickOrPlace(EQUIPMENT_BAG, Number(args[0]));
    return [];
  });

  /**
   * `PickupBagFromSlot(invSlot)` -- dragging an equipped BAG off the bag bar
   * (`mainmenubarbagbuttons.lua:33-36`). It was a declared gap for want of an item cursor; a bag is an
   * item in a worn slot, so it is the paperdoll transition with the bag's own id (20..23), and
   * `equipSlotsFor(INVTYPE_BAG)` already lets it land on any of the four.
   */
  vm.registerFunction('PickupBagFromSlot', (args) => {
    pickOrPlace(EQUIPMENT_BAG, Number(args[0]));
    return [];
  });

  /**
   * `AutoEquipCursorItem()` -- the paperdoll MODEL pane's drop: equip the held item wherever it goes,
   * and let the SERVER pick the slot (`CMSG_AUTOEQUIP_ITEM`, whose whole body is the source bag/slot).
   *
   * A payload already carried FROM the equipment has nothing for the server to "auto" pick, so it is a
   * no-op and stays held -- the reference's own guard (`cursor/doll.rs:157-166`).
   */
  vm.registerFunction('AutoEquipCursorItem', () => {
    const held = getCursorItem(vm);
    if (held === null || held.bag === EQUIPMENT_BAG) {
      return [];
    }
    const src = wirePos(held.bag, held.slot);
    if (src === null) {
      return [];
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_AUTOEQUIP_ITEM, GamePacket.HEADER_SIZE_OUTGOING + 2,
    );
    gp.writeUnsignedByte(src[0] & 0xff);
    gp.writeUnsignedByte(src[1] & 0xff);
    world.game.send(gp);
    lockChanged(held.bag, held.slot);
    holdItem(null, null);
    return [];
  });

  /**
   * `CursorCanGoInSlot(invSlot)` -- `CURSOR_UPDATE`'s highlight driver
   * (`paperdollframe.lua:1203-1208`: lock the slot's highlight if true, unlock it if false).
   *
   * Answered straight off the payload's `equipSlots`, which is why that list is captured at pickup: this
   * is called once per paperdoll slot per `CURSOR_UPDATE`, i.e. nineteen times per pickup.
   */
  vm.registerFunction('CursorCanGoInSlot', (args) => {
    const held = getCursorItem(vm);
    return [held !== null && held.equipSlots.includes(Number(args[0]))];
  });

  /**
   * `IsInventoryItemLocked(invSlot)` -- true while that worn slot is the cursor's SOURCE, so the icon
   * dims the moment it is picked up with no server round-trip. `PaperDollItemSlotButton_UpdateLock`
   * (`paperdollframe.lua:1308-1316`) is the only caller and desaturates on true.
   */
  vm.registerFunction('IsInventoryItemLocked', (args) => {
    const held = getCursorItem(vm);
    return [held !== null && held.bag === EQUIPMENT_BAG && held.slot === Number(args[0])];
  });

  /**
   * `GetInventoryItemCount(unit, invSlot)` -- the stack size on a WORN item.
   *
   * **Its absence is the whole of "the paperdoll slots draw no item icons".** Measured live:
   * `PaperDollItemSlotButton_Update`'s second statement is
   * `SetItemButtonCount(self, GetInventoryItemCount("player", self:GetID()))`
   * (`paperdollframe.lua:1263`), and every OCCUPIED slot raised there -- after `SetItemButtonTexture`
   * had run, so the icon was set and then the handler died eleven lines before
   * `self.ignoreTexture:Hide()` (`:1290-1294`). `paperdollframe.xml:8` authors that texture as
   * `Interface\PaperDollInfoFrame\UI-GearManager-LeaveItem-Transparent` and SHOWN -- a red circle-slash
   * -- so every worn item's icon was drawn and then covered by it. That is exactly the owner's
   * "red circle-slash on several paperdoll slots", and "several" is the count of occupied slots: an
   * EMPTY slot takes the other branch, reaches the `Hide()`, and only then raises on
   * `IsInventoryItemLocked` at `:1309`.
   *
   * 1 for a worn item, because equipment does not stack: the only stackable thing in an inventory slot
   * is ammo, and `AmmoSlot` is id 0, outside the descriptor array (see `wirePos`). `ITEM_FIELD_STACK_COUNT`
   * is read anyway rather than hard-coded, so ammo would answer correctly if it ever reached this call.
   */
  vm.registerFunction('GetInventoryItemCount', (args) => {
    if (String(args[0]).toLowerCase() !== 'player') {
      return [0];
    }
    const slot = Number(args[1]);
    if (!Number.isFinite(slot) || slot < 1) {
      return [0];
    }
    const item = itemAt(guidAt(items.player(), ObjectType.Player,
      PlayerField.player_field_inv_slot_head + (slot - 1) * 2));
    return [item === null ? 0 : item.count];
  });

  /**
   * `GetInventoryItemLink(unit, invSlot)` -- WAS A DECLARED GAP whose reason ("nothing in the bag path
   * calls this; it is the character sheet's") is no longer true: `PaperDollItemSlotButton_OnModifiedClick`
   * passes it straight to `HandleModifiedItemClick` (`paperdollframe.lua:1252`), which is shift-clicking
   * a worn item into chat. Same link builder the bag path uses.
   */
  vm.registerFunction('GetInventoryItemLink', (args) => {
    if (String(args[0]).toLowerCase() !== 'player') {
      return [null];
    }
    const slot = Number(args[1]);
    if (!Number.isFinite(slot) || slot < 1) {
      return [null];
    }
    const item = itemAt(guidAt(items.player(), ObjectType.Player,
      PlayerField.player_field_inv_slot_head + (slot - 1) * 2));
    return [item === null ? null : itemLink(item)];
  });

  /**
   * `PutItemInBackpack()` / `PutItemInBag(invSlot)` -> whether an item was PUT DOWN.
   *
   * RE-REGISTERED over `api/cursor.ts`' empty-cursor `false` (see its note): with an item on the cursor
   * these place it, which is what makes clicking the bag BUTTON while carrying something drop it in
   * rather than toggle the bag open. `BackpackButton_OnClick` is
   * `if ( not PutItemInBackpack() ) then ToggleBackpack() end`
   * (`mainmenubarbagbuttons.lua:50-55`), so the boolean IS the branch.
   *
   * The destination is the first FREE slot of that bag, because the wire has no "anywhere in this bag"
   * form for a swap: `CMSG_AUTOSTORE_BAG_ITEM` (0x10B) is that form, and it is not used here because it
   * cannot express "and swap if full". With no free slot the answer is false and the bag toggles, which
   * is a visible behaviour rather than a silent nothing.
   */
  const putInBag = (bag: number): boolean => {
    const held = getCursorItem(vm);
    if (held === null) {
      return false;
    }
    const total = numSlots(bag);
    for (let slot = 1; slot <= total; slot += 1) {
      if (itemAt(slotGuid(bag, slot)) === null) {
        if (sendMove(held, bag, slot)) {
          holdItem(null, null);
          return true;
        }
        return false;
      }
    }
    return false;
  };
  /**
   * `DeleteCursorItem()` -- DESTROY the held item. `CMSG_DESTROYITEM` (**0x111**).
   *
   * **This is only ever reached from the client's own confirmation dialogue**, and that is the point.
   * `api/cursor.ts#dropCursorOnWorld` fires `DELETE_ITEM_CONFIRM` and KEEPS the item on the cursor;
   * `UIParent_OnEvent` picks `DELETE_GOOD_ITEM` when the quality is `>= 3` and `DELETE_ITEM` otherwise
   * (`uiparent.lua:609-616`); and only those dialogues' `OnAccept` -- or the stern one's
   * `EditBoxOnEnterPressed`, once "DELETE" has been typed -- calls this
   * (`staticpopup.lua:1576-1578`, `:1600-1602`, `:1628-1633`). So the confirmation GATES the destroy
   * and cannot follow it. Every string, the `>= 3` threshold and the typed word
   * (`DELETE_ITEM_CONFIRM_STRING = "DELETE"`, `globalstrings.lua:1971`) are the client's own.
   *
   * The body is `u8 bag, u8 slot, u8 count` -- exactly three fields, read off the server that acts on
   * it: TrinityCore 3.3.5 `Server/Packets/ItemPackets.cpp`'s `DestroyItem::Read` is
   * `>> ContainerId >> SlotNum >> Count`. **`count = 0` means the WHOLE STACK**, the wire's own
   * convention and what the reference records for the same opcode
   * (`benilla-protocol/src/messages/items.rs:711-719`); that reference builds a 6-byte body for 1.12
   * with three trailing bytes the server discards, and those are deliberately NOT sent here because
   * this build's own reader does not name them.
   *
   * The cursor is cleared only after the send, and the source slot's lock is announced so the bag
   * repaints the row it just gave up.
   */
  vm.registerFunction('DeleteCursorItem', () => {
    const held = getCursorItem(vm);
    if (held === null) {
      return [];
    }
    const src = wirePos(held.bag, held.slot);
    if (src === null) {
      return [];
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_DESTROYITEM, GamePacket.HEADER_SIZE_OUTGOING + 3,
    );
    gp.writeUnsignedByte(src[0] & 0xff);
    gp.writeUnsignedByte(src[1] & 0xff);
    gp.writeUnsignedByte(0); // count 0 = the whole stack
    world.game.send(gp);
    lockChanged(held.bag, held.slot);
    holdItem(null, null);
    return [];
  });

  vm.registerFunction('PutItemInBackpack', () => [putInBag(BACKPACK_CONTAINER)]);
  vm.registerFunction('PutItemInBag', (args) => {
    // The argument is an INVENTORY slot id -- `BagSlotButton_OnClick` passes `self:GetID()` straight
    // through (`mainmenubarbagbuttons.lua:16-18`), and that id is 20..23 because that is what
    // `GetInventorySlotInfo("Bag0Slot".."Bag3Slot")` answered at the button's OnLoad. So it converts back
    // to a bag id the same way `ContainerIDToInventoryID` above converts forward.
    const bag = Number(args[0]) - INV_SLOT_BAG_FIRST;
    return [bag >= 1 && bag <= NUM_BAG_SLOTS ? putInBag(bag) : false];
  });

  /**
   * The tooltip feed -- `GameTooltip:SetBagItem` / `:SetHyperlink`.
   *
   * Installed here rather than imported by the method table, because that table has no world; see
   * `api/items.ts#setItemTooltipSource`. The LOOT bridge chains onto this one for its own `'loot'` kind
   * (it attaches after this and calls back into what it replaces), so both kinds resolve through one
   * hook rather than two competing installs.
   *
   * **The body was two lines and the owner reported it: the name drew and nothing under it.** It is
   * built by `ui/item-tooltip.ts` now -- binding, slot, damage and speed, armour, the stat lines, the
   * requirement in red when unmet, durability, the effect labels, the flavour text and the sell price,
   * every label being the client's own `GlobalStrings.lua` entry. The paragraph that used to stand here
   * argued for keeping it sparse; that argument is gone, not merely unmet.
   *
   * THE STACK COUNT WAS DROPPED FROM THE TOOLTIP. It was ours -- the real client draws a stack on the
   * ICON, not in the tooltip -- and it was the only body line that had no client-side source.
   */
  const bagTooltip = (kind: string, a: number | string, b?: number): ItemTooltipInfo | null => {
    let template: ItemTemplate | null = null;
    if (kind === 'bag') {
      const item = itemAt(slotGuid(Number(a), Number(b)));
      if (item === null) {
        return null;
      }
      template = item.template;
    } else if (kind === 'inventory') {
      // A WORN item: `a` is the unit token and `b` the 1-based equipment slot id. Only "player"
      // resolves, for the reason `GetInventoryItemTexture` gives -- no other unit's inventory guids
      // reach this client. This is the same read the bag-bar buttons need to know which bags are
      // equipped, so it shares `bagGuid`'s field arithmetic rather than repeating it.
      if (String(a).toLowerCase() !== 'player' || !Number.isFinite(Number(b)) || Number(b) < 1) {
        return null;
      }
      const item = itemAt(guidAt(items.player(), ObjectType.Player,
        PlayerField.player_field_inv_slot_head + (Number(b) - 1) * 2));
      if (item === null) {
        return null;
      }
      template = item.template;
    } else if (kind === 'link') {
      const match = /\|Hitem:(\d+)/.exec(String(a));
      const entry = match === null ? Number(a) : Number(match[1]);
      template = Number.isFinite(entry) && entry > 0 ? items.template(entry) : null;
    } else {
      return null;
    }
    if (template === null) {
      return null;
    }
    // THE BODY, from `ui/item-tooltip.ts` -- shared with the other bridge on purpose. The owner saw the
    // name and nothing under it in BOTH the bag and the loot window, because each bridge had its own
    // two-line body; one builder is why that cannot drift again.
    const lines = itemTooltipLines(vm, template, {
      // The player's own level, so an unmet `Requires Level` goes red. `Unit#level` (`classes/unit.ts:313`)
      // initialises to 0 and `itemTooltipLines` treats 0 as "do not judge" rather than as level zero --
      // so a tooltip opened before the descriptor lands paints nothing red instead of everything.
      playerLevel: world.player.level,
      // The effect labels' spell names. `spellData` is the same table the action bar reads, so a name
      // appears once `Spell.dbc` has landed and the label stands alone until then.
      spellName: (id: number) => spellData.spell(id)?.name ?? null,
    });
    return { name: template.name, quality: template.quality, lines };
  };
  setItemTooltipSource(vm, bagTooltip as never);

  // -- The repaint --------------------------------------------------------------------------------

  /**
   * Re-register the icon art, then announce once per bag.
   *
   * `BAG_UPDATE` carries the bag id and `ContainerFrame_OnEvent` compares it to the frame's own
   * (`containerframe.lua:187-201`), so one event per bag is what the client's own handler expects --
   * not one per slot. The art goes in FIRST, exactly as `action-bridge.ts#pushAll` does it, so
   * `SetItemButtonTexture(path)` names a key that at least has a def; the BLP lands a moment later and
   * the frame that follows has a different fingerprint anyway.
   *
   * COALESCED to a microtask. A login delivers one create block per item, each of which emits
   * `inventoryChanged`, so a full backpack would otherwise fire the whole event set twenty times in one
   * packet -- twenty repaints of thirteen frames for one arrival.
   */
  let queued = false;
  let disposed = false;
  const pushAll = (): void => {
    if (queued || disposed) {
      return;
    }
    queued = true;
    void Promise.resolve().then(() => {
      queued = false;
      // THE COALESCING WINDOW OUTLIVES THE BRIDGE otherwise. Removing the listeners in the teardown
      // does not cancel a microtask already scheduled, so a teardown between the schedule and the
      // flush would fire `BAG_UPDATE` into a VM that is being torn down. Found in self-review; the
      // same class of hazard `clearRects` covers for the published draw list.
      if (disposed) {
        return;
      }
      const paths: string[] = [];
      for (const bagId of [BACKPACK_CONTAINER, 1, 2, 3, 4, KEYRING_CONTAINER]) {
        for (let slot = 1; slot <= numSlots(bagId); ++slot) {
          const item = itemAt(slotGuid(bagId, slot));
          const path = item === null ? null : iconFor(item);
          if (path !== null) {
            paths.push(path);
          }
        }
      }
      if (paths.length > 0) {
        for (const path of paths) {
          art.register(path, { path });
        }
        void art.load();
      }
      for (const bagId of [BACKPACK_CONTAINER, 1, 2, 3, 4, KEYRING_CONTAINER]) {
        fireEvent(vm, 'BAG_UPDATE', [bagId]);
      }
      // The purse rides the same descriptor flush as the bags (`PLAYER_FIELD_COINAGE` is one word on
      // the same object), so its event belongs on the same edge. `MoneyFrame.lua` registers
      // `PLAYER_MONEY` and re-reads `GetMoney` from it; without this the bag's coin line would show
      // whatever it read at load and never move. Looting money is the case that matters.
      // The purse's VALUE, pushed to where the global that answers it lives. `GetMoney` is installed
      // in `api/items.ts` BEFORE the manifest, because `MoneyFrame_OnLoad` calls it during the load;
      // only the number may arrive this late. See that file's header for the measurement.
      setCoinage(vm, fieldAt(items.player(), ObjectType.Player, PlayerField.player_field_coinage));
      fireEvent(vm, 'PLAYER_MONEY');
    });
  };

  /**
   * THE RED LINE ON SCREEN. `ItemHandler` decodes the reason byte, this turns it into the client's own
   * string and fires the event the client's own frame is listening for.
   *
   * `UIErrorsFrame_OnLoad` registers `UI_ERROR_MESSAGE` (`uierrorsframe.lua:5`) and its handler is one
   * line: `self:AddMessage(arg1, 1.0, 0.1, 0.1, 1.0)` (`:14-15`). So the ENGINE's whole job is the
   * event and its text -- the colour, the position, the font and the hold are all the document's, which
   * is why nothing here draws anything. `MessageFrame` had to become a real widget class for that to
   * land at all; see `lua/methods/messageframe.ts`.
   *
   * A reason with no string in `GlobalStrings.lua` fires nothing, which is the engine's own behaviour --
   * see `EQUIP_ERR_NAMES`.
   */
  const onEquipError = (reason: number): void => {
    if (disposed) {
      return;
    }
    const text = equipErrorText(vm, Number(reason));
    if (text === null) {
      return;
    }
    fireEvent(vm, 'UI_ERROR_MESSAGE', [text]);
  };
  items.on('equipError', onEquipError);

  items.on('inventoryChanged', pushAll);
  items.on('templatesChanged', pushAll);
  // `ItemDisplayInfo.dbc` is 6.7 MB and the icons are null until it lands; this is the repaint that
  // puts them on screen. Idempotent, and on a dressed character it rides `character-look.ts`' fetch.
  void itemData.ensureLoaded().then(pushAll);
  pushAll();

  // -- The declared gaps --------------------------------------------------------------------------

  /**
   * Everything `ContainerFrame.lua` and its neighbours call that this client cannot answer, each with
   * the reason the load report will print. A silent no-op here is how a bag renders plausibly and
   * wrongly -- the whole pickup family in particular would make an item LOOK picked up and then lose
   * it.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    // THE ONE THAT WAS BLOCKING THE WHOLE FRAME, and it was found by pcall-ing the client's own
    // function rather than guessed: `ToggleBag(0)` threw
    // `containerframe.lua:507: attempt to call a nil value (global 'SetBagPortraitTexture')`, so
    // `ContainerFrame_GenerateFrame` never reached the `frame:Show()` below it and the backpack stayed
    // hidden at the default id 100 with every bag global already answering correctly.
    //
    // Declared rather than implemented, and deliberately: it is the PORTRAIT family, whose siblings
    // `SetPortraitTexture` and `SetPortraitToTexture` are already declared gaps in `api/units.ts:518`
    // for the same reason -- this client has no portrait render target. The keyring branch two lines
    // above the call site takes `SetPortraitToTexture`, so implementing one and not the other would
    // leave the two halves of one decision inconsistent. A declared stub RETURNS, which is all
    // `GenerateFrame` needs to finish.
    ['SetBagPortraitTexture', 'no portrait render target exists in this client -- the same gap '
      + 'SetPortraitTexture/SetPortraitToTexture are declared for in api/units.ts', []],
    // `PickupContainerItem` USED TO BE DECLARED HERE. It is real now -- see the item-cursor section
    // above -- and this note stays only because the comment block below still calls the whole pickup
    // family a gap in one place; the family that remains is the SPLIT and the DESTROY.
    ['SplitContainerItem', 'a split carry needs StackSplitFrame, whose OnAccept is the only caller, and '
      + 'CMSG_SPLIT_ITEM; the whole-stack move is real (see the item-cursor section) and a partial one '
      + 'is deliberately not faked as a whole-stack move', []],
    ['SocketInventoryItem', 'no socketing UI and no gem data; PaperDollItemSlotButton_OnModifiedClick '
      + 'reaches it only behind IsModifiedClick("SOCKETITEM")', []],
    ['GetInventoryItemBroken', 'ITEM_FIELD_DURABILITY is not read out of the item descriptor, so a worn '
      + 'item cannot be known to be broken; false leaves the icon its normal colour rather than red',
    [false]],
    ['GetInventoryItemCooldown', 'as GetContainerItemCooldown -- SMSG_ITEM_COOLDOWN (0x0B0) has no '
      + 'subscriber', [0, 0, 0]],
    ['GetContainerItemCooldown', 'SMSG_ITEM_COOLDOWN (0x0B0) has no subscriber, so no item cooldown '
      + 'is decoded', [0, 0, 0]],
    ['GetContainerItemQuestInfo', 'no quest log is decoded, so no item can be known to be a quest '
      + 'item', [null, null, null]],
    ['GetContainerItemPurchaseInfo', 'the refund window needs vendor state this client has none of',
      []],
    ['GetContainerItemPurchaseItem', 'as GetContainerItemPurchaseInfo', []],
    ['SetItemButtonQuality', 'the quality ring on a bag button is drawn by the client\'s own Lua from '
      + 'GetContainerItemInfo\'s quality; nothing calls this in the manifest', []],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }

  const stats = {
    numSlots: (bagId: number) => numSlots(bagId),
    slot: (bagId: number, slot: number) => itemAt(slotGuid(bagId, slot)),
    bagGuid,
    guids: () => items.objectGuids(),
  };
  (window as unknown as Record<string, unknown>).bagBridge = stats;

  return () => {
    disposed = true;
    setItemTooltipSource(vm, null);
    items.removeListener('inventoryChanged', pushAll);
    items.removeListener('templatesChanged', pushAll);
    items.removeListener('equipError', onEquipError);
    delete (window as unknown as Record<string, unknown>).bagBridge;
  };
}

// `warnOnce` LIVED HERE and is gone with its one caller: it existed only for the consumable arm's
// "CMSG_USE_ITEM carries a SpellCastTargets block this client does not build", and that block is built
// now (`sendUseItem`). A warning helper with no caller is a gap that no longer exists.

export default attachContainerBridge;
