/**
 * `CreatureType.dbc` -- the word a unit tooltip puts after its level. "Beast", "Humanoid", "Undead".
 *
 * The owner sent the real client's tooltip beside ours: his reads **"Животное 1-го уровня"** -- Beast,
 * level 1 -- and ours had no type at all. I had claimed the type was not obtainable because
 * `SMSG_CREATURE_QUERY_RESPONSE` "gives us name and rank only". **That was wrong, and our own decode
 * says so**: `object/combat.ts` reads `type_flags`, `type`, `family` and `rank` in sequence and
 * DISCARDS the first three, with the comment `// type (CreatureType.dbc)` naming this table. The claim
 * was about the `CreatureInfo` interface, not about the packet. Read the real thing first.
 *
 * ## MEASURED on the served file
 *
 * `dbfilesclient/creaturetype.dbc`: `recordCount 13`, `fieldCount 19`, `recordSize 76`,
 * `stringBlockSize 119`, and `20 + 13*76 + 119 = 1127` -- the exact file size. The existing entity
 * (`entities/creature-type.js`) declares `id(1) + name(17) + noExperience(1) = 19`, which matches the
 * header exactly, so unlike `Faction.dbc` this definition needed no repair. All thirteen rows read back
 * cleanly at field 1:
 *
 *     1 Beast        2 Dragonkin   3 Demon      4 Elemental   5 Giant     6 Undead   7 Humanoid
 *     8 Critter      9 Mechanical  10 Not specified          11 Totem    12 Non-combat Pet
 *     13 Gas Cloud
 *
 * `1 -> Beast` is the owner's "Животное", which is the check on the whole join.
 *
 * ## Cost
 *
 * 1127 bytes, fetched once and cached by `DBC.load`, kicked by the unit bridge rather than awaited --
 * every reader answers null until it lands and a tooltip built a moment early simply has no type word.
 */
import DBC from './index';

class CreatureTypeData {
  private byId = new Map<number, string>();

  private pending: Promise<void> | null = null;

  /** Idempotent, and safe to await more than once -- the contract `raceClassData` has. */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load();
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('CreatureType');
    for (const record of (table as unknown as { records?: unknown[] }).records ?? []) {
      const rec = record as Record<string, unknown> | null;
      if (!rec || typeof rec.id !== 'number' || typeof rec.name !== 'string' || rec.name === '') {
        continue;
      }
      this.byId.set(rec.id, rec.name);
    }
  }

  /**
   * The localised type word for a `CreatureType.dbc` id, or null.
   *
   * Null for 0 as well as for an unknown id: 0 is not a row in this table -- the ids run 1..13 -- so it
   * is what a unit whose creature query has not answered yet carries, and a tooltip must show no type
   * word rather than a wrong one.
   */
  name(id: number): string | null {
    return this.byId.get(id) ?? null;
  }
}

export const creatureTypeData = new CreatureTypeData();
