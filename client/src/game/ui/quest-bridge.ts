/**
 * THE QUEST GLOBALS -- the engine half of `QuestFrame`, `QuestInfo`, `QuestLogFrame` and
 * `StaticPopup`'s `ABANDON_QUEST`, all of which are the client's own XML and Lua.
 *
 * Nothing is drawn here. `QuestFrame.xml` declares the four questgiver panels, `QuestInfo.xml` the
 * shared body they all reuse, and `QuestLogFrame.xml` the log and its detail frame; the whole
 * deliverable is the answers plus the events those documents register for.
 *
 * **79 globals, and the list was SWEPT rather than remembered.** `scratchpad/sweep.py` walks
 * `questframe.lua`, `questinfo.lua` and `questlogframe.lua`, strips comments, subtracts every function
 * the FrameXML mirror itself defines and every global already registered on the TypeScript side, and
 * prints what is left. That is the same discipline the round was told to apply after
 * `SecureUnitButton_OnClick` was found to raise on its FIRST statement: **a missing global at the top
 * of a handler kills everything below it, and the visible half looks merely absent rather than
 * broken.** Two globals the sweep found that are NOT quest globals at all are registered here for
 * exactly that reason -- see `GetMapInfo`.
 *
 * ## TWO PARALLEL FAMILIES, and `QuestInfoFrame.questLog` is the switch
 *
 * `QuestInfo_Display` is shared by the giver panels and the log, and every branch inside it reads
 * `QuestInfoFrame.questLog` (`questinfo.lua:41` and the eight `if ( QuestInfoFrame.questLog )` after
 * it). So each piece of information has TWO globals:
 *
 *     giver panel            quest log
 *     GetTitleText           GetQuestLogTitle(GetQuestLogSelection())
 *     GetQuestText           GetQuestLogQuestText          (returns TWO strings)
 *     GetObjectiveText       GetQuestLogQuestText          (its second return)
 *     GetNumQuestRewards     GetNumQuestLogRewards
 *     GetNumQuestChoices     GetNumQuestLogChoices
 *     GetQuestItemInfo       GetQuestLogRewardInfo / GetQuestLogChoiceInfo
 *     GetRewardMoney         GetQuestLogRewardMoney        (and so on for xp/honor/talents/arena/title)
 *
 * The giver family reads the OPEN PANEL, which is self-contained on the wire. The log family reads the
 * TEMPLATE CACHE joined to the player's descriptor slots. See `network/game/object/quest.ts`' header
 * for why that split is a fact about 3.3.5a and not a choice made here.
 *
 * ## `0` IS TRUTHY IN LUA, and this file is full of the places it bites
 *
 * The trap list's first entry, three occurrences already. Every global here that means "nothing" answers
 * **nil**:
 *
 *  - `GetQuestLogTimeLeft` -- `QuestInfo_ShowTimer` does `if ( timeLeft )` (`questinfo.lua:171`), so a
 *    0 would show a timer reading "Time Remaining: 0 seconds" on every untimed quest in the game.
 *  - `GetAbandonQuestName` -- `QuestLogControlPanel_UpdateState` does `if ( GetAbandonQuestName() )`
 *    (`questlogframe.lua:863`), so a 0 or an empty string that Lua treats as true would enable the
 *    Abandon button with nothing selected.
 *  - `GetRewardTitle`/`GetQuestLogRewardTitle` -- `QuestInfo_ShowRewards` tests `not playerTitle` and
 *    then `QuestInfo_ToggleRewardElement(..., playerTitle, "Title", ...)`, which shows the frame for any
 *    truthy value (`questinfo.lua:296,378`). A 0 would put an empty "title reward" row on every quest.
 *  - `GetQuestLogTitle` for an out-of-range index -- `QuestLog_GetFirstSelectableQuest` walks until the
 *    title is nil (`questlogframe.lua:680-690`), so returning a placeholder would loop.
 *
 * The mirror case is just as sharp and is why some of these deliberately answer 0 rather than nil:
 * `QuestInfo_ShowRewards` sums `numQuestRewards + numQuestChoices + numQuestSpellRewards` and compares
 * `money == 0` (`questinfo.lua:296`), so those must be NUMBERS. A nil there is an arithmetic error, not
 * an empty panel.
 *
 * ## What is NOT here, stated rather than stubbed silently
 *
 *  - **Quest watching is engine state with no server side**, so `AddQuestWatch`/`RemoveQuestWatch`/
 *    `IsQuestWatched`/`GetNumQuestWatches` are real and complete -- a `Set` of quest indices. There is
 *    no packet for it in any build; the objective tracker is a client feature.
 *  - **Sharing a quest with the party is not built.** `GetQuestLogPushable` answers false, which is a
 *    TRUE answer and not a stub: `CMSG_PUSHQUESTTOPARTY` has no sender here, so the Share button
 *    staying hidden is correct rather than misleading. `QuestLogControlPanel_UpdateState` hides it on
 *    exactly that (`questlogframe.lua:871`).
 *  - **Reward reputation is not resolved.** `GetNumQuestLogRewardFactions` answers 0, so
 *    `QuestInfo_DoReputations`' loop never runs -- which is what keeps `GetFactionInfoByID` (owned by
 *    the reputation work, not this file) off the paint path entirely. The template DOES carry the
 *    faction ids; joining them needs `Faction.dbc`, which the reputation tab owns, and reaching into it
 *    from here would put two owners on one join.
 *  - **A trivial ("low level") quest is never marked**, for the standing reason `gossip-bridge.ts`
 *    records at length: the threshold is `GetQuestGreenRange()`, an engine global that is
 *    level-dependent and that nothing this client can read states. Same gap, same consequence, not a
 *    second differently-wrong copy of it.
 *  - **A creature objective with no objective text and an unseen creature reads as counts only.** The
 *    only name source for a creature entry is `SMSG_CREATURE_QUERY_RESPONSE`, whose query needs a
 *    GUID -- so an entry the player has never had in view cannot be named from here. `"3/8"` is the
 *    honest answer; the alternative was printing the raw entry id as a monster's name.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented, warnOnce } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { GlueArt } from './art';
import { setUnit } from './framexml/lua/api/units';
import { snapshotOf } from './unit-bridge';
import { itemData } from '../pipeline/dbc/item-data';
import { expandTextTokens } from './text-tokens';
import DBC from '../pipeline/dbc';
import type {
  QuestHandler, QuestTemplate, QuestItemTriple,
} from '../../network/game/object/quest';
import { QUEST_FLAGS } from '../../network/game/object/quest';
import { NPC_FLAG } from '../world/cursor-mode';
import { itemLink, itemTooltipLines } from './item-tooltip';
import { spellData } from '../pipeline/dbc/spell-data';
import {
  getItemTooltipSource, setItemTooltipSource, ItemTooltipInfo,
} from './framexml/lua/api/items';
import type { GossipQuest } from '../../network/game/object/gossip';
import { QUEST_STATE, QuestLogSlot } from '../../network/game/object/update-object/quest-log';

/**
 * One row of the flat list `GetNumQuestLogEntries` counts and `GetQuestLogTitle` indexes.
 *
 * The client's own list is headers AND quests in one 1-based sequence -- `QuestLog_Update` walks
 * `1..numEntries` and branches on the fifth return (`questlogframe.lua:401-430`). So the header rows
 * are the ENGINE's, built here; nothing on the wire carries them.
 */
/**
 * The `zoneOrSort` bucket for a quest whose template has not landed. Not a real zone id -- the field is
 * signed and small in practice, so a large negative cannot collide with an `AreaTable` or `QuestSort`
 * row.
 */
const NO_ZONE = -999999;

/**
 * Minimum gap between two `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` sends.
 *
 * UNSOURCED and said so: no file states a rate. It exists because the re-ask edge includes
 * `unit:fields`, which a health tick in combat also fires, and one small packet per second is the
 * cheapest bound that still refreshes a marker promptly after a quest is taken.
 */
const REASK_MIN_MS = 1000;

interface LogEntry {
  isHeader: boolean;
  /** Header rows: the zone or sort name. Quest rows: unused. */
  header: string;
  /** Quest rows: the descriptor slot, which is what `CMSG_QUESTLOG_REMOVE_QUEST` carries. */
  slot: number;
  questId: number;
  /** The `zoneOrSort` the row is grouped under. Headers carry their own. */
  zoneOrSort: number;
}

/**
 * The quest log's selected row -- ENGINE state, and at module scope for one reason only.
 *
 * `QuestLogFrame_OnLoad` calls `SelectQuestLogEntry(0)` (`questlogframe.lua:612`) while the MANIFEST is
 * loading, which is before any bridge attaches. The owner reported the resulting error three times:
 *
 *     QuestLogFrame.xml:QuestLogFrame: OnLoad: [string "QuestLogFrame.lua"]:612:
 *     attempt to call a nil value (global 'SelectQuestLogEntry')
 *
 * It was harmless -- the log re-selects when it opens -- but it is a real ordering defect and it will
 * keep surfacing. `installQuestLogSelection` registers the pair before the manifest runs; the bridge
 * re-registers the same names over the same variable, so there is one source of truth and no stub. The
 * value is reset at attach, because module state outliving a mount is the defect class this project has
 * already been bitten by four times.
 */
let logSelection = 0;

/**
 * The bridge's own abandon latch, reached by the EARLY registration below.
 *
 * `QuestLogFrame_OnLoad` walks `QuestLog_SetSelection`, which calls `SelectQuestLogEntry` and then
 * `SetAbandonQuest` (`questlogframe.lua:612,615`) -- both while the manifest is loading. Fixing only the
 * first moved the owner's error from line 612 to line 615, which is the whole lesson: the OnLoad needs
 * the SET, not one name at a time.
 *
 * A delegate rather than a second implementation: `SetAbandonQuest` has to latch the SELECTED row, and
 * the entry list lives inside the bridge. Before the bridge attaches there are no quests, so latching
 * nothing is the correct answer rather than a stub -- and once it attaches, these point at the real
 * thing and there is still exactly one implementation.
 */
let latchAbandon: (() => void) | null = null;

let abandonName: (() => string | null) | null = null;

export function installQuestLogSelection(vm: LuaVM): void {
  vm.registerFunction('SelectQuestLogEntry', (args) => {
    logSelection = Number(args[0]) || 0;
    return [];
  });
  vm.registerFunction('GetQuestLogSelection', () => [logSelection]);
  vm.registerFunction('SetAbandonQuest', () => {
    latchAbandon?.();
    return [];
  });
  vm.registerFunction('GetAbandonQuestName', () => [abandonName?.() ?? null]);
}

