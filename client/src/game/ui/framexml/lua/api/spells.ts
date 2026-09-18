/**
 * THE SPELLBOOK's engine globals -- what `SpellBookFrame.lua` asks the engine for, and nothing else.
 *
 * Like `api/actions.ts`, **this file contains no world, no network, no guids and no DBCs.** It holds one
 * snapshot per VM that the host writes and the Lua reads; the seam that fills it is
 * `ui/spellbook-bridge.ts`, and nothing here knows a spell id came off a wire or a skill line out of a
 * DBC. The spellbook was blocked on this file existing and on nothing else: `ShowUIPanel`, `ToggleFrame`,
 * `ToggleSpellBook`, `SpellBookFrame_OnLoad` and `SpellBookFrame` itself were all already live (measured
 * last round), and `ToggleSpellBook("spell")` failed at exactly one place -- `spellbookframe.lua:15`, on a
 * nil `HasPetSpells`.
 *
 * ## THE ONE THING TO GET RIGHT: these globals are indexed by SPELLBOOK SLOT, not by spell id
 *
 * This is the trap in the whole API and it is worth stating first, because every signature below depends
 * on it and getting it backwards produces a book that looks populated and is wrong. `SpellButton_OnClick`
 * does not hold a spell id:
 *
 *     local id = SpellBook_GetSpellID(self:GetID());     spellbookframe.lua:343
 *
 * and `SpellBook_GetSpellID` (`:591-601`) computes
 *
 *     local slot = id + SpellBookFrame.selectedSkillLineOffset
 *                     + ( SPELLS_PER_PAGE * (SPELLBOOK_PAGENUMBERS[...] - 1) );
 *     if ( not GetCVarBool("ShowAllSpellRanks") ) then
 *         return GetKnownSlotFromHighestRankSlot(slot), slot;
 *     end
 *     return slot, slot;
 *
 * So the number handed to `GetSpellTexture`, `GetSpellName`, `GetSpellCooldown`, `IsPassiveSpell`,
 * `CastSpell` and `PickupSpell` is a 1-based INDEX INTO THE CHARACTER'S WHOLE SPELL LIST, tab-major. The
 * spell id never appears in the client's Lua at all. A book laid out as spell ids would index by 331 into
 * a 54-entry list and show nothing.
 *
 * ## TWO PARALLEL INDEXINGS, because `ShowAllSpellRanks` is off by default
 *
 * `GetCVarBool("ShowAllSpellRanks")` reads false (the cvar is unset, and `api/screen.ts:325` answers
 * false for that), which is also the real client's default. `SpellBook_GetTabInfo` then SUBSTITUTES the
 * high-rank pair for the full pair (`spellbookframe.lua:656-663`):
 *
 *     local name, texture, offset, numSpells, highestRankOffset, highestRankNumSpells
 *         = GetSpellTabInfo(skillLine);
 *     if ( not GetCVarBool("ShowAllSpellRanks")) then
 *         offset = highestRankOffset;
 *         numSpells = highestRankNumSpells;
 *     end
 *
 * so **`GetSpellTabInfo` must return SIX values** -- a four-return version makes `offset`/`numSpells` nil
 * and the arithmetic above errors -- and the engine keeps two lists at once:
 *
 *   - `all`: every known spell, all ranks, tab-major. `offset`/`numSpells` index it, and it is what a
 *     slot passed to `GetSpellTexture` addresses.
 *   - `high`: the HIGHEST rank of each spell only, tab-major, in the same tab order.
 *     `highestRankOffset`/`highestRankNumSpells` index it.
 *
 * and `GetKnownSlotFromHighestRankSlot` is the map from the second back into the first. That function is
 * not an optimisation -- it is the only reason a book showing top ranks can still name the right spell.
 *
 * ## What is NOT here
 *
 * The pet book. Every getter takes `bookType` and answers nil for `BOOKTYPE_PET`, and `HasPetSpells`
 * answers nil, because `SMSG_PET_SPELLS` (0x179) is in `network/game/opcode.js:379` with **no subscriber**
 * -- grepped, nothing in this client reads a pet at all. See `HasPetSpells` below: it is a declared gap,
 * not a convenient false.
 */
import { LuaVM } from '../vm';
import { fireEvent } from '../events';
import { notImplemented } from '../methods/region';

