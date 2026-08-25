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

  /**
   * For a `header + count * stride + tail` body: the COUNT the header declared, stashed BEFORE the row
   * loop ran.
   *
   * Optional because most packets in this family are a fixed shape and have no count to divide by;
   * `items.ts` and `loot.ts` leave both of these alone. `SMSG_LIST_INVENTORY` sets them.
   *
   * "Before the loop" is the load-bearing part: if the stride is wrong the loop either over-reads and
   * THROWS or under-reads and leaves a remainder, and in the throwing case this is the one number still
   * needed to tell those apart. Reading it off the decoded array afterwards would give the wrong answer
   * in exactly the case that matters.
   */
  wireCount?: number;

  /**
   * `residual / wireCount` when it divides exactly, else `null` -- **the discriminator, not a statistic.**
   *
   * Ported from `network/game/object/trainer.ts#record`, where it was introduced (`2690666`), because a
   * widened field and a moved header need different fixes and this separates them in one reading:
   *
   *  - **a whole number** -> the error is INSIDE THE ROW, by that many bytes per row. A field widened
   *    (`u8` -> `u32` is +3) or one was inserted (+4 for a word). Fix the row.
   *  - **`null` with a nonzero residual** -> the stride is right and something in the HEADER or the
   *    TRAILER moved. Fix those instead.
   *  - **an opcode ending `!THREW`** -> we over-read, so the stride is too LARGE, which neither case
   *    above can express.
   *
   * `null` is therefore a real answer and not "unknown".
   */
  residualPerRow?: number | null;
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
    // The per-row discriminator, where a decode supplied one. Kept beside the raw residuals rather
    // than replacing them: the residual says THAT the layout is wrong and this says WHERE.
    const perRowByOpcode = new Map<string, Array<number | null>>();
    for (const row of this.rows) {
      if (row.residualPerRow === undefined) {
        continue;
      }
      const list = perRowByOpcode.get(row.opcode) ?? [];
      list.push(row.residualPerRow);
      perRowByOpcode.set(row.opcode, list);
    }
    return [...byOpcode.entries()].map(([opcode, residuals]) => {
      const perRow = perRowByOpcode.get(opcode);
      return {
        opcode,
        count: residuals.length,
        residuals: [...new Set(residuals)].sort((a, b) => a - b),
        worst: residuals.reduce((acc, r) => (Math.abs(r) > Math.abs(acc) ? r : acc), 0),
        // Only the NONZERO cases are worth surfacing -- a clean packet reports `residualPerRow` 0/null
        // on every row and listing that would bury the one reading that matters.
        ...(perRow && perRow.some((v) => v !== null && v !== 0)
          ? { perRow: [...new Set(perRow.filter((v) => v !== null && v !== 0))] }
          : {}),
      };
    });
  }
}

export const itemWire = new ItemWire();

(window as unknown as Record<string, unknown>).itemWire = itemWire;

export default itemWire;
