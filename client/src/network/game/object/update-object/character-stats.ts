/**
 * THE CHARACTER SHEET'S NUMBERS, read off the player descriptor.
 *
 * The owner: "I don't see character stats under the preview". Two things were missing and this file is
 * the DATA half -- `game/ui/paperdoll-stats.ts` is the globals half. The other half was a CVar seeding
 * bug (`api/screen.ts`'s `playerStatLeftDropdown`).
 *
 * Every word here is already on the wire and already named in `enums.ts`; none of it was being read.
 * `unit-fields.ts#readUnitFields` deliberately keeps a NAMED SUBSET -- eight fields plus the spell-power
 * array -- and the raw `values` map it is handed is discarded, so the stat block was reachable and
 * unstructured. This is the same shape as `readSpellDamage` beside it: a block that lives next to
 * `unit.fields` rather than in it, because it is arrays rather than scalars.
 *
 * ## MERGED, not all-or-nothing, and that is the difference from `readSpellDamage`
 *
 * An update mask is sparse. `readSpellDamage` can be all-or-nothing because its seven words are written
 * together or not at all; the stat block is not -- a single point of agility spent moves
 * `unit_field_stat1` and nothing else, and one buff moves `posstat` alone. So every field here is
 * merged individually onto what was already known, and a field the packet does not carry means
 * "unchanged" rather than zero. Getting that backwards would blank the whole sheet on the first
 * values-only packet after login.
 *
 * ## The wire types are NOT all integers
 *
 * `MINDAMAGE`/`MAXDAMAGE`, the crit and dodge/parry/block percentages and the ranged damage pair are
 * IEEE floats in the descriptor; the stats, resistances, expertise and combat ratings are integers.
 * Reading a float word as an integer gives a number in the hundreds of millions, which is the most
 * visible class of bug this file can have -- so each read below names which it is.
 */
import { ObjectType, PlayerField, UnitField, getUpdateFieldName } from '../enums';

/** `MAX_STATS` -- strength, agility, stamina, intellect, spirit, in `UnitStat`'s own index order. */
export const STAT_COUNT = 5;

/**
 * `MAX_SPELL_SCHOOL` -- armour, holy, fire, nature, frost, shadow, arcane.
 *
 * **Index 0 IS ARMOUR**, which is not an oddity of this client: the descriptor's resistance array
 * begins at `unit_field_resistances_armor` (`enums.ts:207`) and the game's own `UnitResistance(unit, 0)`
 * answers armour for the same reason. `PaperDollFrame_SetResistances` walks 1..6 and `UnitArmor` reads
 * slot 0 (`paperdollframe.lua:366-430`).
 */
export const RESISTANCE_COUNT = 7;

/**
 * 25 -- `player_field_combat_rating_1` (`unit_end + 0x043b`) to the next named field
 * `player_field_arena_team_info_1_1` (`+ 0x0454`) is 0x19 words. Derived from the table rather than
 * transcribed, the same way `container-bridge.ts` derives its slot counts.
 */
export const COMBAT_RATING_COUNT = PlayerField.player_field_arena_team_info_1_1
  - PlayerField.player_field_combat_rating_1;

/** Everything the two stat panes and the resistance row read. Every member is optional -- see the header. */
export interface CharacterStats {
  /** Effective stat, i.e. what the sheet's big number shows. */
  stats: number[];
  /** The positive buff component, for the sheet's green `(+n)`. */
  statsPos: number[];
  /** The negative buff component, reported as a POSITIVE magnitude, which is what the wire carries. */
  statsNeg: number[];
  /** Index 0 is armour -- see `RESISTANCE_COUNT`. */
  resistances: number[];
  resistPos: number[];
  resistNeg: number[];
  /** Main-hand damage range. FLOATS on the wire. */
  minDamage: number;
  maxDamage: number;
  minOffhandDamage: number;
  maxOffhandDamage: number;
  minRangedDamage: number;
  maxRangedDamage: number;
  /** Percentages, 0..100. FLOATS on the wire. */
  blockPercent: number;
  dodgePercent: number;
  parryPercent: number;
  critPercent: number;
  rangedCritPercent: number;
  offhandCritPercent: number;
  /** Per-school spell crit, 0..100. FLOATS. */
  spellCritPercent: number[];
  /** Integers: raw expertise, which the sheet converts to a percentage itself. */
  expertise: number;
  offhandExpertise: number;
  /** The shield's block VALUE (damage absorbed), an integer -- not `blockPercent`. */
  shieldBlock: number;
  /** `GetCombatRating(i)`'s array, 1-based in Lua and 0-based here. Integers. */
  combatRatings: number[];
}