/** One spellbook entry -- one rank of one spell, as the book has to draw it. */
export interface SpellbookEntry {
  spellId: number;
  name: string;
  /**
   * `Spell.dbc`'s `NameSubtext` (column 153, measured) -- "Rank 3", "Passive", or `''`.
   *
   * **`''` and never null.** `SpellButton_UpdateButton` compares `subSpellName ~= ""` to choose the name
   * label's anchor (`spellbookframe.lua:510-514`); a nil there takes the wrong branch for every rankless
   * spell. `GetSpellName`'s contract has the same requirement.
   */
  subName: string;
  /**
   * `Spell.dbc`'s `Description` (column 170, measured) -- the tooltip body, with the engine's `$s1`/`$d`
   * substitution tokens UNEXPANDED. `''` for a spell with none, and `''` for every spell until the 49 MB
   * fetch lands. Read by `GameTooltip:SetSpell`; see `pipeline/dbc/spell-data.ts#COL.description`.
   */
  description: string;
  /** Extensionless icon path from `SpellIcon.dbc`, or null until the 49 MB `Spell.dbc` fetch lands. */
  texture: string | null;
  /** `SPELL_ATTR0_PASSIVE` (`Spell.dbc` column 4, bit 0x40). Draws a black border and a grey name. */
  passive: boolean;
  /** `GetSpellCooldown`'s `start` and `duration`, in `GetTime()` SECONDS. Both 0 for no cooldown. */
  cooldownStart: number;
  cooldownDuration: number;
}

/** One skill-line tab. `offset`/`numSpells` index `all`; the `highestRank*` pair indexes `high`. */
export interface SpellbookTab {
  name: string;
  /** The tab button's `SetNormalTexture` path, or null. */
  texture: string | null;
  /** 0-BASED offset into `all`: the client adds a 1-based button id to it (`spellbookframe.lua:595`). */
  offset: number;
  numSpells: number;
  highestRankOffset: number;
  highestRankNumSpells: number;
}

export interface SpellbookSnapshot {
  /** At most `MAX_SKILLLINE_TABS` = 8 (`spellbookframe.lua:2`); the host truncates, not this file. */
  tabs: SpellbookTab[];
  /** Every known spell, all ranks, tab-major. Indexed 1-based from Lua. */
  all: SpellbookEntry[];
  /** The highest rank of each spell only, tab-major, tab ranges parallel to `tabs`. */
  high: SpellbookEntry[];
  /**
   * `GetKnownSlotFromHighestRankSlot`: 1-based `high` slot -> 1-based `all` slot.
   *
   * Stored as a dense array rather than computed, because the mapping is not arithmetic -- a tab with
   * three multi-rank spells and one single-rank spell has no stride.
   */
  knownSlotOfHigh: number[];
}

export function emptySpellbook(): SpellbookSnapshot {
  return { tabs: [], all: [], high: [], knownSlotOfHigh: [] };
}

interface SpellbookState {
  book: SpellbookSnapshot;
  /** What `CastSpell` should do, by 1-based `all` slot. Set by the host; a VM with no host casts nothing. */
  cast: ((slot: number) => void) | null;
}

const stateByVm = new WeakMap<LuaVM, SpellbookState>();

function stateOf(vm: LuaVM): SpellbookState {
  let state = stateByVm.get(vm);
  if (state === undefined) {
    state = { book: emptySpellbook(), cast: null };
    stateByVm.set(vm, state);
  }
  return state;
}

/**
 * THE push door. The host replaces the whole book at once, then fires `SPELLS_CHANGED`.
 *
 * Whole-snapshot rather than per-slot, unlike `api/actions.ts`'s 144 independent slots, because a
 * spellbook's slots are not independent: learning one spell shifts every offset after it and can add a
 * tab. A per-slot door would let the tabs and the list disagree for one frame, and `SpellBook_GetSpellID`
 * reads both in the same expression.
 *
 * Push THEN fire, the rule this runtime's other three bridges state: `SpellBookFrame_OnEvent` calls
 * `SpellBookFrame_Update`, which re-reads `GetNumSpellTabs` and `GetSpellTabInfo` on its first lines.
 */
