import type Unit from './unit';
import { SpellRow } from '../pipeline/dbc/spell-data';
import { canAttackUnit } from '../world/scan';
import { reactionFor, REACTION_FRIENDLY } from '../world/faction';

/**
 * **WHAT GOES IN `CMSG_CAST_SPELL`'s TARGET BLOCK -- and why a heal with an enemy selected must
 * land on YOU.**
 *
 * The owner: "не могу кастовать дружественные заклинания, типа хил, пока в таргете противник, а
 * должен мочь и такие эффекты должны автоматически применяться на меня." He is right, and the rule
 * is the CLIENT'S: nothing on the wire asks the server to fall back, the client picks the target
 * before it sends.
 *
 * This client sent the current selection whenever there WAS one, for every spell. So with a wolf
 * selected, a heal went out aimed at the wolf and a self-buff went out aimed at the wolf, and both
 * came back refused.
 *
 * ## The mechanism, transcribed rather than invented
 *
 * A port of `samples/benilla/crates/benilla-app/src/ui_action/cast_target.rs#resolve_cast_target`,
 * which transcribes `Spell_C::ArmCast 0x6e5250` + `BindTarget 0x6e5b40` (both byte-verified there).
 * Three steps:
 *
 *  1. **Seed a flag word** from `Spell.dbc`'s `Targets` column, then apply ONE overlay arm keyed on
 *     `EffectImplicitTargetA[0]` (`cast_target.rs:224-246`).
 *  2. **A word of ZERO needs no target at all**: ship `TARGET_FLAG_SELF` and NO guid, and let the
 *     server resolve the spell's own implicit targeting. The reference is emphatic about this and
 *     names the exact defect: "The real client **never** ships the current selection for these --
 *     doing so is exactly the 'Invalid target' bug this fixes" (`cast_target.rs:9-12`).
 *  3. **Otherwise a target is required**: each bit is satisfied against a candidate by its own
 *     relation, and only a fully-cleared word commits. Candidate 1 is the current selection;
 *     candidate 2 is **the player himself**, behind `autoSelfCast`. That second candidate is the
 *     whole of "buffing with an enemy targeted casts on yourself".
 *
 * ## THE DATA SAYS THE FRIENDLY/HOSTILE QUESTION IS NOT IN `Targets` AT ALL
 *
 * This is the part that would have been wrong if guessed, and it is why "helpful" is NOT read off
 * some helpful bit. Measured over all 49839 rows of the served `dbfilesclient/spell.dbc`:
 *
 *     spell                          Targets   EffectImplicitTargetA[0]
 *     Frost Armor 168, Ice Armor 7302, Mage Armor 6117,
 *     Molten Armor 30482, Mana Shield 1463, Ice Barrier 11426
 *                                    0x0000    1     -- self only
 *     Lesser Heal 2050, Heal 2054, Greater Heal 2060, Holy Light 635,
 *     Rejuvenation 774, Regrowth 8936, Power Word: Shield 17,
 *     Arcane Intellect 1459, Mark of the Wild 1126
 *                                    0x0000    21    -- friendly unit
 *     Healing Wave 331/332           0x0000    45    -- friendly unit (the arm's other half)
 *     Fireball 133, Frostbolt 116, Smite 585, Lightning Bolt 403,
 *     Immolate 348, Corruption 172   0x0000    6     -- enemy unit
 *     Flamestrike 2120, Blizzard 10  0x0040    16/28 -- the ground cursor
 *     Opening 3365, Mining 2575, Herb Gathering 2366
 *                                    0x4000    23    -- the LOCKED family
 *
 * **`Targets` is 0 for a heal, a nuke AND a self-buff alike** -- 46744 of the 49839 rows read 0. So
 * a reader that used only that column could not tell a heal from a Fireball, and one that inferred
 * helpfulness from the effect type would be inventing a rule the client does not use. The
 * discriminator is the implicit-target arm, and every arm the reference names for 1.12 lands on
 * exactly the right family here on 3.3.5a -- six arms, six families, no misses. That agreement is
 * the evidence that the enum did not shift between the builds; see `COL.implicitTargetA0` in
 * `pipeline/dbc/spell-data.ts` for both columns' index measurements.
 *
 * ## What "assistable" means here, and a DELIBERATE divergence from the reference
 *
 * The reference approximates assist as `reaction >= 4` and says so as a stand-in
 * (`cast_target.rs:253-254`). **This client uses `>= REACTION_FRIENDLY` (5) instead, and that is a
 * decision, not an oversight.** This codebase has already settled where neutral sits, in the engine
 * globals the client's own Lua reads: `UnitIsFriend` is `reaction > 4` and `UnitCanAttack` is
 * `reaction <= 4`, "so the two are exhaustive and a neutral unit is attackable and not friendly"
 * (`ui/framexml/lua/api/units.ts:581-602`). Reusing that boundary is what keeps the cast's idea of
 * friendly identical to the one every FrameXML predicate sees; taking the reference's 4 would make
 * a neutral wolf simultaneously attackable and healable, and would disagree with our own
 * `UnitIsFriend` on exactly the units where it matters.
 *
 * ## The targeting CURSOR is not built, and it is refused rather than faked
 *
 * A word carrying a location, item, gameobject or locked bit needs the click-to-target mode
 * (`SpellIsTargeting 0x6e48a0`). The reference does not model it either and refuses locally with
 * the client's own two strings as an INTERIM (`cast_target.rs:19-22`); this does the same. So
 * Flamestrike, Blizzard, Mining and Opening are REFUSED with a red line rather than sent at a
 * target they were never aimed at -- which is what happens today. Named, counted, never silent.
 */

