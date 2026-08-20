/**
 * The repair-cost join, against rows READ OFF THE SERVED FILES.
 *
 * TWO TESTS AND NO MORE, per `CLAUDE.md`. They are the pair worth having because between them they
 * pin the whole chain -- which table the item level keys, which of the two multiplier arrays an item
 * class selects, the `(quality + 1) * 2` indexing, and the rounding -- and because the second one
 * guards the distinction that a wrong answer here would silently collapse: **0 copper and "unknown"
 * are different**, and only one of them may grey the repair button.
 *
 * Every number in the fixtures is measured, not invented. `dbfilesclient/durabilitycosts.dbc` is
 * `recordCount 300, fieldCount 30, recordSize 120, stringSize 1`, and its item-level-20 row is
 *
 *     weapon[0..20] = 5 7 5 5 5 7 7 5 7 0 7 5 7 5 5 3 1 7 7 3 4
 *     armor[0..7]   = 0 5 5 5 5 0 6 0
 *
 * -- note `weapon[9] = 0` (the obsolete weapon subclass), `armor[0] = 0` (ITEM_SUBCLASS_ARMOR_MISC:
 * rings, necks, trinkets), `armor[5] = 0` (the obsolete buckler) and `armor[7] = 0` (librams). Four
 * zeroes, each exactly where a subclass with nothing to repair must be, which is what makes the
 * weapon/armor split a reading of the file rather than a guess about it.
 *
 * `dbfilesclient/durabilityquality.dbc` is `recordCount 16, fieldCount 2, recordSize 8` and its ids
 * 2/4/6/8/10/12 -- the ones `(quality + 1) * 2` selects for qualities 0..5 -- hold
 * 0.6 / 0.8 / 1.0 / 1.25 / 2.5 / 3.0.
 */
import DBC from '..';
import { durabilityData } from '../durability-data';

/** The served item-level-20 row of `durabilitycosts.dbc`. See this file's header. */
const ILVL_20 = {
  id: 20,
  weaponSubClassCost: [5, 7, 5, 5, 5, 7, 7, 5, 7, 0, 7, 5, 7, 5, 5, 3, 1, 7, 7, 3, 4],
  armorSubClassCost: [0, 5, 5, 5, 5, 0, 6, 0],
};

/** The served `durabilityquality.dbc`, entire -- all sixteen rows, as floats. */
const QUALITY_ROWS = [
  { id: 1, data: 1.0 }, { id: 2, data: 0.6 }, { id: 3, data: 1.0 }, { id: 4, data: 0.8 },
  { id: 5, data: 1.0 }, { id: 6, data: 1.0 }, { id: 7, data: 1.2 }, { id: 8, data: 1.25 },
  { id: 9, data: 1.44 }, { id: 10, data: 2.5 }, { id: 11, data: 1.728 }, { id: 12, data: 3.0 },
  { id: 13, data: 0.0 }, { id: 14, data: 0.0 }, { id: 15, data: 1.2 }, { id: 16, data: 1.25 },
];

beforeAll(async () => {
  jest.spyOn(DBC, 'load').mockImplementation((name: string) => Promise.resolve(
    name === 'DurabilityCosts'
      ? { records: [ILVL_20] }
      : { records: QUALITY_ROWS },
  ) as never);
  await durabilityData.ensureLoaded();
});

it('costs a damaged common dagger by item level, weapon subclass and quality', () => {
  // Item level 20 dagger: weapon subclass 15, so the multiplier is 3. Quality 1 (common) selects
  // DurabilityQuality row (1 + 1) * 2 = 4, whose value is 0.8. Ten points lost:
  //   round(10 * 3 * 0.8) = 24 copper.
  expect(durabilityData.repairCost({
    lostDurability: 10, itemLevel: 20, quality: 1, itemClass: 2, subClass: 15,
  })).toBe(24);
});

it('charges nothing -- and answers 0, not null -- for a subclass with no durability', () => {
  // A ring is ITEM_CLASS_ARMOR / ITEM_SUBCLASS_ARMOR_MISC, whose multiplier is 0 in every row of the
  // served table. It must answer 0 copper and NOT null: null means "this client does not know", which
  // greys the repair-all button, and a bagful of rings would then hide a genuinely repairable sword.
  expect(durabilityData.repairCost({
    lostDurability: 40, itemLevel: 20, quality: 3, itemClass: 4, subClass: 0,
  })).toBe(0);
  // An item level this 300-row table does not carry IS the unknown case, and stays distinct from it.
  expect(durabilityData.repairCost({
    lostDurability: 40, itemLevel: 999, quality: 3, itemClass: 4, subClass: 6,
  })).toBeNull();
});
