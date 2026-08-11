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

  clear(): void {
    this.rows.length = 0;
  }
}

export const combatWire = new CombatWire();

if (typeof window !== 'undefined') {
  (window as any).combatWire = combatWire;
}
