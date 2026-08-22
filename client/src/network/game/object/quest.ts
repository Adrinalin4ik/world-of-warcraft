/**
 * QUESTS -- reading one at a giver, accepting it, turning it in, choosing a reward, and abandoning.
 *
 * Nothing here draws. `QuestFrame.xml`/`.lua`, `QuestInfo.xml`/`.lua`, `QuestLogFrame.xml`/`.lua` and
 * `StaticPopup`'s `ABANDON_QUEST` are all in `FrameXML.toc` and already load; this file is the wire
 * half and `game/ui/quest-bridge.ts` is the engine-global half. The door is `object/gossip.ts`, whose
 * quest rows call `SelectGossipAvailableQuest` -- until now a declared gap, because "the
 * SMSG_QUESTGIVER_* family has no subscriber, so there is nowhere to show the quest this would ask
 * for" (`gossip-bridge.ts:231`). This is that subscriber.
 *
 * ## WHERE THE QUEST LOG'S STATE LIVES -- established, not assumed
 *
 * Split, and the split is the single most load-bearing fact in this file:
 *
 *  - **Membership and progress are DESCRIPTOR WORDS.** `PLAYER_QUEST_LOG_1_1`, 25 slots of 5 words:
 *    `update-object/quest-log.ts`. Which quests you have, whether each is complete or failed, the four
 *    objective counters, and a timed quest's expiry. Accepting and abandoning are both confirmed
 *    there and nowhere else -- there is no `SMSG` acknowledgement for either.
 *  - **Text and rewards are the quest TEMPLATE**, fetched with `CMSG_QUEST_QUERY` (**0x05C**) ->
 *    `SMSG_QUEST_QUERY_RESPONSE` (**0x05D**) and cached here. Title, description, objective text, the
 *    four objective quads, the reward and choice arrays.
 *
 * So the quest log frame reads both halves, and a quest can be IN the log with its template still in
 * flight. Every template-backed global answers **nil** in that window rather than a placeholder --
 * see the `0` trap below.
 *
 * The four questgiver panels are a THIRD source and are self-contained: `SMSG_QUESTGIVER_QUEST_DETAILS`
 * carries its own title/details/objectives and its own reward list, so the accept panel needs no
 * template at all. `QuestInfoFrame.questLog` is the flag the client's own `QuestInfo_Display` sets to
 * choose between the two families (`questinfo.lua:41`, and every `if ( QuestInfoFrame.questLog )` after
 * it), which is why the bridge has two parallel sets of globals rather than one.
 *
 * ## THE LAYOUTS COME FROM A SERVER IMPLEMENTATION, AND THE RESIDUAL IS THEIR ONLY ORACLE
 *
 * Same class of source and same caveat as `items.ts`, `loot.ts`, `merchant.ts` and `gossip.ts`:
 * nothing in the game's own data states a packet body, so these come from **TrinityCore 3.3.5**
 * (`Entities/Player/PlayerQuest.cpp`, `Handlers/QuestHandler.cpp`, `Entities/Quest/QuestDef.cpp`).
 * Every arm records `consumed` against `bodySize` in `window.itemWire`; a nonzero residual on a real
 * packet means the layout is wrong.
 *
 * **The 1.12 reference is a good map of the SHAPE and wrong about the numbers, and the deltas are
 * numerous enough to be listed.** `benilla-protocol/src/messages/quest/{giver,log}.rs` is the 1.12
 * transcription and it is what these arms are structured after; WotLK then added, to
 * `SMSG_QUESTGIVER_QUEST_DETAILS` alone: a second guid (the quest sharer), `questFlags`,
 * `suggestedPlayers`, an `isFinished` byte, a reward-XP word, honor and its multiplier, a cast-spell
 * word, a char-title word, bonus talents, arena points and three five-long reputation arrays -- and it
 * narrowed `activateAccept` from a `u32` to a `u8`. Reading the 1.12 shape against a 3.3.5a packet
 * desyncs before the title. This is the same class of trap the merchant round measured four times over
 * (an 8-word vendor row, a `u32` sell count, repair's trailing byte, buyback base 74).
 *
 * **AND THIS IS STATED PLAINLY: the tails are UNVERIFIED.** No 3.3.5a quest packet has been decoded
 * live yet -- the account that holds the test characters was reporting zero characters when this was
 * written, so the residual could not be taken. Two defences are built in rather than promised:
 *
 *  1. **Prefix-strict, tail-tolerant.** Every arm reads the fields the client's own Lua actually
 *     consumes -- guid, quest id, the strings, the reward blocks, money, xp -- as a fixed sequence, and
 *     then reads the remaining scalars ONE AT A TIME behind a `remaining()` guard. A wrong tail costs an
 *     honor number or an arena-point number; it cannot cost the title, the description or the reward
 *     items, which is what a straight fixed-layout read would have done.
 *  2. **Two widths that the FRAME itself decides.** `SMSG_QUESTGIVER_STATUS` and
 *     `SMSG_QUESTGIVER_STATUS_MULTIPLE` are the one place a version delta is genuinely ambiguous (1.12
 *     writes the dialog status as a `u32`, 3.3.5 as a `u8`), so the width is DERIVED from the body size
 *     rather than picked. See `handleStatus`.
 *
 * `itemWire` is the oracle either way, and `window.questWire` is not a second instrument: these rows
 * land in the same census as the item, loot, vendor and gossip rows so one call answers the whole
 * "what did the wire really say" question.
 *
 * ## `readCStr`, NEVER `readCString`
 *
 * `byte-buffer`'s own reader does not consume an EMPTY string's terminator
 * (`network/net/packet.js#readCStr`). Quest packets are the worst case in the protocol for this:
 * `SMSG_QUEST_QUERY_RESPONSE` carries NINE strings and four of them (`endText`, `completedText` and up
 * to four objective texts) are empty on the overwhelming majority of quests, so a `readCString` here
 * would land up to six bytes short and every objective quad after the strings would read as garbage.
 */
import EventEmitter from 'events';

import { GameHandler } from '../handler';
import GamePacket from '../packet';
import GameOpcode from '../opcode';
import { guidBytes, guidHex, GUID_BYTES } from '../../guid-hex';
import { itemWire } from '../../../game/classes/item-wire';

/** `QUEST_OBJECTIVES_COUNT` -- the fixed objective-quad count, 3.3.5a. */
export const QUEST_OBJECTIVES_COUNT = 4;
/** `QUEST_ITEM_OBJECTIVES_COUNT` -- the fixed required-item slot count. SIX in 3.3.5a, and it is a
 * SEPARATE array from the objective quads; 1.12 packs four item requirements inside the quads
 * (`benilla-protocol/.../quest/log.rs:44-50`). */
export const QUEST_ITEM_OBJECTIVES_COUNT = 6;
/** `QUEST_REWARDS_COUNT` -- fixed `{itemId, count}` reward slots on the query response. */
export const QUEST_REWARDS_COUNT = 4;
/** `QUEST_REWARD_CHOICES_COUNT` -- fixed `{itemId, count}` choice slots on the query response. */
export const QUEST_REWARD_CHOICES_COUNT = 6;
/** `QUEST_REPUTATIONS_COUNT` -- the three five-long reputation arrays WotLK added. */
export const QUEST_REPUTATIONS_COUNT = 5;
/** `QUEST_EMOTE_COUNT` -- the detail panel always writes this many emote pairs. */
export const QUEST_EMOTE_COUNT = 4;

/**
 * `MAX_REQUIRED_ITEMS` -- the client's own constant, `questframe.lua:3`, and the alignment check on
 * `SMSG_QUESTGIVER_REQUEST_ITEMS`. Six buttons exist; a count above six cannot be real.
 */
export const MAX_REQUIRED_ITEMS = 6;

/**
 * `DIALOG_STATUS_*` -- what `SMSG_QUESTGIVER_STATUS` carries per NPC, and what decides the `!` or `?`
 * over a giver's head. A SERVER-side definition (`QuestDef.h`), labelled as such, and the same ladder
 * benilla records for 1.12 (`quest/giver.rs:32-42`) with WotLK's two additions at the top.
 */
export const DIALOG_STATUS = {
  NONE: 0,
  UNAVAILABLE: 1,
  LOW_LEVEL_AVAILABLE: 2,
  LOW_LEVEL_REWARD_REP: 3,
  LOW_LEVEL_AVAILABLE_REP: 4,
  INCOMPLETE: 5,
  REWARD_REP: 6,
  AVAILABLE_REP: 7,
  AVAILABLE: 8,
  REWARD2: 9,
  REWARD: 10,
} as const;

/** `QUEST_FLAGS_*`. Server-side (`QuestDef.h`), labelled as such, as in `gossip-bridge.ts`. */
export const QUEST_FLAGS = {
  /** The quest is a PvP quest -- `QuestFlagsPVP()`, which gates `CONFIRM_ACCEPT_PVP_QUEST`. */
  PVP: 0x0080,
  DAILY: 0x1000,
  WEEKLY: 0x8000,
} as const;

/** A `{itemId, count, displayId}` triple -- the shape the three giver panels share. */
export interface QuestItemTriple {
  itemId: number;
  count: number;
  displayId: number;
}

