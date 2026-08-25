/**
 * WHICH QUESTS ARE WATCHED, for the parts of the engine outside the quest bridge.
 *
 * The watch set is a UI concept: `AddQuestWatch`/`RemoveQuestWatch` are client globals and the set
 * lives in `ui/quest-bridge.ts`, which owns `IsQuestWatched` and `GetNumQuestWatches`. Nothing on the
 * wire carries it.
 *
 * The minimap needs it -- a tracked quest gets an edge arrow pointing at its objective -- and the
 * minimap host has no route to that bridge. So this is a sink of the same shape as `ui/pointer.ts` and
 * `ui/map-selection.ts`, for the same reason each of those exists: two hosts that come and go
 * independently, and one of them holds a fact the other needs.
 *
 * The QUEST IDS and not the log indices. An index is a position in a list that renumbers whenever the
 * log changes, and the reader here is a per-frame builder that would then have to re-resolve it; an id
 * is stable and is what `QuestHandler.pois` is keyed by anyway.
 */
let reader: (() => number[]) | null = null;

/** Install the reader. Called by `ui/quest-bridge.ts`; pass null on teardown. */
export function setWatchedQuestSource(next: (() => number[]) | null): void {
  reader = next;
}

/** The watched quest ids, or an empty array when nothing has installed a reader. */
export function watchedQuestIds(): number[] {
  return reader === null ? [] : reader();
}
