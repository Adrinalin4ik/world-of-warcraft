/**
 * THE CHARACTER SHEET'S STAT GLOBALS -- the two panes under the model, and the resistance row.
 *
 * The owner: "I don't see character stats under the preview and don't see options in selects there."
 * That was TWO independent causes and this file is the second:
 *
 *  1. **A CVar seeding bug.** `PaperDollFrame_OnEvent`'s `VARIABLES_LOADED` arm tests
 *     `GetCVar("playerStatLeftDropdown") == ""` (`paperdollframe.lua:163`) and in Lua `nil == ""` is
 *     FALSE, so with the CVar unknown the defaults were never written; `UpdatePaperdollStats(prefix,
 *     index)` is a five-way `if index == "PLAYERSTAT_*"` chain with no else, so every branch was
 *     skipped and both panes kept their placeholders -- and the same nil went to
 *     `UIDropDownMenu_SetSelectedValue`, which is why the two selects read blank too. Fixed by seeding
 *     the pair EMPTY in `api/screen.ts`, which is what lets the client choose its own per-class
 *     defaults.
 *  2. Every stat-reading engine global was absent, so even with a category chosen the branch raised on
 *     its first call. That is this file.
 *
 * ## Nothing here computes a game rule
 *
 * Every number below is a descriptor word (`update-object/character-stats.ts`), or an arithmetic
 * combination the client's own Lua would otherwise do. What is NOT here is anything needing a
 * coefficient table this client does not have -- the rating-to-percent curves (`gtCombatRatings.dbc`),
 * the per-class attack-power-per-stat table, the spirit regen curves. Those go through
 * `notImplemented` so the load report names them, because a plausible-looking wrong percentage on a
 * character sheet is exactly the "renders plausibly and wrongly" failure the project's rules forbid.
 *
 * ## Cost
 *
 * One `UNIT_STATS` event per descriptor packet that actually moved a stat word, and the client's own
 * handler returns on `if ( not self:IsVisible() )` (`paperdollframe.lua:180`) -- so with the character
 * panel shut the whole cost is one event dispatch to one frame. With it open, twelve stat frames re-read
 * and re-format, which is the same work the real client does on the same event. The globals themselves
 * are array indexes: no allocation, no DBC join, no descriptor walk.
 */
import type World from '../world';
import { LuaVM } from './framexml/lua/vm';
import { notImplemented } from './framexml/lua/methods/region';
import { fireEvent } from './framexml/lua/events';
import { CharacterStats } from '../../network/game/object/update-object/character-stats';

/**
 * `CR_WEAPON_SKILL` .. `CR_ARMOR_PENETRATION` are 1-based in Lua (`Constants.lua`), and
 * `characterStats.combatRatings` is 0-based, so every `GetCombatRating(i)` is `[i - 1]`. Named here
 * because the off-by-one is the only thing that can go wrong in that function.
 */
const RATING_BASE = 1;

/**
 * `UnitStat`'s `statIndex` is 1..5 and `characterStats.stats` is 0-based. The ORDER is the client's own
 * -- `PaperDollFrame_SetStat` is called with 1..5 for strength, agility, stamina, intellect, spirit
 * (`paperdollframe.lua:1682-1687`), which is `UNIT_FIELD_STAT0..4`'s order in the descriptor. That
 * agreement is the check on it.
 */
const STAT_BASE = 1;

/** Whether a unit token is the one unit whose stat block this client has. See `statsFor`. */
function isPlayerToken(token: unknown): boolean {
  return String(token ?? '').toLowerCase() === 'player';
}

