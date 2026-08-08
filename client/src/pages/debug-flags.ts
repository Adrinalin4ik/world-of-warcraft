/**
 * `?debug=true` -- the switch that puts the development overlays on screen.
 *
 * The same shape as every other flag this app reads off the query string (`?ui=lua` in
 * `game/ui/world-ui.ts:120` and `pages/glue/index.tsx:26`, `?offline=1` in
 * `network/offline-session.ts`, `?realmlist=`/`?gateway=` in `network/gateway.ts`): one
 * `URLSearchParams` read of `window.location.search`, taken at the point of use rather than stored,
 * so a route change that preserves the search preserves the flag.
 *
 * That preservation is not incidental. Both route transitions carry `window.location.search`
 * verbatim -- `pages/glue/index.tsx#enterWorld` (`navigate({ pathname: '/game', search:
 * window.location.search })`) and `pages/game/index.tsx#disconnected` (the same with `/`) -- which is
 * the fix commit `8faf890` put in after a disconnect silently dropped `?ui=lua` and brought the
 * player back to a differently-configured login screen. `debug` rides on that, and needs no second
 * mechanism.
 *
 * DEFAULT OFF. The overlays it gates are how most of this project's bugs were found, so nothing here
 * removes them or the measurement behind them -- `PerfMonitor` still samples every frame with the HUD
 * hidden (see `game/perf/hud.ts#PerfHud`), and the only work that genuinely stops is the DOM write
 * and the React reconciliation that had nothing to paint into.
 */
export function wantsDebugPanels(search: string): boolean {
  return new URLSearchParams(search).get('debug') === 'true';
}
