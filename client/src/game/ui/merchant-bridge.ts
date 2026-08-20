/**
 * THE MERCHANT GLOBALS -- the engine half of `MerchantFrame`, which is the client's own XML and Lua.
 *
 * Nothing is drawn here. `MerchantFrame.xml` declares the panel, its twelve `MerchantItem` rows, the
 * two tabs, the repair buttons and the buyback slot; `MerchantFrame.lua` fills and pages them. The
 * whole deliverable is the answers, plus the four events its `MerchantFrame_OnLoad` registers for
 * (`merchantframe.lua:7-10`).
 *
 * **The frame was already loading and already running its scripts.** The owner's console had
 * `MerchantFrame.lua:546` raising twenty times on a nil `GetRepairAllCost` -- that line is
 * `MerchantFrame_UpdateGuildBankRepair`, and the same global is read from `MerchantRepairAllButton`'s
 * and `MerchantGuildBankRepairButton`'s `<OnEvent>` in the XML (`merchantframe.xml:408,515`), which is
 * where the twenty come from: both buttons re-read it on `PLAYER_MONEY` and
 * `UPDATE_INVENTORY_DURABILITY`, and those fire all through a login. So the missing piece was never a
 * window, it was this file.
 *
 * ## The three numberings, and confusing them costs a player real gold
 *
 * The **wire MuID** is the vendor row's own 1-based index, and it is what `CMSG_BUY_ITEM` echoes back.
 * The server writes `slot + 1` and subtracts one when it reads it, treating 0 as cheating
 * (`ItemHandler.cpp:551-554`). It is SPARSE: rows the player may not see are skipped server-side.
 *
 * The **display index** is what FrameXML passes to `GetMerchantItemInfo`, `GetMerchantItemLink`,
 * `BuyMerchantItem` and `PickupMerchantItem`. `MerchantFrame_UpdateMerchantInfo` computes it as
 * `((page - 1) * MERCHANT_ITEMS_PER_PAGE) + i` (`merchantframe.lua:82`), so it is 1-based and dense.
 *
 * The **buyback slot** is a third space entirely: an ABSOLUTE player-array slot, `BUYBACK_SLOT_START`
 * (74 in 3.3.5a, and the 1.12 reference says 69) plus an index into the twelve descriptor slots.
 *
 * `rowAt` and `buybackAt` below are the only two places these meet, which is the same discipline
 * `loot-bridge.ts#rowAt` keeps for the loot window's coin row.
 *
 * ## The BUYBACK list is not a packet -- it is the player's own descriptor, and it is ordered
 *
 * There is no `SMSG_LIST_BUYBACK`. The twelve slots are three parallel runs of player fields --
 * `PLAYER_FIELD_VENDORBUYBACK_SLOT_1` (twelve guids, 24 words), `PLAYER_FIELD_BUYBACK_PRICE_1` and
 * `PLAYER_FIELD_BUYBACK_TIMESTAMP_1` (twelve words each) -- all of which this client already decodes
 * through `ItemHandler#notePlayerFields`. Nothing new had to be read off the wire for the buyback tab.
 *
 * **The ORDER is the timestamps' and it is load-bearing.** The server replaces the OLDEST slot when a
 * thirteenth item is sold (`Player::AddItemToBuyBackSlot`), so the newest sale is not at the highest
 * index. `MerchantFrame_UpdateMerchantInfo` asks for `GetBuybackItemInfo(GetNumBuybackItems())` to draw
 * the single "buy back the thing you just sold" slot on the main tab (`merchantframe.lua:171`) -- i.e.
 * it expects the LAST index to be the NEWEST. Sorting the occupied slots by timestamp is what makes
 * that true; returning them in descriptor order would show the player a random one of his last twelve
 * sales as "the one you just sold".
 *
 * ## What is NOT here
 *
 * - **Extended cost is reported but not resolved.** A row's `extendedCost` is answered truthfully from
 *   the wire, so the alt-currency frame appears; but `GetMerchantItemCostInfo` answers `0, 0, 0`
 *   because resolving it needs `ItemExtendedCost.dbc`, which is not loaded. The consequence is stated
 *   rather than hidden: `MerchantFrame_ConfirmExtendedItemCost` sees a zero cost and calls
 *   `BuyMerchantItem` directly, and the SERVER refuses the purchase. So an honor/token item at a
 *   vendor is visible and unbuyable, and nothing is spent on a mistake. Northshire has no such rows.
 * - **The guild bank.** `CanGuildBankRepair` answers false, which is a TRUE answer and not a stub: no
 *   guild feed is decoded, so the character has no guild to repair from. `MerchantGuildBankRepairButton`
 *   stays hidden, which is what `MerchantFrame_UpdateRepairButtons` does with a false.
 * - **`isUsable` is always true.** `SMSG_ITEM_QUERY_SINGLE_RESPONSE` carries `allowableClass` and
 *   `allowableRace` and `items.ts` reads BOTH and discards them (`items.ts:348-349`), so the question
 *   has no answer here yet. True is the safe direction: it means no row is ever wrongly painted red,
 *   whereas a false would paint a whole shop red for a character who can use all of it.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { GlueArt } from './art';
import {
  getItemTooltipSource, setItemTooltipSource, ItemTooltipInfo, setRepairMode,
} from './framexml/lua/api/items';
import { setUnit } from './framexml/lua/api/units';
import { snapshotOf } from './unit-bridge';
import { fieldAt, guidAt, EMPTY_GUID } from './container-bridge';
import { repairCostOf } from './repair-cost';
import { itemData } from '../pipeline/dbc/item-data';
import { durabilityData } from '../pipeline/dbc/durability-data';
import { spellData } from '../pipeline/dbc/spell-data';
import { itemTooltipLines } from './item-tooltip';
import { ObjectType, ObjectField, ItemField, PlayerField, ContainerField } from '../../network/game/object/enums';
import { NPC_FLAG } from '../world/cursor-mode';
import type { MerchantHandler, VendorRow } from '../../network/game/object/merchant';
import { BUYBACK_SLOTS } from '../../network/game/object/merchant';
import type { ItemHandler, ItemTemplate } from '../../network/game/object/items';

/**
 * The player-array slots a REPAIR-ALL walks, and they are the server's own bounds.
 *
 * `Player::DurabilityRepairAll` walks `EQUIPMENT_SLOT_START .. INVENTORY_SLOT_ITEM_END` on the player
 * object -- which is the worn slots, the four equipped bags THEMSELVES, and the backpack -- and then
 * every slot of each equipped bag (`Player.cpp:4692-4705`). Its own comment states what it leaves out:
 * "bank, buyback and keys not repaired". That exclusion is why this cannot simply sum every item
 * descriptor the client holds: a sold item sitting in a buyback slot is still a live descriptor, and
 * counting it would overcharge the total for something the server will not touch.
 *
 * The bound is DERIVED from this client's own field table rather than transcribed, the same way
 * `container-bridge.ts` derives `WIRE_SLOT_PACK_FIRST`: the player array runs from
 * `player_field_inv_slot_head` to the end of the pack block, so the count is the distance in guids.
 */
