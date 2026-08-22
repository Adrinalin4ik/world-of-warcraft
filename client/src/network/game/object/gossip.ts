/**
 * TALKING TO AN NPC -- the gossip menu, its options, and selecting one.
 *
 * This is the DOOR the merchant window comes through. `GossipFrame.xml`/`.lua` are already in
 * `FrameXML.toc` and already load; nothing here draws. This file is the wire half and
 * `game/ui/gossip-bridge.ts` is the engine-global half.
 *
 * ## Why gossip exists at all in a merchant round
 *
 * Right-clicking a friendly service NPC opens EITHER the gossip menu or the service directly, and
 * which one is decided CLIENT-side by the NPC's service flags. The reference states the rule and this
 * client ports it: "a vendor-only NPC opens the vendor list directly (`CMSG_LIST_INVENTORY`); any
 * other service NPC -- gossip, and the out-of-scope banker/trainer/innkeeper/flightmaster -- opens via
 * the universal `CMSG_GOSSIP_HELLO`" (`benilla/src/target/click.rs:124-139`, and its
 * `interact_command` at `:628-647` is the dispatch, keyed off the already-classified cursor kind).
 * `pages/game/index.tsx` dispatches off the same `classifyUnitCursor` result the hover cursor uses.
 *
 * **AND HERE THE REFERENCE'S REASON IS 1.12's, WHILE 3.3.5a's IS STRICTER -- which makes the direct
 * branch load-bearing rather than an optimisation.** `click.rs:622-624` says the hello "works on any
 * interactable creature (verified: the server passes `UNIT_NPC_FLAG_NONE`)". That is vmangos.
 * TrinityCore 3.3.5's `HandleGossipHelloOpcode` passes **`UNIT_NPC_FLAG_GOSSIP`**
 * (`Handlers/NPCHandler.cpp:150`) and returns silently when the creature does not carry bit 0x1. So on
 * 3.3.5a a hello at a pure vendor is answered with NOTHING, and routing every service through the
 * hello -- which is what a straight port of the reference's stated reason would suggest is safe --
 * would leave the plainest vendors in the game unopenable with no error anywhere.
 *
 * Once past that gate the server may still shortcut: `SendPreparedGossip` sends the single service's
 * own packet when a creature has one service option and no gossip text, which is how a
 * gossip-flagged vendor still reaches `SMSG_LIST_INVENTORY` in one round trip. So BOTH paths end in
 * the same place and both must work.
 *
 * The reference also records what a hello at an NPC with nothing to say cost it: "the server answered
 * with eight literal `Greetings $N` blocks" (`benilla/src/target/cursor_mode.rs:399-420`, quoted in
 * `task-9-report.md`). That is why the send is gated on the service ladder
 * `game/world/cursor-mode.ts` already decodes rather than fired at anything friendly.
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
import { DIALOG_STATUS } from './quest';

/** One row of the gossip menu's option list. */
/**
 * An active (held) gossip quest row, from the wire icon alone.
 *
 * **MECHANISM FROM THE REFERENCE, NUMBERS FROM 3.3.5a**, and the two genuinely differ here. The
 * reference verified the split at the bytes as `icon == 3 || icon == 4` -> ACTIVE, every other `u32`
 * -> AVAILABLE, a flat two-way test with no range and no third arm
 * (`benilla-app/src/ui_quest.rs#row_is_active`, split at `0x5dbbfe-0x5dbc08`; the gossip packet's rows
 * use the identical test at `0x4e2430`/`0x4e2580`). Its 3 and 4 are 1.12's `DIALOG_STATUS_INCOMPLETE`
 * and `DIALOG_STATUS_REWARD_REP` -- and WotLK INSERTED the three `LOW_LEVEL_*` values ahead of them, so
 * the same two names are **5 and 6** here (see `DIALOG_STATUS` in `quest.ts`). Taking the reference's
 * literal 3 and 4 would test LOW_LEVEL_REWARD_REP and LOW_LEVEL_AVAILABLE_REP instead -- the exact
 * class of defect this repo's rules single out.
 *
 * `LOW_LEVEL_REWARD_REP` is included as a third value on its NAME: it is `REWARD_REP` for a quest below
 * the player's level, so the player holds it and it is handed in the same way. Said plainly because it
 * is a name-based inference and not a byte the reference could verify -- 1.12 has no such value. The
 * cost of getting it wrong is one-directional: excluded, a low-level turn-in becomes un-handable, which
 * is precisely the failure this whole predicate exists to prevent.
 *
 * **THE QUEST LOG IS NOT CONSULTED, deliberately.** The reference tried that and reversed it: an
 * auto-complete quest is never in the log -- that is what auto-complete means -- yet the server marks
 * it REWARD_REP so the client asks for the reward. Deriving the pool from log membership made every
 * such quest permanently un-turn-in-able and drew its empty detail as a blank window (its ledger B95,
 * decision 0758).
 */
