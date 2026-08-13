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
import { LuaVM } from './framexml/lua/vm';

/**
 * `UnitPowerType`'s numeric order -> the event a bar of that power listens for
 * (`UnitFrameManaBar_RegisterDefaultEvents`, unitframe.lua:307-314). 5 (RUNES) has no event of its
 * own in 3.3.5a's list; a death knight's rune bar is `RuneFrame`, not the mana bar, so it maps to
 * nothing and its changes ride the max/displaypower events.
 */
const POWER_EVENT = ['UNIT_MANA', 'UNIT_RAGE', 'UNIT_FOCUS', 'UNIT_ENERGY', 'UNIT_HAPPINESS', null, 'UNIT_RUNIC_POWER'];
const MAX_POWER_EVENT = ['UNIT_MAXMANA', 'UNIT_MAXRAGE', 'UNIT_MAXFOCUS', 'UNIT_MAXENERGY', 'UNIT_MAXHAPPINESS', null, 'UNIT_MAXRUNIC_POWER'];

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
  snapshot.isPlayer = unit.isPlayer;
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
  /** How many events this bridge has fired, for the frame-cost measurement. */
  const stats = { pushes: 0, events: 0 };
  const spells = world.game.objectHandler.spellHandler;

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

  world.on('unit:fields', onFields);
  world.on('target:change', onTargetChange);
  spells.on('comboPoints', pushCombo);

  // The player is already in the world when this attaches -- his create block arrived while the
  // manifest was still loading -- so the first push is made here rather than waited for. Without it
  // `PlayerFrame` stays blank until the next time anything about him changes, which standing still
  // in a quiet zone can be a long time.
  push('player', world.player);
  fireEvent(vm, 'PLAYER_ENTERING_WORLD');

  (window as unknown as Record<string, unknown>).unitBridgeStats = stats;

  return () => {
    world.removeListener('unit:fields', onFields);
    world.removeListener('target:change', onTargetChange);
    spells.removeListener('comboPoints', pushCombo);
    delete (window as unknown as Record<string, unknown>).unitBridgeStats;
  };
}