/** One `{itemId, count}` pair -- the query response's arrays, which carry NO display id. */
export interface QuestItemPair {
  itemId: number;
  count: number;
}

/** One objective quad of the query response, plus its trailing text. */
export interface QuestObjective {
  /**
   * RAW. A positive value is a creature entry; a gameobject objective is written `(-id)|0x80000000`,
   * and the wire does not disambiguate beyond the top bit. Kept raw exactly as benilla keeps it
   * (`quest/log.rs:36-42`); the bridge does not need to resolve it because the objective TEXT is what
   * `GetQuestLogLeaderBoard` answers.
   */
  creatureOrGo: number;
  requiredCount: number;
  sourceItemId: number;
  sourceItemCount: number;
  text: string;
}

/** The full quest template -- `SMSG_QUEST_QUERY_RESPONSE`. */
export interface QuestTemplate {
  questId: number;
  method: number;
  level: number;
  minLevel: number;
  zoneOrSort: number;
  type: number;
  suggestedPlayers: number;
  nextQuestInChain: number;
  money: number;
  moneyMaxLevel: number;
  rewardSpell: number;
  rewardSpellCast: number;
  srcItemId: number;
  flags: number;
  charTitleId: number;
  bonusTalents: number;
  arenaPoints: number;
  rewards: QuestItemPair[];
  choices: QuestItemPair[];
  /** `RewardFactionId[5]` / `RewardFactionValueIdOverride[5]`, paired. */
  reputations: Array<{ factionId: number; value: number }>;
  title: string;
  /** The one-line objectives summary. `QuestInfo_ShowObjectivesText`'s second return. */
  objectivesText: string;
  details: string;
  endText: string;
  completedText: string;
  objectives: QuestObjective[];
  requiredItems: QuestItemPair[];
  /** True when the whole body was consumed. False means the layout is wrong for this build. */
  exact: boolean;
}

/** `SMSG_QUESTGIVER_QUEST_DETAILS` -- the accept panel. */
export interface QuestGiverDetails {
  npc: string;
  questId: number;
  title: string;
  details: string;
  objectives: string;
  activateAccept: boolean;
  flags: number;
  suggestedPlayers: number;
  choices: QuestItemTriple[];
  rewards: QuestItemTriple[];
  money: number;
  xp: number;
  honor: number;
  rewardSpell: number;
  charTitleId: number;
  bonusTalents: number;
  arenaPoints: number;
}

/** `SMSG_QUESTGIVER_OFFER_REWARD` -- the reward panel. */
export interface QuestGiverOfferReward {
  npc: string;
  questId: number;
  title: string;
  offerText: string;
  activateAccept: boolean;
  flags: number;
  suggestedPlayers: number;
  choices: QuestItemTriple[];
  rewards: QuestItemTriple[];
  money: number;
  xp: number;
  honor: number;
  rewardSpell: number;
  charTitleId: number;
  bonusTalents: number;
  arenaPoints: number;
}

/** `SMSG_QUESTGIVER_REQUEST_ITEMS` -- the progress panel. */
export interface QuestGiverRequestItems {
  npc: string;
  questId: number;
  title: string;
  requestText: string;
  requiredMoney: number;
  requiredItems: QuestItemTriple[];
  /** From the second of the trailing flag words -- the only completability signal on this wire. */
  isComplete: boolean;
}

/** One row of `SMSG_QUESTGIVER_QUEST_LIST` -- the multi-quest greeting panel. */
export interface QuestGiverListEntry {
  questId: number;
  /** A `DIALOG_STATUS` value. `u32` here, unlike the gossip option's `u8` icon. */
  icon: number;
  level: number;
  title: string;
}

/** `SMSG_QUESTGIVER_QUEST_LIST`. */
export interface QuestGiverList {
  npc: string;
  greeting: string;
  quests: QuestGiverListEntry[];
}

export class QuestHandler extends EventEmitter {
  private game: GameHandler;

  /** The giver whose panel is open, or null. Every outgoing questgiver packet needs it. */
  public source: string | null = null;

  /** The open accept panel, or null. */
  public details: QuestGiverDetails | null = null;

  /** The open reward panel, or null. */
  public offer: QuestGiverOfferReward | null = null;

  /** The open progress panel, or null. */
  public progress: QuestGiverRequestItems | null = null;

  /** The open multi-quest greeting, or null. */
  public greeting: QuestGiverList | null = null;

  /** questId -> template, once the query has answered. */
  public templates = new Map<number, QuestTemplate>();

  /**
   * questId -> its TITLE, seeded by any giver panel that carried one.
   *
   * **This exists because the owner's log counted 1 and listed nothing.** The list is built from the
   * template cache, so a quest whose `CMSG_QUEST_QUERY` has not answered yet -- or whose answer was
   * lost -- was counted by the descriptor and omitted from the entry list, which the quest log renders
   * as "No Active Quests" beside a header reading "Quests: 1/25". The accept panel already carried the
   * title, so the log can name a freshly accepted quest with no round trip at all.
   *
   * A title is enough to LIST a quest; the description and the objectives still need the template, and
   * a row with no detail is honest (it says which quest you have) where an absent row is not.
   */
  public titles = new Map<number, string>();

  /** Quest ids whose query is in flight, so the same quest is asked for once. */
  private queried = new Set<number>();

  /**
   * Quest ids we have just ASKED a giver about -- the oracle that picks between the two candidate
   * prefixes of `SMSG_QUESTGIVER_QUEST_DETAILS`. See `handleDetails`.
   *
   * A set rather than one value because the client can send several before any answer arrives (a
   * greeting panel with four rows, clicked quickly). Entries are removed when matched, and the set is
   * cleared on a world change with everything else.
   */
  private awaiting = new Set<number>();

  /**
   * Which candidate prefix the last accept panel decoded under. THE instrument for the sharer-guid
   * question: the answer is a fact about this server and it should be readable rather than
   * re-derived by the next person.
   */
  public detailsShape = '';

  /** Which candidate `activateAccept` width the last reward panel decoded under. See `handleOfferReward`. */
  public offerShape = '';

  /** NPC guid -> `DIALOG_STATUS`. What the `!` over a giver's head is drawn from. */
  public status = new Map<string, number>();

  constructor(gameHandler: GameHandler) {
    super();
    // `this.game` FIRST -- `subscribe` reads it. Same order as `MerchantHandler`'s constructor.
    this.game = gameHandler;

    this.subscribe('SMSG_QUEST_QUERY_RESPONSE', this.handleQueryResponse);
    this.subscribe('SMSG_QUESTGIVER_QUEST_DETAILS', this.handleDetails);
    this.subscribe('SMSG_QUESTGIVER_OFFER_REWARD', this.handleOfferReward);
    this.subscribe('SMSG_QUESTGIVER_REQUEST_ITEMS', this.handleRequestItems);
    this.subscribe('SMSG_QUESTGIVER_QUEST_LIST', this.handleQuestList);
    this.subscribe('SMSG_QUESTGIVER_QUEST_COMPLETE', this.handleQuestComplete);
    this.subscribe('SMSG_QUESTGIVER_QUEST_INVALID', this.handleQuestInvalid);
    this.subscribe('SMSG_QUESTGIVER_QUEST_FAILED', this.handleQuestFailed);
    this.subscribe('SMSG_QUESTUPDATE_COMPLETE', this.handleUpdateComplete);
    this.subscribe('SMSG_QUESTUPDATE_ADD_KILL', this.handleAddKill);
    this.subscribe('SMSG_QUESTUPDATE_FAILED', this.handleUpdateFailed);
    this.subscribe('SMSG_QUESTUPDATE_FAILEDTIMER', this.handleUpdateFailed);
    this.subscribe('SMSG_QUESTLOG_FULL', this.handleLogFull);
    this.subscribe('SMSG_QUEST_FORCE_REMOVED', this.handleForceRemoved);
    this.subscribe('SMSG_QUESTGIVER_STATUS', this.handleStatus);
    this.subscribe('SMSG_QUESTGIVER_STATUS_MULTIPLE', this.handleStatusMultiple);
    // **THE SERVER ENDING THE CONVERSATION CLOSES THE QUEST PANEL TOO, and nothing was doing that.**
    //
    // The owner: accepting a quest leaves the window open. `QuestFrame_OnEvent` hides the frame on
    // `QUEST_FINISHED` (`questframe.lua:18-21`), which this handler fires from `closePanels` -- and
    // `closePanels` was reached only from `CloseQuest` and a world change. The reply to an accept is
    // `SMSG_GOSSIP_COMPLETE`: the server is saying the whole conversation is over, so the giver panel
    // has to go with the gossip menu.
    //
    // A SECOND subscriber on that opcode, beside `GossipHandler`'s own. Both are correct and neither
    // needs to know about the other -- an `EventEmitter` fans out, and the gossip file stays owned by
    // the merchant path.
    this.subscribe('SMSG_GOSSIP_COMPLETE', this.handleGossipComplete);

    // An open panel belongs to the session that opened it -- the same reasoning `LootHandler`,
    // `MerchantHandler` and `GossipHandler` state for their own `SMSG_LOGIN_VERIFY_WORLD` hooks. A
    // stale giver guid would aim the next character's `CMSG_QUESTGIVER_ACCEPT_QUEST` at an NPC in a
    // world he is not in. The template cache goes too: quest text is per-locale, not per-character,
    // but the `!` statuses are per-world and holding them would draw a bang over an empty patch of
    // grass.
    this.game.on('packet:receive:SMSG_LOGIN_VERIFY_WORLD', () => {
      this.closePanels();
      this.status.clear();
      this.awaiting.clear();
    });
  }

