import { rangeState, resolveRange, SpellRangeRow } from '../action-range';
import { SpellRow } from '../../pipeline/dbc/spell-data';

/**
 * **`IsActionInRange`'s tri-state, and the MINIMUM that was missing.**
 *
 * The owner: "Я стою вблизи, мне хватает ярости на charge, но charge нельзя использовать вблизи."
 *
 * Every row below is READ OFF the served `dbfilesclient/spellrange.dbc` (64 records / 40 fields /
 * 160 B) and `spell.dbc` -- not synthesised. **Charge's `min` of 8.00 is the value that proves the
 * column**: the 1.12 row carries a single min/max pair where 3.3.5a splits both into hostile and
 * friendly, so a ported offset would have read 0 here and the defect would have survived the fix.
 *
 * WHICH LAYER: the pure predicate. It says nothing about the hotkey turning red -- that is the
 * client's own `ActionButton_OnUpdate` reading this value, and the colour is the owner's to see.
 */

/** Only the attribute words matter to the predicate; `isOnNextSwing` reads `attributes`. */
const spell = (attributes = 0): SpellRow => ({
  attributes, attributesEx1: 0, attributesEx2: 0,
} as unknown as SpellRow);

/** Charge 100 / Intercept 20252 -> `SpellRange.dbc` id 95 "Charge". */
const CHARGE_RANGE: SpellRangeRow = { min: 8, max: 25, flags: 0 };
/** Fireball 133 -> id 35 "Medium-Long". The min-0 case the guard protects. */
const FIREBALL_RANGE: SpellRangeRow = { min: 0, max: 35, flags: 0 };
/** id 2 "Combat" -- the only row on this build with `flags & 1`. */
const MELEE_RANGE: SpellRangeRow = { min: 0, max: 5, flags: 1 };
/** id 1 "Self". */
const SELF_RANGE: SpellRangeRow = { min: 0, max: 0, flags: 0 };

/** Both reaches at the reference's default, so the pad is a round 3.0. */
const REACH = 1.5;
const sq = (yards: number): number => yards * yards;

it('Charge reads 0 when too close, 1 in the band, and 0 beyond the max', () => {
  const charge = spell();

  // THE OWNER'S CASE. Standing in melee: 2 yards is inside the padded minimum (8 + 3 = 11), so the
  // answer is OUT OF RANGE -- and it must be the number 0, not nil, or the hotkey stays grey.
  expect(rangeState(charge, CHARGE_RANGE, REACH, REACH, sq(2))).toBe(0);

  // Inside the band: past the padded min, short of the padded max (25 + 3 = 28).
  expect(rangeState(charge, CHARGE_RANGE, REACH, REACH, sq(15))).toBe(1);

  // Too far.
  expect(rangeState(charge, CHARGE_RANGE, REACH, REACH, sq(40))).toBe(0);

  // The padded bounds, so the arithmetic is pinned rather than only its verdicts.
  expect(resolveRange(charge, CHARGE_RANGE, REACH, REACH)).toEqual({ min: 11, max: 28 });
});

it('a min-0 spell never grows a minimum, and the three non-applicable cases answer nil', () => {
  // THE GUARD THE REFERENCE NAMES: padding a min of 0 would refuse Fireball at point-blank with
  // TOO_CLOSE. Its minimum must stay 0 while its maximum still pads.
  const fireball = spell();
  expect(resolveRange(fireball, FIREBALL_RANGE, REACH, REACH)).toEqual({ min: 0, max: 38 });
  expect(rangeState(fireball, FIREBALL_RANGE, REACH, REACH, sq(0.5))).toBe(1);

  // The melee row: floor 5, or the padded reach sum when that is larger. 1.5 + 1.5 + 1.3333 = 4.33,
  // under the floor, so 5 wins.
  expect(resolveRange(spell(), MELEE_RANGE, REACH, REACH)?.max).toBeCloseTo(5, 4);

  // An ON-NEXT-SWING spell short-circuits to a flat 100 and never reddens -- Heroic Strike 78
  // carries `Attributes 0x00050014`, whose `0x4` is the on-next-swing bit.
  expect(resolveRange(spell(0x00050014), MELEE_RANGE, REACH, REACH)).toEqual({ min: 0, max: 100 });

  // THE THREE nil CASES, which are the ones that must NOT be 0: the Self row has no range to test,
  // an unknown spell cannot be judged, and neither can an unknown distance.
  expect(rangeState(spell(), SELF_RANGE, REACH, REACH, sq(3))).toBeNull();
  expect(rangeState(null, CHARGE_RANGE, REACH, REACH, sq(3))).toBeNull();
  expect(rangeState(spell(), CHARGE_RANGE, REACH, REACH, null)).toBeNull();
});
