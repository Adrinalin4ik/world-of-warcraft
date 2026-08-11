/**
 * The spell tables an action bar needs: a spell's icon, its name, and the animation its cast plays.
 *
 * ## Why `Spell.dbc` does NOT go through `DBC.load`
 *
 * Every other table in this client is decoded by `wow-data-parser/dbc` through the worker pool, and
 * `entities/spell.js` is the canonical definition of a `Spell.dbc` row -- corrected for 3.3.5a in the
 * same change that added this file. `Spell.dbc` is nevertheless read here by hand, for a reason that is
 * a measurement and not a preference:
 *
 *   the served `dbfilesclient/spell.dbc` is **48,967,121 bytes** -- `recordCount = 49839`,
 *   `fieldCount = 234`, `recordSize = 936`, plus a 2.3 MB string block.
 *
 * Handing that to `restructure` means 49,839 records x 234 columns, including four `LocalizedStringRef`
 * blocks that are 17 pointer decodes each -- roughly 15 million field decodes to obtain two columns per
 * row. The nine columns below are read with a `DataView` instead, which is one pass and no allocation
 * per row beyond the entries actually wanted.
 *
 * The 49 MB DOWNLOAD is unavoidable and is not hidden: a DBC has no index, so there is no way to reach
 * record N without the bytes before it, and the file is only sorted by id by convention. It is fetched
 * ONCE, lazily, off the entry path (`ensureLoaded` is fired when the spell handler first has something
 * to resolve, and every consumer tolerates "not yet"), and the browser caches it. The real client reads
 * this table out of a local MPQ, so there is no upstream design to copy here.
 *
 * `SpellIcon` (152 KB), `SpellVisual` (1.2 MB) and `SpellVisualKit` (1.3 MB) DO go through `DBC.load`,
 * because their entity definitions are deliberately narrow (`entities/spell-visual.js`,
 * `entities/spell-visual-kit.js`) and `stridedRecord` makes a narrow definition cheap.
 *
 * ## Where the column indices come from
 *
 * Measured against the served file, not transcribed. `recordSize` is exactly `fieldCount * 4`, so every
 * column is 4 bytes wide and a field index IS its byte offset / 4. The two load-bearing indices were
 * found by scanning spell 133's record for the column that resolves to the string "Fireball" (index
 * **136**) and the column whose value is a `SpellIcon.dbc` id naming `Spell_Fire_FlameBolt` (index
 * **133**). Ten known spells then decode with correct name, rank and icon; the check is repeated as a
 * unit test against a synthesised record so a future edit cannot shift them silently.
 *
 * `manaCost` corroborates independently: Heroic Strike rank 1 reads 150 and Battle Shout rank 1 reads
 * 100, which are 15 and 10 rage -- rage is stored x10 -- and both carry `powerType = 1` (rage) while
 * Eviscerate carries `powerType = 3` (energy).
 */
import DBC from './index';
import Loader from '../../net/loader';
import { spellWire } from '../../classes/spell-wire';

/** `Spell.dbc` column indices for 3.3.5a build 12340. See the header for how each was established. */
const COL = {
  id: 0,
  castingTimeIndex: 28,
  powerType: 41,
  manaCost: 42,
  /** `SpellVisualID[0]`. `[1]` at 132 is the second visual and is not read. */
  visual: 131,
  iconID: 133,
  activeIconID: 134,
  /** First locale slot of the `Name` block; 3.3.5a localised strings are 16 locales + a flags word. */
  name: 136,
} as const;

/** The head of a `Spell.dbc` row -- only what a button, a cast and a tooltip line need. */
export interface SpellRow {
  id: number;
  name: string;
  iconID: number;
  /** `SpellVisual.dbc` id, or 0 for a spell with no visual (spell 6603 Auto Attack is one). */
  visualID: number;
  /** `SpellCastTimes.dbc` id. Read for a later round; cast TIME is deferred. */
  castingTimeIndex: number;
  powerType: number;
  manaCost: number;
}

class SpellData {
  private spells: Map<number, SpellRow> | null = null;

  private icons: Map<number, string> | null = null;

  /** `SpellVisual.dbc` id -> its cast-stage kit id. */
  private castKits: Map<number, number> | null = null;

  /** `SpellVisualKit.dbc` id -> its `animID`, sentinels already folded away. */
  private kitAnims: Map<number, number> | null = null;

  private pending: Promise<void> | null = null;

  /** True once every table is in memory and lookups can succeed. */
  get ready(): boolean {
    return this.spells !== null && this.icons !== null;
  }