export function rowIsActive(icon: number): boolean {
  return icon === DIALOG_STATUS.INCOMPLETE
    || icon === DIALOG_STATUS.REWARD_REP
    || icon === DIALOG_STATUS.LOW_LEVEL_REWARD_REP;
}

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
    const active: GossipQuest[] = [];
    for (let i = 0; i < questCount; ++i) {
      const questId = gp.readUnsignedInt() >>> 0;
      const icon = gp.readUnsignedInt() >>> 0;
      // SIGNED: a quest whose level is -1 means "scales to the player", and reading it unsigned would
      // print 4294967295 into the button label through `NORMAL_QUEST_DISPLAY`.
      const level = gp.readInt();
      const flags = gp.readUnsignedInt() >>> 0;
      const marker = gp.readUnsignedByte() !== 0;
      const title = gp.readCStr();
      (rowIsActive(icon) ? active : available).push({ questId, icon, level, flags, marker, title });
    }

    this.source = guid;
    this.menuId = menuId;
    this.titleTextId = titleTextId;
    this.options = options;
    /**
     * ONE ARRAY ON THE WIRE, SPLIT BY THE ICON -- and the paragraph that stood here said the opposite.
     *
     * It claimed "3.3.5a's gossip message carries only the available ones (active quests reach the
     * client through `SMSG_QUESTGIVER_QUEST_LIST`)" and that an empty `activeQuests` was therefore
     * correct rather than a gap. The owner's screenshot disproved it in one frame: a quest already in
     * his log, complete, listed in Marshal McBride's gossip window under a yellow `!`. The server does
     * put held quests in this array.
     *
     * What that cost was not cosmetic. `GossipFrame` sends a DIFFERENT opcode per pool -- an available
     * row asks for the offer, an active row asks for the reward -- so with every row landing in
     * "available" the quest could not be handed in at all. Owner: "сдать кстати тоже не получается".
     *
     * See `rowIsActive` for the predicate and for why the quest LOG must never be consulted here.
     */
    this.availableQuests = available;
    this.activeQuests = active;
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
   * WHICH block is shown: **the first with any TEXT**, preferring one that also carries a nonzero
   * probability. The gendered pair collapses to whichever half is non-empty -- this client does not
   * read the player's own gender here, and the two are identical for all but a handful of texts.
   *
   * **The probability was a HARD filter and it is now only a preference, because measurement could not
   * clear it.** Live at a Northshire questgiver the packet decoded with residual **0** and yet the
   * greeting came out null: `titleTextId 50016`, every block rejected. Two explanations fit and this
   * client cannot separate them -- the server may send no text at all for that row (a private server
   * with an empty `npc_text` table), or it may send the text with `Probability` left at 0, which the
   * old rule discarded. Ranking rather than filtering is correct under EITHER, and cannot be worse
   * than discarding a populated block: if every block really is empty the answer is still null, which
   * is what `GetGossipText` reports and what leaves the greeting blank rather than inventing one.
   *
   * So the greeting being empty at that NPC is NOT yet explained, and this is not a claim that it is
   * fixed -- it removes the one explanation that was ours. Stated rather than presented as a fix.
   */
  private handleNpcText(gp: GamePacket): void {
    const textId = gp.readUnsignedInt() >>> 0;
    // Two candidates, ranked: the first block that has text AND a probability, and the first that
    // merely has text. See the doc comment on why the probability is a preference and not a filter.
    let weighted: string | null = null;
    let anyText: string | null = null;
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
      if (text === '') {
        continue;
      }
      if (anyText === null) {
        anyText = text;
      }
      if (weighted === null && probability > 0) {
        weighted = text;
      }
    }
    const chosen = weighted ?? anyText;
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
