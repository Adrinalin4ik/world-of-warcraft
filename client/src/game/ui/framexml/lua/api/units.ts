/**
 * The `Unit*` engine globals -- the Lua-side contract every unit frame in FrameXML is written
 * against, including `TargetFrame`.
 *
 * THE SEAM IS ONE-WAY AND IT IS A SNAPSHOT, which is benilla's architecture and not an incidental
 * choice (`crates/benilla-ui/src/script/unit/mod.rs:14-15`):
 *
 *   > Tokens (`"player"`, `"target"`, ...) are opaque strings the host never interprets -- the app
 *   > decides what each maps to.
 *
 * So this file contains no world, no network and no guids. It holds a `Map<token, UnitSnapshot>` that
 * the host writes with `setUnit(vm, token, snapshot)` and the bindings read
 * (benilla's `with_unit`, `unit/mod.rs:317-330`; its push side is `UiScript::set_unit`,
 * `unit/mod.rs:245-260`). Three things follow from that and all three are deliberate:
 *
 *  - a token with no entry is a unit that DOES NOT EXIST: `UnitExists` false, numbers 0, name nil.
 *    That is what makes `TargetFrame_Update`'s `if not UnitExists("target") then self:Hide()` work
 *    with no special casing, and it is why removing a token is `setUnit(vm, token, null)` rather than
 *    a separate call;
 *  - the bindings can be exercised with no session at all, which is how they are tested;
 *  - nothing here can be stale in a way Lua can observe half-way: the host swaps a whole snapshot.
 *
 * WHICH GLOBALS ARE HERE was decided by reading what the client's own files call, not from a list:
 * `TargetFrame.lua`, `UnitFrame.lua` and `TextStatusBar.lua` between them call 37 distinct `Unit*`
 * functions. The ones with a real field behind them are real below; the ones whose feed does not
 * exist yet (threat, auras, casting, tap state) go through `notImplemented` so the load report names
 * them, per the rule that a gap is declared and never silently answered.
 */
import { LuaVM } from '../vm';
import { notImplemented } from '../methods/region';
// A PURE TABLE, not a world handle -- `selectionColor` takes three plain values and returns three
// numbers. The "no world, no network, no guids" rule above is intact: nothing here can reach a `World`
// through it. It lives beside the ground ring because the ring is the selector's other surface.
import { selectionColor } from '../../../../world/selection-color';

/**
 * What the host knows about one unit, at one instant.
 *
 * Field-for-field the shape benilla's `UnitState` carries (`crates/benilla/src/ui_unit.rs:330-372`),
 * minus what this client has no source for. Every number is what the wire gave us; no derivation
 * happens in the host, because a derivation done twice is a derivation done differently.
 */
export interface UnitSnapshot {
  /** `UNIT_FIELD_*` are not readable as text; a name arrives from a query response or a roster row. */
  name: string | null;
  /** `unit_field_level` (`network/game/object/enums.ts#UnitField`, `object_end + 0x0030`). */
  level: number;
  /** `unit_field_health` / `unit_field_maxhealth` (`+0x0012` / `+0x001a`). */
  health: number;
  maxHealth: number;
  /**
   * The POWER TYPE -- `unit_field_bytes_0`'s high byte (`BYTES_0 >> 24`), benilla
   * `fields/unit.rs:123`. 0 mana, 1 rage, 2 focus, 3 energy, 4 happiness, 5 runes, 6 runic power.
   *
   * It is not optional decoration: rage and energy are 0..100 while mana is thousands, and each has
   * its own colour in `PowerBarColor`. A unit frame that assumes mana draws a rogue's energy bar as a
   * sliver of blue.
   */
  powerType: number;
  /** `unit_field_power1..7` / `unit_field_maxpower1..7`, indexed by `powerType` (`+0x0013` / `+0x001b`). */
  power: number;
  maxPower: number;
  /**
   * 1..8 on the client's reaction scale (1 hated .. 4 neutral .. 8 exalted); 4 is the neutral point
   * `UnitReaction`'s callers compare against. Derived by the host from `unit_field_factiontemplate`
   * (`+0x0031`) through `FactionTemplate.dbc`.
   */
  reaction: number;
  /** `"normal" | "elite" | "rare" | "rareelite" | "worldboss"` -- see `classificationWord`. */
  classification: string;
  isPlayer: boolean;
  dead: boolean;

  /**
   * `PLAYER_XP` and `PLAYER_NEXT_LEVEL_XP` -- what `UnitXP`/`UnitXPMax` answer.
   *
   * Only ever non-zero for `"player"`: they are PLAYER-scope update fields, so a creature's update
   * never carries them (`update-object/unit-fields.ts`). Zero for every other token, which is what
   * `MainMenuExpBar_Update` wants -- `SetMinMaxValues(min(0, currXP), nextXP)`.
   */
  xp: number;
  maxXp: number;

  /**
   * `PLAYER_REST_STATE_EXPERIENCE` -- the banked rested-xp pool `GetXPExhaustion()` returns, in xp.
   *
   * A SEPARATE field from `xp`, and a separate segment on the bar: `ExhaustionTick_OnEvent` places
   * `ExhaustionLevelFillBar` at `((xp + restXp) / maxXp) * width` (`MainMenuBar.lua:325`), so it is
   * drawn as the lighter region to the RIGHT of current xp, not as part of it.
   */
  restXp: number;

  /**
   * `UNIT_FIELD_BASE_MANA` -- mana before gear, which is what a percentage spell cost is a percentage OF.
   *
   * Here rather than derived from `maxPower` because `Spell.dbc`'s `ManaCostPercentage` (column 204) is
   * how most caster spells state their cost -- Fireball 8%, Healing Wave 13%, both with `manaCost` 0 --
   * and `maxPower` is a different, larger number for any geared character. `IsUsableAction` reads it;
   * nothing else does.
   */
  baseMana: number;