export function emptyCharacterStats(): CharacterStats {
  return {
    stats: new Array<number>(STAT_COUNT).fill(0),
    statsPos: new Array<number>(STAT_COUNT).fill(0),
    statsNeg: new Array<number>(STAT_COUNT).fill(0),
    resistances: new Array<number>(RESISTANCE_COUNT).fill(0),
    resistPos: new Array<number>(RESISTANCE_COUNT).fill(0),
    resistNeg: new Array<number>(RESISTANCE_COUNT).fill(0),
    minDamage: 0,
    maxDamage: 0,
    minOffhandDamage: 0,
    maxOffhandDamage: 0,
    minRangedDamage: 0,
    maxRangedDamage: 0,
    blockPercent: 0,
    dodgePercent: 0,
    parryPercent: 0,
    critPercent: 0,
    rangedCritPercent: 0,
    offhandCritPercent: 0,
    spellCritPercent: new Array<number>(RESISTANCE_COUNT).fill(0),
    expertise: 0,
    offhandExpertise: 0,
    shieldBlock: 0,
    combatRatings: new Array<number>(COMBAT_RATING_COUNT).fill(0),
  };
}

/** One buffer, reused, for reinterpreting a wire word as an IEEE float -- as `unit-fields.ts` does. */
const SCRATCH_U32 = new Uint32Array(1);
const SCRATCH_F32 = new Float32Array(SCRATCH_U32.buffer);

/**
 * Merge whatever this packet carried onto what was already known.
 *
 * `type` matters: `getUpdateFieldName` only answers `player_*` names for `ObjectType.Player`
 * (`enums.ts`), so a creature's update contributes only the unit-scope half -- which is correct, and is
 * the same reason `readUnitFields` passes the type through.
 *
 * Returns the SAME object it was given, mutated. The caller owns it (it hangs off the `Unit`), and a
 * fresh object per packet would make "unchanged means keep" impossible to express.
 */
export function mergeCharacterStats(
  into: CharacterStats,
  values: Record<string, number>,
  type: ObjectType,
): CharacterStats {
  /**
   * One descriptor word by INDEX, or undefined.
   *
   * By index rather than by name because most of these blocks name only their first entry -- the same
   * field-name trap `ui/container-bridge.ts`' header documents. `getUpdateFieldName` answers the NAME
   * for a modelled index and the bare number for anything else, which is exactly what `values` is
   * keyed on, so asking it per index is correct for both cases.
   */
  const at = (index: number): number | undefined => {
    const raw = values[getUpdateFieldName(index, type)];
    return typeof raw === 'number' ? raw : undefined;
  };
  const int = (index: number, write: (value: number) => void): void => {
    const raw = at(index);
    if (raw !== undefined) {
      write(raw | 0);
    }
  };
  const float = (index: number, write: (value: number) => void): void => {
    const raw = at(index);
    if (raw !== undefined) {
      SCRATCH_U32[0] = raw >>> 0;
      write(SCRATCH_F32[0]);
    }
  };

  for (let i = 0; i < STAT_COUNT; i += 1) {
    int(UnitField.unit_field_stat0 + i, (v) => { into.stats[i] = v; });
    int(UnitField.unit_field_posstat0 + i, (v) => { into.statsPos[i] = v; });
    int(UnitField.unit_field_negstat0 + i, (v) => { into.statsNeg[i] = v; });
  }
  for (let i = 0; i < RESISTANCE_COUNT; i += 1) {
    int(UnitField.unit_field_resistances_armor + i, (v) => { into.resistances[i] = v; });
    int(UnitField.unit_field_resistancebuffmodspositive_armor + i,
      (v) => { into.resistPos[i] = v; });
    int(UnitField.unit_field_resistancebuffmodsnegative_armor + i,
      (v) => { into.resistNeg[i] = v; });
  }

  float(UnitField.unit_field_mindamage, (v) => { into.minDamage = v; });
  float(UnitField.unit_field_maxdamage, (v) => { into.maxDamage = v; });
  float(UnitField.unit_field_minoffhanddamage, (v) => { into.minOffhandDamage = v; });
  float(UnitField.unit_field_maxoffhanddamage, (v) => { into.maxOffhandDamage = v; });
  float(UnitField.unit_field_minrangeddamage, (v) => { into.minRangedDamage = v; });
  float(UnitField.unit_field_maxrangeddamage, (v) => { into.maxRangedDamage = v; });

  if (type !== ObjectType.Player) {
    return into;
  }

  float(PlayerField.player_block_percentage, (v) => { into.blockPercent = v; });
  float(PlayerField.player_dodge_percentage, (v) => { into.dodgePercent = v; });
  float(PlayerField.player_parry_percentage, (v) => { into.parryPercent = v; });
  float(PlayerField.player_crit_percentage, (v) => { into.critPercent = v; });
  float(PlayerField.player_ranged_crit_percentage, (v) => { into.rangedCritPercent = v; });
  float(PlayerField.player_offhand_crit_percentage, (v) => { into.offhandCritPercent = v; });
  for (let school = 0; school < RESISTANCE_COUNT; school += 1) {
    float(PlayerField.player_spell_crit_percentage1 + school,
      (v) => { into.spellCritPercent[school] = v; });
  }
  int(PlayerField.player_expertise, (v) => { into.expertise = v; });
  int(PlayerField.player_offhand_expertise, (v) => { into.offhandExpertise = v; });
  int(PlayerField.player_shield_block, (v) => { into.shieldBlock = v; });
  for (let rating = 0; rating < COMBAT_RATING_COUNT; rating += 1) {
    int(PlayerField.player_field_combat_rating_1 + rating,
      (v) => { into.combatRatings[rating] = v; });
  }
  return into;
}
