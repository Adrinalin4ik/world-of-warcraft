/**
 * The gossip quest list's ACTIVE/AVAILABLE split, pinned to a MEASURED value.
 *
 * The reference verified the predicate at the bytes as `icon == 3 || icon == 4`
 * (`benilla-app/src/ui_quest.rs#row_is_active`). I "corrected" that to 5 and 6 on the reasoning that its
 * 3 and 4 were 1.12's `DIALOG_STATUS_INCOMPLETE`/`REWARD_REP` and WotLK had shifted those names. The
 * owner's console disproved it in one line:
 *
 *     gossip: 1 quest rows -- 783:icon=4 (active=0, available=1)
 *
 * Quest 783 was in his log and complete, so that row is active -- and it arrived as 4, which in
 * `DIALOG_STATUS` is `LOW_LEVEL_AVAILABLE_REP`. The field is not a status on this wire: 3.3.5-era cores
 * write `QuestMenu` icon constants (4 held, 2 offered). This test exists so the reasoning cannot be
 * repeated.
 *
 * The cost of getting it wrong was not cosmetic: an active row and an available row send different
 * opcodes, so a held quest listed as available cannot be handed in at all.
 */
import { rowIsActive } from '../gossip';

describe('the gossip quest row split', () => {
  it('is active for 3 and 4 and available for everything else', () => {
    // MEASURED: quest 783, held and complete, arrived as 4.
    expect(rowIsActive(4)).toBe(true);
    // The reference's other verified value.
    expect(rowIsActive(3)).toBe(true);

    // 2 is what a 3.3.5 core writes for an offer, and it must not read as held.
    expect(rowIsActive(2)).toBe(false);
    expect(rowIsActive(0)).toBe(false);
    expect(rowIsActive(1)).toBe(false);
    expect(rowIsActive(5)).toBe(false);
    expect(rowIsActive(6)).toBe(false);
  });
});
