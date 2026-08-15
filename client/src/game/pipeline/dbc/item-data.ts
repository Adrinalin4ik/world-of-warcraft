/**
 * THE ITEM ICON, which is the one of the four bag facts that IS client-side data.
 *
 * Name, quality and stack count all come from elsewhere -- the query response and the item's own
 * descriptor fields; see `network/game/object/items.ts`' header for the full accounting. The ICON does
 * not: it is `ItemDisplayInfo.dbc`'s `icon` column, reached through a `displayInfoID`.
 *
 * ## Two roads to the same display id, and both are wanted
 *
 *  - `Item.dbc` column 5 `displayInfoID` (`wow-data-parser/dbc/entities/item.js:11`), keyed by the item
 *    ENTRY. Available the moment the tables are in memory, with no server round trip.
 *  - `SMSG_ITEM_QUERY_SINGLE_RESPONSE`'s `displayInfoId`. Authoritative, and the only source for an
 *    entry a served `Item.dbc` does not carry (a custom or newer item).
 *
 * `iconForEntry` takes the DBC road and `iconForDisplayId` the wire road, so a bag slot draws an icon
 * as soon as the DBC lands and re-resolves to the wire's answer when the query returns. They agree for
 * every stock item; where they disagree the wire wins, because the server is what actually owns the
 * item.
 *
 * ## Which column, and how that is known rather than assumed
 *
 * `entities/item-display-info.js` is a 23-field schema that closes exactly against the served file, and
 * `icon`/`iconAlt` are its fields 5 and 6 -- 3.3.5a's `InventoryIcon[2]`. The schema is not new and is
 * not taken on trust here: `scene/character-look.ts:716` and `scene/npc-look.ts:192-202` have been
 * dressing characters off the SAME rows through `displayInfoID` since long before this file, so the
 * join `entry -> displayInfoID -> row` is already proven on this data. What is new is reading the
 * `icon` string out of a row those consumers only read textures from.
 *
 * The path is returned WITHOUT an extension and WITHOUT its directory prefix in the DBC -- the column
 * holds a bare stem like `INV_Misc_Bandage_01`. `Interface\Icons\` is prepended here and `art.ts#load`
 * appends `.blp` itself when a path carries no `.`, which is the same contract
 * `spell-data.ts#iconPath` answers under.
 */
import DBC from '.';

/** Where every inventory icon lives. The DBC stores the stem only. */
const ICON_DIR = 'Interface\\Icons\\';

class ItemData {
  /** entry -> `Item.dbc` displayInfoID. */
  private displayIds: Map<number, number> | null = null;

  /** `ItemDisplayInfo.dbc` id -> icon stem. */
  private icons: Map<number, string> | null = null;

  private pending: Promise<void> | null = null;

  /** True once both tables are in memory and the lookups below can succeed. */
  get ready(): boolean {
    return this.displayIds !== null && this.icons !== null;
  }

  /**
   * Load both tables, once. Idempotent; callers that need a value NOW read the accessors, which answer
   * null until this settles.
   *
   * `ItemDisplayInfo.dbc` is 6.7 MB and this is the second consumer to want it -- `character-look.ts`
   * already fetches it whenever anyone on screen is wearing anything, and `DBC.load` caches, so on a
   * dressed character this rides a fetch that has already happened rather than starting a second one.
   */
  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure is retryable rather than poisoning the session. The bag simply
        // stays iconless until then, which is the pre-existing state.
        this.pending = null;
        console.warn('itemData: load failed, bag slots will stay iconless', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const [items, displayInfo] = await Promise.all([
      DBC.load('Item'),
      DBC.load('ItemDisplayInfo'),
    ]);

    const displayIds = new Map<number, number>();
    for (const record of (items as any).records ?? []) {
      if (record && typeof record.displayInfoID === 'number') {
        displayIds.set(record.id, record.displayInfoID);
      }
    }
    this.displayIds = displayIds;

    const icons = new Map<number, string>();
    for (const record of (displayInfo as any).records ?? []) {
      // A blank stem is a real value in this table (rows whose display is a model only), and it must
      // NOT become `Interface\Icons\` -- that would be a directory, and the art layer would fetch and
      // fail on it once per bag slot per repaint.
      if (record && typeof record.icon === 'string' && record.icon !== '') {
        icons.set(record.id, record.icon);
      }
    }
    this.icons = icons;
  }

  /** `Item.dbc`'s display id for an entry, or null. */
  displayIdForEntry(entry: number): number | null {
    return this.displayIds?.get(entry) ?? null;
  }

  /** A display id straight to its icon path, e.g. `Interface\Icons\INV_Misc_Bandage_01`. */
  iconForDisplayId(displayId: number): string | null {
    const stem = displayId > 0 ? this.icons?.get(displayId) ?? null : null;
    return stem === null ? null : `${ICON_DIR}${stem}`;
  }

  /** An item entry straight to its icon path, via `Item.dbc`. Null until the tables land. */
  iconForEntry(entry: number): string | null {
    const displayId = this.displayIdForEntry(entry);
    return displayId === null ? null : this.iconForDisplayId(displayId);
  }
}

export const itemData = new ItemData();

export default itemData;
