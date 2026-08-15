/**
 * WHAT THE ITEM AND LOOT PACKETS ACTUALLY DELIVERED -- `window.itemWire`.
 *
 * The ONLY oracle the layouts in `network/game/object/items.ts` and `.../loot.ts` have. Both are
 * transcribed from a SERVER implementation (TrinityCore 3.3.5), because nothing in the game's own data
 * states a packet body, and the project has been bitten three times by a 1.12 layout read against a
 * 3.3.5a wire. `consumed` against `bodySize` is the check: a layout that is right consumes its packet
 * exactly, and one that is wrong lands somewhere arbitrary.
 *
 * `SMSG_ITEM_QUERY_SINGLE_RESPONSE` is the sharp case. WotLK made the stat array VARIABLE-LENGTH by
 * putting a `statsCount` word in front of it, so a 1.12 transcription does not end early -- it desyncs
 * mid-body and every field after the stats, including the quality and the display id, comes out of the
 * middle of some other field. Reading the NAME back correctly is not proof of much (the name sits
 * before the stats); a **zero residual** is.
 *
 * ALWAYS ON, like `combatWire` and for the same reason: these are a handful of small objects per
 * looting, and the next person to ask "what does the wire really say" should be able to read it rather
 * than re-derive it.
 *
 * `!THREW` rows are decodes that ran past their frame. A `!THREW` row's `consumed` is where the read
 * cursor died, which is the most useful number in the file when a layout is wrong.
 */
export interface ItemWireRow {
  at: number;
  /** Opcode name, with `!THREW` appended when the decode over-read, or `(miss)` on a negative answer. */
  opcode: string;
  /** The item entry this row concerns, or 0 where the packet names none. */
  entry: number;
  /** The decoded name, where the packet carries one. Blank otherwise. */
  name: string;
  bodySize: number;
  /** Bytes of body consumed by the decode. Compare with `bodySize`; equal is the pass. */
  consumed: number;
}

const HISTORY = 400;

class ItemWire {
  private rows: ItemWireRow[] = [];

  record(row: ItemWireRow): void {
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  history(): readonly ItemWireRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows = [];
  }

  /**
   * THE RESIDUAL CENSUS -- `window.itemWire.census()`.
   *
   * One row per opcode: how many arrived, and the set of distinct `bodySize - consumed` residuals seen.
   * `residuals: [0]` on a real packet is the pass. Anything else names a layout defect, and the
   * `worst` value says how far out it is.
   *
   * A `count` of zero is impossible here by construction (a row only exists because a packet arrived),
   * which is the failure mode a previous census in this codebase actually had -- it was blind to the
   * count it was meant to report. This one reports the census of what it holds and claims nothing about
   * packets it never saw; use `history()` to check an opcode is arriving at all.
   */
  census(): Array<{ opcode: string; count: number; residuals: number[]; worst: number }> {
    const byOpcode = new Map<string, number[]>();
    for (const row of this.rows) {
      const list = byOpcode.get(row.opcode) ?? [];
      list.push(row.bodySize - row.consumed);
      byOpcode.set(row.opcode, list);
    }
    return [...byOpcode.entries()].map(([opcode, residuals]) => ({
      opcode,
      count: residuals.length,
      residuals: [...new Set(residuals)].sort((a, b) => a - b),
      worst: residuals.reduce((acc, r) => (Math.abs(r) > Math.abs(acc) ? r : acc), 0),
    }));
  }
}

export const itemWire = new ItemWire();

(window as unknown as Record<string, unknown>).itemWire = itemWire;

export default itemWire;
