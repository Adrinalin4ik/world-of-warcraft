/**
 * The unit descriptor fields, read off an `SMSG_UPDATE_OBJECT` values block and kept on the `Unit`.
 *
 * WHY THIS FILE EXISTS. `update-object/handler.ts` decoded the whole values block and then read
 * exactly two entries out of it -- `object_field_scale_x` and `unit_field_displayid`. Everything
 * else was parsed, keyed and dropped on the floor, and nothing else in the client consumed a unit
 * field at all. That single gap is why `PlayerFrame` drew with no name, level or portrait, why there
 * were no target resources, and why nothing ever died: death is a descriptor state, not a packet.
 *
 * ## The indices are 3.3.5a's, and benilla is NOT the authority on them
 *
 * `samples/benilla/` is this project's reference and `CLAUDE.md` makes it the authority where it and
 * our code disagree -- but its `benilla-protocol` targets **vmangos, i.e. 1.12**, and the descriptor
 * arrays were renumbered between 1.12 and 3.3.5a. Its own constants say so:
 * `crates/benilla-protocol/src/messages/update_object/fields/mod.rs:50-58` has
 * `FIELD_UNIT_HEALTH = 22`, `FIELD_UNIT_MAXHEALTH = 28`, `FIELD_UNIT_LEVEL = 34`,
 * `FIELD_UNIT_BYTES_0 = 36`, against this build's 24 / 32 / 54 / 23 (`object/enums.ts#UnitField`).
 * So the OFFSETS here come from our own `UnitField` table and were checked against the live wire
 * (see `unitFieldTrace`); what is taken from benilla is the SHAPE of the derivations, which did not
 * change between expansions:
 *
 *  - the power type is `UNIT_FIELD_BYTES_0`'s high byte (`>>> 24`);
 *  - "dead" is `maxHealth > 0 && health == 0`, NOT a flag bit --
 *    `crates/benilla-protocol/src/messages/update_object/fields/unit.rs:73-75`
 *    (`unit_is_dead`), which is also what `driver.rs:483-486` drives the death play from.
 *    THIS CORRECTS THE BRIEF for this round, which said to find "the dynamic/unit flags that carry
 *    the dead state". `UNIT_DYNAMIC_FLAGS` (0x0049) carries lootable/tapped/track bits and
 *    `UNIT_FIELD_FLAGS` (0x0035) carries `UNIT_FLAG_SKINNABLE` and the rest; neither is the client's
 *    liveness test and neither is set on a creature the instant it dies. Health is. Both flag words
 *    are still read and kept, because the tap/lootable gaps in `lua/api/units.ts` name them.
 *
 * ## Partial updates are the normal case
 *
 * A values-only update carries ONLY the fields that changed -- a wolf losing health sends
 * `unit_field_health` and nothing else. So every reader here is "present or leave alone", never
 * "present or zero": defaulting an absent field to 0 would blank the level and max-health of every
 * unit on every damage tick.
 */
import type Unit from '../../../../game/classes/unit';
import { ObjectType, PlayerField, UnitField } from '../enums';
import { mergeCharacterStats } from './character-stats';
import { mergePlayerSkills } from './player-skills';

/** What one values block said about a unit. Every field optional -- see the header. */
export interface UnitFieldUpdate {
  level?: number;
  health?: number;
  maxHealth?: number;
  powerType?: number;
  /** `UNIT_FIELD_BYTES_0` byte 2 -- 0 male, 1 female. Read for a description's `$g<male>:<female>;`. */
  gender?: number;
  /** `UNIT_FIELD_BYTES_0` byte 0 -- the `ChrRaces.dbc` id. What `UnitRace` answers. */
  race?: number;
  /** `UNIT_FIELD_BYTES_0` byte 1 -- the `ChrClasses.dbc` id. What `UnitClass` answers. */
  classId?: number;
  power?: number;
  maxPower?: number;
  factionTemplate?: number;
  unitFlags?: number;
  dynamicFlags?: number;

