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
   * **THE CONTINENT NUMBERING IS THE CLIENT'S, and I had it wrong.** `worldmapframe.lua:8-10` states it
   * outright and these are not values to infer:
   *
   *     WORLDMAP_COSMIC_ID  = -1;
   *     WORLDMAP_WORLD_ID   = 0;
   *     WORLDMAP_OUTLAND_ID = 3;
   *
   * So **0 is not "nothing chosen" -- it is the WORLD sheet**, the parchment with the three continents
   * on it, and -1 is the cosmic sheet above that. `WorldMapFrame_Update`'s own fallback reads exactly
   * that way: no art name and continent -1 gives "Cosmic", no art name and anything else gives "World"
   * (`worldmapframe.lua:234-245`). The owner's first screenshot was that World sheet, drawn correctly
   * for a selection of 0 -- which is why it looked like the map worked and then never changed.
   *
   * `WORLDMAP_OUTLAND_ID = 3` is also what settles the continent ORDER, in `dbc/map-data.ts`: index 3
   * is Outland, which holds for `WorldMapContinent.dbc`'s mapIDs (0, 1, 530, 571) and not for
   * `WorldMapArea`'s file order. A version-numbered constant taken from the game's own file rather
   * than assumed, which is this project's rule about the reference in as many words.
   *
   * A continent with zone 0 is the continent-wide sheet, which is the `WorldMapArea` row whose `areaId`
   * is 0 -- corroborated on the served file: rows 13/14/466/485 are the four, arted "Kalimdor",
   * "Azeroth", "Expansion01" and "Northrend".
   */
  let continentIndex = 0;

  let zoneIndex = 0;

  /** The `WorldMapArea` row the selection names, or null when nothing is selected or loaded. */
  const selected = (): WorldMapAreaRow | null => {
    // 0 (the World sheet) and -1 (Cosmic) have no `WorldMapArea` row at all, and null is the right
    // answer for both: `GetMapInfo` then returns nil and the client picks its own art name.
    if (continentIndex < 1) {
      return null;
    }
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
   * The ZONE's `AreaTable` id under the player, or 0. The id half of `where()`, which answers names.
   *
   * The ZONE and not the leaf, and that distinction is load-bearing for `GetZonePVPInfo`: Northshire
   * Valley (9) carries faction mask 0 while its parent Elwynn Forest (12) carries 2, so reading the leaf
   * would call the abbey contested.
   */
  const zoneAreaId = (): number => {
    const player = world.player;
    const map = world.map as unknown as { areaIdAt?: (x: number, y: number) => number } | null;
    if (disposed || !mapData.loaded || !player || !map || typeof map.areaIdAt !== 'function') {
      return 0;
    }
    const leaf = map.areaIdAt(player.position.x, player.position.y);
    return leaf === 0 ? 0 : (mapData.zoneOf(leaf)?.areaId ?? 0);
  };

  /** 2 = Alliance, 4 = Horde. Transcribed from the client's race roster -- see `GetZonePVPInfo`. */
  const RACE_FACTION_MASK = new Map<number, number>([
    [1, 2], [3, 2], [4, 2], [7, 2], [11, 2],
    [2, 4], [5, 4], [6, 4], [8, 4], [10, 4],
  ]);

  const playerFactionMask = (): number => {
    const fields = (world.player as unknown as { fields?: { race?: number } } | null)?.fields;
    const race = typeof fields?.race === 'number' ? fields.race : 0;
    return RACE_FACTION_MASK.get(race) ?? 0;
  };

  /** The client's own localised faction word, or '' before GlobalStrings has run. */
  const factionWord = (mask: number): string => {
    const name = mask === 2 ? 'FACTION_ALLIANCE' : 'FACTION_HORDE';
    const read = vm.runExpr(`return ${name}`, 'faction');
    return 'value' in read && typeof read.value === 'string' ? read.value : '';
  };

  /**
   * `GetZonePVPInfo()` -> `pvpType, isSubZonePvP, factionName`, and it is REAL now.
   *
   * The owner spotted it as a colour: the zone name over the minimap is GREEN in the real client and
   * plain in ours, and so is the banner on entering a zone. Both read this one global --
   * `Minimap_Update` runs a five-way ladder on `pvpType` (`minimap.lua:30-43`) where "friendly" is
   * `SetTextColor(0.1, 1.0, 0.1)` -- so one nil here was two wrong colours.
   *
   * ## THE AREA SIDE IS MEASURED, not transcribed
   *
   * `AreaTable.factionGroupID` is a MASK rather than a `FactionGroup.dbc` id, which the served file
   * settles: Elwynn Forest (12) is **2**, Durotar (14) is **4**, Stranglethorn Vale (33) is **0** and
   * Dalaran (4395) is **6**. So 2 is Alliance, 4 is Horde, 6 is both and 0 is contested. The file is
   * 2307 records, 36 fields, 144 B/record and closes exactly.
   *
   * ## THE PLAYER SIDE IS NOT SOURCED, and that is said rather than hidden
   *
   * The fully-sourced chain is `ChrRaces.factionID` -> `Faction.parentID` -> 469 (Alliance) / 67
   * (Horde), and `ChrRaces.factionID` was measured for it: races 1/3/4 read 1/3/4, race 7 reads 115,
   * race 11 reads 1629, races 2/5/6 read 2/5/6, race 8 reads 116, race 10 reads 1610. Walking it needs
   * `Faction.dbc` loaded, and this bridge is seeded before the manifest for a session that may never
   * open a map -- so `RACE_FACTION_MASK` above is transcribed instead, with the same standing as
   * `framexml/bindings.ts`'s default keys: the client's own race roster, not a column this project read.
   *
   * `factionName` is the client's own `FACTION_ALLIANCE`/`FACTION_HORDE` global, read out of the VM
   * rather than spelled here so a localised build gets its own word.
   *
   * NOT ANSWERED: "arena", and the sanctuary FLAG. `AreaTable.flags` is now read and deliberately not
   * interpreted -- Dalaran's mask of 6 already reads as sanctuary, and guessing a bit position for a
   * case this client cannot reach would be inventing a source.
   */
  fn('GetZonePVPInfo', () => {
    const zone = zoneAreaId();
    const area = zone === 0 ? null : mapData.area(zone);
    if (area === null) {
      return [null, false, null];
    }
    const zoneMask = area.factionGroupMask;
    if (zoneMask === 6) {
      return ['sanctuary', false, null];
    }
    if (zoneMask === 0) {
      return ['contested', false, null];
    }
    const mine = playerFactionMask();
    if (mine === 0) {
      // The race is not known yet, so nothing can be said about whose land this is. nil takes the
      // client's own else branch and paints NORMAL_FONT_COLOR, which is what it does at load.
      return [null, false, null];
    }
    const type = zoneMask === mine ? 'friendly' : 'hostile';
    return [type, false, factionWord(zoneMask)];
  });

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
   *  - `IsPartyLFG`, `IsInLFGDungeon` -> the LFG eye's update functions (`minimap.lua:242-244`). nil,
   *    which is the "not queued" state every one of those ladders falls through to.
   *
   *    **`GetLFGMode` is NOT here, and it was until the client's own file was read.** It is not an
   *    engine global at all -- `uiparent.lua:3570` defines it in Lua, on top of `GetLFGProposal`,
   *    `GetLFGInfoServer` and `GetLFGRoleUpdate`, which ARE the engine's. Registering it here shadowed
   *    a function the client ships. Harmless once this bridge is seeded before the manifest (the real
   *    definition simply lands later and wins), and wrong in any other order -- so it is gone, and the
   *    three real globals under it are declared in `api/units.ts` with the rest of the cluster.
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
  /**
   * **UNCONDITIONALLY, and the dedupe that used to be here is what made the map go BLACK on its
   * second opening.**
   *
   * `WorldMapFrame_OnHide` ends with `WorldMap_ClearTextures()` -- `SetTexture(nil)` on all twelve
   * detail tiles, every overlay and the frame art (`worldmapframe.lua:1063-1072`) -- and then calls
   * `SetMapToCurrentZone()`. `OnShow` calls `SetMapToCurrentZone()` again. So on the second opening
   * the selection has NOT changed, and a dedupe here fired nothing, and `WorldMapFrame_UpdateMap`
   * never ran, and the textures stayed cleared. The owner saw precisely that: parchment, then black,
   * then a partial redraw.
   *
   * The lesson is the one this project keeps relearning from the other direction: **an event is not
   * a change notification when the client uses it as a redraw request.** The real engine fires
   * `WORLD_MAP_UPDATE` on both of those calls, because the frame it repaints has been torn down in
   * between and only the client knows that.
   *
   * The cost is one `WorldMapFrame_UpdateMap` per open and per close, which is what the real client
   * pays. It is not a per-frame cost: nothing calls these setters on a tick.
   */
  const announce = (): void => {
    fireEvent(vm, 'WORLD_MAP_UPDATE');
  };



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
    if (!Number.isFinite(continent)) {
      return [];
    }
    // -1 (Cosmic) and 0 (World) are REAL selections and not out of range -- `WorldMapZoomOutButton`
    // sends both by name (`worldmapframe.lua:637-645`). Only a positive index has to resolve.
    if (continent >= 1 && mapData.continents()[continent - 1] === undefined) {
      return [];
    }
    continentIndex = continent;
    zoneIndex = Number.isFinite(zone) && zone > 0 ? zone : 0;
    announce();
    return [];
  });

  /**
   * `SetMapToCurrentZone()` -- the map follows the player once, on request.
   *
   * **The event fires even when the zone cannot be resolved, and that is not sloppiness.** The client
   * calls this from `WorldMapFrame_OnShow` AND from `OnHide` (which has just cleared every texture),
   * and it is relying on the engine to announce that the map needs repainting -- not on the selection
   * having moved. A zone we cannot place leaves the selection where it was, which then draws the World
   * sheet; announcing nothing would leave the frame BLANK instead, which is what the owner saw.
   */
  fn('SetMapToCurrentZone', () => {
    const zone = currentZoneRow();
    if (zone !== null) {
      continentIndex = zone.continent;
      zoneIndex = zone.zone;
    }
    announce();
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
        continentIndex = c + 1;
        zoneIndex = index + 1;
        announce();
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

  /**
   * ZOOMING OUT -- `IsZoomOutAvailable` was THROWING, and `ZoomOut` is not what it looks like.
   *
   * `WorldMapFrame_Update` calls `IsZoomOutAvailable()` unguarded, right after it lays the twelve art
   * tiles (`worldmapframe.lua:269`), so an absent global raised out of that function and took the
   * landmark loop, the overlay loop and the debug pass below it. Available whenever there is somewhere
   * further out to go, i.e. anywhere but the Cosmic sheet -- **`-1`, not 0**; 0 is the World sheet and
   * still has a rung above it (`worldmapframe.lua:8-9`).
   *
   * **`ZoomOut()` IS NOT THE ZOOM-OUT BUTTON, and reading the client is what showed that.** Its own
   * `WorldMapZoomOutButton_OnClick` walks the whole ladder itself with `SetMapZoom` --
   * zone -> continent -> World -> Cosmic (`worldmapframe.lua:632-647`) -- and reaches `ZoomOut()` in
   * exactly two branches: a dungeon map with a level above 0, and the Cosmic sheet. This client enters
   * no instances (`GetCurrentMapDungeonLevel` answers 0) and there is nothing outside Cosmic, so both
   * branches are unreachable.
   *
   * An earlier version of this file implemented the ladder here instead. That was wrong twice over: it
   * duplicated logic the client already has, and it would have FOUGHT it -- the button calls
   * `SetMapZoom` first and would then have had this stepping the selection a second time.
   */
  fn('IsZoomOutAvailable', () => [continentIndex !== -1]);

  fn('ZoomOut', () => []);

  /**
   * THE ROTATING PLAYER ARROW -- five globals, all declared gaps, and declaring them is what makes the
   * client's OWN player marker work.
   *
   * `CreateWorldMapArrowFrame(WorldMapFrame)` is the seventh line of `WorldMapFrame_OnLoad`
   * (`worldmapframe.lua:84`), so an absent global raised THERE, at document load, and took the three
   * lines below it with it -- the black divider's `SetVertexColor`, `InitWorldMapPing`, and
   * `WorldMapFrame_Update()` itself. This is the same defect the minimap's `SetPlayerTextureHeight` had,
   * found in the same round: one missing engine call, and a frame's entire load is gone.
   *
   * **The gap is genuinely the ROTATION, and no-oping these is therefore not a loss.** The engine's
   * arrow frame is a rotating overlay, and this renderer draws axis-aligned quads only -- there is no
   * per-item rotation in `widget.ts#DrawItem` and adding one is a renderer change, not a bridge one.
   * The art was checked rather than assumed: `interface/worldmap/worldmaparrow.blp` **404s** on the asset
   * host (and a 404 there returns an HTML page, the trap that names the wrong subsystem twice over),
   * while `interface/minimap/minimaparrow.blp` and `rotating-minimaparrow.blp` both answer 200 and are
   * both a single 32x32 arrow by their BLP headers -- so not a strip of pre-rotated frames a TexCoord
   * could select from either.
   *
   * What matters is what the client does with the lines after them:
   *
   *     WorldMapPlayer:Show();
   *     WorldMapPlayer:SetPoint("CENTER", "WorldMapDetailFrame", "TOPLEFT", playerX, playerY);
   *                                                     (`worldmapframe.lua:792-793`)
   *
   * `WorldMapPlayer` is AUTHORED art the client positions itself, and it was unreachable only because
   * `UpdateWorldMapArrowFrames()` raised eleven lines above it. So the player's position on the map is
   * drawn by the client's own frame, and what is missing is the second, rotating marker on top of it --
   * position without facing. Named, not implied.
   */
  fn('CreateWorldMapArrowFrame', () => []);
  fn('InitWorldMapPing', () => []);
  fn('UpdateWorldMapArrowFrames', () => []);
  fn('PositionWorldMapArrowFrame', () => []);
  fn('ShowWorldMapArrowFrame', () => []);

  /**
   * The zone under a point on the CURRENT sheet, or null. Shared by the highlight and the click.
   *
   * Only a CONTINENT sheet has zones to find: on a zone sheet the client is already zoomed in, and on
   * the World or Cosmic sheet the buttons the client authors do the navigating.
   */
  const zoneAtPoint = (fractionX: number, fractionY: number): WorldMapAreaRow | null => {
    if (continentIndex < 1 || zoneIndex !== 0 || !mapData.loaded) {
      return null;
    }
    const continent = mapData.continents()[continentIndex - 1];
    if (continent === undefined) {
      return null;
    }
    return mapData.zoneAtSheetPoint(continent.mapId, fractionX, fractionY);
  };

  /**
   * `UpdateMapHighlight(x, y)` -> the zone under the cursor. REAL now, and it names the zone.
   *
   * It was eight nils, declared because "which zone is the cursor over" needed per-zone hit rectangles
   * this client did not compute. It computes them now -- `dbc/map-data.ts#zoneAtSheetPoint`, from
   * `WorldMapContinent`'s sheet extent and each `WorldMapArea` rect -- so the answer is data rather than
   * a stub.
   *
   * **The NAME is answered and the TEXTURE is not, and the client handles that split itself.** Its next
   * lines are `WorldMapFrame.areaName = name; WorldMapFrameAreaLabel:SetText(name)` and then
   * `if ( fileName ) then ... else WorldMapHighlight:Hide() end` (`worldmapframe.lua:758-777`), so a name
   * without a file gives exactly the right behaviour: the zone name appears under the cursor and no
   * highlight art is drawn.
   *
   * The art is the gap that remains: `Interface\WorldMap\<zone>\<zone>Highlight` plus the four
   * percentages and offsets that place it, which are the engine's own crop of a highlight sheet and not
   * something `WorldMapArea` states. Naming that rather than inventing a `fileName` the client would
   * then try to load.
   */
  fn('UpdateMapHighlight', (args) => {
    const row = zoneAtPoint(Number(args[0]), Number(args[1]));
    if (row === null) {
      return [null, null, null, null, null, null, null, null];
    }
    return [mapData.displayName(row), null, null, null, null, null, null, null];
  });

  /**
   * THE DEBUG ZONE MAP -- `false`, and false is a fact rather than a stub.
   *
   * `HasDebugZoneMap()` is called unguarded inside `WorldMapFrame_UpdateMap` (`worldmapframe.lua:363`),
   * below the landmark and overlay loops, so this was the SECOND raise in that one function. It gates a
   * 32x32 double loop over `GetDebugZoneMap(x, y)`, i.e. 1,024 calls per map update, and the retail
   * client answers false outside a development build too.
   *
   * `GetDebugZoneMap` and `GetMapDebugObjectInfo` cannot be reached with the count and the flag at zero
   * and false, and are registered anyway for the reason the object model registers unreachable methods:
   * an addon duck-types before it calls.
   */
  fn('HasDebugZoneMap', () => [false]);
  fn('GetDebugZoneMap', () => [null]);
  fn('GetMapDebugObjectInfo', () => [null]);

  /**
   * THE LANDMARK AND OVERLAY GETTERS, unreachable behind their own counts of 0 and registered anyway.
   *
   * Same rule as above, and the same reason the counts sit at 0 twenty lines up: `WorldMapOverlay.dbc`
   * parses and nothing reads it, and `SMSG_WORLD_MAP_LANDMARKS` has no subscriber. Both already named as
   * real gaps there; these are their getters, not new gaps.
   *
   * `ClickLandmark` is the one an owner could reach by gesture -- but only by clicking a landmark that
   * cannot be drawn, so there is no route to it either.
   */
  fn('GetMapOverlayInfo', () => [null]);
  fn('GetMapLandmarkInfo', () => [null]);
  fn('ClickLandmark', () => []);

  /**
   * THE BATTLEFIELD OVERLAY -- three counts at 0, their getters, and the request that would fill them.
   *
   * `WorldMapFrame_UpdateUnits` walks all three every map update, and each count is `0` because this
   * client joins no battleground: there is no `SMSG_BATTLEFIELD_STATUS` handler, so a flag carrier, an
   * ally position or a siege vehicle would be inventing data rather than reporting none.
   *
   * `RequestBattlefieldPositions` is the client asking the SERVER to start streaming them, so a no-op is
   * the honest shape rather than a refusal: nothing is refused, nothing is sent, and the counts stay 0.
   * `GetWintergraspWaitTime` answers nil, which is the client's own "no queue information".
   */
  fn('GetNumBattlefieldFlagPositions', () => [0]);
  fn('GetNumBattlefieldPositions', () => [0]);
  fn('GetNumBattlefieldVehicles', () => [0]);
  fn('GetBattlefieldFlagPosition', () => [null, null, null]);
  fn('GetBattlefieldPosition', () => [null, null, null]);
  fn('GetBattlefieldVehicleInfo', () => [null]);
  fn('RequestBattlefieldPositions', () => []);
  fn('GetWintergraspWaitTime', () => [null]);

  /**
   * WHERE THE PLAYER DIED -- `0, 0`, which is the engine's own "not applicable".
   *
   * `WorldMapFrame_UpdateUnits` reads both, and the client's guard is a comparison against 0 -- the same
   * zero-means-nowhere convention `GetPlayerMapPosition` already uses for a unit that is not on the
   * displayed map. So 0,0 hides the corpse marker and the spirit-healer marker, which is correct for a
   * living character and is what this client always has: no death handling exists.
   *
   * **Zeros here, nil elsewhere, and the difference is the trap.** `0` is truthy in Lua, so a getter
   * meaning "nothing" must normally answer nil -- but these two are read as NUMBERS and compared against
   * 0 by the client's own guard, so nil would make that comparison throw instead of falling through.
   * The convention to follow is the caller's, not the rule's.
   */
  fn('GetCorpseMapPosition', () => [0, 0]);
  fn('GetDeathReleasePosition', () => [0, 0]);

  /**
   * THE QUEST PANEL'S REMAINING GETTERS, honest empties.
   *
   * `GetNumQuestItemDrops` at 0 makes the quest panel skip the item-drop rows, and `GetQuestLogItemDrop`
   * is unreachable behind it. `GetQuestPOILeaderBoard` and `GetQuestWorldMapAreaID` are the POI half --
   * the objective blobs drawn on the map itself -- which needs `SMSG_QUEST_POI_QUERY` and has no
   * handler; `GetQuestWorldMapAreaID` answering 0 is what makes the client treat every quest as "not on
   * this map" and draw no blob, rather than drawing one in the wrong place.
   *
   * The quest LOG side of this panel is real and already works -- `GetQuestLogTitle`,
   * `GetQuestLogLeaderBoard`, `GetNumQuestLeaderBoards` and the watch functions all answer from decoded
   * packets. It is only the map-placement half that is absent.
   */
  /**
   * THE QUEST-POI ENGINE PAIR, and their absence was breaking the map's quest panel outright:
   *
   *     framexml: WorldMapQuestShowObjectives: OnClick: WorldMapFrame.lua:1540:
   *         attempt to call a nil value (global 'QuestPOIUpdateIcons')
   *
   * `WorldMapQuestShowObjectives_Toggle` calls it on the checkbox's click, so the raise took the
   * whole toggle with it and the quest list never appeared. Both are ENGINE globals -- `questpoi.lua`
   * defines only the `QuestPOI_*` helpers, checked on the served file, so nothing was going to supply
   * these later.
   *
   * A no-op and a nil are the right answers rather than placeholders: the POI icons are the numbered
   * blobs on the map, fed by `SMSG_QUEST_POI_QUERY_RESPONSE`, which has no subscriber. `GetNumQuestPOIs`
   * already answers 0 in `ui/quest-bridge.ts`, so nothing can reach `QuestPOIGetIconInfo` -- it is
   * registered for the reason the object model registers unreachable methods: an addon duck-types
   * before it calls.
   */
  fn('QuestPOIUpdateIcons', () => []);
  fn('QuestPOIGetIconInfo', () => [null]);

  fn('GetNumQuestItemDrops', () => [0]);
  fn('GetQuestLogItemDrop', () => [null]);
  fn('GetQuestPOILeaderBoard', () => [null]);
  fn('GetQuestWorldMapAreaID', () => [0]);

  /**
   * `SetupFullscreenScale(frame)` and `ToggleMapFramerate()` -- no-ops, and the first one is VISIBLE.
   *
   * `SetupFullscreenScale` is the engine sizing the map frame to fill the screen, called from
   * `WorldMapFrame_OnShow` whenever the saved size is not the small windowed one
   * (`worldmapframe.lua:132-134`). A no-op leaves the map at the scale its XML authored, so **the map
   * may open smaller than it should** -- that is a real visual consequence and it belongs on the owner's
   * check list rather than in a claim here. The reason it is not implemented is that the scale factor is
   * the engine's own and no served file states it; guessing one would look right on this screen and
   * wrong on another.
   *
   * `ToggleMapFramerate` is a development readout with nothing behind it in any build.
   */
  fn('SetupFullscreenScale', () => []);
  fn('ToggleMapFramerate', () => []);

  /**
   * `ProcessMapClick(x, y)` -- the click that zooms INTO a zone from a continent sheet. REAL now.
   *
   * The owner reported it as "клики не проходят и зоны не выделяются", and both were the same missing
   * piece: the per-zone rectangles. `UpdateMapHighlight` above answers "which zone is the cursor over"
   * and this answers "which zone did he click" from the same lookup.
   *
   * Selecting through the same path the dropdown uses, rather than writing the indices here: the zone
   * index is 1-based over `zonesOn`, and duplicating that ordering would be a second place for it to
   * drift out of step with `GetMapZones`.
   *
   * A click on empty water finds no zone and does nothing, which is what the real client does.
   */
  fn('ProcessMapClick', (args) => {
    const row = zoneAtPoint(Number(args[0]), Number(args[1]));
    if (row === null) {
      return [];
    }
    const continent = mapData.continents()[continentIndex - 1];
    const index = mapData.zonesOn(continent.mapId).findIndex((zone) => zone.areaId === row.areaId);
    if (index < 0) {
      return [];
    }
    zoneIndex = index + 1;
    announce();
    return [];
  });

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
  /**
   * `window.worldMap()` -- what the WORLD MAP's engine side actually answers, in one call.
   *
   * The owner reports the map frame drawing with "карта не рендерится, селекторы ничего не дают
   * выбрать" -- no art and dead dropdowns -- and those two symptoms have four quite different causes
   * that look identical from a screenshot: the DBCs never loaded; they loaded but the selection is 0
   * so there is no row to name art from; the selection is fine but `GetMapInfo` answers an art name
   * the host does not serve; or all of that is right and the client never ran `UpdateMap`.
   *
   * **Build the instrument before the fix.** This prints all four at once, including the exact texture
   * path the client would build for tile 1, so the next thing to check is a single URL rather than a
   * guess. `tile1` is what `WorldMapFrame_UpdateMap` composes at `worldmapframe.lua:255-262`:
   * `Interface\WorldMap\<art>\<art><i>`.
   */
  (window as unknown as Record<string, unknown>).worldMap = () => {
    const row = selected();
    const continents = mapData.continents();
    const art = row?.art ?? '';
    return {
      dbcLoaded: mapData.loaded,
      continents: continents.length,
      // The SAME expression `GetMapContinents` answers with, not `displayName`. A probe that reports
      // something the global does not is the trap this project has hit three times: the dropdown
      // said "Eastern Kingdoms" while this printed the art folder "Azeroth", which reads as a bug
      // in the global rather than in the probe.
      continentNames: continents.map((entry) => mapData.mapName(entry.mapId) ?? entry.art),
      selection: { continentIndex, zoneIndex },
      zonesOnSelected: continentIndex === 0
        ? 0
        : mapData.zonesOn(continents[continentIndex - 1]?.mapId ?? -1).length,
      currentZoneRow: currentZoneRow(),
      selectedRow: row === null ? null : {
        areaId: row.areaId, mapId: row.mapId, art: row.art,
      },
      // The path the client builds for the first of its twelve detail tiles. If this is empty the
      // selection is the problem; if it is populated, check whether the host serves it.
      tile1: art === '' ? '' : `Interface\\WorldMap\\${art}\\${art}1`,
      /**
       * `WorldMapFrame.blockWorldMapUpdate`, read out of the VM -- the LAST unread half of the guard.
       *
       * `WorldMapFrame_OnEvent` only redraws when `not self.blockWorldMapUpdate and self:IsShown()`, and
       * `WorldMapFrame_ToggleWindowSize` sets that flag true, does five things, and clears it
       * (`worldmapframe.lua:1296-1306`). **If any of those five raises, the flag is true for the rest of
       * the session and this event is ignored for ever** -- which is this project's own documented trap
       * about recovery that lives after a raise, and SHIFT-M is the gesture that walks into it.
       * Everything else in the guard has now been read and is correct, so this is what is left.
       */
      blockWorldMapUpdate: (() => {
        const read = vm.runExpr('return WorldMapFrame and WorldMapFrame.blockWorldMapUpdate', 'probe');
        return 'value' in read ? read.value : `error: ${String(read)}`;
      })(),
      isShown: (() => {
        const read = vm.runExpr('return WorldMapFrame and WorldMapFrame:IsShown()', 'probe');
        return 'value' in read ? read.value : `error: ${String(read)}`;
      })(),
      playerAt: (() => {
        const at = world.player;
        return at ? { x: at.position.x, y: at.position.y } : null;
      })(),
    };
  };

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
      delete (window as unknown as Record<string, unknown>).worldMap;
    },
  };
}

/** What the host holds: a per-tick poll for the zone edge, and the teardown. */
export interface MapBridge {
  poll: () => void;
  dispose: () => void;
}

export default attachMapBridge;
