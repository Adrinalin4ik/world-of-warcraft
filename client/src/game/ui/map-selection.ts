/**
 * WHICH ZONE THE WORLD MAP IS SHOWING -- published by the map bridge, read by the quest bridge.
 *
 * A module sink for the reason `ui/runtime-art.ts` is one: the two bridges own different halves of the
 * same question and neither has a reference to the other. The map's SELECTION lives in
 * `ui/map-bridge.ts`' closure (`continentIndex`/`zoneIndex`) and the quest LOG lives in
 * `ui/quest-bridge.ts`' closure, and the client's own `WorldMapFrame_UpdateQuests` needs both: it asks
 * how many quests are on the DISPLAYED map.
 *
 * Handing the quest bridge a reference to the map bridge would couple two independent attach orders --
 * the map bridge is SEEDED before the manifest and the quest bridge attaches after it, gated on a real
 * session -- and giving the map bridge its own copy of the quest log would be a second model of it. A
 * one-value sink is neither.
 *
 * The ZONE'S DISPLAY NAME rather than an area id, because that is what both sides already have in the
 * same form: `mapData.displayName` gives "Elwynn Forest" for the selected `WorldMapArea` row, and the
 * quest log's own header rows carry the same `AreaTable` name for the group a quest sits in. Comparing
 * ids would mean joining the quest template's `zoneOrSort` to `AreaTable` a second time, in the one file
 * that has no reason to know about `AreaTable` at all.
 *
 * EMPTY means no zone sheet is displayed -- the World or Cosmic view, or nothing loaded yet -- and the
 * client's own behaviour there is to list no quests, so an empty string is a real answer rather than an
 * absence.
 */

let source: (() => string) | null = null;

/** The map bridge publishes its selection. Called once per bridge. */
export function publishMapSelection(zoneName: () => string): void {
  source = zoneName;
}

/** Drop the sink -- the bridge is going away. A stale closure would read a disposed world. */
export function clearMapSelection(): void {
  source = null;
}

/** The displayed zone's name, or `''` when no zone sheet is up (or no map bridge is attached). */
export function selectedZoneName(): string {
  if (source === null) {
    return '';
  }
  try {
    return source();
  } catch (error) {
    // A disposed world reached through a stale closure would otherwise take the quest list down with
    // it. The map bridge clears this on dispose, so reaching here at all is a bug -- reported, not
    // swallowed.
    console.warn('map selection: the published source raised', error);
    return '';
  }
}