  /**
   * `UNIT_NPC_FLAGS` (`enums.ts`: `object_end + 0x004c`) -- the SERVICE word the world cursor's
   * classifier ladder switches on.
   *
   * It was in `enums.ts` and read by nothing, which is why the hover cursor's whole service leg was
   * dead code before this round. The BITS are 3.3.5a's and they are NOT the reference's: benilla's
   * table is vmangos 1.12 (`target/cursor_mode.rs:145-163`, VENDOR 0x4, FLIGHTMASTER 0x8, INNKEEPER
   * 0x80) and the enum was renumbered for WotLK, so a 1.12 value here would read a vendor as a
   * flight master. See `game/world/cursor-mode.ts#NPC_FLAG`, which carries the values, states that
   * their only source is a server implementation, and records what they were corroborated against
   * live.
   */
  npcFlags?: number;

  /**
   * `UNIT_FIELD_COMBATREACH` (`enums.ts`: `object_end + 0x003c`) -- a FLOAT on the wire, like
   * `attackPowerMultiplier` and unlike every integer here.
   *
   * The melee interact reach both the SKIN and LOOT cursor legs gray on is
   * `max(reachA + reachB + 1.3333, 5.0)` (`game/world/cursor-mode.ts`), so this is one of its two
   * terms. Read here rather than approximated because the alternative was a function returning 0 with
   * a paragraph explaining itself.
   */
  combatReach?: number;
  /** `OBJECT_FIELD_ENTRY` -- the creature template id `CMSG_CREATURE_QUERY` is asked about. */
  entry?: number;

  /**
   * `PLAYER_XP` (634) and `PLAYER_NEXT_LEVEL_XP` (635) -- the experience bar's two numbers.
   *
   * PLAYER-scope, not unit-scope, so they only ever arrive for our own character; a creature's update
   * never carries them and they stay undefined. Indices come from `enums.ts#PlayerField`
   * (`unit_end + 0x01e6` and `+ 0x01e7`, where `unit_end` is 0x94), which is this build's own table --
   * NOT from the reference, whose player block sits at different offsets entirely.
   */
  xp?: number;
  maxXp?: number;

  /**
   * `PLAYER_REST_STATE_EXPERIENCE` (1169) -- rested experience, a SEPARATE field from `xp`.
   *
   * This is the "how much bonus xp is banked" pool that `GetXPExhaustion()` returns and that
   * `ExhaustionTick_OnEvent` (`MainMenuBar.lua:314`) turns into the second segment on the bar. It is not
   * a fraction and not a level: `exhaustionTickSet = ((playerCurrXP + exhaustionThreshold) / playerMaxXP)
   * * MainMenuExpBar:GetWidth()`, so it is xp-denominated and added to current xp.
   */
  restXp?: number;

  /**
   * `UNIT_FIELD_BYTES_2`'s byte **3** -- the unit's SHAPESHIFT FORM (a `SpellShapeshiftForm.dbc` id).
   *
   * The byte offset is TrinityCore 3.3.5's own (`Unit.h`:
   * `UNIT_BYTES_2_OFFSET_SHEATH_STATE 0`, `_PVP_FLAG 1`, `_PET_FLAGS 2`, `_SHAPESHIFT_FORM 3`, written
   * by `Unit::SetShapeshiftForm`) -- that is a SERVER SOURCE, not a file in this repo, so it is
   * corroborated twice against the live wire rather than trusted: both warriors on the test account read
   * **17** here (and the login burst casts spell 2457 Battle Stance on them), `SpellShapeshiftForm.dbc`
   * gives form 17 `bonusActionBar` **1**, and bonus bar 1 is exactly where their filled action slots are
   * (1-based 73-84). The two non-warriors carry no `bytes_2` form at all and their slots are 1-4.
   *
   * Why a unit frame does not read it but the ACTION BAR does: form decides which 12-slot block of the
   * server's 144 action slots the buttons address (`ActionButton.lua:139-144`), so for a warrior this
   * one byte is the difference between twelve empty buttons and his real bar. See
   * `game/ui/action-bridge.ts`.
   */
  shapeshiftForm?: number;

