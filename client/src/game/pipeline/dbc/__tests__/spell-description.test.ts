/**
 * The two sentences the owner photographed, rendered from the real `Spell.dbc` columns.
 *
 * TWO TESTS AND NO MORE, by instruction. They are the assertion worth having because they are the whole
 * chain end to end -- min/max identity, per-combo-point column, `${...}` arithmetic, `$AP`, a
 * `SpellDescriptionVariables` talent ladder, and the plural selector -- checked against two numbers
 * that are known independently of this code: Eviscerate rank 1 does **6-10** at one combo point, and
 * Sinister Strike rank 1 does **3** damage plus **100%** weapon damage for **1 combo point**.
 *
 * Every column value below is READ OFF THE SERVED FILE (record scan over `dbfilesclient/spell.dbc`,
 * 49,839 records / 234 fields / recordSize 936) and not invented, which is what makes the expected
 * strings a check on the evaluator rather than on the fixture.
 */
import { SpellRow, spellData } from '../spell-data';
import { CasterStats, renderSpellDescription } from '../spell-description';

/** A row with every column zeroed, so a fixture states only what it is about. */
function emptyRow(id: number, description: string): SpellRow {
  return {
    id,
    name: '',
    subName: '',
    description,
    passive: false,
    hiddenInSpellbook: false,
    speed: 0,
    targets: 0,
    implicitTargetA0: 0,
    interruptFlags: 0,
    channelInterruptFlags: 0,
  hiddenFromAuraBar: false,
    spellLevel: 1,
    iconID: 0,
    visualID: 0,
    castingTimeIndex: 0,
    powerType: 0,
    manaCost: 0,
    category: 0,
    recoveryTimeMs: 0,
    categoryRecoveryTimeMs: 0,
    startRecoveryTimeMs: 0,
    startRecoveryCategory: 0,
    rangeIndex: 0,
    manaCostPercentage: 0,
    effect: [0, 0, 0],
    // Three columns another round added to `SpellRow` after this fixture was written; zeroed like the
    // rest, because a fixture states only what its test is about.
    effectApplyAuraName: [0, 0, 0],
    effectMiscValue: [0, 0, 0],
    dispelType: 0,
    effectBasePoints: [0, 0, 0],
    effectDieSides: [0, 0, 0],
    effectRealPointsPerLevel: [0, 0, 0],
    effectPointsPerComboPoint: [0, 0, 0],
    effectRadiusIndex: [0, 0, 0],
    effectAmplitudeMs: [0, 0, 0],
    effectChainTargets: [0, 0, 0],
    durationIndex: 0,
    procChance: 101,
    stackAmount: 0,
    maxAffectedTargets: 0,
    baseLevel: 1,
    maxLevel: 0,
    schoolMask: 1,
    descriptionVariablesID: 0,
  };
}

/** A level-70 rogue with no gear and no talents: attack power 0, so `$AP` contributes nothing. */
function rogue(): CasterStats {
  return {
    level: 70,
    attackPower: 0,
    rangedAttackPower: 0,
    spellDamage: [0, 0, 0, 0, 0, 0, 0],
    bonusHealing: 0,
    mainHandSpeedSec: 2.6,
    female: false,
    knowsSpell: () => false,
  };
}

describe('spell description evaluator', () => {
  it('renders Eviscerate rank 1 at one combo point as 6-10 damage', () => {
    // 2098 Eviscerate rank 1, as served: effect 1 basePoints 0 / dieSides 5 /
    // pointsPerComboPoint 5.0, descriptionVariablesID 169.
    const row = emptyRow(2098, '1 point: ${$m1+(($b1*1)+$AP*0.03)*$<mult>}-${$M1+(($b1*1)+$AP*0.07)*$<mult>} damage');
    row.effectDieSides = [5, 0, 0];
    row.effectPointsPerComboPoint = [5, 0, 0];
    row.descriptionVariablesID = 169;

    // Row 169 verbatim from `dbfilesclient/spelldescriptionvariables.dbc` (30 records, 2 fields,
    // recordSize 8). A rogue with none of the three Improved Eviscerate talents takes the base rung.
    jest.spyOn(spellData, 'descriptionVariables').mockReturnValue(
      '$mult1=$?s14162[${1.07}][${1.0}]\r\n$mult2=$?s14163[${1.14}][${$<mult1>}]\r\n$mult=$?s14164[${1.2}][${$<mult2>}]',
    );

    // m1 = 0 + 1 = 1, M1 = 0 + 5 = 5, b1 = 5, mult = 1.0, AP = 0
    //   min = 1 + ((5*1) + 0) * 1.0 = 6
    //   max = 5 + ((5*1) + 0) * 1.0 = 10
    expect(renderSpellDescription(row, rogue())).toBe('1 point: 6-10 damage');
  });

  it('renders Sinister Strike rank 1 with its weapon percentage and a singular combo point', () => {
    // 1752 Sinister Strike rank 1, as served: effect 1 basePoints 2 / dieSides 1, effect 2
    // basePoints 0 / dieSides 1, descriptionVariablesID 171.
    const row = emptyRow(
      1752,
      'An instant strike that causes $m1 damage in addition to $<percent>% of your normal weapon damage.  Awards $s2 combo $lpoint:points;.',
    );
    row.effectBasePoints = [2, 0, 0];
    row.effectDieSides = [1, 1, 0];
    row.descriptionVariablesID = 171;

    // Row 171 verbatim: five Improved Sinister Strike / Aggression rungs over a base of 100.
    jest.spyOn(spellData, 'descriptionVariables').mockReturnValue(
      '$aggression1=$?s18427[${103}][${100}]\r\n$aggression2=$?s18428[${106}][${$<aggression1>}]\r\n'
      + '$aggression3=$?s18429[${109}][${$<aggression2>}]\r\n$aggression4=$?s61330[${112}][${$<aggression3>}]\r\n'
      + '$percent=$?s61331[${115}][${$<aggression4>}]\r\n\r\n',
    );

    expect(renderSpellDescription(row, rogue())).toBe(
      'An instant strike that causes 3 damage in addition to 100% of your normal weapon damage.  Awards 1 combo point.',
    );
  });
});