  /**
   * One arm with the over-read catch, exactly as `merchant.ts#subscribe` does it and for the same
   * reason: `byte-buffer` THROWS past the frame, and an uncaught throw escapes
   * `GameHandler#dataReceived`'s receive loop and takes every packet still buffered in that data event.
   */
  private subscribe(name: string, arm: (gp: GamePacket) => void): void {
    this.game.on(`packet:receive:${name}`, (gp: GamePacket) => {
      const bodySize = gp.bodySize;
      try {
        arm.call(this, gp);
        itemWire.record({
          at: performance.now(),
          opcode: name,
          entry: this.lastQuestId,
          name: this.lastTitle,
          bodySize,
          consumed: gp.index - gp.headerSize,
        });
      } catch (e) {
        itemWire.record({
          at: performance.now(),
          opcode: `${name}!THREW`,
          entry: this.lastQuestId,
          name: this.lastTitle,
          bodySize,
          consumed: gp.index - gp.headerSize,
        });
        console.warn(
          `quest: ${name} did not decode -- ${(e as Error).message}. These layouts come from a`
          + ' SERVER implementation (see the header of network/game/object/quest.ts) and are'
          + ' validated rather than trusted. Read window.itemWire.census().',
        );
      }
    });
  }

  /** For the instrument only: what the arm that just ran was about. */
  private announcedStatusQuery = false;

  private announcedStatusReply = false;

  private announcedOfferTail = false;

  private lastQuestId = 0;

  private lastTitle = '';

  // -- Incoming -----------------------------------------------------------------------------------

  /**
   * `SMSG_QUEST_QUERY_RESPONSE` (**0x05D**) -- the full quest template. THE quest log's text source.
   *
   *     u32 questId · u32 method · i32 level · u32 minLevel · i32 zoneOrSort · u32 type
   *     u32 suggestedPlayers
   *     u32 repObjectiveFaction · u32 repObjectiveValue · u32 repObjectiveFaction2 · u32 repObjectiveValue2
   *     u32 nextQuestInChain · u32 xpId · i32 rewOrReqMoney · u32 rewMoneyMaxLevel
   *     u32 rewSpell · i32 rewSpellCast · u32 rewHonorAddition · f32 rewHonorMultiplier
   *     u32 srcItemId · u32 flags · u32 charTitleId · u32 playersSlain · u32 bonusTalents
   *     u32 rewArenaPoints · u32 unk
   *     4 x { u32 rewItemId · u32 rewItemCount }
   *     6 x { u32 rewChoiceItemId · u32 rewChoiceItemCount }
   *     5 x u32 rewFactionId · 5 x i32 rewFactionValueId · 5 x i32 rewFactionValueIdOverride
   *     u32 poiContinent · f32 poiX · f32 poiY · u32 poiOpt
   *     cstr title · cstr objectives · cstr details · cstr endText · cstr completedText
   *     4 x { u32 reqNpcOrGo · u32 reqNpcOrGoCount · u32 reqSourceItemId · u32 reqSourceItemCount }
   *     6 x { u32 reqItemId · u32 reqItemCount }
   *     4 x cstr objectiveText
   *
   * **THE STRING ORDER IS `title, objectives, details, endText, completedText`** -- objectives BEFORE
   * details, which is reversed from the accept panel's `title, details, objectives`. benilla records
   * the same reversal for 1.12 (`quest/log.rs:9-11`); getting it backwards puts the description into
   * the objectives line and vice versa, and both are non-empty, so it would look plausible.
   *
   * **The four objective TEXTS trail the whole packet**, after both fixed arrays, not interleaved with
   * the quads. Also benilla's note, and also unchanged in 3.3.5a.
   *
   * The two WotLK changes to watch: `minLevel` and `xpId` in the numeric prefix (a 1.12 read would put
   * the strings eight bytes early), and `completedText` -- a FIFTH string, empty on nearly every quest,
   * which is precisely the case `readCString` mis-handles.
   *
   * `exact` records whether the body was consumed exactly. A template that is not exact is still
   * stored, because the strings are what the log needs and they are recoverable even when the trailing
   * arrays are not -- but the bridge can see the flag and the instrument records the residual.
   */
  private handleQueryResponse(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    // **RELEASED WHATEVER HAPPENS BELOW.** `queryTemplate` dedupes on `queried`, so an arm that threw
    // half-way used to leave the id in it for ever -- one bad decode and that quest could never be
    // asked for again, which the quest log renders as a permanently missing row. The `finally` makes a
    // failure retryable on the next descriptor edge instead of terminal.
    try {
      this.decodeTemplate(gp, questId);
    } finally {
      this.queried.delete(questId);
    }
  }

  private decodeTemplate(gp: GamePacket, questId: number): void {
    const method = gp.readUnsignedInt() >>> 0;
    // SIGNED: a quest level of -1 means "scales to the player", the same marker `gossip.ts` reads
    // signed for exactly this reason.
    const level = gp.readInt();
    const minLevel = gp.readUnsignedInt() >>> 0;
    const zoneOrSort = gp.readInt();
    const type = gp.readUnsignedInt() >>> 0;
    const suggestedPlayers = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // repObjectiveFaction
    gp.readUnsignedInt(); // repObjectiveValue
    gp.readUnsignedInt(); // repObjectiveFaction2 -- WotLK
    gp.readUnsignedInt(); // repObjectiveValue2 -- WotLK
    const nextQuestInChain = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // xpId -- WotLK; the XP is looked up client-side from QuestXP.dbc, not read
    const money = gp.readInt();
    const moneyMaxLevel = gp.readUnsignedInt() >>> 0;
    const rewardSpell = gp.readUnsignedInt() >>> 0;
    const rewardSpellCast = gp.readInt();
    gp.readUnsignedInt(); // rewHonorAddition -- WotLK
    gp.readFloat(); // rewHonorMultiplier -- WotLK
    const srcItemId = gp.readUnsignedInt() >>> 0;
    const flags = gp.readUnsignedInt() >>> 0;
    const charTitleId = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // playersSlain -- WotLK
    const bonusTalents = gp.readUnsignedInt() >>> 0;
    const arenaPoints = gp.readUnsignedInt() >>> 0;
    gp.readUnsignedInt(); // unk -- WotLK, always 0

    // FIXED-COUNT arrays, not count-prefixed, and carrying NO display ids. A hidden-rewards quest
    // zeroes the values and keeps the shape, so this reader is flag-blind.
    const rewards: QuestItemPair[] = [];
    for (let i = 0; i < QUEST_REWARDS_COUNT; ++i) {
      rewards.push({ itemId: gp.readUnsignedInt() >>> 0, count: gp.readUnsignedInt() >>> 0 });
    }
    const choices: QuestItemPair[] = [];
    for (let i = 0; i < QUEST_REWARD_CHOICES_COUNT; ++i) {
      choices.push({ itemId: gp.readUnsignedInt() >>> 0, count: gp.readUnsignedInt() >>> 0 });
    }

    const factionIds: number[] = [];
    for (let i = 0; i < QUEST_REPUTATIONS_COUNT; ++i) {
      factionIds.push(gp.readUnsignedInt() >>> 0);
    }
    for (let i = 0; i < QUEST_REPUTATIONS_COUNT; ++i) {
      gp.readInt(); // rewFactionValueId -- an index, superseded by the override below when nonzero
    }
    const factionValues: number[] = [];
    for (let i = 0; i < QUEST_REPUTATIONS_COUNT; ++i) {
      factionValues.push(gp.readInt());
    }

    gp.readUnsignedInt(); // poiContinent
    gp.readFloat(); // poiX
    gp.readFloat(); // poiY
    gp.readUnsignedInt(); // poiOpt

    const title = gp.readCStr();
    const objectivesText = gp.readCStr();
    const details = gp.readCStr();
    const endText = gp.readCStr();
    const completedText = gp.readCStr();
    this.lastTitle = title;

    const objectives: QuestObjective[] = [];
    for (let i = 0; i < QUEST_OBJECTIVES_COUNT; ++i) {
      objectives.push({
        creatureOrGo: gp.readUnsignedInt() >>> 0,
        requiredCount: gp.readUnsignedInt() >>> 0,
        sourceItemId: gp.readUnsignedInt() >>> 0,
        sourceItemCount: gp.readUnsignedInt() >>> 0,
        text: '',
      });
    }
    const requiredItems: QuestItemPair[] = [];
    for (let i = 0; i < QUEST_ITEM_OBJECTIVES_COUNT; ++i) {
      requiredItems.push({
        itemId: gp.readUnsignedInt() >>> 0,
        count: gp.readUnsignedInt() >>> 0,
      });
    }
    for (let i = 0; i < QUEST_OBJECTIVES_COUNT; ++i) {
      objectives[i].text = gp.readCStr();
    }

    const template: QuestTemplate = {
      questId,
      method,
      level,
      minLevel,
      zoneOrSort,
      type,
      suggestedPlayers,
      nextQuestInChain,
      money,
      moneyMaxLevel,
      rewardSpell,
      rewardSpellCast,
      srcItemId,
      flags,
      charTitleId,
      bonusTalents,
      arenaPoints,
      rewards,
      choices,
      reputations: factionIds.map((factionId, i) => ({ factionId, value: factionValues[i] })),
      title,
      objectivesText,
      details,
      endText,
      completedText,
      objectives,
      requiredItems,
      exact: gp.index - gp.headerSize === gp.bodySize,
    };
    if (!template.exact) {
      console.warn(
        `quest: SMSG_QUEST_QUERY_RESPONSE for ${questId} left a residual of`
        + ` ${gp.bodySize - (gp.index - gp.headerSize)} bytes -- the 3.3.5a layout in`
        + ' network/game/object/quest.ts is wrong for this server. Read window.itemWire.census().',
      );
    }
    this.templates.set(questId, template);
    if (template.title !== '') {
      this.titles.set(questId, template.title);
    }
    this.emit('questTemplate', template);
  }

