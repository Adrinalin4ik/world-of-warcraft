/**
 * WHAT A REPAIR COSTS -- the two tables behind `GetRepairAllCost`, and the arithmetic over them.
 *
 * The owner's console had `MerchantFrame.lua:546` raising twenty times on a nil `GetRepairAllCost`.
 * That global is not a stub away from working: it has to answer a real number of copper, and the number
 * is a join over two DBCs the client ships and three words off the item -- its lost durability, its
 * item level, and its quality.
 *
 * ## THE TABLES ARE GAME DATA; THE FORMULA AND THE INDEXING ARE A SERVER IMPLEMENTATION
 *
 * That division matters and is kept explicit, because the two have different standing here.
 *
 * **The tables are the game's own, measured on the served files** -- see the two entity definitions in
 * `wow-data-parser/dbc/entities/durability-costs.js` and `durability-quality.js` for the byte-level
 * accounting: record counts, field counts, the layout closing exactly against `fieldCount`, and the
 * four independent zero-checks that make the weapon/armor split legible rather than assumed.
 *
 * **The formula and the row indexing are TrinityCore 3.3.5's** --
 * `Item::CalculateDurabilityRepairCost` (`game/Entities/Item/Item.cpp:752-797`) and
 * `Player::DurabilityRepairAll` (`game/Entities/Player/Player.cpp:4687-4705`). Nothing the client ships
 * states them: no FrameXML file computes a repair cost and no DBC carries the multiplication. That is
 * the same standing this repo already gives the `UNIT_NPC_FLAG_*` bits and the loot layouts, and it is
 * labelled here for the same reason.
 *
 * The formula, verbatim:
 *
 *     lost        = maxDurability - durability                    (0 -> costs nothing)
 *     costRow     = DurabilityCosts.dbc[itemLevel]                (the KEY is item level)
 *     multiplier  = costRow.weaponSubClassCost[subClass]          (item class 2, weapon)
 *                 | costRow.armorSubClassCost[subClass]           (item class 4, armor)
 *                 | 0                                             (anything else)
 *     qualityMod  = DurabilityQuality.dbc[(quality + 1) * 2].data
 *     cost        = round(lost * multiplier * qualityMod)
 *     cost        = cost == 0 ? 1 : cost                          (the artifact-quality fix)
 *
 * ## Two things this client cannot include, and says so rather than approximating
 *
 *  - **The reputation discount.** The real `GetRepairAllCost` scales by the player's standing with the
 *    vendor's faction (`Player::GetReputationPriceDiscount`), and this client decodes no reputation, so
 *    the multiplier is 1.0. The number is therefore the UNDISCOUNTED cost, which is the maximum -- it
 *    can read high at a friendly vendor and never low, so nothing is ever enabled on a cost the player
 *    cannot actually meet.
 *  - **`RATE_REPAIRCOST`.** A server config knob, default 1.0, that no packet carries. Absent.
 *
 * ## The zero that must not become a Lua truth
 *
 * `multiplier` is legitimately 0 for a whole class of items -- a ring, a trinket, a libram, a bag --
 * and the server charges 0 copper for them. **In Lua 0 is TRUTHY**, so a global that means "there is
 * nothing to repair here" must answer nil and not 0; that trap has bitten this project three times.
 * This module speaks numbers, and 0 means zero copper; producing the nil is the BRIDGE's job, and
 * `game/ui/merchant-bridge.ts` is where it happens.
 */
import DBC from '.';

/** `ITEM_CLASS_WEAPON`. The 21-entry weapon multiplier array is keyed by its subclass. */
const ITEM_CLASS_WEAPON = 2;

/** `ITEM_CLASS_ARMOR`. The 8-entry armor multiplier array is keyed by its subclass. */
const ITEM_CLASS_ARMOR = 4;

/** One row of `DurabilityCosts.dbc`: the multipliers for one item level. */
interface CostRow {
  weapon: number[];
  armor: number[];
}

/** Everything the cost of one item depends on. All five come from the item, not from the vendor. */
export interface RepairSubject {
  /** `ITEM_FIELD_MAXDURABILITY` minus `ITEM_FIELD_DURABILITY`. 0 means undamaged. */
  lostDurability: number;
  /** The template's `itemLevel` -- the KEY into `DurabilityCosts.dbc`, not the required level. */
  itemLevel: number;
  /** 0 Poor .. 7 Heirloom. Selects the quality modifier through `(quality + 1) * 2`. */
  quality: number;
  itemClass: number;
  subClass: number;
}

