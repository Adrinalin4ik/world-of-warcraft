/**
 * THE AURA RING -- `window.auraWire.history()` / `.census()` / `.diagnose(...)`.
 *
 * The same instrument `combat-wire.ts` is, for the two packets that carry buffs and debuffs
 * (`network/game/object/auras.ts`). It exists for the same reason and it is the ONLY oracle those
 * layouts have: no DBC states a packet body, the client's own Lua is handed already-decoded values,
 * and **the reference cannot corroborate this family at all** -- 1.12 had no `SMSG_AURA_UPDATE`, it
 * carried auras in the unit's own update fields, so there is nothing in `samples/benilla/` to compare
 * a byte offset against.
 *
 * ## WHY THE PLAIN `header + count * stride` DIAGNOSTIC DOES NOT APPLY HERE, and what replaces it
 *
 * `CLAUDE.md`'s residual rule divides the remainder by the wire count to separate "wrong inside the
 * row" from "header moved" from "over-read". That division assumes a FIXED stride, and an aura entry
 * has a VARIABLE one: the caster guid is present only when the aura is not self-cast, and the two
 * duration words only when the duration flag is set. So an entry is 5, 5+packedGuid, 13 or
 * 13+packedGuid bytes.
 *
 * `diagnose` below keeps the three-way discrimination and gets the localisation from the loop instead:
 * the handler reports how many entries it read AND the byte index each entry started at, so
 *
 *  - `THREW` -- an over-read. The stride was too large for at least one entry (a flag misread as
 *    "duration present" reads 8 bytes that are not there). This is the case a residual cannot express.
 *  - `perEntry` a whole number -- every entry is wrong by that many bytes, which is a field width.
 *  - `perEntry` null with a non-zero residual -- the entries closed and the HEADER or the TAIL moved
 *    (the unit's packed guid read at the wrong width is the only header this family has).
 *  - residual 0 -- the body closed exactly. For `SMSG_AURA_UPDATE_ALL` that is the whole statement,
 *    because the packet has no optional tail at all: it is a guid and then entries to the end.
 *
 * A CORRECT reading of this family closes to residual ZERO, which is a stronger check than the combat
 * log's "one repeated residual" -- there is no unread optional tail to excuse a remainder.
 */

/** How many rows the ring keeps. Auras arrive in bursts on entering the world and then rarely. */
const HISTORY = 400;

export interface AuraWireRow {
  at: number;
  /** `SMSG_AURA_UPDATE`, `SMSG_AURA_UPDATE_ALL`, or one of those with a `!THREW` / `!EMPTY` suffix. */
  opcode: string;
  /** The unit the packet is about, normalised by `guid-hex.ts`. */
  unit: string;
  /** How many aura entries the loop read before it stopped. */
  entries: number;
  /** Slots touched, in wire order. A removal is a slot whose spell id came through as 0. */
  slots: number[];
  /** Spell ids in the same order; 0 for a removal. */
  spellIds: number[];
  bodySize: number;
  consumed: number;
}

/** What a residual MEANS, not merely what it is. See the file header for the three-way split. */
export interface AuraResidual {
  residual: number;
  /** The per-entry byte error when the residual divides evenly by a non-zero entry count, else null. */
  perEntry: number | null;
  kind: 'closed' | 'per-entry' | 'header-or-tail' | 'over-read';
}

/**
 * Name the error rather than only report it.
 *
 * `threw` is passed separately because an over-read is the one failure the arithmetic cannot see: the
 * decode died inside `byte-buffer` and `consumed` is wherever it got to, which can look like any of the
 * other three. It is therefore checked FIRST.
 */
export function diagnose(bodySize: number, consumed: number, entries: number, threw: boolean): AuraResidual {
  const residual = bodySize - consumed;
  if (threw) {
    return { residual, perEntry: null, kind: 'over-read' };
  }
  if (residual === 0) {
    return { residual, perEntry: null, kind: 'closed' };
  }
  if (entries > 0 && residual % entries === 0) {
    return { residual, perEntry: residual / entries, kind: 'per-entry' };
  }
  return { residual, perEntry: null, kind: 'header-or-tail' };
}

class AuraWire {
  private rows: AuraWireRow[] = [];

  record(row: AuraWireRow): void {
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  history(): readonly AuraWireRow[] {
    return this.rows;
  }

  /**
   * Per opcode: packets, entries, and the DIAGNOSED residuals -- the `kind` strings rather than bare
   * numbers, because a number alone is what the plain residual already reported and it is the part that
   * has repeatedly needed a second look.
   *
   * `packets` here really is packets: unlike the combat log's periodic arm, this ring records ONE row
   * per packet with the entry count inside it, so a 20-aura `SMSG_AURA_UPDATE_ALL` is one row.
   */
  census(): unknown {
    const groups = new Map<string, AuraWireRow[]>();
    for (const row of this.rows) {
      const list = groups.get(row.opcode) ?? [];
      list.push(row);
      groups.set(row.opcode, list);
    }
    return [...groups.entries()].map(([opcode, rows]) => ({
      opcode,
      packets: rows.length,
      entries: rows.reduce((sum, r) => sum + r.entries, 0),
      residuals: [...new Set(rows.map((r) => {
        const d = diagnose(r.bodySize, r.consumed, r.entries, opcode.endsWith('!THREW'));
        return `${d.kind}:${d.residual}${d.perEntry === null ? '' : `/entry ${d.perEntry}`}`;
      }))],
      units: [...new Set(rows.map((r) => r.unit))].length,
      slots: [...new Set(rows.flatMap((r) => r.slots))].sort((a, b) => a - b),
    }));
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const auraWire = new AuraWire();

if (typeof window !== 'undefined') {
  (window as any).auraWire = auraWire;
}
