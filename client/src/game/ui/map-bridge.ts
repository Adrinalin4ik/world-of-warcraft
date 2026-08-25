import { mapData, OverlayRow, WorldMapAreaRow } from '../pipeline/dbc/map-data';
import { eventListeners, fireEvent } from './framexml/lua/events';
import { getScriptHandler } from './framexml/lua/scripts';
import type { LuaVM } from './framexml/lua/vm';
import type World from '../world';
import type { MethodContext } from './framexml/lua/object';
import { publishMapSelection, clearMapSelection } from './map-selection';
import { zoneHighlights, setHighlightScale, lastHoverTest } from '../pipeline/zone-highlight';
import { isAreaExplored } from '../../network/game/object/update-object/explored-zones';
import { BlobPolygon, setBlobSource } from './quest-blobs';
import { resolveUnitToken } from '../world/unit-tokens';
import { drawItemOf, lastDrawnOf, rectOf, watchDrawn } from './rects';
import {
  activeTracking, setTracking, trackingTexturePath, visibleTracking,
} from './minimap-tracking';

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
/**
 * A `GlobalStrings.lua` entry, or null.
 *
 * The KEY is checked against a whitelist pattern before it reaches the chunk. Every key here is a
 * literal in this repo, so nothing hostile can arrive -- but the rule on this project is that only
 * numbers and global NAMES are ever spliced into a source string, and a regex is what makes that
 * true by construction rather than by inspection. Same shape as `ui/item-tooltip.ts#globalString`.
 */
const SAFE_GLOBAL = /^[A-Za-z_][A-Za-z0-9_]*$/;

function globalString(vm: LuaVM, key: string): string | null {
  if (!SAFE_GLOBAL.test(key)) {
    return null;
  }
  const answer = vm.runExpr(
    `if type(${key}) ~= "string" then return nil end return ${key}`,
    'map-bridge-global.lua',
  ) as { value?: unknown } | null;
  const value = answer === null ? null : answer.value;
  return typeof value === 'string' && value !== '' ? value : null;
}