export function attachQuestBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const quest: QuestHandler = world.game.objectHandler.questHandler;
  const items = world.game.objectHandler.itemHandler;
  const combat = world.game.objectHandler.combatHandler;

  let disposed = false;

  void itemData.ensureLoaded();

  /**
   * THE MARKERS' DATA FEED, and THE RE-ASK LAW.
   *
   * `world.questMarkerStatuses` is handed the handler's live status map, which is what
   * `world/quest-markers.ts` draws from. Installed from here because this bridge is only attached on a
   * real session; an offline world leaves it null and the marker pass early-outs.
   *
   * **THE SERVER ONLY EVER ANSWERS, NEVER PUSHES, so every refresh point is ours to trigger** -- the
   * reference's phrasing is that "a status that is never re-asked for is a marker frozen at first
   * sight" (`benilla-app/src/quest_markers/query.rs:4-8`). Its law is a descriptor FIELD WATCH: six
   * self-player watches plus four packet handlers, and each firing sweeps every visible object with
   * one query apiece (`query.rs:25-46`).
   *
   * **3.3.5a collapses that whole sweep into ONE packet, and that is a version difference worth
   * stating rather than a simplification.** WotLK added
   * `CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY` (0x417), which asks for every nearby giver at once; the
   * 1.12 client has only the per-guid `CMSG_QUESTGIVER_STATUS_QUERY`, which is why the reference needs
   * an asked-set, a per-unit key and a prune. So the mechanism ported here is the reference's SWEEP --
   * re-ask when any input to the server's answer moves -- and the implementation is one send.
   *
   * The edges are the reference's, mapped onto what this client can see:
   *
   *  - **our own descriptor changed** -> `unit:fields` for the player. That is the reference's
   *    six field watches collapsed the same way: it recomputes only when its store actually changed,
   *    and this fires only on that edge.
   *  - **a quest event** -> accepted, turned in, abandoned, or an objective ticked. The reference's
   *    four packet handlers.
   *  - **entering the world** -> the attach below.
   *
   * THROTTLED, because `unit:fields` is not rare: a health tick in combat is that edge too. One send
   * per `REASK_MIN_MS` at most, which makes the worst case one small packet a second while something
   * about us is changing continuously, and zero when nothing is.
   */
  world.questMarkerStatuses = quest.status;

  let lastReaskMs = 0;
  const reaskStatuses = (): void => {
    if (disposed) {
      return;
    }
    const now = performance.now();
    if (now - lastReaskMs < REASK_MIN_MS) {
      return;
    }
    lastReaskMs = now;
    quest.queryStatusMultiple();
  };


  // -- Engine state ------------------------------------------------------------------------------

  /**
   * The selected row of the log, 1-based into the entry list, or 0 for none.
   *
   * ENGINE state: `SelectQuestLogEntry` is the only writer and `GetQuestLogSelection` the only reader,
   * and nothing in the manifest stores it. Same shape as `skills-bridge.ts`' collapsed-header set.
   */
  // Reset per attach: `logSelection` is module state so it can be installed BEFORE the manifest (see
  // `installQuestLogSelection`), and a second mount must not inherit the first one's row.
  logSelection = 0;

  /** Which headers are COLLAPSED, by `zoneOrSort`. Collapsed rather than expanded for the reason
   * `skills-bridge.ts` gives: every header is open on login, which is the real client's behaviour. */
  const collapsed = new Set<number>();

  /** Watched quest ids. See the header on why this has no server side. */
  const watched = new Set<number>();

  /** The quest the abandon popup is about, latched by `SetAbandonQuest`. */
  let abandoning: { slot: number; questId: number } | null = null;

  /** `zoneOrSort` -> name. Filled from `AreaTable.dbc` and `QuestSort.dbc`; empty until they land. */
  const sortNames = new Map<number, string>();
  let sortsRequested = false;

  /** The flat entry list, rebuilt whenever the log or the template cache changes. */
  let entries: LogEntry[] = [];

  // -- Reading the log ----------------------------------------------------------------------------

  const slots = (): QuestLogSlot[] => Array.from(world.player.questLog.values())
    .sort((a, b) => a.slot - b.slot);

  const templateOf = (questId: number): QuestTemplate | null => quest.templates.get(questId) ?? null;

  /**
   * The quest's title from ANY source: the template when it has landed, else whatever giver panel named
   * it. Null when this client genuinely does not know the quest's name, which is the only case where
   * omitting it from the list is honest.
   */
  const titleOf = (questId: number): string | null => {
    const fromTemplate = templateOf(questId)?.title;
    if (typeof fromTemplate === 'string' && fromTemplate !== '') {
      return fromTemplate;
    }
    const seeded = quest.titles.get(questId);
    return typeof seeded === 'string' && seeded !== '' ? seeded : null;
  };

  /**
   * `zoneOrSort` -> the header label.
   *
   * **POSITIVE is an `AreaTable.dbc` row and NEGATIVE is a `QuestSort.dbc` row.** That is a
   * SERVER-side convention (`Quest::GetZoneOrSort`, and `QuestSort.dbc` exists for exactly the classes
   * of quest -- professions, seasonal, class quests -- that belong to no zone), labelled as such: no
   * client file states the sign rule. A wrong sign costs a header label and never a row.
   */
  const headerFor = (zoneOrSort: number): string => sortNames.get(zoneOrSort) ?? '';

  const primeSortNames = (): void => {
    if (sortsRequested) {
      return;
    }
    sortsRequested = true;
    const learn = (
      table: { records?: { id: number; name?: string }[] } | null,
      sign: number,
    ): boolean => {
      let any = false;
      for (const record of table?.records ?? []) {
        if (record && typeof record.name === 'string' && record.name !== '') {
          sortNames.set(sign * record.id, record.name);
          any = true;
        }
      }
      return any;
    };
    void Promise.all([
      Promise.resolve(DBC.load('AreaTable')).catch(() => null),
      Promise.resolve(DBC.load('QuestSort')).catch(() => null),
    ]).then(([areas, sorts]) => {
      const a = learn(areas as never, 1);
      const b = learn(sorts as never, -1);
      if ((a || b) && !disposed) {
        // The list has already drawn by now, so re-announce down the same door the first paint came
        // through rather than mutating in place -- the same reasoning `api/characters.ts` gives for its
        // own zone-name fetch.
        rebuild();
        fireEvent(vm, 'QUEST_LOG_UPDATE');
      }
    });
  };

  /**
   * Rebuild the flat entry list. Returns whether it differs from the previous one.
   *
   * **A quest with no template yet is NOT listed**, and that is deliberate rather than a gap: every
   * string the row needs -- its title above all -- comes from `SMSG_QUEST_QUERY_RESPONSE`, and a row
   * with a nil title would go into `SetFormattedText` and raise. The template is asked for here, the
   * answer re-enters through `questTemplate`, and the list grows. One round trip, once per quest per
   * session, and `queryTemplate` dedupes so a repaint sends nothing.
   */
  const rebuild = (): boolean => {
    const rows = slots();
    for (const row of rows) {
      quest.queryTemplate(row.questId);
    }
    // **A TITLE IS THE BAR FOR LISTING, NOT A WHOLE TEMPLATE, and that is the fix for the owner's
    // "Quests: 1/25" beside "No Active Quests".** Requiring the template made the entry list and the
    // header count read different sources -- `GetNumQuestLogEntries` returns `entries.length` and
    // `world.player.questLog.size` -- so any lost or slow `CMSG_QUEST_QUERY` produced a count of 1 and
    // an empty list, with no way to open the row and nothing for the objectives tracker to read.
    //
    // `quest.titles` is seeded by every giver panel, so a quest accepted a moment ago is named with no
    // round trip at all. The description and objectives still come from the template and fill in when
    // it lands; a row that names the quest and lacks its detail is honest, an absent row is not.
    const known = rows.filter((row) => titleOf(row.questId) !== null);
    // Group by `zoneOrSort`, keeping each group's quests in descriptor order and the groups in the
    // order their first quest appears. The real client sorts alphabetically by header; this keeps the
    // log stable across repaints, which is what matters for a logSelection held by index.
    const groups = new Map<number, QuestLogSlot[]>();
    for (const row of known) {
      // NO TEMPLATE YET means no zone yet. `NO_ZONE` groups those together and its header is
      // suppressed below rather than drawn blank.
      const zone = templateOf(row.questId)?.zoneOrSort ?? NO_ZONE;
      const bucket = groups.get(zone);
      if (bucket === undefined) {
        groups.set(zone, [row]);
      } else {
        bucket.push(row);
      }
    }
    const next: LogEntry[] = [];
    for (const [zone, bucket] of groups) {
      // A header row is only worth a line when it has a NAME. A quest whose zone is unknown -- no
      // template yet, or a `zoneOrSort` neither DBC names -- lists without one, which the client's own
      // loop handles (it branches on the fifth return, and a headerless run is just quests).
      const header = zone === NO_ZONE ? '' : headerFor(zone);
      if (header !== '') {
        next.push({
          isHeader: true, header, slot: -1, questId: 0, zoneOrSort: zone,
        });
      }
      if (collapsed.has(zone)) {
        continue;
      }
      for (const row of bucket) {
        next.push({
          isHeader: false, header: '', slot: row.slot, questId: row.questId, zoneOrSort: zone,
        });
      }
    }
    // THE DISAGREEMENT CAN NEVER BE SILENT AGAIN. This is exactly the symptom the owner reported and
    // there was nothing in the console about it: the header counts the descriptor and the list counts
    // what could be named, so a gap between them is a real defect and says which quest ids are missing.
    const listed = next.filter((row) => !row.isHeader).length;
    if (listed < rows.length) {
      const missing = rows.filter((row) => titleOf(row.questId) === null).map((row) => row.questId);
      warnOnce(
        `quest log: ${rows.length} quests in the descriptor and ${listed} listed -- no title yet for `
        + `${missing.join(', ')}. The header will read a higher count than the list shows until `
        + 'SMSG_QUEST_QUERY_RESPONSE lands for them.',
      );
    }
    revision += 1;
    const same = next.length === entries.length
      && next.every((row, i) => row.isHeader === entries[i].isHeader
        && row.questId === entries[i].questId
        && row.header === entries[i].header);
    entries = next;
    return !same;
  };

  const entryAt = (index: number): LogEntry | null => entries[index - 1] ?? null;

  const selected = (): LogEntry | null => {
    const row = entryAt(logSelection);
    return row !== null && !row.isHeader ? row : null;
  };

  /** The template for an explicit entry index, or for the logSelection when none is given. */
  const templateAt = (index?: number): QuestTemplate | null => {
    const row = entryAt(index === undefined ? logSelection : index);
    return row === null || row.isHeader ? null : templateOf(row.questId);
  };

  /** The descriptor slot for an explicit entry index, or for the logSelection when none is given. */
  const slotAt = (index?: number): QuestLogSlot | null => {
    const row = entryAt(index === undefined ? logSelection : index);
    return row === null || row.isHeader ? null : world.player.questLog.get(row.slot) ?? null;
  };

  const selectedTemplate = (): QuestTemplate | null => {
    const row = selected();
    return row === null ? null : templateOf(row.questId);
  };

  const selectedSlot = (): QuestLogSlot | null => {
    const row = selected();
    return row === null ? null : world.player.questLog.get(row.slot) ?? null;
  };

  // -- Items --------------------------------------------------------------------------------------

  const iconForTriple = (triple: QuestItemTriple): string | null =>
    itemData.iconForDisplayId(triple.displayId) ?? itemData.iconForEntry(triple.itemId);

  const iconForEntry = (entry: number): string | null => itemData.iconForEntry(entry);

  /**
   * Register whatever icons the open panel resolves to, for the reason `merchant-bridge.ts` gives:
   * `iconFor*` answers null until `ItemDisplayInfo.dbc` is in memory, so a panel opened during that
   * fetch would otherwise register nothing and never come back. `art.register` is idempotent.
   */
  const registerPanelArt = (triples: QuestItemTriple[]): void => {
    for (const triple of triples) {
      const path = iconForTriple(triple);
      if (path !== null) {
        art.register(path, { path });
      }
      // The template is what a name comes from, and asking here is what ISSUES the query.
      items.template(triple.itemId);
    }
    void art.load();
  };

  /** How many of an item the player holds. Through the client's own `GetItemCount`, which
   * `container-bridge.ts` owns -- so there is one bag-counting implementation, not two. */
  const itemCount = (entry: number): number => {
    const result = vm.runExpr(
      `return GetItemCount(${entry >>> 0})`, 'quest-itemcount.lua',
    ) as { value?: unknown } | null;
    const value = Number(result?.value ?? 0);
    return Number.isFinite(value) ? value : 0;
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  // -- The giver panels: text ---------------------------------------------------------------------

  /**
   * `GetTitleText()` -- the open panel's quest title.
   *
   * All four panels share it, so it reads whichever is open. `QuestInfo_ShowTitle` uses it only on the
   * NON-log branch (`questinfo.lua:93`).
   */
  /**
   * Every server-authored string goes through the token pass -- `$n`, `$c`, `$b`,
   * `$g male:female;`. See `ui/text-tokens.ts` for the evidence behind each binding and for the one
   * token deliberately left visible.
   *
   * At the GETTER rather than at the decode, so the substitution follows the character rather than the
   * packet: the same quest text read by two characters must name each of them, and the template cache
   * outlives a character change.
   */
  const tok = (text: string | null | undefined): string => expandTextTokens(vm, text);

  fn('GetTitleText', () => [
    tok(quest.details?.title ?? quest.offer?.title ?? quest.progress?.title ?? ''),
  ]);

  /** `GetQuestText()` -- the accept panel's description. `QuestInfo_ShowDescriptionText`. */
  fn('GetQuestText', () => [tok(quest.details?.details)]);

  /** `GetObjectiveText()` -- the accept panel's objectives line. `QuestInfo_ShowObjectivesText`. */
  fn('GetObjectiveText', () => [tok(quest.details?.objectives)]);

  /** `GetProgressText()` -- the progress panel's "bring me these" text. */
  fn('GetProgressText', () => [tok(quest.progress?.requestText)]);

  /** `GetRewardText()` -- the reward panel's turn-in text. */
  fn('GetRewardText', () => [tok(quest.offer?.offerText)]);

  /** `GetGreetingText()` -- the multi-quest greeting panel's blurb. */
  fn('GetGreetingText', () => [tok(quest.greeting?.greeting)]);

  // -- The greeting panel -------------------------------------------------------------------------

  /**
   * `GetNumActiveQuests()` / `GetNumAvailableQuests()`.
   *
   * `SMSG_QUESTGIVER_QUEST_LIST` has ONE quest array and the split is by the row's `icon`, which is a
   * `DIALOG_STATUS` value: a row the player already has is INCOMPLETE or one of the REWARD statuses,
   * and an offer is AVAILABLE. `QuestFrameGreetingPanel_OnShow` draws the active block first and then
   * the available block, indexing each from 1 (`questframe.lua:214-286`), so the two lists must be
   * separate here or `SelectActiveQuest(2)` would ask for the wrong quest.
   *
   * The threshold is `DIALOG_STATUS.INCOMPLETE` and above meaning "in your log". That is a SERVER-side
   * ladder (`QuestDef.h`), labelled as such, and it is the same one `world/cursor-mode.ts` already
   * consults for the questgiver cursor.
   */
  const listRows = () => quest.greeting?.quests ?? [];

  const activeRows = () => listRows().filter((row) => row.icon >= 5);

  const availableRows = () => listRows().filter((row) => row.icon < 5);

  fn('GetNumActiveQuests', () => [activeRows().length]);

  fn('GetNumAvailableQuests', () => [availableRows().length]);

  /**
   * `GetActiveTitle(index)` -> `title, isComplete`.
   *
   * `isComplete` is derived from the row's `DIALOG_STATUS`: `REWARD_REP`(6), `AVAILABLE_REP`(7),
   * `REWARD2`(9) and `REWARD`(10) all mean "ready to turn in", `INCOMPLETE`(5) does not. It chooses
   * between `ActiveQuestIcon` and `IncompleteQuestIcon` (`questframe.lua:230-234`).
   */
  fn('GetActiveTitle', (args) => {
    const row = activeRows()[Number(args[0]) - 1];
    if (row === undefined) {
      return [];
    }
    return [row.title, row.icon === 6 || row.icon === 9 || row.icon === 10];
  });

  fn('GetAvailableTitle', (args) => {
    const row = availableRows()[Number(args[0]) - 1];
    return [row === undefined ? null : row.title];
  });

  /** See the header: always false, and it is the standing project decision `gossip-bridge.ts` states. */
  fn('IsActiveQuestTrivial', () => [false]);

  /**
   * `GetAvailableQuestInfo(index)` -> `isTrivial, isDaily, isRepeatable`.
   *
   * THREE returns, read off the client's own destructure (`questframe.lua:266`). Daily and weekly both
   * take the daily icon; the flags are `QUEST_FLAGS_DAILY`/`WEEKLY`, server-side and labelled as such
   * in `object/quest.ts`. `SMSG_QUESTGIVER_QUEST_LIST` carries a per-row flags BYTE rather than the
   * whole flags word, and this client reads it for the residual and does not keep it -- so daily and
   * repeatable are answered false here and the ordinary `AvailableQuestIcon` is drawn. Stated rather
   * than guessed: a wrong icon is the whole cost, and Northshire has no daily quests.
   */
  fn('GetAvailableQuestInfo', () => [false, false, false]);

  /**
   * `SelectActiveQuest(index)` / `SelectAvailableQuest(index)` -- the greeting panel's rows.
   *
   * Both send `CMSG_QUESTGIVER_QUERY_QUEST`; the server decides which panel comes back, which is why
   * there is one send for two globals. `QuestTitleButton_OnClick` picks between them off the button's
   * own `isActive` (`questframe.lua:306-312`).
   */
  fn('SelectActiveQuest', (args) => {
    const row = activeRows()[Number(args[0]) - 1];
    if (row !== undefined) {
      quest.queryQuest(row.questId, quest.greeting?.npc);
    }
    return [];
  });

  fn('SelectAvailableQuest', (args) => {
    const row = availableRows()[Number(args[0]) - 1];
    if (row !== undefined) {
      quest.queryQuest(row.questId, quest.greeting?.npc);
    }
    return [];
  });

  /**
   * `SelectGossipAvailableQuest(index)` / `SelectGossipActiveQuest(index)` -- the GOSSIP menu's rows,
   * and **THE ONLY HOME FOR THEM.**
   *
   * They live here because this bridge is attached AFTER `gossip-bridge.ts` in `world-ui.ts`, so
   * whatever it registers wins. That ordering turned a duplicate into a silent defect: a correct
   * implementation was added to the gossip file -- with the reference's opcode law and an explicit giver
   * guid -- and it was dead code, overridden by the version here, which sent `CMSG_QUESTGIVER_QUERY_QUEST`
   * for BOTH pools. The owner saw exactly that: a gold `?` on a completed quest, a click that opened
   * nothing, and `0x186` on the wire where `0x18A` belongs. `gossip-bridge.ts` now carries a pointer
   * here instead of a second copy.
   *
   * THE OPCODE LAW IS THE REFERENCE'S, byte-verified: `SelectActiveQuest` (`0x501320`) sends
   * COMPLETE_QUEST **unconditionally**, and an AVAILABLE row sends COMPLETE_QUEST when its icon is 0 --
   * the "one-click" flag at the pool record's `+0x48`, read at `0x5012db` to pick `0x18a` over `0x186` --
   * else QUERY_QUEST (`benilla-app/src/ui_quest.rs:280,557`, `ui_gossip.rs:430-433`).
   *
   * `GossipTitleButton_OnClick` passes `self:GetID()`, which the two update functions set to the 1-based
   * row of their OWN list, so each select indexes the list it belongs to.
   *
   * The giver guid is passed EXPLICITLY: `QuestHandler#source` is only set once a quest packet has
   * arrived, so on a freshly opened menu it is null or still the previous NPC.
   */
  const selectGossipRow = (rows: GossipQuest[], at: number, active: boolean): void => {
    const gossip = world.game.objectHandler.gossipHandler;
    const row = rows[Number(at) - 1];
    const npc = gossip.source ?? undefined;
    if (row === undefined) {
      return;
    }
    if (active || row.icon === 0) {
      quest.completeQuest(row.questId, npc);
    } else {
      quest.queryQuest(row.questId, npc);
    }
  };

  fn('SelectGossipAvailableQuest', (args) => {
    const gossip = world.game.objectHandler.gossipHandler;
    selectGossipRow(gossip.availableQuests, Number(args[0]), false);
    return [];
  });

  fn('SelectGossipActiveQuest', (args) => {
    const gossip = world.game.objectHandler.gossipHandler;
    selectGossipRow(gossip.activeQuests, Number(args[0]), true);
    return [];
  });

  // -- The progress panel -------------------------------------------------------------------------

  /** `GetNumQuestItems()` -- how many items the progress panel asks the player to hand over. */
  fn('GetNumQuestItems', () => [quest.progress?.requiredItems.length ?? 0]);

  /**
   * `GetQuestMoneyToGet()` -- copper the turn-in COSTS.
   *
   * A NUMBER, never nil: `QuestFrameProgressItems_Update` compares it with `GetMoney()` and
   * `QuestRewardCompleteButton_OnClick` does `if ( money and money > 0 )` (`questframe.lua:95`), so nil
   * would be an arithmetic error in the first and a skipped branch in the second.
   */
  fn('GetQuestMoneyToGet', () => [quest.progress?.requiredMoney ?? 0]);

  /**
   * `IsQuestCompletable()` -- whether the progress panel's Continue button is enabled.
   *
   * Straight off `SMSG_QUESTGIVER_REQUEST_ITEMS`' second trailing flag word, which is the only
   * completability signal on that wire. Deriving it from the descriptor's COMPLETE bit instead would be
   * a second, differently-timed answer to a question the server already answered in this packet.
   */
  fn('IsQuestCompletable', () => [quest.progress?.isComplete ?? false]);

  // -- Items on the giver panels ------------------------------------------------------------------

  /**
   * `GetQuestItemInfo(type, index)` -> `name, texture, numItems, quality, isUsable`.
   *
   * FIVE returns, read off the client's own destructure (`questinfo.lua:311`), and `type` is one of
   * `"required"`, `"reward"`, `"choice"` -- the strings the documents put on the buttons themselves
   * (`questframe.lua:180`, `questinfo.lua:305,417`).
   *
   * `name` is **null while the item query is in flight** rather than a placeholder, which is the same
   * rule `GetMerchantItemInfo` and `GetLootSlotInfo` follow: `SetText(nil)` leaves the label empty and
   * the button still draws with its icon and count, whereas inventing a name would be a claim.
   *
   * `isUsable` is always true for the reason `merchant-bridge.ts` states: `items.ts` reads
   * `allowableClass`/`allowableRace` and discards both, so the question has no answer here, and true is
   * the direction that never paints a usable reward red.
   */
  /**
   * `GameTooltip:SetQuestItem(type, index)` -- the reward and requirement rows' own tooltip.
   *
   * MEASURED, the owner's console on hovering a reward:
   *
   *     QuestInfoItem3: OnEnter: [string "QuestInfo.xml:QuestInfoItem3:OnEnter"]:10:
   *     attempt to call a nil value (method 'SetQuestItem')
   *
   * A nil method inside an `OnEnter` is the worst place for one -- it kills the handler part way, so the
   * tooltip chain is left half built and the row shows nothing however good the data is. Same shape as
   * `SetInventoryItem`'s absence on the bag buttons, which this file's sibling already records.
   *
   * CHAINED, not installed flat: every bridge that answers a tooltip kind captures the previous source
   * and delegates what is not its own (`merchant-bridge.ts`, `loot-bridge.ts`, `trainer-bridge.ts` all
   * do this), so the order bridges attach in cannot make one of them shadow the rest. Restored on
   * teardown for the same reason.
   *
   * The three kinds are the client's own strings on the buttons themselves -- `"required"`, `"reward"`,
   * `"choice"` -- and they resolve through exactly the triple `GetQuestItemInfo` reads, so the tooltip
   * and the row can never name different items.
   */
  const previousTooltipSource = getItemTooltipSource(vm);
  const questTooltip = (
    kind: string, a: number | string, b?: number,
  ): ItemTooltipInfo | null => {
    if (kind !== 'quest' && kind !== 'questlog') {
      return previousTooltipSource === null
        ? null
        : previousTooltipSource(kind as never, a as never, b);
    }
    /**
     * TWO KINDS, because the client asks two different questions of two different sources.
     *
     * `QuestInfoRewardItemTemplate`'s `OnEnter` branches on `QuestInfoFrame.questLog`: the LOG calls
     * `SetQuestLogItem` and a giver panel calls `SetQuestItem` (`questinfo.xml:12-16`). That is the same
     * split this file's header already records for the info accessors -- the giver family reads the OPEN
     * PANEL, which is self-contained on the wire, and the log family reads the TEMPLATE CACHE joined to
     * the descriptor slots. Routing both through one resolver would name the wrong item whenever the log
     * is open over a different quest than the last giver panel showed.
     *
     * The owner's console named the missing half: `QuestInfoItem2: OnEnter: attempt to call a nil value
     * (method 'SetQuestLogItem')`.
     */
    const triple = kind === 'questlog'
      ? logTripleAt(String(a), Number(b))
      : questTripleAt(String(a), Number(b));
    const template = triple === undefined ? null : items.template(triple.itemId);
    if (template === null) {
      return null;
    }
    return {
      name: template.name,
      quality: template.quality,
      lines: itemTooltipLines(vm, template, {
        playerLevel: world.player.level,
        spellName: (id: number) => spellData.spell(id)?.name ?? null,
      }),
    };
  };
  setItemTooltipSource(vm, questTooltip as never);

  /**
   * The LOG's `{itemId, count, displayId}` for a `type`/`index` pair -- the template cache, not the open
   * panel. Declared here and defined against `logRewards`/`logChoices` further down, which are the same
   * readers `GetQuestLogRewardInfo`/`GetQuestLogChoiceInfo` answer from, so the tooltip and the row can
   * never disagree.
   *
   * Typed by the ONE field the tooltip needs: a template's reward rows are `QuestItemPair`s and carry no
   * `displayId` -- only the wire's giver panels do -- so widening them to a triple here would be a lie
   * about the data rather than a convenience.
   */
  const logTripleAt = (kind: string, oneBased: number): { itemId: number } | undefined => (
    kind === 'choice' ? logChoices()[oneBased - 1] : logRewards()[oneBased - 1]
  );

  /** The `{itemId, count, displayId}` a `type`/`index` pair names. One reader for the row and the tooltip. */
  function questTripleAt(kind: string, oneBased: number): QuestItemTriple | undefined {
    const index = oneBased - 1;
    if (kind === 'required') {
      return quest.progress?.requiredItems[index];
    }
    if (kind === 'choice') {
      return (quest.offer ?? quest.details)?.choices[index];
    }
    return (quest.offer ?? quest.details)?.rewards[index];
  }

  /**
   * `GetQuestItemLink(type, index)` -- the shift-click that puts a quest item into chat.
   *
   * MEASURED, the owner's console:
   *
   *     QuestProgressItem1: OnClick: [string "QuestFrame.xml:QuestProgressItem1:OnClick"]:8:
   *     attempt to call a nil value (global 'GetQuestItemLink')
   *
   * Same triple the row and the tooltip read, and the same link format the merchant rows answer -- which
   * is why `itemLink` moved into `item-tooltip.ts` rather than being written a second time here.
   */
  fn('GetQuestItemLink', (args) => {
    const triple = questTripleAt(String(args[0] ?? ''), Number(args[1]));
    return [triple === undefined ? null : itemLink(vm, items.template(triple.itemId))];
  });

  fn('GetQuestItemInfo', (args) => {
    const triple = questTripleAt(String(args[0] ?? ''), Number(args[1]));
    if (triple === undefined) {
      return [];
    }
    const template = items.template(triple.itemId);
    return [
      template?.name ?? null,
      iconForTriple(triple),
      triple.count,
      template?.quality ?? 1,
      true,
    ];
  });

  /**
   * `GetNumQuestChoices()` / `GetNumQuestRewards()` -- the giver panel's two reward blocks.
   *
   * NUMBERS, never nil: `QuestInfo_ShowRewards` adds them (`questinfo.lua:295`).
   *
   * **`GetNumQuestChoices` is also the guard on turning in without picking.**
   * `QuestRewardCompleteButton_OnClick` refuses to send while `itemChoice == 0` and this is `> 0`
   * (`questframe.lua:91-93`) -- so an under-report here would let the player complete a choice quest
   * with no logSelection and the SERVER would pick for him.
   */
  fn('GetNumQuestChoices', () => [(quest.offer ?? quest.details)?.choices.length ?? 0]);

  fn('GetNumQuestRewards', () => [(quest.offer ?? quest.details)?.rewards.length ?? 0]);

  const panel = () => quest.offer ?? quest.details;

  fn('GetRewardMoney', () => [Math.max(0, panel()?.money ?? 0)]);
  fn('GetRewardXP', () => [panel()?.xp ?? 0]);
  fn('GetRewardHonor', () => [panel()?.honor ?? 0]);
  fn('GetRewardTalents', () => [panel()?.bonusTalents ?? 0]);
  fn('GetRewardArenaPoints', () => [panel()?.arenaPoints ?? 0]);

  /**
   * `GetRewardTitle()` -- NIL, not 0, when the quest awards no title. See the header's `0` section:
   * `QuestInfo_ToggleRewardElement` shows its frame for any truthy value.
   *
   * When there IS one, the id is answered rather than the name: `CharTitles.dbc` is not loaded and
   * `QuestInfoPlayerTitleFrameTitle:SetText(value)` would print the number. Stated rather than hidden
   * -- a numeric title reward line is wrong-looking and rare; an invented name would be a fabrication.
   */
  fn('GetRewardTitle', () => {
    const id = panel()?.charTitleId ?? 0;
    return [id === 0 ? null : id];
  });

  /**
   * `GetRewardSpell()` -> `texture, name, isTradeskillSpell, isSpellLearned`, or nothing.
   *
   * `QuestInfo_ShowRewards` calls it TWICE -- once as a boolean test and once for the four values
   * (`questinfo.lua:285,384`) -- so returning nothing for "no spell reward" is what keeps
   * `numQuestSpellRewards` at 0.
   *
   * A DECLARED GAP when there IS one: the four values need `Spell.dbc`'s icon and name for the reward
   * spell, and this bridge has no spell join (`spellbook-bridge.ts` owns it). Answering nothing means a
   * spell-reward quest shows its items and not its spell, which is a missing row rather than a wrong
   * one.
   */
  const spellGap = notImplemented(
    'GetRewardSpell',
    'the reward spell needs a Spell.dbc icon/name join, which spellbook-bridge.ts owns',
    [],
  );
  fn('GetRewardSpell', () => (
    (panel()?.rewardSpell ?? 0) === 0 ? [] : spellGap(null as never, 0, [])
  ));

  /** `GetSuggestedGroupNum()` -- the giver panel's "Suggested Players [n]". A NUMBER. */
  fn('GetSuggestedGroupNum', () => [panel()?.suggestedPlayers ?? 0]);

  /**
   * `QuestFlagsPVP()` -- gates `CONFIRM_ACCEPT_PVP_QUEST` before the accept goes out
   * (`questframe.lua:328-330`). `QUEST_FLAGS_PVP` is 0x80, server-side and labelled as such.
   */
  fn('QuestFlagsPVP', () => [((quest.details?.flags ?? 0) & QUEST_FLAGS.PVP) !== 0]);

  /**
   * `QuestGetAutoAccept()` -- **FALSE, and it is a TRUE answer rather than a stub.**
   *
   * **This returning true is what made the owner's Accept button do nothing and his Decline button
   * disappear, and it was one cause for both symptoms.** `QuestFrameDetailPanel_OnShow` does
   * `QuestFrameDeclineButton:Hide()` and `QuestFrame.autoQuest = true` on a true
   * (`questframe.lua:319-325`), and `QuestDetailAcceptButton_OnClick` then takes
   * `HideUIPanel(QuestFrame)` instead of `AcceptQuest()` (`:331-336`) -- so the page loses its Decline
   * button AND its Accept button silently closes the window without sending a packet. Exactly the
   * report.
   *
   * It used to read `SMSG_QUESTGIVER_QUEST_DETAILS`' byte, which this client had named `autoLaunched`.
   * That byte is TrinityCore's **`activateAccept`** and `HandleQuestgiverQueryQuestOpcode` passes
   * `true`, so it is 1 for every quest clicked at a giver. The name carried the error: two different
   * ideas under one word.
   *
   * FALSE is the honest answer for **every path this client can reach.** An auto-accepted quest is one
   * the player never chose -- started by an item, an area trigger, or a party share -- and this client
   * implements none of those: every detail panel it opens is the answer to a
   * `CMSG_QUESTGIVER_QUERY_QUEST` the player's own click sent. The day one of those paths exists, it
   * will know it from its own opener rather than from a byte that means something else.
   */
  fn('QuestGetAutoAccept', () => [false]);

  // -- The giver panels: actions ------------------------------------------------------------------

  /**
   * `AcceptQuest()` -- and then BACK TO THE GIVER'S PAGE.
   *
   * The owner: accepting should return to the gossip list, as it does in the real client; ours closed
   * and stopped. **Nothing in the client's own Lua re-opens it** -- grepped `questframe.lua`, whose
   * only `Gossip` references are the six icon paths in the greeting panel -- and the server's reply is
   * `SMSG_GOSSIP_COMPLETE`, which by design CLOSES the window (`object/gossip.ts#close`). So the
   * re-show is the engine's, and it is done here by re-sending the hello the menu was opened with.
   *
   * **Gated on the door actually having been a gossip menu.** `gossip.source` is non-null only while a
   * menu is open, and it is captured BEFORE the accept because `SMSG_GOSSIP_COMPLETE` clears it. A
   * quest reached from `SMSG_QUESTGIVER_QUEST_LIST` (a giver with no gossip text) has no gossip session
   * to return to, and one reached from a quest item has no giver at all; both correctly do nothing.
   *
   * `gossipHandler.hello` is called rather than re-implemented -- that send belongs to the merchant
   * path's file and there is one copy of it. This is a read of their public API and changes nothing in
   * it.
   *
   * **Labelled honestly: the re-send is matched to the owner's observation of the real client, not to a
   * cited file.** 3.3.5a's own `HandleQuestgiverAcceptQuestOpcode` ends in `SendCloseGossip()`, so the
   * SERVER closes the window; how the retail client comes back to the list is not something this
   * project can read. A second hello is the mechanism that produces the observed behaviour with the
   * packets we have, and it costs one round trip on a gesture the player just made.
   */
  fn('AcceptQuest', () => {
    const gossip = world.game.objectHandler.gossipHandler;
    const giver = gossip.source;
    quest.acceptQuest();
    if (giver !== null) {
      gossip.hello(giver);
    }
    return [];
  });

  /**
   * `DeclineQuest()` -- the Decline, Cancel and Goodbye buttons, all three
   * (`questframe.lua:85,110,317`).
   *
   * Sends `CMSG_QUESTGIVER_CANCEL`; the window's close comes back as `SMSG_GOSSIP_COMPLETE`. The panels
   * are cleared here as well so a second click cannot re-send against a stale quest id.
   */
  fn('DeclineQuest', () => {
    quest.cancel();
    quest.closePanels();
    return [];
  });

  /** `CompleteQuest()` -- the progress panel's Continue. `CMSG_QUESTGIVER_COMPLETE_QUEST`. */
  fn('CompleteQuest', () => {
    quest.completeQuest();
    return [];
  });

  /**
   * `GetQuestReward(choice)` -- the reward panel's Complete Quest button. THE TURN-IN.
   *
   * **`choice` is 1-BASED from the document and 0-BASED on the wire.** `QuestInfoItem_OnClick` stores
   * `self:GetID()` and the buttons are numbered from a 1-based Lua loop (`questinfo.lua:26-32`,
   * `:317`), while `CMSG_QUESTGIVER_CHOOSE_REWARD` carries an index into the choice array. So one is
   * subtracted here, and a quest with no choices sends 0 -- which is what `QuestInfoFrame.itemChoice`
   * is when nothing was picked and what the server ignores.
   *
   * The `- 1` is the whole reason this comment exists: getting it wrong hands out the wrong item on
   * every choice quest, and the two-item case looks plausible either way.
   */
  fn('GetQuestReward', (args) => {
    const choice = Number(args[0] ?? 0);
    quest.chooseReward(choice > 0 ? choice - 1 : 0);
    return [];
  });

  /**
   * `QuestChooseRewardError()` -- the client's own "you must choose a reward" refusal, raised by
   * `QuestRewardCompleteButton_OnClick` when nothing is selected (`questframe.lua:92`).
   *
   * The real engine prints `ERR_QUEST_MUST_CHOOSE_ITEM` through the error frame. `UIErrorsFrame` is the
   * client's own frame and `AddMessage` is its own method, so this goes down that door rather than
   * inventing a channel.
   */
  fn('QuestChooseRewardError', () => {
    vm.runExpr(
      'if UIErrorsFrame then UIErrorsFrame:AddMessage('
      + '(ERR_QUEST_MUST_CHOOSE_ITEM or "You must choose a reward."), 1.0, 0.1, 0.1, 1.0) end',
      'quest-reward-error.lua',
    );
    return [];
  });

  /** `CloseQuest()` -- `QuestFrame_OnHide` and the panel's bail-out. */
  fn('CloseQuest', () => {
    quest.closePanels();
    return [];
  });

  /**
   * `GetQuestBackgroundMaterial()` -- NIL, and that is a TRUE answer.
   *
   * `QuestFrame_GetMaterial` substitutes `"Parchment"` for a nil (`questframe.lua:378-384`), which is
   * the ordinary paper every quest in the game outside a few scripted ones uses. The material comes
   * from the quest giver's `QuestFrame.dbc`-side art in the real client and nothing on this wire
   * carries it, so nil is both the honest answer and the right-looking one.
   */
  fn('GetQuestBackgroundMaterial', () => [null]);

  // -- The quest log ------------------------------------------------------------------------------

  /**
   * `GetNumQuestLogEntries()` -> `numEntries, numQuests`.
   *
   * TWO returns (`questlogframe.lua:332`). `numEntries` counts HEADERS AND QUESTS -- the flat list the
   * row loop walks -- and `numQuests` counts only quests, for the "Quest Log (n/25)" label.
   *
   * `numQuests` is the size of the DESCRIPTOR block, not of the resolved list, so the label is right
   * from the first paint even while a template is still in flight; `numEntries` is the resolved list,
   * for the reason `rebuild` gives.
   */
  fn('GetNumQuestLogEntries', () => [
    entries.length,
    world.player.questLog.size,
  ]);

  /**
   * `GetQuestLogTitle(index)` ->
   * `title, level, questTag, suggestedGroup, isHeader, isCollapsed, isComplete, isDaily, questID,
   * displayQuestID`.
   *
   * TEN returns, read off the client's own destructure (`questlogframe.lua:401`). Four call sites take
   * only the first six (`:626,683,715,723`), which is why the tail must still be in the right ORDER
   * rather than merely present.
   *
   * **`title` is nil for an out-of-range index and that is load-bearing.**
   * `QuestLog_GetFirstSelectableQuest` walks upward until the title is nil (`:680-690`), so a
   * placeholder would make it loop to `numEntries` and select nothing.
   *
   * `isComplete` is the descriptor's COMPLETE bit -- `1` rather than `true`, because
   * `QuestLogTitleButton_Resize` compares it against `1` in one place and truth-tests it in another,
   * and `1` satisfies both. A FAILED quest answers `-1`, which is what the real client returns and what
   * `QuestLog_Update` paints with the failed icon.
   */
  fn('GetQuestLogTitle', (args) => {
    const row = entryAt(Number(args[0]));
    if (row === null) {
      return [];
    }
    if (row.isHeader) {
      return [
        row.header, 0, null, 0, 1, collapsed.has(row.zoneOrSort) ? 1 : null,
        // `questID` and `displayQuestID` are NIL, not 0. A header owns no quest, and **0 IS TRUTHY IN
        // LUA** -- `questlogframe.lua:427` is `if (questID and displayQuestID)`, so a pair of zeroes
        // reads as "print the id" just as loudly as a real id does.
        null, null, null, null,
      ];
    }
    const template = templateOf(row.questId);
    const slot = world.player.questLog.get(row.slot) ?? null;
    const state = slot?.state ?? 0;
    let complete: number | null = null;
    if ((state & QUEST_STATE.FAIL) !== 0) {
      complete = -1;
    } else if ((state & QUEST_STATE.COMPLETE) !== 0) {
      complete = 1;
    }
    return [
      // The same any-source title `rebuild` listed the row on -- these two must never disagree, or the
      // list would show a row whose title reads nil and `QuestLogTitleButton_Resize` would raise on it.
      titleOf(row.questId),
      template?.level ?? 0,
      // `questTag` is the "Elite"/"Dungeon"/"PvP" suffix, from the template's `type`. Nil rather than
      // an invented string: the mapping is `QuestInfo.dbc`, which is not loaded, and
      // `QuestLogTitleButton_Resize` only appends it when it is non-nil.
      null,
      template?.suggestedPlayers ?? 0,
      null,
      null,
      complete,
      ((template?.flags ?? 0) & QUEST_FLAGS.DAILY) !== 0
        || ((template?.flags ?? 0) & QUEST_FLAGS.WEEKLY) !== 0,
      row.questId,
      /**
       * `displayQuestID` is NIL, and returning the id here put the number in every row's label.
       *
       * The owner's screenshot read "783 - A Threat Within". `questlogframe.lua:427` is
       * `if (questID and displayQuestID) then title = questID.." - "..title; end` -- it is the client's
       * own *debug* option for showing quest ids, off unless the player turned it on. The tenth return
       * is that flag, not a second copy of the ninth; the two happen to sit next to each other in the
       * destructure at `:401`, which is exactly how they got confused.
       *
       * Nothing here can ever turn it on: there is no CVar or slash command in this client that would,
       * so nil is the whole of the correct answer rather than a placeholder.
       */
      null,
    ];
  });

  /** `SelectQuestLogEntry(index)` / `GetQuestLogSelection()` -- engine state, see `logSelection`. */
  fn('SelectQuestLogEntry', (args) => {
    logSelection = Number(args[0]) || 0;
    revision += 1;
    return [];
  });

  fn('GetQuestLogSelection', () => [logSelection]);

  /**
   * `GetQuestLogQuestText()` -> `description, objectivesText`.
   *
   * TWO returns and the SECOND is what `QuestInfo_ShowObjectivesText` destructures
   * (`questinfo.lua:237`). Their order on the WIRE is the reverse -- the query response writes
   * objectives before details -- which is exactly the reversal `object/quest.ts` documents.
   */
  fn('GetQuestLogQuestText', () => {
    const template = selectedTemplate();
    return [tok(template?.details), tok(template?.objectivesText)];
  });

  /**
   * `GetNumQuestLeaderBoards([index])` -- how many objective lines the selected quest has.
   *
   * The count is the creature/gameobject objectives with a nonzero requirement plus the item
   * objectives with a nonzero count, in that order -- which is the order `GetQuestLogLeaderBoard`
   * indexes and the order the four objective TEXTS belong to.
   */
  interface LeaderBoardRow {
    kind: 'monster' | 'item';
    name: string | null;
    have: number;
    need: number;
  }

  /**
   * MEMOISED, and this is a performance fix from the self-review rather than a flourish.
   *
   * `QuestInfo_ShowObjectives` calls `GetNumQuestLeaderBoards()` once and `GetQuestLogLeaderBoard(i)`
   * once per objective (`questinfo.lua:112-117`), and the tracker does the same per WATCHED quest. Each
   * call rebuilt the whole row list, and each item row inside it ran a `vm.runExpr` for `GetItemCount`
   * -- so a six-objective quest cost 7 rebuilds and 42 VM round trips per repaint. The cache turns that
   * into one rebuild and six.
   *
   * Invalidated by `revision`, which every writer bumps: the descriptor edge, a template landing, a
   * logSelection change and a header collapse. A BAG change is covered by the descriptor edge because the
   * inventory slots are player fields, so `unit:fields` fires for them too -- which is what makes an
   * item objective un-tick when the item is destroyed.
   */
  let revision = 0;
  let boardCache: { revision: number; index: number; rows: LeaderBoardRow[] } | null = null;

  const leaderBoards = (index?: number): LeaderBoardRow[] => {
    // `GetNumQuestLeaderBoards([questIndex])` and `GetQuestLogLeaderBoard(i[, questIndex])` BOTH take
    // an optional entry index, and the objective TRACKER always passes one
    // (`watchframe.lua:805,839`). Answering the logSelection's objectives for a watched quest would show
    // one quest's progress under every other quest's title -- found in the self-review, not live.
    const at = index === undefined || index === 0 ? logSelection : index;
    if (boardCache !== null && boardCache.revision === revision && boardCache.index === at) {
      return boardCache.rows;
    }
    const rows = buildLeaderBoards(at);
    boardCache = { revision, index: at, rows };
    return rows;
  };

  const buildLeaderBoards = (index: number): LeaderBoardRow[] => {
    const entry = entryAt(index);
    const target = entry !== null && !entry.isHeader ? entry : null;
    const template = target === null ? null : templateOf(target.questId);
    const slot = target === null ? null : world.player.questLog.get(target.slot) ?? null;
    if (template === null) {
      return [];
    }
    const rows: LeaderBoardRow[] = [];
    template.objectives.forEach((objective, i) => {
      if (objective.requiredCount === 0) {
        return;
      }
      // The objective's own text wins; failing that, the creature's name if it has ever been in view.
      // See the header on why an unseen creature is answered as counts only.
      const entry = objective.creatureOrGo;
      const named = objective.text !== ''
        ? objective.text
        : (entry & 0x80000000) === 0 ? combat.creatureInfo(entry)?.name ?? null : null;
      rows.push({
        kind: 'monster',
        name: named,
        have: slot?.counters[i] ?? 0,
        need: objective.requiredCount,
      });
    });
    for (const required of template.requiredItems) {
      if (required.count === 0) {
        continue;
      }
      rows.push({
        kind: 'item',
        name: items.template(required.itemId)?.name ?? null,
        // THE BAG COUNT, not the descriptor counter: an item objective is satisfied by holding the
        // items, so destroying one must un-tick the line. `GetItemCount` is the client's own global and
        // `container-bridge.ts` owns the one implementation of it.
        have: itemCount(required.itemId),
        need: required.count,
      });
    }
    return rows;
  };

  fn('GetNumQuestLeaderBoards', (args) => [leaderBoards(Number(args[0]) || undefined).length]);

  /**
   * `GetQuestLogLeaderBoard(index)` -> `text, type, finished`.
   *
   * THREE returns (`questinfo.lua:120`, `questlogframe.lua`'s watch loop). `type` is the string the
   * client falls back to when `text` is empty, so it must be a real objective kind and not a label.
   *
   * The text is the game's own format string -- `QUEST_MONSTERS_KILLED` `"%s slain: %d/%d"` and
   * `QUEST_ITEMS_NEEDED` `"%s: %d/%d"` (`globalstrings.lua:5897,5891`) -- resolved through the VM so
   * the strings come from `GlobalStrings.lua` rather than being duplicated here. A row with no
   * resolvable name degrades to `"have/need"`, which is stated in the header.
   */
  fn('GetQuestLogLeaderBoard', (args) => {
    // TWO arguments: the objective index and an OPTIONAL quest-log index. See `leaderBoards`.
    const row = leaderBoards(Number(args[1]) || undefined)[Number(args[0]) - 1];
    if (row === undefined) {
      return [];
    }
    const finished = row.have >= row.need;
    if (row.name === null) {
      return [`${row.have}/${row.need}`, row.kind, finished];
    }
    const key = row.kind === 'monster' ? 'QUEST_MONSTERS_KILLED' : 'QUEST_ITEMS_NEEDED';
    const escaped = row.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const formatted = vm.runExpr(
      `return format(${key} or "%s: %d/%d", "${escaped}", ${row.have}, ${row.need})`,
      'quest-leaderboard.lua',
    ) as { value?: unknown } | null;
    return [String(formatted?.value ?? `${row.name}: ${row.have}/${row.need}`), row.kind, finished];
  });

  /**
   * `GetQuestLogTimeLeft()` -- seconds, or NIL for an untimed quest.
   *
   * The `0` trap's sharpest case in this file: `QuestInfo_ShowTimer` does `if ( timeLeft )`
   * (`questinfo.lua:171`), so a 0 puts a "Time Remaining: 0 seconds" line on every quest in the log.
   *
   * The descriptor's word 4 is an absolute unix second, so the remaining time is a subtraction against
   * the wall clock -- and it is clamped at 0, because a quest whose timer has run out is a FAILED quest
   * whose slot has not been rewritten yet, not a quest with negative time.
   */
  fn('GetQuestLogTimeLeft', (args) => {
    const expiry = slotAt(Number(args[0]) || undefined)?.expiry ?? 0;
    if (expiry === 0) {
      return [null];
    }
    return [Math.max(0, expiry - Math.floor(Date.now() / 1000))];
  });

  /**
   * `GetQuestLogRequiredMoney()` -- copper the turn-in will cost. A NUMBER: `QuestInfo_ShowRequiredMoney`
   * compares it with `> 0` and with `GetMoney()` (`questinfo.lua:180-183`).
   *
   * The template's `rewOrReqMoney` is ONE signed field for both directions -- positive is a payout,
   * negative is a cost -- so the requirement is the negated value when it is negative and 0 otherwise.
   */
  fn('GetQuestLogRequiredMoney', (args) => {
    // Takes an OPTIONAL entry index -- the tracker passes one (`watchframe.lua:804`).
    const money = templateAt(Number(args[0]) || undefined)?.money ?? 0;
    return [money < 0 ? -money : 0];
  });

  fn('GetQuestLogGroupNum', () => [selectedTemplate()?.suggestedPlayers ?? 0]);

  /**
   * `IsCurrentQuestFailed()` -- appends " - (Failed)" to the log's title (`questinfo.lua:89`).
   * The descriptor's FAIL bit.
   */
  fn('IsCurrentQuestFailed', () => [((selectedSlot()?.state ?? 0) & QUEST_STATE.FAIL) !== 0]);

  // -- The quest log's reward block ---------------------------------------------------------------

  /**
   * The log's reward block comes from the TEMPLATE's fixed arrays, whose unused slots are zero-filled
   * -- so a "count" is the number of nonzero entries and the indexing must be over the DENSE list.
   * That is the one structural difference from the giver panels, whose blocks are count-prefixed.
   */
  const logRewards = () => (selectedTemplate()?.rewards ?? []).filter((row) => row.itemId !== 0);

  const logChoices = () => (selectedTemplate()?.choices ?? []).filter((row) => row.itemId !== 0);

  fn('GetNumQuestLogRewards', () => [logRewards().length]);

  fn('GetNumQuestLogChoices', () => [logChoices().length]);

  /**
   * `GetQuestLogRewardInfo(index)` / `GetQuestLogChoiceInfo(index)` ->
   * `name, texture, numItems, quality, isUsable`.
   *
   * The same five returns as `GetQuestItemInfo`, and the icon comes from the ENTRY rather than a display
   * id: the query response's arrays carry no display ids, which benilla flags for 1.12
   * (`quest/log.rs:13-15`) and which is unchanged in 3.3.5a. `itemData.iconForEntry` is the join that
   * exists for exactly that case.
   */
  const logItemInfo = (rows: ReturnType<typeof logRewards>, index: number): unknown[] => {
    const row = rows[index - 1];
    if (row === undefined) {
      return [];
    }
    const template = items.template(row.itemId);
    const icon = iconForEntry(row.itemId);
    if (icon !== null) {
      // REGISTER ONLY. `art.load()` used to be here and that was a promise per row per repaint -- the
      // sink that actually fetches a late path is `ui/runtime-art.ts`, and the batch loads happen on
      // the panel and template edges below. Self-review fix.
      art.register(icon, { path: icon });
    }
    return [template?.name ?? null, icon, row.count, template?.quality ?? 1, true];
  };

  fn('GetQuestLogRewardInfo', (args) => logItemInfo(logRewards(), Number(args[0])));

  fn('GetQuestLogChoiceInfo', (args) => logItemInfo(logChoices(), Number(args[0])));

  fn('GetQuestLogRewardMoney', () => {
    const money = selectedTemplate()?.money ?? 0;
    return [money > 0 ? money : 0];
  });

  /**
   * `GetQuestLogRewardXP()` -- a DECLARED GAP that answers 0 rather than a wrong number.
   *
   * The query response carries an `xpId`, not an amount: the real client looks the level up in
   * `QuestXP.dbc` against the player's own level. That DBC is not loaded and joining it is a separate
   * piece of work; 0 hides the XP row (`QuestInfo_ToggleRewardElement` returns its anchor unchanged for
   * a 0), which is a missing line rather than a wrong figure. The GIVER panel's `GetRewardXP` is a real
   * number because `SMSG_QUESTGIVER_QUEST_DETAILS` carries the computed amount.
   */
  const xpGap = notImplemented(
    'GetQuestLogRewardXP',
    'the query response carries an xpId, not an amount; resolving it needs QuestXP.dbc',
    [0],
  );
  fn('GetQuestLogRewardXP', () => xpGap(null as never, 0, []));

  fn('GetQuestLogRewardHonor', () => [0]);
  fn('GetQuestLogRewardArenaPoints', () => [selectedTemplate()?.arenaPoints ?? 0]);
  fn('GetQuestLogRewardTalents', () => [selectedTemplate()?.bonusTalents ?? 0]);

  /** NIL, not 0, for the reason the giver panel's `GetRewardTitle` is nil. */
  fn('GetQuestLogRewardTitle', () => {
    const id = selectedTemplate()?.charTitleId ?? 0;
    return [id === 0 ? null : id];
  });

  /** As `GetRewardSpell`: nothing when there is none, a declared gap when there is. */
  const logSpellGap = notImplemented(
    'GetQuestLogRewardSpell',
    'the reward spell needs a Spell.dbc icon/name join, which spellbook-bridge.ts owns',
    [],
  );
  fn('GetQuestLogRewardSpell', () => (
    (selectedTemplate()?.rewardSpell ?? 0) === 0 ? [] : logSpellGap(null as never, 0, [])
  ));

  /**
   * `GetNumQuestLogRewardFactions()` / `GetQuestLogRewardFactionInfo` /
   * `ProcessQuestLogRewardFactions`.
   *
   * 0, and the reason is in the header: joining the template's faction ids to names needs `Faction.dbc`,
   * which the reputation tab owns. The 0 is what keeps `QuestInfo_DoReputations`' loop -- and with it
   * `GetFactionInfoByID`, which this file does not own -- off the paint path.
   *
   * `ProcessQuestLogRewardFactions` is a real no-op in the engine too: it primes the list the other two
   * read, which here is empty.
   */
  fn('GetNumQuestLogRewardFactions', () => [0]);
  fn('GetQuestLogRewardFactionInfo', () => []);
  fn('ProcessQuestLogRewardFactions', () => []);

  // -- Headers, watching, abandoning --------------------------------------------------------------

  fn('CollapseQuestHeader', (args) => {
    const index = Number(args[0]);
    if (index === -1) {
      // The client's own "collapse everything" call.
      for (const row of entries) {
        if (row.isHeader) {
          collapsed.add(row.zoneOrSort);
        }
      }
    } else {
      const row = entryAt(index);
      if (row !== null && row.isHeader) {
        collapsed.add(row.zoneOrSort);
      }
    }
    if (rebuild()) {
      fireEvent(vm, 'QUEST_LOG_UPDATE');
    }
    return [];
  });

  fn('ExpandQuestHeader', (args) => {
    const index = Number(args[0]);
    if (index === -1) {
      collapsed.clear();
    } else {
      const row = entryAt(index);
      if (row !== null && row.isHeader) {
        collapsed.delete(row.zoneOrSort);
      }
    }
    if (rebuild()) {
      fireEvent(vm, 'QUEST_LOG_UPDATE');
    }
    return [];
  });

  fn('AddQuestWatch', (args) => {
    const row = entryAt(Number(args[0]));
    if (row !== null && !row.isHeader) {
      watched.add(row.questId);
    }
    return [];
  });

  fn('RemoveQuestWatch', (args) => {
    const row = entryAt(Number(args[0]));
    if (row !== null && !row.isHeader) {
      watched.delete(row.questId);
    }
    return [];
  });

  fn('IsQuestWatched', (args) => {
    const row = entryAt(Number(args[0]));
    return [row !== null && !row.isHeader && watched.has(row.questId)];
  });

  fn('GetNumQuestWatches', () => [watched.size]);

  /**
   * `SetAbandonQuest()` / `GetAbandonQuestName()` / `AbandonQuest()` -- the THREE-STEP abandon, and
   * the order is the engine's contract rather than a convenience.
   *
   * `QuestLogFrameAbandonButton`'s click does `SelectQuestLogEntry(questIndex)`, then
   * `SetAbandonQuest()`, then reads `GetAbandonQuestName()` to build the confirmation, and only the
   * popup's `OnAccept` calls `AbandonQuest()` (`questlogframe.lua:610-620`, `staticpopup.lua:1687-1697`).
   * So the quest is LATCHED at the second step and the send happens at the fourth -- which is what makes
   * the confirmation meaningful: the logSelection can change under an open popup and the abandon still
   * removes what the popup names.
   *
   * `GetAbandonQuestName` answers **nil** with nothing latched, for the `0`-is-truthy reason in the
   * header: `QuestLogControlPanel_UpdateState` enables the Abandon button on its truth.
   */
  /**
   * The SAME implementation the early registration delegates to, so there is one of it. See
   * `latchAbandon`: `QuestLogFrame_OnLoad` reaches `SetAbandonQuest` while the manifest is loading, long
   * before this bridge exists.
   */
  latchAbandon = (): void => {
    const row = selected();
    abandoning = row === null ? null : { slot: row.slot, questId: row.questId };
  };
  abandonName = (): string | null => (abandoning === null
    ? null
    : templateOf(abandoning.questId)?.title ?? null);

  fn('SetAbandonQuest', () => {
    latchAbandon?.();
    return [];
  });

  fn('GetAbandonQuestName', () => {
    return [abandonName?.() ?? null];
  });

  /**
   * `GetAbandonQuestItems()` -- which quest items abandoning would destroy, and the reason
   * `ABANDON_QUEST_WITH_ITEMS` exists.
   *
   * NIL, which is a TRUE answer for the overwhelming majority of quests and picks the plain
   * `ABANDON_QUEST` popup. The template's `srcItemId` is the one candidate and it is only destroyed
   * when the quest granted it; nothing on this wire says whether it did, so naming an item the player
   * keeps would be a worse error than not naming one he loses.
   */
  fn('GetAbandonQuestItems', () => [null]);

  fn('AbandonQuest', () => {
    if (abandoning !== null) {
      quest.removeQuest(abandoning.slot);
      abandoning = null;
    }
    return [];
  });

  /** See the header: false is a TRUE answer -- `CMSG_PUSHQUESTTOPARTY` has no sender. */
  fn('GetQuestLogPushable', () => [false]);

  /**
   * `GetQuestLink(index)` -- the `|Hquest:` hyperlink a shift-click inserts into chat.
   *
   * Built here rather than declared missing because the pieces are all present: the quest id, the level
   * and the title. The colour is the difficulty colour the client's own `GetQuestDifficultyColor`
   * answers, which `api/units.ts` already owns -- so this reaches it through the VM rather than
   * recomputing the ramp.
   */
  fn('GetQuestLink', (args) => {
    const row = entryAt(Number(args[0]));
    if (row === null || row.isHeader) {
      return [null];
    }
    const template = templateOf(row.questId);
    if (template === null) {
      return [null];
    }
    return [
      `|cffffff00|Hquest:${row.questId}:${template.level}|h[${template.title}]|h|r`,
    ];
  });

  /**
   * `IsUnitOnQuest(questIndex, unit)` -- whether a party member also has the quest.
   *
   * FALSE, and a declared gap rather than a silent one: it needs
   * `CMSG_REQUEST_PARTY_MEMBER_STATS`' quest block, which nothing here decodes.
   * `QuestLog_UpdatePartyInfoTooltip` uses it only to add a line to a tooltip.
   */
  const partyGap = notImplemented(
    'IsUnitOnQuest',
    "a party member's quest list needs CMSG_REQUEST_PARTY_MEMBER_STATS, which is not decoded",
    [false],
  );
  fn('IsUnitOnQuest', () => partyGap(null as never, 0, []));

  /**
   * `GetDailyQuestsCompleted()` / `GetMaxDailyQuests()`.
   *
   * `QuestLog_UpdateQuestCount` divides by the max, so it must never be 0 (`questlogframe.lua:772`).
   * **25 is 3.3.5a's own `MAX_DAILY_QUESTS`** and the completed count is a player field this client does
   * not read -- 0 is the honest answer and it hides the daily line rather than mis-stating it.
   */
  fn('GetDailyQuestsCompleted', () => [0]);
  fn('GetMaxDailyQuests', () => [25]);

  /**
   * `GetMapInfo()` / `GetCurrentMapDungeonLevel()` -- **NOT quest globals, and registered anyway.**
   *
   * These are the world map's, and they are here because the sweep found them on the quest log's paint
   * path: `QuestLog_SetSelection` calls `QuestLog_UpdateMap()` immediately BEFORE
   * `ShowUIPanel(QuestLogDetailFrame)` (`questlogframe.lua:667-670`), so a nil `GetMapInfo` raises and
   * the detail frame never shows -- the exact failure mode `SecureUnitButton_OnClick`'s missing
   * `SpellIsTargeting` produced, where the visible half looks absent rather than broken.
   *
   * `GetMapInfo` answering nil is the client's own "no map is set" case and `QuestLog_UpdateMap`
   * returns on it in its second line, so the whole map tile loop is skipped correctly rather than
   * half-run. Declared through `notImplemented` so the load report names them and the world-map work
   * finds them.
   */
  const mapGap = notImplemented(
    'GetMapInfo',
    'no world map is set; the quest log calls this on its logSelection path and returns early on nil',
    [null],
  );
  fn('GetMapInfo', () => mapGap(null as never, 0, []));
  fn('GetCurrentMapDungeonLevel', () => [0]);

  // -- THE OBJECTIVE TRACKER ----------------------------------------------------------------------

  /**
   * **`WatchFrame` IS ON THE QUEST LOG'S PAINT PATH, AND THESE WERE MISSING.** Found by sweeping
   * `watchframe.lua` in the self-review, not live -- and it is the same class of defect as
   * `GetMapInfo` above: `QuestLog_Update` ends in `WatchFrame_Update()`, `WatchFrame_Update` calls
   * `GetCurrentMapZone()` unconditionally before its handler loop (`watchframe.lua:789`), and its
   * handlers run in the order "quest timers, achievements, quests" (`:354`) -- so a nil global in
   * ANY of the first two aborts the loop before the quest tracker runs.
   *
   * Three of these are REAL answers rather than gaps:
   *
   *  - `GetQuestTimers()` returning nothing makes `WatchFrame_DisplayQuestTimers` take its
   *    `numTimers == 0` early return (`:472-483`). No quest in the log has a timer unless its slot
   *    carries an expiry, and the timed-quest tracker is a separate display from the log's own timer
   *    line, which `GetQuestLogTimeLeft` already answers.
   *  - `GetTrackedAchievements()` returning nothing is TRUE: no achievement feed is decoded, so none
   *    is tracked. It is registered here only because it sits between the timers and the quests in
   *    that handler list; the achievement subsystem is not this file's.
   *  - The watch family is real state -- `watched` already holds it.
   */
  const watchOrder = (): number[] => entries
    .map((row, i) => (!row.isHeader && watched.has(row.questId) ? i + 1 : 0))
    .filter((index) => index !== 0);

  /** `GetQuestIndexForWatch(watchIndex)` -> the quest log ENTRY index, or nil. */
  fn('GetQuestIndexForWatch', (args) => {
    const index = watchOrder()[Number(args[0]) - 1];
    return [index === undefined ? null : index];
  });

  /** `GetQuestWatchIndex(questLogIndex)` -> the watch index, or nil. The inverse of the above. */
  fn('GetQuestWatchIndex', (args) => {
    const at = watchOrder().indexOf(Number(args[0]));
    return [at < 0 ? null : at + 1];
  });

  /**
   * `SortQuestWatches()` / `ShiftQuestWatches(...)` -- ordering the tracker's rows.
   *
   * No-ops, and the consequence is stated: `watchOrder` returns watches in QUEST LOG order, which is
   * a stable order and the one the log itself shows. The real engine keeps a separate user-draggable
   * order; nothing stores it here, so there is nothing to sort or shift.
   */
  fn('SortQuestWatches', () => []);
  fn('ShiftQuestWatches', () => []);

  /** `GetQuestSortIndex(questIndex)` -- the row's header group. 0 is "no special sort". */
  fn('GetQuestSortIndex', () => [0]);

  /**
   * `GetQuestLogCompletionText(questIndex)` -- the "return to X" line the tracker shows on a quest
   * that is ready to turn in. The template's fifth string, which is WotLK's own addition to
   * `SMSG_QUEST_QUERY_RESPONSE` and empty on most quests -- so nil rather than "" for the empty case,
   * because the tracker tests it for truth.
   */
  fn('GetQuestLogCompletionText', (args) => {
    const text = templateAt(Number(args[0]) || undefined)?.completedText ?? '';
    return [text === '' ? null : text];
  });

  /** See the block comment: nothing, and both are TRUE answers rather than stubs. */
  fn('GetQuestTimers', () => []);
  fn('GetQuestIndexForTimer', () => [null]);
  fn('GetTrackedAchievements', () => []);
  fn('GetNumTrackedAchievements', () => [0]);

  /**
   * The quest-item button on a tracker row -- the "use this to complete the quest" icon.
   *
   * A DECLARED GAP. The item is the template's `srcItemId`, but whether it is USABLE and whether it is
   * in range are both engine questions with no feed here, and answering nothing keeps the button
   * hidden rather than showing one that does nothing.
   */
  const specialItemGap = notImplemented(
    'GetQuestLogSpecialItemInfo',
    'a quest item button needs a usability and range answer that nothing here decodes',
    [],
  );
  fn('GetQuestLogSpecialItemInfo', () => specialItemGap(null as never, 0, []));
  fn('GetQuestLogSpecialItemCooldown', () => []);
  fn('IsQuestLogSpecialItemInRange', () => [null]);
  fn('UseQuestLogSpecialItem', () => []);

  /** `QuestLogPushQuest()` -- the Share button's send. False from `GetQuestLogPushable` keeps the
   * button hidden, so this is unreachable; registered so a hidden path cannot raise. */
  fn('QuestLogPushQuest', () => []);

  /**
   * The quest POI (point-of-interest) family, and `GetCurrentMapZone`/`SetMapToCurrentZone`.
   *
   * All world-map globals, all on the tracker's unconditional path, none of them this file's subject
   * -- registered for `GetMapInfo`'s reason exactly. `GetCurrentMapZone` answering 0 is the client's
   * own "no zone selected" value and `WatchFrame_Update` uses it only as a table key.
   */
  fn('GetCurrentMapZone', () => [0]);
  fn('SetMapToCurrentZone', () => []);
  fn('QuestMapUpdateAllQuests', () => []);
  fn('QuestPOIGetQuestIDByVisibleIndex', () => [0]);
  fn('GetQuestIDByVisibleIndex', () => [0]);
  fn('GetNumQuestPOIs', () => [0]);

  // -- The "questnpc" unit token ------------------------------------------------------------------

  /**
   * `QuestFrame_SetPortrait` does `UnitName("questnpc")` and `SetPortraitTexture(..., "questnpc")`
   * (`questframe.lua:62-70`), so the giver has to exist under that token or the panel's header is blank
   * and its portrait falls back to the book icon.
   *
   * Pushed under both spellings for the reason `gossip-bridge.ts` pushes its own token twice: the
   * documents are inconsistent about case and `setUnit` is keyed literally.
   */
  const pushQuestNpc = (guid: string | null): void => {
    const unit = guid === null ? null : world.entities.get(guid) ?? null;
    const snapshot = unit === null ? null : snapshotOf(unit, world.player);
    setUnit(vm, 'questnpc', snapshot);
    setUnit(vm, 'QUESTNPC', snapshot);
  };

  // -- The events ---------------------------------------------------------------------------------

  const onDetail = (): void => {
    if (disposed) {
      return;
    }
    registerPanelArt([...(quest.details?.choices ?? []), ...(quest.details?.rewards ?? [])]);
    pushQuestNpc(quest.source);
    fireEvent(vm, 'QUEST_DETAIL');
  };

  const onProgress = (): void => {
    if (disposed) {
      return;
    }
    registerPanelArt(quest.progress?.requiredItems ?? []);
    pushQuestNpc(quest.source);
    fireEvent(vm, 'QUEST_PROGRESS');
  };

  const onOffer = (): void => {
    if (disposed) {
      return;
    }
    registerPanelArt([...(quest.offer?.choices ?? []), ...(quest.offer?.rewards ?? [])]);
    pushQuestNpc(quest.source);
    fireEvent(vm, 'QUEST_COMPLETE');
  };

  const onGreeting = (): void => {
    if (disposed) {
      return;
    }
    pushQuestNpc(quest.source);
    fireEvent(vm, 'QUEST_GREETING');
  };

  const onFinished = (): void => {
    if (disposed) {
      return;
    }
    fireEvent(vm, 'QUEST_FINISHED');
  };

  /**
   * A template landed. Rebuild and announce -- this is the door a freshly accepted quest's row comes
   * through, and the reason `rebuild` can safely leave an unresolved quest out of the list.
   */
  const onTemplate = (): void => {
    if (disposed) {
      return;
    }
    if (rebuild()) {
      fireEvent(vm, 'QUEST_LOG_UPDATE');
    }
  };

  /**
   * The descriptor changed. THE ACCEPT AND ABANDON CONFIRMATION, both -- see
   * `update-object/quest-log.ts`.
   *
   * Gated on the list actually differing, on the same `unit:fields` edge `skills-bridge.ts` and
   * `paperdoll-stats.ts` use, and for the same performance reason: a health tick in combat must not
   * repaint the quest log or dirty the offscreen UI target.
   *
   * `UNIT_QUEST_LOG_CHANGED` carries the unit token as its first argument and `QuestLog_OnEvent` tests
   * it against `"player"` (`questlogframe.lua:253`), so it is fired with the argument rather than bare.
   */
  const onFields = (unit: unknown): void => {
    if (disposed) {
      return;
    }
    if (unit !== world.player) {
      /**
       * **A GIVER CAME INTO VIEW, and this edge was MISSING -- which was the whole of "я их не вижу".**
       *
       * Every other re-ask edge here is a QUEST event: accepted, turned in, an objective ticked. Plus
       * one sweep when the bridge attaches, which is before the player has any NPC near him. So walking
       * up to a questgiver triggered nothing at all: no query went out, no status came back, no marker
       * was drawn -- and not one error anywhere, because the server only ever ANSWERS and never pushes.
       * That is exactly the failure the reference names: "a status that is never re-asked for is a
       * marker frozen at first sight" (`benilla-app/src/quest_markers/query.rs:4-8`).
       *
       * The set of nearby givers IS an input to the server's answer, so it belongs among the edges by
       * the same law the others follow. `unit:fields` is the signal this client has for it: it fires on
       * a real field change, and a newly created unit's first application changes everything.
       *
       * GATED ON THE QUESTGIVER FLAG, so this is not a packet per second per moving creature.
       * `NPC_FLAG.QUESTGIVER` is 3.3.5a's bit and is corroborated live against Northshire's own NPCs
       * (`world/cursor-mode.ts:84-99`). A zone full of critters and guards therefore costs nothing here;
       * only a giver's arrival does, and `reaskStatuses` still throttles that to one small packet a
       * second.
       *
       * The player's own branch below keeps its `rebuild()` gate: that one is about the quest LOG, and
       * re-asking there is already covered by the same call at its end.
       */
      /**
       * **UNTIL THE FIRST ANSWER, ANY UNIT'S FIELDS ARE THE EDGE.** The questgiver gate below is right
       * once statuses are flowing, and it was wrong as the ONLY gate -- which is why the markers worked
       * on one visit and not the next.
       *
       * The bridge's own opening sweep fires when it attaches, which is before the world has any
       * entities, so it is answered for nobody. After that, the only edges were quest events and this
       * one. A giver who was ALREADY standing there when the player entered the world has had his
       * fields applied before this handler existed and never applies them again, so he produced no
       * edge at all: walk up to him and nothing is ever asked. The owner saw exactly that -- one visit
       * with a quest event in it worked, the next was silent from the first line.
       *
       * So while `quest.status` is still empty, any unit's fields are taken as the signal that the
       * world has populated and an answer is worth asking for. `reaskStatuses` throttles it to one
       * small packet a second, and the first reply ends this arm for the rest of the session -- after
       * which the questgiver flag is the gate, as it should be.
       */
      if (quest.status.size === 0) {
        reaskStatuses();
        return;
      }
      const flags = (unit as { fields?: { npcFlags?: number } } | null)?.fields?.npcFlags ?? 0;
      if ((flags & NPC_FLAG.QUESTGIVER) !== 0) {
        reaskStatuses();
      }
      return;
    }
    if (!rebuild()) {
      return;
    }
    fireEvent(vm, 'QUEST_LOG_UPDATE');
    fireEvent(vm, 'UNIT_QUEST_LOG_CHANGED', ['player']);
    // Our own state moved, so every nearby giver's answer could have -- the reference's sweep.
    reaskStatuses();
  };

  const onUpdate = (): void => {
    if (disposed) {
      return;
    }
    fireEvent(vm, 'QUEST_WATCH_UPDATE');
    // An objective ticked or a quest failed: the giver's `!`/`?` may have flipped.
    reaskStatuses();
  };

  /**
   * A TEMPLATE LANDED, so every quest item row can now be named -- and until this existed the panel drew
   * once, before the answer, and never again.
   *
   * MEASURED by the owner twice over: a progress panel whose required item showed an icon and no name,
   * and which was correct the second time it was opened; and no tooltip on that row at all, because the
   * tooltip source resolves through the same template and answered null.
   *
   * `QUEST_ITEM_UPDATE` is the client's OWN event for exactly this, and it refreshes whichever panel is
   * up: rewards on the detail and reward panels, the required-item row on the progress panel
   * (`questframe.lua:48-56`). `merchant-bridge.ts` already solves the identical race the identical way
   * -- its own comment says "the NAME still needs the query, which is why `MERCHANT_UPDATE` re-fires
   * when a template lands".
   */
  const onTemplates = (): void => {
    if (disposed) {
      return;
    }
    fireEvent(vm, 'QUEST_ITEM_UPDATE');
    /**
     * AND THE LOG, which does not listen to the event above.
     *
     * `QuestLogFrame` registers `QUEST_LOG_UPDATE` and not `QUEST_ITEM_UPDATE`
     * (`questlogframe.lua:239-242`), and its handler does both halves: `QuestLog_Update()` for the list
     * and, when the detail page is visible, `QuestLog_UpdateQuestDetails(false)` -- which re-runs
     * `QuestInfo_Display` and so re-reads every reward row (`:254-259`). Firing only the item event left
     * the log needing a second open, which is what the owner reported after the giver panels were fixed.
     *
     * `rebuild()` cannot cover this: it fires `QUEST_LOG_UPDATE` only when the ENTRY LIST changed, and a
     * template landing for a quest already listed by title -- every giver-panel quest -- changes no
     * entry while making its reward names available for the first time.
     *
     * Cost: `templatesChanged` fires per query batch, which is a handful on login and one per newly
     * accepted quest. The client's own handler early-outs on `IsVisible` for the expensive half, so a
     * closed log pays for the list walk only.
     */
    fireEvent(vm, 'QUEST_LOG_UPDATE');
  };
  items.on('templatesChanged', onTemplates);

  quest.on('questDetail', onDetail);
  quest.on('questProgress', onProgress);
  quest.on('questOfferReward', onOffer);
  quest.on('questGreeting', onGreeting);
  quest.on('questFinished', onFinished);
  quest.on('questTemplate', onTemplate);
  quest.on('questUpdate', onUpdate);
  quest.on('questRewarded', onFinished);
  // A turn-in changes the giver's own marker immediately, and this is the one edge where the player is
  // looking straight at it.
  quest.on('questRewarded', reaskStatuses);
  world.on('unit:fields', onFields);

  /**
   * `window.questShapes()` -- WHICH CANDIDATE LAYOUT EACH GIVER PANEL DECODED UNDER, plus what it
   * decoded. One call answers "is the accept panel blank because the wire is misread or because the
   * frame did not draw", which cost a whole round to ask the slow way.
   *
   * Always on, like `itemWire`: these are two strings and a handful of scalars, and the next person to
   * meet a blank quest panel should be able to read the answer instead of re-deriving it.
   */
  (window as unknown as Record<string, unknown>).questShapes = () => ({
    detailsShape: quest.detailsShape,
    offerShape: quest.offerShape,
    details: quest.details === null ? null : {
      questId: quest.details.questId,
      title: quest.details.title,
      detailsLen: quest.details.details.length,
      objectivesLen: quest.details.objectives.length,
      choices: quest.details.choices.length,
      rewards: quest.details.rewards.length,
      activateAccept: quest.details.activateAccept,
      flags: quest.details.flags,
      money: quest.details.money,
      xp: quest.details.xp,
    },
    offer: quest.offer === null ? null : {
      questId: quest.offer.questId,
      title: quest.offer.title,
      offerTextLen: quest.offer.offerText.length,
      choices: quest.offer.choices.length,
      rewards: quest.offer.rewards.length,
    },
    progress: quest.progress === null ? null : {
      questId: quest.progress.questId,
      title: quest.progress.title,
      requiredItems: quest.progress.requiredItems.length,
      isComplete: quest.progress.isComplete,
    },
    greeting: quest.greeting === null ? null : quest.greeting.quests.length,
    logSlots: Array.from(world.player.questLog.values()).map((row) => ({
      slot: row.slot, questId: row.questId, state: row.state, counters: row.counters,
    })),
    templates: Array.from(quest.templates.values()).map((t) => ({
      id: t.questId, exact: t.exact, title: t.title,
    })),
  });

  /**
   * `QUEST_FADING_DISABLE = "1"` -- FORCED, and it is a correctness fix rather than a preference.
   *
   * The client's own uvar, default `"0"`, `cvar = "questFadingDisable"`
   * (`interfaceoptionsframe.lua:315`). Four quest panels branch on it and every branch hands the
   * recovery from alpha 0 to `UIFrameFadeIn` when it reads `"0"`:
   * `QuestFrameRewardPanel_OnShow`, `QuestFrameProgressPanel_OnShow`,
   * `QuestFrameGreetingPanel_OnShow` (`questframe.lua:77-80,137-140,204-207`) each do
   * `SetAlpha(0)` then `UIFrameFadeIn(...)`, and `QuestInfoFadingFrame_OnUpdate` does the same on the
   * detail panel.
   *
   * **`UIFrameFadeIn` is driven by ANOTHER `<OnUpdate>` this runtime does not fire**
   * (`UIParent`'s `UIFrameFade_OnUpdate`), so on `"0"` those three panels would be set to alpha 0 and
   * never raised -- the same permanent blankness the detail panel had. On `"1"` they never drop to 0 at
   * all, and the detail panel's single tick lands on `self:SetAlpha(1)`.
   *
   * Set here rather than in the loader because the manifest's own options code assigns it during load;
   * the bridge attaches afterwards, so this wins. It is a TRUE answer for this renderer: there is no
   * per-glyph alpha gradient in `ui/text.ts`, which is also why
   * `methods/region.ts#SetAlphaGradient` reports the gradient as already complete.
   */
  vm.runExpr('QUEST_FADING_DISABLE = "1" return 1', 'quest-fading.lua');

  primeSortNames();
  rebuild();
  // ENTERING THE WORLD. The reference's create-path query, once, for everything in view.
  reaskStatuses();

  return () => {
    disposed = true;
    quest.off('questDetail', onDetail);
    quest.off('questProgress', onProgress);
    quest.off('questOfferReward', onOffer);
    quest.off('questGreeting', onGreeting);
    quest.off('questFinished', onFinished);
    quest.off('questTemplate', onTemplate);
    quest.off('questUpdate', onUpdate);
    quest.off('questRewarded', onFinished);
    quest.off('questRewarded', reaskStatuses);
    world.off('unit:fields', onFields);
    items.off('templatesChanged', onTemplates);
    // The markers are the world's, but their FEED is this bridge's -- so it goes when the bridge does,
    // or a disposed session's statuses would keep drawing over the next one's units.
    world.questMarkerStatuses = null;
    world.questMarkers.dispose();
    // The chained tooltip source goes back, exactly as `merchant-bridge.ts` and `loot-bridge.ts` restore
    // theirs: leaving ours installed would answer `SetQuestItem` for a session that no longer has a
    // quest handler, and swallow every other kind on the way past.
    setItemTooltipSource(vm, previousTooltipSource);
    // The early-registration delegates are this bridge's own; a disposed session must not keep latching
    // into it. `installQuestLogSelection`'s registrations survive and answer nil, which is correct with
    // no bridge attached.
    latchAbandon = null;
    abandonName = null;
  };
}

export default attachQuestBridge;
