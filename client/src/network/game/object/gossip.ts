/**
 * TALKING TO AN NPC -- the gossip menu, its options, and selecting one.
 *
 * This is the DOOR the merchant window comes through. `GossipFrame.xml`/`.lua` are already in
 * `FrameXML.toc` and already load; nothing here draws. This file is the wire half and
 * `game/ui/gossip-bridge.ts` is the engine-global half.
 *
 * ## Why gossip exists at all in a merchant round
 *
 * Right-clicking a friendly service NPC sends `CMSG_GOSSIP_HELLO` -- ONE opcode for every service.
 * What comes back depends on what the server has for that creature:
 *
 *  - a creature with a gossip menu answers `SMSG_GOSSIP_MESSAGE`, and the player picks "Let me browse
 *    your goods" (a `GOSSIP_OPTION_VENDOR` option), which sends `CMSG_GOSSIP_SELECT_OPTION` and THEN
 *    gets `SMSG_LIST_INVENTORY`;
 *  - a creature with NO gossip menu and a single service answers that service's packet DIRECTLY --
 *    `SMSG_LIST_INVENTORY` with no gossip step at all.
 *
 * Both paths therefore have to work, and neither is a special case of the other. That is why
 * `pages/game/index.tsx`'s right click sends `CMSG_GOSSIP_HELLO` and does NOT send
 * `CMSG_LIST_INVENTORY`: sending the inventory request directly would work on the plain vendors and
 * would skip the menu on every NPC that has one (which is most quest-giving vendors), and worse, it
 * would ask a flight master for a shop.
 *
 * The reference records what happens when a client sends `CMSG_GOSSIP_HELLO` at an NPC with nothing to
 * say: "the server answered with eight literal `Greetings $N` blocks"
 * (`benilla/src/target/cursor_mode.rs:399-420`, quoted in `task-9-report.md`). So the hello is cheap
 * and safe, and the gate on sending it is the NPC service ladder that
 * `game/world/cursor-mode.ts#NPC_FLAG` already decodes for the hover cursors.
 *
 * ## THE LAYOUTS COME FROM A SERVER IMPLEMENTATION, AND THE RESIDUAL IS THEIR ORACLE
 *
 * Same class of source and same caveat as `items.ts`, `loot.ts` and `combat-log.ts`: nothing in the
 * game's own data states a packet body, so `SMSG_GOSSIP_MESSAGE` comes from **TrinityCore 3.3.5**
 * (`PlayerMenu::SendGossipMenu`, `GossipDef.cpp`). Every arm records `consumed` against `bodySize` in
 * `window.itemWire`; a nonzero residual on a real packet means the layout is wrong. The 1.12 reference
 * is NOT usable here: `benilla` never loads `GossipFrame.lua` and its gossip message has no `menuId`,
 * no `boxMoney` and no `boxMessage` -- all three are WotLK additions, and reading the 1.12 shape
 * against a 3.3.5a packet desyncs at the first option.
 *
 * ## The greeting TEXT is not in this packet
 *
 * `SMSG_GOSSIP_MESSAGE` carries a `titleTextId`, which is a row of `NpcText.dbc` the client resolves
 * with `CMSG_NPC_TEXT_QUERY` (**0x17F**) -> `SMSG_NPC_TEXT_UPDATE` (**0x180**). Both opcodes are in
 * `opcode.js` and until now had no subscriber. `GossipFrameUpdate` does
 * `GossipGreetingText:SetText(GetGossipText())` (`gossipframe.lua:33`), so without the query the menu
 * draws with its buttons and an EMPTY greeting -- which is why the query is here and not deferred.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes, guidHex, GUID_BYTES } from '../../guid-hex';
import { itemWire } from '../../../game/classes/item-wire';

/** One row of the gossip menu's option list. */
export interface GossipOption {
  /** The server's own index, and what `CMSG_GOSSIP_SELECT_OPTION` carries back. */
  index: number;
  /**
   * `GOSSIP_ICON_*`. Turned into the STRING `GetGossipOptions` answers by
   * `game/ui/gossip-bridge.ts#ICON_NAMES`, which is data-driven off the served art.
   */
  icon: number;
  /** The option needs a typed code (a guild petition, a battleground queue password). */
  coded: boolean;
  /** Copper the option costs. 0 for nearly everything. */
  boxMoney: number;
  /** The button's label. */
  text: string;
  /** The confirmation dialogue's body, empty for nearly everything. */
  boxText: string;
}

/** One row of the quest list a gossip menu can carry. Available and active have DIFFERENT shapes. */
export interface GossipQuest {
  questId: number;
  /** `SMSG_GOSSIP_MESSAGE`'s own icon word. Not consumed by `GossipFrame`, kept for the residual. */
  icon: number;
  level: number;
  flags: number;
  /** Available quests only: the daily/repeatable byte. Active quests: the "is complete" byte. */
  marker: boolean;
  title: string;
}

export class GossipHandler extends EventEmitter {
  private game: GameHandler;

  /** The NPC we are talking to, or null. */
  public source: string | null = null;