  /**
   * `UNIT_FIELD_BASE_MANA` (`enums.ts`: `object_end + 0x0072`) -- mana BEFORE gear and buffs.
   *
   * Not decoration and not the same as `maxPower`: `Spell.dbc`'s `ManaCostPercentage` is a percentage of
   * THIS, and it is how most caster spells state their cost (`manaCost` reads 0 for Fireball, Healing
   * Wave and Smite alike). See the read below for why substituting `maxPower` would be wrong.
   */
  baseMana?: number;

  /**
   * THE ATTACK-POWER TRIPLE -- `$AP`'s three inputs, and the reason a spell description could not be
   * evaluated before this round.
   *
   * `UNIT_FIELD_ATTACK_POWER` (`enums.ts`: `object_end + 0x0075`), `..._MODS` (+0x0076) and
   * `..._MULTIPLIER` (+0x0077). Three fields and not one, because the CLIENT'S OWN character sheet
   * says so: `PaperDollFrame_SetAttackPower` (`paperdollframe.lua:657-659`) reads
   * `local base, posBuff, negBuff = UnitAttackPower(unit)` and shows `base+posBuff+negBuff`. So the
   * engine global returns a base plus a signed modifier split into its halves, which is this block --
   * and the multiplier is the third word the same block carries.
   *
   * **THE MULTIPLIER IS A FLOAT ON THE WIRE**, unlike every other field this file reads: see `f32` in
   * `readUnitFields`. Read as a uint it comes back 1065353216 for the value 1.0.
   *
   * `attackPowerMods` is a SIGNED int32 -- a debuff drives it negative -- so it goes through `i32`.
   */
  attackPower?: number;
  attackPowerMods?: number;
  attackPowerMultiplier?: number;

  /** The ranged triple, `$RAP`'s inputs: `+0x0078 / +0x0079 / +0x007a`. Same shape as the melee one. */
  rangedAttackPower?: number;
  rangedAttackPowerMods?: number;
  rangedAttackPowerMultiplier?: number;

  /**
   * `$MWS` -- the MAIN-HAND weapon speed, in MILLISECONDS.
   *
   * `UNIT_FIELD_BASEATTACKTIME` (`object_end + 0x0038`) is the first of two words (main hand, then off
   * hand); only the first is read. **`enums.ts` is this build's own table and NOT benilla's**, which is
   * the mismatch `CLAUDE.md` names by number: the reference's base attack time is at 62/63 counted from
   * its own object block, and taking that index here would read `unit_field_aurastate`.
   */
  baseAttackTimeMs?: number;

  /**
   * `$bh` -- `GetSpellBonusHealing()`, i.e. `PLAYER_FIELD_MOD_HEALING_DONE_POS`
   * (`enums.ts`: `unit_end + 0x0414`).
   *
   * ONE number, not seven: the client's own character sheet reads it with no school argument at all
   * (`PaperDollFrame_SetSpellBonusHealing`, `paperdollframe.lua:975`, `local bonusHealing =
   * GetSpellBonusHealing()`), which is the difference between this field and the seven-word spell-power
   * block beside it. Named by `Spell.dbc` 48165's own legend as `$bh` -- "healing: ${$bh}".
   */
  healingDone?: number;
  /** `player_character_points1` -- talent points. See the read in `readUnitFields`. */
  talentPoints?: number;
}

