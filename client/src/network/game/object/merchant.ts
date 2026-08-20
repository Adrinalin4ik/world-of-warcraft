/**
 * BUYING AND SELLING -- the vendor's stock, a purchase, a sale, a buyback and a repair.
 *
 * `MerchantFrame.xml`/`.lua` are already in `FrameXML.toc` and already load; the owner's own console
 * proves it (`MerchantFrame.lua:546` raising twenty times on a nil `GetRepairAllCost`). Nothing here
 * draws. This file is the WIRE half and `game/ui/merchant-bridge.ts` is the engine-global half.
 *
 * ## THE LAYOUTS ARE 3.3.5a's OWN, READ OFF A SERVER IMPLEMENTATION, AND THE RESIDUAL IS THEIR ORACLE
 *
 * Same class of source and same caveat as `items.ts`, `loot.ts` and `gossip.ts`: nothing in the game's
 * own data states a packet body. These come from **TrinityCore's `3.3.5` branch**, read rather than
 * remembered -- `game/Handlers/ItemHandler.cpp`, `game/Server/Packets/ItemPackets.{h,cpp}`,
 * `game/Server/Packets/NPCPackets.cpp`, `game/Entities/Player/Player.cpp` and
 * `game/Entities/Item/Item.cpp`. Every arm records `consumed` against `bodySize` in `window.itemWire`;
 * a nonzero residual on a real packet means the layout is wrong.
 *
 * **THE 1.12 REFERENCE IS RIGHT ABOUT STRUCTURE AND WRONG ABOUT THREE NUMBERS, and each one is
 * silent.** `benilla-protocol/src/messages/vendor.rs` is the shape this file follows -- the same five
 * sends, the same four receives, the same "a successful sell sends no packet at all" law. The deltas:
 *
 *  1. **A vendor row is EIGHT words in 3.3.5a, not seven.** `extendedCost` is appended
 *     (`NPCPackets.cpp:69-81`, and `ItemHandler.cpp`'s own reserve is `numitems * 8 * 4`). Reading the
 *     1.12 shape would desync after the FIRST row and every price below it would be garbage.
 *  2. **`CMSG_SELL_ITEM`'s count is a `u32`, not a `u8`** (`ItemPackets.h:71`, `SellItem::Amount`).
 *     1.12 pushes one byte (`vendor.rs#sell_item`). Three bytes short is exactly the class of defect
 *     that made `CMSG_SWAP_INV_ITEM` answer with silence.
 *  3. **`CMSG_REPAIR_ITEM` gained a trailing `u8`** -- `UseGuildBank` (`ItemPackets.cpp:33-38`). 1.12
 *     is the bare guid pair (`vendor.rs#repair_item`).
 *
 * A fourth is not a delta but a correction: `CMSG_BUY_ITEM` addresses the item by **entry AND vendor
 * row**, in that order, with a `u32` count and a trailing unknown byte
 * (`ItemHandler.cpp:542-558`: `recvData >> vendorguid >> item >> slot >> count >> unk1`). The 1.12
 * reference sends entry and a `u8` count and NO slot at all. The server `--slot`s what we send and
 * treats slot 0 as cheating and returns, so a client that omits the slot is not merely misread, it is
 * silently dropped.
 *
 * The `ItemPackets.cpp` this was read from is the same file whose `SwapInvItem::Read` is
 * `Slot2 >> Slot1` -- destination first, which is this project's own hardest-won wire fact
 * (`CLAUDE.md`'s trap list). That agreement is the check on the source, not a coincidence.
 *
 * ## A SUCCESSFUL SELL AND A SUCCESSFUL REPAIR SEND NOTHING
 *
 * `Player::SendSellError` is only ever called on the error path (`Player.cpp:13139`), and a good sale
 * is visible only as the item's descriptor leaving and `PLAYER_FIELD_COINAGE` rising through
 * `UPDATE_OBJECT`. Both already flow: `ItemHandler#forgetObject` and `notePlayerFields`. So the
 * merchant window's refresh after a sale is NOT this file's job and must not be faked here -- it comes
 * from `inventoryChanged`, which the bridge already listens to. Faking it would produce a window that
 * updated when the server had refused.
 *
 * ## What is NOT here
 *
 * `SMSG_ITEM_PUSH_RESULT` -- the "you received" toast. A bought item arrives in the bag through the
 * normal `UPDATE_OBJECT` path this client already decodes, so the purchase works without it; the toast
 * is a separate feature and is not pretended at.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes, guidHex, GUID_BYTES } from '../../guid-hex';
import { itemWire } from '../../../game/classes/item-wire';

/**
 * The player-array index of the FIRST buyback slot, which is what `CMSG_BUYBACK_ITEM` carries.
 *
 * **74 in 3.3.5a, and the 1.12 reference says 69** (`benilla/src/ui_merchant.rs:43-44`,
 * `BUYBACK_SLOT_FIRST = 69`). Both are `BUYBACK_SLOT_START` from their own core; WotLK's inventory
 * grew, so every absolute slot above the bags moved. The value here is
 * `TrinityCore/3.3.5 src/server/game/Entities/Player/Player.h:603` (`BUYBACK_SLOT_START = 74`,
 * `BUYBACK_SLOT_END = 86`, i.e. twelve slots) -- which agrees independently with the descriptor: this
 * client's own `PlayerField.player_field_vendorbuyback_slot_1` runs to
 * `player_field_keyring_slot_1` in 0x18 words, and 24 words is 12 guids.
 *
 * The slot is sent RAW with no re-base -- the reference says the same for its own number.
 */
