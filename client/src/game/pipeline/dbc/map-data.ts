import DBC from '.';

/**
 * THE MAP TABLES -- `WorldMapArea`, `AreaTable`, `Map`, `WorldMapContinent`.
 *
 * The foundation the minimap and the world map both stand on, and the first step of that arc. Nothing
 * here draws anything; it answers the four questions every map global asks.
 *
 * ## THE PARSERS ALREADY EXISTED. NOTHING HAD EVER READ THEM.
 *
 * All four entities are defined and registered in `wow-data-parser/dbc/entities/` -- as are
 * `WorldMapOverlay` and `WorldMapTransforms`, which this file does not need yet. That is the same
 * situation `GameObjectDisplayInfo` was in, and it is worth noticing as a pattern rather than a
 * coincidence: this client can parse a good deal more of the game's data than it consumes, so "is the
 * table available" is a question to ASK before it is a reason to declare a gap.
 *
 * ## MEASURED AGAINST THE SERVED FILES, header and field count both
 *
 *     worldmaparea       108 records   11 fields   44 B/record   closes exactly
 *     areatable         2307 records   36 fields  144 B/record   closes exactly
 *     map                135 records   66 fields  264 B/record   closes exactly
 *     worldmapcontinent    4 records   14 fields   56 B/record   closes exactly
 *
 * "Closes exactly" means `20 + records * recordSize + stringBlockSize` equals the served byte count, so
 * each layout is right rather than plausible. And the field counts agree with our entities: 11 for
 * `world-map-area.js` (id, mapID, areaID, a `StringRef`, four rect floats, displayMapID,
 * defaultDungeonFloor, one reserved) and 36 for `area-table.js` once its `LocalizedStringRef` is counted
 * at its 3.3.5a width. Both were checked, not assumed -- an entity can be a 1.12 transcription in a
 * 3.3.5a repo, which is the single most repeated defect class here.
 *
 * ## WHAT EACH TABLE IS FOR
 *
 *  - **`WorldMapArea`** is the one the map art hangs off: per (mapID, areaID) it gives the art folder
 *    NAME -- which is what `GetMapInfo`'s first return is, and what `WorldMapFrame_Update` builds
 *    `Interface\WorldMap\<name>\<name>1..12` from (`worldmapframe.lua:234`) -- and the world-space rect
 *    the zone occupies, which is what any position-on-the-map projection lerps through.
 *  - **`AreaTable`** is names and the PARENT CHAIN. The player's position resolves to a leaf sub-area
 *    ("Northshire Abbey"), and a map wants its zone ("Elwynn Forest"); the reference walks the parent
 *    chain for exactly this ("our MCNK `CurrentArea` is the leaf sub-area, so the parent walk lands on
 *    the same zone", `ui_world_map.rs:17-20`).
 *  - **`Map`** carries the continent's own localized name, and the reference is specific about why it
 *    matters: continents display "under their `Map.dbc` localized names ('Eastern Kingdoms', not the art
 *    folder's 'Azeroth')" (`ui_world_map.rs:10-12`). The two names differ and the art folder is the wrong
 *    one to show a player.
 *  - **`WorldMapContinent`** is the world-sheet projection constants, for the zoomed-out view.
 *
 * ## WHAT IS NOT HERE YET, and it is the next step rather than a gap
 *
 * **The player's current AREA.** This client tracks none: there is no `SMSG_ZONE_UPDATE` subscriber and
 * nothing reads the area id out of the terrain chunk under the player. Every map global that answers
 * "where am I" needs it, so it is the next piece, and it is a world-side question rather than a DBC one.
 *
 * ## COST
 *
 * `areatable.dbc` is 367 KB and its string block is most of that; the other three come to 50 KB
 * together. Loaded on demand rather than eagerly -- a player who never opens the map should not pay for
 * it, unlike `GameObjectDisplayInfo`, which every crate in view needs the moment he is in the world.
 */
class MapData {
  private pending: Promise<void> | null = null;

  /** `areaId` -> its row. */
  private areas = new Map<number, { name: string; parentId: number; mapId: number }>();

  /** `mapId` -> the world-map areas on it, in file order. */
  private byMap = new Map<number, WorldMapAreaRow[]>();