/**
 * `$SP` -- `GetSpellBonusDamage(school)` for each of the seven spell schools, already netted
 * (positive block minus negative block), returned alongside `UnitFieldUpdate` rather than inside it.
 *
 * SEVEN NUMBERS AND NOT ONE, because a spell's `$SP` is its OWN school's bonus. The client's own
 * character sheet reads the whole block one school at a time and only then reduces it, taking the
 * MINIMUM across schools 2..7 for its single "Bonus Damage" label
 * (`PaperDollFrame_SetSpellBonusDamage`, `paperdollframe.lua:917-928`). That reduction is a display
 * choice for one label; storing only the minimum here would make a Fire spell's `$SP` read the
 * player's WORST school, so the seven are kept and the caller picks by `Spell.dbc`'s `schoolMask`.
 *
 * The index IS the school index -- 0 physical, 1 holy, 2 fire, 3 nature, 4 frost, 5 shadow, 6 arcane --
 * which is the order `PLAYER_FIELD_MOD_DAMAGE_DONE_POS`'s seven consecutive words are in, and which the
 * character sheet corroborates: its loop starts at `holySchool = 2`, a 1-BASED Lua index into the same
 * seven, i.e. holy, skipping physical.
 *
 * Kept OFF `UnitFieldUpdate` deliberately: that interface is scalars run through `applyUnitFields`'
 * change diff, which drives the unit-frame event fan-out. No frame in this client reads spell power, so
 * seven more diffed keys would cost a comparison per packet and announce nothing.
 */
export const SPELL_SCHOOL_COUNT = 7;

/**
 * Ring buffer of what the wire actually delivered, so the layout above is a MEASUREMENT and not a
 * transcription. Read from the console as `window.unitFieldTrace`.
 *
 * This project has shipped a field the server never writes being read anyway, and a run speed that
 * arrived as -2^65. A named field arriving with a plausible-looking number is exactly the failure
 * this buffer exists to catch: level 1-80 and health <= maxHealth are checkable claims.
 */
export interface UnitFieldSample {
  t: number;
  guid: string;
  type: ObjectType;
  create: boolean;
  fields: UnitFieldUpdate;
}

const TRACE_LIMIT = 400;

export const unitFieldTrace: { samples: UnitFieldSample[]; enabled: boolean } = {
  samples: [],
  enabled: true,
};

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).unitFieldTrace = unitFieldTrace;
}

/**
 * `parseUpdateValues`' output -> the fields we keep.
 *
 * `values` is keyed by the name `getUpdateFieldName` gave each index. That helper IGNORED its type
 * argument until this round and answered `item_field_*` for five of the seven fields below; see
 * `enums.ts#getUpdateFieldName` for the table of collisions. Nothing here would have worked before
 * that fix, which is why it had to come first.
 */
