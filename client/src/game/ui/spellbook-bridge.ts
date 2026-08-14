/**
 * THE SEAM between the character's known spells and the client's own `SpellBookFrame`, and the seam
 * between the cursor and the wire.
 *
 * `lua/api/spells.ts` holds the spellbook snapshot and `lua/api/cursor.ts` holds the cursor, and both say
 * at the top that they contain no world, no network and no DBCs. This is the host for both. It is the
 * exact counterpart of `action-bridge.ts` and follows its two rules: **push then fire**, and **fire only
 * for what changed**, because an event here re-runs `SpellBookFrame_Update` over 12 buttons and 8 tabs and
 * every texture it rewrites dirties the draw fingerprint (`world-ui.ts#drawListSignature`).
 *
 * ## Building the book: three sorts and one join
 *
 * `SMSG_INITIAL_SPELLS` gives a flat, unordered set of spell ids -- 54 of them for the shaman test
 * character. `SpellBookFrame` needs them grouped into tabs, and inside a tab ordered so that a page of 12
 * is a sensible page. The whole derivation:
 *
 *  1. **Group.** `skillData.classLineOf(spellId)` joins through `SkillLineAbility.dbc` to the spell's
 *     `SkillLine`, keeping only `categoryID == 7` (class skills). A spell no class line claims -- a
 *     racial, First Aid, an armour proficiency, Auto Attack -- goes in the **General** tab.
 *     See `pipeline/dbc/skill-data.ts` for the measured columns and the whole category partition.
 *  2. **Order the tabs.** General first, then the class lines by ascending `SkillLine.id`. The second
 *     half is OURS and is known to differ from the real client -- see `skill-data.ts`'s header, which
 *     states it rather than leaving it to look deliberate.
 *  3. **Order inside a tab.** By spell NAME, then by `spellLevel`, then by id. Name first so every rank of
 *     one spell is contiguous, which is what makes the "highest rank only" view a contiguous slice too;
 *     `spellLevel` second because it is what ascends with rank (measured -- see
 *     `spell-data.ts#COL.spellLevel`, and note the obvious column `SkillLineAbility.forward_spellid` was
 *     measured to be 0 for every rank member and is NOT the rank chain).
 *
 * The `high` list is then the last member of each name group per tab, and `knownSlotOfHigh` records where
 * each of those sits in the full list -- which is precisely what `GetKnownSlotFromHighestRankSlot` answers.
 *
 * ## Why the icons are registered here
 *
 * The same `registerTreeArt` hazard `action-bridge.ts`'s header documents: `registerTreeArt` walks the
 * finished tree ONCE after the load, and every spellbook icon path is set later, from
 * `SpellButton_UpdateButton`'s `iconTexture:SetTexture(texture)`. An unregistered key makes
 * `art.texture()` return null for ever and the quad is silently skipped -- an empty book with no
 * explanation. So this bridge registers each path and re-`load()`s, exactly as the action bridge does.
 */
import World from '../world';
import { GlueArt } from './art';
import {
  MAX_SKILLLINE_TABS, SpellbookEntry, SpellbookSnapshot, SpellbookTab, emptySpellbook, getSpellbook,
  setSpellCastHandler, setSpellbook,
} from './framexml/lua/api/spells';
import { CursorPayload, setCursorHandlers } from './framexml/lua/api/cursor';
import { SPELL_AUTO_ATTACK, SpellHandler } from '../../network/game/object/spells';
import { fireEvent } from './framexml/lua/events';
import { spellData } from '../pipeline/dbc/spell-data';
import { renderSpellDescription } from '../pipeline/dbc/spell-description';
import { casterStatsFor } from './caster-stats';
import { skillData } from '../pipeline/dbc/skill-data';
import { LuaVM } from './framexml/lua/vm';