export const BUYBACK_SLOT_START = 74;

/** How many buyback slots the player array holds. `BUYBACK_SLOT_END - BUYBACK_SLOT_START`. */
export const BUYBACK_SLOTS = 12;

/** One row of `SMSG_LIST_INVENTORY`: EIGHT u32 words, 32 bytes. */
export interface VendorRow {
  /**
   * `MuID` -- the vendor row's own 1-based index, and what `CMSG_BUY_ITEM` echoes back.
   *
   * The server writes `slot + 1` and subtracts one when it reads it back, treating 0 as cheating
   * (`ItemHandler.cpp:551-554`). It is NOT a display position: rows the player may not see are skipped
   * server-side, so this is sparse and the display index is separate. See `merchant-bridge.ts#rowAt`.
   */
  muid: number;
  /** The item template entry. `CMSG_BUY_ITEM`'s `item`. */
  entry: number;
  /** Straight to `ItemDisplayInfo.dbc` for the icon, with no query round trip -- as loot rows are. */
  displayInfoId: number;
  /**
   * Stock left. **`-1` means unlimited** -- the server writes `!maxcount ? -1 : currentCount`
   * (`ItemHandler.cpp:611`), so this is read SIGNED. A sold-out row is never sent at all.
   */
  quantity: number;
  /** Copper, ALREADY reputation-discounted server-side (`ItemHandler.cpp:634`). */
  price: number;
  /** The template's max durability. Sent so the row can be drawn before the query answers. */
  maxDurability: number;
  /** How many the player gets per purchase -- the template's `BuyCount`. `quantity` in FrameXML. */
  stackCount: number;
  /** `ItemExtendedCost.dbc` row, or 0. Nonzero means honor/arena/token currency is involved. */
  extendedCostId: number;
}

/** `SellResult` (`ItemHandler.cpp`'s `SELL_ERR_*`). Only the error path sends `SMSG_SELL_ITEM`. */
export const SELL_ERROR = {
  CANT_FIND_ITEM: 1,
  CANT_SELL_ITEM: 2,
  CANT_FIND_VENDOR: 3,
  YOU_DONT_OWN_THAT_ITEM: 4,
  UNK: 5,
  ONLY_EMPTY_BAG: 6,
} as const;

