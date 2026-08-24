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
  private areas = new Map<number, AreaRow>();

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

  /** `WorldMapArea.id` -> its explored-area overlays, in file order. */
  private byOverlayArea = new Map<number, OverlayRow[]>();

  /** Per continent mapID, the sheet's extent in ADT tile indices. See `load`. */
  private sheets = new Map<number, SheetBounds>();

  /** `WorldMapTransforms` rows -- see `MapTransform`. */
  private placements: MapTransform[] = [];

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
    const [areaTable, worldMapArea, maps, continents, transforms, overlays] = await Promise.all([
      DBC.load('AreaTable'),
      DBC.load('WorldMapArea'),
      DBC.load('Map'),
      DBC.load('WorldMapContinent'),
      DBC.load('WorldMapTransforms'),
      DBC.load('WorldMapOverlay'),
    ]);

    const areas = new Map<number, AreaRow>();
    for (const record of recordsOf(areaTable)) {
      const row = record as {
        id?: number; name?: unknown; parentID?: number; mapID?: number;
        flags?: number; factionGroupID?: number; areaBit?: number;
      };
      if (typeof row.id !== 'number') {
        continue;
      }
      areas.set(row.id, {
        name: localized(row.name),
        parentId: typeof row.parentID === 'number' ? row.parentID : 0,
        mapId: typeof row.mapID === 'number' ? row.mapID : 0,
        flags: typeof row.flags === 'number' ? row.flags : 0,
        // `factionGroupID` is a MASK here and not a `FactionGroup.dbc` id -- MEASURED on the served
        // file: Elwynn Forest (12) is 2, Durotar (14) is 4, Stranglethorn Vale (33) is 0 and Dalaran
        // (4395) is 6. So 2 is Alliance, 4 is Horde, 6 is both (a sanctuary) and 0 is contested.
        factionGroupMask: typeof row.factionGroupID === 'number' ? row.factionGroupID : 0,
        areaBit: typeof row.areaBit === 'number' ? row.areaBit : -1,
      });
    }
    this.areas = areas;

    const byMap = new Map<number, WorldMapAreaRow[]>();
    const byMapArea = new Map<number, WorldMapAreaRow>();
    const order: WorldMapAreaRow[] = [];
    for (const record of recordsOf(worldMapArea)) {
      const row = record as {
        id?: number; mapID?: number; areaID?: number; name?: unknown; displayMapID?: number;
        position?: { left?: number; right?: number; top?: number; bottom?: number };
      };
      if (typeof row.id !== 'number' || typeof row.mapID !== 'number') {
        continue;
      }
      const built: WorldMapAreaRow = {
        id: row.id,
        mapId: row.mapID,
        areaId: typeof row.areaID === 'number' ? row.areaID : 0,
        displayMapId: typeof row.displayMapID === 'number' ? row.displayMapID : -1,
        // The ART FOLDER name, which is `GetMapInfo`'s first return -- not a name to show a player.
        art: typeof row.name === 'string' ? row.name : '',
        left: row.position?.left ?? 0,
        right: row.position?.right ?? 0,
        top: row.position?.top ?? 0,
        bottom: row.position?.bottom ?? 0,
      };
      // BY THE DISPLAY MAP, not by `mapId` -- see `WorldMapAreaRow#displayMapId`. This is what puts
      // the Draenei isles on the Kalimdor sheet, where the real client has them.
      const sheetMapId = built.displayMapId >= 0 ? built.displayMapId : built.mapId;
      const list = byMap.get(sheetMapId);
      if (list === undefined) {
        byMap.set(sheetMapId, [built]);
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
     * THE EXPLORED-AREA PATCHES, grouped by the `WorldMapArea` row they belong to.
     *
     * `worldmapoverlay.dbc` is 988 records of 17 fields at 68 bytes, and the entity at
     * `wow-data-parser/dbc/entities/world-map-overlay.js` already names every one of them -- so this
     * is a read, not a decode. Elwynn has twelve, measured on the served file: `STORMWIND` 485x405 at
     * offset 0,0 through `STONECAIRNLAKE` 310x256 at 587,190.
     *
     * `mapAreaID` is the `WorldMapArea` ROW id and not a map id, so the grouping key is `row.id` --
     * which is why that field is on `WorldMapAreaRow` at all.
     *
     * `areaIDs` is up to four `AreaTable` ids and the trailing slots are 0. An overlay is drawn when
     * the player has explored ANY of them, which is what `areaBit` is for -- see `mapData.overlaysOf`.
     */
    const byOverlayArea = new Map<number, OverlayRow[]>();
    for (const record of recordsOf(overlays)) {
      const row = record as {
        mapAreaID?: number; areaIDs?: number[]; textureName?: unknown;
        textureWidth?: number; textureHeight?: number; offsetX?: number; offsetY?: number;
      };
      if (typeof row.mapAreaID !== 'number' || typeof row.textureName !== 'string') {
        continue;
      }
      const built: OverlayRow = {
        textureName: row.textureName,
        width: typeof row.textureWidth === 'number' ? row.textureWidth : 0,
        height: typeof row.textureHeight === 'number' ? row.textureHeight : 0,
        offsetX: typeof row.offsetX === 'number' ? row.offsetX : 0,
        offsetY: typeof row.offsetY === 'number' ? row.offsetY : 0,
        areaIds: (row.areaIDs ?? []).filter((id) => id > 0),
      };
      const list = byOverlayArea.get(row.mapAreaID);
      if (list === undefined) {
        byOverlayArea.set(row.mapAreaID, [built]);
      } else {
        list.push(built);
      }
    }
    this.byOverlayArea = byOverlayArea;

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
    const sheets = new Map<number, SheetBounds>();
    for (const record of recordsOf(continents)) {
      const row = record as {
        mapID?: number;
        bounds?: { left?: number; right?: number; top?: number; bottom?: number };
        offsetX?: number; offsetY?: number; scale?: number;
      };
      if (typeof row.mapID !== 'number') {
        continue;
      }
      if (!continentMapIds.includes(row.mapID)) {
        continentMapIds.push(row.mapID);
      }
      /**
       * THE CONTINENT SHEET'S EXTENT, in ADT TILE indices -- which is what makes a zone's place on
       * the zoomed-out sheet computable, and with it the click that zooms in and the highlight under
       * the cursor.
       *
       * MEASURED on the served file, all four rows: mapID 0 is `left 26, right 44, top 8, bottom 60`
       * (18 x 52 tiles), mapID 1 is `16, 46, 9, 52`, 530 is `23, 47, 15, 61`, 571 is `16, 45, 12, 33`.
       * 18 wide by 52 tall is Eastern Kingdoms' shape, which is the corroboration that these are tile
       * indices and not pixels.
       *
       * `left`/`right` run along the world's **Y** axis and `top`/`bottom` along its **X**, the same
       * crossing `normalise` carries -- and both increase in the direction the tile index increases,
       * i.e. as the world coordinate DECREASES. So `left` is the westmost tile and `top` the
       * northmost, which is what puts Elwynn (tiles ~29-36 by ~47-51) at x 0.17-0.53, y 0.75-0.83 of
       * the Eastern Kingdoms sheet: the south-central part, where it is.
       */
      const bounds = row.bounds;
      if (typeof bounds?.left === 'number' && typeof bounds.right === 'number'
        && typeof bounds.top === 'number' && typeof bounds.bottom === 'number'
        && bounds.right !== bounds.left && bounds.bottom !== bounds.top) {
        sheets.set(row.mapID, {
          left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          offsetX: typeof row.offsetX === 'number' ? row.offsetX : 0,
          offsetY: typeof row.offsetY === 'number' ? row.offsetY : 0,
          scale: typeof row.scale === 'number' && row.scale > 0 ? row.scale : 1,
        });
      }
    }
    this.continentMapIds = continentMapIds;

    // `WorldMapTransforms` -- see `MapTransform`. Identity rows are kept rather than filtered: they
    // cost one comparison each and dropping them would be a rule this file has to justify.
    const placements: MapTransform[] = [];
    for (const record of recordsOf(transforms)) {
      const row = record as {
        mapID?: number; newMapID?: number;
        regionMinX?: number; regionMaxX?: number; regionMinY?: number; regionMaxY?: number;
        regionOffsetX?: number; regionOffsetY?: number;
      };
      if (typeof row.mapID !== 'number' || typeof row.newMapID !== 'number') {
        continue;
      }
      placements.push({
        mapId: row.mapID,
        newMapId: row.newMapID,
        minX: row.regionMinX ?? 0,
        maxX: row.regionMaxX ?? 0,
        minY: row.regionMinY ?? 0,
        maxY: row.regionMaxY ?? 0,
        offsetX: row.regionOffsetX ?? 0,
        offsetY: row.regionOffsetY ?? 0,
      });
    }
    this.placements = placements;
    this.sheets = sheets;

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
  area(areaId: number): AreaRow | null {
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

  /**
   * Each continent's rect on the WORLD sheet, as 0..1 fractions -- what names a continent under the
   * cursor when the map is zoomed all the way out.
   *
   * ## THE PROJECTION IS `WorldMapContinent`'s AND IT IS VALIDATED BY THE ART
   *
   * The World sheet is a composite, not a projection of the world grid: Kalimdor spans tiles 16-46
   * on the Y axis and Eastern Kingdoms 26-44, so placing them by global tile coordinates would
   * OVERLAP them. `offsetX`/`offsetY`/`scale` are what separate them, and running them out gives
   * exactly the picture the art shows:
   *
   *     across:  Kalimdor -9.0 .. 12.0 | Northrend 13.0 .. 33.3 | Eastern Kingdoms 35.1 .. 47.7
   *     down:    Northrend  2.0 .. 16.7 | Kalimdor 9.6 .. 39.7 | Eastern Kingdoms 4.1 .. 40.5
   *
   * Kalimdor left, Eastern Kingdoms right, Northrend centred at the top and the other two below it.
   * That is the World map, and it is the corroboration that these three columns mean what this
   * assumes -- the same kind of check that settled the tile units for the per-continent sheets.
   *
   * ## THE ONE UNSOURCED NUMBER, and it is a MARGIN
   *
   * No file states the World sheet's own extent, so it is taken as the bounding box of the four
   * continents. That places them correctly RELATIVE to each other -- which is what names the right
   * continent -- and puts the outermost coastlines exactly on the sheet's edges, where the art has
   * open sea instead. So the hit rects run slightly wide at the edges of the sheet, and a margin is
   * what would fix it. Stated rather than guessed at: a made-up margin would move every continent
   * and could not be told from a wrong projection.
   */
  worldRects(): Array<{ mapId: number; rect: { left: number; right: number; top: number; bottom: number } }> {
    const placed = this.continentMapIds
      .map((mapId) => ({ mapId, sheet: this.sheets.get(mapId) }))
      .filter((entry): entry is { mapId: number; sheet: SheetBounds } => entry.sheet !== undefined)
      .map(({ mapId, sheet }) => ({
        mapId,
        left: sheet.left * sheet.scale + sheet.offsetX,
        right: sheet.right * sheet.scale + sheet.offsetX,
        top: sheet.top * sheet.scale + sheet.offsetY,
        bottom: sheet.bottom * sheet.scale + sheet.offsetY,
      }));
    if (placed.length === 0) {
      return [];
    }
    const minX = Math.min(...placed.map((entry) => entry.left));
    const maxX = Math.max(...placed.map((entry) => entry.right));
    const minY = Math.min(...placed.map((entry) => entry.top));
    const maxY = Math.max(...placed.map((entry) => entry.bottom));
    const across = maxX - minX;
    const down = maxY - minY;
    return placed.map((entry) => ({
      mapId: entry.mapId,
      rect: {
        left: (entry.left - minX) / across,
        right: (entry.right - minX) / across,
        top: (entry.top - minY) / down,
        bottom: (entry.bottom - minY) / down,
      },
    }));
  }

  /**
   * The zone under a point on a CONTINENT sheet, as a 0..1 fraction from its top-left, or null.
   *
   * This is what makes `UpdateMapHighlight` and `ProcessMapClick` answerable: "which zone is the
   * cursor over" and "which zone did he click" are one question, and both were declared gaps for want
   * of exactly this. Every number in it comes from a served file -- the sheet extent from
   * `WorldMapContinent` (see `load`) and each zone rect from `WorldMapArea`.
   *
   * **The SMALLEST matching zone wins.** Zone rects overlap: the rows for a city and for the zone
   * around it both contain the city, and the client zooms to the city. Picking the first match would
   * depend on file order instead, which is the kind of accident that reads as correct until it does
   * not.
   *
   * Linear over the continent -- 25 rows for Eastern Kingdoms out of 108 in the whole table. It runs
   * on a click and on a cursor move over the map, not per frame.
   */
  /**
   * A zone's rect on its continent sheet, for a caller that needs the rect and not just the hit.
   *
   * `UpdateMapHighlight` has to answer WHERE the highlight goes as well as which zone it is, and the
   * shape test needs the local `(u, v)` inside that rect -- both are this rect. Exposed rather than
   * recomputed by the bridge, so there is one projection and not two.
   */
  /**
   * A zone's rect in the coordinate space of the SHEET it is displayed on.
 *
   * The identity for an ordinary zone, whose rect is already in its own map's space. For one placed
   * on another map by `displayMapId`, the matching `WorldMapTransforms` offset is added -- see
   * `MapTransform` for the measurement and the axis question it settles.
 *
   * The rect CENTRE is tested against the region rather than the whole rect: a zone straddling a
   * region edge would otherwise be placed nowhere, and the regions in this file are far larger than
   * any zone in them.
   */
  private placedRect(row: WorldMapAreaRow, sheetMapId: number): WorldMapAreaRow {
    if (row.mapId === sheetMapId) {
      return row;
    }
    const centreX = (row.top + row.bottom) / 2;
    const centreY = (row.left + row.right) / 2;
    const hit = this.placements.find((t) => t.mapId === row.mapId && t.newMapId === sheetMapId
      && centreX >= t.minX && centreX <= t.maxX && centreY >= t.minY && centreY <= t.maxY);
    if (hit === undefined) {
      return row;
    }
    return {
      ...row,
      top: row.top + hit.offsetX,
      bottom: row.bottom + hit.offsetX,
      left: row.left + hit.offsetY,
      right: row.right + hit.offsetY,
    };
  }

  sheetRectOfZone(mapId: number, row: WorldMapAreaRow):
  { left: number; right: number; top: number; bottom: number } | null {
    const continent = this.worldMapArea(mapId, 0);
    return continent === null ? null : sheetRect(this.placedRect(row, mapId), continent);
  }

  zoneAtSheetPoint(mapId: number, fractionX: number, fractionY: number): WorldMapAreaRow | null {
    const continent = this.worldMapArea(mapId, 0);
    if (continent === null) {
      return null;
    }
    let best: WorldMapAreaRow | null = null;
    let bestArea = Infinity;
    for (const row of this.zonesOn(mapId)) {
      const rect = sheetRect(this.placedRect(row, mapId), continent);
      if (rect === null) {
        continue;
      }
      if (fractionX < rect.left || fractionX > rect.right
        || fractionY < rect.top || fractionY > rect.bottom) {
        continue;
      }
      const area = (rect.right - rect.left) * (rect.bottom - rect.top);
      if (area < bestArea) {
        bestArea = area;
        best = row;
      }
    }
    return best;
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
  /**
   * The explored-area patches for a zone that the player has actually explored, in file order.
   *
   * **THE ENGINE FILTERS BY EXPLORATION, and the client's own loop shows it does so by returning an
   * EMPTY NAME rather than a shorter list.** `WorldMapFrame_Update` iterates `1..GetNumMapOverlays()`
   * and skips a row whose `textureName` is nil or `""` (`worldmapframe.lua:303-306`), so the count is
   * stable and the gaps are in the values. This returns the FILTERED list and the bridge answers its
   * length, which is the same thing the client sees -- one fewer index to keep straight.
   *
   * `explored` is asked per `AreaTable` id and any one of the row's up-to-four ids is enough. An
   * `areaBit` of -1 can never be explored and is dropped by the caller, not here.
   */
  overlaysOf(row: WorldMapAreaRow, explored: (areaId: number) => boolean): OverlayRow[] {
    const all = this.byOverlayArea.get(row.id) ?? [];
    return all.filter((overlay) => overlay.areaIds.some((areaId) => explored(areaId)));
  }

  /** This area's bit index into the explored-zones field, or -1 when the DBC gives it none. */
  areaBitOf(areaId: number): number {
    return this.areas.get(areaId)?.areaBit ?? -1;
  }

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

/**
 * An `AreaTable` row, as much of it as anything here reads.
 *
 * `flags` and `factionGroupMask` are new with `GetZonePVPInfo` and both were MEASURED rather than
 * transcribed: the file is 2307 records, 36 fields, 144 B/record and closes exactly, and the two
 * columns read the values quoted in `load` for four known zones.
 */
/**
 * A zone's rect as 0..1 fractions of its CONTINENT SHEET, or null when either row has no rect.
 *
 * ## THE SHEET IS THE CONTINENT'S OWN `WorldMapArea` ROW, and my first version had this wrong
 *
 * It projected through `WorldMapContinent.bounds` read as ADT tile indices, and I accepted it on a
 * loose check: Elwynn came out at x 0.17-0.53, y 0.75-0.83 and I called that "south-central, where it
 * is". It is not -- it is twice too wide and shifted left, and the owner saw the consequence as a
 * highlight drawn over open sea and a hover that named Winterspring from the middle of the ocean. **A
 * number that agreed with me got less scepticism than one that argued**, which is the trap this
 * project has written down and I walked into anyway.
 *
 * The right sheet is the row with `areaId == 0` for the same map: the continent-wide entry, whose
 * left/right/top/bottom cover exactly what the continent sheet draws. So a zone's place on it is the
 * same crossing `normalise` already carries and nothing else -- no tile indices, no second table.
 *
 * MEASURED on the served file, and these are the values the projection now produces:
 *
 *     Elwynn Forest  on Azeroth    x 0.408..0.494   y 0.704..0.789
 *     Winterspring   on Kalimdor   x 0.472..0.665   y 0.174..0.367
 *     Azshara        on Kalimdor   x 0.553..0.691   y 0.304..0.442
 *
 * All three land on the landmass and in the right quarter of it. That is a check the old projection
 * fails on every one of them.
 *
 * `WorldMapContinent` is still read, and still only for the WORLD sheet (`worldRects`), where its
 * offset/scale triple was validated by the shape it produces.
 *
 * EXPORTED AND PURE because this is the arithmetic here that fails SILENTLY: a wrong crossing does not
 * blank the map, it puts the zone somewhere else, and the click and the hover then agree with each other
 * about the wrong place.
 */
export function sheetRect(row: WorldMapAreaRow, continent: WorldMapAreaRow):
{ left: number; right: number; top: number; bottom: number } | null {
  if (row.left === row.right || row.top === row.bottom
    || continent.left === continent.right || continent.top === continent.bottom) {
    return null;
  }
  // The world's Y runs WEST and the sheet's x runs east; the world's X runs NORTH and the sheet's y
  // runs down. The same crossing `normalise` carries, applied to a rect instead of a point.
  const across = continent.left - continent.right;
  const down = continent.top - continent.bottom;
  return {
    left: (continent.left - row.left) / across,
    right: (continent.left - row.right) / across,
    top: (continent.top - row.top) / down,
    bottom: (continent.top - row.bottom) / down,
  };
}

/**
/**
 * A `WorldMapTransforms` row -- how a zone that LIVES on one map is placed on ANOTHER map's sheet.
 *
 * **This is what puts the Draenei isles where the art draws them**, and it is the table that closes
 * the hole `displayMapId` opened. The isles carry `mapID 530` and `displayMapID 1`, so they are
 * listed under Kalimdor -- but their rect is in map 530's coordinates, and projecting it through
 * Kalimdor's continent rect put them at x 0.75-0.86 of the sheet. The owner saw exactly that: the
 * name appeared "около надписи The Great Sea".
 *
 * MEASURED, and the file is small enough to quote whole -- 9 records, 10 fields, 40 B/record,
 * closes exactly. The two rows that matter:
 *
 *     map 530 -> 0   region x  4800.0..16000.0   y -10133.3.. -2666.7   offset  -2400.0,  2400.0
 *     map 530 -> 1   region x -6933.3..  533.3   y -16000.0.. -8000.0   offset  10133.3, 17600.0
 *
 * The other seven are identity (`mapID == newMapID`, zero offset) and change nothing.
 *
 * WHICH AXIS IS WHICH was settled by containment, not by the field names: Azuremyst's worldX range
 * (-5508..-2794) falls inside `region x` and its worldY range (-14571..-10500) inside `region y`, and
 * the other pairing fits neither. So `regionX` is the world X axis -- the one `WorldMapArea` calls
 * top/bottom -- and `regionY` is its left/right.
 *
 * CORROBORATED BY THE ART, which is the check that matters: with the offset applied, Azuremyst lands
 * at x 0.271..0.381, y 0.223..0.333 of the Kalimdor sheet -- the upper left, where the islands are
 * drawn. Without it, the lower right, where the sea label is.
 */
interface MapTransform {
  mapId: number;
  newMapId: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * A `WorldMapContinent` row, read for the WORLD sheet only -- see `MapData#worldRects`.
 *
 * The bounds are in ADT tile indices and are used ONLY as the input to the offset/scale placement that
 * lays the continents out on the zoomed-out world map. They are deliberately NOT the per-continent
 * sheet's extent: reading them that way is the mistake `sheetRect` documents at length, and the sheet's
 * real extent is the continent's own `WorldMapArea` row.
 */
export interface SheetBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** `WorldMapContinent`'s placement of this continent on the WORLD sheet. See `worldRects`. */
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface AreaRow {
  name: string;
  parentId: number;
  mapId: number;
  flags: number;
  /** 2 = Alliance, 4 = Horde, 6 = both (sanctuary), 0 = contested. See `load`. */
  factionGroupMask: number;
  /**
   * `areaBit` -- this area's index into the player's explored-zones bitfield, or **-1** for none.
   *
   * The server sends 128 dwords at `player_explored_zones_1`
   * (`network/game/object/enums.ts:462`), so bit `areaBit` of word `areaBit >> 5` is "this area has
   * been visited". -1 is the DBC's own "no bit", carried through rather than clamped to 0: word 0
   * bit 0 is a real area, and defaulting to it would mark every bitless row explored the moment the
   * player entered that one.
   */
  areaBit: number;
}

/** One `WorldMapOverlay` row -- an explored-area patch drawn over a zone's base art. */
export interface OverlayRow {
  /**
   * The BARE texture name, e.g. `STORMWIND`. Not a path and not a file.
   *
   * The client appends a 1-based tile index to whatever it is handed and the engine prefixes the
   * zone's art folder, so the file is `Interface\\WorldMap\\<art>\\<textureName><n>`. Verified on the
   * host: `interface/worldmap/elwynn/stormwind1.blp` answers 200 with a `BLP2` header, and a name
   * that does not exist answers 404 with 27 KB of HTML -- the trap this project has hit before.
   */
  textureName: string;
  /** Both in the sheet's own pixels, which the client cuts into 256-px tiles itself. */
  width: number;
  height: number;
  /** From the sheet's TOP-LEFT, in the same pixels. The client negates `offsetY` itself. */
  offsetX: number;
  offsetY: number;
  /** Up to four `AreaTable` ids; any one of them explored shows the patch. Zeros dropped. */
  areaIds: number[];
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
  /**
   * `displayMapID` -- the map whose SHEET this zone is drawn on, or -1 for "its own `mapId`".
   *
   * **A column I did not read, and the owner found it.** `worldmaparea.dbc` has ELEVEN fields and
   * this code used eight. Measured on the served file: `AzuremystIsle`, `BloodmystIsle` and
   * `TheExodar` carry `mapID 530` (Outland, where their terrain actually is) and
   * **`displayMapID 1`** -- Kalimdor, where the real client draws and names them. Every other row
   * carries -1.
   *
   * So "which continent sheet is this zone on" is `displayMapId >= 0 ? displayMapId : mapId`, and
   * reading `mapId` alone put the Draenei isles under Outland: hovering them on the Kalimdor sheet
   * named nothing, which is exactly what he reported.
   */
  displayMapId: number;
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
