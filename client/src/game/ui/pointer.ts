/**
 * WHERE THE POINTER IS, for the parts of the engine that cannot reach the input router.
 *
 * `GameTooltip:SetOwner(owner, "ANCHOR_CURSOR")` is the case this exists for, and its own comment in
 * `framexml/lua/methods/gametooltip.ts` named the obstacle exactly: "it needs the live pointer, which
 * this object model has no route to (the router is `ui/input.ts` and nothing in `MethodContext`
 * reaches it)". This is that route.
 *
 * A module SINK and not a field on `MethodContext`, for the same reason `ui/map-selection.ts` is one:
 * the object model is built once per VM and knows nothing about which screen is mounted, while the
 * router belongs to a host that comes and goes. The host installs a reader; the model asks.
 *
 * ## Who needs it
 *
 * Three cursor anchors exist in the engine and the client asks for two of them:
 * `WorldMapQuestPOI_SetTooltip` uses `ANCHOR_CURSOR_RIGHT` (`worldmapframe.lua:1867`) and
 * `ui/minimap-terrain.ts` asks for `ANCHOR_CURSOR` for a blip tooltip. Both were silently unanchored
 * before this -- the warning was there, but a warning is not a tooltip.
 *
 * ## Units
 *
 * LOGICAL UNITS, the same space `ui/rects.ts` resolves rects in and the same one the router hit-tests
 * in. Not device pixels: `api/screen.ts`' `GetCursorPosition` answers those, and mixing the two is the
 * documented hazard in `methods/frame.ts:191-194`.
 */
export interface PointerAt {
  x: number;
  y: number;
}

let reader: (() => PointerAt | null) | null = null;

/**
 * Install the reader. Called by the host that owns the input router; pass null on teardown.
 *
 * Null on teardown matters: the reader closes over a router, and a stale one outliving its host is
 * exactly the double-mount hazard this project has voided four measurements to.
 */
export function setPointerSource(next: (() => PointerAt | null) | null): void {
  reader = next;
}

/** The pointer in logical units, or null when nothing has installed a reader or it has not moved yet. */
export function pointerAt(): PointerAt | null {
  return reader === null ? null : reader();
}
