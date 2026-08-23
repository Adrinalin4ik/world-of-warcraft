/**
 * MINIMAP -- the zoom state, the player-arrow size, and the ping.
 *
 * `MINIMAP` has been in the class chain (`object.ts#WidgetClass`, parent `FRAME`) with **no methods of
 * its own**, and that is not a cosmetic gap: the very first thing `MinimapPing_OnLoad` does is
 *
 *     Minimap:SetPlayerTextureHeight(40);
 *     Minimap:SetPlayerTextureWidth(40);          (`minimap.lua:11-12`)
 *
 * and `MinimapPing` carries `<OnLoad function="MinimapPing_OnLoad"/>` (`minimap.xml`), so this runs
 * during document load, not on some path a player has to walk to. An absent method there throws out of
 * the OnLoad and takes the two `RegisterEvent` calls below it with it -- so `MINIMAP_PING` and
 * `MINIMAP_UPDATE_ZOOM` were never registered either. One missing method, three things silently gone.
 *
 * WHICH METHODS, measured rather than guessed: every `Minimap:<Method>` call across the 66 FrameXML
 * files decoded into this repo's scratchpad is `GetZoom` (5), `SetZoom` (2), `GetZoomLevels` (2),
 * `PingLocation` (1), `SetPlayerTextureHeight` (1), `SetPlayerTextureWidth` (1), plus `Show`/`Hide`/
 * `IsShown`/`GetWidth`/`GetHeight` which `FRAME` and `REGION` already answer by inheritance. So this
 * table is exactly the six the client actually calls and nothing speculative.
 *
 * ## THE ZOOM IS REAL STATE, and the terrain draw reads it
 *
 * `Minimap_ZoomInClick` is `SetZoom(GetZoom() + 1)` followed by a bounds check against
 * `GetZoomLevels() - 1` (`minimap.lua:158-172`). So the two buttons only behave -- enable, disable,
 * stop at the ends -- if the value actually moves and actually clamps. A `GetZoom` that always answered
 * 0 would leave `MinimapZoomOut` disabled for ever and `MinimapZoomIn` enabled for ever, which looks
 * like a button bug rather than a missing getter. **This is the same shape as the slider's `GetHeight`
 * returning the authored value**: the client computes its own state from the engine's number, so a
 * frozen number freezes every path built on it.
 *
 * `zoomOf` is exported because `ui/minimap-terrain.ts` reads it: the zoom level is what decides how many
 * ADT tiles fit in the circle.
 *
 * ## WHAT IS NOT SOURCED, said plainly
 *
 * **The level count, 5, has no file behind it here.** No DBC, no CVar and no FrameXML line states it;
 * it is the retail engine's number, carried from knowledge of the client rather than from data this
 * project can open. What the client's own code *does* require is only that it be at least 1, so the
 * two buttons have somewhere to stop. If a served file ever settles the count, this is the one line to
 * change -- flagged rather than dressed up as evidence.
 */
import { MethodContext, MethodTable, registerMethods } from '../object';
import { Widget } from '../../../widget';
import { notImplemented } from './region';

/**
 * How many zoom steps the minimap has, so the valid levels are `0 .. ZOOM_LEVELS - 1`.
 *
 * UNSOURCED -- see this file's header. The client requires only that it exceed 0.
 */
export const ZOOM_LEVELS = 5;

/**
 * The current zoom per Minimap widget, held outside `Widget` on purpose.
 *
 * A `WeakMap` rather than a new field on the widget class: exactly one frame in the game is a
 * `MINIMAP`, so a field would cost a word on all ~4,200 widgets to serve one of them, and the entry
 * dies with the widget without a teardown hook.
 */
const zooms = new WeakMap<Widget, number>();

/** The Minimap's zoom level, `0` when it has never been set. Read by `ui/minimap-terrain.ts`. */
export function zoomOf(widget: Widget): number {
  return zooms.get(widget) ?? 0;
}

