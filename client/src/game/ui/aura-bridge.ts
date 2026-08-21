/**
 * THE BUFF/DEBUFF FRAME'S AND THE STANCE BAR'S ENGINE GLOBALS.
 *
 * The wire half is `network/game/object/auras.ts`; the DBC halves are `pipeline/dbc/spell-data.ts` (the
 * icon, the name, the rank, the dispel type, and the shapeshift effect) and the already-decoded
 * `SpellShapeshiftForm.dbc` (`pipeline/dbc/shapeshift-data.ts`). This file is the join the client's own
 * Lua reads. **No frame is built here and none may be**: `BuffFrame`, `BuffButtonTemplate`,
 * `DebuffButtonTemplate`, `ConsolidatedBuffs`, `TemporaryEnchantFrame` and `ShapeshiftBarFrame` are all
 * the client's own (`buffframe.xml`, `bonusactionbarframe.xml:201`).
 *
 * ## THE CONTRACT, read off the client's own destructuring
 *
 *     name, rank, texture, count, debuffType, duration, expirationTime, _, _, shouldConsolidate
 *       = UnitAura(unit, index, filter)
 *
 * (`buffframe.lua:125`.) The 8th is `unitCaster`, the 9th `isStealable` and the 11th `spellId` --
 * `targetframe.lua:3268,3314` reads the same call and `unitpopup`/`targetframe` between them read every
 * position, so all eleven are returned in order.
 *
 * **THE LIST MUST BE DENSE, and this is the sharpest correctness rule in this file.** `BuffFrame_Update`
 * walks 1..32 and counts the non-nil answers into `BUFF_ACTUAL_DISPLAY` (`buffframe.lua:85-89`), and
 * `BuffFrame_UpdateAllBuffAnchors` then walks 1..`BUFF_ACTUAL_DISPLAY` doing `buff.consolidated` on
 * `_G["BuffButton"..i]` (`:283-285`). A HOLE -- index 2 nil while index 3 answers -- makes that second
 * walk index a button that was never created and raise on a nil. So `auraList` below filters FIRST and
 * indexes the filtered array; an aura it cannot name is dropped from the list entirely rather than
 * returned nameless or left as a gap in the numbering.
 *
 * ## `0` IS TRUTHY IN LUA, and this contract has four positions where that decides a branch
 *
 * `CLAUDE.md` records four occurrences of this defect already. Here:
 *
 *  - `count` must be a NUMBER, never nil: `count > 1` (`:208`) is arithmetic and nil raises. 0 is right
 *    for a non-stacking aura and `0 > 1` is false, so the stack text hides.
 *  - `duration` must be a NUMBER, never nil: `duration > 0` (`:182`) is arithmetic too. 0 means
 *    permanent.
 *  - `expirationTime` must be **nil** for a permanent aura, not 0. The test is
 *    `duration > 0 and expirationTime`, so a 0 there would be TRUTHY and a permanent aura would get an
 *    `OnUpdate` handler counting down from a fixed point -- which is exactly the "plausible and wrong"
 *    failure the rule warns about. It comes back nil because `AuraEntry#expiresAt` is null.
 *  - `debuffType` must be **nil** rather than the empty string when the dispel type is not one of the
 *    four the client knows. `DebuffTypeColor[""]` IS defined (`:21`) so an empty string would silently
 *    take the "none" colour by a different route -- the same answer today, and a landmine if that table
 *    ever changes. nil takes the explicit `else` branch at `:174`.
 *
 * ## COST -- auras are the hardest case in the interface and this is the number
 *
 * The interface renders to an offscreen target redrawn only when a draw-list fingerprint changes, worth
 * 4-7.5 ms on ~92% of frames. **Nothing in this file is per-frame.** Two things make that true:
 *
 *  1. **The expiry is ABSOLUTE and computed once, at receipt** (`auras.ts#AuraEntry.expiresAt`). A
 *     getter that answered "seconds remaining" would return a different number on every call, and
 *     `AuraButton_Update` runs 48 of them per `UNIT_AURA`; worse, a value that changes between two reads
 *     in the same frame is indistinguishable from the stale-handle defect that has voided four
 *     measurement arms here.
 *  2. **The filtered list is memoised against `AuraHandler#version`**, so `BuffFrame_Update`'s 48
 *     `UnitAura` calls cost one array index each rather than 48 filter passes over the slot map.
 *
 * What DOES cost frames is the client's own `AuraButton_OnUpdate`, and it is bounded and honest:
 * `SetAlpha(BuffFrame.BuffAlphaValue)` runs only while an aura has under `BUFF_WARNING_TIME` = 31 s left
 * (`:234-237`), and that flashing IS the feature. Above 31 s the body writes `SetAlpha(1.0)` on a widget
 * already at 1.0 and calls `AuraButton_UpdateDuration`, which -- with `SHOW_BUFF_DURATIONS` at its
 * shipped default of `"0"` (`interfaceoptionsframe.lua:312`) -- calls `Hide()` on an already-hidden
 * FontString. Neither restamps, so the fingerprint cost of a screen full of long buffs is ZERO. That is
 * the same result the cooldown sweeps, the selection ring and the nameplates measured, reached a
 * different way: they draw outside the widget list, and this writes values that do not move.
 */