  /**
   * `SMSG_QUESTGIVER_QUEST_DETAILS` (**0x188**) -- the accept panel. Fires `QUEST_DETAIL`.
   *
   *     u64 npcGuid · u64 sharerGuid · u32 questId
   *     cstr title · cstr details · cstr objectives
   *     u8 activateAccept · u32 flags · u32 suggestedPlayers · u8 isFinished
   *     u32 choiceCount · choiceCount x { u32 itemId · u32 count · u32 displayId }
   *     u32 rewardCount · rewardCount x { same triple }
   *     i32 money · u32 xp
   *     [tail] u32 honor · f32 honorMultiplier · u32 rewSpell · i32 rewSpellCast
   *            u32 charTitleId · u32 bonusTalents · u32 arenaPoints · u32 unk
   *            5 x u32 repFaction · 5 x i32 repValueId · 5 x i32 repValue
   *            u32 emoteCount · emoteCount x { u32 emote · u32 delay }
   *
   * **The SECOND guid is a WotLK addition** and it is the one that would break everything: it is the
   * player who shared the quest (`Player::GetDivider()`), zero for an NPC's own offer, and skipping it
   * puts the quest id eight bytes early and the title in the middle of it. 1.12 has one guid
   * (`benilla-protocol/.../quest/giver.rs:265-271`).
   *
   * **`activateAccept` is a `u8` here and a `u32` in 1.12, AND IT IS NOT `QuestGetAutoAccept`.**
   *
   * It was called `autoLaunched` and bound to that global, and that pair of mistakes is what made the
   * owner's Accept button do nothing and his Decline button vanish. TrinityCore 3.3.5 names this
   * parameter **`activateAccept`** (`PlayerMenu::SendQuestGiverQuestDetails(quest, guid,
   * activateAccept)`) and `HandleQuestgiverQueryQuestOpcode` passes **`true`** -- so on every quest a
   * player clicks at a giver, this byte is 1. It means "the Accept button is live", not "this quest was
   * accepted for you".
   *
   * The proof that the two cannot be the same is the real client's own behaviour: if
   * `QuestGetAutoAccept()` were this byte, the real client would hide Decline and make Accept a no-op
   * on every ordinary quest too (`questframe.lua:319-325,331-336`). It does neither. See
   * `ui/quest-bridge.ts#QuestGetAutoAccept` for what that global actually answers here.
   *
   * Kept and decoded because the width is still load-bearing for everything after it; the FRAMES just
   * do not read it. `QuestGetAutoAccept()` is what the client
   * reads it as, and it decides whether the Decline button is hidden (`questframe.lua:319-325`).
   *
   * Everything from `honor` on is the TOLERANT TAIL -- see the file header. The four strings, the two
   * reward blocks, the money and the XP are what `QuestInfo_ShowRewards` needs, and they are read as a
   * fixed sequence; a tail that disagrees with this build costs an honor or arena figure and nothing
   * the panel is built out of.
   */
  private handleDetails(gp: GamePacket): void {
    const base = gp.index;

    // TWO CANDIDATE PREFIXES, AND THE QUEST ID WE ASKED FOR PICKS BETWEEN THEM.
    //
    // **This exists because the owner got a BLANK accept panel and my residual could not see it.**
    // The tolerant tail reads only while four bytes remain, so a prefix that consumes EIGHT BYTES TOO
    // MANY simply leaves nothing for the tail and the residual comes out 0 -- the decode announces
    // success while the title, the description and the objectives are all read out of the middle of
    // some other field. That is an instrument my own fix had blinded, which is a named failure mode in
    // this project, and this is the correction.
    //
    // The sharer guid is the whole doubt. TrinityCore 3.3.5 writes `GetDivider()` as a second `u64`
    // and 1.12 writes one guid (`benilla-protocol/.../quest/giver.rs:265-271`); nothing available here
    // settles which this server does, and picking wrong is silent. So BOTH are decoded and the one
    // whose echoed quest id matches the id `CMSG_QUESTGIVER_QUERY_QUEST` just asked for wins.
    //
    // That is the same class of answer as the status width being derived from `bodySize`: a value the
    // FRAME decides rather than one this file asserts. It is stronger here, because the oracle is a
    // number we chose ourselves and the server echoed back -- a wrong prefix cannot match it by luck.
    const withSharer = this.tryDetails(gp, base, true);
    const withoutSharer = this.tryDetails(gp, base, false);
    const asked = (d: (QuestGiverDetails & { cursor: number }) | null): boolean =>
      d !== null && this.awaiting.has(d.questId);

    let chosen: (QuestGiverDetails & { cursor: number }) | null;
    let shape: string;
    if (asked(withSharer) && !asked(withoutSharer)) {
      chosen = withSharer;
      shape = 'two guids';
    } else if (asked(withoutSharer) && !asked(withSharer)) {
      chosen = withoutSharer;
      shape = 'ONE guid';
    } else if (withSharer !== null && withSharer.title !== '') {
      // Neither matched (an unsolicited offer -- a quest-starting item, an area trigger, a party
      // share) or both did (not possible in practice, the ids differ). Fall back to the documented
      // 3.3.5a shape, then sanity-check it: a real quest always has a title, so an EMPTY one means the
      // prefix is wrong even with no id to compare against.
      chosen = withSharer;
      shape = 'two guids (unsolicited)';
    } else if (withoutSharer !== null && withoutSharer.title !== '') {
      chosen = withoutSharer;
      shape = 'ONE guid (unsolicited, chosen on a non-empty title)';
    } else {
      chosen = withSharer;
      shape = 'two guids (neither candidate produced a title)';
    }

    if (chosen === null) {
      throw new Error('SMSG_QUESTGIVER_QUEST_DETAILS: neither candidate prefix decoded');
    }
    this.lastQuestId = chosen.questId;
    this.lastTitle = chosen.title;
    this.detailsShape = shape;
    if (chosen.title === '') {
      // LOUD. A blank accept panel is what this looks like on screen, and it looked like a missing Lua
      // method for a whole round.
      console.warn(
        'quest: SMSG_QUESTGIVER_QUEST_DETAILS decoded an EMPTY title under both candidate prefixes'
        + ' (chose "' + shape + '", questId ' + chosen.questId + ', body ' + gp.bodySize + ').'
        + ' The accept panel will draw blank. Read window.itemWire.census().',
      );
    }
    // Leave the cursor where the CHOSEN decode left it, so `subscribe`'s residual is that decode's and
    // not the second candidate's.
    gp.index = chosen.cursor;
    this.awaiting.delete(chosen.questId);

    if (chosen.title !== '') {
      this.titles.set(chosen.questId, chosen.title);
    }
    this.source = chosen.npc;
    this.details = chosen;
    this.offer = null;
    this.progress = null;
    this.greeting = null;
    this.emit('questDetail', this.details);
  }

  /**
   * One candidate decode of `SMSG_QUESTGIVER_QUEST_DETAILS`, from `base`, with or without the WotLK
   * sharer guid. Returns null when it runs off the frame, which is itself evidence against the shape.
   *
   * See `handleDetails` for why there are two and what chooses between them. The layout is otherwise
   * the one this file's header documents:
   *
   *     u64 npcGuid | [u64 sharerGuid] | u32 questId
   *     cstr title | cstr details | cstr objectives
   *     u8 activateAccept | u32 flags | u32 suggestedPlayers | u8 isFinished
   *     u32 choiceCount | triples | u32 rewardCount | triples | i32 money | u32 xp
   *     [tolerant tail] honor | honorMultiplier | rewSpell | rewSpellCast | charTitleId
   *                     | bonusTalents | arenaPoints
   */
  private tryDetails(
    gp: GamePacket, base: number, sharerGuid: boolean,
  ): (QuestGiverDetails & { cursor: number }) | null {
    gp.index = base;
    try {
      const npc = this.readFullGuid(gp);
      if (sharerGuid) {
        this.readFullGuid(gp);
      }
      const questId = gp.readUnsignedInt() >>> 0;
      const title = gp.readCStr();
      const details = gp.readCStr();
      const objectives = gp.readCStr();
      const activateAccept = gp.readUnsignedByte() !== 0;
      const flags = gp.readUnsignedInt() >>> 0;
      const suggestedPlayers = gp.readUnsignedInt() >>> 0;
      gp.readUnsignedByte(); // isFinished -- sent and unused by the real client too
      const choices = this.readTripleBlock(gp);
      const rewards = this.readTripleBlock(gp);
      const money = gp.readInt();
      const xp = gp.readUnsignedInt() >>> 0;
      const honor = this.tailU32(gp);
      this.tailU32(gp); // honorMultiplier -- a float, read as a word for its width only
      const rewardSpell = this.tailU32(gp);
      this.tailU32(gp); // rewSpellCast
      const charTitleId = this.tailU32(gp);
      const bonusTalents = this.tailU32(gp);
      const arenaPoints = this.tailU32(gp);
      return {
        npc,
        questId,
        title,
        details,
        objectives,
        activateAccept,
        flags,
        suggestedPlayers,
        choices,
        rewards,
        money,
        xp,
        honor,
        rewardSpell,
        charTitleId,
        bonusTalents,
        arenaPoints,
        cursor: gp.index,
      };
    } catch (e) {
      // Ran off the frame. `readTripleBlock` is the usual place: a misaligned count word reads as a
      // huge number and its loop over-reads. That is EVIDENCE, not an error -- the other candidate is
      // very likely the right one.
      return null;
    }
  }