export function readUnitFields(values: Record<string, number>): UnitFieldUpdate {
  const out: UnitFieldUpdate = {};
  const u32 = (name: string): number | undefined => {
    const raw = values[name];
    // `parseUpdateValues` reads with `readUnsignedInt`, so a present field is always a finite
    // non-negative number; `undefined` is the only "absent" it can produce.
    return typeof raw === 'number' && Number.isFinite(raw) ? raw >>> 0 : undefined;
  };
  // SIGNED and FLOAT reinterpretations of the same 32 bits. Every field above happens to be a count
  // that cannot go negative; the attack-power MODS can (a debuff) and the MULTIPLIER is an IEEE float,
  // so both need the wire's bits read as something other than a uint. `| 0` is the int32 cast and
  // `SCRATCH` the float one -- no allocation per call, which matters because this runs per packet.
  const i32 = (name: string): number | undefined => {
    const raw = u32(name);
    return raw === undefined ? undefined : raw | 0;
  };
  const f32 = (name: string): number | undefined => {
    const raw = u32(name);
    if (raw === undefined) {
      return undefined;
    }
    SCRATCH_U32[0] = raw;
    return SCRATCH_F32[0];
  };

  out.entry = u32('object_field_entry');
  out.level = u32('unit_field_level');
  out.health = u32('unit_field_health');
  out.maxHealth = u32('unit_field_maxhealth');
  out.factionTemplate = u32('unit_field_factiontemplate');
  out.unitFlags = u32('unit_field_flags');
  out.dynamicFlags = u32('unit_dynamic_flags');
  out.npcFlags = u32('unit_npc_flags');
  out.combatReach = f32('unit_field_combatreach');

  // THE POWER TYPE is the high byte of `UNIT_FIELD_BYTES_0` (`race | class | gender | powerType`),
  // benilla `fields/unit.rs` and this build's own `UnitField` table agree on the packing even though
  // they disagree on the index. It decides WHICH of the seven power slots is the unit's bar, so it
  // is read before them.
  const bytes0 = u32('unit_field_bytes_0');
  if (bytes0 !== undefined) {
    out.powerType = (bytes0 >>> 24) & 0xff;
    // GENDER is byte 2 of the same word -- the packing is `race | class | gender | powerType`, which is
    // benilla's reading of the block (`fields/unit.rs`) and is the same packing the power type above
    // already relies on; only the INDEX of the word is version-specific, and that comes from our own
    // `UnitField` table. Read for `$g<male>:<female>;` in a spell description and nothing else.
    out.gender = (bytes0 >>> 16) & 0xff;
    // RACE is byte 0 and CLASS byte 1 of the SAME word, by the same packing the two reads above
    // already depend on and which this function's own comment four lines up states
    // (`race | class | gender | powerType`) -- so nothing new is being asserted about the layout.
    // They feed `UnitRace`/`UnitClass`, which `PaperDollFrame_SetLevel` (`paperdollframe.lua:203`)
    // calls: with `UnitRace` absent that one line raised and left `CharacterLevelText` showing the
    // placeholder `paperdollframe.xml:279` authors, which is the owner's "Level level race class".
    out.race = bytes0 & 0xff;
    out.classId = (bytes0 >>> 8) & 0xff;
  }

  // THE SHAPESHIFT FORM, byte 3 of `UNIT_FIELD_BYTES_2`. Unit-scope, not player-scope: a creature in a
  // form carries it too. See the field's own comment for the byte offset's source.
  const bytes2 = u32('unit_field_bytes_2');
  if (bytes2 !== undefined) {
    out.shapeshiftForm = (bytes2 >>> 24) & 0xff;
  }

  // The experience pair and the rested pool. Present only on our own character's updates -- these are
  // PLAYER-scope indices, and `getUpdateFieldName` only answers `player_*` names for `ObjectType.Player`
  // (that type argument was ignored until the round that fixed it; see this function's header). So a
  // creature's update leaves all three undefined, which is what keeps `UnitXP("target")` answering 0.
  out.xp = u32('player_xp');
  out.maxXp = u32('player_next_level_xp');
  out.restXp = u32('player_rest_state_experience');

  // BASE MANA, and the reason it is read at all: most caster spells in 3.3.5a store no absolute
  // `manaCost` -- they store `ManaCostPercentage` (`Spell.dbc` column 204, measured: Fireball 8,
  // Healing Wave 13, Smite 9, all with `manaCost` 0) -- and that percentage is of BASE mana, not of
  // maximum mana. Approximating it with `maxPower` would grey a button EARLY by however much mana the
  // character's gear adds, which is exactly the "visible lie" a wrong tint would be. The wire carries
  // the real number, so `IsUsableAction` uses it (`game/ui/framexml/lua/api/actions.ts`).
  out.baseMana = u32('unit_field_base_mana');

  // THE STAT BLOCK a spell DESCRIPTION needs: `$AP`, `$RAP` and `$MWS`. Unit-scope, so a creature
  // carries them too, but only the player's are ever read -- a description is always rendered for the
  // caster. See the fields' own comments for where each index and each shape comes from.
  out.attackPower = i32('unit_field_attack_power');
  out.attackPowerMods = i32('unit_field_attack_power_mods');
  out.attackPowerMultiplier = f32('unit_field_attack_power_multiplier');
  out.rangedAttackPower = i32('unit_field_ranged_attack_power');
  out.rangedAttackPowerMods = i32('unit_field_ranged_attack_power_mods');
  out.rangedAttackPowerMultiplier = f32('unit_field_ranged_attack_power_multiplier');
  out.baseAttackTimeMs = u32('unit_field_baseattacktime');
  out.healingDone = i32('player_field_mod_healing_done_pos');
  // TALENT POINTS -- `player_character_points1` (`enums.ts:441`), which is what
  // `UnitCharacterPoints("player")` answers and `SkillFrame_UpdateSkills` destructures
  // (`skillframe.lua:436`). A scalar, so it belongs in `fields` rather than beside them.
  out.talentPoints = u32('player_character_points1');

  return out;
}