import type World from '../world';
import type { GlueArt } from './art';
import { LuaVM } from './framexml/lua/vm';
import { fireEvent } from './framexml/lua/events';
import { notImplemented } from './framexml/lua/methods/region';
import { setAuraTooltipSource, setShapeshiftTooltipSource } from './framexml/lua/api/auras';
import { resolveUnitToken } from '../world/unit-tokens';
import { spellData } from '../pipeline/dbc/spell-data';
import type { AuraEntry, AuraHandler } from '../../network/game/object/auras';
import { AFLAG_NEGATIVE } from '../../network/game/object/auras';
import type { SpellHandler } from '../../network/game/object/spells';
import type Unit from '../classes/unit';

/**
 * `SPELL_AURA_MOD_SHAPESHIFT`, the `AuraType` that makes a known spell a STANCE.
 *
 * Same vocabulary and same class of source as the `AuraType` constants in
 * `network/game/object/combat-log.ts`, which records the one corroboration available: aura type ids are
 * DBC-facing -- `Spell.dbc`'s `EffectApplyAuraName` columns hold them -- and did not renumber between
 * 1.12 and 3.3.5a. This one has a second, stronger check available and it is taken below: the forms it
 * finds for a warrior must be exactly the three `SpellShapeshiftForm.dbc` gives bonus bars 1, 2 and 3.
 */
const AURA_MOD_SHAPESHIFT = 36;

/**
 * `DispelType` -> the string `DebuffTypeColor` is keyed by.
 *
 * VERIFIED against the served `DBFilesClient/SpellDispelType.dbc` -- see `spell-data.ts#COL.dispelType`
 * for the full 12-row dump. Ids 5..11 (Stealth, Invisibility, `All(M+C+D+P)`, `Special - npc only`,
 * Enrage, `ZG Trinkets`, `ZZOLD UNUSED`) have NO entry in the client's own table, so they answer nil,
 * which is the engine's own answer and takes `buffframe.lua:174`'s explicit else.
 */
function dispelName(dispelType: number): string | null {
  switch (dispelType) {
    case 1: return 'Magic';
    case 2: return 'Curse';
    case 3: return 'Disease';
    case 4: return 'Poison';
    default: return null;
  }
}

/** One stance-bar position. Built once per known-spell change; see `shapeshiftForms`. */
interface ShapeshiftForm {
  /** `SpellShapeshiftForm.dbc` id -- 17/18/19 for a warrior's three stances, 30 for a rogue's Stealth. */
  form: number;
  spellId: number;
}

