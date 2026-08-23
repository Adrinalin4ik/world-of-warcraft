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

  /**
   * ZOOMING OUT, which is the map's own navigation and the one arm of it that was THROWING.
   *
   * `WorldMapFrame_UpdateMap` calls `IsZoomOutAvailable()` unguarded, right after it lays the twelve art
   * tiles (`worldmapframe.lua:269`). So an absent global did not merely leave the button in the wrong
   * state -- it raised out of `UpdateMap` and **took the whole rest of that function with it**: the
   * landmark loop, the overlay loop and the debug pass all sit below it. The tiles would appear and
   * nothing else would.
   *
   * `ZoomOut()` is the button's own click, and it is real rather than a stub because the selection state
   * to do it with is right here. The step order is the client's own zoom ladder read backwards -- a zone
   * zooms out to its continent, a continent to the cosmic sheet -- and `WorldMapFrame_Update` detects
   * that last state by `GetCurrentMapContinent() == WORLDMAP_COSMIC_ID`, which is what continent 0 means
   * in this bridge's convention (see `continentIndex`).
   *
   * So "available" is exactly "there is somewhere to go", i.e. a continent is selected at all. On the
   * cosmic sheet the client disables its own button, which is right: there is nothing further out.
   */
  fn('IsZoomOutAvailable', () => [continentIndex !== 0]);

  fn('ZoomOut', () => {
    if (continentIndex === 0) {
      return [];
    }
    const before = mark();
    if (zoneIndex !== 0) {
      zoneIndex = 0;
    } else {
      continentIndex = 0;
    }
    announce(before);
    return [];
  });

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
   * THE ZONE HIGHLIGHT under the cursor -- `UpdateMapHighlight(x, y)`, and eight nils is the right answer.
   *
   * Called from `WorldMapButton_OnUpdate` whenever the cursor is over the map (`worldmapframe.lua:755`),
   * and the client's very next lines are `if ( fileName ) then ... else WorldMapHighlight:Hide() end`. So
   * nils take the else branch, which is precisely "nothing is highlighted" -- the state the map is in for
   * most of every second the cursor moves across it.
   *
   * The real answer needs the per-zone highlight art (`Interface\WorldMap\<zone>\<zone>Highlight`) plus
   * the hit rectangle each zone occupies on its continent sheet, and neither is anything this client
   * reads today. A fabricated name here would make the client build a texture path from it and try to
   * load art that does not exist.
   */
  fn('UpdateMapHighlight', () => [null, null, null, null, null, null, null, null]);

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
   * `ProcessMapClick(x, y)` -- the click that zooms INTO a zone from a continent sheet.
   *
   * A gesture the owner will make, and a genuine gap: it needs the same per-zone hit rectangles
   * `UpdateMapHighlight` needs, since "which zone did he click" and "which zone is he over" are one
   * question. Returning nothing leaves the click inert, and the two dropdowns above the map are the
   * working route to the same place -- so the feature is reachable, just not by clicking.
   *
   * Not routed through a red `UIErrorsFrame` line: `WorldMapButton_OnClick` calls this on EVERY click on
   * the map, including the ones that are meant to do nothing, so a refusal notice would fire constantly.
   */
  fn('ProcessMapClick', () => []);

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
