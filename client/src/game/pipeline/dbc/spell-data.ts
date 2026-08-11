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
 * ONCE and the browser caches it. The real client reads this table out of a local MPQ, so there is no
 * upstream design to copy here.
 *
 * **WHO calls `ensureLoaded` is load-bearing, and it is NOT the packet handler.** Firing it from
 * `SMSG_INITIAL_SPELLS` -- which arrives in the login burst -- put this 49 MB fetch in contention with
 * `FrameXML.toc`'s 264 small fetches over the same connection and STARVED them: measured, the FrameXML
 * boot did not finish in 240 s and `window.worldRuntime` never appeared, with nothing logged anywhere.
 * The caller is `ui/action-bridge.ts`, which attaches only after the manifest is loaded. Every consumer
 * tolerates "not yet" and the bridge re-pushes when this settles, so the bar comes up with the right
 * shape first and the icons land a moment later.
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
 *
 * ## THE GLOBAL COOLDOWN's column, measured
 *
 * `StartRecoveryTime` is **column 206** and `StartRecoveryCategory` is **205**. Derived from
 * `wow-data-parser/dbc/entities/spell.js` -- which the four indices above already corroborate, and whose
 * total is exactly the file's 234 -- and then verified by reading the served `spell.dbc` directly
 * (header + the first 2000 records, over an HTTP range request):
 *
 *     spell  133 Fireball        col 205 = 133   col 206 = 1500
 *     spell  331 Healing Wave    col 205 = 133   col 206 = 1500
 *     spell  403 Lightning Bolt  col 205 = 133   col 206 = 1500
 *     spell 1752 Sinister Strike col 205 = 133   col 206 = 1000
 *     spell 2098 Eviscerate      col 205 = 133   col 206 = 1000
 *     spell   78 Heroic Strike   col 205 = 0     col 206 = 0
 *     spell 6603 Auto Attack     col 205 = 0     col 206 = 0
 *
 * That is the 3.3.5a rule reading back exactly: 1.5 s for a spell, 1.0 s for an energy ability, and
 * ZERO for Heroic Strike and Auto Attack, which are on-next-swing and genuinely off the global cooldown.
 * Category 133 is the shared GCD group; category 0 is "this spell triggers no GCD".
 *
 * **The GCD is not on the wire.** Nothing the server sends carries it -- `SMSG_SPELL_GO` has
 * `castFlags` and a timestamp and no recovery field, and `SMSG_SPELL_COOLDOWN` (0x134) carries only real
 * per-spell cooldowns. The 3.3.5a client computes the global cooldown ITSELF from this column when a cast
 * is confirmed, which is why it appears instantly in the real client and why this is a DBC read and not a
 * packet decode. `recoveryTimeMs` (29) and `categoryRecoveryTimeMs` (30) are the real cooldowns and read
 * 0 for every spell sampled above, so on these characters the GCD is the only cooldown to be seen.
 */
import DBC from './index';
import Loader from '../../net/loader';
import { spellWire } from '../../classes/spell-wire';

/** `Spell.dbc` column indices for 3.3.5a build 12340. See the header for how each was established. */
const COL = {
  id: 0,
  /** `Category` -- the shared-cooldown group `CategoryRecoveryTime` applies across. */
  category: 1,
  castingTimeIndex: 28,
  /** `RecoveryTime` (ms): this spell's OWN cooldown. */
  recoveryTime: 29,
  /** `CategoryRecoveryTime` (ms): the cooldown put on every spell sharing `category`. */
  categoryRecoveryTime: 30,
  powerType: 41,
  manaCost: 42,
  /** `rangeIndex` -> `SpellRange.dbc`, which is what `IsActionInRange` needs. */
  rangeIndex: 46,
  /** `ManaCostPercentage` -- a PERCENT OF BASE MANA, used instead of `manaCost` by most caster spells. */
  manaCostPercentage: 204,
  /** `StartRecoveryCategory`: 133 is the shared global-cooldown group; 0 means the spell is off-GCD. */
  startRecoveryCategory: 205,
  /** `StartRecoveryTime` (ms) -- THE GLOBAL COOLDOWN. See the header for the measurement. */
  startRecoveryTime: 206,
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
  /** `Category`. 0 for a spell in no shared-cooldown group. */
  category: number;
  /** This spell's own cooldown, in MILLISECONDS. 0 for a spell with none. */
  recoveryTimeMs: number;
  /** The cooldown put on every spell sharing `category`, in milliseconds. */
  categoryRecoveryTimeMs: number;
  /** The GLOBAL COOLDOWN this spell triggers, in milliseconds. 0 for an off-GCD spell. */
  startRecoveryTimeMs: number;
  /** The GCD group. 133 is 3.3.5a's shared category; 0 means this spell triggers no GCD. */
  startRecoveryCategory: number;
  /** `SpellRange.dbc` id. */
  rangeIndex: number;
  /** Percent of BASE mana, used where `manaCost` is 0. See `spellCost` for why both are needed. */
  manaCostPercentage: number;
}

