/**
 * What the spell opcodes actually delivered -- the same instrument-first discipline as
 * `combat-wire.ts`, for the same reason: every one of these layouts was version-numbered, and the last
 * time a layout was transcribed from the 1.12.1 reference instead of measured
 * (`SMSG_ATTACKERSTATEUPDATE`) every field past the third was garbage while the feature still looked
 * like it worked.
 *
 * ALWAYS ON, like `combatWire`: a handful of small objects per cast, a short ring, and the point is that
 * the next person to ask "what does the wire really say" reads `window.spellWire.history()` rather than
 * re-deriving it.
 *
 * ## The reading that matters
 *
 * `consumed` against `bodySize`, exactly as in `combatWire`. A layout that is right consumes the body to
 * a known remainder; one that is wrong lands somewhere arbitrary. For the two entry-burst packets the
 * remainder should be **zero**, and that is what pinned both layouts before a single byte was decoded
 * for real -- the recorded sizes are arithmetic identities:
 *
 *  - `SMSG_INITIAL_SPELLS` measured **329 B**. Layout is `u8 unk`, `u16 spellCount`, then per spell
 *    `u32 spellId` + `u16 unk` (6 B), then `u16 cooldownCount`, then per cooldown 14 B. So
 *    `1 + 2 + 6n + 2 + 14m = 329` -> `6n + 14m = 324`, and `m = 0, n = 54` is the only small solution:
 *    **54 known spells, no active cooldowns**, which is exactly what a freshly-logged-in character has.
 *  - `SMSG_ACTION_BUTTONS` measured **577 B**. Layout is `u8 packetType` then `MAX_ACTION_BUTTONS` slots
 *    of `u32`. `1 + 4 * 144 = 577` and 144 is 3.3.5a's `MAX_ACTION_BUTTONS` (12 buttons x 12 pages).
 *    An exact fit, and it also rules out the 2.4.3 form (120 slots) and the packed 1.12 form.
 *
 * Both are recorded here anyway rather than merely reasoned about, because an arithmetic fit is not a
 * decode -- two layouts can share a size.
 */

/** One decoded spell-opcode arrival. `kind` is the opcode's short name. */
export interface SpellWireRow {
  at: number;
  kind:
    | 'INITIAL_SPELLS'
    | 'ACTION_BUTTONS'
    | 'SPELL_START'
    | 'SPELL_GO'
    | 'CAST_FAILED'
    | 'CAST_SENT'
    // The three cooldown opcodes. `SPELL_COOLDOWN` (0x134) carries a whole list, `COOLDOWN_EVENT` (0x135)
    // one spell with no duration; both are on the wire and neither carries the GLOBAL cooldown, which the
    // client computes from `Spell.dbc` column 206 (`object/spells.ts#applyGlobalCooldown`).
    | 'SPELL_COOLDOWN'
    | 'COOLDOWN_EVENT'
    // `SMSG_SPELL_FAILURE` (0x133) -- a cast that had STARTED was broken, which is a different thing from
    // `CAST_FAILED` (0x130), the server refusing one up front. The cast bar colours them differently.
    | 'SPELL_FAILURE'
    // `SMSG_SPELL_DELAYED` (0x1E2) -- CAST PUSHBACK. The server's own revised timing for a cast that was
    // interrupted-but-not-broken by a hit; `detail.delayMs` is how much later it now finishes. Its own
    // kind because it is the one spell opcode that neither starts nor ends a cast.
    | 'SPELL_DELAYED'
    /**
     * Not a packet: the one row `spell-data.ts` writes when the four DBC tables finish loading, with
     * their row counts and the elapsed ms.
     *
     * It has its OWN kind rather than borrowing `INITIAL_SPELLS`, which is what it did first. That
     * conflated "the spell book arrived" with "the tables loaded" in one `kind`, and the giveaway was
     * that the unit test had to filter on `consumed > 0` to tell them apart -- a test working around
     * an instrument is the instrument's defect, not the test's.
     */
    | 'TABLES_LOADED';
  /** The spell this row is about, or 0 where the packet is not about one spell. */
  spellId: number;
  /** Caster guid where the packet names one. */
  caster: string | null;
  /** Packet-specific detail, kept small and JSON-able. */
  detail: Record<string, number | string | null>;
  bodySize: number;
  /** Bytes of body consumed by the decode. Compare with `bodySize`; see the header. */
  consumed: number;
}

const HISTORY = 200;

class SpellWire {
  private rows: SpellWireRow[] = [];

  record(row: SpellWireRow): void {
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  history(): readonly SpellWireRow[] {
    return this.rows;
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const spellWire = new SpellWire();

if (typeof window !== 'undefined') {
  (window as any).spellWire = spellWire;
}
