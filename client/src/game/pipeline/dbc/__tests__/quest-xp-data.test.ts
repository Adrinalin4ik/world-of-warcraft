/**
 * `QuestXP.dbc` -- the table behind `GetQuestLogRewardXP`, and its INDEXING is the whole risk.
 *
 * The key is the QUEST's level, not a quest id, and the ten `difficulty` words are that level's XP at
 * each band, picked by the template's `xpId`. Getting the key or the band wrong yields a plausible
 * number, which is why the corroboration is against real traffic: the owner's giver panel showed
 * "Experience: 40" for quest 783, a level-1 quest, and row 1 of the served file decodes as
 * `[0, 10, 20, 40, 60, 80, 100, 120, 160, 0]` -- so 40 is `difficulty[3]`, and the SERVER's own computed
 * amount is the word this indexing picks.
 */
import { questXpData } from '../quest-xp-data';
import DBC from '..';

jest.mock('..', () => ({
  __esModule: true,
  default: {
    load: jest.fn(),
  },
}));

describe('questXpData', () => {
  it('picks the difficulty band out of the quest level row', async () => {
    (DBC.load as jest.Mock).mockResolvedValue({
      records: [
        // The served file's own row 1, verbatim.
        { id: 1, difficulty: [0, 10, 20, 40, 60, 80, 100, 120, 160, 0] },
        { id: 61, difficulty: [0, 970, 2400, 4850, 7300, 9800, 12200, 14700, 19600, 0] },
      ],
    });
    await questXpData.ensureLoaded();

    // The measured cross-check: quest 783 is level 1 and the server sent 40.
    expect(questXpData.xpFor(1, 3)).toBe(40);
    expect(questXpData.xpFor(61, 3)).toBe(4850);

    // NULL, not 0, for a level the table does not carry -- 0 is a real answer for a quest that grants
    // no XP, and the caller turns only null into "print nothing".
    expect(questXpData.xpFor(200, 3)).toBeNull();
  });
});