const REPAIRABLE_PLAYER_SLOTS = (PlayerField.player_field_bank_slot_1
  - PlayerField.player_field_inv_slot_head) / 2;

/** 36 -- `ContainerField`'s own span, as `container-bridge.ts` derives it. */
const MAX_CONTAINER_SLOTS = (ContainerField.container_end
  - ContainerField.container_field_slot_1) / 2;

/** The four equipped bag slots, 0-based, within the player array. `container-bridge.ts` derives 19. */
const NUM_BAG_SLOTS = 4;
const INV_SLOT_BAG_FIRST = ((PlayerField.player_field_pack_slot_1
  - PlayerField.player_field_inv_slot_head) / 2) - NUM_BAG_SLOTS;

/** Every VENDOR sub-kind, folded. A vendor is a vendor whichever shelf it keeps. */
const ANY_VENDOR = NPC_FLAG.VENDOR | NPC_FLAG.VENDOR_AMMO | NPC_FLAG.VENDOR_FOOD
  | NPC_FLAG.VENDOR_POISON | NPC_FLAG.VENDOR_REAGENT;

/** One buyback entry, resolved from the player's descriptor. */
interface BuybackEntry {
  /** The index into the twelve descriptor slots -- what `CMSG_BUYBACK_ITEM` re-bases. */
  slot: number;
  guid: string;
  price: number;
  timestamp: number;
}