export function attachPaperDollStats(vm: LuaVM, world: World): () => void {
  /**
   * The stat block, or null for any unit but the player.
   *
   * **Only `"player"` answers, and that is a true answer rather than a limitation being hidden.** The
   * stat fields are unit-scope on the wire, so a creature carries them -- but the character sheet only
   * ever asks for `"player"`, and `PetPaperDollFrame` asks for `"pet"`, which this client has no unit
   * for at all (a declared gap in `api/units.ts`). Answering a target's real numbers where the sheet
   * expects the player's would be worse than answering nothing.
   */
  const statsFor = (token: unknown): CharacterStats | null => (
    isPlayerToken(token) ? world.player.characterStats : null
  );

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * `UnitStat(unit, statIndex)` -> `stat, effectiveStat, posBuff, negBuff`.
   *
   * FOUR returns and the first two are NOT the same number in the real client: `stat` is the base and
   * `effectiveStat` the total. The descriptor carries the TOTAL in `UNIT_FIELD_STATx` and the two buff
   * components separately, so the base is `total - pos + neg` -- the wire's `negstat` is a positive
   * magnitude, which is why it is added back. `PaperDollFrame_SetStat` uses `effectiveStat` for the
   * number and the pos/neg pair to colour it (`paperdollframe.lua:233-260`).
   */
  fn('UnitStat', (args) => {
    const stats = statsFor(args[0]);
    const index = Number(args[1]) - STAT_BASE;
    if (stats === null || !(index >= 0 && index < stats.stats.length)) {
      return [0, 0, 0, 0];
    }
    const total = stats.stats[index];
    const pos = stats.statsPos[index];
    const neg = stats.statsNeg[index];
    return [total - pos + neg, total, pos, neg];
  });

  /**
   * `UnitArmor(unit)` -> `base, effectiveArmor, armor, posBuff, negBuff`.
   *
   * FIVE returns, and `PaperDollFrame_SetArmor` reads `effectiveArmor` when it is non-zero and `armor`
   * otherwise (`paperdollframe.lua:430-446`). `effectiveArmor` is the real client's "armour after the
   * target's level is taken into account" and is 0 out of combat, which is why the fallback exists --
   * so 0 here is the correct value and not a missing one. Armour is resistance slot **0**; see
   * `character-stats.ts#RESISTANCE_COUNT`.
   */
  fn('UnitArmor', (args) => {
    const stats = statsFor(args[0]);
    if (stats === null) {
      return [0, 0, 0, 0, 0];
    }
    const total = stats.resistances[0];
    const pos = stats.resistPos[0];
    const neg = stats.resistNeg[0];
    return [total - pos + neg, 0, total, pos, neg];
  });

  /**
   * `UnitResistance(unit, school)` -> `base, resistance, posBuff, negBuff`.
   *
   * `school` is the RESISTANCE index, 0 armour and 1..6 the schools -- `PaperDollFrame_SetResistances`
   * passes `frame:GetID()` for the six resistance buttons (`paperdollframe.lua:376`).
   *
   * **Its absence was suppressing the panes even after the CVar fix**: `PaperDollFrame_SetResistances`
   * runs from `PaperDollFrame_OnShow` BEFORE `PaperDollFrame_UpdateStats` (`:1092-1093`), so a nil here
   * took out the whole handler.
   */
  fn('UnitResistance', (args) => {
    const stats = statsFor(args[0]);
    const school = Number(args[1]);
    if (stats === null || !(school >= 0 && school < stats.resistances.length)) {
      return [0, 0, 0, 0];
    }
    const total = stats.resistances[school];
    const pos = stats.resistPos[school];
    const neg = stats.resistNeg[school];
    return [total - pos + neg, total, pos, neg];
  });

  /**
   * `UnitAttackPower(unit)` / `UnitRangedAttackPower(unit)` -> `base, posBuff, negBuff`.
   *
   * THREE returns, and the client's own arithmetic is `base + posBuff - negBuff` with the multiplier
   * applied on top (`paperdollframe.lua:657-680`). This client's `attackPowerMods` is ONE signed word
   * for both directions -- there is no separate positive and negative field on the wire -- so it is
   * reported as the positive when it is positive and as the negative magnitude when it is not. The sum
   * the client computes is identical either way, and the only visible difference is which colour the
   * tooltip paints the modifier.
   *
   * The multiplier is deliberately NOT folded in here: `caster-stats.ts:32-39` already documents that
   * the total is `(base + mods) * (1 + multiplier)`, and the sheet applies its own arithmetic to these
   * three returns. Folding it in would double-count.
   */
  const attackPowerTriple = (base: number, mods: number): unknown[] => (
    mods >= 0 ? [base, mods, 0] : [base, 0, -mods]
  );
  fn('UnitAttackPower', (args) => (isPlayerToken(args[0])
    ? attackPowerTriple(world.player.fields.attackPower ?? 0, world.player.fields.attackPowerMods ?? 0)
    : [0, 0, 0]));
  fn('UnitRangedAttackPower', (args) => (isPlayerToken(args[0])
    ? attackPowerTriple(
      world.player.fields.rangedAttackPower ?? 0,
      world.player.fields.rangedAttackPowerMods ?? 0,
    )
    : [0, 0, 0]));

  /**
   * `UnitDamage(unit)` -> `minDamage, maxDamage, minOffHandDamage, maxOffHandDamage, physicalBonusPos,
   * physicalBonusNeg, percent`.
   *
   * SEVEN returns (`paperdollframe.lua:542`). The two physical-bonus words are a separate descriptor
   * block this client does not read, and `percent` is a damage multiplier the wire does not carry at
   * all -- **1 is its identity, not a guess**: `PaperDollFrame_SetDamage` multiplies by it
   * (`:544-560`), so 0 would report zero damage for every character.
   */
  fn('UnitDamage', (args) => {
    const stats = statsFor(args[0]);
    if (stats === null) {
      return [0, 0, 0, 0, 0, 0, 1];
    }
    return [
      stats.minDamage, stats.maxDamage,
      stats.minOffhandDamage, stats.maxOffhandDamage,
      0, 0, 1,
    ];
  });

  /**
   * `UnitRangedDamage(unit)` -> `rangedAttackSpeed, minDamage, maxDamage, physicalBonusPos,
   * physicalBonusNeg, percent`.
   *
   * SIX returns, speed FIRST (`paperdollframe.lua:792`). The ranged attack time is the descriptor word
   * after `unit_field_baseattacktime`, which this client reads only as the main-hand pair, so the speed
   * is the main-hand time until a ranged weapon's own is read -- and 0 is what an unarmed ranged slot
   * genuinely reports.
   */
  fn('UnitRangedDamage', (args) => {
    const stats = statsFor(args[0]);
    if (stats === null) {
      return [0, 0, 0, 0, 0, 1];
    }
    return [0, stats.minRangedDamage, stats.maxRangedDamage, 0, 0, 1];
  });

  /**
   * `UnitAttackSpeed(unit)` -> `mainSpeed, offSpeed`, in SECONDS.
   *
   * The wire carries milliseconds (`unit_field_baseattacktime`), which `unit-fields.ts` already reads as
   * `baseAttackTimeMs`; `caster-stats.ts` divides the same word by 1000 for `$MWS`, so the conversion
   * is stated in both places rather than in neither. The off-hand time is the next descriptor word and
   * is not read, so it is 0 -- which is what a character with no off-hand weapon reports.
   */
  fn('UnitAttackSpeed', (args) => (isPlayerToken(args[0])
    ? [(world.player.fields.baseAttackTimeMs ?? 0) / 1000, 0]
    : [0, 0]));

  /**
   * `UnitAttackBothHands(unit)` -> `mainBase, mainMod, offBase, offMod` -- the WEAPON SKILL numbers, not
   * damage. `PaperDollFrame_SetAttackBothHands` compares them against `UnitLevel * 5`
   * (`paperdollframe.lua:668-690`).
   *
   * A DECLARED GAP rather than a zero, because zero is a real and wrong answer here: it would read as
   * "your weapon skill is 0", which the client then colours red as a penalty. Weapon skill lives in
   * `PLAYER_SKILL_INFO_1_1`, which is not decoded.
   */

  /** `GetCombatRating(i)` -- the raw rating. 1-based in Lua; see `RATING_BASE`. */
  fn('GetCombatRating', (args) => {
    const index = Number(args[0]) - RATING_BASE;
    const ratings = world.player.characterStats.combatRatings;
    return [index >= 0 && index < ratings.length ? ratings[index] : 0];
  });

  /** The four percentages the descriptor carries outright. Already 0..100 on the wire. */
  fn('GetCritChance', () => [world.player.characterStats.critPercent]);
  fn('GetRangedCritChance', () => [world.player.characterStats.rangedCritPercent]);
  fn('GetDodgeChance', () => [world.player.characterStats.dodgePercent]);
  fn('GetParryChance', () => [world.player.characterStats.parryPercent]);
  fn('GetBlockChance', () => [world.player.characterStats.blockPercent]);
  /** The shield's absorbed VALUE, an integer -- not `GetBlockChance`. */
  fn('GetShieldBlock', () => [world.player.characterStats.shieldBlock]);

  /**
   * `GetSpellCritChance(school)` -- 0..100 per school, and the argument is a SPELL SCHOOL index which is
   * the same 0..6 numbering the resistance array uses (`paperdollframe.lua:346-352` walks
   * `holySchool..MAX_SPELL_SCHOOLS`).
   */
  fn('GetSpellCritChance', (args) => {
    const school = Number(args[0]);
    const table = world.player.characterStats.spellCritPercent;
    return [school >= 0 && school < table.length ? table[school] : 0];
  });

  /** `GetExpertise()` -> `expertise, offhandExpertise` -- raw points, not a percentage. */
  fn('GetExpertise', () => [
    world.player.characterStats.expertise,
    world.player.characterStats.offhandExpertise,
  ]);

  /**
   * `GetSpellBonusDamage(school)` / `GetSpellBonusHealing()`.
   *
   * Both already existed as DATA -- `unit.spellDamage` and `fields.healingDone` are what
   * `ui/caster-stats.ts` reads for a spell description's `$SP` and `$bh`. This is the same numbers
   * reaching the character sheet, which is why neither is recomputed here.
   */
  fn('GetSpellBonusDamage', (args) => {
    const school = Number(args[0]);
    const table = world.player.spellDamage;
    return [school >= 0 && school < table.length ? table[school] : 0];
  });
  fn('GetSpellBonusHealing', () => [world.player.fields.healingDone ?? 0]);

  /**
   * THE DECLARED HALF, and every one of these needs a table or a feed this client has not got. Each
   * answers the shape its call site destructures, so the pane renders with the value missing rather
   * than raising and taking the whole pane with it -- which is the difference between one blank number
   * and six.
   *
   * The rating-to-percent curves are the big one: `GetCombatRatingBonus` and its siblings are
   * `gtCombatRatings.dbc` lookups keyed on rating and level, and that DBC is not joined here. Returning
   * a computed-looking percentage without it would be a fabricated game rule on a character sheet.
   */
  const gaps: Array<[string, string, unknown[]]> = [
    ['GetCombatRatingBonus', 'the rating-to-percent curve is gtCombatRatings.dbc, which is not joined; '
      + 'a computed percentage without it would be a fabricated game rule', [0]],
    ['GetMaxCombatRatingBonus', 'as GetCombatRatingBonus', [0]],
    ['GetExpertisePercent', 'expertise points convert to a percentage through a per-class constant this '
      + 'client does not have; GetExpertise answers the raw points, which is what the wire carries',
    [0, 0]],
    ['UnitAttackBothHands', 'weapon skill lives in PLAYER_SKILL_INFO_1_1, which is not decoded. Zero is '
      + 'not a safe stand-in: the sheet colours a skill below level*5 as a penalty', [0, 0, 0, 0]],
    ['UnitRangedAttack', 'as UnitAttackBothHands -- ranged weapon skill is a skill line', [0, 0]],
    ['UnitDefense', 'defense skill is a skill line (PLAYER_SKILL_INFO_1_1, not decoded); the DEFENSE '
      + 'rating beside it does resolve through GetCombatRating', [0, 0]],
    ['GetArmorPenetration', 'the rating-to-percent curve, as GetCombatRatingBonus', [0]],
    ['GetSpellPenetration', 'PLAYER_FIELD_MOD_TARGET_RESISTANCE is not read', [0]],
    ['GetManaRegen', 'the spirit-to-regen curve is gtRegenMPPerSpt.dbc, which is not joined', [0, 0]],
    ['GetAttackPowerForStat', 'the attack-power-per-stat table is per class and per stat and this '
      + 'client decodes no such table', [0]],
    ['GetCritChanceFromAgility', 'gtChanceToMeleeCritBase / gtChanceToMeleeCrit are not joined', [0]],
    ['GetSpellCritChanceFromIntellect', 'gtChanceToSpellCrit is not joined', [0]],
    ['GetUnitManaRegenRateFromSpirit', 'as GetManaRegen', [0]],
    ['GetUnitHealthRegenRateFromSpirit', 'gtRegenHPPerSpt is not joined', [0]],
    ['GetUnitMaxHealthModifier', 'the pet-scaling modifiers need a pet unit, which this client has '
      + 'none of', [1]],
    ['GetUnitHealthModifier', 'as GetUnitMaxHealthModifier', [1]],
    ['GetUnitPowerModifier', 'as GetUnitMaxHealthModifier', [1]],
    ['HasWandEquipped', 'the ranged slot\'s item SUBCLASS is not read off the template, so a wand '
      + 'cannot be told from a bow', [false]],
    ['GetGuildInfo', 'no guild state is decoded (SMSG_GUILD_QUERY_RESPONSE has no subscriber)', []],
  ];
  for (const [name, reason, results] of gaps) {
    const stub = notImplemented(name, reason, results);
    fn(name, () => stub(null as never, 0, []));
  }

  /**
   * TELL THE SHEET WHEN A NUMBER MOVES.
   *
   * `PaperDollFrame_OnLoad` registers `UNIT_STATS`, `UNIT_RESISTANCES`, `UNIT_DAMAGE`,
   * `UNIT_ATTACK_POWER`, `UNIT_RANGED_ATTACK_POWER`, `UNIT_ATTACK_SPEED`, `UNIT_ATTACK`,
   * `UNIT_RANGEDDAMAGE` and `COMBAT_RATING_UPDATE` (`paperdollframe.lua:118-136`) and its handler maps
   * every one of them onto `PaperDollFrame_UpdateStats` (`:186-199`). One event is therefore enough to
   * repaint both panes, and `UNIT_STATS` is the one that means "a stat block changed".
   *
   * **`UNIT_RESISTANCES` is fired as well and is not redundant**: its arm calls
   * `PaperDollFrame_SetResistances()` BEFORE `PaperDollFrame_UpdateStats()` (`:189-191`), and the
   * resistance ROW is not part of either pane.
   *
   * Cost: the client's own handler returns immediately on `if ( not self:IsVisible() )` (`:180`), so
   * with the panel shut this is two event dispatches to one frame per descriptor packet. The
   * `unitsChanged` edge is the same one `unit-bridge.ts` already listens on, so no new subscription
   * walks the world.
   */
  const onFields = (unit: unknown): void => {
    if (unit !== world.player) {
      return;
    }
    fireEvent(vm, 'UNIT_STATS', ['player']);
    fireEvent(vm, 'UNIT_RESISTANCES', ['player']);
  };
  // `world.on('unit:fields')` is the SAME edge `unit-bridge.ts:390` already listens on, so nothing new
  // walks the world and a stat change and a health change arrive through one path.
  world.on('unit:fields', onFields);
  // Once at attach: the player's create block arrived while the manifest was still loading, which is
  // the reasoning `unit-bridge.ts:398-400` records for its own first push.
  fireEvent(vm, 'UNIT_STATS', ['player']);
  fireEvent(vm, 'UNIT_RESISTANCES', ['player']);

  return () => {
    world.removeListener('unit:fields', onFields);
  };
}
