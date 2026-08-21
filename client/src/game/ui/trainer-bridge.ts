/**
 * THE CLASS TRAINER's GLOBALS -- the engine half of `ClassTrainerFrame`, which is the client's own
 * XML and Lua and is LOAD-ON-DEMAND.
 *
 * Nothing is drawn here. `Interface\AddOns\Blizzard_TrainerUI\Blizzard_TrainerUI.xml` declares the
 * panel, its eleven `ClassTrainerSkill` rows, the filter dropdown, the detail pane, the money frames
 * and the Train button; `Blizzard_TrainerUI.lua` fills them. The whole deliverable is the ANSWERS plus
 * the four events the frame's own handlers register for.
 *
 * ## THE ON-DEMAND LOADER WAS NOT THE BLOCKER, AND THE ONE NOTE SAYING OTHERWISE IS EXPLAINED
 *
 * The brief for this round expected demand loading to be broken, on the strength of a `STATE.md` note:
 * "`ToggleTalentFrame` returns true and `Blizzard_TalentUI` does NOT load. Measured. The demand loader
 * works (CombatLog proves it), so something upstream declines; not chased."
 *
 * **The upstream decline is the client's own level gate, and it is three lines of `uiparent.lua`:**
 *
 *     function ToggleTalentFrame()
 *         if ( UnitLevel("player") < SHOW_TALENT_LEVEL ) then
 *             return;
 *         end
 *         TalentFrame_LoadUI();
 *
 * (`uiparent.lua:359-363`, `SHOW_TALENT_LEVEL = 10` at `constants.lua:129`). The probe that produced
 * that note ran on **`Gesf`, level 4**, so the function returned before it ever reached `LoadAddOn`.
 * Nothing was broken. The note is a false negative of exactly the kind `CLAUDE.md` warns about -- a
 * negative that confirmed the worry got less scrutiny than a positive would have -- and it is corrected
 * in `STATE.md` rather than left standing.
 *
 * So the trainer needed no loader work at all. Its path is unconditional:
 * `UIParent_OnEvent`'s `TRAINER_SHOW` arm calls `ClassTrainerFrame_LoadUI()`
 * (`uiparent.lua:959-966`), which is `UIParentLoadAddOn("Blizzard_TrainerUI")`
 * (`uiparent.lua:253-255`). Raising the event is the whole of it.
 *
 * ## THE LIST IS FLAT, AND THAT IS THE CLASS TRAINER's OWN SHAPE
 *
 * `GetTrainerServiceInfo(i)` can answer `"header"` as its type, and `blizzard_trainerui.lua` handles
 * headers with plus/minus textures and a collapse-all button. **A class trainer produces none**: the
 * 3.3.5a wire carries no skill-line grouping for trainer services (`SMSG_TRAINER_LIST`'s row is 38
 * fixed bytes with no group field -- see `object/trainer.ts`), so there is nothing to group BY. Headers
 * are a tradeskill-trainer display and `CollapseTrainerSkillLine`/`ExpandTrainerSkillLine` are declared
 * gaps rather than silent no-ops, so the load report names them.
 *
 * The consequence is stated: `ClassTrainerCollapseAllButton` is enabled (the Lua enables it whenever
 * there is at least one service) and clicking it does nothing. With `numHeaders == 0` the Lua's own
 * `notExpanded ~= numHeaders` test is false, so the button already draws as the PLUS (collapsed) glyph;
 * that is the client's arithmetic on an empty header set, not a defect here.
 *
 * ## `0` IS TRUTHY IN LUA -- FOUR RETURNS HERE MUST BE nil
 *
 * The trap this project has now hit three times, most recently putting an unlearn button on every
 * skill. In this file:
 *
 *  - **`GetTrainerSelectionIndex()`** -- `ClassTrainer_SetSelection(id)` opens `if ( not id ) then
 *    ClassTrainer_HideSkillDetails(); return; end`. A 0 would pass that guard and then index service 0,
 *    which does not exist, and `GetTrainerServiceInfo(0)` returning nothing puts `serviceType` at nil
 *    and takes the "is header" arm -- collapsing a line that is not there.
 *  - **`GetTrainerServiceSkillReq(id)`'s first return** -- `if ( skill ) then requirements = ..
 *    format(TRAINER_REQ_SKILL_RANK, skill, rank)`. A 0 would print "Requires 0 (0)" on every ability
 *    that has no skill requirement, which is every class ability.
 *  - **`GetTrainerServiceStepReq(id)`'s first return** -- same shape, `if ( step ) then`.
 *  - **`GetTrainerServiceInfo` on an out-of-range index** -- returns NOTHING, so `serviceName` is nil
 *    and the Lua's own `if ( not serviceName ) then serviceName = UNKNOWN` handles it.
 *
 * Two returns must go the OTHER way and always be numbers, for the mirror reason -- `nil > 1` and
 * `nil == 0` both raise or misbranch: `GetTrainerServiceLevelReq` (`if ( reqLevel > 1 )`) and
 * `GetTrainerServiceCost` (`if ( moneyCost == 0 )`, `if ( cpCost2 > 0 )`).
 *
 * ## THE FILTER, AND WHERE ITS DEFAULTS COME FROM
 *
 * `GetTrainerServiceTypeFilter`/`SetTrainerServiceTypeFilter` are engine state -- nothing in the
 * manifest or the addon stores it, and `ClassTrainerFrameFilterDropDown_Initialize` reads the getter to
 * tick its three boxes. The defaults are the addon's own three declarations, which are the only
 * statement of them this client has: `TRAINER_FILTER_AVAILABLE = 1`, `TRAINER_FILTER_UNAVAILABLE = 1`,
 * `TRAINER_FILTER_USED = 0` (`blizzard_trainerui.lua:7-9`). So a spell already known is hidden until the
 * player ticks "Used", which is the real client's behaviour.
 *
 * **The filter is applied to the DISPLAY list and the wire list is untouched**, which is why there are
 * two index spaces below -- `serviceAt` is the only place they meet, the same discipline
 * `merchant-bridge.ts#rowAt` keeps for its three numberings. `CMSG_TRAINER_BUY_SPELL` carries the SPELL
 * ID rather than an index (`object/trainer.ts#buy`), so a filtered list cannot cause a wrong purchase
 * even if the mapping were wrong.
 *
 * ## Cost
 *
 * The display list is rebuilt only when the wire list changes or a filter is toggled -- not per call.
 * `ClassTrainerFrame_Update` asks `GetTrainerServiceInfo` once per visible row (11) plus once per
 * service for its header count, so a 40-service trainer is ~51 array reads per update, and updates
 * happen on open, on a click and on a purchase. Nothing is added to the draw list outside the window
 * and nothing here runs per frame.
 *
 * The one real cost is `Spell.dbc`: names, ranks, icons and descriptions all come from it.
 * `ensureLoaded` is idempotent and `action-bridge.ts` already asks for the same tables at attach, so
 * this bridge rides that promise rather than starting a second 49 MB fetch -- and it asks anyway so it
 * does not silently depend on another bridge's attach order.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { GlueArt } from './art';
import {
  getItemTooltipSource, setItemTooltipSource, ItemTooltipInfo,
} from './framexml/lua/api/items';
import { setUnit } from './framexml/lua/api/units';
import { snapshotOf } from './unit-bridge';
import { casterStatsFor } from './caster-stats';
import { spellData } from '../pipeline/dbc/spell-data';
import { skillData } from '../pipeline/dbc/skill-data';
import { renderSpellDescription } from '../pipeline/dbc/spell-description';
import type { TrainerHandler, TrainerService } from '../../network/game/object/trainer';
import { TRAINER_SPELL_STATE, TRAINER_TYPE } from '../../network/game/object/trainer';

/**
 * The three service types, indexed by the wire's state byte.
 *
 * These exact strings are what `blizzard_trainerui.lua` compares against -- `"available"` picks
 * `GameFontNormalLeftGreen` and enables Train, `"used"` picks grey, anything else picks red
 * (`blizzard_trainerui.lua:157-168`). `"header"` is the fourth value the API can answer and this client
 * never produces it; see the header.
 */