/**
 * `GENERAL_SPELLS` -- the first tab's name, and it is the client's own global string, not a literal
 * invented here: `globalstrings.lua:3792`, `GENERAL_SPELLS = "General"`.
 *
 * Read out of the VM rather than hardcoded, so a localised build gets its own word. Falls back to the
 * enUS value only if the global is missing, which would mean `GlobalStrings.lua` did not load at all.
 */
const GENERAL_TAB_FALLBACK = 'General';

/**
 * THE GENERAL TAB HAS NO ICON, and that is a DECLARED GAP rather than a chosen texture.
 *
 * The value here was `Interface\Icons\INV_Misc_QuestionMark`, justified by a comment claiming "this is
 * what the real client's General tab shows". **That claim was unsourced and is now refuted**, which
 * under `CLAUDE.md` makes the comment itself the defect -- the owner's report was "вкладка general все
 * ещё с вопросительным знаком".
 *
 * Searched, and the client's own files do not specify it:
 *
 *  - `spellbookframe.lua:107-112` sets a tab's art from `GetSpellTabInfo(i)`'s SECOND return
 *    (`skillLineTab:SetNormalTexture(texture)`), so the path is engine-side for every tab including the
 *    first. There is no literal anywhere in the file.
 *  - `SpellBookSkillLineTabTemplate` authors `<NormalTexture/>` -- **EMPTY, no `file` attribute**
 *    (`spellbookframe.xml:41`). The only art the template carries is the tab FRAME
 *    (`Interface\SpellBook\SpellBook-SkillLineTab`, `:15`) plus its highlight and checked states.
 *  - `SkillLine.dbc` has **no row named "General"** at all: scanned all 150 records of the served file
 *    (56 fields, recordSize 224), and its 39 category-7 rows are the class lines -- Frost, Fire, Arms,
 *    Combat, Subtlety, Assassination, ... and the 20 `Pet - *` lines. So there is no `spellIconID` to
 *    resolve, which is why this tab needed a decision at all. Its NAME is the client's own
 *    `GENERAL_SPELLS`; its icon has no equivalent.
 *
 * So `null`: an empty normal texture, which is exactly what the template itself authors. The tab draws
 * its frame with no icon inside -- visibly incomplete rather than plausibly wrong, which is the
 * standard this round holds for the description tokens too.
 *
 * A class line whose `spellIconID` does not resolve gets the same null for the same reason.
 *
 * **TAB ORDER is still ours and still differs from the real client** (ascending `SkillLine.id`). The
 * rule is not in `spellbookframe.lua` either: `SpellBookFrame_Update:103-122` walks `1..GetNumSpellTabs()`
 * and asks the engine for each, so the ordering lives entirely behind `GetSpellTabInfo`. Recorded, not
 * closed.
 */
const GENERAL_TAB_ICON = null;

interface Grouped {
  /** null is the General tab. */
  lineId: number | null;
  name: string;
  texture: string | null;
  entries: SpellbookEntry[];
}