export function attachMapBridge(vm: LuaVM, world: World, ctx: MethodContext): MapBridge {
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
   *  - The three TRACKING globals have LEFT this list -- they are real below. The sentence that used
   *    to be here said "tracking types are the tracking SPELLS the player knows, and this client
   *    models no such thing", and **that was wrong**: the owner photographed the menu in the real
   *    client and it is twelve fixed townsfolk categories -- Repair, Food & Drink, Reagents,
   *    Innkeeper and so on -- none of which is a spell. Tracking spells are a different, additional
   *    category (`GetTrackingInfo`'s fourth return distinguishes them), and those are still absent.
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
  /**
   * THE TRACKING MENU -- four globals, and the menu is derived entirely from them.
   *
   * `MiniMapTrackingDropDown_Initialize` walks `1..GetNumTrackingTypes()`, reads
   * `name, texture, active, category = GetTrackingInfo(id)` for each and adds a final None row whose
   * `checked` is set only when nothing is active (`minimap.lua:424-467`). So there is no list in Lua
   * to match -- what these answer IS the menu. `ui/minimap-tracking.ts` holds the list and the
   * evidence for its order.
   *
   * The NAME is resolved through the VM from its `GlobalStrings.lua` key, so a Russian client
   * localises itself and no English literal appears here. A key that resolves to nothing yields a
   * row the client skips, which is the honest outcome for a build whose strings differ.
   *
   * `category` is the client's own discriminator: it sets a tighter tex-coord crop for `"spell"` than
   * for anything else (`minimap.lua:438-448`), because a spell icon is a full square and a tracking
   * icon has its own margin. These are all townsfolk, so `"townsfolk"` it is -- and that is also the
   * word that keeps the spell branch reachable for the tracking SPELLS still absent here.
   */
  /**
   * The player's class, or 0 -- which matches no row's `onlyClass` and so shows only the common ones.
   *
   * 0 rather than a guess: before the descriptor lands the class is genuinely unknown, and a menu
   * missing a hunter row for one second is better than one that shows a rogue his ammunition.
   */
  const playerClassId = (): number => world.player?.fields.classId ?? 0;

  fn('GetNumTrackingTypes', () => [visibleTracking(playerClassId()).length]);

  fn('GetTrackingInfo', (args) => {
    const id = Math.trunc(Number(args[0]));
    const rows = visibleTracking(playerClassId());
    const row = id >= 1 && id <= rows.length ? rows[id - 1] : null;
    if (row === null) {
      return [null, null, null, null];
    }
    const name = globalString(vm, row.stringKey);
    return [
      name,
      trackingTexturePath(row),
      // `active` gates the tick, and the client also folds it into `anyActive` to decide whether
      // None is ticked -- so `false` and not nil: nil would be indistinguishable from an error to a
      // reader, and the client tests it for truth either way.
      activeTracking() === row,
      'townsfolk',
    ];
  });

  /**
   * `SetTracking(id)` -- 1-based into the class-filtered list, and **nil for the None row.**
   *
   * `MiniMapTracking_SetTracking` passes `self.value`, which the initialiser sets to `nil` on that
   * last row (`minimap.lua:462-465`). So an absent argument is not a caller mistake, it is the
   * documented way to turn tracking off, and `Number(undefined)` being NaN is what would have made
   * that silently select row 0.
   *
   * NOTHING IS SENT. A tracking SPELL writes `PLAYER_TRACK_CREATURES` server-side; the townsfolk
   * categories are a display filter over units this client already has, since `UNIT_NPC_FLAGS` is
   * decoded onto every one of them.
   */
  fn('SetTracking', (args) => {
    const raw = args[0];
    const id = raw === undefined || raw === null ? null : Math.trunc(Number(raw));
    setTracking(playerClassId(), id !== null && Number.isFinite(id) ? id : null);
    /**
     * **`MINIMAP_UPDATE_TRACKING`, and without it the button icon never changes.**
     *
     * The owner: "После выбора выбор не появляется в кружочке." The tick moved, so the choice was
     * taken -- what was missing is the announcement. `MiniMapTracking_SetTracking` calls this global
     * and nothing else (`minimap.lua:420-422`); the icon is repainted by `MiniMapTracking_Update`,
     * which the frame binds to `<OnEvent>` after registering `MINIMAP_UPDATE_TRACKING`
     * (`minimap.xml:479-482`). So the event is the engine telling the client the tracking moved, and
     * this is the engine.
     *
     * The same shape as the `unit:fields` and `QUEST_LOG_UPDATE` edges: the value was written
     * correctly and nothing told the reader.
     */
    fireEvent(vm, 'MINIMAP_UPDATE_TRACKING');
    return [];
  });

  /**
   * `GetTrackingTexture()` -- the button's own icon, or nil.
   *
   * `MiniMapTracking_Update` compares it with the icon's current texture and only then calls
   * `SetTexture` plus a shine (`minimap.lua:408-414`), so nil while nothing is tracked keeps that a
   * no-op rather than a flash -- which is what the old stub got right and is kept.
   */
  fn('GetTrackingTexture', () => {
    const row = activeTracking();
    return [row === null ? null : trackingTexturePath(row)];
  });
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
  /**
   * PUBLISH THE SELECTED ZONE for the quest bridge -- see `ui/map-selection.ts` on why a sink.
   *
   * The `AreaTable` id, and only for a ZONE sheet: a continent or the World view has no zone, and
   * the client's own quest list is empty there. `zoneIndex === 0` is that case.
   */
  publishMapSelection(() => {
    if (disposed || zoneIndex === 0) {
      return 0;
    }
    return selected()?.areaId ?? 0;
  });

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
  /**
   * One unit's position on the displayed sheet, or `0,0` for "not on this map".
   *
   * **FAILS OPEN on an unknown map, and that is a correction to my own previous version.** The first
   * one read `world.map?.mapID` and treated an absent handle as `-1`, i.e. as "matches nothing" --
   * so if that handle is ever missing, the marker disappears from EVERY sheet including the right
   * one. The owner saw exactly that: "На zone map не показывается наш персонаж."
   *
   * A check that suppresses a marker must only fire when it KNOWS the maps differ. Unknown means
   * "do not suppress" -- the behaviour before the check existed -- and `window.worldMap()` reports
   * the value so the handle can be looked at rather than guessed about.
   */
  const unitMapPosition = (
    row: WorldMapAreaRow,
    unit: { position: { x: number; y: number } },
  ): number[] => {
    const playerMapId = playerMapIdOf();
    if (playerMapId !== null && playerMapId !== row.mapId) {
      return [0, 0];
    }
    const at = mapData.normalise(row, unit.position.x, unit.position.y);
    return at === null ? [0, 0] : [at.x, at.y];
  };

  /** The map the player is standing on, or null when this client cannot say. */
  const playerMapIdOf = (): number | null => {
    const id = world.map?.mapID;
    return typeof id === 'number' ? id : null;
  };

  fn('GetPlayerMapPosition', (args) => {
    const row = selected();
    const player = world.player;
    /**
     * **EVERY unit token, not just "player" -- the party and raid arms call this same global.**
     *
     * `WorldMapFrame_UpdateUnits` walks `GetPlayerMapPosition(unit)` for each raid member and each
     * `party<i>` (`worldmapframe.lua:828,844`) and hides the dot on `0,0`, exactly as it does for the
     * player. Answering 0,0 for anything but "player" therefore hid every group member by
     * construction, which is what the owner asked about.
     *
     * `resolveUnitToken` is the same resolver the unit frames use, so "party1" means here what it
     * means everywhere else in this client -- and a member out of range, with no entity in the
     * world, resolves to null and correctly gets no dot.
     */
    const token = String(args[0] ?? '');
    const unit = token === 'player' ? player : resolveUnitToken(token, world);
    if (row === null || !unit) {
      return [0, 0];
    }
    /**
     * **THE MAP HAS TO MATCH, and without this the player drew on whatever sheet was open.**
     *
     * The owner: "Сейчас я нахожусь в эльвинском лесу, но меня также показывает в калимдоре по
     * тем же координатам." A world position means nothing off its own map, and Kalimdor's rect
     * happens to CONTAIN Elwynn's coordinates -- so `normalise` answered a perfectly good
     * fraction for a place the player is nowhere near.
     *
     * Compared against the selected row's OWN `mapId` and not the sheet's: a zone shown on
     * another continent through `displayMapID` is still entered from the map it lives on, so the
     * player standing in it is on `row.mapId`. Answering 0,0 is the engine's own "not on the
     * displayed map", and it is checked by name: `WorldMapButton_OnUpdate` reads `playerX == 0 and
     * playerY == 0` and hides the arrow, the ping and `WorldMapPlayer`
     * (`worldmapframe.lua:782-787`). The party and raid arms do the same with the same global
     * (`worldmapframe.lua:828-853`), so they inherit this check rather than needing their own.
     */
    return unitMapPosition(row, unit);
  });

  /**
   * THE DUNGEON AND DECORATION SURFACE, answered as EMPTY rather than left absent.
   *
   * `WorldMapFrame_Update` calls all of these on every open, and an absent global throws inside it --
   * which takes the whole map down rather than leaving one decoration off. Each answers the value that
   * means "there are none", and here that is true:
   *
   *  - Dungeon levels: this client enters no instances, so no levels and level 0.
   *  - Overlays: CLOSED, and no longer on this list -- see `GetNumMapOverlays` below.
   *  - Landmarks: `SMSG_WORLD_MAP_LANDMARKS`-fed points of interest, with no subscriber. Named.
   *  - Debug objects: a development surface with no data behind it in any build.
   */
  fn('GetCurrentMapDungeonLevel', () => [0]);
  fn('GetNumDungeonMapLevels', () => [0]);
  fn('SetDungeonMapLevel', () => []);
  fn('DungeonUsesTerrainMap', () => [false]);
  /**
   * THE EXPLORED-AREA PATCHES -- "разведанные территории", and the count is the EXPLORED count.
   *
   * `WorldMapFrame_Update` walks `1..GetNumMapOverlays()` and skips any row whose `textureName` is
   * nil or empty (`worldmapframe.lua:303-306`), so the engine is free to answer either a stable
   * count with holes in the values or a filtered count with none. This answers the FILTERED count,
   * because the two are indistinguishable to that loop and one index is easier to keep straight
   * than two.
   *
   * Exploration comes from the player's own descriptor -- `PLAYER_EXPLORED_ZONES_1`, 128 words,
   * indexed by `AreaTable.areaBit` (`update-object/explored-zones.ts`). Nothing on the wire
   * announces a discovery; the word changes and the map must notice. That is why the merge returns
   * a flag and why `applyUnitFields` folds it into the one it emits on.
   *
   * NOT the selected sheet but the selected ROW: overlays hang off a `WorldMapArea` row id, and on
   * the World or Cosmic sheet there is no row, so the list is empty and the client draws base art.
   */
  const overlaysNow = (): OverlayRow[] => {
    const row = selected();
    const player = world.player;
    if (row === null || !player) {
      return [];
    }
    const zones = player.exploredZones;
    return mapData.overlaysOf(
      row,
      (areaId) => isAreaExplored(zones, mapData.areaBitOf(areaId)),
    );
  };

  fn('GetNumMapOverlays', () => [overlaysNow().length]);
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
   * THE WORLD MAP'S PLAYER ARROW -- and `CreateWorldMapArrowFrame` had to CREATE A FRAME, not no-op.
   *
   * These five were declared gaps on the grounds that the arrow ROTATES and this widget layer draws
   * axis-aligned quads. That reasoning held for the art and was wrong about the frame, and the client
   * says so in its own comment:
   *
   *     -- PlayerArrowEffectFrame is created in code: CWorldMap::CreatePlayerArrowFrame()
   *     PlayerArrowEffectFrame:SetAlpha(0.65);           (`worldmapframe.lua:108-109`)
   *
   * **Line 109 is inside `WorldMapFrame_OnLoad`, so everything after it was dead** -- and the tail of
   * that function is not decoration:
   *
   *     WorldMapFrame_ResetFrameLevels();
   *     WorldMapDetailFrame:SetScale(WORLDMAP_QUESTLIST_SIZE);
   *     WorldMapButton:SetScale(WORLDMAP_QUESTLIST_SIZE);
   *     WorldMapFrame_SetPOIMaxBounds();
   *     WatchFrame.showObjectives = WorldMapQuestShowObjectives:GetChecked();
   *     ... the quest frames' font metrics and the two scroll frames' flags
   *
   * So the map has been laid out at scale 1 instead of the 0.691 the client asks for, every frame level
   * was left at its authored value, and the objective text had no line height. The owner saw the scale
   * half of that as "текст очень большой" -- the label IS 62 pt by `fonts.xml:165`, and 0.691 of 62 is
   * what he was comparing against.
   *
   * The frame is REAL and its art is still a gap, which is the same shape `<Minimap>` has: the client
   * only ever calls `SetAlpha` and `SetFrameLevel` on it (all five uses, grepped), so a frame is exactly
   * what it needs. `ShowWorldMapArrowFrame` and `PositionWorldMapArrowFrame` act on it for real, so the
   * day an arrow is drawn it is already in the right place at the right time.
   *
   * WHY THE ART IS STILL A GAP: the arrow turns with the player and the widget layer has no rotation.
   * The minimap solves it with a canvas (`ui/minimap-terrain.ts`), and the same trick would work here --
   * it needs the drawing host, which this bridge is seeded too early to have. Named, not implied.
   */
  const ARROW_FRAME = 'PlayerArrowEffectFrame';
  /**
   * THE ARROW'S OWN FRAME, a sibling of the effect frame -- and it exists because of one client line.
   *
   * `WorldMapFrame_OnLoad` does `PlayerArrowEffectFrame:SetAlpha(0.65)` (`worldmapframe.lua:109`),
   * and the name is the tell: that frame is the arrow's EFFECT -- the glow the engine pulses around
   * it -- not the arrow. Drawing our arrow inside it inherited an alpha meant for something else, and
   * the owner saw it at once: "она полупрозрачная почему-то".
   *
   * Alpha cascades multiplicatively in this widget layer, so a child cannot undo its parent's 0.65.
   * The arrow therefore gets a sibling frame at full alpha, and both are moved by the same
   * `PositionWorldMapArrowFrame` and shown by the same `ShowWorldMapArrowFrame` -- so the engine's
   * own two-part shape is honoured rather than collapsed, and the client keeps its 0.65 on the frame
   * it asked for.
   *
   * Named in the REGISTRY only and never minted as a Lua table, so no `_G` entry appears for a frame
   * the client does not know about. `ui/minimap-terrain.ts` finds it with `byName`.
   */
  const ARROW_ART_FRAME = '__worldMapPlayerArrow';
  let arrowFrameId: number | null = null;
  let arrowArtId: number | null = null;

  fn('CreateWorldMapArrowFrame', (args) => {
    if (arrowFrameId !== null) {
      return [];
    }
    const parent = ctx.frameIdOf(args[0]);
    if (parent === null) {
      return [];
    }
    try {
      arrowFrameId = ctx.registry.create('Frame', ARROW_FRAME, parent);
      /**
       * **`wrapper` IS WHAT PUBLISHES `_G[name]`, and creating the frame alone did not.**
       *
       * The registry's name map and Lua's global table are two different things: `registry.create`
       * records the name so `byName` can find it, and only minting the Lua table exports the global.
       * `object.ts`' own `CreateFrame` says so at the line it does it -- "minting it is also what
       * publishes `_G[name]`" -- and that was the line this was missing. The frame existed, the
       * registry knew its name, and `PlayerArrowEffectFrame` was still nil in Lua.
       *
       * The same trap waits for any future engine-created frame, which is why this is written here
       * rather than left as one call among four.
       */
      ctx.wrapper(arrowFrameId);
      // The sibling: same parent, full alpha, no Lua global. See `ARROW_ART_FRAME`.
      arrowArtId = ctx.registry.create('Frame', ARROW_ART_FRAME, parent);
    } catch (error) {
      console.warn(`CreateWorldMapArrowFrame: ${String(error)}`);
    }
    return [];
  });

  /** `InitWorldMapPing(frame)` -- the ping is authored art (`WorldMapPing`); nothing to create. */
  fn('InitWorldMapPing', () => []);

  /**
   * `UpdateWorldMapArrowFrames()` -- refreshes the arrow's rotation, of which there is none to refresh.
   * A no-op for the reason named above and not for want of a frame.
   */
  fn('UpdateWorldMapArrowFrames', () => []);

  /** `PositionWorldMapArrowFrame(point, relativeTo, relativePoint, x, y)` -- placed for real. */
  fn('PositionWorldMapArrowFrame', (args) => {
    const frames = [arrowFrameId, arrowArtId]
      .map((id) => (id === null ? null : ctx.registry.widget(id)))
      .filter((w): w is NonNullable<typeof w> => w !== null);
    if (frames.length === 0) {
      return [];
    }
    const point = String(args[0] ?? 'CENTER').toUpperCase();
    const relativePoint = String(args[2] ?? point).toUpperCase();
    const target = typeof args[1] === 'string' ? ctx.registry.byName(args[1]) : null;
    const relativeTo = target === null ? undefined : ctx.registry.widget(target)?.id;
    frames.forEach((widget) => widget.setAnchors({
      point: point as never,
      relativePoint: relativePoint as never,
      relativeTo,
      x: Number(args[3]) || 0,
      y: Number(args[4]) || 0,
    }));
    return [];
  });

  /** `ShowWorldMapArrowFrame(show)` -- nil hides, anything else shows. The client passes 1 or nil. */
  fn('ShowWorldMapArrowFrame', (args) => {
    const wanted = !(args[0] === undefined || args[0] === null || args[0] === false);
    [arrowFrameId, arrowArtId].forEach((id) => {
      const widget = id === null ? null : ctx.registry.widget(id);
      if (widget === null) {
        return;
      }
      if (wanted) {
        widget.show();
      } else {
        widget.hide();
      }
    });
    return [];
  });

  /**
   * The zone under a point on the CURRENT sheet, or null. Shared by the highlight and the click.
   *
   * Only a CONTINENT sheet has zones to find: on a zone sheet the client is already zoomed in, and on
   * the World or Cosmic sheet the buttons the client authors do the navigating.
   */
  /**
   * The zone under a point on the current CONTINENT sheet, tested against its SHAPE and not its rect.
   *
   * The rect is only the first pass. `WorldMapArea` gives a bounding rectangle, and the owner found
   * what that costs: hovering open water "очень далеко от локации" named Winterspring, because a
   * ragged coastline's bounding box is mostly sea. The real engine tests the zone's highlight
   * TEXTURE, whose alpha IS the outline -- so `pipeline/zone-highlight.ts` reads that alpha and this
   * asks it.
   *
   * Ordered rect-first because the rect is the cheap reject: it removes every zone but one or two
   * before any shape is sampled, and the sample is an array index.
   *
   * **A shape that has not landed yet answers null and the rect stands**, which keeps the first hover
   * after a map opens responsive rather than dead. That is a different answer from "outside": null
   * means ask again, false means this point is not in this zone.
   */
  type SheetRect = { left: number; right: number; top: number; bottom: number };

  const zoneAtPoint = (fractionX: number, fractionY: number): {
    row: WorldMapAreaRow; rect: { left: number; right: number; top: number; bottom: number };
  } | null => {
    if (continentIndex < 1 || zoneIndex !== 0 || !mapData.loaded) {
      return null;
    }
    const continent = mapData.continents()[continentIndex - 1];
    if (continent === undefined) {
      return null;
    }
    /**
     * **ASK EVERY CANDIDATE, because the rects overlap -- this is the zone-name bug, measured.**
     *
     * The owner hovered the Barrens and `window.worldMapHover()` reported `art: "Mulgore"`,
     * `inside: false`, `luminance: 0`. Mulgore's rect contains that point and is the smaller of the
     * two, so it was the only candidate tested; its outline correctly rejected the point, and the
     * old code returned null rather than trying the Barrens. Hence a name in one small patch and
     * nowhere else -- and hence a highlight that looked right whenever the patch was reached.
     *
     * The outline is what distinguishes overlapping rects, so each candidate is asked in
     * smallest-rect-first order and the first whose SHAPE accepts wins.
     *
     * A candidate whose art has not loaded answers null, not false. That is kept as a FALLBACK
     * rather than accepted outright: a definite yes from a larger zone should beat a "do not know"
     * from a smaller one, and answering the unknown immediately would reinstate exactly the
     * first-match behaviour this fixes for the first second after a map opens.
     */
    let fallback: { row: WorldMapAreaRow; rect: SheetRect } | null = null;
    for (const row of mapData.zonesAtSheetPoint(continent.mapId, fractionX, fractionY)) {
      const rect = mapData.sheetRectOfZone(continent.mapId, row);
      if (rect === null) {
        continue;
      }
      const opaque = zoneHighlights.opaqueAtSheetPoint(row.art, rect, fractionX, fractionY);
      if (opaque === true) {
        return { row, rect };
      }
      if (opaque === null && fallback === null) {
        fallback = { row, rect };
      }
    }
    return fallback;
  };

  /**
   * The CONTINENT under a point on the World sheet, as a 1-based index, or 0.
   *
   * The other half of what the owner asked for: "на уровне континентов подписей нет". The World sheet
   * is the one at continent 0, and hovering it should name a continent the way hovering a continent
   * names a zone. `dbc/map-data.ts#worldRects` is the projection and carries the note about the one
   * unsourced number in it -- the sheet margin.
   *
   * The COSMIC sheet (-1) is deliberately not answered: it carries two authored buttons of its own,
   * `AzerothButton` and `OutlandButton`, which the client shows and handles itself
   * (`worldmapframe.lua:237-239`). There is nothing for a hit test to add there.
   */
  const continentAtPoint = (fractionX: number, fractionY: number): number => {
    if (continentIndex !== 0 || !mapData.loaded) {
      return 0;
    }
    const order = mapData.continents();
    for (const placed of mapData.worldRects()) {
      const rect = placed.rect;
      if (fractionX < rect.left || fractionX > rect.right
        || fractionY < rect.top || fractionY > rect.bottom) {
        continue;
      }
      const index = order.findIndex((row) => row.mapId === placed.mapId);
      if (index >= 0) {
        return index + 1;
      }
    }
    return 0;
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
    const x = Number(args[0]);
    const y = Number(args[1]);
    const hit = zoneAtPoint(x, y);
    if (hit !== null) {
      const { row, rect } = hit;
      /**
       * THE NAME AND THE ART, and the art uses the SAME alignment the hover just used.
       *
       * The client draws the whole image at what it is given and crops from the top-left
       * (`worldmapframe.lua:762-772`), so `texPercentageX/Y` stay 1 -- the image is a power of two
       * with nothing to crop, and what is not outline is black, which its authored `alphaMode="ADD"`
       * makes transparent.
       *
       * `drawRectFor` inverts the mask's own registration of the outline against the zone rect, so
       * what lights up is what the hover agreed with. Its error is named at that function: the rect
       * is the zone's PLAYABLE bounds and includes coastal water, so the shape draws a little larger
       * than the landmass. That is a smaller and different error from the three placements that were
       * in the wrong place, and it is honest about being an alignment rather than a derivation.
       *
       * A nil `fileName` still takes the client's own "nothing is highlighted" branch, which is what
       * a zone whose art the host does not serve gets.
       */
      const draw = zoneHighlights.drawRectFor(row.art, rect);
      const crop = zoneHighlights.usedTexCoords();
      return draw === null
        ? [mapData.displayName(row), null, null, null, null, null, null, null]
        : [
          mapData.displayName(row), row.art, crop.x, crop.y,
          draw.width, draw.height, draw.left, draw.top,
        ];
    }
    // The World sheet names a CONTINENT instead, from `Map.dbc` -- "Eastern Kingdoms", not the art
    // folder "Azeroth", the same distinction `GetMapContinents` makes.
    const continent = continentAtPoint(x, y);
    if (continent > 0) {
      const sheet = mapData.continents()[continent - 1];
      const name = mapData.mapName(sheet.mapId) ?? sheet.art;
      return [name, null, null, null, null, null, null, null];
    }
    return [null, null, null, null, null, null, null, null];
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
   * THE LANDMARK GETTERS, unreachable behind a count of 0 and registered anyway.
   *
   * Same rule as above: `SMSG_WORLD_MAP_LANDMARKS` has no subscriber, so the count sits at 0 and this
   * is its getter rather than a new gap. `ClickLandmark` is the one an owner could reach by gesture --
   * but only by clicking a landmark that cannot be drawn, so there is no route to it either.
   */
  /**
   * ONE EXPLORED-AREA PATCH -- the seven values the client's overlay loop destructures.
   *
   * Order is the client's own, read off the call and not from memory: `textureName, textureWidth,
   * textureHeight, offsetX, offsetY, mapPointX, mapPointY` (`worldmapframe.lua:305`).
   *
   * **`textureName` is a PATH here and a bare name in the DBC.** The client appends a 1-based tile
   * index to whatever it gets -- `SetTexture(textureName..n)` at `worldmapframe.lua:351` -- so the
   * engine must hand back everything up to that index. `Interface\WorldMap\<art>\<name>` is the
   * shape, verified on the host: `interface/worldmap/elwynn/stormwind1.blp` answers 200 with a
   * `BLP2` header.
   *
   * `mapPointX`/`mapPointY` are 0 in every one of the 988 rows on the served file, so they are
   * passed through as the zeros they are rather than invented. The client destructures them and
   * never reads them.
   *
   * The index is 1-based and out of range answers nil, which the loop's own `if ( textureName ...`
   * guard already handles -- the same shape as an unexplored row in the real engine.
   */
  fn('GetMapOverlayInfo', (args) => {
    const index = Math.trunc(Number(args[0]));
    const row = selected();
    const list = overlaysNow();
    const overlay = index >= 1 && index <= list.length ? list[index - 1] : null;
    if (overlay === null || row === null) {
      return [null];
    }
    return [
      `Interface\\WorldMap\\${row.art}\\${overlay.textureName}`,
      overlay.width,
      overlay.height,
      overlay.offsetX,
      overlay.offsetY,
      0,
      0,
    ];
  });
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
   * is unreachable behind it. `GetQuestPOILeaderBoard` and `GetQuestWorldMapAreaID` are the BLOB half
   * -- the shaded objective areas, which `WorldMapBlobFrame` draws from the same POI reply the pins
   * now use. The pins are done (`QuestPOIGetIconInfo` below); the blobs still are not, because they
   * need the polygon rendered rather than a point, and `GetQuestWorldMapAreaID` answering 0 is what
   * keeps the client from drawing one in the wrong place while that is true.
   *
   * The quest LOG side of this panel is real and already works -- `GetQuestLogTitle`,
   * `GetQuestLogLeaderBoard`, `GetNumQuestLeaderBoards` and the watch functions all answer from decoded
   * packets. It is only the map-placement half that is absent.
   */
  /**
   * THE QUEST-POI ENGINE PAIR -- the numbered pins on the map, and they are REAL now.
   *
   * Their absence used to break the panel outright:
   *
   *     framexml: WorldMapQuestShowObjectives: OnClick: WorldMapFrame.lua:1540:
   *         attempt to call a nil value (global 'QuestPOIUpdateIcons')
   *
   * `WorldMapQuestShowObjectives_Toggle` calls it on the checkbox click, so the raise took the whole
   * toggle with it and the quest list never appeared. Both are ENGINE globals -- `questpoi.lua`
   * defines only the `QuestPOI_*` helpers, checked on the served file.
   *
   * `QuestPOIUpdateIcons` is where the QUERY belongs, because it is what the client calls once per
   * map update (`worldmapframe.lua:1540`). The ids come from the DESCRIPTOR -- `world.player`'s own
   * quest log -- and not from `ui/quest-bridge.ts`, because the descriptor is where log membership
   * actually lives and this bridge would otherwise depend on the order the two attach in.
   *
   * `queryPois` drops ids it already has or has in flight, so a map repainting on a health tick
   * sends nothing. See `network/game/object/quest.ts#queryPois`.
   */
  /**
   * THE BLOB POLYGONS -- the same POI reply the pins read, projected onto the displayed sheet.
   *
   * Installed as a sink rather than passed, because `WorldMapBlobFrame:DrawQuestBlob` is a widget
   * METHOD and a `MethodContext` carries no `World` (`ui/quest-blobs.ts` states the same reason).
   * This is the half that knows the world, the quest handler and which sheet is open; the raster is
   * the half that knows the canvas.
   *
   * Same map discipline as the pins and the player arrow: a POI's points are world coordinates
   * inside its own `worldMapAreaId`, so a POI on another sheet contributes nothing rather than a
   * polygon in the wrong place. A one- or two-point POI is a PIN and not an area -- it is the
   * marker `QuestPOIGetIconInfo` already draws -- so only genuine polygons come through here.
   */
  setBlobSource((questId) => {
    const row = selected();
    if (row === null) {
      return [];
    }
    const pois = world.game.objectHandler.questHandler.pois.get(questId) ?? [];
    const out: BlobPolygon[] = [];
    for (const poi of pois) {
      if (poi.worldMapAreaId !== row.id || poi.points.length < 3) {
        continue;
      }
      const points: { x: number; y: number }[] = [];
      for (const point of poi.points) {
        const at = mapData.normalise(row, point.x, point.y);
        if (at !== null) {
          points.push(at);
        }
      }
      if (points.length >= 3) {
        out.push({ points });
      }
    }
    return out;
  });

  fn('QuestPOIUpdateIcons', () => {
    const player = world.player;
    if (!player) {
      return [];
    }
    const ids: number[] = [];
    player.questLog.forEach((slot) => {
      if (slot.questId > 0) {
        ids.push(slot.questId);
      }
    });
    world.game.objectHandler.questHandler.queryPois(ids);
    return [];
  });

  /**
   * `QuestPOIGetIconInfo(questId)` -> `completed, posX, posY, objective`.
   *
   * **Only the middle two are used by anything this client ships.** `WorldMapFrame_DisplayQuestPOI`
   * discards the first and the fourth (`worldmapframe.lua:1711`) and no other FrameXML file calls
   * this global at all -- checked against the served `questpoi.lua`, `watchframe.lua` and
   * `questlogframe.lua`. So the first return is the one value here with no oracle in the game's own
   * files: it is the POI's completion flag per the documented signature, and it is labelled rather
   * than presented as measured.
   *
   * `posX`/`posY` are fractions of `WorldMapDetailFrame`, which the client multiplies by the frame's
   * size and the windowed scale itself (`worldmapframe.lua:1719-1720`). **nil, not 0,0, when there is
   * no marker** -- the client guards on `if ( posX and posY )`, so a 0,0 would pin every quest to the
   * top-left corner of the sheet.
   *
   * ## THE MAP HAS TO MATCH, the same rule as the player arrow
   *
   * A POI's points are WORLD coordinates inside its own `worldMapAreaId`, so they mean nothing on
   * another sheet -- the mistake that drew the player in Kalimdor while he stood in Elwynn. This
   * answers nil unless the displayed row IS that area. A quest whose POI sits on a different zone
   * therefore has no pin, which is also what the real client does: its quest list is per zone.
   *
   * Continent-level sheets are NOT projected, and that is a stated gap rather than an oversight: it
   * would need the POI composed through `sheetRect` the way the zone rects are, and the quest list
   * the pins belong to is itself filtered to one zone (`ui/quest-bridge.ts#questsOnMap`).
   *
   * A POI with several points is an objective AREA. The position is the mean of its points, because
   * a pin needs one place and the centre is the only choice that does not favour a corner.
   */
  fn('QuestPOIGetIconInfo', (args) => {
    const questId = Math.trunc(Number(args[0]));
    const row = selected();
    if (!Number.isFinite(questId) || questId <= 0 || row === null) {
      return [null];
    }
    const pois = world.game.objectHandler.questHandler.pois.get(questId);
    if (pois === undefined) {
      // Not asked yet -- a different answer from "no POI", and nil is right for both.
      return [null];
    }
    const poi = pois.find((candidate) => (
      candidate.worldMapAreaId === row.id && candidate.points.length > 0
    ));
    if (poi === undefined) {
      return [null];
    }
    const mid = poi.points.reduce(
      (into, point) => ({ x: into.x + point.x, y: into.y + point.y }),
      { x: 0, y: 0 },
    );
    const at = mapData.normalise(row, mid.x / poi.points.length, mid.y / poi.points.length);
    if (at === null) {
      return [null];
    }
    return [poi.objectiveIndex < 0, at.x, at.y, poi.objectiveIndex];
  });

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
    const x = Number(args[0]);
    const y = Number(args[1]);
    const hit = zoneAtPoint(x, y);
    if (hit === null) {
      // On the World sheet a click picks a CONTINENT, which is the zoom step above a zone.
      const continent = continentAtPoint(x, y);
      if (continent > 0) {
        continentIndex = continent;
        zoneIndex = 0;
        announce();
      }
      return [];
    }
    const continent = mapData.continents()[continentIndex - 1];
    const index = mapData.zonesOn(continent.mapId)
      .findIndex((zone) => zone.areaId === hit.row.areaId);
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
  /**
   * `window.worldMapHover()` -- what the hover test computed for the LAST point under the cursor.
   *
   * Hover a spot, move the pointer off the map, then call it. See `lastHover` in
   * `pipeline/zone-highlight.ts` for why this exists: the drawn highlight and the name are supposed
   * to read one placement, and they visibly disagree, so this reports the arithmetic rather than
   * leaving it to be inferred from a screenshot.
   */
  /**
   * `window.worldTracking()` -- why the tracking button shows no icon.
   *
   * The blips draw, so the choice is stored and the art exists. What is left is the button, and
   * three things could each be it alone: the event never reaching the frame, `MiniMapTracking_Update`
   * skipping because `GetTexture()` already equals the new value, or the region having a sprite that
   * does not draw. They look identical on screen.
   *
   * So this reports both sides of the comparison the client makes
   * (`MiniMapTrackingIcon:GetTexture() ~= texture`, `minimap.lua:410`) plus whether the region is
   * registered, shown and sized -- and it FIRES the event itself, so the same call also says whether
   * dispatching it changes anything.
   */
  /**
   * `window.worldMapTooltip()` -- why the world-map tooltip text goes grey.
   *
   * The owner: fine on the big map at first, grey once the map has been WINDOWED, and grey on the
   * big map thereafter. That shape is state left behind by the windowed transition, not a property
   * of the mode -- otherwise returning would restore it.
   *
   * Ruled out statically first: `WorldMapTooltip` is `parent="WorldMapFrame"`
   * (`worldmapframe.xml:1139`), nothing calls `WorldMapFrame:SetAlpha` (grepped: the only
   * `SetAlpha` calls are the ping, the arrow effect frame, and `SetOpacity`'s borders plus
   * `WorldMapDetailFrame`/`WorldMapPOIFrame`), and `SetScale` is never applied to `WorldMapFrame` or
   * to the tooltip. So neither the alpha cascade nor the scale chain explains it on paper, which is
   * exactly when to measure instead of reasoning.
   *
   * Reports what the RENDERER sees for each line: the widget alpha, the cascaded alpha, the
   * effective scale, and the font colour and size actually resolved -- not the values handed in.
   * `fillItemLines` passes `1,1,1`, so a grey line means something downstream of that, and this is
   * downstream.
   */
  (window as unknown as Record<string, unknown>).worldMapTooltip = () => {
    /**
     * ARM THE SAMPLER on the first call, then read what it caught.
     *
     * The tooltip is in the draw list only while the pointer is on a POI, so calling this while it is
     * on screen is impossible by hand. First call arms; hover, then call again and the numbers are
     * from the frames it was actually drawn on. `at` says how many frames ago, so a stale sample
     * cannot be mistaken for a live one.
     */
    watchDrawn([
      'WorldMapTooltip', 'WorldMapTooltipTextLeft1', 'WorldMapTooltipTextLeft2',
      'WorldMapTooltipBackdrop', 'WorldMapFrame', 'WorldMapDetailFrame',
    ]);
    const id = ctx.registry.byName('WorldMapTooltip');
    const tip = id === null ? null : ctx.registry.widget(id);
    if (tip === null) {
      return { note: 'WorldMapTooltip is not in the registry' };
    }
    const lines: unknown[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const lineId = ctx.registry.byName(`WorldMapTooltipTextLeft${i}`);
      const line = lineId === null ? null : ctx.registry.widget(lineId);
      if (line === null) {
        continue;
      }
      lines.push({
        n: i,
        text: line.displayText,
        shown: line.shown,
        alpha: line.alpha,
        colour: line.font?.color ?? null,
        size: line.font?.size ?? null,
        family: line.font?.family ?? null,
        effectiveScale: line.effectiveScale,
        // THE CASCADED alpha and the draw position -- see `rects.ts#drawItemOf`. The own alpha above
        // read 1 on every line while the pixels were grey, which is exactly what a dimming ANCESTOR
        // looks like from here.
        drawn: drawItemOf(line.id),
        lastDrawn: lastDrawnOf(line.id),
      });
    }
    return {
      tooltip: {
        alpha: tip.alpha,
        shown: tip.shown,
        visible: tip.visible,
        effectiveScale: tip.effectiveScale,
        scale: tip.scale,
        drawn: drawItemOf(tip.id),
        lastDrawn: lastDrawnOf(tip.id),
        // The backdrop, whose draw index decides whether it covers the text.
        backdrop: (() => {
          const b = ctx.registry.byName('WorldMapTooltipBackdrop');
          const w = b === null ? null : ctx.registry.widget(b);
          return w === null ? null : { alpha: w.alpha, drawn: drawItemOf(w.id) };
        })(),
      },
      // The frames the windowed transition DOES touch, for comparison.
      detailFrameAlpha: (() => {
        const d = ctx.registry.byName('WorldMapDetailFrame');
        const w = d === null ? null : ctx.registry.widget(d);
        return w === null ? null : { alpha: w.alpha, scale: w.scale };
      })(),
      // The ancestors, so a dimming parent is visible rather than inferred.
      ancestors: ['WorldMapFrame', 'WorldMapDetailFrame'].map((name) => {
        const wid = ctx.registry.byName(name);
        const w = wid === null ? null : ctx.registry.widget(wid);
        return {
          name,
          alpha: w?.alpha ?? null,
          lastDrawn: w === null ? null : lastDrawnOf(w.id),
        };
      }),
      lines,
    };
  };

  (window as unknown as Record<string, unknown>).worldTracking = () => {
    const iconId = ctx.registry.byName('MiniMapTrackingIcon');
    const icon = iconId === null ? null : ctx.registry.widget(iconId);
    const before = icon?.sprite ?? null;
    fireEvent(vm, 'MINIMAP_UPDATE_TRACKING');
    const row = activeTracking();
    return {
      // What `GetTrackingTexture` answers -- the string the client is handed.
      wanted: row === null ? null : trackingTexturePath(row),
      activeRow: row?.stringKey ?? null,
      // The region itself. `null` for `regionFound` means the name resolves to nothing, which would
      // make the client's own `MiniMapTrackingIcon:GetTexture()` raise rather than skip.
      regionFound: iconId !== null,
      spriteBefore: before,
      spriteAfterEvent: icon?.sprite ?? null,
      shown: icon?.shown ?? null,
      visible: icon?.visible ?? null,
      rect: icon === null ? null : rectOf(icon.id),
      /**
       * WHO IS LISTENING, because the sprite not moving after a dispatch leaves only two causes.
       *
       * The region resolves, is shown and has a rect, and its sprite is null -- so
       * `MiniMapTrackingIcon:GetTexture()` answers nil, `nil ~= path` is TRUE, and
       * `MiniMapTracking_Update` was obliged to call `SetTexture`. It did not. So either nothing is
       * registered for the event, or the frame that is has no `OnEvent` bound.
       *
       * `MiniMapTrackingButton` is the one that registers, in an inline `<OnLoad>` body
       * (`minimap.xml:478-482`) -- and an inline body that failed to compile would leave the frame
       * loaded, named and silent, which is exactly this shape.
       */
      listeners: eventListeners('MINIMAP_UPDATE_TRACKING').map((id) => ({
        name: ctx.registry.nameOf(id),
        hasOnEvent: getScriptHandler(vm, id, 'OnEvent') !== null,
      })),
      buttonFound: ctx.registry.byName('MiniMapTrackingButton') !== null,
      updateGlobal: vm.isRef(vm.getGlobal('MiniMapTracking_Update')),
    };
  };

  (window as unknown as Record<string, unknown>).worldMapHover = () => lastHoverTest();

  /**
   * `window.worldMapHighlight(0.9)` -- a multiplier on the derived highlight size. No argument
   * restores 1, which is the derivation itself. See `HIGHLIGHT_PX` in `pipeline/zone-highlight.ts`.
   */
  (window as unknown as Record<string, unknown>).worldMapHighlight = (factor?: number) => (
    setHighlightScale(typeof factor === 'number' ? factor : null)
  );

  (window as unknown as Record<string, unknown>).worldMap = () => {
    const row = selected();
    const continents = mapData.continents();
    const art = row?.art ?? '';
    return {
      dbcLoaded: mapData.loaded,
      // THE TWO MAP IDS THE MARKER COMPARES, because a suppressed marker is otherwise invisible
      // to diagnose: null here means this client cannot say which map the player is on, and the
      // check then deliberately does not suppress anything. See `unitMapPosition`.
      playerMapId: playerMapIdOf(),
      selectedRowMapId: row?.mapId ?? null,
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
      clearMapSelection();
      disposed = true;
      delete (window as unknown as Record<string, unknown>).worldZone;
      delete (window as unknown as Record<string, unknown>).worldMap;
      delete (window as unknown as Record<string, unknown>).worldMapHighlight;
      delete (window as unknown as Record<string, unknown>).worldMapHover;
      delete (window as unknown as Record<string, unknown>).worldTracking;
      delete (window as unknown as Record<string, unknown>).worldMapTooltip;
      // The blob source outlives this bridge otherwise, and it closes over a disposed world.
      setBlobSource(null);
    },
  };
}

/** What the host holds: a per-tick poll for the zone edge, and the teardown. */
export interface MapBridge {
  poll: () => void;
  dispose: () => void;
}

export default attachMapBridge;