  /**
   * `SMSG_QUESTGIVER_OFFER_REWARD` (**0x18D**) -- the reward panel. Fires `QUEST_COMPLETE`.
   *
   *     u64 npcGuid · u32 questId · cstr title · cstr offerText
   *     u8 activateAccept · u32 flags · u32 suggestedPlayers
   *     u32 emoteCount · emoteCount x { u32 delay · u32 emote }
   *     u32 choiceCount · triples · u32 rewardCount · triples
   *     i32 money · u32 xp
   *     [tail] u32 charTitleId · u32 bonusTalents · u32 arenaPoints · u32 unk
   *            u32 rewSpell · i32 rewSpellCast · u32 honor · f32 honorMultiplier
   *
   * **The emote pairs are `{delay, emote}` here and `{emote, delay}` on the detail panel.** benilla
   * records the same reversal for 1.12 (`quest/giver.rs:14-15`); this arm consumes them for alignment
   * only, so the order costs nothing here -- it is noted because it is the kind of asymmetry that
   * looks like a transcription error and is not.
   *
   * **This is the panel the reward CHOICE is made on**, so `choices` is the array
   * `GetNumQuestChoices`/`GetQuestItemInfo("choice", i)` answer from and the index the player clicks
   * is what `CMSG_QUESTGIVER_CHOOSE_REWARD` carries. `QuestRewardCompleteButton_OnClick` refuses to
   * send at all while `itemChoice == 0` and `GetNumQuestChoices() > 0` (`questframe.lua:91-93`), which
   * is the client's own guard against turning in without picking.
   *
   * The tail is tolerant for the reason the detail panel's is, and here the ORDER of the tail differs
   * from that panel's -- which is itself the thing this cannot check without a live packet.
   */
  private handleOfferReward(gp: GamePacket): void {
    const base = gp.index;

    // TWO CANDIDATE WIDTHS FOR `activateAccept`, DISCRIMINATED BY `emoteCount`.
    //
    // Same lesson as `handleDetails`, applied before it costs a round: 1.12 writes `autoFinish` as a
    // `u32` (`benilla-protocol/.../quest/giver.rs:302-306`) and 3.3.5 writes a `u8`, and a wrong width
    // here does NOT corrupt the quest id -- that field is already past -- so the id oracle cannot see
    // it. What it corrupts is everything from the emote block on: the title and the offer text survive
    // and the REWARD ITEMS do not, which on screen is a reward panel with text and no items.
    //
    // `emoteCount` is the discriminator and it is a strong one: the server writes at most
    // `QUEST_EMOTE_COUNT` (4) of them, so a value above that is proof the cursor is misaligned. Three
    // bytes of slack read as part of a following word gives a number in the millions, not in 0..4.
    const narrow = this.tryOffer(gp, base, 1);
    const wide = this.tryOffer(gp, base, 4);
    let chosen = narrow;
    let shape = 'u8 activateAccept';
    if (narrow === null || narrow.emoteCount > QUEST_EMOTE_COUNT) {
      if (wide !== null && wide.emoteCount <= QUEST_EMOTE_COUNT) {
        chosen = wide;
        shape = 'u32 activateAccept (the 1.12 width)';
      }
    }
    if (chosen === null) {
      throw new Error('SMSG_QUESTGIVER_OFFER_REWARD: neither candidate width decoded');
    }
    this.lastQuestId = chosen.questId;
    this.lastTitle = chosen.title;
    this.offerShape = shape;
    /**
     * THE TAIL, ONCE, AS RAW WORDS. See `tryOffer`'s note at `tailAt` for why this exists rather than a
     * corrected order: the layout is unverified, the owner has shown it is wrong, and this repo settles
     * a layout with bytes off real traffic.
     */
    if (!this.announcedOfferTail) {
      this.announcedOfferTail = true;
      const words: string[] = [];
      const save = gp.index;
      gp.index = chosen.tailAt;
      try {
        for (let i = 0; i < 16; ++i) {
          words.push(String(gp.readUnsignedInt() >>> 0));
        }
      } catch {
        // Ran off the frame; what was collected is still the evidence.
      }
      gp.index = save;
      console.warn(`quest: OFFER_REWARD tail after xp = [${words.join(' ')}] (body ${gp.bodySize}; `
        + `we read charTitleId=${chosen.charTitleId} bonusTalents=${chosen.bonusTalents} `
        + `arenaPoints=${chosen.arenaPoints} honor=${chosen.honor})`);
    }
    if (chosen.title === '' || chosen.emoteCount > QUEST_EMOTE_COUNT) {
      console.warn(
        'quest: SMSG_QUESTGIVER_OFFER_REWARD looks misaligned (chose "' + shape + '", title "'
        + chosen.title + '", emoteCount ' + chosen.emoteCount + ', body ' + gp.bodySize
        + '). The reward panel may draw without its items. Read window.itemWire.census().',
      );
    }
    gp.index = chosen.cursor;
    this.awaiting.delete(chosen.questId);

    if (chosen.title !== '') {
      this.titles.set(chosen.questId, chosen.title);
    }
    this.source = chosen.npc;
    this.offer = chosen;
    this.details = null;
    this.progress = null;
    this.greeting = null;
    this.emit('questOfferReward', this.offer);
  }

