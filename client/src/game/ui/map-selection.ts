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
 * THE ZONE'S AREA ID, and it started as the display name -- which was wrong for a reason worth keeping.
 *
 * The name looked like the cheaper join: `mapData.displayName` gives "Elwynn Forest" and the quest
 * log's header rows carry the same `AreaTable` name. But a quest's `zoneOrSort` may be a SUB-area --
 * a Northshire quest can sit under "Northshire Valley" while the map is showing "Elwynn Forest" -- and
 * then the two strings differ for a quest that is unquestionably on the displayed map. That is why
 * `QuestMapUpdateAllQuests` answered 0 with three quests in the log.
 *
 * An id lets the caller walk the parent chain (`mapData.zoneOf`), which is the same walk the minimap's
 * label already does and the only thing that gets a sub-area right. The argument for the name was that
 * it kept `AreaTable` out of the quest bridge -- and that was already false: the quest bridge reads
 * `AreaTable` itself to name its own headers.
 *
 * ZERO means no zone sheet is displayed -- the World or Cosmic view, or nothing loaded yet -- and the
 * client's own behaviour there is to list no quests, so 0 is a real answer rather than an absence.
 * `AreaTable` has no id 0, so it cannot mean anything else.
 */

let source: (() => number) | null = null;

/** The map bridge publishes its selection. Called once per bridge. */
export function publishMapSelection(areaId: () => number): void {
  source = areaId;
}

/** Drop the sink -- the bridge is going away. A stale closure would read a disposed world. */
export function clearMapSelection(): void {
  source = null;
}

/** The displayed zone's `AreaTable` id, or 0 when no zone sheet is up (or no bridge is attached). */
export function selectedZoneAreaId(): number {
  if (source === null) {
    return 0;
  }
  try {
    return source();
  } catch (error) {
    // A disposed world reached through a stale closure would otherwise take the quest list down with
    // it. The map bridge clears this on dispose, so reaching here at all is a bug -- reported, not
    // swallowed.
    console.warn('map selection: the published source raised', error);
    return 0;
  }
}