  /**
   * What `UnitRace` and `UnitClass` answer, ALREADY RESOLVED TO STRINGS by the host.
   *
   * Names and not ids, because this file holds no world, no network and no pipeline -- see the
   * header. The ids live in `UNIT_FIELD_BYTES_0` bytes 0 and 1 and the join to `ChrRaces.dbc` /
   * `ChrClasses.dbc` is `unit-bridge.ts`' business, exactly as the `reaction` join already is.
   *
   * Each is a PAIR because both globals return two values and the second is not the first: the
   * second is a token FrameXML keys real tables on (`RAID_CLASS_COLORS`, `CLASS_ICON_TCOORDS` are
   * both indexed by the uppercase class token), so answering the localized name twice would look
   * right in a header and break every lookup built on it.
   *
   * Null until `bytes_0` has arrived AND the DBC has landed -- `UnitRace` answers nothing rather
   * than a wrong race.
   */
  race: { name: string; token: string } | null;
  classInfo: { name: string; token: string } | null;
}

/** A unit that exists but about which nothing has arrived yet. */
export function emptySnapshot(): UnitSnapshot {
  return {
    name: null,
    level: 0,
    health: 0,
    maxHealth: 0,
    powerType: 0,
    power: 0,
    maxPower: 0,
    reaction: 4,
    classification: 'normal',
    isPlayer: false,
    dead: false,
    xp: 0,
    maxXp: 0,
    restXp: 0,
    baseMana: 0,
    race: null,
    classInfo: null,
  };
}

/**
 * `SMSG_CREATURE_QUERY_RESPONSE`'s `rank` to the string `UnitClassification` answers.
 *
 * Ported verbatim from benilla `crates/benilla-ui/src/script/unit/mod.rs:218-226`. NOTE that 2 is
 * rare-elite and 4 is rare -- they are not in the order the words suggest, and getting them the
 * obvious way round puts a silver dragon border on a rare and a plain one on a rare elite. Never
 * returns nil: `TargetFrame_CheckClassification` indexes a table with the result.
 */
export function classificationWord(rank: number): string {
  switch (rank) {
    case 1:
      return 'elite';
    case 2:
      return 'rareelite';
    case 3:
      return 'worldboss';
    case 4:
      return 'rare';
    default:
      return 'normal';
  }
}

/** Per-VM, because two runtimes (glue and world) can be alive at once during a screen change. */
const unitsByVm = new WeakMap<LuaVM, Map<string, UnitSnapshot>>();

function unitsOf(vm: LuaVM): Map<string, UnitSnapshot> {
  let units = unitsByVm.get(vm);
  if (units === undefined) {
    units = new Map();
    unitsByVm.set(vm, units);
  }
  return units;
}

/**
 * THE push door: give `token` this snapshot, or `null` to say the unit does not exist.
 *
 * The host calls this and then fires the event that tells the UI to re-read -- in that order, which
 * benilla also keeps (`crates/benilla/src/ui_unit.rs:672-676` fires `PLAYER_TARGET_CHANGED` AFTER
 * `set_unit("target", ...)`), so the handler already sees the fresh snapshot when it runs.
 */
export function setUnit(vm: LuaVM, token: string, snapshot: UnitSnapshot | null): void {
  const units = unitsOf(vm);
  if (snapshot === null) {
    units.delete(token);
  } else {
    units.set(token, snapshot);
  }
}

/** What the host last pushed for `token`, or null. Exposed for tests and for the host's own diffing. */
export function getUnit(vm: LuaVM, token: string): UnitSnapshot | null {
  return unitsOf(vm).get(token) ?? null;
}

/**
 * COMBO POINTS -- a per-VM scalar, not a unit field, because that is what it is on the wire.
 *
 * They arrive on their OWN opcode, `SMSG_UPDATE_COMBO_POINTS` (**0x39D**, already in `opcode.js` and
 * until now with no subscriber), whose body is `pguid comboTarget` + `u8 comboPoints` -- see
 * `network/game/object/spells.ts#handleComboPoints` for the decode and for what is and is not sourced
 * about that layout. There is no `UNIT_FIELD_COMBO_POINTS`, so this cannot ride `UnitSnapshot`.
 *
 * `GetComboPoints(unit, target)` (`ComboFrame.lua:20`, reached from `PlayerFrame_ToPlayerArt`) is
 * answered from here, and it is A QUESTION ABOUT A PAIR: points are banked against ONE unit and the
 * real client answers zero when you are looking at a different one. That comparison is the HOST's,
 * not this file's -- this module's header promises no world, no network and NO GUIDS, and the combo
 * target is a guid. So the host pushes the number the current pair is worth (`unit-bridge.ts`), which
 * is the same division of labour `UnitSnapshot.reaction` already uses.
 */
const comboByVm = new WeakMap<LuaVM, number>();

/** The push door: the combo points the CURRENT player/target pair is worth. */
export function setComboPoints(vm: LuaVM, points: number): void {
  comboByVm.set(vm, points);
}

/** What the host last pushed. Exposed for the host's own diffing, like `getUnit`. */
export function getComboPoints(vm: LuaVM): number {
  return comboByVm.get(vm) ?? 0;
}

