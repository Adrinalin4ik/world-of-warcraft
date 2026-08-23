import { mapData } from '../pipeline/dbc/map-data';
import type { LuaVM } from './framexml/lua/vm';
import type World from '../world';

/**
 * WHERE THE PLAYER IS, in the words the interface shows -- the zone-text family.
 *
 * Step 3 of the map arc, and the first one with anything visible in it. Step 1 was the DBC tables
 * (`pipeline/dbc/map-data.ts`), step 2 the area under the player (`world/map.js#areaIdAt`), and this is
 * what turns those two into the strings the minimap and the world map print.
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
export function attachMapBridge(vm: LuaVM, world: World): () => void {
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

  const fn = (name: string, body: () => unknown[]): void => {
    vm.registerFunction(name, body);
  };

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

  return () => {
    disposed = true;
    delete (window as unknown as Record<string, unknown>).worldZone;
  };
}

export default attachMapBridge;