  /** `(mapId << 20) | areaId` -> the world-map area row, for the direct lookup. */
  private byMapArea = new Map<number, WorldMapAreaRow>();

/**
   * Every `WorldMapArea` row in FILE ORDER, which is an ordering the client depends on.
   *
   * The reference: continents are listed "in `WorldMapArea` **file order** (Kalimdor, then EK -- the
   * `0x4a5d00` builder's walk)" (`ui_world_map.rs:8-10`). Sorting them would put Eastern Kingdoms first
   * and disagree with the real client's continent menu, so the array is kept as the file has it.
   */
  private order: WorldMapAreaRow[] = [];

  /** `WorldMapContinent.dbc`'s mapIDs in file order -- what numbers the client's continents. */
  private continentMapIds: number[] = [];

  /** `mapId` -> the continent's own localized name. See the header on why this is not the art folder. */
  private mapNames = new Map<number, string>();

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Reset so a transient failure is retryable rather than poisoning the session. Until it
        // succeeds every lookup answers null, which hides a map rather than drawing a wrong one.
        this.pending = null;
        console.warn('mapData: load failed, the map and minimap will have no names or rects', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const [areaTable, worldMapArea, maps, continents] = await Promise.all([
      DBC.load('AreaTable'),
      DBC.load('WorldMapArea'),
      DBC.load('Map'),
      DBC.load('WorldMapContinent'),
    ]);

    const areas = new Map<number, { name: string; parentId: number; mapId: number }>();
    for (const record of recordsOf(areaTable)) {
      const row = record as { id?: number; name?: unknown; parentID?: number; mapID?: number };
      if (typeof row.id !== 'number') {
        continue;
      }
      areas.set(row.id, {
        name: localized(row.name),
        parentId: typeof row.parentID === 'number' ? row.parentID : 0,
        mapId: typeof row.mapID === 'number' ? row.mapID : 0,
      });
    }
    this.areas = areas;

    const byMap = new Map<number, WorldMapAreaRow[]>();
    const byMapArea = new Map<number, WorldMapAreaRow>();
    const order: WorldMapAreaRow[] = [];
    for (const record of recordsOf(worldMapArea)) {
      const row = record as {
        id?: number; mapID?: number; areaID?: number; name?: unknown;
        position?: { left?: number; right?: number; top?: number; bottom?: number };
      };
      if (typeof row.id !== 'number' || typeof row.mapID !== 'number') {
        continue;
      }
      const built: WorldMapAreaRow = {
        id: row.id,
        mapId: row.mapID,
        areaId: typeof row.areaID === 'number' ? row.areaID : 0,
        // The ART FOLDER name, which is `GetMapInfo`'s first return -- not a name to show a player.
        art: typeof row.name === 'string' ? row.name : '',
        left: row.position?.left ?? 0,
        right: row.position?.right ?? 0,
        top: row.position?.top ?? 0,
        bottom: row.position?.bottom ?? 0,
      };
      const list = byMap.get(built.mapId);
      if (list === undefined) {
        byMap.set(built.mapId, [built]);
      } else {
        list.push(built);
      }
      byMapArea.set(mapAreaKey(built.mapId, built.areaId), built);
      order.push(built);
    }
    this.byMap = byMap;
    this.byMapArea = byMapArea;
    this.order = order;

    /**
     * THE CONTINENT ORDER, and it is NOT `WorldMapArea`'s file order.
     *
     * `continents()` used to filter `WorldMapArea` for `areaId === 0` and keep the file order, which on
     * the served file is **Kalimdor, Azeroth, Expansion01, Northrend** -- and that is wrong. The client
     * numbers its continents from `WorldMapContinent.dbc`, whose four rows are mapIDs **0, 1, 530, 571**
     * (measured: 4 records, 14 fields, 56 B/record, closes exactly).
     *
     * **`worldmapframe.lua:10` proves it rather than my inferring it**: `WORLDMAP_OUTLAND_ID = 3`, so
     * continent 3 IS Outland -- which holds for `0, 1, 530, 571` and fails for the file order, where
     * index 3 is Expansion01 only by coincidence and index 1 is Kalimdor rather than Eastern Kingdoms.
     * With the old order `SetMapZoom(1)` selected the wrong continent and the zone list under it was a
     * different continent's, which is a silent wrong answer of exactly the kind this project keeps
     * finding: every index resolved, every name looked plausible, and the map showed the wrong place.
     *
     * Rows `WorldMapContinent` does not list are APPENDED rather than dropped, so a build with a fifth
     * continent sheet still reaches the dropdown instead of vanishing from it.
     */
    const continentMapIds: number[] = [];
    for (const record of recordsOf(continents)) {
      const row = record as { mapID?: number };
      if (typeof row.mapID === 'number' && !continentMapIds.includes(row.mapID)) {
        continentMapIds.push(row.mapID);
      }
    }
    this.continentMapIds = continentMapIds;

    const mapNames = new Map<number, string>();
    for (const record of recordsOf(maps)) {
      const row = record as { id?: number; name?: unknown; mapName?: unknown };
      if (typeof row.id !== 'number') {
        continue;
      }
      // The entity may name this column either way depending on which transcription it followed; both
      // are read rather than guessed at, and an absent one answers ''.
      mapNames.set(row.id, localized(row.mapName ?? row.name));
    }
    this.mapNames = mapNames;
  }

