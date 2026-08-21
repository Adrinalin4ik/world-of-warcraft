/**
 * THE SEAM between the world's units and the client's own unit frames.
 *
 * `lua/api/units.ts` holds a `Map<token, UnitSnapshot>` and says at the top that "this file contains
 * no world, no network and no guids" -- the host writes it and the Lua reads it. Nothing was the
 * host. This is that, and it is deliberately the ONLY place the two sides meet: the Lua side still
 * knows nothing about guids and the world side still knows nothing about tokens.
 *
 * ## It pushes, then fires. Never the other way round.
 *
 * benilla keeps the same order (`crates/benilla/src/ui_unit.rs:672-676` fires
 * `PLAYER_TARGET_CHANGED` AFTER `set_unit("target", ...)`), and it is not a style choice: every
 * FrameXML handler re-reads through `Unit*` the moment it runs, so firing first hands the old
 * snapshot to the handler for the new state.
 *
 * ## Why it diffs, and why that is the frame budget
 *
 * The in-world UI renders into an offscreen target that is only re-rendered when a fingerprint of
 * the draw list changes (`world-ui.ts`). Every event fired here re-runs a FrameXML handler, which
 * rewrites a status bar's value and its text, which changes the fingerprint, which costs a full
 * ~8 ms pass instead of a 0.5 ms composite.
 *
 * So the rule is: **fire an event only for a field that actually changed.** A health bar ticking at
 * 60 Hz for a health value that moved twice is exactly the failure this diff exists to prevent, and
 * it is the difference between `ui.draw` at 0.5 ms and at 9 ms. The world's own `unit:fields` event
 * is already gated the same way one level down (`unit-fields.ts#applyUnitFields` returns whether
 * anything changed), so this is the second of two gates, not the only one.
 *
 * ## Which tokens exist
 *
 * `"player"` and `"target"`. `"pet"`, `"focus"`, `"targettarget"` and the party/raid tokens are NOT
 * pushed: there is no pet, no focus and no party roster in this client, and a token with no entry is
 * precisely how `UnitExists` answers false -- which is what keeps `PetFrame`, `FocusFrame` and
 * `TargetofTarget` correctly hidden with no special casing.
 */
import Unit from '../classes/unit';
import World from '../world';
import { REACTION_NEUTRAL, reactionFor } from '../world/faction';
import {
  UnitSnapshot, emptySnapshot, getComboPoints, getUnit, setComboPoints, setUnit,
} from './framexml/lua/api/units';
import { fireEvent } from './framexml/lua/events';
import { combatFeedbackArgs, spellFeedbackArgs, spellMissText } from '../classes/combat-text';
import type { SpellDamageEvent } from '../../network/game/object/combat-log';
import { LuaVM } from './framexml/lua/vm';
import { raceClassData } from '../pipeline/dbc/race-class-data';

/**
 * `UnitPowerType`'s numeric order -> the event a bar of that power listens for
 * (`UnitFrameManaBar_RegisterDefaultEvents`, unitframe.lua:307-314). 5 (RUNES) has no event of its
 * own in 3.3.5a's list; a death knight's rune bar is `RuneFrame`, not the mana bar, so it maps to
 * nothing and its changes ride the max/displaypower events.
 */
/**
 * `ObjectType.Player`. Declared locally the way `cursor-mode.ts:42`, `nameplates.ts:98` and
 * `pick.ts:101` each declare it, rather than reaching into the network layer's enum from the UI.
 */
const OBJECT_TYPE_PLAYER = 4;

const POWER_EVENT = ['UNIT_MANA', 'UNIT_RAGE', 'UNIT_FOCUS', 'UNIT_ENERGY', 'UNIT_HAPPINESS', null, 'UNIT_RUNIC_POWER'];
const MAX_POWER_EVENT = ['UNIT_MAXMANA', 'UNIT_MAXRAGE', 'UNIT_MAXFOCUS', 'UNIT_MAXENERGY', 'UNIT_MAXHAPPINESS', null, 'UNIT_MAXRUNIC_POWER'];