  /**
   * `SMSG_GOSSIP_MESSAGE`'s `menuId`, which `CMSG_GOSSIP_SELECT_OPTION` must echo back.
   *
   * **This is the one field a 1.12-shaped decode would drop, and dropping it is silent**: the select
   * would go out with the option index in the menu id's slot and the server would answer nothing.
   * That is the same failure mode as `CMSG_SWAP_INV_ITEM`'s argument order.
   */
  public menuId = 0;

  /** The `NpcText.dbc` row the greeting comes from. */
  public titleTextId = 0;

  /** The greeting text once `SMSG_NPC_TEXT_UPDATE` has answered, else null. */
  public greeting: string | null = null;

  public options: GossipOption[] = [];

  public availableQuests: GossipQuest[] = [];

  public activeQuests: GossipQuest[] = [];

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `LootHandler`'s constructor.
    this.game = gameHandler;
    this.subscribe('SMSG_GOSSIP_MESSAGE', this.handleMessage);
    this.subscribe('SMSG_GOSSIP_COMPLETE', this.handleComplete);
    this.subscribe('SMSG_NPC_TEXT_UPDATE', this.handleNpcText);
    // An open menu belongs to the session that opened it -- the same reasoning `LootHandler` and
    // `ItemHandler` state for their own `SMSG_LOGIN_VERIFY_WORLD` hooks.
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
          `gossip: ${name} did not decode -- ${(e as Error).message}. These layouts come from a`
          + ' SERVER implementation (see the header of network/game/object/gossip.ts) and are'
          + ' validated rather than trusted. Read window.itemWire.census().',
        );
      }
    });
  }

  // -- Incoming -----------------------------------------------------------------------------------

  /**
   * `SMSG_GOSSIP_MESSAGE` (**0x17D**) -- the whole menu.
   *
   *     u64 guid (FULL, not packed)
   *     u32 menuId          -- WotLK addition; must be echoed by CMSG_GOSSIP_SELECT_OPTION
   *     u32 titleTextId     -- NpcText.dbc row; see the header
   *     u32 optionCount
   *       per option: u32 index · u8 icon · u8 coded · u32 boxMoney · cstr text · cstr boxText
   *     u32 questCount
   *       per quest:  u32 questId · u32 icon · i32 level · u32 flags · u8 repeatable · cstr title
   *
   * `readCStr`, NOT `readCString` -- byte-buffer's own reader does not consume an EMPTY string's
   * terminator, and `boxText` is empty on essentially every option, so `readCString` here would desync
   * by one byte PER OPTION. That is the defect `network/net/packet.js#readCStr`'s comment measured on
   * `SMSG_ITEM_QUERY_SINGLE_RESPONSE`, and this packet has strictly more empty strings than that one.
   *
   * The quest block's 3.3.5a shape carries BOTH a flags word and a trailing byte. In 1.12 there is
   * neither (`benilla-protocol` gossip: id, icon, level, title). The residual is what proves it.
   */
  private handleMessage(gp: GamePacket): void {
    const guid = this.readFullGuid(gp);
    const menuId = gp.readUnsignedInt() >>> 0;
    const titleTextId = gp.readUnsignedInt() >>> 0;

    const optionCount = gp.readUnsignedInt() >>> 0;
    const options: GossipOption[] = [];
    for (let i = 0; i < optionCount; ++i) {
      const index = gp.readUnsignedInt() >>> 0;
      const icon = gp.readUnsignedByte();
      const coded = gp.readUnsignedByte() !== 0;
      const boxMoney = gp.readUnsignedInt() >>> 0;
      const text = gp.readCStr();
      const boxText = gp.readCStr();
      options.push({ index, icon, coded, boxMoney, text, boxText });
    }

    const questCount = gp.readUnsignedInt() >>> 0;
    const available: GossipQuest[] = [];
    for (let i = 0; i < questCount; ++i) {
      const questId = gp.readUnsignedInt() >>> 0;
      const icon = gp.readUnsignedInt() >>> 0;
      // SIGNED: a quest whose level is -1 means "scales to the player", and reading it unsigned would
      // print 4294967295 into the button label through `NORMAL_QUEST_DISPLAY`.
      const level = gp.readInt();
      const flags = gp.readUnsignedInt() >>> 0;
      const marker = gp.readUnsignedByte() !== 0;
      const title = gp.readCStr();
      available.push({ questId, icon, level, flags, marker, title });
    }

    this.source = guid;
    this.menuId = menuId;
    this.titleTextId = titleTextId;
    this.options = options;
    // **THE QUEST LIST IS ALL "AVAILABLE" AND THAT IS THE WIRE'S OWN SHAPE, not a simplification of
    // ours.** `SMSG_GOSSIP_MESSAGE` has ONE quest array; the split into available and active is the
    // server's choice of which quests to put in it, and 3.3.5a's gossip message carries only the
    // available ones (active quests reach the client through `SMSG_QUESTGIVER_QUEST_LIST`, which this
    // client does not decode). `activeQuests` therefore stays empty, and
    // `GetNumGossipActiveQuests` answering 0 is correct rather than a gap.
    this.availableQuests = available;
    this.activeQuests = [];
    // The greeting is a second round trip. Cleared first so a stale one from the previous NPC cannot
    // be drawn under this one's buttons.
    this.greeting = null;
    if (titleTextId !== 0) {
      this.queryNpcText(titleTextId);
    }
    this.emit('gossipShow');
  }

  /** `SMSG_GOSSIP_COMPLETE` (**0x17E**): an EMPTY body. The server is done talking. */
  private handleComplete(): void {
    this.close();
  }

  /**
   * `SMSG_NPC_TEXT_UPDATE` (**0x180**) -- the greeting behind a `titleTextId`.
   *
   *     u32 textId
   *     8 x { f32 probability · cstr maleText · cstr femaleText · u32 language
   *           · 3 x { u32 delay · u32 emote } }
   *
   * EIGHT blocks always, padded with empties -- `NpcText.dbc` has eight text slots and the server
   * writes all of them (`NPCHandler.cpp`'s `HandleNpcTextQueryOpcode`). This is the packet where
   * `readCStr` earns its keep hardest: fourteen of the sixteen strings are typically empty, so
   * `readCString` would land fourteen bytes short and the last block's emotes would read as garbage.
   *
   * WHICH block is shown: the first with a nonzero probability, which is what the real client picks
   * when it has no reason to weight them. The gendered pair collapses to whichever is non-empty --
   * this client does not read the player's own gender here, and the two are identical for all but a
   * handful of texts.
   */
  private handleNpcText(gp: GamePacket): void {
    const textId = gp.readUnsignedInt() >>> 0;
    let chosen: string | null = null;
    for (let i = 0; i < 8; ++i) {
      const probability = gp.readFloat();
      const male = gp.readCStr();
      const female = gp.readCStr();
      gp.readUnsignedInt(); // language -- read for the frame, not kept
      for (let e = 0; e < 3; ++e) {
        gp.readUnsignedInt(); // emote delay
        gp.readUnsignedInt(); // emote id
      }
      const text = male !== '' ? male : female;
      if (chosen === null && probability > 0 && text !== '') {
        chosen = text;
      }
    }
    if (textId !== this.titleTextId) {
      // A late answer for the PREVIOUS npc. Dropping it is the same guid/id match
      // `LootHandler#handleReleaseResponse` makes, and for the same reason.
      return;
    }
    this.greeting = chosen;
    this.emit('gossipTextChanged');
  }

  // -- Outgoing -----------------------------------------------------------------------------------

  /** `CMSG_GOSSIP_HELLO` (**0x17B**): one FULL 8-byte guid. The door to every NPC service. */
  hello(guid: string): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_GOSSIP_HELLO, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES,
    );
    gp.write(Array.from(guidBytes(guid)));
    this.game.send(gp);
  }

  /**
   * `CMSG_GOSSIP_SELECT_OPTION` (**0x17C**): `u64 guid · u32 menuId · u32 optionIndex · [cstr code]`.
   *
   * **THE MENU ID IS FIRST AND IT IS NOT OPTIONAL.** `HandleGossipSelectOptionOpcode` reads
   * `guid >> menuId >> gossipListId`, and a client that sends only the index puts the index where the
   * menu id belongs and gets silence. The code string is written ONLY for a coded option -- the server
   * reads it conditionally on the packet's remaining size.
   */
  selectOption(index: number, code?: string): void {
    const guid = this.source;
    if (guid === null) {
      return;
    }
    const codeBytes = code === undefined || code === ''
      ? []
      : [...Array.from(code, (c) => c.charCodeAt(0) & 0xff), 0];
    const gp = new GamePacket(
      GameOpcode.CMSG_GOSSIP_SELECT_OPTION,
      GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 8 + codeBytes.length,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(this.menuId >>> 0);
    gp.writeUnsignedInt(index >>> 0);
    if (codeBytes.length > 0) {
      gp.write(codeBytes);
    }
    this.game.send(gp);
  }

  /** `CMSG_NPC_TEXT_QUERY` (**0x17F**): `u32 textId · u64 guid`. */
  private queryNpcText(textId: number): void {
    const guid = this.source;
    const gp = new GamePacket(
      GameOpcode.CMSG_NPC_TEXT_QUERY, GamePacket.HEADER_SIZE_OUTGOING + 4 + GUID_BYTES,
    );
    gp.writeUnsignedInt(textId >>> 0);
    gp.write(Array.from(guidBytes(guid ?? '0x0')));
    this.game.send(gp);
  }

  /**
   * Drop the menu.
   *
   * NOTE that there is no `CMSG_GOSSIP_CLOSE` in 3.3.5a: closing the window is purely client side, and
   * the server drops its own menu state when the player walks away or opens something else. That is
   * why `CloseGossip` in the bridge calls this and sends nothing -- unlike `CloseLoot`, which must
   * send `CMSG_LOOT_RELEASE`.
   */
  close(): void {
    if (this.source === null) {
      return;
    }
    this.source = null;
    this.menuId = 0;
    this.titleTextId = 0;
    this.greeting = null;
    this.options = [];
    this.availableQuests = [];
    this.activeQuests = [];
    this.emit('gossipClosed');
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

export default GossipHandler;
