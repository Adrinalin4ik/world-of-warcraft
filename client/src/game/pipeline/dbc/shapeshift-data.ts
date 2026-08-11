/**
 * `SpellShapeshiftForm.dbc`: a shapeshift form -> the BONUS ACTION BAR that form switches to.
 *
 * ## Why this is its own module and not a fifth table in `spell-data.ts`
 *
 * `spell-data.ts` loads four tables behind ONE promise, and one of them is the 48,967,121-byte
 * `Spell.dbc`. This table is **4,890 bytes**. Folding it in would make the action bar's PAGE wait on a
 * 49 MB download, and the page is what decides whether the twelve buttons address the slots the server
 * actually filled -- so a bar that could have had the right shape immediately would instead have the
 * wrong one for as long as the big fetch takes. Icons legitimately wait for `Spell.dbc`; which slots to
 * read does not.
 *
 * See `wow-data-parser/dbc/entities/spell-shapeshift-form.js` for the column evidence and for the
 * measurement (a warrior's filled slots are 73-84 / 85-96 / 97-108, one block per stance) that made
 * this table load-bearing.
 */
import DBC from './index';

class ShapeshiftData {
  /** `SpellShapeshiftForm.dbc` id -> `bonusActionBar`. Forms with bar 0 are kept: 0 is a real answer. */
  private bars: Map<number, number> | null = null;

  private pending: Promise<void> | null = null;

  get ready(): boolean {
    return this.bars !== null;
  }

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure can be retried rather than poisoning the session. Until it
        // succeeds `bonusBar` answers null and the caller keeps offset 0, which is the pre-existing
        // state (no bonus bar) rather than a guess.
        this.pending = null;
        console.warn('shapeshiftData: load failed, a form-swapped action bar will stay on page 1', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const dbc = await DBC.load('SpellShapeshiftForm');
    const bars = new Map<number, number>();
    for (const record of (dbc as any).records ?? []) {
      if (record && typeof record.bonusActionBar === 'number') {
        bars.set(record.id, record.bonusActionBar >>> 0);
      }
    }
    this.bars = bars;
  }

  /**
   * The bonus action bar for a form id, or null when the table is not loaded yet.
   *
   * Form **0** is "no form at all" and has no record in the table; it answers 0, which is what
   * `GetBonusBarOffset()` must return for an unshifted character. A form the table does not know
   * answers 0 as well rather than null -- "this form has no bonus bar" is the safe reading, and the
   * alternative would leave the buttons pointing at whichever page was last set.
   */
  bonusBar(form: number): number | null {
    if (this.bars === null) {
      return null;
    }
    if (form === 0) {
      return 0;
    }
    return this.bars.get(form) ?? 0;
  }
}

export const shapeshiftData = new ShapeshiftData();

if (typeof window !== 'undefined') {
  (window as any).shapeshiftData = shapeshiftData;
}