const MINIMAP: MethodTable = {
  /**
   * `Minimap:GetZoom()` -- the current level, `0` until something sets it.
   *
   * 0 rather than nil deliberately, and this is the `0`-is-truthy trap's mirror image: here 0 is a
   * REAL level (fully zoomed out), not an absence, and the client does `if zoom == 0 then` on it.
   * Answering nil would make that comparison false and the arithmetic in `SetZoom(GetZoom() + 1)`
   * throw.
   */
  GetZoom: (ctx: MethodContext, self: number) => {
    const widget = ctx.registry.widget(self);
    return [widget === null ? 0 : zoomOf(widget)];
  },

  /**
   * `Minimap:SetZoom(level)` -- clamped into `0 .. ZOOM_LEVELS - 1`.
   *
   * Clamped rather than rejected because the client relies on it: `Minimap_ZoomInClick` sends
   * `GetZoom() + 1` and only *afterwards* checks whether it has hit the top (`minimap.lua:158-165`).
   * A rejected write there would leave the button enabled at a level it could never leave.
   *
   * No event is fired. `MINIMAP_UPDATE_ZOOM` is the engine telling the client the zoom moved for a
   * reason the client did not cause -- its handler re-enables BOTH buttons before re-deriving their
   * state (`minimap.lua:88-96`), which is right for an external change and wrong after a click, where
   * the click handler has already set them. Firing it here would undo the client's own work.
   */
  SetZoom: (ctx: MethodContext, self: number, args: unknown[]) => {
    const widget = ctx.registry.widget(self);
    if (widget === null) {
      return [];
    }
    const wanted = Number(args[0]);
    if (!Number.isFinite(wanted)) {
      return [];
    }
    zooms.set(widget, Math.max(0, Math.min(ZOOM_LEVELS - 1, Math.floor(wanted))));
    return [];
  },

  /** `Minimap:GetZoomLevels()` -- the count, so the top level is this minus one. Unsourced; see header. */
  GetZoomLevels: () => [ZOOM_LEVELS],

  /**
   * `Minimap:SetPlayerTextureHeight(h)` / `SetPlayerTextureWidth(w)` -- the size of the player arrow.
   *
   * Accepted and RECORDED rather than routed through `notImplemented`, and the distinction is the point
   * of the two calls in `MinimapPing_OnLoad`: this is a setter whose effect is a texture that does not
   * exist yet, so there is nothing to refuse and nothing to warn about. The value is kept because the
   * arrow is drawn by `ui/minimap-terrain.ts`, which reads the value below, and 40 is what the client asks
   * for. A `notImplemented` here would put a permanent gap in the load report for a call that is
   * perfectly well understood and merely early.
   */
  SetPlayerTextureHeight: (_ctx: MethodContext, _self: number, args: unknown[]) => {
    playerArrow.height = Number(args[0]) || playerArrow.height;
    return [];
  },
  SetPlayerTextureWidth: (_ctx: MethodContext, _self: number, args: unknown[]) => {
    playerArrow.width = Number(args[0]) || playerArrow.width;
    return [];
  },

  /**
   * `Minimap:PingLocation(x, y)` -- a genuine gap, so it says so.
   *
   * The ping is a texture animated over the minimap's own surface, and there is no surface yet. Called
   * from `Minimap_OnClick` (`minimap.lua`), i.e. on a gesture the owner can make, which is exactly the
   * case this project wants named in the load report rather than swallowed.
   */
  PingLocation: notImplemented(
    'PingLocation',
    'the minimap draws no terrain surface yet, so there is nothing for a ping to be placed over',
  ),
};

/**
 * The player arrow's requested size, as the client asked for it.
 *
 * Module-level rather than per-widget because there is one Minimap and the real engine's setter is
 * likewise global to it.
 *
 * **RECORDED AND NOT READ, and the round trip is worth writing down.** `ui/minimap-terrain.ts` did
 * size its arrow from this, and the owner's side-by-side against the real client showed the result
 * about twice too large. The reason is in `<Minimap>` itself: the arrow is named as a MODEL
 * (`minimapPlayerModel="...MinimapArrow.mdx"`), so 40 is the box the engine reserves and the visible
 * arrow inside it is smaller by a factor no file states. We draw the BLP, which fills its own box.
 *
 * So the drawn size is an unsourced constant with a live knob there, and this stays the client's
 * request faithfully recorded -- which is the honest state, not a gap.
 */
export const playerArrow = { width: 40, height: 40 };

registerMethods('MINIMAP', MINIMAP);

export default MINIMAP;
