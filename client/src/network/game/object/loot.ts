/**
 * LOOTING A CORPSE, end to end -- the window opening, its slots, taking an item, taking the money, and
 * releasing.
 *
 * `LootFrame.xml`/`.lua` are already in the manifest and already load; they draw four `LootButton`s and
 * page through anything beyond that. Nothing here draws. This file is the WIRE half and
 * `game/ui/loot-bridge.ts` is the engine-global half.
 *
 * ## THE LAYOUTS ARE FROM A SERVER IMPLEMENTATION, AND THE RESIDUAL IS THEIR ORACLE
 *
 * Same class of source, and same caveat, as `items.ts` and `combat-log.ts`: nothing in the game's own
 * data states a packet body, so these come from **TrinityCore 3.3.5** (`LootHandler.cpp`,
 * `LootMgr.cpp`'s `operator<<(ByteBuffer&, LootView const&)`, `Player::SendLootRelease`). Every arm
 * records `consumed` against `bodySize` in `window.itemWire`; a nonzero residual on a real packet
 * means the layout is wrong.
 *
 * The 1.12 reference (`benilla-protocol/src/messages/loot.rs`) is the STRUCTURE and it is unusually
 * close here -- the loot family barely moved between 1.12 and WotLK. Two things are worth stating
 * because getting either wrong is silent:
 *
 *  - **EVERY GUID IN THIS FAMILY IS A FULL 8-BYTE u64, NOT PACKED.** `loot.rs:347,387` and the builders
 *    at `:110,133`. This is the opposite of the combat-log family, where all but `SMSG_SPELLLOGMISS`
 *    are packed -- so the instinct carried over from that file is exactly wrong here.
 *  - **`SMSG_LOOT_MONEY_NOTIFY` GAINED A TRAILING u8 IN WotLK.** 1.12 is the lone `u32` (`loot.rs:400`);
 *    3.3.5a appends a byte the client uses to choose between "Your share is..." and "You loot...".
 *    That byte is the one version-numbered difference in this file and it is read, not assumed away.
 *
 * ## The slot numbering, which has two different meanings and they must not be confused
 *
 * The WIRE slot is the index into the server's own loot item list, 0-based, and it is what
 * `CMSG_AUTOSTORE_LOOT_ITEM` carries and what `SMSG_LOOT_REMOVED` names. The DISPLAY index is what
 * FrameXML passes to `GetLootSlotInfo`/`LootSlot`, is 1-based, and has the COIN row occupying index 1
 * whenever there is money. The bridge owns that mapping (`benilla/src/ui_loot.rs:258`, `action_at`);
 * this file speaks only wire slots.
 *
 * A removed row KEEPS the wire slots of the rows around it -- `remove_slot` filters the list and does
 * not renumber (`ui_loot.rs:175-178`). Renumbering would make the next `CMSG_AUTOSTORE_LOOT_ITEM` ask
 * for the wrong item, which is the kind of defect that loses a player his drop.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes, guidHex, GUID_BYTES } from '../../guid-hex';
import { itemWire } from '../../../game/classes/item-wire';

/** One item row of `SMSG_LOOT_RESPONSE`, exactly 22 bytes on the wire. */
export interface LootRow {
  /** The WIRE slot: 0-based, and what `CMSG_AUTOSTORE_LOOT_ITEM` carries. Never renumbered. */
  slot: number;
  itemId: number;
  count: number;
  /** Straight to `ItemDisplayInfo.dbc` for the icon, with no query round trip needed. */
  displayInfoId: number;
  randomPropertyId: number;
  /**
   * `LootSlotType`: 0 ALLOW_LOOT, 1 ROLL_ONGOING, 2 MASTER, 3 LOCKED, 4 OWNER
   * (`benilla-protocol/src/messages/loot.rs:37-48`). Only 0 and 3 occur solo.
   */
  slotType: number;
}

/** `loot_type` (`loot.rs:58-63`). 3 is what `IsFishingLoot` answers to. */
export const LOOT_TYPE_FISHING = 3;