export function attachAuraBridge(vm: LuaVM, world: World, art: GlueArt): () => void {
  const auras: AuraHandler = world.game.objectHandler.auraHandler;
  const spells: SpellHandler = world.game.objectHandler.spellHandler;

  /** For the frame-cost measurement: pushes, events, and how much work the memo saved. */
  const stats = {
    events: 0,
    listBuilds: 0,
    listHits: 0,
    unnamed: 0,
    forms: 0,
    trackedUnits: 0,
    unclassified: 0,
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  // -- The aura list ---------------------------------------------------------------------------------

  /**
   * `guid|filter` -> the dense, ordered list `UnitAura`'s index addresses, memoised against the
   * handler's revision.
   *
   * Cleared wholesale on a version bump rather than per unit: a bump means SOME unit changed and the map
   * holds at most a handful of entries (the player, the target, whatever is hovered), so finding out
   * which would cost more than rebuilding the two or three lists that are asked for again.
   */
  let listCache = new Map<string, AuraEntry[]>();
  let cachedVersion = -1;

  /**
   * The FILTER, parsed off the string the client passes.
   *
   * `HELPFUL` and `HARMFUL` are the two that matter and they are mutually exclusive. **A nil or empty
   * filter means HELPFUL** -- that is the engine's own default and it is load-bearing here:
   * `TargetFrame_UpdateAuras` calls `UnitBuff(self.unit, i)` with no filter at all
   * (`targetframe.lua:457`), so defaulting to "everything" would put debuffs in the buff row.
   *
   * `PLAYER` is honoured: it restricts to auras WE cast, which is what makes a target's own debuffs
   * from other players stay out of the player-cast row. The remaining documented tokens --
   * `RAID`, `CANCELABLE`, `NOT_CANCELABLE` -- are IGNORED rather than guessed at: `RAID` needs a raid
   * roster this client does not have, and the cancelable pair needs the spell attribute bit that gates
   * `CMSG_CANCEL_AURA`, which is not read. Ignoring a restriction shows MORE auras than the real client
   * would, never fewer, so nothing disappears; stated here rather than left to the code's silence.
   */
  const parseFilter = (raw: unknown, harmful?: boolean): { harmful: boolean; playerOnly: boolean } => {
    const text = typeof raw === 'string' ? raw.toUpperCase() : '';
    return {
      // `harmful` FORCED is what `UnitBuff`/`UnitDebuff` pass, and forcing it is the point: those two
      // are named by their filter, so `UnitBuff(unit, i, "PLAYER")` must stay helpful. An earlier version
      // built the filter by string concatenation and `UnitDebuff`'s "HARMFUL" prefix could be re-read
      // out of a caller's own argument -- self-review caught it; the comment said the name won and the
      // code let the argument win.
      harmful: harmful ?? text.includes('HARMFUL'),
      playerOnly: text.includes('PLAYER'),
    };
  };

  /**
   * The dense list for one unit and one filter.
   *
   * HELPFUL/HARMFUL comes off the WIRE, not off the DBC: `AFLAG_NEGATIVE` is what the server set from
   * the spell's own positive/negative evaluation combined with who cast it, so it is right for the cases
   * a DBC read gets wrong (a friendly spell cast by an enemy; a debuff a player applies to himself).
   * See `auras.ts#AFLAG_CASTER` for the flag block and `AuraHandler#unclassified` for the counter that
   * makes the fallback observable -- an entry with neither bit set is treated as HELPFUL, which is the
   * side that shows it rather than hides it.
   *
   * An aura whose `Spell.dbc` row is missing is DROPPED, not returned nameless: `AuraButton_Update`
   * needs a name to do anything at all, and a hole in the numbering raises (see the file header). The
   * drop is counted so a probe can tell "no auras" from "auras with no rows yet" -- which is exactly
   * what the first 49 MB of `Spell.dbc` still loading looks like.
   */
  const auraList = (guid: string, harmful: boolean, playerOnly: boolean): AuraEntry[] => {
    if (cachedVersion !== auras.version) {
      listCache = new Map();
      cachedVersion = auras.version;
    }
    const key = `${guid}|${harmful ? 'H' : 'B'}|${playerOnly ? 'P' : '-'}`;
    const hit = listCache.get(key);
    if (hit !== undefined) {
      stats.listHits += 1;
      return hit;
    }
    const playerGuid = world.player?.guid ?? null;
    const built = auras.forUnit(guid).filter((entry) => {
      if (((entry.flags & AFLAG_NEGATIVE) !== 0) !== harmful) {
        return false;
      }
      if (playerOnly && entry.caster !== null && entry.caster !== playerGuid) {
        return false;
      }
      if (spellData.spell(entry.spellId) === null) {
        stats.unnamed += 1;
        return false;
      }
      return true;
    });
    listCache.set(key, built);
    stats.listBuilds += 1;
    return built;
  };

  const unitOf = (token: unknown): Unit | null =>
    (typeof token === 'string' ? resolveUnitToken(token, world) : null);

  const entryAt = (
    token: unknown,
    index: unknown,
    filter: unknown,
    forced?: boolean,
  ): AuraEntry | null => {
    const unit = unitOf(token);
    const i = Number(index);
    if (unit === null || !Number.isFinite(i) || i < 1) {
      return null;
    }
    const { harmful, playerOnly } = parseFilter(filter, forced);
    return auraList(unit.guid, harmful, playerOnly)[i - 1] ?? null;
  };

  /**
   * The caster as a UNIT TOKEN, which is what `UnitAura`'s 8th return is -- not a guid.
   *
   * Only the tokens this client actually resolves can be answered (`world/unit-tokens.ts` lists them),
   * so a caster who is neither us nor our target nor our focus comes back nil. That is the engine's own
   * answer for a caster outside the token set, and every call site treats nil as "unknown caster".
   */
  const casterToken = (entry: AuraEntry, unit: Unit): string | null => {
    if (entry.caster === null) {
      // `AFLAG_CASTER`: the caster IS the unit the aura is on.
      return unit === world.player ? 'player' : null;
    }
    if (entry.caster === world.player?.guid) {
      return 'player';
    }
    if (entry.caster === world.target?.guid) {
      return 'target';
    }
    return null;
  };

  /**
   * `UnitAura(unit, index, filter)` -- the eleven returns, in order.
   *
   * `rank` is `Spell.dbc`'s `NameSubtext` ("Rank 3"), which is what the real engine returns there and
   * what `GameTooltip:SetUnitAura` puts in the right column of line 1.
   *
   * `isStealable` (9th) and `shouldConsolidate` (10th) come back **nil**, and both are honest rather
   * than lazy. `isStealable` is the engine's Spellsteal test -- a Magic buff on a unit hostile to us --
   * and this client reads no hostility relation, so asserting either answer would light or dark a border
   * on nothing. `shouldConsolidate` is a `Spell.dbc` attribute bit that is not read; nil skips
   * `buffframe.lua:220`'s branch entirely, which with `CONSOLIDATE_BUFFS` unset it would skip anyway.
   */
  const auraReturns = (
    token: unknown,
    index: unknown,
    filter: unknown,
    forced?: boolean,
  ): unknown[] => {
    const unit = unitOf(token);
    const entry = entryAt(token, index, filter, forced);
    if (unit === null || entry === null) {
      return [];
    }
    const row = spellData.spell(entry.spellId);
    if (row === null) {
      // `auraList` already dropped these, so this is unreachable; kept because returning a nameless
      // aura from here would be the dense-list violation the header describes.
      return [];
    }
    return [
      row.name,
      row.subName,
      spellData.iconPath(entry.spellId),
      entry.applications,
      dispelName(row.dispelType),
      entry.duration,
      entry.expiresAt,
      casterToken(entry, unit),
      null,
      null,
      entry.spellId,
    ];
  };

  fn('UnitAura', (args) => auraReturns(args[0], args[1], args[2]));
  // `UnitBuff`/`UnitDebuff` are the same call with the filter FIXED -- and the third argument is still
  // read, because `UnitBuff(unit, i, "PLAYER")` is a real call shape. The helpful/harmful half of a
  // filter string passed here is ignored, which is what the engine does: the function name wins.
  fn('UnitBuff', (args) => auraReturns(args[0], args[1], args[2], false));
  fn('UnitDebuff', (args) => auraReturns(args[0], args[1], args[2], true));

  /**
   * `CancelUnitBuff(unit, index|name, filter|rank)` -- a right click on one of our own buffs
   * (`BuffButton_OnClick`, `buffframe.lua:271-273`).
   *
   * TWO ARGUMENT SHAPES, both real in the manifest: an INDEX with a filter (`buffframe.lua:272`) and a
   * NAME with a rank (`playerframe.lua`-side and `uiparent.lua:1076`). Which one it is is decided by the
   * type of the second argument, exactly as the engine does.
   *
   * It sends only for `player`. The server refuses a cancel on anything else, and a send that the server
   * discards is the failure mode this project has been bitten by eleven times -- silent. So a non-player
   * unit prints in `UIErrorsFrame` instead: this is an ACTION the player performed with a deliberate
   * gesture, and `CLAUDE.md`'s rule is that those must refuse out loud where getters stay silent.
   */
  fn('CancelUnitBuff', (args) => {
    const token = typeof args[0] === 'string' ? args[0] : '';
    const unit = unitOf(token);
    if (unit === null || unit !== world.player) {
      vm.run(
        'if UIErrorsFrame then UIErrorsFrame:AddMessage("You can only cancel your own buffs.",'
        + ' 1.0, 0.1, 0.1, 1.0) end',
        'aura-cancel-notice.lua',
      );
      return [];
    }
    let spellId = 0;
    if (typeof args[1] === 'number') {
      spellId = entryAt(token, args[1], args[2])?.spellId ?? 0;
    } else if (typeof args[1] === 'string') {
      const wanted = args[1].toLowerCase();
      const rank = typeof args[2] === 'string' ? args[2].toLowerCase() : null;
      const found = auraList(unit.guid, false, false).find((entry) => {
        const row = spellData.spell(entry.spellId);
        return row !== null
          && row.name.toLowerCase() === wanted
          && (rank === null || row.subName.toLowerCase() === rank);
      });
      spellId = found?.spellId ?? 0;
    }
    if (spellId === 0) {
      return [];
    }
    auras.cancelAura(spellId);
    return [];
  });

  setAuraTooltipSource(vm, (token, index, filter) => {
    const entry = entryAt(token, index, filter);
    const row = entry === null ? null : spellData.spell(entry.spellId);
    return row === null
      ? null
      : { name: row.name, rank: row.subName, description: row.description };
  });

  // -- The stance bar --------------------------------------------------------------------------------

  /**
   * THE PLAYER'S STANCE LIST, and it is built from the KNOWN-SPELL SET rather than from any table of
   * classes.
   *
   * A form is a known spell with an `SPELL_AURA_MOD_SHAPESHIFT` effect, and the form id is that effect's
   * `EffectMiscValue` -- see `spell-data.ts#COL.effectApplyAuraName` for how both column indices were
   * derived from neighbours this table already fixes. That is why a rogue gets Stealth and a warrior
   * gets three stances from one rule with no class branch anywhere.
   *
   * **CORROBORATED, not assumed**: `action-bridge.ts` already established from the wire that a warrior's
   * filled action words are the three bonus blocks 73-84, 85-96 and 97-108, and that
   * `SpellShapeshiftForm.dbc` column 1 maps forms 17/18/19 onto bonus bars 1/2/3. So the three forms
   * this rule finds for a warrior have to be exactly 17, 18 and 19, and any other answer is wrong by a
   * measurement that was already taken.
   *
   * **THE ORDER IS UNSOURCED and is stated as such.** Nothing in the client's own data says what order
   * the engine puts the stance buttons in: the bar is positional (`ShapeshiftButton1..10`) and
   * `GetShapeshiftFormInfo` is indexed by position, but no DBC carries a display order. Form id
   * ascending is used because it is the one ordering with a check available -- 17, 18, 19 is the order a
   * warrior's three stances appear in -- and because it is stable, which matters more than being right
   * for a single-form class like the owner's rogue. A druid's in-game order is NOT known to be form-id
   * ascending; if it turns out not to be, this is the line to change.
   *
   * Duplicate forms (two ranks of the same stance) keep the HIGHEST `spellLevel`, tie-broken by the
   * higher spell id, which is the later rank.
   */
  let formCache: ShapeshiftForm[] = [];
  let formCacheKey = '';

  const shapeshiftForms = (): ShapeshiftForm[] => {
    const known = spells.knownSpells();
    // The known-spell COUNT is the key, and the two things it cannot see are both invalidated
    // explicitly: the 49 MB `Spell.dbc` landing (`ensureLoaded().then` below) and a RANK-UP, which
    // removes one spell and adds another so the count does not move (`onSpells`). An earlier version
    // probed `spellData.spell(1)` to detect the DBC -- self-review removed it: whether spell id 1 exists
    // in this build's file was never checked, so it was a guess standing in for a signal that was
    // already wired.
    const key = String(known.size);
    if (key === formCacheKey) {
      return formCache;
    }
    const best = new Map<number, { spellId: number; level: number }>();
    for (const spellId of known) {
      const row = spellData.spell(spellId);
      if (row === null) {
        continue;
      }
      for (let i = 0; i < 3; i += 1) {
        if (row.effectApplyAuraName[i] !== AURA_MOD_SHAPESHIFT) {
          continue;
        }
        const form = row.effectMiscValue[i];
        if (form <= 0) {
          continue;
        }
        const held = best.get(form);
        if (held === undefined
          || row.spellLevel > held.level
          || (row.spellLevel === held.level && spellId > held.spellId)) {
          best.set(form, { spellId, level: row.spellLevel });
        }
      }
    }
    formCache = [...best.entries()]
      .map(([form, held]) => ({ form, spellId: held.spellId }))
      .sort((a, b) => a.form - b.form);
    formCacheKey = key;
    stats.forms = formCache.length;
    // The icons: registered before the event, exactly as `action-bridge.ts` does, so
    // `icon:SetTexture(path)` names a key that has a def and the sprite resolves when the fetch lands.
    const paths = formCache
      .map((entry) => spellData.iconPath(entry.spellId))
      .filter((path): path is string => path !== null);
    for (const path of paths) {
      art.register(path, { path });
    }
    if (paths.length > 0) {
      void art.load();
    }
    return formCache;
  };

  const formAt = (index: unknown): ShapeshiftForm | null => {
    const i = Number(index);
    return Number.isFinite(i) && i >= 1 ? shapeshiftForms()[i - 1] ?? null : null;
  };

  /**
   * `GetNumShapeshiftForms()` -- WAS a declared gap in `api/actions.ts` reading "the list of a class's
   * forms is not known", which is what kept `ShapeshiftBarFrame` hidden: `ShapeshiftBar_Update` hides
   * the whole bar on 0 (`bonusactionbarframe.lua:145-146`).
   */
  fn('GetNumShapeshiftForms', () => [shapeshiftForms().length]);

  /**
   * `GetShapeshiftFormInfo(index)` -> `texture, name, isActive, isCastable`.
   *
   * `isActive` is a BOOLEAN, and it must be: the player's current form is
   * `UNIT_FIELD_BYTES_2` byte 3, which `action-bridge.ts` already reads for the bonus bar, and form 0
   * is "no form" -- so returning the raw number would make `if ( isActive )` true for every button on a
   * character standing in no form at all, because 0 is truthy in Lua.
   *
   * `isCastable` is TRUE, and that is a real answer rather than a placeholder: a stance/shapeshift spell
   * has no power cost in this build's `Spell.dbc` (`manaCost` and `manaCostPercentage` both 0 for the
   * warrior stances and for Stealth), so there is nothing to be unable to afford. What is NOT checked
   * and would make it false in the real client: being in combat for a Stealth, and the shared stance
   * cooldown -- the cooldown is deliberate, because `GetShapeshiftFormCooldown` below draws a sweep for
   * it and the real client's `isCastable` ignores cooldowns for the same reason
   * (`action-bridge.ts#usability` records the identical decision for the action bar).
   */
  fn('GetShapeshiftFormInfo', (args) => {
    const entry = formAt(args[0]);
    if (entry === null) {
      return [];
    }
    const row = spellData.spell(entry.spellId);
    const active = (world.player?.fields.shapeshiftForm ?? 0) === entry.form;
    return [spellData.iconPath(entry.spellId), row?.name ?? '', active, true];
  });

  /**
   * `GetShapeshiftFormCooldown(index)` -> `start, duration, enable`.
   *
   * THREE NUMBERS, never nil: `CooldownFrame_SetTimer(cooldown, start, duration, enable)` is called
   * unconditionally on the result (`bonusactionbarframe.lua:171-172`) and does arithmetic on all three.
   * `0, 0, 1` is "no cooldown running", which is what `CooldownFrame_SetTimer` reads as "hide the sweep".
   *
   * Same source as the action bar's: `SpellHandler#cooldownOf`, which is fed by
   * `SMSG_SPELL_COOLDOWN` and by the DBC recovery times. So a stance switch draws the same sweep an
   * ability does, through the same `<Cooldown>` frame, at the same measured cost of zero dirty frames.
   */
  fn('GetShapeshiftFormCooldown', (args) => {
    const entry = formAt(args[0]);
    const running = entry === null ? null : spells.cooldownOf(entry.spellId);
    return running === null ? [0, 0, 1] : [running.start, running.duration, 1];
  });

  /** `CastShapeshiftForm(index)` -- `ShapeshiftBar_ChangeForm`'s one line (`:196`). Self-cast. */
  fn('CastShapeshiftForm', (args) => {
    const entry = formAt(args[0]);
    if (entry !== null) {
      spells.castSpell(entry.spellId, null);
    }
    return [];
  });

  setShapeshiftTooltipSource(vm, (index) => {
    const entry = formAt(index);
    const row = entry === null ? null : spellData.spell(entry.spellId);
    return row === null
      ? null
      : { name: row.name, rank: row.subName, description: row.description };
  });

  /**
   * `IsPossessBarVisible()` -- a GAP, and it is declared here rather than in `api/actions.ts` because
   * the stance bar is what reads it: `PossessBar_Update` HIDES `ShapeshiftBarFrame` when it answers true
   * (`bonusactionbarframe.lua:221-223`), so a nil global raises inside `PossessBar_Update` and takes
   * `PossessBar_OnLoad` with it. FALSE is the true answer -- this client has no possession bar and no
   * vehicle -- and false is also the branch that lets the stance bar show.
   */
  const possessGap = notImplemented(
    'IsPossessBarVisible',
    'no possession or vehicle bar exists in this client, so the stance bar is never displaced by one',
    [false],
  );
  fn('IsPossessBarVisible', () => possessGap(null as never, 0, []));

  // -- Events ----------------------------------------------------------------------------------------

  /**
   * `UNIT_AURA` with the unit TOKEN -- `BuffFrame_OnEvent` compares the first argument against
   * `PlayerFrame.unit` (`buffframe.lua:44`) and `TargetFrame` against its own, so a guid here would
   * match nothing and the frame would never update.
   *
   * Only the tokens that resolve are announced, and only when one of them IS this guid: a debuff landing
   * on a mob 40 yards away must not make `BuffFrame_Update` walk 48 slots. That is the whole event cost
   * of this bridge -- one event per aura change on a unit some frame is actually watching.
   */
  const onAuras = (guid: string): void => {
    stats.trackedUnits = auras.trackedUnits;
    stats.unclassified = auras.unclassified;
    for (const token of ['player', 'target', 'focus', 'mouseover']) {
      if (unitOf(token)?.guid === guid) {
        fireEvent(vm, 'UNIT_AURA', [token]);
        stats.events += 1;
      }
    }
  };

  /**
   * The form byte moving. `action-bridge.ts` already watches the same field for the bonus bar; this is
   * the stance bar's own half, and it is a separate listener rather than a shared one because the two
   * bridges have no ordering relationship and a shared push would give one of them the other's teardown.
   *
   * `UPDATE_SHAPESHIFT_FORM` is precisely the event `ShapeshiftBar_OnEvent` routes to
   * `ShapeshiftBar_UpdateState` (`:110-123`), which is "re-read which button is checked" and not "rebuild
   * the bar" -- so a stance switch costs the checked state and nothing else.
   */
  let lastForm = -1;
  const onFields = (unit: Unit): void => {
    if (unit !== world.player) {
      return;
    }
    const form = unit.fields.shapeshiftForm ?? 0;
    if (form === lastForm) {
      return;
    }
    lastForm = form;
    fireEvent(vm, 'UPDATE_SHAPESHIFT_FORM');
    stats.events += 1;
  };

  /** A learn or a rank-up can add a form -- `UPDATE_SHAPESHIFT_FORMS` rebuilds the bar's width. */
  const onSpells = (): void => {
    formCacheKey = '';
    fireEvent(vm, 'UPDATE_SHAPESHIFT_FORMS');
    stats.events += 1;
  };

  const onCooldowns = (): void => {
    fireEvent(vm, 'UPDATE_SHAPESHIFT_COOLDOWN');
    stats.events += 1;
  };

  auras.on('auras', onAuras);
  spells.on('spellsChanged', onSpells);
  spells.on('cooldownsChanged', onCooldowns);
  world.on('unit:fields', onFields);

  /**
   * The 49 MB `Spell.dbc` is kicked by `action-bridge.ts` already; this only needs to know when it
   * lands, because every name, icon and dispel type above comes out of it and the form list cannot be
   * built at all without it. Both events are fired: the bar's shape depends on the form list and the
   * buff icons depend on the names.
   */
  void spellData.ensureLoaded().then(() => {
    formCacheKey = '';
    listCache = new Map();
    cachedVersion = -1;
    fireEvent(vm, 'UPDATE_SHAPESHIFT_FORMS');
    fireEvent(vm, 'UNIT_AURA', ['player']);
    stats.events += 2;
  });

  // The auras arrive in the login burst, long before the 8-22 s manifest load finishes, so the first
  // announcement is made here rather than waited for -- the same reason `action-bridge.ts` calls
  // `pushAll()` on attach.
  onAuras(world.player?.guid ?? '');

  (window as unknown as Record<string, unknown>).auraBridgeStats = stats;

  return () => {
    auras.removeListener('auras', onAuras);
    spells.removeListener('spellsChanged', onSpells);
    spells.removeListener('cooldownsChanged', onCooldowns);
    world.removeListener('unit:fields', onFields);
    setAuraTooltipSource(vm, null);
    setShapeshiftTooltipSource(vm, null);
    delete (window as unknown as Record<string, unknown>).auraBridgeStats;
  };
}
