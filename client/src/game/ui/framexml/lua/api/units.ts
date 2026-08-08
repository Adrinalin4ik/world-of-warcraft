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

  fn('UnitPowerType', (args) => [withUnit(args[0], 0, (u) => u.powerType)]);
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

  fn('UnitReaction', (args) => [withUnit(args[0], null, (u) => u.reaction)]);
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
  fn('UnitCanAttack', (args) => [withUnit(pickToken(args), false, (u) => u.reaction < 4)]);

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
  fn('UnitPlayerControlled', (args) => [withUnit(args[0], false, (u) => u.isPlayer)]);

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
    ['UnitSelectionColor', 'the reaction palette is not ported yet', [1, 1, 1, 1]],
    ['UnitClass', 'no class is read out of UNIT_FIELD_BYTES_0 yet', []],
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
    ['GetPartyMember', 'no party roster is fed', [false]],
    ['GetNumPartyMembers', 'no party roster is fed', [0]],
    ['GetNumRaidMembers', 'no raid roster is fed', [0]],
    // The modifier keys. `input.ts` tracks no modifier state at all today, so these answer false --
    // which is the safe direction: every FrameXML caller uses them to ADD behaviour (ctrl-click to
    // dressing-room, shift-click to link), so false is "the plain action" rather than a wrong action.
    ['IsControlKeyDown', 'input.ts tracks no modifier-key state', [false]],
    ['IsShiftKeyDown', 'input.ts tracks no modifier-key state', [false]],
    ['IsAltKeyDown', 'input.ts tracks no modifier-key state', [false]],
    ['IsModifiedClick', 'input.ts tracks no modifier-key state', [false]],
    ['GetBindingKey', 'no keybinding table exists in this client', []],
    ['GetMoney', 'PLAYER_FIELD_COINAGE is not read yet', [0]],
  );

  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    // `notImplemented` builds a FRAME METHOD (ctx, self, args); a global takes only args. The two
    // shapes differ, so the stub is adapted rather than registered directly -- what is reused is the
    // NAME REGISTRATION, which is the part the load report reads.
    fn(name, () => stub(null as never, 0, []));
  }
}
