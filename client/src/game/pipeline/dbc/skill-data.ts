/**
 * THE SPELLBOOK'S TABS: which skill line each known spell belongs to, and which skill lines are tabs.
 *
 * `SpellBookFrame` groups the character's spells into up to `MAX_SKILLLINE_TABS` = 8 tabs
 * (`spellbookframe.lua:2`) and asks the engine for them through `GetNumSpellTabs` and `GetSpellTabInfo`.
 * Neither the wire nor `Spell.dbc` says which tab a spell is in: `SMSG_INITIAL_SPELLS` is a flat list of
 * ids (54 of them for the shaman test character) and `Spell.dbc` has no skill-line column. The grouping
 * is a JOIN, and this file is it.
 *
 * ## The two tables, and the columns, MEASURED on the served files
 *
 * Both entity definitions already existed and are registered (`wow-data-parser/dbc/entities/index.js:117`
 * and `:118`), and both were checked against the served bytes independently before being trusted here --
 * a definition agreeing with the file is exactly what `spell-data.ts`'s header says cannot be assumed.
 *
 * `dbfilesclient/skilllineability.dbc`: `recordCount 10219`, `fieldCount 14`, `recordSize 56`, and an
 * EMPTY string block (`stringSize 1`), which is itself a check -- every column is numeric.
 *
 *     col 0  id                col 1  skillLineID       col 2  spellID
 *     col 3  requiredRaces     col 4  requiredClasses   col 7  minRank
 *     col 8  forward_spellid   col 9  acquireMethod
 *
 * Columns 1 and 2 were found rather than transcribed: of the 14 columns, exactly ONE contains all seven
 * of a set of known spell ids (133, 331, 403, 585, 1752, 2098, 78) and that is **column 2**. Column 1
 * holds only 150 distinct values, which is `skillline.dbc`'s record count. Corroborated on record 0:
 * `skillLineID 6` (Frost), `spellID 116` (Frostbolt), `requiredClasses 128` = `1 << 7` = class 8, Mage.
 * A frost mage spell on the Frost skill line restricted to mages is three agreeing facts.
 *
 * `dbfilesclient/skillline.dbc`: `recordCount 150`, `fieldCount 56`, `recordSize 224`.
 *
 *     col 0  id     col 1  categoryID     col 2  skillCostsID
 *     col 3..19   displayName  (16 locales + a flags word = 17)
 *     col 20..36  description  (17)
 *     col 37      spellIconID
 *     col 38..54  alternateVerb (17)
 *     col 55      canLink
 *
 * `1 + 1 + 1 + 17 + 17 + 1 + 17 + 1 = 56`, exactly the file's `fieldCount` -- the layout closes with
 * nothing left over, which is the strongest check a DBC layout gets.
 *
 * ## WHICH skill lines are tabs: `categoryID == 7`
 *
 * `SkillLine.categoryID` partitions the 150 lines, and the partition is legible. Measured, with the
 * lines each class's `SkillLineAbility` rows actually point at:
 *
 *     category 6  (18)  Swords, Axes, Bows, Guns, Maces, Defense, Daggers, ...   -- WEAPON skills
 *     category 7  (75)  Frost, Fire, Arms, Combat, Subtlety, Beast Mastery, ...  -- CLASS skills
 *     category 8  (5)   Plate Mail, Mail, Leather, Cloth, Shield                 -- ARMOUR proficiencies
 *     category 9  (24)  Dwarven Racial, First Aid, Wolf Riding, Cooking, ...     -- secondary/racial
 *     category 10 (14)  Language: Common, Language: Orcish, ...                  -- LANGUAGES
 *     category 11 (11)  Blacksmithing, Alchemy, Mining, Tailoring, ...           -- PROFESSIONS
 *     category 12 (1)   `183 GENERIC (DND)`
 *
 * Category 7 is the spellbook's tab set and nothing else is. For the shaman test character it is exactly
 * **373 Enhancement, 374 Restoration, 375 Elemental Combat** -- three tabs, which is what a shaman's book
 * has; a mage gets 6 Frost / 8 Fire / 237 Arcane, a warrior 26 Arms / 256 Fury / 257 Protection. The
 * armour and weapon proficiencies a character also knows (Mail, Shield, Axes) are NOT tabs in the real
 * client, and category 8/6 is what keeps them out.
 *
 * **The FIRST tab is "General" and it is not a skill line at all.** Its name is the client's own
 * `GENERAL_SPELLS` global string (`globalstrings.lua:3792`, `= "General"`), and it holds every known
 * spell that no category-7 line claims -- racials, First Aid, armour proficiencies, Auto Attack. That is
 * why it exists: without it those spells would be in the book's index and in no tab, and
 * `SpellBook_GetSpellID`'s arithmetic would walk off the end of the last tab's range.
 * `183 GENERIC (DND)` is deliberately NOT used for it -- that row's `displayName` is the literal string
 * "GENERIC (DND)", a developer placeholder, and it is category 12, not 7.
 *
 * ## WHAT IS NOT SOURCED, stated rather than left to look deliberate
 *
 * The ORDER of the category-7 tabs after General. Nothing in either table sorts them: `SkillLine` has no
 * sort column (`skillCostsID` is a cost table id and `spellIconID` is art), and `SkillLineCategory.dbc`
 * orders the CATEGORIES, not the lines inside one. They are ordered here by ascending `SkillLine.id`,
 * which is OURS. The real client's order for a shaman is General / Elemental Combat / Enhancement /
 * Restoration, and ascending id gives General / Enhancement / Restoration / Elemental Combat -- so this
 * is known to differ from the real client in the ORDER of the three, while the SET and the contents of
 * each are right. Fixing it needs the engine's real sort key, which is not in these two files.
 */