/**
 * `TARGET_FLAG_*` bits of the targeting word, from the reference's byte-verified table
 * (`cast_target.rs:44-52`). Only the bits this resolver consumes are named.
 */
const TF_UNIT = 0x0002;
const TF_UNIT_RAID = 0x0004;
const TF_UNIT_PARTY = 0x0008;
const TF_ITEM = 0x0010;
const TF_SOURCE_LOCATION = 0x0020;
const TF_DEST_LOCATION = 0x0040;
const TF_UNIT_ENEMY = 0x0080;
const TF_UNIT_ASSIST = 0x0100;
const TF_CORPSE_ENEMY = 0x0200;
const TF_EXPLICIT_GATE = 0x0400;
const TF_GAMEOBJECT = 0x0800;
const TF_LOCKED = 0x4000;
const TF_CORPSE_ALLY = 0x8000;

/** The unit-shaped bits a selected unit (alive or dead) can satisfy -- `cast_target.rs:53-61`. */
const UNIT_BITS = TF_UNIT | TF_UNIT_RAID | TF_UNIT_PARTY | TF_UNIT_ENEMY | TF_UNIT_ASSIST
  | TF_CORPSE_ENEMY | TF_EXPLICIT_GATE | TF_CORPSE_ALLY;

/** The bits that mean "a click has to pick this" -- the unmodelled targeting-cursor family. */
const CURSOR_BITS = TF_ITEM | TF_SOURCE_LOCATION | TF_DEST_LOCATION | TF_GAMEOBJECT | TF_LOCKED;

/**
 * The two `GlobalStrings.lua` names this refuses with, and **both are verified against the served
 * file** rather than remembered: `interface/framexml/globalstrings.lua:6948-6949` reads
 *
 *     SPELL_FAILED_BAD_IMPLICIT_TARGETS = "No target";
 *     SPELL_FAILED_BAD_TARGETS = "Invalid target";
 *
 * which are the reference's `ERR_NO_TARGET` 0x09 and `ERR_INVALID_TARGET` 0x0A
 * (`cast_target.rs:63-66`). The same fetch shows `SPELL_FAILED_SPELL_IN_PROGRESS` at line **7160**,
 * exactly where `ui/cast-refusal.ts` already cites it -- so this is the same file that module was
 * written against.
 *
 * Read through `vm.getGlobal` and never spelled in English at the call site: the owner plays a ruRU
 * client, which is the rule `ui/cast-refusal.ts` states and the reason it exists.
 */
