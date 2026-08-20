/**
 * THE REPUTATION PANE'S FACTIONS: `Faction.dbc`, joined into the header/child tree the pane draws.
 *
 * `ReputationFrame_Update` asks the engine for a FLAT list of rows through `GetNumFactions` and
 * `GetFactionInfo(index)`, where each row carries `isHeader`/`isChild` and the pane turns those into the
 * tree lines (`reputationframe.lua:158,182-215`). Nothing on the wire says which faction is a header:
 * `SMSG_INITIALIZE_FACTIONS` is 128 (flags, standing) pairs and nothing else. The tree is a JOIN over
 * `Faction.dbc`'s `parentID`, and this file is it.
 *
 * ## The columns, MEASURED on the served file
 *
 * `dbfilesclient/faction.dbc`: `recordCount 401`, `fieldCount 57`, `recordSize 228`,
 * `stringBlockSize 17339`, and `20 + 401*228 + 17339 = 108787` -- the exact file size, which is the
 * strongest check a DBC layout gets. `entities/faction.js` was FOUR columns short before this work (it
 * omitted 3.3.5's `parentFactionMod[2]`/`parentFactionCap[2]`) and read every name and description from
 * the wrong offset; see that file's header for the measurement.
 *
 * **`parentFactionMod`/`parentFactionCap` are declared there and never read here, deliberately.** They
 * are the SERVER's spillover rule -- how much reputation earned on a child propagates to its parent, and
 * the cap on it -- and grepping the whole served FrameXML for `FactionMod`, `FactionCap` and
 * `parentFaction` finds no Lua or XML use at all. They exist in the definition only because omitting
 * them is what shifted the name column. Inert for display, load-bearing for the offsets.
 *
 * ## What is OURS, and it is stated rather than implied
 *
 * **The ROW ORDER.** `Faction.dbc` has no display-order column in 3.3.5a, and the real client's order
 * comes from the engine's own faction list, which is not in any served file. Rows are emitted in the
 * DBC's own record order, a header followed by that header's children -- the same choice, and the same
 * reasoning, as the Skills tab's categories (`skill-data.ts`, `SkillLineCategory` in "its own order").
 * It is a stable, legible order; it is NOT claimed to be the real client's.
 *
 * **Which factions are headers** is derived, not read: a faction is a header if any other faction names
 * it as `parentID`. MEASURED on the served file -- 14 distinct factions are referenced as a parent, and
 * every one of the 401 rows carries a `parentID` that is either 0 or a real faction id, with **zero**
 * exceptions, which is what makes the derivation safe. Note a header can itself hold reputation
 * (`Horde` is `reputationIndex` 12, `Alliance` is 11), so "is a header" and "has rep" are independent --
 * which is exactly why `GetFactionInfo` returns both `isHeader` and `hasRep`.
 */
import DBC from './index';

/** One `Faction.dbc` row, reduced to what the pane needs. */
export interface FactionRow {
  id: number;
  /** `reputationIndex`, or -1 for a faction the player can hold no standing with. */
  index: number;
  /** `parentID`, or 0 for a root. */
  parentId: number;
  name: string;
  description: string;
}

/** A row as the pane sees it: an entry in the flat list `GetFactionInfo` indexes into. */
export interface FactionDisplayRow {
  row: FactionRow;
  /** Any other faction names this one as its parent. */
  isHeader: boolean;
  /** This faction sits under a header, i.e. it is drawn indented. */
  isChild: boolean;
}

class FactionData {
  private byId = new Map<number, FactionRow>();

  private order: FactionRow[] = [];

  private headers = new Set<number>();

  private pending: Promise<void> | null = null;