export function attachSpellbookBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const spells: SpellHandler = world.game.objectHandler.spellHandler;

  // `discards` is new with the world-drop gesture: it is the only counter that says a slot was EMPTIED
  // rather than moved, which is what separates "the drop cleared the wrong slot" from "the drop never
  // reached the engine at all".
  const stats = {
    builds: 0, events: 0, tabs: 0, spells: 0, picks: 0, places: 0, moves: 0, discards: 0,
  };

  const entryFor = (spellId: number): SpellbookEntry => {
    const row = spellData.spell(spellId);
    const cooldown = spells.cooldownOf(spellId);
    return {
      spellId,
      name: row?.name ?? '',
      // `''` and never null -- `SpellbookEntry#subName` says why.
      subName: row?.subName ?? '',
      // THE DESCRIPTION IS EVALUATED HERE, not in the tooltip method: `$s1`/`$AP`/`$<mult>` need the
      // spell's own effect columns AND the player's live stats, and this is the seam that has both.
      // A token the evaluator cannot resolve is left VISIBLE -- see `spell-description.ts`.
      description: row === null ? '' : renderSpellDescription(row, casterStatsFor(world, spells)),
      texture: spellData.iconPath(spellId),
      passive: row?.passive ?? false,
      cooldownStart: cooldown?.start ?? 0,
      cooldownDuration: cooldown?.duration ?? 0,
    };
  };

  /** The general string, from the VM's own globals. See `GENERAL_TAB_FALLBACK`. */
  const generalName = (): string => {
    const value = vm.getGlobal('GENERAL_SPELLS');
    return typeof value === 'string' && value !== '' ? value : GENERAL_TAB_FALLBACK;
  };

  /**
   * Build the whole snapshot. See the file header for the three sorts and the join.
   *
   * Tolerant of every table being absent, and that tolerance is the design rather than a guard: the boot
   * order puts this bridge before `Spell.dbc`'s 49 MB fetch resolves, so the FIRST book is built with no
   * names and no icons. It still has the right SHAPE -- one General tab holding every known spell -- and
   * the rebuild when the tables land fills it in. A book that appears empty until 49 MB arrives would look
   * broken; a book with the right number of buttons and blank labels looks like it is loading, which it is.
   */
  const build = (): SpellbookSnapshot => {
    const known = [...spells.knownSpells()];
    if (known.length === 0) {
      return emptySpellbook();
    }

    // 1. GROUP by class skill line; null is General.
    const groups = new Map<number | null, Grouped>();
    for (const spellId of known) {
      /**
       * THE BOOK'S ONE FILTER: `Spell.dbc` column 4 bit **0x80**, DO NOT DISPLAY.
       *
       * This is what was putting `Rogue Passive (DND)`, `Unarmed`, `Thrown`, `Defense`, `Two-Handed
       * Swords`, `Plate Mail` and the rest of the weapon and armour PROFICIENCIES in the book -- the
       * server sends them in `SMSG_INITIAL_SPELLS` because the character genuinely knows them, and the
       * real client hides them here rather than the server withholding them.
       *
       * `SpellRow#hiddenInSpellbook` carries the measurement, including why the `(DND)` NAME and the
       * weapon SKILL CATEGORY were both tested and are both wrong -- category 6 would delete `Dual
       * Wield`, `Dodge`, `Block`, `Parry`, `Throw` and `Shoot`, which the real client shows.
       *
       * A spell whose row is not loaded yet is KEPT, not dropped: until the 49 MB `Spell.dbc` fetch lands
       * every row is null, and dropping on a null would build the first book empty and then repopulate it,
       * which is the opposite of the "right shape, blank labels" behaviour this function is written for.
       */
      if (spellData.spell(spellId)?.hiddenInSpellbook === true) {
        continue;
      }
      const line = skillData.classLineOf(spellId);
      const key = line?.id ?? null;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          lineId: key,
          name: line?.name ?? generalName(),
          texture: line === null
            ? GENERAL_TAB_ICON
            : spellData.icon(line.spellIconID) ?? GENERAL_TAB_ICON,
          entries: [],
        };
        groups.set(key, group);
      }
      group.entries.push(entryFor(spellId));
    }

    // 2. ORDER the tabs: General first, then class lines by ascending SkillLine.id.
    const ordered = [...groups.values()].sort((a, b) => {
      if (a.lineId === null) {
        return -1;
      }
      if (b.lineId === null) {
        return 1;
      }
      return a.lineId - b.lineId;
    });

    // `MAX_SKILLLINE_TABS` is a hard limit in the XML -- there are 8 `SpellBookSkillLineTab` buttons and
    // `SpellBookFrame_Update` indexes `_G["SpellBookSkillLineTab"..i]` up to it, so a 9th tab would be a
    // nil index. Truncation happens HERE rather than in `api/spells.ts` so the Lua side never sees a book
    // it cannot draw. No test character comes near it (a shaman has 4 tabs including General).
    if (ordered.length > MAX_SKILLLINE_TABS) {
      console.warn(
        `spellbook: ${ordered.length} tabs but the book has only ${MAX_SKILLLINE_TABS} tab buttons; `
        + `the last ${ordered.length - MAX_SKILLLINE_TABS} skill line(s) and their spells are not shown`,
      );
      ordered.length = MAX_SKILLLINE_TABS;
    }

    // 3. ORDER inside a tab, and build both lists.
    const tabs: SpellbookTab[] = [];
    const all: SpellbookEntry[] = [];
    const high: SpellbookEntry[] = [];
    const knownSlotOfHigh: number[] = [];

    for (const group of ordered) {
      group.entries.sort((a, b) => (
        a.name.localeCompare(b.name)
        || (spellData.spell(a.spellId)?.spellLevel ?? 0) - (spellData.spell(b.spellId)?.spellLevel ?? 0)
        || a.spellId - b.spellId
      ));

      const offset = all.length;
      const highestRankOffset = high.length;
      for (let i = 0; i < group.entries.length; i += 1) {
        const entry = group.entries[i];
        all.push(entry);
        // The HIGHEST rank of a name group is its LAST member, because the sort above put the group
        // together and ordered it by ascending `spellLevel`. So an entry is a top rank exactly when the
        // next entry in the tab has a different name (or there is no next entry).
        const next = group.entries[i + 1];
        if (next === undefined || next.name !== entry.name) {
          high.push(entry);
          // 1-based on both sides: `all.length` is already this entry's 1-based index, since it was just
          // pushed.
          knownSlotOfHigh.push(all.length);
        }
      }

      tabs.push({
        name: group.name,
        texture: group.texture,
        offset,
        numSpells: all.length - offset,
        highestRankOffset,
        highestRankNumSpells: high.length - highestRankOffset,
      });
    }

    stats.builds += 1;
    stats.tabs = tabs.length;
    stats.spells = all.length;
    return { tabs, all, high, knownSlotOfHigh };
  };

  /** Cheap equality: the book is rebuilt from scratch, so this decides whether to ANNOUNCE it. */
  const same = (a: SpellbookSnapshot, b: SpellbookSnapshot): boolean => {
    if (a.all.length !== b.all.length || a.tabs.length !== b.tabs.length) {
      return false;
    }
    for (let i = 0; i < a.tabs.length; i += 1) {
      const x = a.tabs[i];
      const y = b.tabs[i];
      if (x.name !== y.name || x.texture !== y.texture || x.offset !== y.offset
        || x.numSpells !== y.numSpells || x.highestRankOffset !== y.highestRankOffset
        || x.highestRankNumSpells !== y.highestRankNumSpells) {
        return false;
      }
    }
    for (let i = 0; i < a.all.length; i += 1) {
      const x = a.all[i];
      const y = b.all[i];
      if (x.spellId !== y.spellId || x.name !== y.name || x.subName !== y.subName
        || x.texture !== y.texture || x.passive !== y.passive
        || x.cooldownStart !== y.cooldownStart || x.cooldownDuration !== y.cooldownDuration) {
        return false;
      }
    }
    return true;
  };

  const push = (): void => {
    const next = build();
    if (same(getSpellbook(vm), next)) {
      return;
    }
    // Register the tab and icon art BEFORE the event, so the `SetTexture` calls the event provokes name
    // keys that at least have a def -- see the file header on the `registerTreeArt` hazard.
    const paths = new Set<string>();
    for (const tab of next.tabs) {
      if (tab.texture !== null) {
        paths.add(tab.texture);
      }
    }
    for (const entry of next.all) {
      if (entry.texture !== null) {
        paths.add(entry.texture);
      }
    }
    for (const path of paths) {
      art.register(path, { path });
    }
    if (paths.size > 0) {
      void art.load();
    }

    setSpellbook(vm, next);
    // `SPELLS_CHANGED` is what `SpellBookFrame_OnLoad` registers (`spellbookframe.lua:35`) and what
    // `SpellButton_OnShow` registers on every button (`:311`). One event re-reads the whole book, which is
    // one fingerprint change rather than one per button.
    fireEvent(vm, 'SPELLS_CHANGED');
    stats.events += 1;
  };

  // -- The cursor's host half ------------------------------------------------------------------------

  /** The spellbook slot a spell sits in, or null -- `GetCursorInfo`'s payload. See `CursorPayload`. */
  const bookSlotOf = (spellId: number): number | null => {
    const book = getSpellbook(vm);
    const index = book.all.findIndex((entry) => entry.spellId === spellId);
    return index < 0 ? null : index + 1;
  };

  setCursorHandlers(vm, {
    /** `PickupAction` -- what is in a bar slot. */
    pick: (action: number): CursorPayload | null => {
      const spellId = spells.spellInSlot(action);
      if (spellId === null) {
        return null;
      }
      stats.picks += 1;
      return {
        kind: 'action',
        spellId,
        bookSlot: bookSlotOf(spellId),
        sourceSlot: action,
        texture: spellData.iconPath(spellId),
      };
    },

    /** `PickupSpell` -- what is in a spellbook slot. */
    pickSpell: (slot: number): CursorPayload | null => {
      const entry = getSpellbook(vm).all[slot - 1];
      if (entry === undefined || entry.spellId === 0) {
        return null;
      }
      // A PASSIVE spell cannot go on the action bar -- there is nothing to activate. The real client
      // refuses the pickup rather than letting a dead icon be placed, and `SpellButton_OnDrag` has already
      // filtered the obvious case (a passive still has an icon, so its own `IsShown` guard does not).
      if (entry.passive) {
        return null;
      }
      stats.picks += 1;
      return {
        kind: 'spell',
        spellId: entry.spellId,
        bookSlot: slot,
        sourceSlot: null,
        texture: entry.texture,
      };
    },

    /**
     * `PlaceAction` -- commit the drop, and TELL THE SERVER.
     *
     * A bar-to-bar drag SWAPS (`moveActionButton`); a book-to-bar drag overwrites (`assignActionButton`).
     * Both go through `SpellHandler`, which owns the slot array and the socket, and both emit
     * `actionsChanged` -- which `action-bridge.ts` is already subscribed to, so the bar redraws through
     * the path it always used rather than a second one invented here.
     *
     * Returns false for a no-op so `PlaceAction` leaves the ability on the cursor rather than losing it.
     */
    place: (destination: number, payload: CursorPayload): boolean => {
      if (payload.kind === 'action' && payload.sourceSlot !== null) {
        if (payload.sourceSlot === destination) {
          // Dropped back where it came from. Nothing changed, nothing is sent, and the cursor is still
          // cleared -- the gesture is over. True, not false: false would leave the player carrying it.
          return true;
        }
        spells.moveActionButton(payload.sourceSlot, destination);
        stats.moves += 1;
        return true;
      }
      if (payload.spellId === 0) {
        return false;
      }
      spells.assignActionButton(destination, payload.spellId);
      stats.places += 1;
      return true;
    },

    /**
     * The DISCARD -- an ability dropped on the world. `clearActionButton` sends
     * `CMSG_SET_ACTION_BUTTON` with `packedData == 0` (the opcode's own remove form) and emits
     * `actionsChanged`, so the button empties through the same path a move redraws through.
     */
    discard: (sourceSlot: number): void => {
      spells.clearActionButton(sourceSlot);
      stats.discards += 1;
    },
  });

  /**
   * `CastSpell(slot)` -- clicking a spell in the book.
   *
   * Auto Attack is special-cased for the same reason `action-bridge.ts#use` special-cases it: 6603 is a
   * spell by identity and an opcode by mechanism, and sending it through `CMSG_CAST_SPELL` is refused.
   * A PASSIVE spell is not cast at all -- there is nothing to send, and the server would refuse it.
   */
  setSpellCastHandler(vm, (slot: number): void => {
    const entry = getSpellbook(vm).all[slot - 1];
    if (entry === undefined || entry.spellId === 0 || entry.passive) {
      return;
    }
    const target = world.game.objectHandler.combatHandler.selection;
    if (entry.spellId === SPELL_AUTO_ATTACK) {
      if (spells.autoAttackOn) {
        world.game.objectHandler.combatHandler.stopAttack();
      } else if (target !== null) {
        world.game.objectHandler.combatHandler.startAttack(target);
      }
      return;
    }
    spells.castSpell(entry.spellId, target);
  });

  /**
   * A COOLDOWN CHANGE updates two numbers per entry and fires `SPELL_UPDATE_COOLDOWN` -- it does NOT
   * rebuild the book and does NOT fire `SPELLS_CHANGED`.
   *
   * Self-review caught the first draft doing both, and it was the frame-budget trap this project's own
   * notes warn about. Every confirmed cast stamps the global cooldown on every known spell, so
   * `cooldownsChanged` fires constantly; routing that through `push` re-sorted 45 spells through
   * `localeCompare`, found the cooldown fields different (they always are), and fired `SPELLS_CHANGED` --
   * which re-runs `SpellBookFrame_Update` over 12 buttons and 8 tabs and rewrites every texture, dirtying
   * the draw fingerprint. `world-ui.ts`'s note is explicit that anything dirtying it repeatedly gives the
   * whole offscreen-target saving back.
   *
   * `SPELL_UPDATE_COOLDOWN` is the right event and not a cheaper substitute for one: `SpellButton_OnShow`
   * registers it alongside `SPELLS_CHANGED` (`spellbookframe.lua:312`) and `SpellButton_OnEvent` routes
   * both to `SpellButton_UpdateButton` (`:296-298`). Exactly the split `action-bridge.ts#pushCooldowns`
   * already makes for the same reason.
   */
  const pushCooldowns = (): void => {
    const book = getSpellbook(vm);
    let changed = false;
    for (const entry of book.all) {
      const cooldown = spells.cooldownOf(entry.spellId);
      const start = cooldown?.start ?? 0;
      const duration = cooldown?.duration ?? 0;
      if (entry.cooldownStart === start && entry.cooldownDuration === duration) {
        continue;
      }
      // Mutated in place. `all` and `high` SHARE their entry objects (`high` holds references to members
      // of `all`, see `build`), so one write updates both views -- which is the point of sharing them.
      entry.cooldownStart = start;
      entry.cooldownDuration = duration;
      changed = true;
    }
    if (changed) {
      fireEvent(vm, 'SPELL_UPDATE_COOLDOWN');
      stats.events += 1;
    }
  };

  spells.on('spellsChanged', push);
  spells.on('cooldownsChanged', pushCooldowns);

  // `SMSG_INITIAL_SPELLS` is in the login burst and the manifest load takes 8-22 s, so the spells are
  // already in hand when this attaches. Same reason `action-bridge.ts` pushes on attach.
  push();

  // Both tables are re-pushed when they land. `Spell.dbc` is NOT fetched here -- `action-bridge.ts` owns
  // that call for the starvation reason its header documents, and `ensureLoaded` is idempotent, so this
  // rides the same promise rather than starting a second 49 MB fetch.
  void spellData.ensureLoaded().then(push);
  void skillData.ensureLoaded().then(push);

  (window as unknown as Record<string, unknown>).spellbookStats = stats;

  return () => {
    spells.removeListener('spellsChanged', push);
    spells.removeListener('cooldownsChanged', pushCooldowns);
    delete (window as unknown as Record<string, unknown>).spellbookStats;
  };
}