import DBC from './index';

/** One `SkillLine.dbc` row, narrowed to what a tab needs. */
export interface SkillLineRow {
  id: number;
  /** 7 is the CLASS-skill category -- the spellbook's tabs. See the header for the whole partition. */
  categoryID: number;
  name: string;
  /** `SpellIcon.dbc` id, which is why `spellData.icon()` resolves a tab's texture. */
  spellIconID: number;
}

/**
 * `SkillLine.categoryID` for CLASS skills -- the one category the spellbook makes tabs out of.
 *
 * Measured, not transcribed: see the category table in the header. A shaman's three category-7 lines are
 * his three book tabs and his category-6/8 lines (Axes, Maces, Mail, Shield) are correctly not tabs.
 */
export const SKILL_CATEGORY_CLASS = 7;

class SkillData {
  /** `SkillLine.dbc` id -> the row. */
  private lines: Map<number, SkillLineRow> | null = null;

  /**
   * spell id -> the CLASS skill line that claims it (category 7 only).
   *
   * Only category-7 rows are indexed, because only they can be a tab: a spell that appears on a weapon
   * or armour line and nowhere else belongs in General, and keeping those rows out of this map is what
   * makes that fall out rather than needing a second test at every lookup.
   *
   * A spell can have SEVERAL `SkillLineAbility` rows (one per class that learns it). The first
   * category-7 row wins, which is unambiguous in practice for a class spell -- a spell restricted to one
   * class has one such row -- and is stated because nothing here checks the player's class against
   * `requiredClasses`. It does not need to: the spell set comes from `SMSG_INITIAL_SPELLS`, so every
   * spell being grouped is one this character actually knows.
   */
  private lineOfSpell: Map<number, number> | null = null;

  private pending: Promise<void> | null = null;

  get ready(): boolean {
    return this.lines !== null && this.lineOfSpell !== null;
  }

  /**
   * Load both tables, once. Idempotent.
   *
   * 572 KB + 39 KB, so unlike `Spell.dbc`'s 49 MB there is no starvation hazard here and no reason to
   * hand-decode: both go through `DBC.load` like every other table in this client, which is the rule
   * `spell-data.ts` deviates from only because of its size.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure can be retried. The spellbook shows ONE tab (General) holding
        // every known spell until then -- see `spellbook.ts#buildSpellbook`, which treats "not loaded"
        // as "no class lines", not as an error. That is a degraded book, not a wrong one.
        this.pending = null;
        console.warn('skillData: load failed, the spellbook will show a single General tab', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const [lines, abilities] = await Promise.all([
      DBC.load('SkillLine'),
      DBC.load('SkillLineAbility'),
    ]);

    this.lines = new Map<number, SkillLineRow>();
    for (const record of (lines as any).records ?? []) {
      if (!record || typeof record.id !== 'number') {
        continue;
      }
      this.lines.set(record.id, {
        id: record.id,
        categoryID: record.categoryID ?? 0,
        // `LocalizedStringRef` returns locale 0, which is enUS on the served files.
        name: typeof record.name === 'string' ? record.name : '',
        spellIconID: record.spellIconID ?? 0,
      });
    }

    this.lineOfSpell = new Map<number, number>();
    for (const record of (abilities as any).records ?? []) {
      const spellID = record?.spellID;
      const skillLineID = record?.skillLineID;
      if (typeof spellID !== 'number' || spellID === 0 || typeof skillLineID !== 'number') {
        continue;
      }
      if (this.lines.get(skillLineID)?.categoryID !== SKILL_CATEGORY_CLASS) {
        continue;
      }
      if (!this.lineOfSpell.has(spellID)) {
        this.lineOfSpell.set(spellID, skillLineID);
      }
    }
  }

  /** The class skill line that claims this spell, or null -- which means "General tab". */
  classLineOf(spellId: number): SkillLineRow | null {
    const lineId = this.lineOfSpell?.get(spellId);
    if (lineId === undefined) {
      return null;
    }
    return this.lines?.get(lineId) ?? null;
  }

  line(id: number): SkillLineRow | null {
    return this.lines?.get(id) ?? null;
  }
}

export const skillData = new SkillData();

if (typeof window !== 'undefined') {
  (window as any).skillData = skillData;
}