/** See `f32` in `readUnitFields`: one buffer, reused, for reinterpreting a wire word as an IEEE float. */
const SCRATCH_U32 = new Uint32Array(1);
const SCRATCH_F32 = new Float32Array(SCRATCH_U32.buffer);

/**
 * `GetSpellBonusDamage(school)` for all seven schools -- see `SPELL_SCHOOL_COUNT`.
 *
 * Returns null when the positive block is absent, which is the normal case: these are PLAYER-scope
 * fields, so every creature's update leaves them undefined, and a values-only update that did not touch
 * spell power leaves them undefined too. Null means "leave whatever we knew alone".
 *
 * Only the FIRST word of each seven-word block is named in `PlayerField`
 * (`player_field_mod_damage_done_pos` / `_neg`); schools 1..6 are the next six indices and are read by
 * NUMBER, which is the same idiom `applyUnitFields` already uses for the off-hand virtual item slot.
 */
export function readSpellDamage(values: Record<string, number>): number[] | null {
  const posBase = values['player_field_mod_damage_done_pos'];
  if (typeof posBase !== 'number') {
    return null;
  }
  const out: number[] = [];
  for (let school = 0; school < SPELL_SCHOOL_COUNT; school += 1) {
    const pos = school === 0
      ? posBase
      : values[String(PlayerField.player_field_mod_damage_done_pos + school)];
    const neg = school === 0
      ? values['player_field_mod_damage_done_neg']
      : values[String(PlayerField.player_field_mod_damage_done_neg + school)];
    // `GetSpellBonusDamage` is the NET of the two blocks. An absent word is 0 rather than "leave
    // alone": the whole array is rewritten together or not at all (the null above), so a partial
    // block genuinely means those schools carry no modifier.
    out.push(((typeof pos === 'number' ? pos : 0) | 0) - ((typeof neg === 'number' ? neg : 0) | 0));
  }
  return out;
}

/**
 * The power/maxpower pair for a power type, read from the seven-slot arrays.
 *
 * Separate from `readUnitFields` because it needs the type, which may have arrived in an EARLIER
 * packet: a values-only update that carries `unit_field_power1` alone does not repeat `bytes_0`, and
 * indexing the array with a type we forgot would read the wrong bar. The unit's remembered type is
 * therefore the fallback.
 *
 * `powerType` indexes the array DIRECTLY -- power slot 0 is `unit_field_power1`, which is mana for
 * type 0 and rage for type 1. It is not an off-by-one: the field names are 1-based and the type is
 * 0-based, and `POWER_MANA = 0` reads `power1`.
 */
export function readPower(
  values: Record<string, number>,
  powerType: number,
): { power?: number; maxPower?: number } {
  if (!Number.isInteger(powerType) || powerType < 0 || powerType > 6) {
    // Seven slots, `unit_field_power1..7`. Anything else is a type this build has no bar for
    // (vehicle/alternate power arrived later), and reading slot 8 would run off the end of the unit
    // block into `unit_field_power_regen_flat_modifier`.
    return {};
  }
  const slot = powerType + 1;
  const power = values[`unit_field_power${slot}`];
  const maxPower = values[`unit_field_maxpower${slot}`];
  return {
    power: typeof power === 'number' ? power >>> 0 : undefined,
    maxPower: typeof maxPower === 'number' ? maxPower >>> 0 : undefined,
  };
}

