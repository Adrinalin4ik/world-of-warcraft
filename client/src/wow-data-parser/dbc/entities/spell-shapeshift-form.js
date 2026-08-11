import * as r from 'restructure';

import Entity from '../entity';

/**
 * `SpellShapeshiftForm.dbc` -- a shapeshift FORM, and the action-bar page that form swaps to.
 *
 * THE SECOND COLUMN IS WHY THIS FILE EXISTS, and it is the answer to "the action bar is empty". The
 * server sends all 144 action slots (`SMSG_ACTION_BUTTONS`), and for a WARRIOR the ones that hold
 * anything are not slots 1-12: measured on the live wire for `Gesf` (a level-2 human warrior), the
 * filled slots are 0-based 72, 73, 82, 84 and 96. Slots 0-71 are the main bar's six pages
 * (`ActionButton.lua:2`, `NUM_ACTIONBAR_PAGES = 6`); everything above them is a BONUS bar, and which
 * bonus bar a form uses is exactly this column: `ActionButton_CalculateAction` computes
 * `page = NUM_ACTIONBAR_PAGES + GetBonusBarOffset()` for a button with `isBonus` set
 * (`ActionButton.lua:139-144`), so offset 1 addresses 1-based slots 73-84.
 *
 * Read off the served file (`recordCount = 32`, `fieldCount = 35`, `recordSize = 140`), field 1 by id:
 *
 *   17 Battle Stance -> 1, 18 Defensive Stance -> 2, 19 Berserker Stance -> 3,
 *   1 Cat Form -> 1, 5 Bear Form -> 3, 8 Dire Bear Form -> 3, 31 Moonkin Form -> 4,
 *   30 Stealth -> 1, 28 Shadowform -> 1, 3 Travel Form -> 0, 13 Shadow Dance -> 2.
 *
 * The three warrior stances land on 1/2/3, which is precisely where that character's three blocks of
 * filled slots are (73-84, 85-96, 97-108) -- the DBC and the wire corroborate each other, and the
 * forms with no bar of their own (Travel Form) carry 0, which is what `GetBonusBarOffset() == 0`
 * means to `BonusActionBar_OnEvent` ("hide the bonus bar").
 *
 * Narrow by design, the same rule `spell-visual.js` records: `stridedRecord` realigns on the header's
 * `recordSize`, so unread trailing columns cannot corrupt the records after them, and naming a column
 * without evidence is worse than not reading it. `Name_lang` (field 2, a localised string block) is
 * read as a plain offset word rather than declared as a locale block, and is not used -- it is here
 * only because the two columns before it are.
 */
export default Entity({
  id: r.uint32le,
  /** The bonus action bar this form switches to, or 0 for a form with no bar. See the header. */
  bonusActionBar: r.uint32le
});
