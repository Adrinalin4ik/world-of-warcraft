/**
 * WHAT A QUEST'S XP REWARD IS -- the table behind `GetQuestLogRewardXP`.
 *
 * That global was a declared gap whose reason was accurate: "the query response carries an `xpId`, not
 * an amount; resolving it needs QuestXP.dbc". This is that DBC, and nothing more -- the giver panel's
 * `GetRewardXP` was always a real number because `SMSG_QUESTGIVER_QUEST_DETAILS` carries the computed
 * amount; only the LOG has to compute it, because the log reads the template cache.
 *
 * ## The table is the game's own, and the indexing is corroborated by real traffic
 *
 * `questxp.dbc` MEASURED on the served file: `recordCount 100`, `fieldCount 11`, `recordSize 44`,
 * `stringSize 1`, and the layout closes exactly against the 4421 bytes served. The KEY is the QUEST's
 * level -- row `n` is quest level `n` -- and the ten `difficulty` words are that level's XP at each
 * difficulty band, selected by the template's `xpId`.
 *
 * The cross-check is exact rather than argued: the owner's giver panel showed "Experience: 40" for quest
 * 783, a level-1 quest, and row 1 decodes as `[0, 10, 20, 40, 60, 80, 100, 120, 160, 0]` -- 40 is
 * `difficulty[3]`, so the amount the SERVER computed and sent is the same word this indexing picks.
 *
 * ## WHAT IS NOT DONE, said plainly
 *
 * The real client REDUCES the figure for a quest well below the player's level, and that reduction is
 * not applied here. No file the client ships states it -- no FrameXML function computes quest XP and no
 * DBC carries a level-difference curve -- so applying one would be inventing a formula, which this repo
 * treats as worse than a figure that is right at level and generous below it. The corroboration above
 * was taken at a small level gap, where the two agree. If a source appears, it belongs here and the note
 * should go with it.
 */
import DBC from '.';

class QuestXpData {
  private pending: Promise<void> | null = null;

  /** Quest level -> its ten difficulty bands. Empty until the DBC lands. */
  private rows = new Map<number, number[]>();

  /**
   * Load the table, once. Idempotent, and the same shape as `durabilityData.ensureLoaded`.
   *
   * **4.4 KB**, probed on the live host: 100 records of 44 bytes. Smaller than a single icon, so there
   * is no budget argument for deferring it and a real one against making the first quest log of a
   * session show no XP row.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure is retryable rather than poisoning the session. Until it
        // succeeds `xpFor` answers null, which hides the XP row -- a missing line, not a wrong figure.
        this.pending = null;
        console.warn('questXpData: load failed, the quest log will show no XP row', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('QuestXP');
    const rows = new Map<number, number[]>();
    for (const record of (table as { records?: unknown[] }).records ?? []) {
      const row = record as { id?: number; difficulty?: number[] };
      if (typeof row?.id === 'number' && Array.isArray(row.difficulty)) {
        rows.set(row.id, row.difficulty);
      }
    }
    this.rows = rows;
  }

  /**
   * The XP a quest of `level` at difficulty `xpId` rewards, or **null when unknown**.
   *
   * Null and not 0, and the distinction is the one this file's callers care about: 0 is a real answer
   * for a quest that grants no XP and hides the row, while null means the table has not landed and the
   * caller must not print a figure it does not have. A level off the end of the table is also null --
   * there are 100 rows and 3.3.5a caps at 80, so that can only mean a misread template.
   */
  xpFor(level: number, xpId: number): number | null {
    const bands = this.rows.get(level);
    if (bands === undefined) {
      return null;
    }
    const value = bands[xpId];
    return typeof value === 'number' ? value : null;
  }
}

export const questXpData = new QuestXpData();

export default questXpData;
