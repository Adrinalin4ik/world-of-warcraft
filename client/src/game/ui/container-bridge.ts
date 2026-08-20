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
    const item = itemAt(slotGuid(Number(args[0]), Number(args[1])));
    if (item === null) {
      return [];
    }
    const lootable = item.template !== null
      && (item.template.flags & ITEM_FLAG_LOOTABLE) !== 0;
    return [
      iconFor(item),
      item.count,
      // `locked` -- see the header. No cursor, so no locked slot; nil rather than a guessed false.
      null,
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
    ['PickupContainerItem', 'there is no item on this client\'s cursor: the cursor carries actions and '
      + 'spells only (api/cursor.ts), so an item pickup has nowhere to be held', []],
    ['SplitContainerItem', 'splitting needs the cursor a pickup would put the stack on', []],
    ['GetContainerItemCooldown', 'SMSG_ITEM_COOLDOWN (0x0B0) has no subscriber, so no item cooldown '
      + 'is decoded', [0, 0, 0]],
    ['GetContainerItemQuestInfo', 'no quest log is decoded, so no item can be known to be a quest '
      + 'item', [null, null, null]],
    ['GetContainerItemPurchaseInfo', 'the refund window needs vendor state this client has none of',
      []],
    ['GetContainerItemPurchaseItem', 'as GetContainerItemPurchaseInfo', []],
    ['GetInventoryItemLink', 'a worn item resolves to a link, but nothing in the bag path calls this; '
      + 'it is the character sheet\'s, and that is not this round', [null]],
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
    delete (window as unknown as Record<string, unknown>).bagBridge;
  };
}

// `warnOnce` LIVED HERE and is gone with its one caller: it existed only for the consumable arm's
// "CMSG_USE_ITEM carries a SpellCastTargets block this client does not build", and that block is built
// now (`sendUseItem`). A warning helper with no caller is a gap that no longer exists.

export default attachContainerBridge;
