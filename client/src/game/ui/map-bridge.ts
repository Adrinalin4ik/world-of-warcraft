import { mapData } from '../pipeline/dbc/map-data';
import type { WorldMapAreaRow } from '../pipeline/dbc/map-data';
import { fireEvent } from './framexml/lua/events';
import type { LuaVM } from './framexml/lua/vm';
import type World from '../world';

/**
 * THE MAP'S ENGINE SIDE -- the zone text, the world map's selection, and the player's position on it.
 *
 * Steps 3 and 4 of the map arc. Step 1 was the DBC tables (`pipeline/dbc/map-data.ts`), step 2 the area
 * under the player (`world/map.js#areaIdAt`), and this turns both into what the interface asks for.
 *
 * Every global here was taken from the client's own call sites rather than from a list of names:
 * `worldmapframe.lua` calls `GetCurrentMapContinent` fifteen times, `SetMapZoom` seven, `GetMapInfo` and
 * `GetCurrentMapAreaID` twice each, and so on. The dungeon and decoration surface is answered as EMPTY
 * rather than left absent for a reason that is not politeness: `WorldMapFrame_Update` calls all of it on
 * every open, and one absent global throws inside that function and takes the whole map down.
 *
 * ## THE SELECTION IS NOT THE POSITION
 *
 * The map shows what the player CHOSE; it follows him only when something calls `SetMapToCurrentZone`.
 * The two are kept apart deliberately -- see `continentIndex`.
 *
 * ## FOUR GLOBALS AND THEY ARE NOT THE SAME QUESTION
 *
 * The client asks in four different ways and means four different things, which is why this cannot be one
 * function with three aliases:
 *
 *  - **`GetSubZoneText()`** -- the LEAF area, "Northshire Abbey". Empty when the leaf IS the zone, which
 *    is what makes `MinimapZoneText` fall back to the zone name rather than printing it twice.
 *  - **`GetZoneText()`** -- the ZONE, "Elwynn Forest": the leaf's first ancestor that the map can draw.
 *  - **`GetRealZoneText()`** -- the zone again in 3.3.5a for the ordinary case. It differs only inside
 *    instances, where `GetZoneText` answers the instance's own name; this client enters none, so the two
 *    agree and that is stated rather than left as an accidental duplicate.
 *  - **`GetMinimapZoneText()`** -- the subzone if there is one, else the zone. The minimap's own label,
 *    and the client's `Minimap.xml` reads exactly this.
 *
 * ## THE RESOLUTION, and the two honest nulls in it
 *
 * `map.areaIdAt(player)` gives the MCNK cell's `AreaTable.id` -- the LEAF sub-area -- and
 * `mapData.zoneOf` walks its parent chain to the first ancestor with a `WorldMapArea`. Corroborated on
 * the served files: `AreaTable` 9 "Northshire Valley" has parent 12 "Elwynn Forest", and `WorldMapArea`
 * 30 is `(map 0, area 12)`. So the walk lands on the zone the map can actually draw, which is the
 * reference's own resolution (`ui_world_map.rs:17-20`).
 *
 * **Both failure modes answer "" rather than a guess**, and they are different failures:
 *
 *  - area id **0** means the cell under the player is not loaded -- a teleport's first frames, or a
 *    position off the streamed set. `AreaTable` has no id 0, so this can mean nothing else.
 *  - the tables not landed yet, which `mapData.loaded` reports.
 *
 * An empty string is what the client's own code expects for "not known yet": `MinimapZoneText:SetText("")`
 * draws an empty label rather than erroring, and every caller here is a `SetText`. A placeholder would
 * put a wrong place name on screen, which is worse than a blank one.
 *
 * ## COST
 *
 * The DBC load is kicked off on attach and awaited by nobody -- until it lands, every global answers ""
 * and the label is blank. Per call: one `Map#get` for the cell, then at most eight `Map#get`s up the
 * parent chain, and the chain is two or three deep in practice. These are called from `SetText` paths on
 * zone-change events, not per frame.
 */