export class MerchantHandler extends EventEmitter {
  private game: GameHandler;

  /** The vendor whose window is open, or null. */
  public source: string | null = null;

  /** The vendor's stock, in wire order. */
  public rows: VendorRow[] = [];

  /** The last refusal, for the instrument and for a console line. Cleared when a window opens. */
  public lastError: { kind: 'sell' | 'buy'; code: number; guid: string } | null = null;

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `LootHandler`'s constructor.
    this.game = gameHandler;
    this.subscribe('SMSG_LIST_INVENTORY', this.handleListInventory);
    this.subscribe('SMSG_BUY_ITEM', this.handleBuyItem);
    this.subscribe('SMSG_SELL_ITEM', this.handleSellItem);
    this.subscribe('SMSG_BUY_FAILED', this.handleBuyFailed);
    // An open window belongs to the session that opened it -- the same reasoning `LootHandler` and
    // `ItemHandler` state for their own `SMSG_LOGIN_VERIFY_WORLD` hooks. A stale vendor guid would
    // aim the next character's `CMSG_SELL_ITEM` at an NPC in a world he is not in.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => this.close());
  }

  /**
   * One arm with the over-read catch, exactly as `loot.ts#subscribe` does it and for the same reason:
   * `byte-buffer` THROWS past the frame, and an uncaught throw escapes `GameHandler#dataReceived`'s
   * receive loop and takes every packet still buffered in that data event.
   */
  private subscribe(name: string, arm: (gp: GamePacket) => void): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        arm.call(this, gp);
        itemWire.record({
          at: performance.now(), opcode: name, entry: 0, name: '',
          bodySize, consumed: gp.index - gp.headerSize,
        });
      } catch (e) {
        itemWire.record({
          at: performance.now(), opcode: `${name}!THREW`, entry: 0, name: '',
          bodySize, consumed: gp.index - gp.headerSize,
        });
        console.warn(
          `merchant: ${name} did not decode -- ${(e as Error).message}. These layouts come from a`
          + ' SERVER implementation (see the header of network/game/object/merchant.ts) and are'
          + ' validated rather than trusted. Read window.itemWire.census().',
        );
      }
    });
  }

  // -- Incoming -----------------------------------------------------------------------------------

  /**
   * `SMSG_LIST_INVENTORY` (**0x19F**) -- the whole shop, and what opens the window.
   *
   *     u64 guid (FULL, not packed) · u8 count · count x { 8 x u32/i32, see VendorRow }
   *     and, ONLY when count == 0, a trailing i8 reason
   *
   * `count` is a **u8** back-patched by the writer (`NPCPackets.cpp:86`), and `MAX_VENDOR_ITEMS` is
   * 128, so it never overflows.
   *
   * The empty case's trailing byte is read CONDITIONALLY, and that conditional read has the same
   * honest caveat `loot.ts#handleMoneyNotify` records about its own: a guarded read makes the residual
   * 0 whether the byte is there or not, so `itemWire` cannot corroborate this one branch. The
   * populated case -- the one that matters and the one a real vendor produces -- is a fixed shape and
   * IS genuinely checked.
   */
  private handleListInventory(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const count = gp.readUnsignedByte();
    const rows: VendorRow[] = [];
    for (let i = 0; i < count; ++i) {
      const muid = gp.readUnsignedInt() >>> 0;
      const entry = gp.readUnsignedInt() >>> 0;
      const displayInfoId = gp.readUnsignedInt() >>> 0;
      // SIGNED on purpose: -1 is "unlimited stock" and reading it unsigned would put 4294967295 into
      // `SetItemButtonStock`, which prints the number on the icon.
      const quantity = gp.readInt();
      const price = gp.readUnsignedInt() >>> 0;
      const maxDurability = gp.readUnsignedInt() >>> 0;
      const stackCount = gp.readUnsignedInt() >>> 0;
      const extendedCostId = gp.readUnsignedInt() >>> 0;
      rows.push({
        muid, entry, displayInfoId, quantity, price, maxDurability, stackCount, extendedCostId,
      });
    }
    if (count === 0 && gp.available > 0) {
      gp.readUnsignedByte(); // `VendorInventoryReason` -- read for the frame, not kept
    }
    this.source = guid;
    this.rows = rows;
    this.lastError = null;
    this.emit('merchantShow');
  }

  /**
   * `SMSG_BUY_ITEM` (**0x1A4**) -- a purchase went through; the row's stock changed.
   *
   *     u64 guid · u32 vendorSlot (1-based, i.e. the row's muid) · i32 newCount · u32 stacks
   *
   * `Player.cpp:21384-21389`. `newCount` is `0xFFFFFFFF` for an unlimited row, which is the same -1
   * the list uses. The bought ITEM itself does not arrive here -- it comes through `UPDATE_OBJECT`,
   * which `ItemHandler` already decodes.
   */
  private handleBuyItem(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const muid = gp.readUnsignedInt() >>> 0;
    const newCount = gp.readInt();
    const stacks = gp.readUnsignedInt() >>> 0;
    if (this.source !== null && this.source !== guid) {
      // A reply from a vendor we are no longer looking at. Same guid match as
      // `LootHandler#handleReleaseResponse`, and for the same reason.
      return;
    }
    const row = this.rows.find((entry) => entry.muid === muid);
    if (row !== undefined) {
      row.quantity = newCount;
    }
    this.emit('merchantUpdate', { muid, newCount, stacks });
  }

  /**
   * `SMSG_SELL_ITEM` (**0x1A1**) -- a REFUSAL. A good sale sends nothing at all.
   *
   *     u64 vendorGuid · u64 itemGuid · [u32 param, only when nonzero] · u8 reason
   *
   * `Player.cpp:13139-13148`. **The `param` word is conditional on the server side**, so the body is
   * 17 bytes without it and 21 with it, and there is no flag saying which. Every call site in
   * `ItemHandler.cpp` passes `param = 0` (grepped: nine `SendSellError` calls, all with a literal 0),
   * so 17 is the shape that actually occurs; the 21-byte branch is taken off the remaining size rather
   * than assumed away, because guessing wrong would put the reason byte inside the param word.
   */
  private handleSellItem(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const itemGuid = this.readFullGuid(gp);
    if (gp.available > 1) {
      gp.readUnsignedInt(); // param -- never nonzero from any 3.3.5a call site; read for the frame
    }
    const code = gp.readUnsignedByte();
    this.lastError = { kind: 'sell', code, guid: itemGuid };
    this.emit('merchantSellFailed', { code, itemGuid, vendor: guid });
  }

  /**
   * `SMSG_BUY_FAILED` (**0x1A5**): `u64 guid · u32 entry · [u32 param when nonzero] · u8 reason`.
   *
   * `Player.cpp:13128-13137`, and the same conditional-param caveat as the sell error above.
   */
  private handleBuyFailed(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const entry = gp.readUnsignedInt() >>> 0;
    if (gp.available > 1) {
      gp.readUnsignedInt(); // param
    }
    const code = gp.readUnsignedByte();
    this.lastError = { kind: 'buy', code, guid };
    this.emit('merchantBuyFailed', { code, entry, vendor: guid });
  }

  // -- Outgoing -----------------------------------------------------------------------------------

  /**
   * `CMSG_LIST_INVENTORY` (**0x19E**): one FULL 8-byte guid.
   *
   * NOT the normal way in. `pages/game/index.tsx`'s right click sends `CMSG_GOSSIP_HELLO` instead --
   * see `gossip.ts`' header for why. This exists for the gossip-less reopen: the merchant window's own
   * `MERCHANT_UPDATE` path and an addon calling for a refresh.
   */
  listInventory(guid: string): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_LIST_INVENTORY, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES,
    );
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `CMSG_BUY_ITEM` (**0x1A2**): `u64 guid · u32 entry · u32 muid · u32 count · u8 unk1`, 21 bytes.
   *
   * See the header on why the ROW as well as the entry, and on why the 1.12 reference's shape is
   * dropped by the server rather than misread. `count` is the number of STACKS
   * (`BuyItemFromVendorSlot`'s `stacks`), so buying one of a 20-stack reagent is `count = 1`.
   */
  buy(entry: number, muid: number, count = 1): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_BUY_ITEM, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 12 + 1,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(entry >>> 0);
    gp.writeUnsignedInt(muid >>> 0);
    gp.writeUnsignedInt(count >>> 0);
    gp.writeUnsignedByte(0); // unk1 -- the server reads it and ignores it
    this.game.send(gp);
  }

  /**
   * `CMSG_SELL_ITEM` (**0x1A0**): `u64 vendorGuid · u64 itemGuid · u32 amount`, 20 bytes.
   *
   * **`amount` is a u32 here and a u8 in 1.12** -- see the header. `0` means the whole stack, which is
   * what a right click in a bag does (`benilla/src/ui_items/drain.rs:177` states the same law).
   */
  sell(itemGuid: string, amount = 0): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_SELL_ITEM, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES * 2 + 4,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.write(Array.from(guidBytes(itemGuid)));
    gp.writeUnsignedInt(amount >>> 0);
    this.game.send(gp);
  }

  /**
   * `CMSG_BUYBACK_ITEM` (**0x290**): `u64 vendorGuid · u32 slot`, 12 bytes.
   *
   * The slot is the ABSOLUTE player-array slot, `BUYBACK_SLOT_START + index`, sent with no re-base --
   * see `BUYBACK_SLOT_START` on why 74 and not the reference's 69.
   */
  buyback(index: number): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_BUYBACK_ITEM, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 4,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt((BUYBACK_SLOT_START + index) >>> 0);
    this.game.send(gp);
  }

  /**
   * `CMSG_REPAIR_ITEM` (**0x2A8**): `u64 npcGuid · u64 itemGuid · u8 useGuildBank`, 17 bytes.
   *
   * **`itemGuid == 0` means repair EVERYTHING** -- the reference records the same rule from the real
   * client's four send sites (`vendor.rs#repair_item`). The trailing byte is the WotLK addition
   * (`ItemPackets.cpp:33-38`); 1.12 has 16 bytes and sending 16 here would leave the server reading a
   * `bool` off the end of the frame.
   *
   * A successful repair sends nothing back: the items' `ITEM_FIELD_DURABILITY` and the player's
   * coinage both arrive through `UPDATE_OBJECT`, which is what re-fires `UPDATE_INVENTORY_DURABILITY`
   * and re-reads the cost.
   */
  repair(itemGuid: string | null, useGuildBank = false): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_REPAIR_ITEM, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES * 2 + 1,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.write(Array.from(guidBytes(itemGuid ?? '0x0')));
    gp.writeUnsignedByte(useGuildBank ? 1 : 0);
    this.game.send(gp);
  }

  /**
   * Drop the window.
   *
   * Nothing goes out: there is no `CMSG_CLOSE_MERCHANT` in 3.3.5a -- the vendor session ends when the
   * player walks away or the server closes it. That is why `CloseMerchant` in the bridge calls this
   * and sends nothing, unlike `CloseLoot`, which must send `CMSG_LOOT_RELEASE`.
   */
  close(): void {
    if (this.source === null) {
      return;
    }
    this.source = null;
    this.rows = [];
    this.lastError = null;
    this.emit('merchantClosed');
  }

  /** Eight little-endian bytes -> the normalised guid string. `guid-hex.ts` says why not a Number. */
  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }
}

export default MerchantHandler;