const SERVICE_TYPE: Record<number, string> = {
  [TRAINER_SPELL_STATE.AVAILABLE]: 'available',
  [TRAINER_SPELL_STATE.UNAVAILABLE]: 'unavailable',
  [TRAINER_SPELL_STATE.USED]: 'used',
};

/**
 * The filter's default state, and it is the ADDON's own declaration rather than a choice made here --
 * `blizzard_trainerui.lua:7-9`. See the header.
 */
const DEFAULT_FILTER: Record<string, boolean> = {
  available: true,
  unavailable: true,
  used: false,
};

/**
 * `SMSG_TRAINER_BUY_FAILED`'s reason word.
 *
 * **A SERVER-SIDE SOURCE and labelled as one** -- the meanings are TrinityCore 3.3.5's own inline
 * comment on `SendTrainerBuyFailed` and nothing the client ships names them. Used only to put a line in
 * the console next to the raw number, so a wrong mapping costs a log line and never an action.
 */
const BUY_FAILED_REASON: Record<number, string> = {
  0: 'the trainer service is unavailable',
  1: 'not enough money for the trainer service',
  2: 'not enough skill points',
};

export function attachTrainerBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const trainer: TrainerHandler = world.game.objectHandler.trainerHandler;

  let disposed = false;

  // `Spell.dbc` and friends -- see the header's Cost note on why this rides an existing promise.
  void spellData.ensureLoaded();
  // `SkillLine.dbc`, for `GetTrainerServiceSkillReq`'s name. The spellbook asks for the same table.
  void skillData.ensureLoaded();

  /** Which service types the player has ticked. Engine state; the two filter globals are its only writers. */
  const filter: Record<string, boolean> = { ...DEFAULT_FILTER };

  /**
   * The DISPLAY list: the wire's services minus the ones the filter hides, in wire order.
   *
   * Rebuilt rather than filtered per call -- `ClassTrainerFrame_Update` walks it twice per update (see
   * the header's Cost note) and `GetNumTrainerServices` must agree with `GetTrainerServiceInfo`'s index
   * space exactly, or the last row of a full page becomes unreachable.
   */
  let display: TrainerService[] = [];

  const rebuild = (): void => {
    display = trainer.services.filter(
      (service) => filter[SERVICE_TYPE[service.state] ?? 'unavailable'] === true,
    );
  };

  /**
   * The explicitly selected service's SPELL ID, or null.
   *
   * Keyed on the spell id and not on an index, deliberately: a purchase re-fetches the list and a
   * filter toggle rebuilds the display list, and both can move a service's index while the player is
   * still looking at the same ability.
   */
  let selectedSpell: number | null = null;

  /** Display index (1-based) -> service, or null. The ONLY place the two index spaces meet. */
  const serviceAt = (index: number): TrainerService | null => {
    if (!Number.isFinite(index) || index < 1) {
      return null;
    }
    return display[index - 1] ?? null;
  };

  /**
   * The selected service's display index, or null.
   *
   * Falls back to the FIRST AVAILABLE service when nothing is selected, and that is not a convenience:
   * `ClassTrainer_SelectFirstLearnableSkill` is `local selectionIndex = GetTrainerSelectionIndex();
   * ClassTrainer_SetSelection(selectionIndex)` (`blizzard_trainerui.lua:222-224`) -- the FrameXML has no
   * search of its own, so if this answered nil on open the window would show a list with no detail pane
   * and a disabled Train button, for ever. The function's name says the engine does the searching.
   *
   * **nil and never 0** -- see the header.
   */
  const selectionIndex = (): number | null => {
    if (selectedSpell !== null) {
      const at = display.findIndex((service) => service.spellId === selectedSpell);
      if (at >= 0) {
        return at + 1;
      }
    }
    const first = display.findIndex(
      (service) => service.state === TRAINER_SPELL_STATE.AVAILABLE,
    );
    if (first >= 0) {
      return first + 1;
    }
    // Nothing learnable. The first row of anything is still better than an empty pane -- the real
    // client shows the top row's detail on a trainer with nothing to teach.
    return display.length > 0 ? 1 : null;
  };

  /** A service's `Spell.dbc` row, or null before the tables land. */
  const rowOf = (service: TrainerService | null) => (
    service === null ? null : spellData.spell(service.spellId)
  );

  /** The player's rank in a skill line, or 0. `world.player.skills` is the descriptor's own block. */
  const skillRank = (skillLine: number): number => world.player.skills.get(skillLine)?.value ?? 0;

  const fn = (name: string, body: Parameters<LuaVM['registerFunction']>[1]): void => {
    vm.registerFunction(name, body);
  };

  // -- The list -----------------------------------------------------------------------------------

  fn('GetNumTrainerServices', () => [display.length]);

  /** `GetTrainerGreetingText()` -- `SMSG_TRAINER_LIST`'s trailing string. */
  fn('GetTrainerGreetingText', () => [trainer.greeting]);

  /** `IsTradeskillTrainer()` -- the packet's `trainerType`, which is 2 for a profession trainer. */
  fn('IsTradeskillTrainer', () => [trainer.trainerType === TRAINER_TYPE.TRADESKILLS]);

  /**
   * `GetTrainerServiceInfo(index)` -> `name, subText, serviceType, isExpanded`.
   *
   * `subText` is the spell's RANK label -- `Spell.dbc`'s `NameSubtext`, which `spell-data.ts` already
   * decodes as `subName` ("Rank 3", "Passive", or `''`). The Lua wraps it in `PARENS_TEMPLATE` only when
   * it is neither nil nor empty (`blizzard_trainerui.lua:143`), so `''` is the right answer for a spell
   * with no rank and must not become nil -- `ClassTrainer_SetSelection` does
   * `SetFormattedText(PARENS_TEMPLATE, serviceSubText)` unguarded at line 268.
   *
   * `isExpanded` is nil always: there are no headers. See the header.
   */
  fn('GetTrainerServiceInfo', (args) => {
    const service = serviceAt(Number(args[0]));
    if (service === null) {
      // NOTHING, not a row of nils -- the Lua's `if ( not serviceName )` arm is written for this.
      return [];
    }
    const row = rowOf(service);
    return [
      row?.name ?? null,
      row?.subName ?? '',
      SERVICE_TYPE[service.state] ?? 'unavailable',
      null,
    ];
  });

  /**
   * `GetTrainerServiceCost(index)` -> `moneyCost, cpCost1, cpCost2`.
   *
   * All three are ALWAYS numbers -- `if ( moneyCost == 0 )` and `if ( cpCost2 > 0 )` both misbehave on
   * nil. The two `cp` words are the wire's two profession words; `object/trainer.ts#TrainerService`
   * carries the inference for which is which and why a class trainer is unaffected by it.
   */
  fn('GetTrainerServiceCost', (args) => {
    const service = serviceAt(Number(args[0]));
    if (service === null) {
      return [0, 0, 0];
    }
    return [service.moneyCost, service.cpCost1, service.cpCost2];
  });

  /** `GetTrainerServiceIcon(index)` -> the spell's icon path, or nil before `Spell.dbc` lands. */
  fn('GetTrainerServiceIcon', (args) => {
    const service = serviceAt(Number(args[0]));
    return [service === null ? null : spellData.iconPath(service.spellId)];
  });

  /**
   * `GetTrainerServiceDescription(index)` -> the spell's tooltip body.
   *
   * The same evaluator the spellbook and the action bar use (`pipeline/dbc/spell-description.ts`), with
   * the same caster stats, so a trainer's description reads identically to the one the player will see
   * in his book after buying it. `''` and not nil: `SetText(nil)` would clear the FontString where an
   * empty string is the honest "this spell has no description".
   */
  fn('GetTrainerServiceDescription', (args) => {
    const row = rowOf(serviceAt(Number(args[0])));
    if (row === null) {
      return [''];
    }
    return [renderSpellDescription(row, casterStatsFor(world, world.game.objectHandler.spellHandler))];
  });

  /** `GetTrainerServiceLevelReq(index)` -> a NUMBER always; `if ( reqLevel > 1 )` raises on nil. */
  fn('GetTrainerServiceLevelReq', (args) => {
    const service = serviceAt(Number(args[0]));
    return [service?.reqLevel ?? 0];
  });

  /**
   * `GetTrainerServiceSkillReq(index)` -> `skillName, rank, hasReq`.
   *
   * **nil for "no skill requirement"** -- see the header on why 0 would print "Requires 0 (0)" on every
   * class ability. `hasReq` is the player's own rank in that line against the wire's `reqSkillValue`,
   * read from the descriptor's skill block (`world.player.skills`), which is where the Skills tab reads
   * it from too.
   */
  fn('GetTrainerServiceSkillReq', (args) => {
    const service = serviceAt(Number(args[0]));
    if (service === null || service.reqSkill === 0) {
      return [null, null, null];
    }
    const line = skillData.line(service.reqSkill);
    if (line === null) {
      // The DBC has not landed, or the server named a skill this build's table does not have. Nil
      // rather than a placeholder: the requirement's whole content is its name.
      return [null, null, null];
    }
    return [line.name, service.reqSkillValue, skillRank(service.reqSkill) >= service.reqSkillValue];
  });

  fn('GetTrainerServiceNumAbilityReq', (args) => {
    const service = serviceAt(Number(args[0]));
    return [service?.reqSpells.length ?? 0];
  });

  /**
   * `GetTrainerServiceAbilityReq(index, i)` -> `abilityName, hasReq`.
   *
   * `i` is 1-based -- the Lua's loop is `for i=1, numRequirements, 1`. `hasReq` is whether the character
   * already knows that spell, read from the same `known` set the spellbook is built from, which is now
   * kept current mid-session by `spells.ts#handleLearnedSpell`.
   */
  fn('GetTrainerServiceAbilityReq', (args) => {
    const service = serviceAt(Number(args[0]));
    const which = Number(args[1]);
    const spellId = service === null ? undefined : service.reqSpells[which - 1];
    if (spellId === undefined) {
      return [null, null];
    }
    const known = world.game.objectHandler.spellHandler.knownSpells().has(spellId);
    return [spellData.spell(spellId)?.name ?? null, known];
  });

  /**
   * `GetTrainerServiceStepReq(index)` -> `step, met`.
   *
   * **nil, ALWAYS, and it is the WIRE's shape rather than a gap here.** `SMSG_TRAINER_LIST`'s row is 38
   * fixed bytes and carries no step field (`object/trainer.ts` has the layout and the two independent
   * derivations of 38), so there is no such requirement to report in 3.3.5a. `if ( step ) then` is
   * simply never taken, which is what the real client does with this data.
   */
  fn('GetTrainerServiceStepReq', () => [null, null]);

  /**
   * `GetTrainerServiceSkillLine(index)` -> the name for the profession confirmation dialog.
   *
   * Only reached by `StaticPopupDialogs["CONFIRM_PROFESSION"]`, i.e. a TRADESKILL trainer teaching a
   * primary profession's first rank -- never on a class trainer. The wire's `reqSkill` is the nearest
   * thing to a skill line the packet carries, and for a profession's first rank it is 0, so this falls
   * back to the spell's own name. **That fallback is an approximation and is labelled as one**: the
   * dialog would read "Are you sure you want to learn Alchemy?" off the learn-spell's name rather than
   * off `SkillLine.dbc`. It cannot return nil -- `SetFormattedText(PROFESSION_CONFIRMATION1, nil)`
   * raises inside an `OnShow`.
   */
  fn('GetTrainerServiceSkillLine', (args) => {
    const service = serviceAt(Number(args[0]));
    if (service === null) {
      return [''];
    }
    const line = service.reqSkill === 0 ? null : skillData.line(service.reqSkill);
    return [line?.name ?? spellData.spell(service.spellId)?.name ?? ''];
  });

  /**
   * `GetTrainerServiceItemLink(index)` -- a DECLARED GAP, and nil is not a safe answer to invent.
   *
   * `ClassTrainerSkillIcon`'s `<OnClick>` is `HandleModifiedItemClick(GetTrainerServiceItemLink(...))`
   * (`blizzard_trainerui.xml:446-448`). A class trainer's service is a SPELL and has no item link at
   * all, so nil is arguably correct there; but a tradeskill trainer's recipe service does have one, and
   * producing it needs a spell-to-recipe-item join this client has no table for. Declared so the load
   * report names it rather than answering nil for both cases and calling the harder one done.
   */
  const itemLinkStub = notImplemented(
    'GetTrainerServiceItemLink',
    'a class trainer service is a spell and has no item link; a tradeskill recipe does, and no'
    + ' spell-to-item join is loaded',
    [null],
  );
  fn('GetTrainerServiceItemLink', () => itemLinkStub(null as never, 0, []));

  // -- Selection ----------------------------------------------------------------------------------

  /** `GetTrainerSelectionIndex()` -> the display index, or **nil**. See the header. */
  fn('GetTrainerSelectionIndex', () => [selectionIndex()]);

  /**
   * `SelectTrainerService(index)` -- the engine remembers what the player clicked.
   *
   * Fires nothing. `ClassTrainer_SetSelection` calls this in the MIDDLE of its own fill
   * (`blizzard_trainerui.lua:270`) and goes on to set every widget itself, so raising `TRAINER_UPDATE`
   * here would re-enter `ClassTrainerFrame_Update` from inside a half-finished selection.
   */
  fn('SelectTrainerService', (args) => {
    const service = serviceAt(Number(args[0]));
    selectedSpell = service?.spellId ?? null;
    return [];
  });

  /**
   * `BuyTrainerService(index)` -- `CMSG_TRAINER_BUY_SPELL`, by spell id.
   *
   * No local state is changed and no event is raised: the row goes grey when the SERVER says so.
   * `SMSG_TRAINER_BUY_SUCCEEDED` re-asks for the list (`object/trainer.ts#handleBuySucceeded`) and the
   * fresh list raises `TRAINER_UPDATE`. Marking it "used" here would show a purchase the server had
   * refused, which is the same law `merchant-bridge.ts` keeps for a sale.
   */
  fn('BuyTrainerService', (args) => {
    const service = serviceAt(Number(args[0]));
    if (service !== null) {
      trainer.buy(service.spellId);
    }
    return [];
  });

  /**
   * `CloseTrainer()` -- drop the window. Nothing goes out; 3.3.5a has no close opcode for a trainer.
   *
   * Called from `ClassTrainerFrame`'s own `<OnHide>` (`blizzard_trainerui.xml:516`), so this is the
   * path the Escape key and the X button both take.
   */
  fn('CloseTrainer', () => {
    trainer.close();
    return [];
  });

  // -- The filter ---------------------------------------------------------------------------------

  /**
   * `GetTrainerServiceTypeFilter(type)` / `SetTrainerServiceTypeFilter(type, on)`.
   *
   * The setter rebuilds and raises `TRAINER_UPDATE`, because the dropdown's own click handler does not:
   * `ClassTrainerFrameFilterDropDown_OnClick` sets the filter and resets the scroll bar and stops
   * (`blizzard_trainerui.lua:433-440`), so the redraw is the engine's to trigger.
   *
   * The setter takes 1/0 from the Lua, and `0` being truthy is exactly why the test is `!== 0` and not a
   * bare cast.
   */
  fn('GetTrainerServiceTypeFilter', (args) => [filter[String(args[0] ?? '')] === true]);
  fn('SetTrainerServiceTypeFilter', (args) => {
    const kind = String(args[0] ?? '');
    if (!(kind in filter)) {
      return [];
    }
    filter[kind] = args[1] !== 0 && args[1] !== false && args[1] !== null && args[1] !== undefined;
    rebuild();
    if (!disposed && trainer.source !== null) {
      fireEvent(vm, 'TRAINER_UPDATE');
    }
    return [];
  });

  /**
   * `CollapseTrainerSkillLine` / `ExpandTrainerSkillLine` -- DECLARED GAPS, not silent no-ops.
   *
   * They are real functions in the engine and they act on service HEADERS, which this client never
   * produces -- see the header on why the 3.3.5a wire carries no grouping. `ClassTrainerCollapseAllButton`
   * calls them with 0 ("all"), so they ARE reached; naming them is what stops "the collapse-all button
   * does nothing" being an unexplained mystery later.
   */
  for (const name of ['CollapseTrainerSkillLine', 'ExpandTrainerSkillLine']) {
    const stub = notImplemented(
      name,
      'no trainer service headers are produced: SMSG_TRAINER_LIST carries no skill-line grouping, so'
      + ' the service list is flat and there is nothing to collapse',
      [],
    );
    fn(name, () => stub(null as never, 0, []));
  }

  // -- The tooltip --------------------------------------------------------------------------------

  /**
   * `GameTooltip:SetTrainerService(index)`, chained onto whatever tooltip source is already installed.
   *
   * `ClassTrainerSkillIcon`'s `<OnEnter>` is `SetOwner` then this then `Show()`
   * (`blizzard_trainerui.xml:440-444`) -- it DOES call `Show()` itself, unlike the bag and vendor
   * setters, so this only has to fill.
   *
   * Chained and not replaced, for `merchant-bridge.ts`' reason: four bridges want this hook and this one
   * attaches last, so replacing it outright would take away every bag, loot and vendor tooltip.
   *
   * Quality 1 (Common/white) is deliberate and is not a claim about the spell: a service has no item
   * quality, and 1 is the neutral white the client draws a spell name in.
   */
  const previous = getItemTooltipSource(vm);
  const trainerTooltip = (
    kind: string, a: number | string, b?: number,
  ): ItemTooltipInfo | null => {
    if (kind !== 'trainer') {
      return previous === null ? null : previous(kind as never, a as never, b);
    }
    const service = serviceAt(Number(a));
    const row = rowOf(service);
    if (service === null || row === null) {
      return null;
    }
    const lines: ItemTooltipInfo['lines'] = [];
    if (row.subName !== '') {
      lines.push({ left: row.subName, colour: [1, 0.82, 0] });
    }
    const description = renderSpellDescription(
      row, casterStatsFor(world, world.game.objectHandler.spellHandler),
    );
    if (description !== '') {
      lines.push({ left: description, colour: [1, 1, 1], wrap: true });
    }
    return { name: row.name, quality: 1, lines, link: null };
  };
  setItemTooltipSource(vm, trainerTooltip as never);

  // -- The events ---------------------------------------------------------------------------------

  /**
   * The "npc" unit token, under BOTH spellings, for the same measured reason `gossip-bridge.ts` and
   * `merchant-bridge.ts` push both: `ClassTrainerFrame_Update` reads `UnitName("npc")` and
   * `SetPortraitTexture(ClassTrainerFramePortrait, "npc")` (`blizzard_trainerui.lua:74-75`), and
   * `api/units.ts#withUnit` resolves tokens through an exact-match `Map`.
   */
  const pushNpcToken = (guid: string | null): void => {
    const unit = guid === null ? null : world.entities.get(guid) ?? null;
    const snapshot = unit === null ? null : snapshotOf(unit, world.player);
    setUnit(vm, 'npc', snapshot);
    setUnit(vm, 'NPC', snapshot);
  };

  /**
   * Register the services' icons.
   *
   * Called on open AND on every update, because `iconPath` answers null until `Spell.dbc` is in memory,
   * so a trainer opened during that fetch would otherwise have registered nothing and never come back
   * for it. `art.register` is idempotent -- the same belt-and-braces `merchant-bridge.ts#registerRowArt`
   * keeps, with `ui/runtime-art.ts` as the general sink behind it.
   */
  const registerServiceArt = (): void => {
    for (const service of trainer.services) {
      const path = spellData.iconPath(service.spellId);
      if (path !== null) {
        art.register(path, { path });
      }
    }
    void art.load();
  };

  const onShow = (): void => {
    if (disposed) {
      return;
    }
    rebuild();
    selectedSpell = null;
    registerServiceArt();
    pushNpcToken(trainer.source);
    // The answers are ready BEFORE the event, not after it: `UIParent_OnEvent`'s arm calls
    // `ClassTrainerFrame_LoadUI()` and then `ClassTrainerFrame_Show()` synchronously, and that runs
    // `ClassTrainerFrame_Update` -- the same ordering `merchant-bridge.ts#onShow` keeps.
    fireEvent(vm, 'TRAINER_SHOW');
  };

  const onUpdate = (): void => {
    if (disposed || trainer.source === null) {
      return;
    }
    rebuild();
    registerServiceArt();
    fireEvent(vm, 'TRAINER_UPDATE');
  };

  const onClosed = (): void => {
    if (disposed) {
      return;
    }
    display = [];
    selectedSpell = null;
    pushNpcToken(null);
    fireEvent(vm, 'TRAINER_CLOSED');
  };

  const onBuyFailed = (payload: { code: number; spellId: number }): void => {
    console.warn(
      `trainer: the server refused to teach spell ${payload.spellId} -- reason ${payload.code}`
      + ` (${BUY_FAILED_REASON[payload.code] ?? 'unmapped'}). The reason MAPPING is a server-side`
      + ' source; the number is the wire\'s. See ui/trainer-bridge.ts.',
    );
    onUpdate();
  };

  /**
   * `Spell.dbc` landing while a trainer is open.
   *
   * `TRAINER_DESCRIPTION_UPDATE` and not `TRAINER_UPDATE`, because that is precisely what the event is
   * for: `ClassTrainerFrame_OnEvent` answers it with `ClassTrainer_SetSelection(GetTrainerSelectionIndex())`
   * (`blizzard_trainerui.lua:69-70`), i.e. re-fill the DETAIL pane, which is the part that was empty
   * while the tables were still fetching. The row list is refreshed too, because the names came from the
   * same table -- so both are fired, in the order the client's own handler would see them.
   */
  void spellData.ensureLoaded().then(() => {
    if (disposed || trainer.source === null) {
      return;
    }
    onUpdate();
    fireEvent(vm, 'TRAINER_DESCRIPTION_UPDATE');
  });

  /**
   * A SPELL WAS LEARNED WHILE THE TRAINER IS OPEN -- re-ask for the list.
   *
   * **SELF-REVIEW: this closes a hole in the purchase path that the `SMSG_TRAINER_BUY_SUCCEEDED`
   * re-list does not cover.** That re-list is the primary refresh (`object/trainer.ts#handleBuySucceeded`),
   * but it depends on the server actually sending that opcode -- and the buy path is the one arm this
   * round could not exercise, so "the server sends it" is an assumption and not a measurement. The
   * learned-spell edge is INDEPENDENT of it: `SMSG_LEARNED_SPELL`/`SMSG_SUPERCEDED_SPELL` are how the
   * spell reaches the book at all, so if the player got the ability, this fires.
   *
   * Only while a window is open, and it CANNOT loop: a list arrival raises `trainerUpdate`, which
   * changes no spells, so nothing re-enters here. Cost is one packet per spell learned at a trainer,
   * and zero at every other time.
   */
  const spells = world.game.objectHandler.spellHandler;
  const onSpellsChanged = (): void => {
    if (disposed || trainer.source === null) {
      return;
    }
    trainer.list(trainer.source);
  };

  trainer.on('trainerShow', onShow);
  trainer.on('trainerUpdate', onUpdate);
  trainer.on('trainerClosed', onClosed);
  trainer.on('trainerBuyFailed', onBuyFailed);
  spells.on('spellsChanged', onSpellsChanged);

  (window as unknown as Record<string, unknown>).trainerBridge = () => ({
    source: trainer.source,
    trainerType: trainer.trainerType,
    greeting: trainer.greeting,
    wireServices: trainer.services.length,
    displayServices: display.length,
    filter: { ...filter },
    selectedSpell,
    selectionIndex: selectionIndex(),
    // **SELF-REVIEW: THIS WAS `spellData.spell(1) !== null` AND IT WAS AN INSTRUMENT DEFECT.** It
    // probed readiness by asking for spell id 1 -- a specific row whose existence in this build's
    // `Spell.dbc` nobody had checked. If id 1 is absent the panel reports "tables not ready" for ever,
    // which is precisely the shape `CLAUDE.md` warns about: a debug panel reading zero while the world
    // is fine. `spellData.ready` is the table's own answer and is what `spellbook-bridge.ts:234` gates
    // its ledger on.
    spellTablesReady: spellData.ready,
    lastError: trainer.lastError,
    // The whole display list as the interface would read it -- one place to check a row's name, cost,
    // type and requirement without driving the Lua.
    rows: display.map((service, i) => ({
      index: i + 1,
      spellId: service.spellId,
      name: spellData.spell(service.spellId)?.name ?? null,
      subName: spellData.spell(service.spellId)?.subName ?? null,
      type: SERVICE_TYPE[service.state] ?? 'unavailable',
      moneyCost: service.moneyCost,
      reqLevel: service.reqLevel,
      reqSkill: service.reqSkill,
      reqSkillValue: service.reqSkillValue,
      reqSpells: service.reqSpells,
    })),
  });

  return () => {
    disposed = true;
    setItemTooltipSource(vm, previous);
    setUnit(vm, 'npc', null);
    setUnit(vm, 'NPC', null);
    trainer.removeListener('trainerShow', onShow);
    trainer.removeListener('trainerUpdate', onUpdate);
    trainer.removeListener('trainerClosed', onClosed);
    trainer.removeListener('trainerBuyFailed', onBuyFailed);
    spells.removeListener('spellsChanged', onSpellsChanged);
    delete (window as unknown as Record<string, unknown>).trainerBridge;
  };
}

export default attachTrainerBridge;