  /** Idempotent, and safe to await more than once -- the same contract `raceClassData` has. */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load();
    }
    return this.pending;
  }

  /** Whether the table has landed. Callers answer nothing until it has, rather than guessing. */
  get loaded(): boolean {
    return this.order.length > 0;
  }

  private async load(): Promise<void> {
    const table = await DBC.load('Faction');
    for (const record of (table as unknown as { records?: unknown[] }).records ?? []) {
      const rec = record as Record<string, unknown> | null;
      if (!rec || typeof rec.id !== 'number') {
        continue;
      }
      const row: FactionRow = {
        id: rec.id,
        index: typeof rec.index === 'number' ? rec.index : -1,
        parentId: typeof rec.parentID === 'number' ? rec.parentID : 0,
        name: typeof rec.name === 'string' ? rec.name : '',
        description: typeof rec.description === 'string' ? rec.description : '',
      };
      // A row with no name cannot be drawn and cannot be a useful header. 401 rows in the file, 105 of
      // which carry both an index and a name.
      if (row.name === '') {
        continue;
      }
      this.byId.set(row.id, row);
      this.order.push(row);
    }
    for (const row of this.order) {
      if (row.parentId !== 0 && this.byId.has(row.parentId)) {
        this.headers.add(row.parentId);
      }
    }
  }

  /** The row for a faction id, or null. */
  byFactionId(id: number): FactionRow | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * The flat display list, each header followed by its children.
   *
   * `visible` decides which factions the character actually knows -- the wire's own
   * `FACTION_FLAG_VISIBLE` bit, passed IN rather than read here so this module stays a pure DBC join
   * with no dependency on the network layer.
   *
   * A header is emitted only if it is visible itself or has at least one visible descendant: the real
   * client shows no empty groups, which is the rule `skills-bridge.ts` already applies to a category
   * with no skills.
   */
  displayRows(visible: (index: number) => boolean): FactionDisplayRow[] {
    const shown = (row: FactionRow): boolean => row.index >= 0 && visible(row.index);
    const childrenOf = new Map<number, FactionRow[]>();
    for (const row of this.order) {
      if (row.parentId === 0 || !this.byId.has(row.parentId)) {
        continue;
      }
      const list = childrenOf.get(row.parentId);
      if (list === undefined) {
        childrenOf.set(row.parentId, [row]);
      } else {
        list.push(row);
      }
    }

    const out: FactionDisplayRow[] = [];
    const emitted = new Set<number>();

    /** Whether this subtree holds anything the character can see. Guards an empty group. */
    const anyVisible = (row: FactionRow, depth: number): boolean => {
      if (shown(row)) {
        return true;
      }
      // Bounded, because a malformed table could in principle cycle: `parentID` resolving for all 401
      // rows says nothing about the graph being acyclic.
      if (depth > 4) {
        return false;
      }
      return (childrenOf.get(row.id) ?? []).some((kid) => anyVisible(kid, depth + 1));
    };

    const emitGroup = (header: FactionRow, depth: number): void => {
      if (emitted.has(header.id) || depth > 4 || !anyVisible(header, 0)) {
        return;
      }
      out.push({ row: header, isHeader: true, isChild: depth > 0 });
      emitted.add(header.id);
      for (const kid of childrenOf.get(header.id) ?? []) {
        if (emitted.has(kid.id)) {
          continue;
        }
        if (this.headers.has(kid.id)) {
          emitGroup(kid, depth + 1);
        } else if (shown(kid)) {
          out.push({ row: kid, isHeader: false, isChild: true });
          emitted.add(kid.id);
        }
      }
    };

    // Roots first, in the DBC's own record order -- see the header on why the order is ours.
    for (const row of this.order) {
      const isRoot = row.parentId === 0 || !this.byId.has(row.parentId);
      if (isRoot && this.headers.has(row.id)) {
        emitGroup(row, 0);
      }
    }
    // Then anything visible that no header claimed -- a faction whose parent chain is absent from the
    // table, or a root with no children. Emitted flat rather than dropped, because a standing the
    // server actually sent must not vanish from the pane.
    for (const row of this.order) {
      if (!emitted.has(row.id) && shown(row)) {
        out.push({ row, isHeader: this.headers.has(row.id), isChild: false });
        emitted.add(row.id);
      }
    }
    return out;
  }
}

export const factionData = new FactionData();