  /**
   * Load all four tables, once. Idempotent and safe to call from every consumer -- callers that need a
   * value NOW read the accessors below, which answer null until this settles.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure can be retried rather than poisoning the session for good; the
        // action bar simply stays iconless until then, which is the pre-existing state.
        this.pending = null;
        console.warn('spellData: load failed, action bar will stay iconless', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const startedAt = Date.now();
    const [spells, icons, visuals, kits] = await Promise.all([
      this.loadSpells(),
      DBC.load('SpellIcon'),
      DBC.load('SpellVisual'),
      DBC.load('SpellVisualKit'),
    ]);

    this.spells = spells;

    this.icons = new Map<number, string>();
    for (const record of (icons as any).records ?? []) {
      if (record && typeof record.file === 'string' && record.file !== '') {
        this.icons.set(record.id, record.file);
      }
    }

    this.castKits = new Map<number, number>();
    for (const record of (visuals as any).records ?? []) {
      if (record && record.castKitID) {
        this.castKits.set(record.id, record.castKitID);
      }
    }

    this.kitAnims = new Map<number, number>();
    for (const record of (kits as any).records ?? []) {
      // THE DUAL NONE-SENTINEL. `0` and `0xFFFFFFFF` both mean "no animation" on this table, found
      // empirically by the reference across all 1772 kits (41 carry `0`, 875 carry `0xFFFFFFFF`) --
      // `samples/benilla/crates/benilla-formats/src/spell_visual/mod.rs:66-75`. Folding only one form
      // would make a kit resolve to animation id 4294967295, or worse to id 0 (`Stand`), which would
      // silently park a caster in an idle instead of playing nothing.
      const anim = record?.animID;
      if (typeof anim === 'number' && anim !== 0 && anim !== 0xffffffff) {
        this.kitAnims.set(record.id, anim);
      }
    }

    spellWire.record({
      at: Date.now(),
      kind: 'INITIAL_SPELLS',
      spellId: 0,
      caster: null,
      detail: {
        note: 'spellData tables loaded',
        spells: this.spells.size,
        icons: this.icons.size,
        castKits: this.castKits.size,
        kitAnims: this.kitAnims.size,
        ms: Date.now() - startedAt,
      },
      bodySize: 0,
      consumed: 0,
    });
  }

  /** The narrow `Spell.dbc` pass described in the header. */
  private async loadSpells(): Promise<Map<number, SpellRow>> {
    const raw = await new Loader().load('DBFilesClient\\Spell.dbc');
    const view = new DataView(raw);
    const bytes = new Uint8Array(raw);

    // WDBC header: signature, recordCount, fieldCount, recordSize, stringBlockSize.
    const recordCount = view.getUint32(4, true);
    const fieldCount = view.getUint32(8, true);
    const recordSize = view.getUint32(12, true);
    const HEADER = 20;
    const stringBlock = HEADER + recordCount * recordSize;

    // A definition that disagrees with the file is the failure mode `dbc/index.js#stridedRecord` exists
    // to contain, and here there is no entity to fall back on -- so refuse rather than read garbage.
    if (recordSize !== fieldCount * 4) {
      throw new Error(
        `Spell.dbc: recordSize ${recordSize} is not fieldCount ${fieldCount} * 4; column indices in `
          + 'spell-data.ts assume a uniform 4-byte column',
      );
    }
    if (fieldCount <= COL.name) {
      throw new Error(`Spell.dbc: only ${fieldCount} columns, expected more than ${COL.name}`);
    }

    const readString = (offset: number): string => {
      if (offset <= 0) {
        return '';
      }
      let end = stringBlock + offset;
      while (end < bytes.length && bytes[end] !== 0) {
        end += 1;
      }
      // The string block is UTF-8 in this build; `TextDecoder` is in every browser this client targets
      // and is already used elsewhere in the pipeline.
      return new TextDecoder().decode(bytes.subarray(stringBlock + offset, end));
    };

    const rows = new Map<number, SpellRow>();
    for (let i = 0; i < recordCount; i += 1) {
      const at = HEADER + i * recordSize;
      const col = (index: number) => view.getUint32(at + index * 4, true);
      const id = col(COL.id);
      if (id === 0) {
        continue;
      }
      rows.set(id, {
        id,
        name: readString(col(COL.name)),
        iconID: col(COL.iconID),
        visualID: col(COL.visual),
        castingTimeIndex: col(COL.castingTimeIndex),
        powerType: col(COL.powerType),
        manaCost: col(COL.manaCost),
      });
    }
    return rows;
  }

  // -- Lookups. Each answers null until `ensureLoaded` settles. ------------------------------------

  spell(spellId: number): SpellRow | null {
    return this.spells?.get(spellId) ?? null;
  }

  /**
   * The icon texture path for a spell, e.g. `Interface\Icons\Spell_Fire_FlameBolt`.
   *
   * Returned WITHOUT an extension, which is what `SpellIcon.dbc` stores and what the art layer wants:
   * `art.ts#load` appends `.blp` itself when a path carries no `.`.
   */
  iconPath(spellId: number): string | null {
    const row = this.spell(spellId);
    if (row === null) {
      return null;
    }
    return this.icons?.get(row.iconID) ?? null;
  }

  /**
   * The `AnimationData.dbc` id the caster's body plays when this spell goes off, or null.
   *
   * The chain is the reference's (`benilla-formats/src/spell_visual/mod.rs`):
   * `Spell.dbc.visualIDs[0]` -> `SpellVisual.dbc.castKitID` -> `SpellVisualKit.dbc.animID`. Verified
   * end to end on the served 3.3.5a files against benilla's own byte-verified example -- spell 133
   * Fireball -> visual 67 -> cast kit 38 -> anim **53** (`SpellCastDirected`), which is exactly what
   * `spell_visual/mod.rs:78-79` records. Also checked: 585 Smite -> 128 / 119 -> 53, 2098 Eviscerate ->
   * 671 / 733 -> 57, 78 Heroic Strike -> 39 / 324 -> 57.
   *
   * Null is a real answer and not a failure: spell 6603 Auto Attack has `visualID = 0` and therefore no
   * kit and no anim, which is correct -- its animation comes from `SMSG_ATTACKERSTATEUPDATE`, one clip
   * per swing, which `network/game/object/combat.ts` already drives.
   */
  castAnimation(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null || row.visualID === 0) {
      return null;
    }
    const kit = this.castKits?.get(row.visualID);
    if (!kit) {
      return null;
    }
    return this.kitAnims?.get(kit) ?? null;
  }
}

export const spellData = new SpellData();

if (typeof window !== 'undefined') {
  (window as any).spellData = spellData;
}