/** The hover tooltip's failure, said once. A mouse-move must not spam the console. */
let hoverTooltipWarned = false;
function warnHoverTooltipOnce(message: string): void {
  if (hoverTooltipWarned) {
    return;
  }
  hoverTooltipWarned = true;
  console.warn(`the world hover tooltip raised: ${message}`);
}

/** A unit's live state as one snapshot. Pure -- it reads, it does not write. */
export function snapshotOf(unit: Unit, self: Unit | null): UnitSnapshot {
  const snapshot = emptySnapshot();
  snapshot.name = unit.name && unit.name !== '<unknown>' ? unit.name : null;
  snapshot.level = unit.fields.level ?? 0;
  snapshot.health = unit.fields.health ?? 0;
  snapshot.maxHealth = unit.fields.maxHealth ?? 0;
  snapshot.powerType = unit.fields.powerType ?? 0;
  snapshot.power = unit.fields.power ?? 0;
  snapshot.maxPower = unit.fields.maxPower ?? 0;
  snapshot.classification = unit.classification;
  // `UnitIsPlayer`/`UnitPlayerControlled` ask "is this a player CHARACTER", and `Unit#isPlayer` does
  // not answer that question. It defaults to false and is assigned in exactly one place in the tree,
  // `classes/player.ts:14` -- the constructor of our OWN character -- because eight motion sites read
  // it as the LOCAL-versus-REMOTE switch (`world/index.ts:1051` picks `move.horizVel` over
  // `remoteMotion.speed` on it; `unit.ts:3012,3023` gate the peer dead-reckon trace on `!isPlayer`).
  // So it was false for every player the server streams, and `UnitIsPlayer("target")` answered false
  // for a targeted player -- which also fed `UnitSelectionColor` (`api/units.ts:475`) the creature
  // ramp for a player.
  //
  // `objectType` is the create block's own `ObjectType` byte and the right question to ask.
  // `cursor-mode.ts:290` and `nameplates.ts:561` already test players this way; the flag is left to
  // mean what the motion code needs it to mean.
  snapshot.isPlayer = unit.objectType === OBJECT_TYPE_PLAYER;
  snapshot.dead = unit.dead;

  // The experience pair and the rested pool. PLAYER-scope update fields, so they are only ever present
  // on our own character and stay 0 for every creature -- which is what keeps `UnitXP("target")` at 0
  // with no special casing here.
  snapshot.xp = unit.fields.xp ?? 0;
  snapshot.maxXp = unit.fields.maxXp ?? 0;
  snapshot.restXp = unit.fields.restXp ?? 0;
  // Base mana, for `IsUsableAction`'s percentage-cost spells. See `UnitSnapshot#baseMana`.
  snapshot.baseMana = unit.fields.baseMana ?? 0;

  // The reaction, resolved lazily and cached on the unit by `reactionFor`: `FactionTemplate.dbc` is
  // an async load and the first units stream in before it lands. `REACTION_NEUTRAL` is the stand-in
  // until then -- stated rather than hidden, and the honest one of the three, because painting an
  // unknown unit hostile red or friendly green would both be assertions we cannot make yet.
  snapshot.reaction = reactionFor(unit, self) ?? REACTION_NEUTRAL;

  // RACE AND CLASS, joined here for the same reason `reaction` is: `api/units.ts` holds no pipeline,
  // and the ids are useless to Lua on their own -- `UnitRace`/`UnitClass` each owe a localized name
  // AND a token. `UNIT_FIELD_BYTES_0` packs `race | class | gender | powerType`, which is
  // `update-object/unit-fields.ts`' own stated layout and the same packing the power-type and gender
  // reads there already depend on.
  //
  // Null until the DBC lands, which is the honest answer and not a placeholder: `raceClassData`
  // answers null while its two (small) tables are in flight, and both globals then return NOTHING
  // rather than a wrong race. `ensureLoaded` is kicked off by `attachUnitBridge`.
  snapshot.race = unit.fields.race ? raceClassData.race(unit.fields.race) : null;
  snapshot.classInfo = unit.fields.classId ? raceClassData.class(unit.fields.classId) : null;
  // THE SEX, converted here and not in `api/units.ts`, because the two numberings differ: the wire's
  // byte 2 of `UNIT_FIELD_BYTES_0` is 0 male / 1 female
  // (`network/game/object/update-object/unit-fields.ts:281-285`) and `UnitSex` answers 1 unknown / 2
  // male / 3 female. `undefined` (no `bytes_0` yet) stays 1, which is the API's "unknown" and not a
  // guess at male. See `UnitSnapshot#sex`.
  snapshot.sex = unit.fields.gender === undefined ? 1 : unit.fields.gender + 2;
  return snapshot;
}