export class LootHandler extends EventEmitter {
  private game: GameHandler;

  /** The corpse or object currently open, or null. */
  public source: string | null = null;

  /** Copper in the pile. 0 once taken. */
  public gold = 0;

  /** The item rows still available, in wire order. */
  public rows: LootRow[] = [];

  /** `loot_type` from the response -- `IsFishingLoot`'s only source. */
  public lootType = 0;

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `CombatLogHandler`'s constructor.
    this.game = gameHandler;
    this.subscribe('SMSG_LOOT_RESPONSE', this.handleResponse);
    this.subscribe('SMSG_LOOT_RELEASE_RESPONSE', this.handleReleaseResponse);
    this.subscribe('SMSG_LOOT_REMOVED', this.handleRemoved);
    this.subscribe('SMSG_LOOT_MONEY_NOTIFY', this.handleMoneyNotify);
    this.subscribe('SMSG_LOOT_CLEAR_MONEY', this.handleClearMoney);
  }

  /**
   * One arm with the over-read catch, exactly as `combat-log.ts#subscribe` does it and for the same
   * reason: `byte-buffer` THROWS past the frame, and an uncaught throw escapes
   * `GameHandler#dataReceived`'s receive loop and takes every packet still buffered in that data event.
   *
   * The residual is recorded on BOTH paths. A `!THREW` row's `consumed` is where the read cursor died,
   * which is the most useful number available when one of these layouts is wrong.
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
          `loot: ${name} did not decode -- ${(e as Error).message}. These layouts come from a`
          + ' SERVER implementation (see the header of network/game/object/loot.ts) and are'
          + ' validated rather than trusted. Read window.itemWire.census().',
        );
      }
    });
  }

  // -- Incoming -----------------------------------------------------------------------------------

  /**
   * `SMSG_LOOT_RESPONSE` (**0x160**) -- the window's whole contents.
   *
   * `u64 guid` (FULL) · `u8 lootType`. **`lootType == 0` is the ERROR shape** and is followed by a lone
   * `u8` error code and nothing else (`loot.rs:349-352`); it is how "you are too far away" and "someone
   * else's kill" arrive, and reading it as the items shape would take the error byte for the low byte
   * of `gold`. Otherwise: `u32 gold` · `u8 itemCount` · that many 22-byte rows.
   *
   * `itemCount` is a **u8**, not a u32 -- the server back-patches one byte
   * (`LootMgr.cpp`'s count placeholder).
   */
  private handleResponse(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const lootType = gp.readUnsignedByte();
    if (lootType === 0) {
      const error = gp.readUnsignedByte();
      this.emit('lootError', { guid, error });
      return;
    }
    const gold = gp.readUnsignedInt() >>> 0;
    const count = gp.readUnsignedByte();
    const rows: LootRow[] = [];
    for (let i = 0; i < count; ++i) {
      const slot = gp.readUnsignedByte();
      const itemId = gp.readUnsignedInt() >>> 0;
      const rowCount = gp.readUnsignedInt() >>> 0;
      const displayInfoId = gp.readUnsignedInt() >>> 0;
      // `randomSuffix` is read and dropped: the server writes a literal 0 there and never anything
      // else (`loot.rs:20-22`). Reading it is not optional even so -- it is four bytes of frame.
      gp.readUnsignedInt();
      const randomPropertyId = gp.readUnsignedInt() >>> 0;
      const slotType = gp.readUnsignedByte();
      rows.push({ slot, itemId, count: rowCount, displayInfoId, randomPropertyId, slotType });
    }
    this.source = guid;
    this.lootType = lootType;
    this.gold = gold;
    this.rows = rows;
    this.emit('lootOpened');
  }

  /** `SMSG_LOOT_RELEASE_RESPONSE` (**0x161**): `u64 guid` (FULL) · `u8 result`, always 1. */
  private handleReleaseResponse(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    gp.readUnsignedByte(); // result -- the server never sends anything but 1 (`loot.rs:384-385`)
    // GUID-MATCHED. A release response for a corpse we are no longer looking at must not close the
    // window we have just opened on the next one -- the corpse-switch race `LootLatch::clear_for`
    // (`benilla/src/ui_loot.rs:303-311`) exists for.
    if (this.source !== null && this.source !== guid) {
      return;
    }
    this.close();
  }

  /**
   * `SMSG_LOOT_REMOVED` (**0x162**): a single `u8`, the WIRE slot. **No guid** (`loot.rs:393-395`).
   *
   * The row is filtered out and the surviving rows KEEP their wire slots -- see the header on why
   * renumbering would lose a player his drop.
   */
  private handleRemoved(gp: GamePacket): void {
    const slot = gp.readUnsignedByte();
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.slot !== slot);
    if (this.rows.length !== before) {
      this.emit('lootRemoved', slot);
    }
  }

  /**
   * `SMSG_LOOT_MONEY_NOTIFY` (**0x163**): `u32 copper` and -- **in WotLK only** -- a trailing `u8`.
   *
   * The byte is the client's chat-line selector ("Your share is..." vs "You loot..."), 1 when the
   * looter is alone. 1.12 has no such byte (`loot.rs:400-402`), which is this file's one
   * version-numbered difference from the reference. This client has no loot chat line, so the value is
   * read for the frame and not kept; the READ is what matters, since a missed byte would leave the
   * residual at 1 and mask a real defect later.
   */
  private handleMoneyNotify(gp: GamePacket): void {
    const copper = gp.readUnsignedInt() >>> 0;
    if (gp.available > 0) {
      gp.readUnsignedByte();
    }
    this.emit('lootMoney', copper);
  }

  /** `SMSG_LOOT_CLEAR_MONEY` (**0x165**): an EMPTY body. The coin row is gone. */
  private handleClearMoney(): void {
    if (this.gold !== 0) {
      this.gold = 0;
      this.emit('lootRemoved', -1);
    }
  }

  // -- Outgoing -----------------------------------------------------------------------------------

  /** `CMSG_LOOT` (**0x15D**): one FULL 8-byte guid. */
  loot(guid: string): void {
    this.send(GameOpcode.CMSG_LOOT, guid);
  }

  /**
   * `CMSG_LOOT_RELEASE` (**0x15F**): one FULL 8-byte guid.
   *
   * The server ignores the guid and releases whatever it has stored for us (`loot.rs:129-131`), but it
   * reads eight bytes regardless, so they must be there.
   */
  release(): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    this.send(GameOpcode.CMSG_LOOT_RELEASE, guid);
    // The window is NOT closed locally here: `SMSG_LOOT_RELEASE_RESPONSE` is what closes it, so there
    // is one source of truth. Same law as `CMSG_ATTACKSTOP` and the bar it does not write.
  }

  /** `CMSG_AUTOSTORE_LOOT_ITEM` (**0x108**): a single `u8`, the WIRE slot. */
  take(wireSlot: number): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_AUTOSTORE_LOOT_ITEM, GamePacket.HEADER_SIZE_OUTGOING + 1,
    );
    gp.writeUnsignedByte(wireSlot & 0xff);
    this.game.send(gp);
  }

  /** `CMSG_LOOT_MONEY` (**0x15E**): an EMPTY body. The server knows which loot we have open. */
  takeMoney(): void {
    this.game.send(new GamePacket(GameOpcode.CMSG_LOOT_MONEY, GamePacket.HEADER_SIZE_OUTGOING));
  }

  /** Drop the window without telling the server -- for a disconnect or a corpse that despawned. */
  close(): void {
    if (this.source === null) {
      return;
    }
    this.source = null;
    this.gold = 0;
    this.rows = [];
    this.emit('lootClosed');
  }

  private send(opcode: number, guid: string): void {
    const gp = new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES);
    // FULL, not packed -- see the header. `writeGUID` takes a `GUID` object, so the bytes go in
    // through `guidBytes`, which is the one converter for this client's hex-string guids.
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
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

export default LootHandler;