class SpellData {
  private spells: Map<number, SpellRow> | null = null;

  private icons: Map<number, string> | null = null;

  /** `SpellVisual.dbc` id -> its cast-stage kit id. */
  private castKits: Map<number, number> | null = null;

  /**
   * `SpellVisual.dbc` id -> its PRECAST-stage kit id -- the held pose, not the release.
   *
   * See `precastAnimation` for the measurement that establishes field 1 as the held pose and field 2 as
   * the release. This is a separate map rather than a second lookup on `castKits` because the two
   * columns answer two different questions at two different moments of one cast.
   */
  private precastKits: Map<number, number> | null = null;

  /** `SpellVisualKit.dbc` id -> its `animID`, sentinels already folded away. */
  private kitAnims: Map<number, number> | null = null;

  /** `SpellRange.dbc` id -> `maxRangeHostile`, in YARDS. What `IsActionInRange` is judged against. */
  private ranges: Map<number, number> | null = null;

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
    // `SpellRange` rides with these four rather than getting a module of its own like
    // `shapeshift-data.ts` did, and the difference is which table its consumer needs FIRST: the bonus bar
    // must not wait on 49 MB because it decides which slots the buttons address, whereas a range check is
    // useless without `Spell.dbc`'s own `rangeIndex` anyway. It is 6 KB behind a fetch that is already
    // happening.
    const [spells, icons, visuals, kits, ranges] = await Promise.all([
      this.loadSpells(),
      DBC.load('SpellIcon'),
      DBC.load('SpellVisual'),
      DBC.load('SpellVisualKit'),
      DBC.load('SpellRange'),
    ]);

    this.ranges = new Map<number, number>();
    for (const record of (ranges as any).records ?? []) {
      // `maxRangeHostile` is the one a cast at an enemy is judged by; `maxRangeFriendly` differs only for
      // a handful of spells and the client uses the hostile value for the indicator. Both are YARDS, as
      // floats (`wow-data-parser/dbc/entities/spell-range.js`).
      if (record && typeof record.maxRangeHostile === 'number') {
        this.ranges.set(record.id, record.maxRangeHostile);
      }
    }

    this.spells = spells;

    this.icons = new Map<number, string>();
    for (const record of (icons as any).records ?? []) {
      if (record && typeof record.file === 'string' && record.file !== '') {
        this.icons.set(record.id, record.file);
      }
    }

