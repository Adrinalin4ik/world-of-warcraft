/**
 * THE ZONE THE PLAYER IS STANDING IN -- published by the map bridge, read by the channel bridge.
 *
 * A module sink for the reason `ui/map-selection.ts` is one: the two bridges own different halves of the
 * same question and neither has a reference to the other. The zone is polled in `ui/map-bridge.ts`'
 * closure, which already computes it every tick to decide whether to fire `ZONE_CHANGED_NEW_AREA`; the
 * channel bridge needs it because a zone channel's NAME contains the zone.
 *
 * ## Why not the Lua event
 *
 * `ZONE_CHANGED_NEW_AREA` is fired into the VM, and a TypeScript bridge cannot subscribe to a Lua event
 * -- only frames can. Reading `GetZoneText()` back out through `runExpr` on some other edge would be a
 * second source for the same value, polled at a different moment; giving the channel bridge its own
 * `areaIdAt` poll would be a second copy of the computation. A one-value sink is neither, and it rides
 * the poll that already exists.
 *
 * ## What it carries
 *
 * The zone's DISPLAY NAME, not its id, and that is the exception to `map-selection.ts`' reasoning rather
 * than a contradiction of it. That sink needed an id because its consumer compares against a quest's
 * `zoneOrSort` and has to walk the parent chain. This one's consumer substitutes the name into
 * `ChatChannels.dbc`'s `General - %s`, so the STRING is the value -- and it must be the same string the
 * server builds its channel name from, which is the zone's own localized `AreaTable` name.
 *
 * The empty string means the zone is not known yet: the terrain under the player has not resolved, or
 * `AreaTable` has not landed. A caller must treat it as "do not act", not as a zone called nothing.
 */

let source: (() => string) | null = null;

/**
 * Who wants to know WHEN it changed, not just what it is.
 *
 * **A GETTER ALONE WAS NOT ENOUGH AND THE FIRST VERSION DEADLOCKED ON IT.** The channel bridge needs
 * the zone to build `General - <ZoneName>`, and at attach time the terrain under the player has not
 * resolved -- so the value is `''`. Retrying on channel events cannot help: there are no channel
 * events until something is joined, and nothing can be joined until the zone is known. The map bridge
 * already detects the change on its own poll; carrying the edge is strictly cheaper than any consumer
 * polling for it.
 */
const listeners = new Set<(zone: string) => void>();

/** The map bridge publishes its zone. Called once per bridge. */
export function publishZone(zone: () => string): void {
  source = zone;
}

/**
 * The map bridge announces a change. Called from its own poll, which already computes this.
 *
 * Listeners are called even for an empty zone: a consumer that cares only about a real one tests for
 * it, and swallowing the transition here would hide a zone becoming UNKNOWN, which is a real state
 * (a worldport in flight).
 */
export function notifyZoneChanged(zone: string): void {
  for (const listener of [...listeners]) {
    listener(zone);
  }
}

/** Subscribe to the change. Returns the unsubscribe, which a bridge must call on teardown. */
export function onZoneChanged(listener: (zone: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the sink -- the bridge is going away. A stale closure would read a disposed world. */
export function clearZone(): void {
  source = null;
}

/**
 * The zone's display name, or `''` when it is not known.
 *
 * `''` also when no map bridge is attached at all, which is every glue screen: a caller that joins a
 * channel named after the zone must not act on it, and the empty string is what says so.
 */
export function currentZone(): string {
  return source === null ? '' : source();
}