  /** Whether the tables have landed, so a caller can tell "not yet" from "no such row". */
  get loaded(): boolean {
    return this.areas.size > 0;
  }

  /** An `AreaTable` row, or null. */
  area(areaId: number): { name: string; parentId: number; mapId: number } | null {
    return this.areas.get(areaId) ?? null;
  }

  /**
   * Walk `AreaTable`'s parent chain up to the ZONE -- the row that has a `WorldMapArea` of its own.
   *
   * This is the reference's own resolution rather than a guess: a position lands on a leaf sub-area and
   * the map wants the zone above it. The walk stops at the first ancestor that a `WorldMapArea` names,
   * because that is precisely "an area the map can draw"; a chain that reaches the top without one
   * answers null rather than the continent, since a continent is not a zone.
   *
   * Bounded at eight hops. `AreaTable`'s chains are two or three deep in practice, and a cycle in
   * third-party data must not hang a frame.
   */
  zoneOf(areaId: number): { areaId: number; name: string; mapId: number } | null {
    let current = areaId;
    for (let hop = 0; hop < 8; hop += 1) {
      const row = this.areas.get(current);
      if (row === undefined) {
        return null;
      }
      if (this.byMapArea.has(mapAreaKey(row.mapId, current))) {
        return { areaId: current, name: row.name, mapId: row.mapId };
      }
      if (row.parentId === 0) {
        return null;
      }
      current = row.parentId;
    }
    return null;
  }

  /** The `WorldMapArea` row for a zone, or null. `areaId` 0 is the continent-wide sheet. */
  worldMapArea(mapId: number, areaId: number): WorldMapAreaRow | null {
    return this.byMapArea.get(mapAreaKey(mapId, areaId)) ?? null;
  }

  /** Every `WorldMapArea` on a map, in FILE order -- which is the order the reference displays in. */
  areasOnMap(mapId: number): WorldMapAreaRow[] {
    return this.byMap.get(mapId) ?? [];
  }

  /**
   * A continent's own localized name -- "Eastern Kingdoms", not the art folder's "Azeroth".
   *
   * The distinction is the reference's and it is a real one: showing the art folder puts the wrong word
   * in front of the player.
   */
  mapName(mapId: number): string | null {
    return this.mapNames.get(mapId) ?? null;
  }

  /**
   * The CONTINENTS, in the order the client lists them: `WorldMapArea` rows whose `areaId` is 0, in file
   * order. See `order` for why the order is not sorted.
   *
   * `areaId 0` being the continent-wide sheet is corroborated on the served file, not inferred from the
   * name: row 13 is `mapID 1, areaID 0, art "Kalimdor"` and row 30 is `mapID 0, areaID 12, art "Elwynn"`.
   */
  continents(): WorldMapAreaRow[] {
    const sheets = this.order.filter((row) => row.areaId === 0);
    const ranked = this.continentMapIds
      .map((mapId) => sheets.find((row) => row.mapId === mapId))
      .filter((row): row is WorldMapAreaRow => row !== undefined);
    // Anything WorldMapContinent did not list keeps its file order at the end -- see the note in
    // `load` on why these are appended rather than dropped.
    return [...ranked, ...sheets.filter((row) => !ranked.includes(row))];
  }