/** Installs every `Unit*` global on `vm`. Safe with no host feed at all: every token simply does not exist. */
export function installUnitsApi(vm: LuaVM): void {
  const units = unitsOf(vm);

  /**
   * benilla's `with_unit` (`unit/mod.rs:317-330`): resolve the token, or answer `fallback`.
   *
   * A non-string first argument (nil, a number, a frame) is a MISS rather than an error -- FrameXML
   * calls these with `self.unit`, which is nil on a frame whose unit has not been set, and the real
   * engine answers nil there rather than raising.
   */
  const withUnit = <T>(token: unknown, fallback: T, read: (unit: UnitSnapshot) => T): T => {
    if (typeof token !== 'string') {
      return fallback;
    }
    const unit = units.get(token);
    return unit === undefined ? fallback : read(unit);
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  fn('UnitExists', (args) => [withUnit(args[0], false, () => true)]);
  // nil, not "", for a unit with no name yet: `GetUnitName` and every caller in the manifest tests the
  // result for truthiness, and an empty string is truthy in Lua.
  fn('UnitName', (args) => [withUnit(args[0], null, (u) => u.name)]);
  fn('UnitLevel', (args) => [withUnit(args[0], 0, (u) => u.level)]);
  fn('UnitHealth', (args) => [withUnit(args[0], 0, (u) => u.health)]);
  fn('UnitHealthMax', (args) => [withUnit(args[0], 0, (u) => u.maxHealth)]);

  /**
   * `UnitPowerType(unit)` returns `powerType, powerToken, altR, altG, altB` -- FIVE values, and the
   * SECOND is load-bearing.
   *
   * This returned the number alone, which is a defect the snapshot survey could not see because
   * nothing called it. `UnitFrameManaBar_UpdateType` (unitframe.lua:161-164) does:
   *
   *     local powerType, powerToken, altR, altG, altB = UnitPowerType(manaBar.unit);
   *     local prefix = _G[powerToken];
   *     local info = PowerBarColor[powerToken];
   *
   * `_G[nil]` raises "table index is nil" and takes the whole mana-bar update with it, so a
   * one-value answer means no power bar at all -- not merely a wrongly coloured one. With the token
   * present, `PowerBarColor["RAGE"]` is the red the bar is drawn in and `prefix` is the localized
   * word its text is prefixed with.
   *
   * The tokens are `Constants.lua`'s own `PowerBarColor` keys, in `UnitPowerType`'s numeric order:
   * 0 MANA, 1 RAGE, 2 FOCUS, 3 ENERGY, 4 HAPPINESS, 5 RUNES, 6 RUNIC_POWER. `altR/G/B` are the
   * alternate-power colour override, which only vehicle power buses carry; nil here, which is the
   * branch `UnitFrameManaBar_UpdateType` already handles (`if ( not altR )`).
   */
  const POWER_TOKENS = ['MANA', 'RAGE', 'FOCUS', 'ENERGY', 'HAPPINESS', 'RUNES', 'RUNIC_POWER'];
  fn('UnitPowerType', (args) => {
    const type = withUnit(args[0], 0, (u) => u.powerType);
    return [type, POWER_TOKENS[type] ?? 'MANA'];
  });
  // `UnitPower(unit [, type])`: an explicit type argument selects a bar this snapshot does not carry
  // (a druid's mana while in cat form), so it is honoured only when it MATCHES the active type and
  // otherwise answers 0 -- which is what the engine answers for a power the unit does not have. It is
  // not a silent lie: a mismatched type genuinely has no value in a one-power snapshot.
  const powerFor = (args: unknown[], pick: (u: UnitSnapshot) => number): number =>
    withUnit(args[0], 0, (u) =>
      typeof args[1] === 'number' && args[1] !== u.powerType ? 0 : pick(u),
    );
  fn('UnitPower', (args) => [powerFor(args, (u) => u.power)]);
  fn('UnitPowerMax', (args) => [powerFor(args, (u) => u.maxPower)]);
  // 3.3.5a's `UnitMana`/`UnitManaMax` are the pre-2.4 spelling and are still called by some of the
  // manifest's older files. They are the SAME two numbers -- the client aliases them -- so they are
  // aliases here rather than a second code path that could disagree.
  fn('UnitMana', (args) => [withUnit(args[0], 0, (u) => u.power)]);
  fn('UnitManaMax', (args) => [withUnit(args[0], 0, (u) => u.maxPower)]);

  /**
   * THE EXPERIENCE BAR. `MainMenuExpBar_Update` (`MainMenuBar.lua:6-10`) is nothing but
   * `SetMinMaxValues(min(0, UnitXP("player")), UnitXPMax("player"))` then `SetValue(UnitXP("player"))`,
   * so these two globals are the whole of the bar's progress and neither existed.
   */
  fn('UnitXP', (args) => [withUnit(args[0], 0, (u) => u.xp)]);
  fn('UnitXPMax', (args) => [withUnit(args[0], 0, (u) => u.maxXp)]);

  /**
   * `GetXPExhaustion()` -> the banked rested-xp pool, or **nil** when there is none.
   *
   * nil and not 0, and this is load-bearing: `ExhaustionTick_OnEvent` branches on
   * `if (not exhaustionThreshold) then ExhaustionTick:Hide(); ExhaustionLevelFillBar:Hide()`
   * (`MainMenuBar.lua:322-324`), and 0 is TRUTHY in Lua. Returning 0 would take the other branch and
   * place the rested segment at exactly current-xp -- a zero-width fill bar and a visible tick marker
   * sitting on the bar's fill edge, for a character with no rested xp at all.
   */
  fn('GetXPExhaustion', () => {
    const player = units.get('player');
    const rest = player?.restXp ?? 0;
    return [rest > 0 ? rest : null];
  });

  /**
   * `GetRestState()` -> `exhaustionStateID, exhaustionStateName, exhaustionStateMultiplier`.
   *
   * **1 is RESTED and 2 is NORMAL**, and that pair is what colours the bar -- `ExhaustionTick_OnEvent`
   * paints `SetStatusBarColor(0.0, 0.39, 0.88)` (blue) for state 1 and `(0.58, 0.0, 0.55)` (magenta) for
   * state 2 (`MainMenuBar.lua:350-357`).
   *
   * That is worth stating plainly because it corrects a diagnosis: **a magenta XP bar is the CORRECT
   * 3.3.5a appearance for a character with no rested experience**, not a sign of an unresolved texture.
   * `MainMenuExpBar` declares no `<BarTexture>` at all in `MainMenuBar.xml` -- its fill is a flat tint
   * and this function is what chooses the colour. The 3.3.5a XP bar is purple when you are not rested.
   *
   * The name and multiplier are the values the real client supplies; the multiplier is 1 in both states
   * on this build (rested xp is spent as a separate pool, not as a kill-xp multiplier), and the name is
   * the untranslated token because there is no `GlobalStrings` lookup for it in the engine.
   */
  fn('GetRestState', () => {
    const player = units.get('player');
    const rested = (player?.restXp ?? 0) > 0;
    return rested ? [1, 'rested', 1] : [2, 'normal', 1];
  });

  /**
   * `IsXPUserDisabled()` -- the "stop gaining xp" toggle, which does not exist on this build's server
   * and is not a 3.3.5a player-visible feature. Genuinely false rather than a stub; it only gates
   * whether the exhaustion tick is hidden (`MainMenuBar.lua:342`).
   */
  fn('IsXPUserDisabled', () => [false]);

  fn('UnitReaction', (args) => [withUnit(args[0], null, (u) => u.reaction)]);

  /**
   * `UnitSelectionColor(unit)` -> `r, g, b, a` -- the reaction palette, and it was the target frame's
   * BRIGHT SILVER NAME BAR.
   *
   * `TargetFrame_CheckFaction`'s else-branch is `self.nameBackground:SetVertexColor(UnitSelectionColor
   * (self.unit))` (`targetframe.lua:268`) over `UI-TargetingFrame-LevelBackground`
   * (`targetframe.xml:215`). This was a declared gap answering `1, 1, 1, 1`, so the strip drew at full
   * white -- the owner's "the target's health bar looks wrong". Measured live as `Sgh` on a Vale Moth:
   * `scratchpad/t17c-real-name.png`.
   *
   * THE PALETTE IS THE REFERENCE'S, read off the client's own selector `0x605960`
   * (`benilla/src/target/ring.rs:115-118, 186-223`), on the raw reaction RANK -- which is
   * `UnitReaction`'s 1..8 scale minus one, so rank <= 1 is reaction <= 2:
   *   reaction <= 2 hostile RED, 3 unfriendly ORANGE, 4 neutral YELLOW, >= 5 friendly GREEN.
   *
   * A PLAYER-CONTROLLED unit branches first in that selector and reads soft blue
   * (`RING_PLAYER`, ring.rs:119) unless its rank is already hostile. The selector's further legs --
   * PvP-flagged green, pale for a party member -- need `UnitIsPVP` and a party roster, both declared
   * gaps here, so those two refinements are NOT applied and a PvP-flagged enemy player reads blue
   * rather than green. Stated rather than guessed.
   *
   * ALSO NOT APPLIED: the selector's DEAD grey (`RING_DEAD`). That is the ground RING's rule and
   * extending it to the name background is an extrapolation this has no evidence for; the tapped-grey
   * case the name background really does have is the client's OWN first branch
   * (`targetframe.lua:262-264`), which it takes without asking us.
   *
   * A unit whose reaction is still unresolved -- `FactionTemplate.dbc` in flight -- already reads
   * NEUTRAL before it gets here: `unit-bridge.ts:79` is `reactionFor(unit, self) ?? REACTION_NEUTRAL`,
   * so `UnitSnapshot.reaction` is never null and there is nothing to defend against a second time.
   * That collapse is the reference's own fallback (`ring.rs:598`,
   * `resolved.unwrap_or(Reaction::Neutral)`).
   */
  fn('UnitSelectionColor', (args) => {
    const white: unknown[] = [1, 1, 1, 1];
    if (typeof args[0] !== 'string') {
      return white;
    }
    const unit = units.get(args[0]);
    if (unit === undefined) {
      return white;
    }
    // ONE LAW, ONE FUNCTION -- `world/selection-color.ts` is the selector, shared with the ground
    // selection ring. The palette used to be spelled out here; the reference records what happens when
    // the two surfaces the selector feeds keep separate copies (`ring.rs:137-145`: the ring gained the
    // PvP legs, the name's copy did not, and a flagged player drew a green ring under a blue name).
    // `dead` is left at its default here -- see that file for why the gray is the ring's rule alone.
    const [r, g, b] = selectionColor(unit.reaction, unit.isPlayer);
    return [r, g, b, 1];
  });
  /**
   * `GetComboPoints(unit, target)` -- `ComboFrame.lua:20`, reached from `PlayerFrame_ToPlayerArt`.
   *
   * The arguments are NOT inspected, and that is deliberate rather than lazy: the host already
   * resolved the pair when it pushed (see `setComboPoints`), and the only pair the 3.3.5a manifest
   * ever asks about is `("player", "target")` -- `ComboFrame_Update` is the sole caller. Reading a
   * token here would need a guid, which this module does not have and must not acquire.
   *
   * Zero when nothing has been pushed, which is the true answer for every class but a rogue or a
   * druid in Cat Form, and for those two out of combat.
   */
  fn('GetComboPoints', () => [getComboPoints(vm)]);

  fn('UnitClassification', (args) => [withUnit(args[0], 'normal', (u) => u.classification)]);
  fn('UnitIsPlayer', (args) => [withUnit(args[0], false, (u) => u.isPlayer)]);
  fn('UnitIsDead', (args) => [withUnit(args[0], false, (u) => u.dead)]);
  fn('UnitIsDeadOrGhost', (args) => [withUnit(args[0], false, (u) => u.dead)]);

  /**
   * The DIRECTIONAL calls -- `UnitIsEnemy(a, b)`, `UnitIsFriend(a, b)`, `UnitCanAttack(a, b)`.
   *
   * These take TWO tokens and the answer is a relationship, but a snapshot stores the relationship on
   * the non-player unit (its reaction TOWARD us), so reading the first argument is wrong: FrameXML
   * calls them as `UnitIsFriend("player", unit)` and the first token is the one with no reaction of
   * interest. benilla hit exactly this and solved it with `pick_unit_token`
   * (`crates/benilla-ui/src/script/unit/mod.rs:309-315`): take whichever argument is not "player",
   * falling back to the other.
   *
   * A test caught this: reading `args[0]` made `UnitIsEnemy("player", "target")` answer false for a
   * hostile target, which is precisely the bug that paints every enemy's frame friendly green.
   */
  const pickToken = (args: unknown[]): unknown => {
    if (typeof args[0] === 'string' && args[0] !== 'player') {
      return args[0];
    }
    return args[1] ?? args[0];
  };
  // 4 is the neutral point on the client's 1..8 reaction scale: strictly below is hostile, strictly
  // above is friendly, and neutral is neither.
  fn('UnitIsEnemy', (args) => [withUnit(pickToken(args), false, (u) => u.reaction < 4)]);
  fn('UnitIsFriend', (args) => [withUnit(pickToken(args), false, (u) => u.reaction > 4)]);
  // `UnitCanAttack` IS NOT `UnitIsEnemy`. It was written as the same test -- strictly hostile -- and
  // that is wrong at the neutral point: a neutral unit (every critter, every unaggressive beast) can
  // be attacked in this game and simply does not attack back. The reference states the boundary
  // explicitly at `benilla/src/target/click.rs:98`: the Attack cursor is "alive + reaction <= neutral".
  // With the strict form, right-clicking a chicken did nothing and `TargetFrame_CheckLevel` coloured a
  // neutral target's level as if it were unattackable.
  fn('UnitCanAttack', (args) => [withUnit(pickToken(args), false, (u) => u.reaction <= 4)]);

  // `UnitIsUnit(a, b)` is called seven times by TargetFrame.lua and is pure token algebra -- it needs
  // no field at all, only whether two tokens name the same unit. Compared by NAME because that is the
  // only identity a snapshot carries; a host that later puts a guid on the snapshot should compare
  // that instead, and this comment is the flag for it.
  fn('UnitIsUnit', (args) => {
    const a = withUnit(args[0], null, (u) => u.name);
    const b = withUnit(args[1], null, (u) => u.name);
    if (typeof args[0] === 'string' && args[0] === args[1]) {
      return [true];
    }
    return [a !== null && a === b];
  });

  // A unit we can see is a unit whose server is talking to us. There is no disconnect signal on the
  // wire this client reads, so this is a stated assumption rather than a measurement -- but answering
  // `false` (the honest-looking option) would make `TargetFrame_Update` print "Offline" over every
  // target, which is a worse lie.
  fn('UnitIsConnected', (args) => [withUnit(args[0], false, () => true)]);

  /**
   * `UnitIsVisible(unit)` -- is the unit within visible range?
   *
   * REAL, not a gap, and the answer is the same argument `UnitIsConnected` makes: a token is only
   * occupied while the host has a live unit for it, and the host only has one while the server is
   * streaming that unit to us. "In range" is precisely what being in the object registry MEANS -- a
   * unit that leaves range arrives as an out-of-range block and is removed
   * (`update-object/handler.ts`, `UpdateType.FarObjects`).
   *
   * FOUND BY MEASUREMENT, not by reading a list: with it absent, `PlayerFrame_ToPlayerArt` -- the
   * first thing `PlayerFrame_OnEvent` does on `PLAYER_ENTERING_WORLD` -- died at `PetFrame.lua:41`,
   * so `PlayerFrame_Update()` two lines later never ran and the player's LEVEL was never written.
   */
  fn('UnitIsVisible', (args) => [withUnit(args[0], false, () => true)]);

  /**
   * `GetUnitName(unit [, showServerName])` -- the name `UnitFrame_Update` actually calls
   * (unitframe.lua:84,86,107), NOT `UnitName`.
   *
   * It is registered here because `FrameXML.toc` does not define it: grepped across the manifest's
   * Lua at build 12340 and it appears only as a CALLER. In 3.3.5a it is an engine global, and an
   * absent one meant `self.name:SetText(GetUnitName(self.unit))` raised on the first line of every
   * unit frame's update -- which is a second, independent reason `PlayerFrame` had no name.
   *
   * The server-name half is nil: this client reads one realm and `SMSG_NAME_QUERY_RESPONSE`'s realm
   * string is empty on it (`network/game/handler.js#handleName` reads and discards it). The engine
   * appends "-Realm" only when the flag is set AND the unit is from another realm, so the two agree
   * here for the only case that exists.
   */
  fn('GetUnitName', (args) => [withUnit(args[0], null, (u) => u.name)]);
  fn('UnitPlayerControlled', (args) => [withUnit(args[0], false, (u) => u.isPlayer)]);

  /**
   * `UnitRace(unit)` -> `localizedName, fileName` and `UnitClass(unit)` -> `localizedName, TOKEN`.
   *
   * **BOTH RETURN TWO VALUES AND THE SECOND IS NOT THE FIRST.** FrameXML keys real tables on the
   * second -- `RAID_CLASS_COLORS` and `CLASS_ICON_TCOORDS` are both indexed by the uppercase class
   * token -- so answering the localized name twice would look right in a header and break every
   * lookup built on it. See `pipeline/dbc/race-class-data.ts` for which DBC column each comes from.
   *
   * THIS IS WHAT THE CHARACTER PANEL'S HEADER WAS BLOCKED ON. `PaperDollFrame_SetLevel`
   * (`paperdollframe.lua:203`) is a single line calling all three of `UnitLevel`, `UnitRace` and
   * `UnitClass`; `UnitRace` was registered NOWHERE, so it was a nil global, the line raised, and
   * `CharacterLevelText` kept the placeholder `paperdollframe.xml:279` authors -- the literal
   * `"Level level race class"` the owner sees. It was never a string-formatting gap:
   * `SetFormattedText` has been implemented since `methods/region.ts:685`.
   *
   * An EMPTY return (not a nil pair) when the id is 0 or the tables have not landed, because both
   * callers destructure into two locals and `format` prints "nil" for a nil where it prints nothing
   * for a missing argument.
   */
  const namePair = (
    token: unknown,
    read: (u: UnitSnapshot) => { name: string; token: string } | null,
  ): unknown[] => {
    const row = withUnit(token, null, read);
    return row === null ? [] : [row.name, row.token];
  };

  fn('UnitRace', (args) => namePair(args[0], (u) => u.race));
  fn('UnitClass', (args) => namePair(args[0], (u) => u.classInfo));

  // Gaps, declared. Each of these has NO source in this client today: there is no threat table, no
  // aura array read off the update fields, no cast bar feed, no tap state and no party roster. They
  // are registered so that `TargetFrame.lua` calling them does not raise and take its whole update
  // with it, and `notImplemented` records each name so the load report says which.
  const gaps: Array<[string, string, unknown[]]> = [
    ['UnitThreatSituation', 'no threat table is read from the wire', [null]],
    ['UnitDetailedThreatSituation', 'no threat table is read from the wire', [null]],
    ['UnitBuff', 'auras are not read out of the update fields yet', []],
    ['UnitDebuff', 'auras are not read out of the update fields yet', []],
    ['UnitCastingInfo', 'no cast bar feed exists', []],
    ['UnitChannelInfo', 'no cast bar feed exists', []],
    ['UnitIsTapped', 'UNIT_DYNAMIC_FLAGS is not read yet', [false]],
    ['UnitIsTappedByPlayer', 'UNIT_DYNAMIC_FLAGS is not read yet', [false]],
    ['UnitIsTappedByAllThreatList', 'UNIT_DYNAMIC_FLAGS is not read yet', [false]],
    ['UnitIsCorpse', 'no corpse state is fed', [false]],
    ['UnitIsGhost', 'no ghost state is fed', [false]],
    ['UnitIsPVP', 'UNIT_FIELD_FLAGS is not read yet', [false]],
    ['UnitIsPVPFreeForAll', 'PLAYER_FLAGS is not read yet', [false]],
    ['UnitFactionGroup', 'no faction group is resolved yet', []],
    ['UnitInParty', 'no party roster is fed', [false]],
    ['UnitInRaid', 'no raid roster is fed', []],
    ['UnitIsPartyLeader', 'no party roster is fed', [false]],
  ];
  // NOT `Unit*`, but on the same path and found the same way -- by loading the manifest and reading
  // which call `UnitFrame_OnLoad` died on next. Each of these is an ENGINE global (no FrameXML file
  // defines them), so an absent one is not a load-order problem that will fix itself later.
  //
  //  - `SetPortraitTexture(texture, unit)` (UnitFrame.lua:97) renders a unit's 3D portrait into a
  //    texture. This client has no portrait render target at all, so there is nothing to point it at.
  //  - `IsThreatWarningEnabled()` (UnitFrame.lua:437) gates the threat glow. There is no threat table
  //    on the wire here (see `UnitThreatSituation` above), so answering true would light a glow with
  //    no data behind it.
  gaps.push(
    ['SetPortraitTexture', 'no portrait render target exists in this client', []],
    ['SetPortraitToTexture', 'no portrait render target exists in this client', []],
    ['IsThreatWarningEnabled', 'no threat table is read from the wire', [false]],
    ['GetThreatStatusColor', 'no threat table is read from the wire', [1, 1, 1]],
    // The world-state globals the same chain reaches next, each found by re-measuring rather than
    // guessed. `UnitPopup.lua:457` (which `TargetFrame_OnLoad` reaches through its right-click menu)
    // reads `local inInstance, instanceType = IsInInstance()`, so the pair must be returned together
    // or the destructuring assigns nil to both.
    ['IsInInstance', 'no instance state is read from the wire', [false, 'none']],
    // `GetInstanceInfo()` returns `name, type, difficultyIndex, difficultyName, maxPlayers, ...`.
    // `UnitPopup.lua:245` destructures it, so the shape matters more than the values; this is what
    // the engine answers standing in the open world.
    ['GetInstanceInfo', 'no instance state is read from the wire', ['', 'none', 1, 'Normal', 0]],
    // `IsPartyLeader()` -- OURS, no argument, the twin of `UnitIsPartyLeader` above. Its absence was
    // the single most expensive missing global on this path: `UnitPopup.lua:469` calls it while
    // building a unit dropdown, which `TargetFrame_OnLoad` reaches, which took out the whole of
    // `TargetFrame`'s inline `<OnLoad>` -- including the `self:RegisterEvent("PLAYER_TARGET_CHANGED")`
    // three lines further down (TargetFrame.xml:654). So `TargetFrame` was never registered for the
    // one event that shows it, and no amount of correct unit data would have made it appear. It also
    // killed `PlayerFrame_Update` at `PlayerFrame.lua:63`, which is why the player's level was blank.
    // False is the honest answer with no party: `GetNumPartyMembers` answers 0 beside it.
    ['IsPartyLeader', 'no party roster is fed', [false]],
    // The rest of the same chain, all found the same way -- by running the manifest and reading which
    // call the OnLoad died on NEXT. `UnitPopup_HideButtons` (unitpopup.lua:455-485) alone needs
    // `IsInInstance`, `GetNumPartyMembers`, `GetNumRaidMembers`, `IsPartyLeader`, `IsRaidOfficer`,
    // `UnitInBattleground` and `UnitCanCooperate` before it reaches its first menu row, and
    // `PlayerFrame_UpdatePartyLeader` (playerframe.lua:62-83) needs `HasLFGRestrictions` and
    // `GetLootMethod`. Every one of them has no source in this client and every one answers the
    // "nothing here" value, which is also the true value for a solo player outside an instance.
    //
    // `GetLootMethod` returns TWO values and the second is compared to a NUMBER
    // (`lootMaster == 0`), so a one-value stub leaves `lootMaster` nil and the master-looter icon
    // decision reads `nil == 0`. Answering `'freeforall', nil` is what a party-less client is.
    ['IsRaidOfficer', 'no raid roster is fed', [false]],
    ['UnitInBattleground', 'no battleground state is read from the wire', [null]],
    ['UnitCanCooperate', 'no group or faction cooperation state is fed', [false]],
    ['HasLFGRestrictions', 'no LFG state is read from the wire', [false]],
    ['GetLootMethod', 'no group loot state is read from the wire', ['freeforall', null]],
    // The remainder of the same walk, each found by re-running the manifest and reading the next
    // failing call. THE VALUES ARE NOT ARBITRARY: three of them are compared to numbers rather than
    // tested for truth, so nil would change a branch rather than skip one.
    //  - `GetLootThreshold` indexes a string table: `_G["ITEM_QUALITY"..GetLootThreshold().."_DESC"]`
    //    (unitpopup.lua:226). 2 is Uncommon, the game's own default.
    //  - `GetDungeonDifficulty`/`GetRaidDifficulty` are compared `== 1` (unitpopup.lua:700,704).
    //    1 is Normal / 10-player, which is what a client with no instance state is in.
    //  - `UnitHasVehicleUI` gates three separate branches of `PlayerFrame_UpdateStatus`,
    //    `PlayerFrame_UpdateLayout` and `PlayerFrame_ToPlayerArt` (playerframe.lua:433 and on). There
    //    are no vehicles in this client and false is the only branch that can be drawn.
    //  - `IsResting` decides the rest glow; there is no `PLAYER_UPDATE_RESTING` feed here.
    ['GetLootThreshold', 'no group loot state is read from the wire', [2]],
    ['GetDungeonDifficulty', 'no instance state is read from the wire', [1]],
    ['GetRaidDifficulty', 'no instance state is read from the wire', [1]],
    ['UnitHasVehicleUI', 'this client has no vehicles', [false]],
    ['UnitInVehicle', 'this client has no vehicles', [false]],
    ['IsResting', 'no resting state is read from the wire', [false]],
    ['GetOptOutOfLoot', 'no group loot state is read from the wire', [false]],
    // `GetWatchedFactionInfo()` -> `name, standing, min, max, value`, and NIL for `name` is a real
    // answer, not a placeholder: it is what the engine returns when no faction is being watched, which
    // is every character that has not ticked the box. `ReputationWatchBar_Update`'s first line reads it
    // (`ReputationFrame.lua:324`), so its ABSENCE made that function raise -- and that function is the
    // only thing in 3.3.5a's whole manifest that ever shows `MainMenuExpBar` again once it has hidden
    // itself. Declared here rather than left missing so the reputation path cannot take down the
    // experience bar's owner a second time. (The bar no longer DEPENDS on it -- the seeded snapshot
    // stops the bar hiding in the first place; see `ui/unit-bridge.ts#seedUnitSnapshots`.)
    ['GetWatchedFactionInfo', 'no reputation feed: SMSG_INITIALIZE_FACTIONS is not decoded, so no '
      + 'faction is watched and the reputation half of the bar draws nothing', [null]],
    // `GetSummonFriendCooldown()` -> `start, duration`, immediately arithmetic:
    // `local remaining = start + duration - GetTime()` (unitpopup.lua:264). Two ZEROS, not nil --
    // nil there is an arithmetic error, not a skipped branch.
    ['GetSummonFriendCooldown', 'no refer-a-friend state is read from the wire', [0, 0]],
    ['CanSummonFriend', 'no refer-a-friend state is read from the wire', [false]],
    ['CanChangePlayerDifficulty', 'no instance state is read from the wire', [false]],
    ['GetRaidTargetIndex', 'no raid target icons are read from the wire', [null]],
    ['UnitPlayerOrPetInParty', 'no party roster is fed', [false]],
    ['UnitPlayerOrPetInRaid', 'no raid roster is fed', [false]],
    ['UnitIsSameServer', 'this client reads one realm', [true]],
    ['UnitGroupRolesAssigned', 'no party roster is fed', ['NONE']],
    ['UnitIsRaidOfficer', 'no raid roster is fed', [false]],
    ['UnitIsInMyGuild', 'no guild roster is fed', [false]],
    ['IsGuildLeader', 'no guild roster is fed', [false]],
    ['CheckInteractDistance', 'no interact-distance test exists in this client', [false]],
    // `UnitAura(unit, index, filter)` is the ARRAY form `BuffFrame_Update` walks (bufffframe.lua:125);
    // `UnitBuff`/`UnitDebuff` above are the same gap by their other two names. Answering nothing
    // terminates the walk at index 1, which is what a unit with no auras looks like.
    ['UnitAura', 'auras are not read out of the update fields yet', []],
    /**
     * `GetWeaponEnchantInfo()` -> `hasMainHand, mainExpiration, mainCharges, hasOffHand, ...`.
     *
     * Answering NOTHING is what makes `TemporaryEnchantFrame_OnUpdate` take its early exit and HIDE the
     * two weapon-buff squares (`buffframe.lua:400-405`); they are authored shown (`buffframe.xml:201-217`)
     * and nothing else hides them. So this gap has a visible effect the moment it is declared, which is
     * why it is declared rather than left nil -- a nil raised inside that handler and the squares stayed.
     * The real feed is the main/off-hand temporary-enchant fields of the player's item data, which this
     * client does not decode at all.
     */
    ['GetWeaponEnchantInfo', 'no item data is decoded, so no weapon enchant is known', []],
    // The Chinese anti-addiction play-time pair, which `PlayerFrame_UpdatePlaytime` calls
    // unconditionally (playerframe.lua:507). Both false is "no play-time restriction", which is what
    // every non-CN realm reports.
    ['PartialPlayTime', 'no play-time restriction state is read from the wire', [false]],
    ['NoPlayTime', 'no play-time restriction state is read from the wire', [false]],
    ['GetPartyMember', 'no party roster is fed', [false]],
    ['GetNumPartyMembers', 'no party roster is fed', [0]],
    ['GetNumRaidMembers', 'no raid roster is fed', [0]],
    // `uiparent.lua:1927`, called UNGUARDED in the tail of the managed-frame-position pass and then
    // compared with `> 0`. Zero is the true answer -- there is no arena and no `ArenaEnemyFrames` fed --
    // and it must be a NUMBER, because a nil would raise on the comparison and truncate the rest of the
    // pass (WatchFrame, the durability frames, the container anchors). It is after the `securecall` loop,
    // so this was never what held the cast bar up; see `api/screen.ts#GetScreenResolutions` for that.
    ['GetNumArenaOpponents', 'no arena roster is fed', [0]],
    /**
     * `RegisterStaticConstants(STATIC_CONSTANTS)` -- `Constants.lua:469`, AT FILE SCOPE.
     *
     * The engine fills the table it is handed with a name-to-value translation table. Nothing in the loaded
     * manifest reads `STATIC_CONSTANTS`, and what the engine puts in it is not sourced here, so it is left
     * EMPTY -- but it has to exist, because a nil here raises at file scope and takes the last ten lines of
     * `Constants.lua` with it: `TEXTURE_ITEM_QUEST_BANG`, `TEXTURE_ITEM_QUEST_BORDER`,
     * `SHOW_SEARCH_BAR_NUM_FRIENDS` and the faction block. Declared through `notImplemented` so the load
     * report names it rather than a silent no-op leaving an empty table nobody knows is empty.
     */
    ['RegisterStaticConstants', 'the engine\'s name-to-value constant table is not sourced, so '
      + 'STATIC_CONSTANTS is left empty; nothing in the loaded manifest reads it', []],
    // THE MODIFIER KEYS. `IsShiftKeyDown` is deliberately NOT here any more, and the removal is the fix:
    // `api/screen.ts` registers a REAL one tracked off the DOM, and this file is installed AFTER it
    // (`world-runtime.ts:139` then `:144`), so this hard `false` was silently shadowing the real answer in
    // the world. STATE.md recorded the double registration as "which wins depends on install order"; the
    // order is now measured and it was this one, which is why shift state never reached the Lua.
    // `IsControlKeyDown` and `IsAltKeyDown` moved to `screen.ts` beside it for the same reason.
    //
    // `IsModifiedClick` is NO LONGER HERE either, and for the same shadowing reason: it is real in
    // `api/screen.ts` beside the three key trackers it reads, because the shift-gated action bar needs it
    // (`actionbarframe.xml:19`). A hard `false` here would have shadowed it in the world, which is exactly
    // the defect the three keys above suffered.
    ['GetBindingKey', 'no keybinding table exists in this client', []],
    // `GetMoney` IS NO LONGER HERE. `PLAYER_FIELD_COINAGE` is read now -- `ItemHandler` accumulates our
    // own character's descriptor words -- so it is a REAL global in `ui/container-bridge.ts`, beside the
    // rest of the inventory. It must not also be declared here: `installUnitsApi` runs during the boot,
    // before the bridge attaches, but a stub registered later or a name resolved through this table
    // would shadow the real answer, which is the exact defect the `IsModifiedClick` note above records.
  );

  /**
   * `GetQuestDifficultyColor(level)` -- the colour a level NUMBER is drawn in, and the one global on
   * this path that must return a TABLE (`color.r`, `color.g`, `color.b`).
   *
   * `TargetFrame_CheckLevel` (targetframe.lua:246-251) does
   * `local color = GetQuestDifficultyColor(targetLevel); self.levelText:SetVertexColor(color.r, ...)`,
   * so a nil here is not a missing colour -- it is an error that stops `TargetFrame_Update` before
   * the classification and dead checks. `notImplemented` cannot answer it: its results are plain
   * values and this needs a table.
   *
   * WRITTEN IN LUA, and deliberately: the five colours are the client's OWN
   * `QuestDifficultyColors` table (`Constants.lua`), so reading them there rather than transcribing
   * them into TypeScript means there is one copy and it is the game's. Registered before the manifest
   * runs but resolved at CALL time, which is after `Constants.lua` has defined the table; the
   * fallback exists only for a VM where it somehow has not.
   *
   * THE GREEN RANGE IS NOT PINNED. The engine's `GetQuestGreenRange()` is a level-dependent constant
   * this client has no source for, so anything below the yellow band is green rather than fading to
   * grey at low relative level. Said plainly rather than approximated with an invented table: the
   * visible consequence is that a much lower-level unit's number is green where the real client would
   * grey it.
   */
  vm.run(
    `function GetQuestDifficultyColor(level)
      local colors = QuestDifficultyColors
      local diff = (level or 0) - (UnitLevel("player") or 0)
      local key
      if diff >= 5 then key = "impossible"
      elseif diff >= 3 then key = "verydifficult"
      elseif diff >= -2 then key = "difficult"
      else key = "standard" end
      if colors and colors[key] then return colors[key] end
      return { r = 1.0, g = 0.82, b = 0.0 }
    end`,
    'units-api.lua',
  );

  /**
   * `FillLocalizedClassList(table, isFemale)` -- AND IT WAS KILLING `Constants.lua` AT FILE SCOPE.
   *
   * ## This is the `UIParent.lua:102` defect again, one file earlier and much larger
   *
   * `Constants.lua` is the SECOND real entry in `FrameXML.toc` (after `GlobalStrings.lua`), and lines 85-88
   * are, at file scope:
   *
   *     LOCALIZED_CLASS_NAMES_MALE = {};
   *     LOCALIZED_CLASS_NAMES_FEMALE = {};
   *     FillLocalizedClassList(LOCALIZED_CLASS_NAMES_MALE, false);
   *     FillLocalizedClassList(LOCALIZED_CLASS_NAMES_FEMALE, true);
   *
   * Read off the served `interface/framexml/constants.lua` (13,223 B, 478 lines). The global was absent, so
   * line 87 raised and **lines 87-478 of a 478-line file never ran** -- and `world-runtime.ts` records a
   * raising chunk as one error line for the file with no partial execution, so this cost one line in the load
   * report and roughly 170 globals in the runtime. Among them, all measured by their line being below 87:
   * `CLASS_ICON_TCOORDS` (every class icon), the 21 `INVSLOT_*`, `NUM_BAG_SLOTS`/`BACKPACK_CONTAINER`/
   * `BANK_CONTAINER` and the container block, the `SPELL_POWER_*` ids the power bars colour by, the
   * `ITEM_QUALITY_*` constants, the 40 `COMBATLOG_OBJECT_*`/`COMBATLOG_FILTER_*` names, `TOTEM_PRIORITIES`
   * and the totem block, and the `CALENDAR_*`/`ACHIEVEMENT_*`/`GMTICKET_*` blocks.
   *
   * **It also silently disabled a function in THIS FILE.** `GetQuestDifficultyColor` above reads the client's
   * own `QuestDifficultyColors`, and that table is `constants.lua:403` -- below the kill. Its comment says
   * the hard-coded fallback "exists only for a VM where it somehow has not" been defined; in fact the
   * fallback was the only path ever taken, so every level number drew in one colour. That is exactly the
   * hazard `CLAUDE.md` names: a comment that describes a gap as closed when it is not.
   *
   * ## Why this is a real implementation and not a stub
   *
   * It MUTATES its first argument -- it is not a getter, and a getter-shaped stub returning a table would
   * leave `LOCALIZED_CLASS_NAMES_MALE` empty while looking correct. Written in Lua for the same reason
   * `GetQuestDifficultyColor` is: the caller hands in a live Lua table and this fills it in place.
   *
   * The keys are `ChrClasses.dbc`'s `classFile` tokens and the values its `name` column, enUS, build 12340 --
   * the same table `api/characters.ts#CLASS_NAMES` carries, keyed differently on purpose: that one is keyed
   * by the numeric class id because the wire sends an id, this one by token because FrameXML indexes by
   * token (`LOCALIZED_CLASS_NAMES_MALE[select(2, UnitClass(unit))]`). There is no class 10 in 3.3.5a.
   *
   * `isFemale` is accepted and IGNORED, and that is correct for this client rather than lazy: enUS class
   * names are not gendered, so `ChrClasses.dbc`'s male and female name columns hold identical strings and
   * the real client fills both tables the same way. In a gendered locale they differ; this client serves
   * enUS only. Said plainly here so nobody reads the ignored argument as an oversight.
   */
  vm.run(
    `local WOW_CLASS_NAMES = {
      WARRIOR = "Warrior", PALADIN = "Paladin", HUNTER = "Hunter", ROGUE = "Rogue",
      PRIEST = "Priest", DEATHKNIGHT = "Death Knight", SHAMAN = "Shaman", MAGE = "Mage",
      WARLOCK = "Warlock", DRUID = "Druid",
    }
    function FillLocalizedClassList(t, isFemale)
      if type(t) ~= "table" then return end
      for token, name in pairs(WOW_CLASS_NAMES) do t[token] = name end
      return t
    end`,
    'units-api.lua',
  );

  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD (ctx, self, args); a global takes only args. The two
    // shapes differ, so the stub is adapted rather than registered directly -- what is reused is the
    // NAME REGISTRATION, which is the part the load report reads.
    fn(name, () => stub(null as never, 0, []));
  }
}
