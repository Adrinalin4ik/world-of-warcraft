/**
 * THE GOSSIP GLOBALS -- the engine half of `GossipFrame`, which is the client's own XML and Lua.
 *
 * Nothing is drawn here. `GossipFrame.xml` declares the panel and its 32 `GossipTitleButton`s and
 * `GossipFrame.lua` fills them; the whole deliverable is the answers plus the two events its
 * `GossipFrame_OnLoad` registers for (`gossipframe.lua:4-5`).
 *
 * This bridge exists FOR the merchant: most vendors in the game carry the GOSSIP flag as well, so
 * "Let me browse your goods" is the click that opens the shop. See `object/gossip.ts`' header for why
 * a pure vendor does NOT come through here on 3.3.5a and goes straight to `CMSG_LIST_INVENTORY`.
 *
 * ## THREE OF THESE GLOBALS RETURN VARARGS, AND THAT IS NOT A STYLE CHOICE
 *
 * `GossipFrameUpdate` passes them straight through as argument lists --
 * `GossipFrameOptionsUpdate(GetGossipOptions())` -- and each consumer walks `select("#", ...)` with a
 * STRIDE (`gossipframe.lua:34-36`):
 *
 *     GetGossipOptions           stride 2   text, iconName
 *     GetGossipAvailableQuests   stride 5   title, level, isTrivial, isDaily, isRepeatable
 *     GetGossipActiveQuests      stride 4   title, level, isTrivial, isComplete
 *
 * So a flat list is the contract and the stride is exact: one extra or one missing value shifts every
 * row after it, and `GossipFrameAvailableQuestsUpdate` would then read a boolean as a title. The
 * strides are read off the client's own `for i=1, select("#", ...), N` loops, not remembered.
 *
 * ## The icon is a STRING, and the ten names are the served art
 *
 * `GossipFrameOptionsUpdate` builds the texture path itself:
 * `"Interface\GossipFrame\" .. select(i+1, ...) .. "GossipIcon"` (`gossipframe.lua:160`). So the engine
 * answers a NAME and the document makes the path -- which means a wrong name is a 404, not a wrong
 * picture.
 *
 * The name set was PROBED rather than recalled. `interface/gossipframe/<name>gossipicon.blp` answers
 * **200 for exactly ten stems** -- gossip, vendor, taxi, trainer, healer, binder, banker, petition,
 * tabard, battlemaster -- and 404 for every other plausible one tried (auctioneer, talent, moneybag,
 * chat, interact, guild, arena). Ten served names for the ten `GOSSIP_ICON_*` values 0..9 is the
 * mapping, and its two ends are independently checkable: icon 8 is the tabard designer and icon 9 is
 * the battlemaster's crossed swords, which is where `tabard` and `battlemaster` fall.
 *
 * An icon above 9 -- 3.3.5a's server-side `gossip_menu_option` allows them -- has NO served art, so it
 * falls back to `gossip`. Stated, not silent: the alternative is a guaranteed 404 and a blank icon.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { GlueArt } from './art';
import { setUnit } from './framexml/lua/api/units';
import { snapshotOf } from './unit-bridge';
import type { GossipHandler } from '../../network/game/object/gossip';
import { QUEST_STATE } from '../../network/game/object/update-object/quest-log';
import { expandTextTokens } from './text-tokens';

/**
 * `GOSSIP_ICON_*` -> the stem `GossipFrameOptionsUpdate` concatenates. See the header on how the set
 * was established and why index 0 is the fallback.
 */
const ICON_NAMES = [
  'gossip', 'vendor', 'taxi', 'trainer', 'healer',
  'binder', 'banker', 'petition', 'tabard', 'battlemaster',
] as const;

/** Where those ten live, so the art layer can be told to fetch them. */
const BS = String.fromCharCode(92);
const ICON_DIR = ['Interface', 'GossipFrame', ''].join(BS);

