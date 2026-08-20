/**
 * THE LAST FRAME'S RESOLVED RECTS, so `Region:GetLeft/GetRight/GetTop/GetBottom/GetCenter` can answer.
 *
 * ## Why this module exists at all
 *
 * `world-ui.ts:571-572` states the problem exactly: *"`registry.widget(id)` has no rect (the layout
 * pass computes rects, it does not store them)"*. `resolveAnchors` builds a `Map<string, Rect>`, hands
 * it to `drawList`, and drops it. So a widget knows its authored size and its anchors, and nothing in
 * the client could answer where it actually ENDED UP -- which is what those five methods are for.
 *
 * **This was found by a real failure, not by auditing the method table.** A tooltip on a bag item threw
 * `containerframe.lua:759: attempt to call a nil value (method 'GetRight')` from
 * `ContainerFrameItemButton_OnEnter`, which reads the button's right edge to decide which side of the
 * screen to anchor the tooltip on. `worldframe.ts:46-47` had already asserted in a comment that
 * "`GetLeft`, `GetTop`, `GetWidth`, `GetHeight`, `GetCenter` and `IsShown` all answer" -- of those six,
 * only `GetWidth`, `GetHeight` and `IsShown` were ever implemented. That comment described a design,
 * not the code.
 *
 * ## The source is the DRAW LIST, which is the honest one
 *
 * The same array the input router hit-tests (`world-ui.ts#setDrawList`), so a rect this answers is by
 * construction the rect a click would land in -- there is no second copy to disagree. It is the
 * PREVIOUS frame's layout, which is also what the real client answers: a frame moved by a script this
 * frame reports its old rect until the next layout pass, and FrameXML is written against that.
 *
 * **A widget that is HIDDEN, or that has no drawable content, is not in the draw list and answers
 * null.** That is a real limit and not a bug to paper over: `drawList`'s `walk` only pushes shown
 * widgets. `containerframe.lua:759` asks about a button that is on screen, so it is answered.
 *
 * ## Cost
 *
 * One reference assignment and one null store per frame. The `Map` is built LAZILY, on the first
 * lookup after a publish, because these methods are called a handful of times per session and building
 * a several-thousand-entry map every frame to serve them would be its own performance defect.
 */
import type { Rect } from './layout';
import type { DrawItem } from './widget';
import { layoutRevision } from './widget';

let items: DrawItem[] | null = null;
let byId: Map<string, Rect> | null = null;
let screenHeight = 0;
/** Resolves the WHOLE tree's rects on demand. See `rectOf`'s fallback. */
let resolveAll: (() => Map<string, Rect>) | null = null;
/** The on-demand map. */
let allRects: Map<string, Rect> | null = null;
/**
 * The `layoutRevision()` `allRects` was computed at.
 *
 * **Caching only until the next `publishRects` was a stale-map hazard**, and it stopped being
 * hypothetical when the unit-popup submenus landed: two Show-then-measure sequences on DIFFERENT frames
 * inside one frame would have had the second answered from a map resolved before the first frame moved.
 * `widget.ts#geometryRevision` bumps on anchors, shown, size and tree shape -- everything that can move
 * a rect -- so the cache is now valid exactly as long as the geometry it was built from.
 */
let allRectsRevision = -1;

/**
 * Publish the frame's draw list. Called once per frame from the UI host.
 *
 * `screenHeightUnits` rides along because the FrameXML coordinate system has its ORIGIN AT THE
 * BOTTOM-LEFT with +y up, while a draw rect's `top` is measured DOWN from the top -- so converting one
 * to the other needs the viewport's height in the same logical units, and reading it from anywhere
 * else risks the two disagreeing on the frame the window was resized.
 */
export function publishRects(
  list: DrawItem[],
  screenHeightUnits: number,
  resolveEverything?: () => Map<string, Rect>,
): void {
  items = list;
  byId = null;
  allRects = null;
  allRectsRevision = -1;
  resolveAll = resolveEverything ?? null;
  screenHeight = screenHeightUnits;
}

/** The last resolved rect for a widget id, or null when it was not drawn. */
export function rectOf(id: string): Rect | null {
  if (items === null) {
    return null;
  }
  if (byId === null) {
    byId = new Map();
    // FIRST occurrence wins: a StatusBar contributes its frame and its bar-fill region under related
    // ids, and the outer frame is pushed first. Nothing today collides on an identical id, and if
    // something did, the first is the container -- which is what a script asking for an edge means.
    for (const item of items) {
      if (!byId.has(item.widget.id)) {
        byId.set(item.widget.id, item.rect);
      }
    }
  }
  const drawn = byId.get(id);
  if (drawn !== undefined) {
    return drawn;
  }
  /**
   * NOT IN THE LAST DRAW LIST -- resolve the whole tree once and answer from that.
   *
   * **This is what makes the stat dropdowns open.** `ToggleDropDownMenu` calls `listFrame:Show()` and
   * then `listFrame:GetCenter()` on the next line, hiding the menu again when that is nil
   * (`uidropdownmenu.lua:742-751`). A frame shown during an `OnClick` is not in the PREVIOUS frame's
   * draw list, so the guard fired every time and the menu never appeared. MEASURED live: `numButtons`
   * 5 and `UIDROPDOWNMENU_OPEN_MENU` set, `IsShown()` false through 2.6 s of sampling.
   *
   * The module header used to call the draw-list-only limit "a real limit and not a bug to paper over".
   * That was right about hidden frames with no geometry and wrong about this case: the client's own Lua
   * measures a frame in the same tick it shows it, and the engine answers. This is not a second copy of
   * the truth either -- it runs the SAME `resolveAnchors` over the same tree, so a rect it returns is
   * the one the next draw pass will use.
   *
   * COST: one extra layout pass, and only on a miss. `ui.layout` p50 is 0.4 ms at 257 draw items and
   * this walk covers the hidden frames too, so call it a low single-digit millisecond. It is cached
   * until the next `publishRects`, so a script asking about several undrawn frames in one frame pays
   * once, and code that only ever asks about drawn frames never pays at all. Nothing here runs per
   * frame and the draw-list fingerprint is untouched.
   */
  if (resolveAll !== null) {
    const revision = layoutRevision();
    if (allRects === null || allRectsRevision !== revision) {
      allRects = resolveAll();
      allRectsRevision = revision;
    }
    return allRects.get(id) ?? null;
  }
  return null;
}

/** The viewport height in logical units, for the Y flip. 0 before the first publish. */
export function screenHeightUnits(): number {
  return screenHeight;
}

/** Drop everything -- the UI host is going away. */
export function clearRects(): void {
  items = null;
  byId = null;
  allRects = null;
  allRectsRevision = -1;
  resolveAll = null;
  screenHeight = 0;
}
