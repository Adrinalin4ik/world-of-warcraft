import {
  CATEGORIES, CATEGORY_CRIT, CATEGORY_NUMBER, CATEGORY_WORD, combatFeedbackArgs, fadeAlpha, meleeText,
} from '../combat-text';

/**
 * THE ONE THING THAT MUST NOT BE WRONG: the crit bit is 3.3.5a's `0x200`, and the reference's `0x80` is
 * this build's FULL_RESIST. Getting these two swapped shows a resist as a crit and a crit as an ordinary
 * hit -- plausible on screen and wrong, which is the failure the whole header of `combat-text.ts` exists
 * to prevent. The word arms cover the outcomes the owner asked to see: parry, miss and dodge.
 */
test('the crit bit is 0x200 and the reference 0x80 is a full RESIST', () => {
  expect(meleeText(0x2, 1, 37)).toEqual({ category: CATEGORY_NUMBER, number: '37', wordKey: null });
  expect(meleeText(0x202, 1, 74)).toEqual({ category: CATEGORY_CRIT, number: '74', wordKey: null });
  // The reference's crit bit, on a swing that did damage: still an ORDINARY number here.
  expect(meleeText(0x82, 1, 37)).toEqual({ category: CATEGORY_NUMBER, number: '37', wordKey: null });
  // And on a swing that did none, it is what 3.3.5a says it is.
  expect(meleeText(0x82, 1, 0)).toEqual({ category: CATEGORY_WORD, number: null, wordKey: 'RESIST' });
  // The three outcomes the owner named. A word state ignores Damage entirely (the client's own
  // unconditional word arm), which is why the parry carries 25.
  expect(meleeText(0x2, 3, 25)?.wordKey).toBe('PARRY');
  expect(meleeText(0x2, 2, 0)?.wordKey).toBe('DODGE');
  expect(meleeText(0x2, 1, 0)?.wordKey).toBe('MISS');
  // A decode that did not add up floats nothing rather than guessing at the common case.
  expect(meleeText(0x2, null, 37)).toBeNull();
});

/**
 * The other medium, from the same decision: what the client's own `CombatFeedback_OnCombatEvent` is
 * handed. Plus the fade law's two pinned points off the reference, which is what makes the indicator
 * appear at all -- it is shown at alpha zero.
 */
test('the client is told WOUND with CRITICAL, and the fade ramps then plateaus', () => {
  expect(combatFeedbackArgs(0x202, 1, 74, 0x01))
    .toEqual({ event: 'WOUND', flags: 'CRITICAL', amount: 74, school: 0x01 });
  expect(combatFeedbackArgs(0x2, 3, 25, 0x01))
    .toEqual({ event: 'PARRY', flags: '', amount: 0, school: 0x01 });
  expect(combatFeedbackArgs(0x2, 1, 0, 0x01)?.event).toBe('MISS');

  // `law.rs:396-410`: the ramp divides by the row's DURATION, so 150 ms is a STEP onto the plateau, and
  // the shadow lane is min-capped to the text by the store seam.
  const row = CATEGORIES[0];
  expect(fadeAlpha(row, 75)).toEqual({ text: 12, shadow: 6 });
  expect(fadeAlpha(row, 150)).toEqual({ text: 0xff, shadow: 0x7f });
  expect(fadeAlpha(row, 760)).toEqual({ text: 0xff, shadow: 0xff });
});
