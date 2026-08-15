/**
 * What `SMSG_ATTACKERSTATEUPDATE` actually delivered, so its layout is a MEASUREMENT and not a
 * transcription.
 *
 * This packet's body past `Damage` was decoded from the reference's 1.12.1 structure
 * (`attack.rs:55-83`) and 3.3.5a differs twice: WotLK inserts `OverDamage` before the sub-damage
 * count, and absorb/resist are separate trailing loops gated on `HitInfo` bits rather than
 * unconditional per-sub fields. Nothing noticed, because the swing animation is armed from `HitInfo`
 * and the attacker guid, both of which are read BEFORE the disputed region -- so the swing looked
 * right while every field after it was garbage.
 *
 * `consumed` against `bodySize` is the check that matters: a layout that is right consumes the packet
 * to a known remainder (the trailing `unk`, `MeleeSpellID` and the conditional blocked/rage words), and
 * one that is wrong lands somewhere arbitrary. `victimState` is `null` when the decode did not produce
 * a value the reference's own tables recognise, which is the case where nothing is armed.
 *
 * ALWAYS ON, unlike the other traces here, and deliberately: it is one small object per melee swing,
 * the ring is short, and the whole point is that the next person to ask "what does the wire really
 * say" can read `window.combatWire.history()` instead of re-deriving it. Turn it off by clearing.
 */
export interface CombatWireRow {
  at: number;
  hitInfo: number;
  attacker: string;
  victim: string;
  damage: number;
  overkill: number;
  subs: number;
  /** The FIRST sub-block's `SchoolMask` -- `SCHOOL_MASK_PHYSICAL` 0x01 for an ordinary swing. */
  school: number;
  /** `null` when the decode did not land on a recognised value -- see the header. */
  victimState: number | null;
  bodySize: number;
  /** Bytes of body consumed by the decode above. Compare with `bodySize`. */
  consumed: number;
}

const HISTORY = 400;

class CombatWire {
  private rows: CombatWireRow[] = [];

  record(row: CombatWireRow): void {
    this.rows.push(row);
    if (this.rows.length > HISTORY) {
      this.rows.shift();
    }
  }

  history(): readonly CombatWireRow[] {
    return this.rows;
  }

  /**
   * THE `HitInfo` CENSUS -- `window.combatWire.census()`.
   *
   * The instrument that makes 3.3.5a's crit bit CHECKABLE rather than believed. Its value (`0x200`) comes
   * from a server implementation and cannot be corroborated from the game's own data
   * (`classes/combat-text.ts`' header says so and why), and the reference's own number for that bit
   * (`0x80`) is a DIFFERENT bit here -- so a wrong reading would print a resist as a crit and look
   * entirely plausible.
   *
   * What it answers: for each distinct `hitInfo` word observed, how many swings carried it and the
   * min/mean/max damage those swings did. A crit is the group whose mean is about twice the ordinary
   * group's, and the two candidate bits are then distinguishable by inspection: if `0x200` is crit, the
   * doubled group carries it; if the reference's `0x80` were, the doubled group would carry that instead
   * -- and `0x80` swings should carry damage ZERO here, being a FULL resist.
   *
   * Grouped rather than listed because the reading is a RATIO across a population; a single crit proves
   * nothing about which bit named it.
   */
  census(): unknown {
    const groups = new Map<number, number[]>();
    for (const row of this.rows) {
      const list = groups.get(row.hitInfo) ?? [];
      list.push(row.damage);
      groups.set(row.hitInfo, list);
    }
    return [...groups.entries()]
      .map(([hitInfo, damages]) => ({
        hitInfo: `0x${hitInfo.toString(16)}`,
        swings: damages.length,
        minDamage: Math.min(...damages),
        meanDamage: +(damages.reduce((a, b) => a + b, 0) / damages.length).toFixed(2),
        maxDamage: Math.max(...damages),
        crit0x200: (hitInfo & 0x200) !== 0,
        // The reference's 1.12 crit bit, which is 3.3.5a's FULL_RESIST. Reported side by side precisely
        // so the two readings can be compared against the damage rather than argued about.
        refCrit0x80: (hitInfo & 0x80) !== 0,
      }))
      .sort((a, b) => b.swings - a.swings);
  }

  clear(): void {
    this.rows.length = 0;
  }
}

export const combatWire = new CombatWire();

if (typeof window !== 'undefined') {
  (window as any).combatWire = combatWire;
}
