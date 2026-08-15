/**
 * RACE AND CLASS NAMES -- what `UnitRace` and `UnitClass` answer, and the only client-side half of
 * either.
 *
 * The IDs come off the wire: `UNIT_FIELD_BYTES_0` packs `race | class | gender | powerType`, which is
 * stated in `update-object/unit-fields.ts`' own comment and is the same packing the power type and
 * gender reads there already depend on. What the DBCs add is the pair of STRINGS each global owes.
 *
 * ## Both globals return TWO values, and the second is not the first
 *
 * `UnitRace(unit)` -> `localizedName, fileName` and `UnitClass(unit)` -> `localizedName, FILENAME`.
 * The second return is a token FrameXML uses to index tables and build texture paths -- `RAID_CLASS_COLORS`
 * and `CLASS_ICON_TCOORDS` are both keyed by the uppercase class token -- so answering the localized
 * name twice would look right in the header and break every lookup keyed on it.
 *
 *  - `ChrRaces.dbc`: `name` (localized) and `clientFileString` -- `entities/chr-races.js` names both,
 *    and `clientFileString` is the "Human"/"Scourge"/"NightElf" form the client builds paths from.
 *  - `ChrClasses.dbc`: `name` (localized) and `filename` -- `entities/chr-classes.js`. The `filename`
 *    column is the uppercase token (`WARRIOR`, `DEATHKNIGHT`).
 *
 * **THE CASE OF THE CLASS TOKEN IS NOT ASSUMED.** `filename` is uppercased here, because FrameXML's
 * own tables are keyed in uppercase (`RAID_CLASS_COLORS["WARRIOR"]`) and a served column that is
 * already uppercase is unchanged by it. That is a normalisation, not a guess about the column.
 *
 * ## Why the accessors answer null rather than waiting
 *
 * Same contract as `item-data.ts`: `ensureLoaded` is idempotent and the sync accessors answer null
 * until the tables land. Both files are small (a few dozen rows each) next to the 6.7 MB
 * `ItemDisplayInfo.dbc` this pattern was written for, and the character sheet is opened by a
 * keystroke long after load -- so in practice the read is warm. A caller that asks too early gets
 * nil, which is what `UnitRace` answers for an unknown unit anyway.
 */
import DBC from '.';

/** One row's two strings, in the order the Lua global returns them. */
interface NamePair {
  name: string;
  token: string;
}

class RaceClassData {
  private races: Map<number, NamePair> | null = null;

  private classes: Map<number, NamePair> | null = null;

  private pending: Promise<void> | null = null;

  get ready(): boolean {
    return this.races !== null && this.classes !== null;
  }

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Retryable rather than poisoned, exactly as `itemData` does it. The header simply stays
        // unwritten until a later attempt succeeds, which is the pre-existing state.
        this.pending = null;
        console.warn('raceClassData: load failed, UnitRace/UnitClass stay nil', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const [races, classes] = await Promise.all([
      DBC.load('ChrRaces'),
      DBC.load('ChrClasses'),
    ]);

    const raceMap = new Map<number, NamePair>();
    for (const record of (races as any).records ?? []) {
      if (record && typeof record.id === 'number') {
        raceMap.set(record.id, {
          name: String(record.name ?? ''),
          token: String(record.clientFileString ?? ''),
        });
      }
    }
    this.races = raceMap;

    const classMap = new Map<number, NamePair>();
    for (const record of (classes as any).records ?? []) {
      if (record && typeof record.id === 'number') {
        classMap.set(record.id, {
          name: String(record.name ?? ''),
          // See the header: uppercased so it matches the keys FrameXML's own tables use.
          token: String(record.filename ?? '').toUpperCase(),
        });
      }
    }
    this.classes = classMap;
  }

  /** `[localizedName, fileName]` for a `ChrRaces` id, or null. */
  race(id: number): NamePair | null {
    const row = this.races?.get(id) ?? null;
    return row === null || row.name === '' ? null : row;
  }

  /** `[localizedName, TOKEN]` for a `ChrClasses` id, or null. */
  class(id: number): NamePair | null {
    const row = this.classes?.get(id) ?? null;
    return row === null || row.name === '' ? null : row;
  }
}

export const raceClassData = new RaceClassData();

export default raceClassData;