export function attachMapBridge(vm: LuaVM, world: World): MapBridge {
  let disposed = false;

  // Kicked off here rather than awaited: the first zone change after it lands fills the label, and a
  // blank label for the first second is better than blocking the bridge's attach on 367 KB.
  void mapData.ensureLoaded();

  /**
   * The leaf area and its zone, resolved together because every global below needs one or both.
   *
   * `null` for either half is the honest answer -- see the header on the two ways it happens.
   */
  const where = (): { leaf: string; zone: string } => {
    if (disposed || !mapData.loaded) {
      return { leaf: '', zone: '' };
    }
    const player = world.player;
    const map = world.map as unknown as { areaIdAt?: (x: number, y: number) => number } | null;
    if (!player || !map || typeof map.areaIdAt !== 'function') {
      return { leaf: '', zone: '' };
    }
    const areaId = map.areaIdAt(player.position.x, player.position.y);
    if (areaId === 0) {
      return { leaf: '', zone: '' };
    }
    const leaf = mapData.area(areaId);
    const zone = mapData.zoneOf(areaId);
    const leafName = leaf?.name ?? '';
    const zoneName = zone?.name ?? '';
    return {
      // THE LEAF IS EMPTY WHEN IT *IS* THE ZONE, which is what keeps `GetMinimapZoneText` from printing
      // "Elwynn Forest" twice over. The engine's own `GetSubZoneText` behaves this way.
      leaf: leafName === zoneName ? '' : leafName,
      zone: zoneName,
    };
  };

  const fn = (name: string, body: (args: unknown[]) => unknown[]): void => {
    vm.registerFunction(name, body);
  };

  /**
   * THE MAP'S OWN SELECTION, which is NOT the player's position.
   *
   * The world map shows whatever continent and zone the player chose from its dropdowns, and it follows
   * him only when something calls `SetMapToCurrentZone`. Conflating the two would snap the map back every
   * time he walked, so the selection is state and the position is a query.
   *
   * Both indices are 1-BASED and 0 means "not chosen", which is the client's own convention: the
   * continent dropdown's first entry is index 1, and `GetCurrentMapContinent() == WORLDMAP_COSMIC_ID` is
   * how `WorldMapFrame_Update` detects the zoomed-all-the-way-out sheet (`worldmapframe.lua:236`). A
   * continent with zone 0 is the continent-wide sheet, which is exactly the `WorldMapArea` row whose
   * `areaId` is 0 -- corroborated on the served file, where row 13 is `mapID 1, areaID 0, art "Kalimdor"`.
   */
  let continentIndex = 0;

  let zoneIndex = 0;

  /** The `WorldMapArea` row the selection names, or null when nothing is selected or loaded. */
  const selected = (): WorldMapAreaRow | null => {
    const continent = mapData.continents()[continentIndex - 1];
    if (continent === undefined) {
      return null;
    }
    if (zoneIndex === 0) {
      return continent;
    }
    return mapData.zonesOn(continent.mapId)[zoneIndex - 1] ?? continent;
  };

  /**
   * The player's zone as a (continent, zone) index pair -- what `SetMapToCurrentZone` needs.
   *
   * Both 1-based, and a zone the continent list does not contain answers null rather than 0: a zone we
   * can name but cannot place is a data disagreement, and quietly selecting the continent sheet instead
   * would hide it behind a map that looks plausible.
   */
  const currentZoneRow = (): { continent: number; zone: number } | null => {
    const player = world.player;
    const map = world.map as unknown as { areaIdAt?: (x: number, y: number) => number } | null;
    if (!player || !map || typeof map.areaIdAt !== 'function' || !mapData.loaded) {
      return null;
    }
    const areaId = map.areaIdAt(player.position.x, player.position.y);
    const zone = areaId === 0 ? null : mapData.zoneOf(areaId);
    if (zone === null) {
      return null;
    }
    const continents = mapData.continents();
    const continent = continents.findIndex((row) => row.mapId === zone.mapId);
    if (continent < 0) {
      return null;
    }
    const index = mapData.zonesOn(zone.mapId).findIndex((row) => row.areaId === zone.areaId);
    return index < 0 ? null : { continent: continent + 1, zone: index + 1 };
  };

/**
   * `GetZonePVPInfo()` -- `Minimap_Update` reads it on the very next line after the label.
   *
   * Answers nil, which is a real answer and not a stub: the else branch of the client's own ladder paints
   * `NORMAL_FONT_COLOR`, which is what an ordinary contested zone looks like. Registering it matters even
   * so -- an absent global would throw INSIDE the handler that has just set the text, and while the
   * `SetText` above it would survive, the tooltip call below it would not.
   *
   * The real values need `AreaTable.flags`' sanctuary/arena bits and the faction ownership a zone can
   * change hands over, neither of which this client reads. Declared, not faked.
   */
  fn('GetZonePVPInfo', () => [null, null, null]);

  /**
   * THE MINIMAP'S REMAINING GLOBALS, all six absent until now -- and absent means THROWING, not blank.
   *
   * Measured against the client's own file rather than guessed at: these are every `Get*`/`Is*` in
   * `minimap.lua`/`minimap.xml` that this engine did not already answer. Each one is registered because
   * of WHERE it is called from, and the call sites are what decide the answer:
   *
   *  - `GetTrackingTexture` -> `MiniMapTracking_Update`, which compares it with the icon's current
   *    texture and calls `SetTexture(nil)` plus a shine when they differ (`minimap.lua:408-414`). nil is
   *    the correct answer for "no tracking active", and it makes that comparison a no-op rather than a
   *    flash: the icon starts with no texture, so nil == nil and the shine does not fire.
   *  - `GetNumTrackingTypes` -> the dropdown's initialiser loops `1..count` (`minimap.lua:427-430`).
   *    **0 leaves the menu empty, which is the truth**: tracking types are the tracking SPELLS the
   *    player knows, and this client models no such thing. A fabricated count would put rows in the menu
   *    that select nothing.
   *  - `GetTrackingInfo` cannot be reached with the count at 0, and is registered anyway: an addon
   *    duck-types it, and this is the object-model rule the button classes already follow.
   *  - `GetLFGMode`, `IsPartyLFG`, `IsInLFGDungeon` -> the LFG eye's four update functions
   *    (`minimap.lua:215, 239-244, 284, 313`). nil throughout, and nil is the state "not queued" that
   *    every one of those ladders falls through to.
   *  - `GetLatestThreeSenders` -> the mail icon's tooltip (`minimap.lua:387`). Three nils make the
   *    client pick `HAVE_MAIL` over `HAVE_MAIL_FROM`, which is precisely its own wording for "you have
   *    mail and I cannot name the senders".
   *
   * So every one of the six answers a value the client's own else-branch is written for. **None of them
   * is a stub dressed as data, and none is a `notImplemented` either** -- a getter that goes through the
   * report reddens `UIErrorsFrame` on a path the client walks unprompted, which is the rule that round
   * of unit-popup gaps established. The two that are genuine missing FEATURES rather than missing
   * values -- tracking spells and the LFG queue -- are named here instead, because a comment is where an
   * absent subsystem belongs and a red line on screen is not.
   */
  fn('GetTrackingTexture', () => [null]);
  fn('GetNumTrackingTypes', () => [0]);
  fn('GetTrackingInfo', () => [null, null, null, null]);
  fn('GetLFGMode', () => [null, null]);
  fn('IsPartyLFG', () => [null]);
  fn('IsInLFGDungeon', () => [null]);
  fn('GetLatestThreeSenders', () => [null, null, null]);

  /**
   * ANNOUNCE A SELECTION CHANGE -- and without this the map opens blank.
   *
   * `WorldMapFrame_UpdateMap()`, which is what lays the twelve art tiles, runs from ONE place:
   * `WorldMapFrame_OnEvent`'s `WORLD_MAP_UPDATE` arm (`worldmapframe.lua:172-175`). `OnShow` does not
   * call it -- it calls `SetMapToCurrentZone()` and trusts the engine to announce the result. So a
   * selection that changes silently is a map that never redraws.
   *
   * **This is the checklist the zone banner taught, applied before the fact rather than after it.** That
   * round fired an event and did not ask what undoes the state it sets; this one asks the other half of
   * the same question -- what does the client need told, for the state it just set to become visible?
   *
   * Only on a real change. `SetMapToCurrentZone` is called from `OnShow` AND `OnHide`, so firing
   * unconditionally would rebuild the map every time it closes.
   */
  const announce = (before: { c: number; z: number }): void => {
    if (before.c !== continentIndex || before.z !== zoneIndex) {
      fireEvent(vm, 'WORLD_MAP_UPDATE');
    }
  };

  /** The selection as it stands, for `announce` to compare against. */
  const mark = () => ({ c: continentIndex, z: zoneIndex });

  /**
   * `GetMapInfo()` -> the ART FOLDER name, and the texture height.
   *
   * `WorldMapFrame_Update` builds the map's twelve tiles from the first return
   * (`worldmapframe.lua:234`) and handles nil itself by falling back to "Cosmic" or "World" -- so nil is
   * a real answer for "nothing selected" rather than a gap.
   *
   * `textureHeight` is 0 because the client uses it only for DUNGEON maps, and this client enters none. A
   * non-zero guess would change the art layout for no reason.
   */
  fn('GetMapInfo', () => {
    const row = selected();
    return row === null ? [null, 0] : [row.art, 0];
  });

  /**
   * `GetMapContinents()` -- the `Map.dbc` names, NOT the art folders.
   *
   * "Eastern Kingdoms", not "Azeroth". The reference is explicit about it and our own data confirms the
   * two disagree: `WorldMapArea` row 30's art is "Elwynn" while `AreaTable` 12 is "Elwynn Forest", and
   * the continent sheet for map 0 is arted as "Azeroth". Showing the art folder puts the wrong word in
   * front of the player.
   */
  fn('GetMapContinents', () => mapData.continents().map(
    (row) => mapData.mapName(row.mapId) ?? row.art,
  ));

  fn('GetMapZones', (args) => {
    const continent = mapData.continents()[Number(args[0]) - 1];
    if (continent === undefined) {
      return [];
    }
    return mapData.zonesOn(continent.mapId).map((row) => mapData.displayName(row));
  });

  /**
   * `SetMapZoom(continent, zone)` -- the dropdowns' own setter and the one the client calls most.
   *
   * An out-of-range index is IGNORED rather than clamped. The client passes what its own dropdown gave
   * it, so an index we cannot resolve means our list and its list disagree -- and clamping would hide
   * that disagreement behind a map that looks plausible.
   */
  fn('SetMapZoom', (args) => {
    const continent = Number(args[0]);
    const zone = Number(args[1] ?? 0);
    if (!Number.isFinite(continent) || continent < 1
      || mapData.continents()[continent - 1] === undefined) {
      return [];
    }
    const before = mark();
    continentIndex = continent;
    zoneIndex = Number.isFinite(zone) && zone > 0 ? zone : 0;
    announce(before);
    return [];
  });

  /** `SetMapToCurrentZone()` -- the map follows the player once, on request. */
  fn('SetMapToCurrentZone', () => {
    const zone = currentZoneRow();
    if (zone !== null) {
      const before = mark();
      continentIndex = zone.continent;
      zoneIndex = zone.zone;
      announce(before);
    }
    return [];
  });

  /**
   * `SetMapByID(areaId)` -- select by `WorldMapArea.areaID`, which is how a quest's map link arrives.
   *
   * Searched rather than indexed: the table is 108 rows, this runs on a click, and a second index would
   * have to be kept in step with the sort for no measurable gain.
   */
  fn('SetMapByID', (args) => {
    const areaId = Number(args[0]);
    const continents = mapData.continents();
    for (let c = 0; c < continents.length; c += 1) {
      const zones = mapData.zonesOn(continents[c].mapId);
      const index = zones.findIndex((row) => row.areaId === areaId);
      if (index >= 0) {
        const before = mark();
        continentIndex = c + 1;
        zoneIndex = index + 1;
        announce(before);
        return [];
      }
    }
    return [];
  });

  fn('GetCurrentMapContinent', () => [continentIndex]);
  fn('GetCurrentMapZone', () => [zoneIndex]);
  fn('GetCurrentMapAreaID', () => [selected()?.areaId ?? 0]);

  /**
   * `GetPlayerMapPosition(unit)` -> the pair, normalised into the DISPLAYED map.
   *
   * `(0, 0)` when the unit is not on it, which is the engine's own answer and what the client's callers
   * test to hide the arrow. Only `player` is answered: any other token needs that unit's world position
   * projected the same way, and the frames that ask about party members are not built here.
   *
   * The projection and its axis crossing live in `mapData.normalise`, verified there against the served
   * rect rather than transcribed.
   */
  fn('GetPlayerMapPosition', (args) => {
    const row = selected();
    const player = world.player;
    if (String(args[0] ?? '') !== 'player' || row === null || !player) {
      return [0, 0];
    }
    const at = mapData.normalise(row, player.position.x, player.position.y);
    return at === null ? [0, 0] : [at.x, at.y];
  });

  /**
   * THE DUNGEON AND DECORATION SURFACE, answered as EMPTY rather than left absent.
   *
   * `WorldMapFrame_Update` calls all of these on every open, and an absent global throws inside it --
   * which takes the whole map down rather than leaving one decoration off. Each answers the value that
   * means "there are none", and here that is true:
   *
   *  - Dungeon levels: this client enters no instances, so no levels and level 0.
   *  - Overlays: the explored-area patches. `WorldMapOverlay.dbc` PARSES already (the entity is
   *    registered) and nothing reads it, so 0 draws the base art only. A real gap, named.
   *  - Landmarks: `SMSG_WORLD_MAP_LANDMARKS`-fed points of interest, with no subscriber. Named.
   *  - Debug objects: a development surface with no data behind it in any build.
   */
  fn('GetCurrentMapDungeonLevel', () => [0]);
  fn('GetNumDungeonMapLevels', () => [0]);
  fn('SetDungeonMapLevel', () => []);
  fn('DungeonUsesTerrainMap', () => [false]);
  fn('GetNumMapOverlays', () => [0]);
  fn('GetNumMapLandmarks', () => [0]);
  fn('GetNumMapDebugObjects', () => [0]);

  fn('GetSubZoneText', () => [where().leaf]);
  fn('GetZoneText', () => [where().zone]);
  // See the header: identical to `GetZoneText` outside an instance, and this client enters none.
  fn('GetRealZoneText', () => [where().zone]);
  fn('GetMinimapZoneText', () => {
    const { leaf, zone } = where();
    return [leaf !== '' ? leaf : zone];
  });

  /**
   * `window.worldZone()` -- the whole resolution in one call, because it has four failure modes that
   * all look like a blank label.
   *
   * `areaId` 0 says the cell is not loaded; `loaded` false says the tables have not landed; a `leaf` with
   * no `zone` says the parent walk found no `WorldMapArea`, which would be a data question rather than a
   * wiring one; and both names present with a blank label on screen says the globals are right and the
   * frame is not reading them.
   */
  (window as unknown as Record<string, unknown>).worldZone = () => {
    const player = world.player;
    const map = world.map as unknown as { areaIdAt?: (x: number, y: number) => number } | null;
    const areaId = player && map && typeof map.areaIdAt === 'function'
      ? map.areaIdAt(player.position.x, player.position.y)
      : -1;
    return {
      loaded: mapData.loaded,
      areaId,
      area: areaId > 0 ? mapData.area(areaId) : null,
      zone: areaId > 0 ? mapData.zoneOf(areaId) : null,
      ...where(),
    };
  };

/**
   * THE ZONE-CHANGE EDGE, and without it the label is blank for ever.
   *
   * The owner's reading closed every other candidate: `loaded: true`, `areaId: 12`,
   * `zone: 'Elwynn Forest'` -- so the globals answer correctly and nothing was asking them. The client's
   * own file says why, and it is not a missing global:
   *
   *     <OnLoad>  Minimap.timer = 0; Minimap_Update();
   *               self:RegisterEvent("ZONE_CHANGED");
   *               self:RegisterEvent("ZONE_CHANGED_INDOORS");
   *               self:RegisterEvent("ZONE_CHANGED_NEW_AREA");
   *     <OnEvent function="Minimap_Update"/>          (`minimap.xml:741-751`)
   *
   * `Minimap_Update` runs ONCE at load -- before a world exists, when `GetMinimapZoneText` correctly
   * answers "" -- and after that the label only ever refreshes on those three events. **This engine fires
   * none of them**, so the blank was written at load and never rewritten. That is the same shape as the
   * scroll ranges: the client announces nothing itself and waits for the engine to say something changed.
   *
   * WHICH of the three, by the reference's own distinction between the leaf and the zone:
   *
   *  - the ZONE changed -> `ZONE_CHANGED_NEW_AREA`, which is the "you have entered Westfall" edge.
   *  - the zone is the same and the SUB-AREA changed -> `ZONE_CHANGED`.
   *  - `ZONE_CHANGED_INDOORS` is NOT fired: it needs the indoor bit out of `AreaTable.flags`, which this
   *    client does not read. Declared. Nothing is lost by its absence -- the client's handler is the same
   *    function for all three.
   *
   * Polled rather than pushed because there is nothing to push from: no `SMSG_ZONE_UPDATE` subscriber
   * exists and the area comes from the terrain cell under the player, which changes as he walks. The cost
   * is `areaIdAt` -- two divisions and a `Map#get` -- plus a compare, once per UI tick.
   */
  let lastArea = 0;
  let lastZone = '';

  const poll = (): void => {
    if (disposed || !mapData.loaded) {
      return;
    }
    const player = world.player;
    const map = world.map as unknown as { areaIdAt?: (x: number, y: number) => number } | null;
    if (!player || !map || typeof map.areaIdAt !== 'function') {
      return;
    }
    const areaId = map.areaIdAt(player.position.x, player.position.y);
    if (areaId === 0 || areaId === lastArea) {
      return;
    }
    lastArea = areaId;
    const zone = mapData.zoneOf(areaId)?.name ?? '';
    const zoneChanged = zone !== lastZone;
    lastZone = zone;
    fireEvent(vm, zoneChanged ? 'ZONE_CHANGED_NEW_AREA' : 'ZONE_CHANGED');
  };

  return {
    poll,
    dispose: () => {
      disposed = true;
      delete (window as unknown as Record<string, unknown>).worldZone;
    },
  };
}

/** What the host holds: a per-tick poll for the zone edge, and the teardown. */
export interface MapBridge {
  poll: () => void;
  dispose: () => void;
}

export default attachMapBridge;