/**
 * A SPELL BY ID, for a `|Hspell:<id>|h` link clicked in chat.
 *
 * A VM-KEYED HOOK, the same shape and for the same reason as
 * `api/items.ts#setItemTooltipSource`: `methods/gametooltip.ts` is a method table with no session and
 * must not grow one, and `Spell.dbc` is loaded per session by `spellbook-bridge.ts`.
 *
 * **BY ID AND NOT BY SPELLBOOK SLOT, which is the whole point.** `GameTooltip:SetSpell` takes a slot
 * and reads the player's own book -- right for the spellbook frame, and useless here: a spell linked
 * into chat is frequently one the player does not know. `Spell.dbc` has every spell, so the link
 * resolves either way. Narrowing this to the known book would have worked on the owner's own
 * `[Выстрел]` and failed silently on everyone else's.
 */
export type SpellLinkSource = (spellId: number) => {
  name: string;
  subName: string;
  description: string;
} | null;

const spellLinkByVm = new WeakMap<LuaVM, SpellLinkSource>();

export function setSpellLinkSource(vm: LuaVM, source: SpellLinkSource | null): void {
  if (source === null) {
    spellLinkByVm.delete(vm);
  } else {
    spellLinkByVm.set(vm, source);
  }
}

export function getSpellLinkSource(vm: LuaVM): SpellLinkSource | null {
  return spellLinkByVm.get(vm) ?? null;
}

export function setSpellbook(vm: LuaVM, book: SpellbookSnapshot): void {
  stateOf(vm).book = book;
}

export function getSpellbook(vm: LuaVM): SpellbookSnapshot {
  return stateOf(vm).book;
}

/** The host's cast door: what `CastSpell` calls, with a 1-based `all` slot. */
export function setSpellCastHandler(vm: LuaVM, cast: (slot: number) => void): void {
  stateOf(vm).cast = cast;
}

/** `BOOKTYPE_SPELL` (`spellbookframe.lua:5`). The only book this client can fill. */
export const BOOKTYPE_SPELL = 'spell';

/**
 * `MAX_SKILLLINE_TABS` (`spellbookframe.lua:2`) -- the book has exactly 8 tab buttons in its XML.
 *
 * The bound `GetSpellTabInfo` answers zeroes WITHIN and nothing OUTSIDE; see that function for the load
 * error that forced the distinction.
 */
export const MAX_SKILLLINE_TABS = 8;