    this.castKits = new Map<number, number>();
    this.precastKits = new Map<number, number>();
    for (const record of (visuals as any).records ?? []) {
      if (record && record.castKitID) {
        this.castKits.set(record.id, record.castKitID);
      }
      // `0xFFFFFFFF` as well as 0 -- the same dual none-sentinel the kit table carries, and it appears
      // in this column too: a visual with no precast stage writes either form.
      if (record && record.precastKitID && record.precastKitID !== 0xffffffff) {
        this.precastKits.set(record.id, record.precastKitID);
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
      kind: 'TABLES_LOADED',
      spellId: 0,
      caster: null,
      detail: {
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
        category: col(COL.category),
        recoveryTimeMs: col(COL.recoveryTime),
        categoryRecoveryTimeMs: col(COL.categoryRecoveryTime),
        startRecoveryTimeMs: col(COL.startRecoveryTime),
        startRecoveryCategory: col(COL.startRecoveryCategory),
        rangeIndex: col(COL.rangeIndex),
        manaCostPercentage: col(COL.manaCostPercentage),
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
  /**
   * A spell's maximum range in YARDS, or null when it has none to check.
   *
   * Null for three distinct cases that all mean "no range indicator": the tables are not loaded, the
   * spell is unknown, or its range is 0 -- which is `SpellRange.dbc` id 1 ("Self Only") and id 2 ("Combat
   * Range", whose max is 0 because melee reach is computed from the two units' bounding radii and not
   * from this table). Melee therefore reports no range rather than a wrong one, which is correct
   * behaviour and not a gap: the real client shows no range dot on Heroic Strike either.
   */
  maxRange(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null) {
      return null;
    }
    const yards = this.ranges?.get(row.rangeIndex) ?? null;
    return yards !== null && yards > 0 ? yards : null;
  }

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

  /**
   * The `AnimationData.dbc` id the caster's body HOLDS for the duration of a cast, or null.
   *
   * `Spell.dbc.visualIDs[0]` -> `SpellVisual.dbc.`**`precastKitID`** (field 1) -> `SpellVisualKit.animID`.
   * The same chain `castAnimation` walks, one column to its left, and that column is the whole reason the
   * cast animation used to appear only at the END of a cast: field 2 is the RELEASE.
   *
   * ## WHICH FIELD IS WHICH, measured rather than assumed
   *
   * Read out of the served `dbfilesclient/spellvisual.dbc` (9406 records, fieldCount 32, recordSize 128)
   * joined to `spellvisualkit.dbc` (8663 / 38 / 152) and named through `animationdata.dbc` (506 rows).
   * Two independent facts settle it, and neither needs benilla's naming taken on trust:
   *
   * 1. **The animation NAMES the two columns resolve to are held poses on one side and strikes on the
   *    other.** Across every visual in the table, field 1's top anims are `ReadySpellOmni` (879),
   *    `ReadySpellDirected` (703), `ReadyThrown` (322), `UseStandingLoop` (188), `HoldRifle` (33),
   *    `HoldThrown` (29), `LoadBow` (19) -- Ready/Hold/Load/Loop, every one a pose. Field 2's top anims
   *    are `SpellCastOmni` (1091), `SpellCastDirected` (957), `AttackThrown` (517),
   *    `ChannelCastDirected` (131), `Special1H` (76), `Attack1H` (72) -- every one a discharge.
   * 2. **A spell that is INSTANT carries precast kit 0 and only a cast kit.** Measured: 78 Heroic Strike
   *    (visual 39) field 1 = 0, field 2 = kit 324 -> `Special1H`; 1752 Sinister Strike (253) field 1 = 0,
   *    field 2 = 399 -> `Attack1H`; 2098 Eviscerate (671) field 1 = 0, field 2 = 733 -> `Special1H`.
   *    An instant has no cast phase to hold and the table says so, which is why this method needs no
   *    special case for one -- it answers null and only the release plays.
   *
   * The timed spells on the test characters read, on the same files:
   *
   *     spell  133 Fireball      visual  67  precast kit  30 -> 51 ReadySpellDirected  cast kit  38 -> 53 SpellCastDirected
   *     spell  331 Healing Wave  visual  58  precast kit 100 -> 52 ReadySpellOmni      cast kit 183 -> 54 SpellCastOmni
   *     spell  403 Lightning Bolt visual 173 precast kit 124 -> 51 ReadySpellDirected  cast kit  72 -> 53 SpellCastDirected
   *     spell  585 Smite         visual 128  precast kit 184 -> 51 ReadySpellDirected  cast kit 119 -> 53 SpellCastDirected
   *     spell 2054 Heal          visual 135  precast kit  99 -> 52 ReadySpellOmni      cast kit 270 -> 54 SpellCastOmni
   *
   * So Healing Wave holds `ReadySpellOmni` for its 1.5 s and releases `SpellCastOmni` -- which is exactly
   * what the real client shows, and exactly what benilla's own byte-verified Fireball example ("precast
   * 30 / cast 38", `benilla-formats/src/spell_visual/mod.rs:78`) reads as on this build's file too.
   *
   * NOTE what is deliberately absent: there is NO fallback. `castAnimation`'s caller substitutes
   * `SpellCastDirected` for a spell whose chain yields nothing, because a cast with no visible release is
   * worse than a generic one; a HELD pose has the opposite trade. Parking a caster in a `ReadySpell` clip
   * a kit never asked for would freeze him there for the cast's whole length, and a frozen wrong pose is
   * more misleading than no pose at all.
   */
  precastAnimation(spellId: number): number | null {
    const row = this.spell(spellId);
    if (row === null || row.visualID === 0) {
      return null;
    }
    const kit = this.precastKits?.get(row.visualID);
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