class DurabilityData {
  /** item level -> its multiplier row. */
  private costs: Map<number, CostRow> | null = null;

  /** `(quality + 1) * 2` -> the float modifier. */
  private quality: Map<number, number> | null = null;

  private pending: Promise<void> | null = null;

  /** True once both tables are in memory. `repairCost` answers null until then. */
  get ready(): boolean {
    return this.costs !== null && this.quality !== null;
  }

  /**
   * Load both tables, once. Idempotent, and the same shape as `itemData.ensureLoaded`.
   *
   * **36 KB and 149 bytes.** `durabilitycosts.dbc` is 300 records of 120 bytes and
   * `durabilityquality.dbc` is 16 of 8 -- both probed on the live host, both 200. That is why this is
   * fetched when the merchant bridge attaches rather than deferred to the first vendor: the pair is
   * smaller than a single icon, so there is no budget argument for loading it lazily and a real one
   * against making the first `GetRepairAllCost` of a session answer null.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure is retryable rather than poisoning the session. Until it
        // succeeds `repairCost` answers null, which the bridge turns into "cannot repair" -- a greyed
        // button, not a wrong number.
        this.pending = null;
        console.warn('durabilityData: load failed, repair costs will be unavailable', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const [costs, quality] = await Promise.all([
      DBC.load('DurabilityCosts'),
      DBC.load('DurabilityQuality'),
    ]);

    const costRows = new Map<number, CostRow>();
    for (const record of (costs as { records?: unknown[] }).records ?? []) {
      const row = record as {
        id?: number; weaponSubClassCost?: number[]; armorSubClassCost?: number[];
      };
      if (typeof row?.id === 'number'
        && Array.isArray(row.weaponSubClassCost) && Array.isArray(row.armorSubClassCost)) {
        costRows.set(row.id, { weapon: row.weaponSubClassCost, armor: row.armorSubClassCost });
      }
    }
    this.costs = costRows;

    const qualityMods = new Map<number, number>();
    for (const record of (quality as { records?: unknown[] }).records ?? []) {
      const row = record as { id?: number; data?: number };
      if (typeof row?.id === 'number' && typeof row.data === 'number') {
        qualityMods.set(row.id, row.data);
      }
    }
    this.quality = qualityMods;
  }

  /**
   * What one item costs to repair, in copper. **0 means nothing to pay; null means unknown.**
   *
   * The two are different answers and collapsing them is how a repair-all button ends up enabled with
   * no tables loaded. 0 is a fact about the ITEM (undamaged, or a subclass with no durability cost);
   * null is a fact about this CLIENT -- the DBCs have not landed, or the item level is off the end of a
   * 300-row table, which is what a level-300-plus item would be.
   */
  repairCost(subject: RepairSubject): number | null {
    if (this.costs === null || this.quality === null) {
      return null;
    }
    if (subject.lostDurability <= 0) {
      return 0;
    }
    const row = this.costs.get(subject.itemLevel);
    if (row === undefined) {
      return null;
    }
    let multiplier = 0;
    if (subject.itemClass === ITEM_CLASS_WEAPON) {
      multiplier = row.weapon[subject.subClass] ?? 0;
    } else if (subject.itemClass === ITEM_CLASS_ARMOR) {
      multiplier = row.armor[subject.subClass] ?? 0;
    }
    if (multiplier === 0) {
      // A subclass with no durability cost -- a ring, a libram, the obsolete buckler. This is the
      // server's `default: dmultiplier = 0` arm, and it returns 0 copper rather than falling through
      // to the artifact fix below. The server applies that fix AFTER the multiplication, so a zero
      // multiplier would become 1 copper there -- but the server never reaches that line for such an
      // item, because `maxDurability` is 0 for every one of them and it returns at the top. Answering
      // 0 here is the same outcome by the shorter road; charging a phantom copper per ring would be
      // visible in the repair-all total.
      return 0;
    }
    const mod = this.quality.get((subject.quality + 1) * 2);
    if (mod === undefined) {
      return null;
    }
    const cost = Math.round(subject.lostDurability * multiplier * mod);
    // The server's own `if (cost == 0) cost = 1` -- reachable only through a quality whose modifier is
    // 0.0 (ids 13 and 14 in the served table), which is what the comment there calls the artifact case.
    return cost === 0 ? 1 : cost;
  }
}

export const durabilityData = new DurabilityData();

export default durabilityData;