export function attachMerchantBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const merchant: MerchantHandler = world.game.objectHandler.merchantHandler;
  const items: ItemHandler = world.game.objectHandler.itemHandler;

  let disposed = false;

  // The repair tables are 36 KB and 149 bytes together -- see `durability-data.ts#ensureLoaded` on why
  // they are fetched here rather than at the first vendor.
  void durabilityData.ensureLoaded();
  // `Item.dbc` + `ItemDisplayInfo.dbc`, for the row icons. The container bridge asks for the same pair
  // and attaches first, and `ensureLoaded` is idempotent -- so this rides that promise rather than
  // starting a second fetch. Asked for HERE anyway so this bridge does not silently depend on another
  // one's attach order for a table it needs.
  void itemData.ensureLoaded();

  // -- Reading the vendor's rows -----------------------------------------------------------------

  /**
   * Display index (1-based) -> the vendor row it addresses, or null.
   *
   * Dense, unlike the wire's MuID. `MerchantFrame_UpdateMerchantInfo` pages on
   * `GetMerchantNumItems()` and hides any button whose index exceeds it (`merchantframe.lua:81-88`),
   * so the count and this mapping must agree or the last row on a full page becomes unreachable.
   */
  const rowAt = (index: number): VendorRow | null => {
    if (!Number.isFinite(index) || index < 1) {
      return null;
    }
    return merchant.rows[index - 1] ?? null;
  };

  /**
   * A vendor row's icon, WITHOUT a query round trip.
   *
   * `SMSG_LIST_INVENTORY` carries each row's own `displayInfoId` (`NPCPackets.cpp:73`), exactly as
   * `SMSG_LOOT_RESPONSE` does, so the shop draws its icons the instant it opens. The NAME still needs
   * the query, which is why `MERCHANT_UPDATE` re-fires when a template lands.
   */
  const iconFor = (row: VendorRow): string | null => itemData.iconForDisplayId(row.displayInfoId)
    ?? itemData.iconForEntry(row.entry);

  /** An item hyperlink, coloured by the client's own `GetItemQualityColor`. */
  const linkFor = (template: ItemTemplate | null): string | null => {
    if (template === null) {
      return null;
    }
    const colour = vm.runExpr(
      `local _,_,_,hex = GetItemQualityColor(${template.quality}) return hex`, 'merchant-link.lua',
    ) as { value?: unknown } | null;
    const hex = String(colour?.value ?? '|cffffffff');
    return `${hex}|Hitem:${template.entry}:0:0:0:0:0:0:0:0:0:0|h[${template.name}]|h|r`;
  };

  // -- Reading the buyback slots ------------------------------------------------------------------

  /**
   * The occupied buyback slots, OLDEST FIRST. See the header on why the order is the timestamps'.
   *
   * A slot is occupied when its guid word pair is nonzero. The price is read as well because the
   * buyback price is NOT the item's sell price -- the server stores what it actually paid, which a
   * discount or a stack could make different, so recomputing it from the template would be a guess
   * where the descriptor holds the fact.
   */
  const buybackEntries = (): BuybackEntry[] => {
    const bag = items.player();
    const found: BuybackEntry[] = [];
    for (let slot = 0; slot < BUYBACK_SLOTS; ++slot) {
      const guid = guidAt(bag, ObjectType.Player,
        PlayerField.player_field_vendorbuyback_slot_1 + slot * 2);
      if (guid === EMPTY_GUID) {
        continue;
      }
      found.push({
        slot,
        guid,
        price: fieldAt(bag, ObjectType.Player, PlayerField.player_field_buyback_price_1 + slot),
        timestamp: fieldAt(bag, ObjectType.Player,
          PlayerField.player_field_buyback_timestamp_1 + slot),
      });
    }
    return found.sort((a, b) => a.timestamp - b.timestamp);
  };

  /** Display index (1-based, oldest first) -> the buyback entry it addresses. */
  const buybackAt = (index: number): BuybackEntry | null => {
    if (!Number.isFinite(index) || index < 1) {
      return null;
    }
    return buybackEntries()[index - 1] ?? null;
  };

  /** The template and stack count behind an item guid we hold a descriptor for. */
  const itemAt = (guid: string): { entry: number; count: number; template: ItemTemplate | null } | null => {
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
      entry,
      count: fieldAt(bag, ObjectType.Item, ItemField.item_field_stack_count),
      template: items.template(entry, guid),
    };
  };

  // -- The repair walk ---------------------------------------------------------------------------

  /**
   * Every item guid a repair-all would touch, in the server's own order. See
   * `REPAIRABLE_PLAYER_SLOTS`.
   */
  const repairableGuids = (): string[] => {
    const bag = items.player();
    const guids: string[] = [];
    for (let slot = 0; slot < REPAIRABLE_PLAYER_SLOTS; ++slot) {
      const guid = guidAt(bag, ObjectType.Player,
        PlayerField.player_field_inv_slot_head + slot * 2);
      if (guid !== EMPTY_GUID) {
        guids.push(guid);
      }
    }
    for (let bagId = 0; bagId < NUM_BAG_SLOTS; ++bagId) {
      const container = guidAt(bag, ObjectType.Player,
        PlayerField.player_field_inv_slot_head + (INV_SLOT_BAG_FIRST + bagId) * 2);
      if (container === EMPTY_GUID) {
        continue;
      }
      const contents = items.object(container);
      if (contents === null) {
        continue;
      }
      for (let slot = 0; slot < MAX_CONTAINER_SLOTS; ++slot) {
        const guid = guidAt(contents, ObjectType.Container,
          ContainerField.container_field_slot_1 + slot * 2);
        if (guid !== EMPTY_GUID) {
          guids.push(guid);
        }
      }
    }
    return guids;
  };

  /**
   * The repair-all total, memoised per inventory flush.
   *
   * **Memoised because it is read far more often than it changes.** `GetRepairAllCost` is called from
   * two `<OnEvent>` handlers, two `<OnEnter>` handlers and two Lua functions, and the walk behind it
   * is up to 39 + 4x36 = 183 guid reads plus a template lookup each. Recomputing it per call would put
   * that on the hover path of two buttons. Recomputing it per inventory flush -- which is when a
   * durability word can actually move -- makes every read after the first one a field access.
   *
   * `total` is null when ANY repairable item's cost is unknown. That is deliberate and it is the
   * conservative direction: an unknown item could be the expensive one, so the button greys rather
   * than offering a total that is quietly too low.
   */
  let repairCache: { total: number | null } | null = null;

  /**
   * The total as last announced through `UPDATE_INVENTORY_DURABILITY`. `undefined` means never.
   *
   * Distinct from `repairCache` on purpose -- see the self-review note in `onInventory`. `null` is a
   * meaningful VALUE here (the total is unknown), so it cannot double as "no value".
   */
  let lastAnnounced: number | null | undefined;
  const repairAllCost = (): number | null => {
    if (repairCache === null) {
      let total = 0;
      let known = true;
      for (const guid of repairableGuids()) {
        const cost = repairCostOf(items, guid);
        if (cost === null) {
          known = false;
          break;
        }
        total += cost;
      }
      repairCache = { total: known ? total : null };
    }
    return repairCache.total;
  };

  /** Is the vendor we are talking to an armourer? `UNIT_NPC_FLAG_REPAIR`, bit 0x1000 in 3.3.5a. */
  const vendorFlags = (): number => {
    const guid = merchant.source;
    if (guid === null) {
      return 0;
    }
    return world.entities.get(guid)?.fields.npcFlags ?? 0;
  };

  // -- The globals: the shop ---------------------------------------------------------------------

  vm.registerFunction('GetMerchantNumItems', () => [merchant.rows.length]);

  /**
   * `GetMerchantItemInfo(index)` -> `name, texture, price, quantity, numAvailable, isUsable,
   * extendedCost`.
   *
   * SEVEN returns, read straight off the client's own call site (`merchantframe.lua:89`).
   *
   * `quantity` is the STACK SIZE the purchase delivers -- the wire's `StackCount`, the template's
   * `BuyCount` -- and not the stock. `SetItemButtonCount(itemButton, quantity)` draws it on the icon,
   * so confusing it with `numAvailable` would print the shelf count on every reagent.
   *
   * `numAvailable` is the wire's signed `Quantity`: **-1 means unlimited**. `SetItemButtonStock` hides
   * its label for a negative, and `MerchantFrame_UpdateMerchantInfo` greys the row on exactly `== 0`
   * (`merchantframe.lua:130`) -- so the sign matters twice and the value is read signed off the wire.
   */
  vm.registerFunction('GetMerchantItemInfo', (args) => {
    const row = rowAt(Number(args[0]));
    if (row === null) {
      return [];
    }
    const template = items.template(row.entry);
    return [
      // Null, not a placeholder, while the query is in flight -- `SetText(nil)` leaves the label empty
      // and the row still draws, whereas inventing a name would be a claim. Same rule as
      // `GetLootSlotInfo`.
      template?.name ?? null,
      iconFor(row),
      row.price,
      row.stackCount,
      row.quantity,
      // See the header: `allowableClass` is read and discarded by `items.ts`, so this has no answer
      // yet, and true is the direction that never paints a usable shop red.
      true,
      row.extendedCostId !== 0,
    ];
  });

  vm.registerFunction('GetMerchantItemLink', (args) => {
    const row = rowAt(Number(args[0]));
    return [row === null ? null : linkFor(items.template(row.entry))];
  });

  /**
   * `GetMerchantItemMaxStack(index)` -- how many the SPLIT-STACK dialogue may offer.
   *
   * The template's `stackable`, not the vendor's stock. `MerchantItemButton_OnModifiedClick` only
   * opens the dialogue when this is `> 1` and then clamps it by what the player can afford
   * (`merchantframe.lua:415-425`), so a 0 or 1 here correctly means "no split".
   */
  vm.registerFunction('GetMerchantItemMaxStack', (args) => {
    const row = rowAt(Number(args[0]));
    const template = row === null ? null : items.template(row.entry);
    return [template?.stackable ?? 1];
  });

  /**
   * `GetMerchantItemCostInfo(index)` -> `honorPoints, arenaPoints, itemCount`.
   *
   * `0, 0, 0` -- see the header's "extended cost is reported but not resolved". THREE ZEROES rather
   * than nothing, because `MerchantFrame_UpdateAltCurrency` does `if ( itemCount > 0 )` on the third
   * return (`merchantframe.lua:242`) and `MerchantFrame_ConfirmExtendedItemCost` multiplies all three
   * by a quantity (`:460`) -- nil in either place raises, and the raise would take out the whole
   * update for a shop that merely happens to stock one token item.
   */
  vm.registerFunction('GetMerchantItemCostInfo', () => [0, 0, 0]);

  /**
   * `GetMerchantItemCostItem(index, i)` -> `itemTexture, itemValue, itemLink`.
   *
   * Nothing, for the same reason. `MerchantFrame_UpdateAltCurrency` hides the button when the texture
   * is falsy (`merchantframe.lua:257-261`), which is the correct outcome for a cost this client cannot
   * resolve: the row draws, its token requirement does not, and the purchase is refused by the server
   * rather than by a lie here.
   */
  vm.registerFunction('GetMerchantItemCostItem', () => [null, 0, null]);

  /**
   * `BuyMerchantItem(index, quantity)` -- the purchase.
   *
   * `quantity` is the number of STACKS and defaults to 1: `MerchantItemButton_OnClick`'s right-click
   * arm passes no second argument (`merchantframe.lua:404`), and the split-stack arm passes the split
   * (`:369`). The wire needs the row's MuID as well as the entry -- see `merchant.ts#buy` on why a
   * client that omits it is silently dropped rather than misread.
   *
   * STACKS is the server's reading and it is checked: `BuyItemFromVendorSlot` names the argument
   * `count`, assigns `uint32 stacks = count`, and gates stock on `GetBuyCount() * count`
   * (`Player.cpp:21410` and the two checks below it). **The SPLIT-STACK path is therefore ambiguous in
   * Blizzard's own arithmetic, and that is named rather than smoothed over**:
   * `MerchantItemButton_OnModifiedClick` bounds the dialogue by `GetMerchantItemMaxStack`, i.e. the
   * template's stack size, which counts ITEMS -- so a split of 5 on a row that sells 20 at a time buys
   * 100. The plain right click, which is the path that matters, is quantity 1 and is exact.
   *
   * Nothing is changed locally. `SMSG_BUY_ITEM` updates the stock and `UPDATE_OBJECT` delivers the
   * item, which is the same server-authoritative law `LootSlot` follows.
   */
  vm.registerFunction('BuyMerchantItem', (args) => {
    const row = rowAt(Number(args[0]));
    if (row === null) {
      return [];
    }
    const quantity = args[1] === undefined || args[1] === null ? 1 : Number(args[1]);
    if (!Number.isFinite(quantity) || quantity < 1) {
      return [];
    }
    merchant.buy(row.entry, row.muid, Math.floor(quantity));
    return [];
  });

  /**
   * `PickupMerchantItem(index)` -- put the shop's item on the cursor to drop into a bag.
   *
   * A DECLARED GAP, and the reason is specific rather than general: the cursor's payload space
   * (`api/cursor.ts`) has three kinds -- an item, a spell, an action -- and a merchant item is a
   * FOURTH, distinguished by `GetCursorInfo` answering the type string `"merchant"`, which
   * `ContainerFrameItemButton_OnClick` branches on to complete the purchase into a chosen slot
   * (`containerframe.lua:707-714`). Adding a kind means teaching every existing transition to refuse
   * it, and the buy path already works through the right click, so this is named rather than
   * half-built. Left-clicking a shop row therefore does nothing instead of doing something wrong.
   */
  const pickupStub = notImplemented(
    'PickupMerchantItem',
    'the cursor payload space has three kinds (item, spell, action) and a merchant item is a fourth '
      + 'that GetCursorInfo must answer as "merchant"; buying works through the right click, so the '
      + 'drag-into-a-chosen-slot path is declared rather than half-built',
    [],
  );
  vm.registerFunction('PickupMerchantItem', () => pickupStub(null as never, 0, []));

  /**
   * `CloseMerchant()` -- `MerchantFrame_OnHide`'s first statement (`merchantframe.lua:51`).
   *
   * Sends nothing: there is no `CMSG_CLOSE_MERCHANT` in 3.3.5a. See `merchant.ts#close`.
   */
  vm.registerFunction('CloseMerchant', () => {
    merchant.close();
    return [];
  });

  // -- The globals: buyback -----------------------------------------------------------------------

  vm.registerFunction('GetNumBuybackItems', () => [buybackEntries().length]);

  /**
   * `GetBuybackItemInfo(index)` -> `name, texture, price, quantity, numAvailable, isUsable`.
   *
   * SIX returns, from the client's own call site (`merchantframe.lua:171` and `:297`). One fewer than
   * the merchant row's: there is no `extendedCost` on a buyback.
   *
   * **`numAvailable` is -1, not 1.** `SetItemButtonStock` hides its label for a negative and prints
   * the number otherwise, and a buyback slot is a single unique item rather than stock -- the real
   * client shows no count there. A 1 would stamp "1" on every buyback icon.
   *
   * Answering NOTHING for an empty slot is what hides the row: `MerchantFrame_UpdateMerchantInfo`
   * tests `if ( buybackName )` (`:172`) and `MerchantFrame_UpdateBuybackInfo` tests
   * `if ( i <= numBuybackItems )` -- so an absent slot must not answer a row of blank fields.
   */
  vm.registerFunction('GetBuybackItemInfo', (args) => {
    const entry = buybackAt(Number(args[0]));
    if (entry === null) {
      return [];
    }
    const item = itemAt(entry.guid);
    if (item === null) {
      return [];
    }
    return [
      item.template?.name ?? null,
      itemData.iconForDisplayId(item.template?.displayInfoId ?? 0)
        ?? itemData.iconForEntry(item.entry),
      entry.price,
      item.count,
      -1,
      true,
    ];
  });

  vm.registerFunction('GetBuybackItemLink', (args) => {
    const entry = buybackAt(Number(args[0]));
    const item = entry === null ? null : itemAt(entry.guid);
    return [item === null ? null : linkFor(item.template)];
  });

  /**
   * `BuybackItem(index)` -- buy it back.
   *
   * The index is a DISPLAY index into the timestamp-ordered list; the wire wants the descriptor slot
   * re-based by `BUYBACK_SLOT_START`. `merchant.ts#buyback` does the re-basing, so the two numberings
   * meet in exactly one place.
   */
  vm.registerFunction('BuybackItem', (args) => {
    const entry = buybackAt(Number(args[0]));
    if (entry === null) {
      return [];
    }
    merchant.buyback(entry.slot);
    return [];
  });

  // -- The globals: repair ------------------------------------------------------------------------

  /**
   * `CanMerchantRepair()` -- does this vendor mend things?
   *
   * `UNIT_NPC_FLAG_REPAIR`, **0x1000 in 3.3.5a**. The bit's value is a server-side definition and is
   * labelled as such where the table lives (`world/cursor-mode.ts#NPC_FLAG`), which also records that
   * the whole table was corroborated live against Northshire's own NPCs. The reference's 1.12 value is
   * different, as its own comment warns.
   *
   * This is the ONE consumer of `NPC_FLAG.REPAIR`. Its own comment there says it is "never consulted
   * by the ladder -- kept because its ABSENCE from the ladder is the fact"; the ladder is the hover
   * cursor's, and this is not the ladder.
   */
  vm.registerFunction('CanMerchantRepair', () => [(vendorFlags() & NPC_FLAG.REPAIR) !== 0]);

  /**
   * `GetRepairAllCost()` -> `repairAllCost, canRepair`. **The global the owner's console was raising
   * on, twenty times.**
   *
   * `canRepair` is the SECOND return and it is what enables the button
   * (`MerchantFrame_UpdateCanRepairAll`, `merchantframe.lua:533-543`). It is false when there is
   * nothing to pay for -- which is the reading that makes the XML's `<OnEvent>` on `PLAYER_MONEY`
   * sensible: after a repair the cost falls to zero and the button greys itself.
   *
   * **The cost is 0 and canRepair FALSE when nothing is damaged, and 0 is not nil here.** The two
   * returns are read as `local repairAllCost, canRepair = GetRepairAllCost()` and both call sites then
   * gate on `canRepair and (repairAllCost > 0)` (`merchantframe.xml:394,488`), so the number is
   * arithmetic and must stay a number -- a nil there would raise inside an `OnEnter`. This is the
   * inverse of the usual trap: the NIL belongs on `SetBagItem`'s per-item cost, where the client tests
   * the value for truth, and NOT here, where it multiplies and compares it.
   *
   * An unknown total (a template still in flight, or the DBCs not landed) answers `0, false`: greyed,
   * which is honest, rather than a total that is quietly too low.
   */
  vm.registerFunction('GetRepairAllCost', () => {
    const total = repairAllCost();
    if (total === null || total <= 0) {
      return [0, false];
    }
    return [total, true];
  });

  /**
   * `RepairAllItems(guildBank)` -- `MerchantRepairAllButton`'s `<OnClick>` (`merchantframe.xml:403`),
   * and with a literal 1 from the guild-bank button (`:509`).
   *
   * `CMSG_REPAIR_ITEM` with a ZERO item guid means everything -- see `merchant.ts#repair`. Nothing is
   * changed locally: the durability words and the coinage both come back through `UPDATE_OBJECT`,
   * which is what invalidates the cache below and re-fires the events.
   */
  vm.registerFunction('RepairAllItems', (args) => {
    if (merchant.source === null) {
      return [];
    }
    const guildBank = args[0] !== undefined && args[0] !== null && args[0] !== false;
    merchant.repair(null, guildBank);
    return [];
  });

  /**
   * `CanGuildBankRepair()` -- **false, and that is a TRUE answer rather than a stub.**
   *
   * No guild feed is decoded, so this character has no guild and cannot repair from its bank. A false
   * makes `MerchantFrame_UpdateRepairButtons` take the no-guild layout and keep
   * `MerchantGuildBankRepairButton` hidden (`merchantframe.lua:558-580`), which is exactly what the
   * real client does for an unguilded player. Stubbing it would have been the wrong shape: the button
   * would appear and do nothing.
   */
  vm.registerFunction('CanGuildBankRepair', () => [false]);

  /**
   * The two guild-bank money reads, DECLARED.
   *
   * Only reachable from `MerchantGuildBankRepairButton`'s `<OnEnter>` (`merchantframe.xml:490-505`),
   * which `CanGuildBankRepair` keeps hidden -- so these are unreachable today and are registered by
   * name purely so the load report carries them rather than leaving two nils for an addon to find.
   */
  const guildGaps: Array<[string, string, unknown[]]> = [
    ['GetGuildBankMoney', 'no guild feed is decoded, so there is no guild bank to hold money', [0]],
    ['GetGuildBankWithdrawMoney', 'as GetGuildBankMoney', [0]],
  ];
  for (const [name, reason, results] of guildGaps) {
    const stub = notImplemented(name, reason, results);
    vm.registerFunction(name, () => stub(null as never, 0, []));
  }

  /**
   * REPAIR MODE -- `ShowRepairCursor` / `HideRepairCursor`, and the `InRepairMode` they drive.
   *
   * `MerchantRepairItemButton`'s `<OnClick>` toggles between them and registers or unregisters
   * `PLAYER_MONEY` on the frame as it does (`merchantframe.xml:453-461`), and
   * `ContainerFrameItemButton_OnEnter` reads `InRepairMode()` to decide whether to append the
   * per-item repair-cost line (`containerframe.lua:775`). So the STATE is real and useful even though
   * the hammer POINTER is not: the pointer shape is owned end to end by `WorldCursorDriver`, which
   * re-derives it every tick, and `api/cursor.ts` already declares every shape setter as a gap for
   * that reason.
   *
   * The flag lives in `api/items.ts` beside `InRepairMode` itself, so there is one source of truth and
   * `container-bridge.ts` can read it without importing this bridge.
   */
  vm.registerFunction('ShowRepairCursor', () => {
    setRepairMode(vm, true);
    return [];
  });
  vm.registerFunction('HideRepairCursor', () => {
    setRepairMode(vm, false);
    return [];
  });

  /**
   * `ShowMerchantSellCursor(index)` -- the coin pointer over a shop row. A declared gap, in the same
   * family and for the same reason as `ShowContainerSellCursor` next to it in `api/cursor.ts`.
   */
  const sellCursorStub = notImplemented(
    'ShowMerchantSellCursor',
    'as ShowContainerSellCursor -- WorldCursorDriver owns the pointer shape and re-derives it every '
      + 'tick, so a shape set here would be overwritten on the next one',
    [],
  );
  vm.registerFunction('ShowMerchantSellCursor', () => sellCursorStub(null as never, 0, []));

  // -- The tooltip --------------------------------------------------------------------------------

  /**
   * `GameTooltip:SetMerchantItem(index)` and `:SetBuybackItem(index)` -- CHAINED onto whatever the
   * container and loot bridges installed, exactly as `loot-bridge.ts` chains onto the container's.
   *
   * Chained, not replaced: three bridges want the same hook and this one attaches last, so replacing
   * it outright would take away every bag and loot tooltip. Anything that is not a merchant or buyback
   * row falls through.
   *
   * The BODY is `ui/item-tooltip.ts`, shared with the other two on purpose -- the owner has already
   * seen what happens when each bridge grows its own two-line body.
   */
  const previous = getItemTooltipSource(vm);
  const merchantTooltip = (
    kind: string, a: number | string, b?: number,
  ): ItemTooltipInfo | null => {
    let template: ItemTemplate | null = null;
    if (kind === 'merchant') {
      const row = rowAt(Number(a));
      template = row === null ? null : items.template(row.entry);
    } else if (kind === 'buyback') {
      const entry = buybackAt(Number(a));
      const item = entry === null ? null : itemAt(entry.guid);
      template = item?.template ?? null;
    } else {
      return previous === null ? null : previous(kind as never, a as never, b);
    }
    if (template === null) {
      return null;
    }
    const lines = itemTooltipLines(vm, template, {
      playerLevel: world.player.level,
      spellName: (id: number) => spellData.spell(id)?.name ?? null,
    });
    return {
      name: template.name,
      quality: template.quality,
      lines,
      // `GameTooltip:GetItem`'s second return -- the same link `GetMerchantItemLink` answers, so the
      // compare path gets the identical string the client would have got from the API.
      link: linkFor(template),
    };
  };
  setItemTooltipSource(vm, merchantTooltip as never);

  // -- The events ---------------------------------------------------------------------------------

  /**
   * The shop opened. Register the row art, ask for every template, THEN raise `MERCHANT_SHOW`.
   *
   * `MerchantFrame_OnEvent` answers it with `ShowUIPanel(self)` and then `MerchantFrame_Update()`
   * (`merchantframe.lua:24-32`), so the answers have to be ready before the event, not after it --
   * the same ordering `loot-bridge.ts#onOpened` keeps.
   *
   * **The "NPC" unit token is pushed here and it is pushed under BOTH spellings.**
   * `MerchantFrame_UpdateMerchantInfo` does `UnitName("NPC")` and `SetPortraitTexture(..., "NPC")`
   * (`merchantframe.lua:73-74`) while `GossipFrameUpdate` does `UnitName("npc")`
   * (`gossipframe.lua:40`) -- the real engine's tokens are case-insensitive and
   * `api/units.ts#withUnit` resolves them through an exact-match `Map`. Registering both spellings
   * fixes the two the manifest actually uses without reaching into a file another agent owns; the
   * general fix is one `toLowerCase` in `withUnit` and is named in the report rather than taken here.
   */
  const pushNpcToken = (guid: string | null): void => {
    const unit = guid === null ? null : world.entities.get(guid) ?? null;
    const snapshot = unit === null ? null : snapshotOf(unit, world.player);
    setUnit(vm, 'npc', snapshot);
    setUnit(vm, 'NPC', snapshot);
  };

  /**
   * Register whatever icons the rows currently resolve to.
   *
   * Called on the OPEN and on every UPDATE, because `iconFor` answers null until
   * `ItemDisplayInfo.dbc` is in memory -- so a shop opened during that fetch would otherwise have
   * registered nothing and never come back for it. `art.register` is idempotent and `art.load` only
   * fetches defs with no texture, so the repeat costs a `Map` lookup per row.
   *
   * Belt and braces rather than the only thing holding the icons up: `ui/runtime-art.ts` is the sink
   * that catches a `SetTexture` naming an unregistered path, which is the general fix. This is the
   * same hand-registration `action-bridge.ts#pushAll` and `container-bridge.ts#pushAll` keep.
   */
  const registerRowArt = (): void => {
    const paths = merchant.rows
      .map((row) => iconFor(row))
      .filter((path): path is string => path !== null);
    for (const path of paths) {
      art.register(path, { path });
    }
    void art.load();
  };

  const onShow = (): void => {
    if (disposed) {
      return;
    }
    registerRowArt();
    // Ask for every row's template up front. `items.template` is what ISSUES the query, and the answer
    // re-enters through `templatesChanged` -- so the shop opens with icons and prices and the names
    // fill in a moment later rather than the whole window waiting on a round trip.
    for (const row of merchant.rows) {
      items.template(row.entry);
    }
    pushNpcToken(merchant.source);
    fireEvent(vm, 'MERCHANT_SHOW');
  };

  const onUpdate = (): void => {
    if (!disposed && merchant.source !== null) {
      registerRowArt();
      fireEvent(vm, 'MERCHANT_UPDATE');
    }
  };

  const onClosed = (): void => {
    if (disposed) {
      return;
    }
    pushNpcToken(null);
    fireEvent(vm, 'MERCHANT_CLOSED');
  };

  /** A name arriving for a row already on screen. `MERCHANT_UPDATE` re-runs the whole fill. */
  const onTemplates = (): void => {
    // The cache depends on templates as well as on descriptors -- an unknown template is what makes
    // the total null -- so a template landing must invalidate it too.
    repairCache = null;
    onUpdate();
  };

  /**
   * A descriptor flush: the bags, the purse and every durability word arrive on the same edge.
   *
   * **`UPDATE_INVENTORY_DURABILITY` is fired only when the repair total actually MOVED**, and the
   * reason is the offscreen target: `DurabilityFrame` and both repair buttons answer that event, so
   * firing it on every inventory change would redraw them on every loot, every purchase and every
   * stack merge. Comparing the memoised total first costs one walk that this bridge has to do anyway
   * for `GetRepairAllCost`, and it makes the event mean what its name says.
   */
  const onInventory = (): void => {
    if (disposed) {
      return;
    }
    repairCache = null;
    const after = repairAllCost();
    // **SELF-REVIEW: THIS COMPARISON WAS `repairCache?.total ?? undefined` AND IT FIRED EVERY FLUSH.**
    //
    // `?? undefined` collapsed the two states that matter. A cached total of `null` -- the normal state
    // while ANY template query is in flight, i.e. all through a login -- came out of that expression as
    // `undefined`, while `after` was `null`, so `undefined !== null` held on EVERY inventory flush. The
    // event whose whole purpose is to fire only on a real change would have fired on every loot, every
    // purchase and every stack merge, redrawing `DurabilityFrame` and both repair buttons each time --
    // exactly the churn the memoisation above exists to avoid.
    //
    // A separate `lastAnnounced` slot, with its own `undefined` for "never announced", keeps `null`
    // meaning `null`, so null -> null is correctly no change.
    if (lastAnnounced !== after) {
      lastAnnounced = after;
      fireEvent(vm, 'UPDATE_INVENTORY_DURABILITY');
    }
    // The buyback slots are player fields on the same flush, so a sale changes the tab's contents
    // without any merchant packet at all. Only while a window is open -- `MERCHANT_UPDATE` outside one
    // would run `MerchantFrame_Update` against a hidden frame.
    onUpdate();
  };

  merchant.on('merchantShow', onShow);
  merchant.on('merchantUpdate', onUpdate);
  merchant.on('merchantClosed', onClosed);
  merchant.on('merchantSellFailed', onUpdate);
  merchant.on('merchantBuyFailed', onUpdate);
  items.on('templatesChanged', onTemplates);
  items.on('inventoryChanged', onInventory);

  (window as unknown as Record<string, unknown>).merchantBridge = () => ({
    vendor: merchant.source,
    vendorFlags: vendorFlags(),
    canRepair: (vendorFlags() & NPC_FLAG.REPAIR) !== 0,
    isVendor: (vendorFlags() & ANY_VENDOR) !== 0,
    rows: merchant.rows,
    buyback: buybackEntries(),
    repairAllCost: repairAllCost(),
    repairable: repairableGuids().length,
    durabilityTablesReady: durabilityData.ready,
    lastError: merchant.lastError,
  });

  return () => {
    disposed = true;
    setItemTooltipSource(vm, previous);
    setUnit(vm, 'npc', null);
    setUnit(vm, 'NPC', null);
    merchant.removeListener('merchantShow', onShow);
    merchant.removeListener('merchantUpdate', onUpdate);
    merchant.removeListener('merchantClosed', onClosed);
    merchant.removeListener('merchantSellFailed', onUpdate);
    merchant.removeListener('merchantBuyFailed', onUpdate);
    items.removeListener('templatesChanged', onTemplates);
    items.removeListener('inventoryChanged', onInventory);
    delete (window as unknown as Record<string, unknown>).merchantBridge;
  };
}

export default attachMerchantBridge;