  /**
   * One candidate decode of `SMSG_QUESTGIVER_OFFER_REWARD`, with `activateAccept` read as `autoBytes`
   * bytes. See `handleOfferReward` for what chooses.
   *
   * `emoteCount` is returned rather than discarded precisely because it is the alignment check; the
   * pairs themselves are `{delay, emote}` here and `{emote, delay}` on the detail panel, which is
   * benilla's own recorded asymmetry (`quest/giver.rs:14-15`) and costs nothing because they are
   * consumed for alignment only.
   */
  private tryOffer(
    gp: GamePacket, base: number, autoBytes: 1 | 4,
  ): (QuestGiverOfferReward & { cursor: number; emoteCount: number; tailAt: number }) | null {
    gp.index = base;
    try {
      const npc = this.readFullGuid(gp);
      const questId = gp.readUnsignedInt() >>> 0;
      const title = gp.readCStr();
      const offerText = gp.readCStr();
      const activateAccept = autoBytes === 1
        ? gp.readUnsignedByte() !== 0
        : (gp.readUnsignedInt() >>> 0) !== 0;
      const flags = gp.readUnsignedInt() >>> 0;
      const suggestedPlayers = gp.readUnsignedInt() >>> 0;
      const emoteCount = gp.readUnsignedInt() >>> 0;
      if (emoteCount > QUEST_EMOTE_COUNT) {
        // Bail rather than loop: an implausible count is the whole signal, and looping on a
        // multi-million count would over-read the frame in a hot handler.
        return {
          // 0: this candidate never reached the tail, and this shape is the one being REJECTED anyway.
          tailAt: 0,
          npc,
          questId,
          title,
          offerText,
          activateAccept,
          flags,
          suggestedPlayers,
          choices: [],
          rewards: [],
          money: 0,
          xp: 0,
          honor: 0,
          rewardSpell: 0,
          charTitleId: 0,
          bonusTalents: 0,
          arenaPoints: 0,
          cursor: gp.index,
          emoteCount,
        };
      }
      for (let i = 0; i < emoteCount; ++i) {
        gp.readUnsignedInt(); // delay FIRST here -- reversed against the detail panel
        gp.readUnsignedInt(); // emote
      }
      const choices = this.readTripleBlock(gp);
      const rewards = this.readTripleBlock(gp);
      const money = gp.readInt();
      const xp = gp.readUnsignedInt() >>> 0;
      // WHERE THE UNVERIFIED TAIL STARTS. This method's header says the tail ORDER "cannot be checked
      // without a live packet", and the owner has now supplied the evidence that it is wrong: his reward
      // panel drew "Bonus arena points: 8" for a Northshire quest that grants none. The raw words are
      // reported from here once (see `handleOfferReward`) -- a residual against real traffic is the only
      // thing that settles a layout in this repo, and reconstructing a server's write order from memory
      // is what cost a round on the gossip icon.
      const tailAt = gp.index;
      const charTitleId = this.tailU32(gp);
      const bonusTalents = this.tailU32(gp);
      const arenaPoints = this.tailU32(gp);
      this.tailU32(gp); // unk
      const rewardSpell = this.tailU32(gp);
      this.tailU32(gp); // rewSpellCast
      const honor = this.tailU32(gp);
      return {
        npc,
        questId,
        title,
        offerText,
        activateAccept,
        flags,
        suggestedPlayers,
        choices,
        rewards,
        money,
        xp,
        honor,
        rewardSpell,
        charTitleId,
        bonusTalents,
        arenaPoints,
        tailAt,
        cursor: gp.index,
        emoteCount,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * `SMSG_QUESTGIVER_REQUEST_ITEMS` (**0x18B**) -- the progress panel. Fires `QUEST_PROGRESS`.
   *
   *     u64 npcGuid · u32 questId · cstr title · cstr requestText
   *     u32 emoteDelay · u32 emote · u32 closeOnCancel
   *     u32 flags · u32 suggestedPlayers · u32 requiredMoney
   *     u32 reqCount · reqCount x { u32 itemId · u32 count · u32 displayId }
   *     then the trailing flag words, of which the SECOND is the completability
   *
   * **`flags` and `suggestedPlayers` are the WotLK additions here**, and they sit between
   * `closeOnCancel` and `requiredMoney` -- so a 1.12 read takes the flags word as the required money
   * and the suggested-player count as the item count, which would either draw a nonsense gold cost or
   * over-read the frame.
   *
   * The trailing flag words are read while four bytes remain, and `isComplete` comes from the SECOND
   * of them. 1.12 writes four (`0x02`, `complete?3:0`, `0x04`, `0x08`) and 3.3.5 writes five; either
   * way the completability is word index 1, which is why counting them is enough and their values are
   * not read.
   */
  private handleRequestItems(gp: GamePacket): void {
    const npc = this.readFullGuid(gp);
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    const title = gp.readCStr();
    this.lastTitle = title;
    const requestText = gp.readCStr();
    gp.readUnsignedInt(); // emoteDelay
    gp.readUnsignedInt(); // emote
    gp.readUnsignedInt(); // closeOnCancel
    gp.readUnsignedInt(); // flags -- WotLK
    gp.readUnsignedInt(); // suggestedPlayers -- WotLK
    const requiredMoney = gp.readUnsignedInt() >>> 0;
    const requiredItems = this.readTripleBlock(gp);

    const flagWords: number[] = [];
    while (this.remaining(gp) >= 4) {
      flagWords.push(gp.readUnsignedInt() >>> 0);
    }
    const isComplete = (flagWords[1] ?? 0) !== 0;

    // LOUD WHEN IMPLAUSIBLE, because this arm cannot use the quest-id oracle: the id is read before
    // the two WotLK words that are in doubt, so a wrong prefix still echoes the right id. The two
    // checks that DO discriminate are the required-item count -- the client's own `MAX_REQUIRED_ITEMS`
    // is 6 (`questframe.lua:3`), so anything above that is proof of misalignment -- and the flag-word
    // count, which is 4 in 1.12 and 5 in 3.3.5 and can be neither only if the cursor is wrong.
    //
    // A warning rather than a second candidate decode: unlike the detail and reward panels there is no
    // clean alternate shape to try here (dropping `flags`/`suggestedPlayers` shifts the money and the
    // count into each other's slots, and both would still look like small numbers), so guessing a
    // second layout would be inventing one. Naming it is the honest half.
    if (title === '' || requiredItems.length > MAX_REQUIRED_ITEMS
      || (flagWords.length !== 4 && flagWords.length !== 5)) {
      console.warn(
        'quest: SMSG_QUESTGIVER_REQUEST_ITEMS looks misaligned (title "' + title + '", '
        + requiredItems.length + ' required items, ' + flagWords.length + ' trailing flag words,'
        + ' body ' + gp.bodySize + '). Expected at most ' + MAX_REQUIRED_ITEMS + ' items and 4 or 5'
        + ' flag words. The progress panel may draw blank or refuse to complete.'
        + ' Read window.itemWire.census().',
      );
    }

    if (title !== '') {
      this.titles.set(questId, title);
    }
    this.source = npc;
    this.progress = {
      npc, questId, title, requestText, requiredMoney, requiredItems, isComplete,
    };
    this.details = null;
    this.offer = null;
    this.greeting = null;
    this.emit('questProgress', this.progress);
  }

  /**
   * `SMSG_QUESTGIVER_QUEST_LIST` (**0x185**) -- the multi-quest greeting. Fires `QUEST_GREETING`.
   *
   *     u64 npcGuid · cstr greeting · u32 emoteDelay · u32 emote
   *     u32 count · count x { u32 questId · u32 icon · u32 level · u8 flags · cstr title }
   *
   * **The count is a `u32` in 3.3.5a and a `u8` in 1.12** (`quest/giver.rs:242`), and each row gained
   * a trailing flags byte. Both are read here; a wrong count width alone would read three garbage
   * bytes as the start of the first quest id.
   *
   * The `icon` is a `DIALOG_STATUS` value and a `u32` -- NOT the `u8` the gossip menu's option icon
   * is, which benilla flags as its own list-entry trap (`quest/giver.rs:11-13`) and which is unchanged
   * in 3.3.5a.
   *
   * This is a DIFFERENT panel from the gossip menu. A giver with several quests and no gossip text
   * sends this; one with gossip options sends `SMSG_GOSSIP_MESSAGE` with a quest array. Both end in
   * `SelectAvailableQuest`/`SelectGossipAvailableQuest` -> `CMSG_QUESTGIVER_QUERY_QUEST`.
   */
  private handleQuestList(gp: GamePacket): void {
    const npc = this.readFullGuid(gp);
    const greeting = gp.readCStr();
    gp.readUnsignedInt(); // emoteDelay
    gp.readUnsignedInt(); // emote
    const count = gp.readUnsignedInt() >>> 0;
    const quests: QuestGiverListEntry[] = [];
    for (let i = 0; i < count; ++i) {
      const questId = gp.readUnsignedInt() >>> 0;
      const icon = gp.readUnsignedInt() >>> 0;
      // SIGNED for the reason `gossip.ts` reads its own level signed: -1 is "scales to the player".
      const level = gp.readInt();
      gp.readUnsignedByte(); // flags -- WotLK; the repeatable/daily marker
      const title = gp.readCStr();
      if (title !== '') {
        this.titles.set(questId, title);
      }
      quests.push({ questId, icon, level, title });
    }
    this.lastQuestId = 0;
    this.lastTitle = '';
    this.source = npc;
    this.greeting = { npc, greeting, quests };
    this.details = null;
    this.offer = null;
    this.progress = null;
    this.emit('questGreeting', this.greeting);
  }

  /**
   * `SMSG_QUESTGIVER_QUEST_COMPLETE` (**0x191**) -- the turn-in landed.
   *
   *     u32 questId · u32 xp · u32 money · [tail] u32 honor · u32 talents · u32 arenaPoints
   *
   * 1.12 has an `unknown` word after the quest id and an item list at the end
   * (`quest/giver.rs:364-372`); 3.3.5a has neither -- the granted items arrive through
   * `SMSG_ITEM_PUSH_RESULT` and `UPDATE_OBJECT` like any other item. The tail is tolerant.
   *
   * **This packet does not remove the quest from the log; the descriptor does.** The client's own
   * `QuestFrame_OnEvent` only hides the panel on `QUEST_FINISHED`, and the log's row disappears when
   * the slot's `questId` word goes to zero. So this arm fires the event and nothing else.
   */
  private handleQuestComplete(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    const xp = gp.readUnsignedInt() >>> 0;
    const money = gp.readUnsignedInt() >>> 0;
    const honor = this.tailU32(gp);
    const talents = this.tailU32(gp);
    const arenaPoints = this.tailU32(gp);
    this.closePanels();
    this.emit('questRewarded', {
      questId, xp, money, honor, talents, arenaPoints,
    });
  }

  /**
   * `SMSG_GOSSIP_COMPLETE` (**0x17E**): an EMPTY body, and it closes the giver panel.
   *
   * `closePanels` is a no-op with nothing open, so this costs a comparison on every gossip close that
   * had no quest panel behind it.
   */
  private handleGossipComplete(): void {
    this.lastQuestId = 0;
    this.lastTitle = '';
    this.closePanels();
  }

  /** `SMSG_QUESTGIVER_QUEST_INVALID` (**0x18F**): one `u32` `INVALIDREASON_*` code. */
  private handleQuestInvalid(gp: GamePacket): void {
    const reason = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = 0;
    this.lastTitle = '';
    this.emit('questInvalid', reason);
  }

  /** `SMSG_QUESTGIVER_QUEST_FAILED` (**0x192**): `u32 questId · u32 reason`. */
  private handleQuestFailed(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    const reason = gp.readUnsignedInt() >>> 0;
    this.emit('questInvalid', reason);
  }

  /**
   * `SMSG_QUESTUPDATE_COMPLETE` (**0x198**): one `u32` questId. The objective toast's "complete" half.
   *
   * The COMPLETE bit also lands in the slot's state word, so this is a notification and not the state.
   */
  private handleUpdateComplete(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    this.emit('questUpdate', { kind: 'complete', questId });
  }

  /**
   * `SMSG_QUESTUPDATE_ADD_KILL` (**0x199**): `u32 questId · u32 entry · u32 count · u32 required
   * · u64 guid`.
   *
   * **The two counts are `u32` in 3.3.5a and `u16` in 1.12.** The counter itself is also in the
   * descriptor, so this arm exists for the toast and the `QUEST_WATCH_UPDATE` event rather than for
   * the number -- which means a wrong width here cannot corrupt the log. `entry` is raw, carrying the
   * same `(-id)|0x80000000` gameobject encoding the template's objectives do.
   */
  private handleAddKill(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    const entry = gp.readUnsignedInt() >>> 0;
    const count = gp.readUnsignedInt() >>> 0;
    const required = gp.readUnsignedInt() >>> 0;
    this.readFullGuid(gp);
    this.emit('questUpdate', {
      kind: 'kill', questId, entry, count, required,
    });
  }

  /** `SMSG_QUESTUPDATE_FAILED` / `..._FAILEDTIMER` (**0x196** / **0x197**): one `u32` questId. */
  private handleUpdateFailed(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    this.emit('questUpdate', { kind: 'failed', questId });
  }

  /** `SMSG_QUESTLOG_FULL` (**0x195**): an EMPTY body. */
  private handleLogFull(): void {
    this.lastQuestId = 0;
    this.lastTitle = '';
    this.emit('questLogFull');
  }

  /** `SMSG_QUEST_FORCE_REMOVED` (**0x21E**): one `u32` questId. */
  private handleForceRemoved(gp: GamePacket): void {
    const questId = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = questId;
    this.lastTitle = '';
    this.emit('questUpdate', { kind: 'removed', questId });
  }

  /**
   * `SMSG_QUESTGIVER_STATUS` (**0x183**) -- the `!` over ONE giver's head.
   *
   * **THE STATUS WIDTH IS DERIVED FROM THE FRAME, NOT ASSUMED, and this is the one place in the file
   * where that is the honest answer.** 1.12 writes `u64 guid · u32 status`
   * (`quest/giver.rs:225-228`) and 3.3.5 writes `u64 guid · u8 status`; nothing available here settles
   * which, and picking wrong is a silent 4x error in the status value -- so the body size does it. A
   * body of nine bytes can only be guid + byte and a body of twelve can only be guid + word. That
   * makes the residual 0 by construction, which is stated rather than presented as a verified layout
   * (the same honest caveat `merchant.ts#handleListInventory` records for its conditional trailing
   * byte).
   */
  private handleStatus(gp: GamePacket): void {
    const size = gp.bodySize;
    const guid = this.readFullGuid(gp);
    const status = size - GUID_BYTES >= 4 ? gp.readUnsignedInt() >>> 0 : gp.readUnsignedByte();
    this.lastQuestId = 0;
    this.lastTitle = '';
    this.status.set(guid, status);
    this.emit('questgiverStatus', { guid, status });
  }

  /**
   * `SMSG_QUESTGIVER_STATUS_MULTIPLE` (**0x418**) -- every nearby giver at once, and the packet the
   * `!` indicators are actually driven by.
   *
   *     u32 count · count x { u64 guid · u8|u32 status }
   *
   * A WotLK opcode with no 1.12 counterpart, so benilla has nothing to say about it. The per-row
   * status width is derived the same way `handleStatus` derives its own -- `(bodySize - 4) / count` is
   * 9 or 12 and there is no third possibility. A `count` of 0 leaves the map untouched, which matters:
   * the server sends this whenever the player's quest state changes anywhere, and clearing on an empty
   * one would blink every bang in view.
   */
  private handleStatusMultiple(gp: GamePacket): void {
    const size = gp.bodySize;
    const count = gp.readUnsignedInt() >>> 0;
    this.lastQuestId = 0;
    this.lastTitle = '';
    if (count === 0) {
      return;
    }
    if (!this.announcedStatusReply) {
      this.announcedStatusReply = true;
      console.warn(`quest: status sweep ANSWERED with ${count} rows (body ${size})`);
    }
    const stride = (size - 4) / count;
    const wide = stride >= GUID_BYTES + 4;
    for (let i = 0; i < count; ++i) {
      const guid = this.readFullGuid(gp);
      const status = wide ? gp.readUnsignedInt() >>> 0 : gp.readUnsignedByte();
      this.status.set(guid, status);
    }
    this.emit('questgiverStatusMultiple');
  }

  // -- Outgoing -----------------------------------------------------------------------------------

  /**
   * `CMSG_QUEST_QUERY` (**0x05C**): one `u32` quest id. Answered by `SMSG_QUEST_QUERY_RESPONSE`.
   *
   * Deduplicated on `queried` so a quest log with 25 rows repainting on every `unit:fields` edge does
   * not send 25 packets per health tick -- which is the whole per-frame cost of the quest log's data
   * path and the reason it is zero after the first paint.
   */
  queryTemplate(questId: number): void {
    if (questId <= 0 || this.templates.has(questId) || this.queried.has(questId)) {
      return;
    }
    this.queried.add(questId);
    const gp = new GamePacket(
      GameOpcode.CMSG_QUEST_QUERY, GamePacket.HEADER_SIZE_OUTGOING + 4,
    );
    gp.writeUnsignedInt(questId >>> 0);
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTGIVER_QUERY_QUEST` (**0x186**): `u64 guid · u32 questId · u8 startCheat`.
   *
   * **The trailing byte is the WotLK addition** (`HandleQuestgiverQueryQuestOpcode` reads a `bool`);
   * 1.12 has twelve bytes (`quest/giver.rs:158-160`) and sending twelve here would leave the server
   * reading that bool off the end of the frame. Always 0: it is the GM "start the quest regardless"
   * flag.
   *
   * This is what a quest row's click sends, from either panel. Answered by
   * `SMSG_QUESTGIVER_QUEST_DETAILS` for an available quest and by `SMSG_QUESTGIVER_REQUEST_ITEMS` or
   * `SMSG_QUESTGIVER_OFFER_REWARD` for one already in the log.
   */
  queryQuest(questId: number, npc?: string): void {
    const guid = npc ?? this.source;
    if (guid === null || guid === undefined) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTGIVER_QUERY_QUEST, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 4 + 1,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(questId >>> 0);
    gp.writeUnsignedByte(0); // startCheat
    this.source = guid;
    // REMEMBERED so the reply's own echo of it can pick between the two candidate prefixes -- see
    // `handleDetails`. Bounded: cleared on a match and on a world change.
    this.awaiting.add(questId >>> 0);
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTGIVER_ACCEPT_QUEST` (**0x189**): `u64 guid · u32 questId · u32 startCheat`,
   * **16 bytes**.
   *
   * The third word is `startCheat` in TrinityCore 3.3.5's `HandleQuestgiverAcceptQuestOpcode` -- a
   * SERVER implementation's own name for it, labelled as such like every other value in this file
   * whose only source is one, and the GM "start the quest regardless of its requirements" flag. Always
   * sent as 0.
   *
   * **This docstring said "12 bytes" until after the fix below landed, which made it the stale half of
   * a closed gap pointing readers at the wrong number** -- `send()` correctly told them to come here
   * for the width while here still described the bug. Recorded rather than quietly corrected, because
   * a comment that still describes a gap now closed is treated as a defect on this project and this was
   * one of mine.
   *
   * The quest is in the log when a `PLAYER_QUEST_LOG_*` slot carries its id, and by no other signal
   * -- see `update-object/quest-log.ts`. The server also sends `SMSG_GOSSIP_COMPLETE`, which closes
   * the giver window through `GossipHandler`.
   */
  acceptQuest(questId?: number): void {
    const guid = this.source;
    const id = questId ?? this.details?.questId ?? 0;
    if (guid === null || id === 0) {
      return;
    }
    // **16 BYTES, NOT 12, AND THIS IS WHY "Принять квест тоже не получается".**
    //
    // 1.12 reads `u64 guid, u32 quest` (`benilla-protocol/.../quest/giver.rs:165-168`, the shared
    // `guid_quest` body). TrinityCore 3.3.5's `HandleQuestgiverAcceptQuestOpcode` reads
    // **`guid >> questId >> startCheat`** with `startCheat` a `u32` -- so a 12-byte send makes the
    // server's `ByteBuffer` read four bytes past the end and throw, the packet is DISCARDED, and
    // nothing at all comes back. The button looks inert rather than refused, and no `SMSG_*` will ever
    // explain it. That is the project's most-repeated defect class, eleven-plus instances across four
    // areas, and this is the twelfth.
    //
    // **A SEPARATE BODY FROM `send()` ON PURPOSE.** `CMSG_QUESTGIVER_COMPLETE_QUEST` and
    // `..._REQUEST_REWARD` genuinely read 12, so widening the shared helper would have "fixed" this
    // one and broken those two -- the opposite mistake, and equally silent.
    //
    // **AND THE WIDTH IS SAFE UNDER BOTH HYPOTHESES, which is what settles it without a capture.**
    // A `ByteBuffer` throws only on an UNDER-read; trailing bytes the server never reads are simply
    // ignored. So if `startCheat` is really there, 16 is required; if it is not, 16 is harmless. 12 is
    // fatal in the first case. That asymmetry is the same reasoning `CLAUDE.md` records for preferring
    // the reference's BYTES over its rationale -- a `u8` 0 plus three zero bytes IS a little-endian
    // `u32` 0.
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTGIVER_ACCEPT_QUEST,
      GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 8,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(id >>> 0);
    gp.writeUnsignedInt(0); // startCheat -- the GM "start it regardless" flag; the server reads it
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTGIVER_COMPLETE_QUEST` (**0x18A**): `u64 guid · u32 questId`, 12 bytes.
   *
   * "Show me the turn-in panel" -- answered by `SMSG_QUESTGIVER_REQUEST_ITEMS` when the quest wants
   * items or money, and by `SMSG_QUESTGIVER_OFFER_REWARD` when it is ready to pay out.
   */
  completeQuest(questId?: number, npc?: string): void {
    // `npc` EXPLICIT, mirroring `queryQuest`: a gossip menu's row is handed in against the GOSSIP's
    // giver, and `this.source` is only set once a quest packet has arrived -- so on a fresh menu it is
    // null or, worse, the previous giver. `gossip-bridge.ts`' quest rows pass their own guid.
    const guid = npc ?? this.source;
    const id = questId ?? this.progress?.questId ?? this.details?.questId ?? 0;
    if (guid === null || id === 0) {
      return;
    }
    this.send(GameOpcode.CMSG_QUESTGIVER_COMPLETE_QUEST, guid, id);
  }

  /**
   * `CMSG_QUESTGIVER_REQUEST_REWARD` (**0x18C**): `u64 guid · u32 questId`, 12 bytes.
   *
   * The progress panel's Continue button. Advances to `SMSG_QUESTGIVER_OFFER_REWARD`.
   */
  requestReward(questId?: number): void {
    const guid = this.source;
    const id = questId ?? this.progress?.questId ?? 0;
    if (guid === null || id === 0) {
      return;
    }
    this.send(GameOpcode.CMSG_QUESTGIVER_REQUEST_REWARD, guid, id);
  }

  /**
   * `CMSG_QUESTGIVER_CHOOSE_REWARD` (**0x18E**): `u64 guid · u32 questId · u32 rewardIndex`, 16 bytes.
   *
   * **`rewardIndex` is 0-BASED on the wire and the client's own button ids are 1-based.**
   * `QuestInfoItem_OnClick` stores `self:GetID()` (`questinfo.lua:26-32`) and the buttons are given
   * `questItem:SetID(i)` with `i` from a 1-based Lua loop, so `game/ui/quest-bridge.ts#GetQuestReward`
   * subtracts one. Sending the 1-based value would hand out the wrong item on any quest with a choice
   * -- the exact class of off-by-one the merchant round found in `CMSG_SWAP_INV_ITEM`'s argument order.
   *
   * A quest with no choice rewards ignores the index; 0 is what the client sends there.
   */
  chooseReward(rewardIndex: number, questId?: number): void {
    const guid = this.source;
    const id = questId ?? this.offer?.questId ?? 0;
    if (guid === null || id === 0) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTGIVER_CHOOSE_REWARD,
      GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 8,
    );
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(id >>> 0);
    gp.writeUnsignedInt(rewardIndex >>> 0);
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTLOG_REMOVE_QUEST` (**0x194**): one `u8` log SLOT. THE ABANDON.
   *
   * **The slot, not the quest id** -- and that is why `update-object/quest-log.ts` keys its map by
   * slot. There is no acknowledgement: the slot's words going to zero in the next `UPDATE_OBJECT` is
   * the confirmation, which is the same law benilla states for 1.12 (`quest/log.rs:98-102`).
   */
  removeQuest(slot: number): void {
    if (slot < 0 || slot > 0xff) {
      return;
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTLOG_REMOVE_QUEST, GamePacket.HEADER_SIZE_OUTGOING + 1,
    );
    gp.writeUnsignedByte(slot & 0xff);
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTGIVER_CANCEL` (**0x190**): an EMPTY body. The Decline/Goodbye buttons.
   *
   * The server answers `SMSG_GOSSIP_COMPLETE`, so the window's close travels back through
   * `GossipHandler` -- which is why this does not clear the panels itself and `closePanels` is called
   * from the bridge's `CloseQuest`.
   */
  cancel(): void {
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTGIVER_CANCEL, GamePacket.HEADER_SIZE_OUTGOING,
    );
    this.game.send(gp);
  }

  /**
   * `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` (**0x417**): an EMPTY body.
   *
   * Asks for every nearby giver's status in one packet. A WotLK opcode; the 1.12 client asks per NPC
   * with `CMSG_QUESTGIVER_STATUS_QUERY`, which is why benilla has a per-guid encoder
   * (`quest/giver.rs:139-141`) and no bulk one. Sent on entering the world and when the log changes.
   */
  queryStatusMultiple(): void {
    /**
     * ANNOUNCED, ONCE. The overhead `!`/`?` markers have now cost several rounds in which the owner's
     * console said nothing at all -- not even that a status map had arrived -- and silence cannot
     * distinguish "no query was sent" from "the query was sent and never answered". These two lines
     * (the twin is in `handleStatusMultiple`) make that a positive statement instead of an absence.
     */
    if (!this.announcedStatusQuery) {
      this.announcedStatusQuery = true;
      console.warn('quest: status sweep SENT (CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY)');
    }
    const gp = new GamePacket(
      GameOpcode.CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY, GamePacket.HEADER_SIZE_OUTGOING,
    );
    this.game.send(gp);
  }

  /**
   * Forget every open panel. Called by `CloseQuest` and on a world change.
   *
   * **THE EMIT IS GUARDED ON SOMETHING HAVING BEEN OPEN, and that guard is a self-review fix rather
   * than tidiness.** `QuestFrame_OnHide` calls `CloseQuest()` (`questframe.lua:297`) and the
   * `questFinished` emit fires `QUEST_FINISHED`, which `QuestFrame_OnEvent` answers with
   * `HideUIPanel(QuestFrame)` (`questframe.lua:18-21`). Unguarded that is a hide feeding a hide: it
   * terminates only because the second `HideUIPanel` finds the frame already hidden, which is a
   * property of `HideUIPanel` and not of this file. Emitting only on a real close removes the loop
   * instead of relying on someone else's early-out.
   */
  closePanels(): void {
    const wasOpen = this.details !== null || this.offer !== null
      || this.progress !== null || this.greeting !== null;
    this.details = null;
    this.offer = null;
    this.progress = null;
    this.greeting = null;
    if (wasOpen) {
      this.emit('questFinished');
    }
  }

  // -- Readers ------------------------------------------------------------------------------------

  /** The shared `{u64 guid, u32 questId}` body of the four simple questgiver sends. */
  /**
   * The shared `{u64 guid, u32 questId}` body -- **`CMSG_QUESTGIVER_COMPLETE_QUEST` and
   * `..._REQUEST_REWARD` ONLY.**
   *
   * `CMSG_QUESTGIVER_ACCEPT_QUEST` used to come through here and that was the bug: it reads a third
   * word in 3.3.5a. See `acceptQuest` for the width and for why it does not share this.
   */
  private send(opcode: number, guid: string, questId: number): void {
    // Same oracle as `queryQuest`: both of these are answered with a panel that echoes the quest id
    // back.
    this.awaiting.add(questId >>> 0);
    const gp = new GamePacket(opcode, GamePacket.HEADER_SIZE_OUTGOING + GUID_BYTES + 4);
    gp.write(Array.from(guidBytes(guid)));
    gp.writeUnsignedInt(questId >>> 0);
    this.game.send(gp);
  }

  /** `u32 count` then that many `{itemId, count, displayId}` triples. */
  private readTripleBlock(gp: GamePacket): QuestItemTriple[] {
    const count = gp.readUnsignedInt() >>> 0;
    const items: QuestItemTriple[] = [];
    for (let i = 0; i < count; ++i) {
      items.push({
        itemId: gp.readUnsignedInt() >>> 0,
        count: gp.readUnsignedInt() >>> 0,
        displayId: gp.readUnsignedInt() >>> 0,
      });
    }
    return items;
  }

  /** Bytes of body left. `length` is the whole frame; `index` is the read cursor. */
  private remaining(gp: GamePacket): number {
    return gp.length - gp.index;
  }

  /**
   * One tail word, or 0 when the frame is spent. See the file header on why every scalar after the
   * fields the panels are built out of is read this way: an unverified 3.3.5a tail must not be able to
   * cost the title, the text or the reward items.
   */
  private tailU32(gp: GamePacket): number {
    return this.remaining(gp) >= 4 ? gp.readUnsignedInt() >>> 0 : 0;
  }

  private readFullGuid(gp: GamePacket): string {
    const bytes = new Uint8Array(GUID_BYTES);
    for (let i = 0; i < GUID_BYTES; ++i) {
      bytes[i] = gp.readUnsignedByte();
    }
    return guidHex(bytes);
  }
}

export default QuestHandler;