export const ERR_NO_TARGET = 'SPELL_FAILED_BAD_IMPLICIT_TARGETS';
export const ERR_INVALID_TARGET = 'SPELL_FAILED_BAD_TARGETS';

/** What the wire's target block should carry. */
export type CastWireTarget =
  /** Word 0 -- mask `TARGET_FLAG_SELF` (0) and NO guid; the server resolves implicitly. */
  | { kind: 'self-implicit' }
  /** A bound unit -- mask `TARGET_FLAG_UNIT` (0x2) plus this guid, possibly our own. */
  | { kind: 'unit'; guid: string }
  /** Nothing bindable: do NOT send. `error` is a `GlobalStrings.lua` name, never a sentence. */
  | { kind: 'refused'; error: string; word: number };

/** The relation inputs the bit checks read. Both are `Unit`s so the existing helpers apply. */
export interface CastTargetRelations {
  target: Unit | null;
  self: Unit | null;
}

/**
 * The flag-word seed plus the implicit-target overlay -- the reference's `cast_target_mask`
 * (`cast_target.rs:222-247`), arm for arm. Every arm's value is the reference's; every arm was
 * checked to land on the right spell family on THIS build (see the module header's table).
 */
export function castTargetWord(row: SpellRow): number {
  let word = row.targets & 0xffff;
  switch (row.implicitTargetA0) {
    case 1: word &= ~TF_EXPLICIT_GATE; break;
    case 5: word &= ~TF_CORPSE_ALLY; break;
    case 6: case 53: word |= TF_UNIT_ENEMY; break;
    // Arm 16 is the ground arm. The reference sets a cursor-mode flag rather than a word bit and
    // ORs the DEST bit so a word-only reader agrees with it; shipped data carries `Targets & 0x40`
    // on these rows anyway (Flamestrike 2120 reads 0x40 here), so the OR only keeps the two
    // agreeing if one ever does not.
    case 16: word |= TF_DEST_LOCATION; break;
    case 21: case 45: word |= TF_UNIT_ASSIST; break;
    case 23: word |= TF_GAMEOBJECT; break;
    case 25: case 63: word |= TF_UNIT; break;
    case 26: word |= TF_LOCKED; break;
    case 35: word |= TF_UNIT_PARTY; break;
    case 57: case 61: word |= TF_UNIT_RAID; break;
    default: break;
  }
  return word & 0xffff;
}

/**
 * Clear every bit this candidate satisfies -- the reference's `clear_satisfied_bits`
 * (`cast_target.rs:255-300`), using this client's own relation helpers so the cast agrees with the
 * selection ring, the attack cursor and `UnitIsFriend`.
 */