/**
 * Write a values block onto the unit, and answer whether anything a unit frame reads changed.
 *
 * THE RETURN VALUE IS THE POINT, and it is the whole of this round's performance story. The in-world
 * UI renders to an offscreen target that is only redrawn when a fingerprint of the draw list changes
 * (`game/ui/world-ui.ts`). A bridge that pushed a snapshot and fired `UNIT_HEALTH` on every values
 * packet would re-run `UnitFrameHealthBar_Update`, rewrite the bar's text, change the fingerprint,
 * and re-expand `ui.draw` from 0.5 ms to ~9 ms -- for a health value that did not move. So the
 * caller only announces a change this function reports.
 */
export function applyUnitFields(
  unit: Unit,
  values: Record<string, number>,
  type: ObjectType,
  create: boolean,
): boolean {
  const fields = readUnitFields(values);

  let changed = false;
  const set = <K extends keyof UnitFieldUpdate>(key: K, value: number | undefined): void => {
    if (value === undefined) {
      return;
    }
    if (unit.fields[key] !== value) {
      unit.fields[key] = value;
      changed = true;
    }
  };

  set('entry', fields.entry);
  set('level', fields.level);
  set('health', fields.health);
  set('maxHealth', fields.maxHealth);
  set('factionTemplate', fields.factionTemplate);
  set('unitFlags', fields.unitFlags);
  set('dynamicFlags', fields.dynamicFlags);
  set('npcFlags', fields.npcFlags);
  set('combatReach', fields.combatReach);
  set('powerType', fields.powerType);
  set('gender', fields.gender);
  set('race', fields.race);
  set('classId', fields.classId);

  // The experience pair and the rested pool. Only our own character's updates carry them (see
  // `readUnitFields`), and `changed` is what gates the event that repaints the bar -- so an xp value
  // that has not moved costs nothing, which matters because the bar's repaint dirties the draw-list
  // fingerprint (`world-ui.ts#drawListSignature`).
  set('shapeshiftForm', fields.shapeshiftForm);
  set('xp', fields.xp);
  set('maxXp', fields.maxXp);
  set('restXp', fields.restXp);
  set('baseMana', fields.baseMana);

  // THE STAT BLOCK. It goes through `set` like everything else, so a stat that moved does announce --
  // no frame listens today, but the alternative (writing behind the diff) would make the first frame
  // that does silently stale.
  set('attackPower', fields.attackPower);
  set('attackPowerMods', fields.attackPowerMods);
  set('attackPowerMultiplier', fields.attackPowerMultiplier);
  set('rangedAttackPower', fields.rangedAttackPower);
  set('rangedAttackPowerMods', fields.rangedAttackPowerMods);
  set('rangedAttackPowerMultiplier', fields.rangedAttackPowerMultiplier);
  set('baseAttackTimeMs', fields.baseAttackTimeMs);
  set('healingDone', fields.healingDone);
  set('talentPoints', fields.talentPoints);

  // THE CHARACTER SHEET'S STAT BLOCK -- stats, resistances, the damage range, the percentages, the 25
  // combat ratings. Merged rather than replaced, because an update mask is sparse and one point of
  // agility moves one word; see `character-stats.ts` on why that differs from `readSpellDamage` below.
  // `values` is the same map this function was handed and otherwise discards.
  mergeCharacterStats(unit.characterStats, values, type);
  // THE SKILLS BLOCK -- 128 triples, merged per slot for the same sparse-mask reason. Player-scope, so
  // `mergePlayerSkills` returns immediately for a creature. See `player-skills.ts`.
  mergePlayerSkills(unit.skills, values, type);

  // SPELL POWER is seven numbers and lives beside `fields`, not in it -- see `SPELL_SCHOOL_COUNT`.
  const spellDamage = readSpellDamage(values);
  if (spellDamage !== null) {
    unit.spellDamage = spellDamage;
  } else if (create && type === ObjectType.Player && unit.spellDamage.length === 0) {
    // ON A CREATE BLOCK, ABSENT MEANS ZERO -- and that distinction is why this branch exists.
    //
    // An update mask is sparse: the server writes only the fields it has a non-zero value for, so a
    // character with no spell power at all never sends the seven words. Measured live as a level-2
    // character: `attackPower` arrived (24) and the whole `player_field_mod_damage_done_pos` block did
    // not, so `spellDamage` stayed `[]` and 94 spells' `$SPH` stayed a visible token -- when the true
    // answer is 0.
    //
    // Gated on all three of `create`, PLAYER scope and "we have never had a value", so it can only ever
    // fill in the initial state and can never overwrite a real reading with zeroes: a later values-only
    // packet that omits the block still means "unchanged" and takes the null path above. A creature is
    // excluded because these are player-scope indices it would never carry anyway.
    unit.spellDamage = new Array<number>(SPELL_SCHOOL_COUNT).fill(0);
  }

  // AFTER the power type is settled, using whatever the unit now knows -- see `readPower`.
  const power = readPower(values, unit.fields.powerType ?? 0);
  set('power', power.power);
  set('maxPower', power.maxPower);

  // THE EQUIPPED WEAPONS, whose only consumer is the swing-clip pick (`game/classes/combat-anim.ts`).
  // Two different fields because a creature and a player carry the same fact in different places:
  // `UNIT_VIRTUAL_ITEM_SLOT_ID` (+0x0032, main/off/ranged) for a creature or NPC, and
  // `PLAYER_VISIBLE_ITEM_16/17_ENTRYID` for a player -- slot 16 is `EQUIPMENT_SLOT_MAINHAND`
  // one-based. Both hold ITEM ENTRY ids on 3.3.5a. Not part of `fields`: nothing announces on a
  // weapon swap and folding them in would dirty the unit-frame fingerprint for a fact no frame reads.
  //
  // `unit_virtual_item_slot_id` names only the FIRST of its three words in `UnitField`; the offhand
  // is the next index up, read by number for that reason.
  const virtualMain = values['unit_virtual_item_slot_id'];
  const virtualOff = values[String(UnitField.unit_virtual_item_slot_id + 1)];
  const playerMain = values['player_visible_item_16_entryid'];
  const playerOff = values['player_visible_item_17_entryid'];
  if (typeof playerMain === 'number') unit.equippedMainhand = playerMain >>> 0;
  else if (typeof virtualMain === 'number') unit.equippedMainhand = virtualMain >>> 0;
  if (typeof playerOff === 'number') unit.equippedOffhand = playerOff >>> 0;
  else if (typeof virtualOff === 'number') unit.equippedOffhand = virtualOff >>> 0;

  if (unitFieldTrace.enabled && unitFieldTrace.samples.length < TRACE_LIMIT) {
    unitFieldTrace.samples.push({
      t: performance.now(),
      guid: unit.guid,
      type,
      create,
      fields: { ...fields, ...power },
    });
  }

  // Kept in sync with the legacy scalars `Unit` has carried (and nothing wrote) since it was
  // written, so a reader of either sees the same number rather than two truths.
  if (unit.fields.level !== undefined) unit.level = unit.fields.level;
  if (unit.fields.health !== undefined) unit.health = unit.fields.health;
  if (unit.fields.power !== undefined) unit.mana = unit.fields.power;

  return changed;
}

/**
 * The client's own liveness test: a real max health and none left.
 *
 * benilla `crates/benilla-protocol/src/messages/update_object/fields/unit.rs:73-75` verbatim. The
 * `maxHealth > 0` half is not decoration -- a create block for a unit whose health fields have not
 * arrived reads 0/0, and calling that dead would play a death animation on every unit at first
 * sight.
 */
export function isDead(unit: Unit): boolean {
  return (unit.fields.maxHealth ?? 0) > 0 && (unit.fields.health ?? 0) === 0;
}