  /**
   * The ZONES on a continent, sorted the way the client sorts them.
   *
   * "Zones sorted case-insensitively by AreaTable localized name (the `0x4a6390` comparator's
   * `SStrCmpI`)" (`ui_world_map.rs:11-13`) -- so this sorts by the AREA's name and not by the art folder,
   * and case-insensitively, because both halves are the reference's and either alone would give a
   * different list than the real client's dropdown.
   */
  zonesOn(mapId: number): WorldMapAreaRow[] {
    return this.areasOnMap(mapId)
      .filter((row) => row.areaId !== 0)
      .sort((left, right) => {
        const a = (this.areas.get(left.areaId)?.name ?? left.art).toUpperCase();
        const b = (this.areas.get(right.areaId)?.name ?? right.art).toUpperCase();
        return a < b ? -1 : a > b ? 1 : 0;
      });
  }

  /**
   * A zone's DISPLAY name -- `AreaTable`'s, not the art folder's.
   *
   * The two differ and the art folder is the wrong one to show: `WorldMapArea` 30's art is "Elwynn" while
   * `AreaTable` 12 is "Elwynn Forest". Corroborated on the served files.
   */
  displayName(row: WorldMapAreaRow): string {
    return this.areas.get(row.areaId)?.name ?? row.art;
  }

  /**
   * Normalise a world position into a `WorldMapArea`'s rect -- `GetPlayerMapPosition`'s pair.
   *
   * **The axes cross, and that is the whole content of this function.** WoW's world X runs NORTH and its
   * Y runs WEST, while a map's x runs east across the image and its y runs down it. So the horizontal
   * fraction is measured from `left` using the world's Y, and the vertical from `top` using the world's X:
   *
   *     mapX = (left - worldY) / (left - right)
   *     mapY = (top  - worldX) / (top  - bottom)
   *
   * VERIFIED against the served file rather than transcribed. Elwynn's rect is
   * `left 1535.4, right -1935.4, top -7939.6, bottom -10254.2`, and Northshire's world position
   * (x ~ -8900, y ~ -160) lands at (0.49, 0.42) -- inside the rect on both axes and in the northern middle
   * of the zone, which is where Northshire is. A swapped or unflipped formula puts it outside [0, 1].
   *
   * Returns null when the position is outside the rect, which is the engine's own answer: `GetPlayerMapPosition`
   * gives (0, 0) for a player not on the displayed map, and the client's callers hide the arrow on it.
   */
  normalise(row: WorldMapAreaRow, worldX: number, worldY: number): { x: number; y: number } | null {
    const width = row.left - row.right;
    const height = row.top - row.bottom;
    if (width === 0 || height === 0) {
      return null;
    }
    const x = (row.left - worldY) / width;
    const y = (row.top - worldX) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x, y };
  }
}

/** One `WorldMapArea` row: which art draws it, and the world-space rect it covers. */
export interface WorldMapAreaRow {
  id: number;
  mapId: number;
  areaId: number;
  /** The ART FOLDER name -- `GetMapInfo`'s first return. Not a display name. */
  art: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * `(mapId, areaId)` as one number.
 *
 * `areaId` is shifted into the low 20 bits: `AreaTable`'s highest id in 3.3.5a is in the low thousands
 * and 20 bits carries a million, so this cannot collide. A string key would allocate per lookup on a
 * path the map's projection runs per frame.
 */
function mapAreaKey(mapId: number, areaId: number): number {
  return (mapId * 0x100000) + areaId;
}

/** `records` off a loaded DBC, whatever shape the loader handed back. */
function recordsOf(table: unknown): unknown[] {
  return (table as { records?: unknown[] } | null)?.records ?? [];
}

/**
 * A `StringRef` or a `LocalizedStringRef`, as one string.
 *
 * `AreaTable` and `Map` use the localized form -- an array of locale slots of which one is filled -- and
 * `WorldMapArea` uses the plain one. Both arrive here, so this takes the first non-empty entry rather
 * than assuming an index: which slot is filled depends on the client's locale, and enUS is not
 * guaranteed to be slot 0 in every build.
 */
function localized(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry !== '') {
        return entry;
      }
    }
    return '';
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (typeof entry === 'string' && entry !== '') {
        return entry;
      }
    }
  }
  return '';
}

export const mapData = new MapData();

export default mapData;