/**
 * A quest is "trivial" -- wrapped in `TRIVIAL_QUEST_DISPLAY`, `"%s (low level)"`
 * (`globalstrings.lua:7693`) -- when it is far enough below the player to be worth nothing.
 *
 * **FALSE, ALWAYS, AND THAT IS A STANDING PROJECT DECISION RATHER THAN AN OVERSIGHT.**
 *
 * `SMSG_GOSSIP_MESSAGE` carries no trivial bit -- the quest block is id, type, level, flags,
 * repeatable (`NPCPackets.cpp:34-44`) -- so the engine derives it, and the client's own file says how.
 * `GetQuestDifficultyColor` (`uiparent.lua:3358-3371`) ends
 *
 *     elseif ( -levelDiff <= GetQuestGreenRange() ) then return QuestDifficultyColors["standard"];
 *     else                                              return QuestDifficultyColors["trivial"];
 *
 * so the threshold is `GetQuestGreenRange()`, an ENGINE global that is level-dependent and that
 * **nothing this client can read states**. A previous round already met this exact question for the
 * unit-level colour and recorded the answer in `api/units.ts`: "THE GREEN RANGE IS NOT PINNED ... a
 * level-dependent constant this client has no source for, so anything below the yellow band is green
 * rather than fading to grey ... Said plainly rather than approximated with an invented table."
 *
 * Inventing a band here would contradict that decision AND put a second, differently-wrong copy of it
 * next to the first. So the same gap is taken, with the same consequence stated: an old quest in a
 * gossip menu reads as a normal quest instead of carrying "(low level)". Cosmetic, and one number away
 * from correct the day `GetQuestGreenRange` gets a source.
 *
 * (A level of -1 -- the wire's "scales to the player" marker, which is why `object/gossip.ts` reads it
 * SIGNED -- is never trivial either, so this answer is right for that case whatever the range is.)
 */
const isTrivial = (): boolean => false;

/**
 * `QUEST_FLAGS_DAILY` (0x1000) and `QUEST_FLAGS_WEEKLY` (0x8000).
 *
 * Read off `Quests/QuestDef.h:144,147`. A SERVER-side definition, labelled as such, exactly like the
 * `UNIT_NPC_FLAG_*` bits. Nothing the client ships names them -- the flags word arrives raw on the
 * wire and no DBC carries it. `GossipFrameAvailableQuestsUpdate` uses the result only to choose
 * between `DailyQuestIcon`, `DailyActiveQuestIcon` and `AvailableQuestIcon`
 * (`gossipframe.lua:82-88`), so a wrong bit costs an icon and never a wrong action.
 */
const QUEST_FLAGS_DAILY = 0x1000;
const QUEST_FLAGS_WEEKLY = 0x8000;

