/**
 * The player's live stat block, in the shape a spell description needs.
 *
 * ONE PLACE, because two bridges build a spell tooltip -- `spellbook-bridge.ts` (`SetSpell`) and
 * `action-bridge.ts` (`SetAction`) -- and a description rendered with different stats in the two would
 * show the same spell two different numbers depending on where the pointer was.
 *
 * ## Why the attack power is a product and not a field
 *
 * `UNIT_FIELD_ATTACK_POWER` alone is the BASE. The client's own character sheet reads three values and
 * sums them (`PaperDollFrame_SetAttackPower`, `paperdollframe.lua:657-659`:
 * `local base, posBuff, negBuff = UnitAttackPower(unit)`, displayed as `base+posBuff+negBuff`), which
 * establishes that the engine global returns a base plus a split modifier -- i.e. that the modifier
 * word belongs in the total.
 *
 * The MULTIPLIER is the part the client's files do not settle. `(base + mods) * (1 + multiplier)` is
 * **TrinityCore 3.3.5's `Unit::GetTotalAttackPowerValue`** -- a SERVER source, labelled as such, not a
 * file in this repo. What makes it safe to apply here rather than a coin toss: the multiplier is 0 for
 * a character with no attack-power-percentage buff, so the product reduces to the sum the character
 * sheet shows, and every value this evaluator prints on a buff-free character is the sum either way.
 * A character under Blessing of Might-style percentage buffs is where the two readings could diverge
 * and where this is unverified.
 *
 * `Math.max(0, ...)` mirrors the same function's own floor and the character sheet's
 * `max((base+posBuff+negBuff), 0)` on the line below the read above: attack power does not go negative.
 */
import Unit from '../classes/unit';
import World from '../world';
import { CasterStats, unknownCaster } from '../pipeline/dbc/spell-description';
import { SpellHandler } from '../../network/game/object/spells';

/** `(base + mods) * (1 + multiplier)`, floored at 0. See the header for each factor's source. */
function totalAttackPower(base: number, mods: number, multiplier: number): number {
  const sum = base + mods;
  if (sum <= 0) {
    return 0;
  }
  return Math.trunc(sum * (1 + multiplier));
}

/**
 * The caster's stats for a description render, or a caster with none when the player has not arrived.
 *
 * NaN is the deliberate "unknown" for the attack-power pair rather than 0: `unknownCaster` says why --
 * a `$AP` that resolves to 0 before the wire has spoken prints a number that is wrong by the whole of
 * the character's gear, and this project's rule is that a wrong number reads as truth. The evaluator
 * leaves a non-finite stat as a visible token.
 *
 * **A missing field and a real zero are different**, and that is why each read tests `undefined`
 * rather than falling back with `?? 0`: a values block that never carried `UNIT_FIELD_ATTACK_POWER`
 * has not told us the player's attack power is zero.
 */
export function casterStatsFor(world: World, spells: SpellHandler): CasterStats {
  const player: Unit | null = world.player ?? null;
  if (player === null) {
    return unknownCaster();
  }
  const fields = player.fields;
  const attackPower = fields.attackPower === undefined
    ? Number.NaN
    : totalAttackPower(fields.attackPower, fields.attackPowerMods ?? 0, fields.attackPowerMultiplier ?? 0);
  const rangedAttackPower = fields.rangedAttackPower === undefined
    ? Number.NaN
    : totalAttackPower(
      fields.rangedAttackPower,
      fields.rangedAttackPowerMods ?? 0,
      fields.rangedAttackPowerMultiplier ?? 0,
    );

  return {
    level: fields.level ?? 0,
    attackPower,
    rangedAttackPower,
    spellDamage: player.spellDamage,
    // `$bh` -- `GetSpellBonusHealing()`. `PaperDollFrame_SetSpellBonusHealing` (`paperdollframe.lua:975`)
    // reads it as ONE number with no school split, which is what `PLAYER_FIELD_MOD_HEALING_DONE_POS` is.
    bonusHealing: fields.healingDone === undefined ? Number.NaN : fields.healingDone,
    // The wire carries MILLISECONDS; `$MWS` is a weapon speed in seconds ("2.6").
    mainHandSpeedSec: fields.baseAttackTimeMs === undefined
      ? Number.NaN
      : fields.baseAttackTimeMs / 1000,
    female: fields.gender === 1,
    // `SMSG_INITIAL_SPELLS`' own set -- which is what makes `$?s<talentSpellId>` answerable, and it is
    // the leg both `$<mult>` (Eviscerate) and `$<percent>` (Sinister Strike) are built out of.
    knowsSpell: (spellId: number) => spells.knownSpells().has(spellId),
  };
}
