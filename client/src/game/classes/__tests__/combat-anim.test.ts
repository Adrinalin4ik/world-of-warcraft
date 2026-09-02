/**
 * THE RANGED AUTO-ATTACK IDLE -- `combat-anim.ts#rangedLoadAnimation` and the Load -> Hold promotion.
 *
 * Two arms and no more: the selector across all five ranged subclasses (the wand being the one the
 * owner's report turns on), and the promotion. The wand's row is the interesting one twice over --
 * it is the only key that maps to a HOLD rather than a Load, so `isRangedLoad` must EXCLUDE it,
 * because a hold pose has nothing to freeze into.
 *
 * `Item.dbc` is mocked rather than fetched: the real table is ~40k rows and the thing under test is
 * the subclass -> clip mapping, not the load. `classID: 2` on every row because all five of the
 * reference's match arms are item class 2 (`ITEM_CLASS_WEAPON`) and `primeItems` indexes only that
 * class -- a fixture on any other class would make every arm answer ReadyUnarmed and pass for one
 * wrong reason.
 */
import {
  isRangedLoad, primeItems, rangedHoldFor, rangedLoadAnimation,
} from '../combat-anim';

/** entry id -> subclass, by construction: entry `100 + subclass`. */
const entryWithSubclass = (subclass: number) => 100 + subclass;

jest.mock('../../pipeline/dbc', () => ({
  __esModule: true,
  default: {
    load: () => Promise.resolve({
      records: [2, 3, 7, 16, 18, 19].map((subClassID) => ({
        id: 100 + subClassID, classID: 2, subClassID,
      })),
    }),
  },
}));

describe('rangedLoadAnimation', () => {
  it('picks the Load/Hold clip from the ranged item subclass, wand included', async () => {
    await primeItems();
    const cases: Array<[number, number]> = [
      [2, 105],   // Bow      -> LoadBow
      [3, 106],   // Gun      -> LoadRifle
      [18, 106],  // Crossbow -> LoadRifle
      [16, 112],  // Thrown   -> LoadThrown
      [19, 111],  // Wand     -> HoldThrown
      [7, 25],    // a sword in the ranged slot -> ReadyUnarmed
    ];
    for (const [subclass, expected] of cases) {
      expect(rangedLoadAnimation({ equippedRanged: entryWithSubclass(subclass) } as any))
        .toBe(expected);
    }
    // No ranged item at all is the same ReadyUnarmed the reference gives `None`.
    expect(rangedLoadAnimation({ equippedRanged: 0 } as any)).toBe(25);
  });

  it('promotes a finished Load to its Hold, and leaves the wand hold alone', () => {
    expect(rangedHoldFor(105)).toBe(109);
    expect(rangedHoldFor(106)).toBe(110);
    expect(rangedHoldFor(112)).toBe(111);
    expect(rangedHoldFor(111)).toBeNull();
    expect(isRangedLoad(105)).toBe(true);
    expect(isRangedLoad(111)).toBe(false);
  });
});