export function attachGossipBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const gossip: GossipHandler = world.game.objectHandler.gossipHandler;

  let disposed = false;

  // The ten icons, registered once. `art.register` is idempotent and the whole set is ten 16x16-ish
  // BLPs, so registering all of them on attach is cheaper than deciding per menu and cannot miss the
  // one a particular NPC needs -- the same reasoning `loot-bridge.ts` gives for its three coin icons.
  for (const name of ICON_NAMES) {
    const path = `${ICON_DIR}${name}GossipIcon`;
    art.register(path, { path });
  }

  /**
   * The "npc" unit token, under BOTH spellings.
   *
   * `GossipFrameUpdate` reads `UnitName("npc")` and `UnitExists("npc")` (`gossipframe.lua:40-41`)
   * while `MerchantFrame_UpdateMerchantInfo` reads `UnitName("NPC")` (`merchantframe.lua:73`). The real
   * engine's tokens are case-insensitive; `api/units.ts#withUnit` resolves them through an exact-match
   * `Map`. Both spellings are registered here rather than lower-casing in that file, which another
   * agent owns this round -- the general fix is one `toLowerCase` and is named in the report.
   */
  const pushNpcToken = (guid: string | null): void => {
    const unit = guid === null ? null : world.entities.get(guid) ?? null;
    const snapshot = unit === null ? null : snapshotOf(unit, world.player);
    setUnit(vm, 'npc', snapshot);
    setUnit(vm, 'NPC', snapshot);
  };

  // -- The globals --------------------------------------------------------------------------------

  /**
   * `GetGossipText()` -- the greeting, or nil.
   *
   * NIL and not `''` while the second round trip is out. `GossipGreetingText:SetText(nil)` leaves the
   * block empty and the buttons still draw; an empty string would do the same thing today but would
   * be a claim that the NPC said nothing, which is different from not knowing yet. The text arrives on
   * `SMSG_NPC_TEXT_UPDATE` and `GOSSIP_SHOW` re-fires when it does.
   */
  vm.registerFunction('GetGossipText', () => [
    // Tokens expanded here and NOT in the handler, because the raw text is what the server sent and
    // is what a residual is checked against. `$c` in a greeting is what the owner reported seeing.
    //
    // NIL IS PRESERVED DELIBERATELY. `expandTextTokens` answers '' for a nullish input, and the
    // header above explains why that would be wrong here: an empty string claims the NPC said
    // nothing, which is not the same as not knowing yet while the second round trip is out.
    gossip.greeting == null ? gossip.greeting : expandTextTokens(vm, gossip.greeting),
  ]);

  vm.registerFunction('GetNumGossipOptions', () => [gossip.options.length]);

  /** `GetGossipOptions()` -> flat `text, iconName` pairs. Stride 2; see the header. */
  vm.registerFunction('GetGossipOptions', () => {
    const flat: unknown[] = [];
    for (const option of gossip.options) {
      flat.push(option.text, ICON_NAMES[option.icon] ?? ICON_NAMES[0]);
    }
    return flat;
  });

  vm.registerFunction('GetNumGossipAvailableQuests', () => [gossip.availableQuests.length]);

  /**
   * `GetGossipAvailableQuests()` -> flat `title, level, isTrivial, isDaily, isRepeatable` fives.
   *
   * `isRepeatable` is the wire's own trailing byte, which the server sets for an auto-complete
   * repeatable that is neither daily nor weekly nor monthly (`GossipDef.cpp`'s `PlayerMenu::SendGossipMenu`) -- so it and the
   * daily flag are mutually exclusive by construction, which is what
   * `GossipFrameAvailableQuestsUpdate`'s `if isDaily elseif isRepeatable` chain assumes.
   */
  vm.registerFunction('GetGossipAvailableQuests', () => {
    const flat: unknown[] = [];
    for (const quest of gossip.availableQuests) {
      flat.push(
        quest.title,
        quest.level,
        isTrivial(),
        (quest.flags & (QUEST_FLAGS_DAILY | QUEST_FLAGS_WEEKLY)) !== 0,
        quest.marker,
      );
    }
    return flat;
  });

  /**
   * The ACTIVE quest list -- always empty, and that is the WIRE's shape rather than a gap here.
   *
   * `SMSG_GOSSIP_MESSAGE` has ONE quest array and 3.3.5a puts the AVAILABLE quests in it; a quest
   * already in the log reaches the client through `SMSG_QUESTGIVER_QUEST_LIST`, which this client does
   * not decode. So 0 is the honest count for this packet, and it is registered rather than stubbed
   * because it is a real answer -- `GossipFrameActiveQuestsUpdate` with no arguments simply draws no
   * rows. See `object/gossip.ts#handleMessage`.
   */
  vm.registerFunction('GetNumGossipActiveQuests', () => [gossip.activeQuests.length]);
  /**
   * `isComplete` COMES FROM THE QUEST LOG, not from the wire byte -- the owner's grey `?` is why.
   *
   * `GossipFrameActiveQuestsUpdate` picks the icon off the fourth value: truthy draws
   * `ActiveQuestIcon`, the gold `?`, and falsy draws `IncompleteQuestIcon`, the grey one
   * (`gossipframe.lua:133-137`). We were passing the row's trailing wire byte, and in 3.3.5's gossip
   * message that byte is a literal `0` for "repeatable" -- so every active row was permanently grey,
   * including a quest the player had already finished.
   *
   * The player's own log is the right source and the engine's own: whether a held quest is complete is
   * client-side state, carried in the descriptor slot's COMPLETE bit. That is a DIFFERENT use of the log
   * from the one the reference forbids -- it rejects deriving the active/available POOL from log
   * membership (an auto-complete quest is never in the log), and says nothing against reading the
   * completion of a quest that demonstrably is in it. A row that is active but absent from the log is
   * exactly the auto-complete case, and it answers false, which draws the grey icon the real client
   * draws for it too.
   */
  const questIsComplete = (questId: number): boolean => {
    for (const slot of world.player.questLog.values()) {
      if (slot.questId === questId) {
        return (slot.state & QUEST_STATE.COMPLETE) !== 0;
      }
    }
    return false;
  };

  vm.registerFunction('GetGossipActiveQuests', () => {
    const flat: unknown[] = [];
    for (const quest of gossip.activeQuests) {
      flat.push(
        quest.title, quest.level, isTrivial(), questIsComplete(quest.questId),
      );
    }
    return flat;
  });

  /**
   * `SelectGossipOption(index, code, confirmed)` -- **the click that opens the shop.**
   *
   * `GossipTitleButton_OnClick` passes the button's `SetID`, which `GossipFrameOptionsUpdate` numbered
   * 1..n in list order (`gossipframe.lua:155-165`), so the argument is a 1-BASED DISPLAY index and the
   * wire wants the server's own option index. Those differ whenever the server's indices are sparse,
   * which they are: `_gossipMenu.GetMenuItems()` is a map keyed by gossip option id. Converting
   * through the decoded list is the whole reason the option's `index` is kept.
   */
  vm.registerFunction('SelectGossipOption', (args) => {
    const at = Number(args[0]);
    const option = Number.isFinite(at) && at >= 1 ? gossip.options[at - 1] : undefined;
    if (option === undefined) {
      return [];
    }
    const code = typeof args[1] === 'string' ? args[1] : undefined;
    gossip.selectOption(option.index, code);
    return [];
  });

  /**
   * THE TWO QUEST SELECTIONS ARE NOT HERE, and this pointer is the whole of the entry.
   *
   * `quest-bridge.ts` owns `SelectGossipAvailableQuest`/`SelectGossipActiveQuest`, and it must: it is
   * attached AFTER this bridge in `world-ui.ts`, so anything registered here for those two names is
   * overwritten. A correct implementation DID live here for a few commits -- with the reference's opcode
   * law and an explicit giver guid -- and it was dead code the whole time, while the version in the quest
   * bridge sent `CMSG_QUESTGIVER_QUERY_QUEST` for both pools. The owner's symptoms were a click that
   * opened nothing and `0x186` on the wire where `0x18A` belongs, and nothing in either file said the
   * two were competing.
   *
   * So: do not re-add them here. If they need changing, change them there.
   */


  /**
   * `CloseGossip()` -- `GossipFrame_OnEvent`'s bail-out and `GossipFrameCloseButton`'s click.
   *
   * Sends nothing: there is no `CMSG_GOSSIP_CLOSE` in 3.3.5a. See `object/gossip.ts#close`.
   */
  vm.registerFunction('CloseGossip', () => {
    gossip.close();
    return [];
  });

  /**
   * `ForceGossip()` -- **false, and it is a TRUE answer rather than a stub.**
   *
   * `GossipFrame_OnEvent` uses it to decide whether to SHOW a one-option menu or auto-select that
   * option and skip the window (`gossipframe.lua:11-17`). The real engine answers true only for a few
   * scripted NPCs that must be talked to; false is the ordinary case, and it is the case that HELPS
   * here -- a vendor whose only gossip option is "browse your goods" auto-selects it and the shop
   * opens with no menu flash, which is the real client's behaviour.
   */
  vm.registerFunction('ForceGossip', () => [false]);

  // -- The events ---------------------------------------------------------------------------------

  const onShow = (): void => {
    if (disposed) {
      return;
    }
    void art.load();
    pushNpcToken(gossip.source);
    fireEvent(vm, 'GOSSIP_SHOW');
  };

  /**
   * The greeting landed. `GOSSIP_SHOW` again, because `GossipFrameUpdate` is what reads
   * `GetGossipText()` and `GossipFrame_OnEvent` is the only thing that calls it.
   *
   * Re-firing is safe by the document's own construction: its handler is idempotent -- it rebuilds
   * every button from scratch and hides the tail (`gossipframe.lua:32-39`) -- and the
   * `if ( not GossipFrame:IsShown() )` guard means the second pass does not re-show the panel.
   */
  const onText = (): void => {
    if (!disposed && gossip.source !== null) {
      fireEvent(vm, 'GOSSIP_SHOW');
    }
  };

  const onClosed = (): void => {
    if (disposed) {
      return;
    }
    pushNpcToken(null);
    fireEvent(vm, 'GOSSIP_CLOSED');
  };

  gossip.on('gossipShow', onShow);
  gossip.on('gossipTextChanged', onText);
  gossip.on('gossipClosed', onClosed);

  (window as unknown as Record<string, unknown>).gossipBridge = () => ({
    npc: gossip.source,
    menuId: gossip.menuId,
    titleTextId: gossip.titleTextId,
    greeting: gossip.greeting,
    options: gossip.options,
    availableQuests: gossip.availableQuests,
  });

  return () => {
    disposed = true;
    setUnit(vm, 'npc', null);
    setUnit(vm, 'NPC', null);
    gossip.removeListener('gossipShow', onShow);
    gossip.removeListener('gossipTextChanged', onText);
    gossip.removeListener('gossipClosed', onClosed);
    delete (window as unknown as Record<string, unknown>).gossipBridge;
  };
}

export default attachGossipBridge;