/**
 * SEED the tokens before a single line of the manifest runs. No events -- there are no frames yet.
 *
 * THIS IS AN ORDERING FIX, and the experience bar is what found it. The real client has the player's
 * data before FrameXML loads, so a document's `OnLoad` that reads unit state gets real numbers. Ours
 * loaded the manifest first and attached the feed afterwards, so every load-time reader saw zeroes --
 * and one of those readers HIDES ITSELF on a zero and cannot recover:
 *
 *   `CharacterFrame_OnLoad:58` calls `TextStatusBar_UpdateTextString(MainMenuExpBar)`, which hides a
 *   status bar whose max is 0 (`TextStatusBar.lua:80-84`), and `MainMenuExpBar`'s own
 *   `<OnValueChanged>` opens with `if (not self:IsShown()) then return; end`
 *   (`MainMenuBar.xml:160-165`) -- so once hidden at load, no value change can ever bring it back. In
 *   3.3.5a the ONLY thing that shows it again is `ReputationWatchBar_Update` on `UPDATE_FACTION`
 *   (`ReputationFrame.lua:399-401`), which needs a reputation feed this client does not have.
 *
 * So the bar was invisible with 280/400 xp behind it, and no engine global was missing: the DATA was
 * late. Seeding is the fix that matches the reference client's own ordering, and it is deliberately
 * only the SNAPSHOTS -- the events still come from `attachUnitBridge` after the tree exists.
 */
export function seedUnitSnapshots(vm: LuaVM, world: World): void {
  if (world.player) {
    setUnit(vm, 'player', snapshotOf(world.player, world.player));
  }
  if (world.target) {
    setUnit(vm, 'target', snapshotOf(world.target, world.player));
  }
}

/**
 * Push `snapshot` onto `token` and fire exactly the events whose fields moved.
 *
 * `previous` null means the token had no unit -- a fresh target -- and everything is announced.
 * Returns whether anything was announced, which the caller uses for its own measurement.
 */
