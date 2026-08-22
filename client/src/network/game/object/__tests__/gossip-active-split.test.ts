/**
 * The gossip quest list's ACTIVE/AVAILABLE split, and the version numbers are the whole risk.
 *
 * The reference verified the predicate at the bytes as `icon == 3 || icon == 4`
 * (`benilla-app/src/ui_quest.rs#row_is_active`) -- 1.12's `DIALOG_STATUS_INCOMPLETE` and
 * `DIALOG_STATUS_REWARD_REP`. WotLK INSERTED the three `LOW_LEVEL_*` values ahead of them, so the same
 * two names are 5 and 6 here. Taking the reference's literal numbers would test LOW_LEVEL_REWARD_REP
 * and LOW_LEVEL_AVAILABLE_REP instead, which is why this asserts by NAME and pins 3 and 4 as NOT
 * active-by-number.
 *
 * The cost of getting it wrong was not cosmetic: an active row and an available row send different
 * opcodes, so a held quest listed as available cannot be handed in at all.
 */
import { rowIsActive } from '../gossip';
import { DIALOG_STATUS } from '../quest';

describe('the gossip quest row split', () => {
  it('is active for the held statuses and available for everything else', () => {
    expect(rowIsActive(DIALOG_STATUS.INCOMPLETE)).toBe(true);
    expect(rowIsActive(DIALOG_STATUS.REWARD_REP)).toBe(true);
    expect(rowIsActive(DIALOG_STATUS.LOW_LEVEL_REWARD_REP)).toBe(true);

    // An offer is not active -- and these two are the 1.12 numbers the reference tested, which land on
    // different meanings here.
    expect(rowIsActive(DIALOG_STATUS.AVAILABLE)).toBe(false);
    expect(rowIsActive(DIALOG_STATUS.AVAILABLE_REP)).toBe(false);
    expect(rowIsActive(DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP)).toBe(false);
    expect(rowIsActive(DIALOG_STATUS.NONE)).toBe(false);
  });
});