export function installSpellsApi(vm: LuaVM): void {
  const state = stateOf(vm);

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * A `(slot, bookType)` pair to an entry, or null.
   *
   * `bookType` is checked rather than ignored: a nil book type is treated as the spell book, which is
   * what the client's own default is (`SpellBookFrame.bookType` is set to `BOOKTYPE_SPELL` in
   * `SpellBookFrame_OnLoad`), and anything else -- which in this build is only `BOOKTYPE_PET` -- answers
   * null so every getter reports "no such spell" consistently instead of showing a spell spell in the
   * pet book's slot numbering.
   */
  const entryOf = (slotValue: unknown, bookType: unknown): SpellbookEntry | null => {
    if (typeof bookType === 'string' && bookType !== BOOKTYPE_SPELL) {
      return null;
    }
    const slot = Number(slotValue);
    if (!Number.isFinite(slot) || slot < 1) {
      return null;
    }
    return state.book.all[slot - 1] ?? null;
  };

  // -- Tabs ----------------------------------------------------------------------------------------

  fn('GetNumSpellTabs', () => [state.book.tabs.length]);

  /**
   * `GetSpellTabInfo(index)` -> `name, texture, offset, numSpells, highestRankOffset, highestRankNumSpells`
   *
   * SIX values. See the file header: with `ShowAllSpellRanks` off -- the default --
   * `SpellBook_GetTabInfo` discards 3 and 4 and uses 5 and 6, so a four-return version makes `offset` nil
   * and `spellbookframe.lua:659-660` errors.
   *
   * **A MISSING TAB ANSWERS ZEROES, NOT NOTHING, and that was found live rather than reasoned out.**
   * The first version returned nothing for any index without a tab, on the argument that
   * `SpellBookFrame_Update` only asks for `i <= GetNumSpellTabs()` (`:108-109`) so the range is the
   * client's own. That argument is wrong, and the load report said so:
   *
   *     SpellBookFrame.xml:SpellBookFrame: OnLoad: SpellBookFrame.lua:626:
   *     attempt to perform arithmetic on a nil value (local 'numSpells')
   *
   * `SpellBookFrame_OnLoad:51` calls `SpellBookSkillLineTab_OnClick(nil, 1)` -> `:569`
   * `SpellBook_UpdatePageArrows` -> `SpellBook_GetCurrentPage` -> `:626`
   * `maxPages = ceil(numSpells/SPELLS_PER_PAGE)` -- and THAT path has no `numSkillLineTabs` guard at all.
   * It runs during the manifest load, when this book is still empty because the bridge attaches after it.
   * So an in-range index with no tab must answer six values whose numbers are usable: `numSpells` 0 gives
   * `maxPages` 0, which `SpellBookFrame_UpdatePages:179-181` returns early on. A name of `''` and a nil
   * texture assert nothing about a tab that does not exist.
   *
   * **The empty load-time state needs no seeding**, which is worth stating because
   * `unit-bridge.ts#seedUnitSnapshots` exists for exactly the opposite case. `MainMenuExpBar` had to be
   * seeded because it hid itself PERMANENTLY on a zero at load and nothing could bring it back. Nothing
   * here latches: `SpellBookFrame_OnShow` calls `SpellBookFrame_Update(1)`, which re-runs
   * `SpellBookSkillLineTab_OnClick` and re-reads every one of these values, so the book the player sees is
   * built from the pushed snapshot however empty it was at load.
   */
  fn('GetSpellTabInfo', (args) => {
    const index = Number(args[0]);
    if (!Number.isFinite(index) || index < 1 || index > MAX_SKILLLINE_TABS) {
      return [];
    }
    const tab = state.book.tabs[index - 1];
    if (tab === undefined) {
      return ['', null, 0, 0, 0, 0];
    }
    return [
      tab.name,
      tab.texture,
      tab.offset,
      tab.numSpells,
      tab.highestRankOffset,
      tab.highestRankNumSpells,
    ];
  });

  /**
   * `GetKnownSlotFromHighestRankSlot(slot)` -> the `all`-list slot for a `high`-list slot.
   *
   * Returns the argument unchanged when the book is empty, which is the one answer that cannot invent a
   * spell: `SpellButton_UpdateButton` then reads `all[slot-1]` and finds nothing, and hides the button --
   * exactly what it does for a slot past the end of a tab (`spellbookframe.lua:431-442`). Returning nil
   * instead would break `SpellButton_OnClick:344`'s `if ( id > MAX_SPELLS )` comparison on a nil.
   */
  fn('GetKnownSlotFromHighestRankSlot', (args) => {
    const slot = Number(args[0]);
    if (!Number.isFinite(slot) || slot < 1) {
      return [slot];
    }
    return [state.book.knownSlotOfHigh[slot - 1] ?? slot];
  });

  // -- One spell -----------------------------------------------------------------------------------

  /**
   * nil, not `''`, for a slot with no spell. `SpellButton_UpdateButton:451` tests
   * `if ( not texture or (strlen(texture) == 0) )` -- so both work here, but the same function's
   * `iconTexture:SetTexture(texture)` at `:507` would be handed `""` and draw an untextured white quad if
   * the earlier guard were ever relaxed. nil is the engine's own answer.
   */
  fn('GetSpellTexture', (args) => [entryOf(args[0], args[1])?.texture ?? null]);

  /**
   * `GetSpellName(slot, bookType)` -> `spellName, subSpellName`.
   *
   * `subSpellName` is `''` for a spell with no rank and NEVER nil -- see `SpellbookEntry#subName`.
   */
  fn('GetSpellName', (args) => {
    const entry = entryOf(args[0], args[1]);
    if (entry === null) {
      return [];
    }
    return [entry.name, entry.subName];
  });

  /**
   * `GetSpellLink(slot, bookType)` -> `spellLink, tradeSkillLink`.
   *
   * REAL, and the gap note it replaces had gone stale on BOTH of its reasons. It said the escape
   * format was unsourced and that there was no chat box to insert into. The second is simply no longer
   * true -- `ScrollingMessageFrame` is real, the chat field takes input, and `EditBox:Insert` landed
   * with the whisper work. The first was already answered elsewhere in this client:
   * `container-bridge.ts#itemLink` builds the same shape for an item and has since the bags worked.
   *
   * SHAPE: `|cAARRGGBB|Hspell:<id>|h[Name]|h|r`, which is what `markup.ts` parses back
   * (`|H<type>:<args>|h[text]|h`, and its own census counted 111 `|H` uses across the manifest) and
   * what `SetItemRef` splits on `:` to get the id. Verified by the round trip that matters: the tooltip
   * side reads exactly this and `GameTooltip:SetHyperlink`'s `spell:` arm resolves it.
   *
   * THE COLOUR IS TRANSCRIBED, NOT READ. `71d5ff` is the light blue every 3.3.5a spell link carries,
   * and no file in the 264-file manifest states it -- grepped the served Lua and XML for the literal
   * and found nothing, because the engine composes the link. So it carries the same standing note as
   * `framexml/bindings.ts`' default keys: transcribed from the shipped client, not derived from data
   * this project can read. A wrong colour here is a cosmetic defect in one direction only -- the link
   * still parses, still resolves and still opens the right tooltip.
   *
   * The SECOND return is the trade-skill link and is nil: this client has no trade skills, and
   * `SpellButton_OnModifiedClick` tests the two separately (`spellbookframe.lua:372-378`), so a nil is
   * the answer that takes the spell branch rather than a fabricated one.
   */
  fn('GetSpellLink', (args) => {
    const entry = entryOf(args[0], args[1]);
    if (entry === null) {
      return [];
    }
    return [`|cff71d5ff|Hspell:${entry.spellId}|h[${entry.name}]|h|r`, null];
  });

  /**
   * `GetSpellCooldown(slot, bookType)` -> `start, duration, enable`.
   *
   * `enable` is NUMERIC and it is **1** for an ordinary known spell, not 0.
   * `SpellButton_UpdateButton:467-471` reads `if ( enable == 1 )` and greys the icon to (0.4, 0.4, 0.4)
   * otherwise -- so returning 0 here would grey every spell in the book. It means "this spell's cooldown
   * may be displayed", the same meaning `GetActionCooldown`'s third return has in `api/actions.ts`, not
   * "a cooldown is running": `CooldownFrame_SetTimer` needs all three of `start > 0`, `duration > 0` and
   * `enable > 0` before it draws anything, so a spell with no cooldown correctly shows none.
   */
  fn('GetSpellCooldown', (args) => {
    const entry = entryOf(args[0], args[1]);
    if (entry === null) {
      return [0, 0, 0];
    }
    return [entry.cooldownStart, entry.cooldownDuration, 1];
  });

  /** `Spell.dbc` column 4 bit 0x40 -- see `pipeline/dbc/spell-data.ts#COL.attributes` for the measurement. */
  fn('IsPassiveSpell', (args) => [entryOf(args[0], args[1])?.passive ?? false]);

  /**
   * `IsSelectedSpell(slot, bookType)` -- is this the spell currently awaiting a target?
   *
   * **False is the TRUE answer in this client, not a stub.** It is what puts the checked highlight on a
   * spellbook button while a targeting cursor is armed, and this client has no spell-targeting cursor
   * state at all -- the same fact `api/actions.ts` already records for `SpellCanTargetItem`, which
   * answers false for the same reason. A cast here goes straight to `CMSG_CAST_SPELL` against the
   * player's existing selection, so no spell is ever in a pending-target state to be "selected".
   *
   * Its only consumer is `SpellButton_UpdateSelection` (`spellbookframe.lua:409-413`), which calls
   * `SetChecked("false")` on this answer -- so the visible effect of a wrong `true` would be a
   * permanently depressed button, and there is nothing that could ever clear it.
   */
  fn('IsSelectedSpell', () => [false]);

  /**
   * `GetSpellAutocast(slot, bookType)` -> `autoCastAllowed, autoCastEnabled`.
   *
   * Both nil, and both genuinely nil rather than stubbed: autocast is a PET mechanic -- it is the little
   * spinning border on a pet ability -- and no spell in a PLAYER's book has it. `SpellButton_OnClick`
   * only reaches `ToggleSpellAutocast` for `SpellBookFrame.bookType == BOOKTYPE_PET`
   * (`spellbookframe.lua:347-348`), which this client never enters. `autoCastAllowed` nil hides
   * `$parentAutoCastable` and nil `autoCastEnabled` releases the shine (`:473-493`), which is the correct
   * appearance for a player spell.
   */
  fn('GetSpellAutocast', () => [null, null]);

  /**
   * `UpdateSpells()` -- FIRES `SPELLS_CHANGED`, which is what makes the twelve buttons re-read.
   *
   * **This was a no-op for one round and that was a real defect, caught live.** The argument for the
   * no-op was that the snapshot is pushed by `ui/spellbook-bridge.ts` and is therefore always current, so
   * there was nothing left to refresh. That reasoning is about the DATA and misses what the call is FOR:
   * the client's Lua uses it to make the book's buttons redraw. `SpellBookSkillLineTab_OnClick` ends with
   *
   *     if ( update ) then UpdateSpells(); end          spellbookframe.lua:572-574
   *
   * and both page buttons call it as their last statement (`:535`, `:552`). With it doing nothing,
   * **clicking a skill-line tab or a page arrow changed `selectedSkillLine` and redrew nothing** -- measured
   * live: selecting tab 4 (Elemental Combat) left all twelve buttons showing the General tab's spells.
   *
   * `SPELLS_CHANGED` is the right mechanism and not a substitute for one: every `SpellButton` registers it
   * in its own `OnShow` (`spellbookframe.lua:311`) and routes it to `SpellButton_UpdateButton`
   * (`:296-298`), which is exactly "re-read my slot and redraw me". That is the event the engine's
   * `UpdateSpells` raises.
   *
   * The re-entrancy guard is not decoration. `SpellBookFrame_OnEvent`'s `SPELLS_CHANGED` branch calls
   * `SpellBookFrame_Update` when the book is visible (`:58-61`), which reaches
   * `SpellBookFrame_UpdatePages`, which calls `UpdateSpells()` again on the `currentPage > maxPages` branch
   * (`:189`). That converges -- the branch clamps the page first -- but it is one Lua edit away from not
   * doing, and an event storm inside a pointer handler has no report to land in.
   */
  let updating = false;
  fn('UpdateSpells', () => {
    if (updating) {
      return [];
    }
    updating = true;
    try {
      fireEvent(vm, 'SPELLS_CHANGED');
    } finally {
      updating = false;
    }
    return [];
  });

  /**
   * `CastSpell(slot, bookType)` -- clicking a spell in the book casts it.
   *
   * `SpellButton_OnClick:350`. The host handler is the same door `UseAction` uses, so a spell cast from
   * the book and the same spell cast from the bar take one path to the wire.
   */
  fn('CastSpell', (args) => {
    const entry = entryOf(args[0], args[1]);
    const slot = Number(args[0]);
    if (entry === null || state.cast === null || !Number.isFinite(slot)) {
      return [];
    }
    state.cast(slot);
    return [];
  });

  /**
   * Declared gaps. Each is registered by NAME so `NOT_IMPLEMENTED` and the load report carry it, using
   * the same adaptation `api/actions.ts:367-373` documents: `notImplemented` builds a FRAME METHOD
   * `(ctx, self, args)` and a global takes only args, so the stub is called through rather than
   * registered directly. What is reused is the name registration, which is the half the report reads.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    [
      /**
       * `HasPetSpells()` -> `numPetSpells, petToken`.
       *
       * THE ONE GLOBAL THAT WAS BLOCKING THE PANEL: `ToggleSpellBook("spell")` reached
       * `spellbookframe.lua:15` and raised on this being nil, which is as far as opening the book ever got.
       *
       * **nil, and it must be nil rather than 0.** 0 is TRUTHY in Lua, so a 0 would make
       * `SpellBookFrame_Update:129`'s `if ( hasPetSpells )` true and draw a pet tab for a character with no
       * pet -- and `SpellBook_GetCurrentPage:622` then computes `ceil(numPetSpells/SPELLS_PER_PAGE)`
       * ARITHMETICALLY on it, so the value has to be a number when it is one at all.
       *
       * A gap and not an answer, because the honest answer is unknown for a class that HAS a pet:
       * `SMSG_PET_SPELLS` (0x179) sits in `network/game/opcode.js:379` with no subscriber and nothing in
       * this client tracks a pet, so a hunter or warlock with a live pet would also get nil here. For the
       * test characters (the shaman `Sgh` has no pet) nil is correct; for a hunter it is a lie this
       * declares rather than hides.
       */
      'HasPetSpells',
      'no pet feed: SMSG_PET_SPELLS (0x179) has no subscriber and nothing in this client tracks a pet, '
        + 'so the pet book is absent for every character -- correct for one with no pet, wrong for a '
        + 'hunter or warlock with one',
      [null],
    ],

    [
      // `SpellButton_OnClick:348`, pet book only. Needs `CMSG_PET_SPELL_AUTOCAST` and the pet feed above.
      'ToggleSpellAutocast',
      'pet autocast needs the pet feed HasPetSpells declares plus CMSG_PET_SPELL_AUTOCAST, neither of '
        + 'which exists; unreachable in any case because the pet book cannot be opened',
      [],
    ],
  ];

  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    fn(name, () => stub(null as never, 0, []));
  }
}