function pushUnit(
  vm: LuaVM,
  token: string,
  snapshot: UnitSnapshot,
  previous: UnitSnapshot | null,
): boolean {
  setUnit(vm, token, snapshot);
  if (previous === null) {
    // A new occupant of the token. `PLAYER_TARGET_CHANGED` (fired by the caller) already makes
    // `TargetFrame_Update` re-read everything, and `PlayerFrame` gets the same from
    // `PLAYER_ENTERING_WORLD`, so nothing further is needed and firing the whole set would run every
    // handler twice.
    return true;
  }

  let fired = false;
  const fire = (event: string): void => {
    fireEvent(vm, event, [token]);
    fired = true;
  };

  if (snapshot.health !== previous.health) fire('UNIT_HEALTH');
  if (snapshot.maxHealth !== previous.maxHealth) fire('UNIT_MAXHEALTH');
  if (snapshot.powerType !== previous.powerType) {
    // `UNIT_DISPLAYPOWER` is what re-colours the bar and re-prefixes its text
    // (`UnitFrame_OnEvent` -> `UnitFrameManaBar_UpdateType`). A druid shifting form is the real case.
    fire('UNIT_DISPLAYPOWER');
  }
  if (snapshot.power !== previous.power) {
    const event = POWER_EVENT[snapshot.powerType];
    if (event) fire(event);
  }
  if (snapshot.maxPower !== previous.maxPower) {
    const event = MAX_POWER_EVENT[snapshot.powerType];
    if (event) fire(event);
  }
  if (snapshot.level !== previous.level) fire('UNIT_LEVEL');
  // `PLAYER_XP_UPDATE` is what `MainMenuExpBar`'s own `<OnEvent>` listens for (`MainMenuBar.xml:127`,
  // which calls `MainMenuExpBar_Update()`), and `ExhaustionTick` listens for it too. It takes a UNIT
  // argument in 3.3.5a even though only the player ever has xp.
  if (snapshot.xp !== previous.xp || snapshot.maxXp !== previous.maxXp) fire('PLAYER_XP_UPDATE');
  // A SEPARATE event for the rested pool, because a separate frame draws it: `ExhaustionTick` registers
  // `UPDATE_EXHAUSTION` and it is the only event that re-runs the bar's COLOUR choice
  // (`MainMenuBar.lua:347-358`). Firing only `PLAYER_XP_UPDATE` would move the fill and leave the bar
  // the wrong colour after resting.
  if (snapshot.restXp !== previous.restXp) fire('UPDATE_EXHAUSTION');
  if (snapshot.name !== previous.name) fire('UNIT_NAME_UPDATE');
  if (snapshot.reaction !== previous.reaction) fire('UNIT_FACTION');
  if (snapshot.classification !== previous.classification) fire('UNIT_CLASSIFICATION_CHANGED');
  return fired;
}

/**
 * Subscribe a VM to a world. Returns the teardown.
 *
 * Event-driven throughout -- there is no polling and no per-frame work at all. That is what lets the
 * offscreen target stay valid: with the world quiet, this bridge does nothing, so the draw list does
 * not change, so the UI costs one composite.
 */