function clearSatisfiedBits(
  word: number,
  isSelf: boolean,
  rel: CastTargetRelations,
): number {
  let left = word;
  const reaction = rel.target === null ? null : reactionFor(rel.target, rel.self);
  // See the module header for why this is `>= REACTION_FRIENDLY` and not the reference's `>= 4`.
  const assist = isSelf || (reaction !== null && reaction >= REACTION_FRIENDLY);
  const dead = rel.target !== null && rel.target.health === 0;

  // Party and raid accept only the player himself until real group membership is read here; the
  // reference's own stand-in, and the same shortfall (`cast_target.rs:252-254`).
  if ((left & TF_UNIT_PARTY) !== 0 && isSelf) left &= ~TF_UNIT_PARTY;
  if ((left & TF_UNIT_RAID) !== 0 && isSelf) left &= ~TF_UNIT_RAID;
  if ((left & TF_UNIT_ASSIST) !== 0 && assist) left &= ~TF_UNIT_ASSIST;
  if ((left & TF_UNIT_ENEMY) !== 0 && !isSelf
    && rel.target !== null && canAttackUnit(rel.target, rel.self)) {
    left &= ~TF_UNIT_ENEMY;
  }
  // Generic UNIT is the binder's unit-flag leg with no relation at all: any resolved unit binds.
  if ((left & TF_UNIT) !== 0) left &= ~TF_UNIT;
  // The explicit-selection gate carries no guid of its own; a real explicit candidate discharges it.
  if ((left & TF_EXPLICIT_GATE) !== 0 && !isSelf) left &= ~TF_EXPLICIT_GATE;
  if ((left & TF_CORPSE_ALLY) !== 0 && assist && dead) left &= ~TF_CORPSE_ALLY;
  if ((left & TF_CORPSE_ENEMY) !== 0 && !isSelf && dead) left &= ~TF_CORPSE_ENEMY;
  return left;
}

/**
 * Resolve the wire target for casting `row` with `selectionGuid` selected -- the ArmCast walk.
 *
 * A null `row` (a spell not in the DBC, or the table still loading) keeps the OLD behaviour
 * deliberately: the raw selection, or self-implicit without one. That is the reference's own
 * degrade (`cast_target.rs:355-361`) and it matters here because `Spell.dbc` is 49 MB -- a press in
 * the first seconds of a session must still send something the server can validate rather than be
 * refused by us.
 */
export function resolveCastTarget(
  row: SpellRow | null,
  selectionGuid: string | null,
  selfGuid: string | null,
  autoSelfCast: boolean,
  rel: CastTargetRelations,
): CastWireTarget {
  if (row === null) {
    return selectionGuid !== null && selectionGuid !== '0x0'
      ? { kind: 'unit', guid: selectionGuid }
      : { kind: 'self-implicit' };
  }

  const word = castTargetWord(row);
  // STEP 2, and it must come before everything else -- the reference fixes that order at `6e5338`.
  // This is the arm that stops a self-buff being aimed at whatever happens to be selected.
  if (word === 0) {
    return { kind: 'self-implicit' };
  }

  // A bit no unit candidate can ever satisfy: the click-to-target families. `clearSatisfiedBits`
  // only ever clears unit bits, so such a word always survives the walk -- which is why forking
  // here is equivalent to the reference letting the walk fail and then entering cursor mode.
  if ((word & ~UNIT_BITS) !== 0) {
    // Both legs refuse with the same string today, and they are written as one on purpose: the
    // CURSOR_BITS leg is the one that would become the targeting-cursor mode the day it is built
    // (`Targeting(word)` in the reference), and the remainder -- the bare SOURCE word, 0x20, which
    // is NPC-cast data unreachable from a player's book -- stays refused for good. `CURSOR_BITS`
    // names the split so the future change is a one-line fork rather than a re-derivation.
    return { kind: 'refused', error: ERR_INVALID_TARGET, word };
  }

  // Candidate 1: the current selection.
  if (selectionGuid !== null && selectionGuid !== '0x0') {
    const isSelf = selfGuid === selectionGuid;
    if (clearSatisfiedBits(word, isSelf, rel) === 0) {
      return { kind: 'unit', guid: selectionGuid };
    }
  }

  // Candidate 2: OURSELVES -- "buffing with an enemy targeted casts on yourself"
  // (`cast_target.rs:374-385`). This is the owner's whole request.
  if (autoSelfCast && selfGuid !== null) {
    const selfRel: CastTargetRelations = { target: rel.self, self: rel.self };
    if (clearSatisfiedBits(word, true, selfRel) === 0) {
      return { kind: 'unit', guid: selfGuid };
    }
  }

  return {
    kind: 'refused',
    error: selectionGuid !== null && selectionGuid !== '0x0' ? ERR_INVALID_TARGET : ERR_NO_TARGET,
    word,
  };
}