export function attachUnitBridge(vm: LuaVM, world: World): () => void {
  // `ChrRaces.dbc` and `ChrClasses.dbc`, for `UnitRace`/`UnitClass`. A few dozen rows each, next to
  // the 6.7 MB and 49 MB loads the container and action bridges already start, and `DBC.load` caches.
  // No repaint is needed after it lands: a snapshot is rebuilt on every field change anyway, so the
  // names appear on the next push. The character sheet is opened by a keystroke long after load, so
  // in practice the read is warm by the time anything asks.
  /** How many events this bridge has fired, for the frame-cost measurement. */
  const stats = { pushes: 0, events: 0 };
  const spells = world.game.objectHandler.spellHandler;
  const combat = world.game.objectHandler.combatHandler;
  const combatLog = world.game.objectHandler.combatLogHandler;

  const push = (token: string, unit: Unit | null): boolean => {
    if (unit === null) {
      const had = getUnit(vm, token) !== null;
      setUnit(vm, token, null);
      return had;
    }
    const previous = getUnit(vm, token);
    const snapshot = snapshotOf(unit, world.player);
    const fired = pushUnit(vm, token, snapshot, previous);
    if (fired) {
      stats.pushes += 1;
    }
    return fired;
  };

  /**
   * THE WORLD HOVER TOOLTIP -- "При наведении на юнита должен появляться тултип."
   *
   * `"mouseover"` is pushed here, and the tooltip is driven through the CLIENT'S OWN globals.
   *
   * **There is no FrameXML driver for this and that is not an omission on our part.** Grepped the whole
   * served manifest: no `UPDATE_MOUSEOVER_UNIT` handler exists and nothing outside `unitframe.lua` calls
   * `GameTooltip:SetUnit`. In the real client the ENGINE fills and shows this tooltip when the cursor
   * rests on a unit, so being the engine is exactly our job here -- and it is done by calling
   * `GameTooltip_SetDefaultAnchor` and `GameTooltip:SetUnit`, both of which the client defines
   * (`gametooltip.lua:72`, `methods/gametooltip.ts`), rather than by drawing anything.
   *
   * `UPDATE_MOUSEOVER_UNIT` is fired too. Nothing in the manifest handles it, so it changes nothing
   * today -- it is fired because an ADDON is entitled to it and running addons is the point of this
   * runtime.
   *
   * ## Cost
   *
   * `World#setHovered` guards on the transition, so this runs on a real hover CHANGE and not on the
   * pick's 100 ms cadence. The tooltip lands at `GameTooltip_SetDefaultAnchor`'s fixed position -- the
   * bottom-right of `UIParent`, which is where the real client puts a world unit's tooltip -- so it does
   * NOT follow the pointer and therefore does not dirty the draw-list fingerprint per frame. Two dirty
   * frames per hover: one to show, one to hide.
   */
  const onHoverChange = (unit: Unit | null): void => {
    push('mouseover', unit);
    fireEvent(vm, 'UPDATE_MOUSEOVER_UNIT');
    // `GameTooltip` may not exist yet -- the bridges attach before the manifest finishes on some
    // paths -- so this is guarded rather than assumed, the same way the token pushes are.
    const error = vm.run(
      unit === null
        ? 'if GameTooltip then GameTooltip:Hide() end'
        : 'if GameTooltip and GameTooltip_SetDefaultAnchor then'
          + ' GameTooltip_SetDefaultAnchor(GameTooltip, UIParent);'
          + ' if GameTooltip:SetUnit("mouseover") then GameTooltip:Show() end'
          + ' end',
      'hover-tooltip',
    );
    if (error !== null) {
      // Reported once rather than every hover: a broken tooltip must not spam the console on mouse move.
      warnHoverTooltipOnce(error.message);
    }
  };

  const onFields = (unit: Unit): void => {
    if (unit === world.player) {
      push('player', unit);
    }
    if (unit === world.target) {
      push('target', unit);
    }
  };

  /**
   * COMBO POINTS, resolved as the PAIR they are.
   *
   * `SMSG_UPDATE_COMBO_POINTS` banks points against a specific unit (`spells.ts#handleComboPoints`),
   * and `GetComboPoints("player", "target")` -- `ComboFrame.lua:20`'s only shape -- must read ZERO when
   * the player is looking at anything else. Both guids are knowable only here, which is why
   * `api/units.ts` takes a plain number and says so.
   *
   * Fired as `UNIT_COMBO_POINTS` with `"player"` as its argument, and BOTH halves are read off the
   * client's own file rather than remembered: `comboframe.xml:115-121`'s inline `<OnLoad>` registers
   * `PLAYER_TARGET_CHANGED` and `UNIT_COMBO_POINTS`, and `ComboFrame_OnEvent` (`comboframe.lua:8-17`)
   * takes the first vararg and acts only `if ( unit == PlayerFrame.unit )` -- so an event with no
   * argument, or with a guid, would be silently ignored. (A first draft of this comment cited a
   * `ComboFrame_OnLoad` function; there is no such function, the registration is inline.)
   * `ComboFrame_Update`'s own read is `GetComboPoints(PlayerFrame.unit, "target")`
   * (`comboframe.lua:20`), which is what "the only shape asked" above means.
   *
   * AFTER the push, per this file's header. Diffed, because an event here re-runs
   * `ComboFrame_Update`, which shows or hides five points and cross-fades their highlights -- so it
   * dirties the draw fingerprint, the rule `action-bridge.ts` states.
   */
  const pushCombo = (): void => {
    const combo = spells.comboState;
    const points =
      combo.target !== null && world.target !== null && world.target.guid === combo.target
        ? combo.points
        : 0;
    if (points === getComboPoints(vm)) {
      return;
    }
    setComboPoints(vm, points);
    fireEvent(vm, 'UNIT_COMBO_POINTS', ['player']);
    stats.events += 1;
  };

  const onTargetChange = (unit: Unit | null): void => {
    push('target', unit);
    // AFTER the push. See the header.
    fireEvent(vm, 'PLAYER_TARGET_CHANGED');
    stats.events += 1;
    // The pair changed even though the packet did not: points banked on the unit we just stopped
    // looking at have to go to zero, and points on the one we just picked up have to come back.
    pushCombo();
  };

  /**
   * THE UNIT-FRAME HALF OF THE DAMAGE DISPLAY, and it is entirely the CLIENT'S OWN LUA.
   *
   * The owner asked for both media ("По цифрам оба варианта"). The big floating number is engine-drawn
   * (`world/floating-text.ts`); this is the other one, and nothing here draws anything -- it supplies the
   * one engine event the client's own `CombatFeedback` is waiting for and then gets out of the way.
   *
   * `UNIT_COMBAT` is handled in exactly ONE place in this build's FrameXML, which was measured rather
   * than remembered: `playerframe.lua:14` registers it and `:129-132` forwards
   * `CombatFeedback_OnCombatEvent(self, arg2, arg3, arg4, arg5)` when `arg1 == self.unit`.
   * `targetframe.lua` has no `CombatFeedback` call at all and neither does `unitframe.lua` -- so in
   * 3.3.5a the unit-frame feedback text is the PLAYER's portrait indicator (`PlayerHitIndicator`,
   * `playerframe.xml:175`, `NumberFontNormalHuge` at font height 30, `playerframe.lua:11`) and nothing
   * else. It therefore shows damage the player TAKES, which is the complement of the floating text's
   * "only our own damage floats" and is why both media are needed to see a fight.
   *
   * The five arguments and the outcome mapping are `classes/combat-text.ts#combatFeedbackArgs`, shared
   * with the floating text so the two can never name the same swing differently.
   *
   * The animation is the client's own too -- `COMBATFEEDBACK_FADEINTIME` 0.2 / `_HOLDTIME` 0.7 /
   * `_FADEOUTTIME` 0.3 (`combatfeedback.lua:1-3`), integrated by `CombatFeedback_OnUpdate` off `GetTime`.
   * That needs `PlayerFrame`'s `<OnUpdate>` to be ticked, which `world-runtime.ts` now does and says why.
   */
  const onSwing = (
    _attacker: string, victim: string, damage: number, hitInfo: number,
    victimState: number | null, school: number,
  ): void => {
    if (world.player === null || victim !== world.player.guid) {
      return;
    }
    const args = combatFeedbackArgs(hitInfo, victimState, damage, school);
    if (args === null) {
      // `victimState` null means the decode did not add up and `handleAttackerState` has already said so.
      // Nothing is announced, rather than announcing a WOUND of 0 that would print "Miss" over a hit.
      return;
    }
    fireEvent(vm, 'UNIT_COMBAT', ['player', args.event, args.flags, args.amount, args.school]);
    stats.events += 1;
  };

  /**
   * THE SPELL HALF OF THE PORTRAIT INDICATOR -- "не видно урона по себе" for anything but a swing.
   *
   * Same event, same frame, same client Lua. The melee arm above filters to `victim === player`; these
   * do the same, and the filter is ours only in the sense that the CLIENT'S OWN `playerframe.lua:129`
   * applies it in Lua (`arg1 == self.unit`) -- we raise the event only for the unit that frame acts on
   * rather than raising it for every unit and letting the comparison discard them, which is the same
   * decision the melee arm already took and is stated in `combat-text.ts#spellFeedbackArgs`.
   *
   * **THIS IS WHY A SPELL HITTING THE PLAYER SHOWED NOTHING AT ALL**: no packet, so no event, so no
   * indicator. It was never a display filter.
   */
  const onSpellDamage = (ev: SpellDamageEvent): void => {
    if (world.player === null || ev.target !== world.player.guid) {
      return;
    }
    const args = spellFeedbackArgs(ev.amount, ev.absorb, ev.resist, ev.crit, ev.school);
    if (args === null) {
      return;
    }
    fireEvent(vm, 'UNIT_COMBAT', ['player', args.event, args.flags, args.amount, args.school]);
    stats.events += 1;
  };

  /**
   * A HEAL LANDING ON THE PLAYER -- the client's own `HEAL` action, which `CombatFeedback_OnCombatEvent`
   * draws GREEN through `PlayerHealIndicator` rather than on the hit indicator
   * (`combatfeedback.lua:69-77`, `playerframe.xml`'s second indicator string). Nothing is drawn by us;
   * the action name is the reference's (`net/apply/combat_log.rs:434-440`) and the client's table
   * resolves it.
   */
  const onSpellHeal = (ev: { target: string; amount: number; crit: boolean }): void => {
    if (world.player === null || ev.target !== world.player.guid) {
      return;
    }
    fireEvent(vm, 'UNIT_COMBAT', ['player', 'HEAL', ev.crit ? 'CRITICAL' : '', ev.amount, 0]);
    stats.events += 1;
  };

  /**
   * A SPELL MISSING THE PLAYER -- his own dodge, parry, resist or immunity to an incoming cast. The word
   * comes out of `spellMissText`, i.e. the same `WORD_KEY` table the floating word and the melee dodge
   * use, so all three name an outcome identically by construction.
   */
  const onSpellMiss = (ev: { target: string; code: number }): void => {
    if (world.player === null || ev.target !== world.player.guid) {
      return;
    }
    const text = spellMissText(ev.code);
    if (text === null || text.wordKey === null) {
      return;
    }
    fireEvent(vm, 'UNIT_COMBAT', ['player', text.wordKey, '', 0, 0]);
    stats.events += 1;
  };

  // `ChrRaces.dbc` and `ChrClasses.dbc`, for `UnitRace`/`UnitClass`. A few dozen rows each, and
  // `DBC.load` caches.
  //
  // THE RE-PUSH IS LOAD-BEARING AND ITS ABSENCE WAS A DEFECT OF MINE, caught live: a snapshot is only
  // rebuilt when a FIELD CHANGES, so "the names will appear on the next push" is false whenever the
  // DBC lands after the last one -- which is the normal case, since a standing character stops
  // emitting field updates within a few seconds of entry. Measured that way: `race` 11 and `classId`
  // 7 were on the unit and `UnitRace`/`UnitClass` still answered nil. Same shape as
  // `container-bridge.ts`' `void itemData.ensureLoaded().then(pushAll)`, and the same fix.
  void raceClassData.ensureLoaded().then(() => {
    push('player', world.player);
    push('target', world.target);
  });

  world.on('unit:fields', onFields);
  world.on('hover:change', onHoverChange);
  world.on('target:change', onTargetChange);
  spells.on('comboPoints', pushCombo);
  combat.on('attack:swing', onSwing);
  combatLog.on('spell:damage', onSpellDamage);
  combatLog.on('spell:heal', onSpellHeal);
  combatLog.on('spell:miss', onSpellMiss);

  // The player is already in the world when this attaches -- his create block arrived while the
  // manifest was still loading -- so the first push is made here rather than waited for. Without it
  // `PlayerFrame` stays blank until the next time anything about him changes, which standing still
  // in a quiet zone can be a long time.
  push('player', world.player);
  fireEvent(vm, 'PLAYER_ENTERING_WORLD');

  (window as unknown as Record<string, unknown>).unitBridgeStats = stats;

  return () => {
    world.removeListener('unit:fields', onFields);
    world.removeListener('hover:change', onHoverChange);
    world.removeListener('target:change', onTargetChange);
    spells.removeListener('comboPoints', pushCombo);
    combat.removeListener('attack:swing', onSwing);
    combatLog.removeListener('spell:damage', onSpellDamage);
    combatLog.removeListener('spell:heal', onSpellHeal);
    combatLog.removeListener('spell:miss', onSpellMiss);
    delete (window as unknown as Record<string, unknown>).unitBridgeStats;
  };
}
