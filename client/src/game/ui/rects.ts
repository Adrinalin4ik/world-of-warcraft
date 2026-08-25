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

/**
 * How many on-demand resolves have happened, and how long they took in total.
 *
 * Published so the cost of the fallback is a NUMBER rather than a claim -- `resolveAnchors` over the
 * whole tree is not free, and during the manifest load the tree grows under it so the cache invalidates
 * often. Read via `window.uiRectStats`.
 */
export const rectStats = { resolves: 0, ms: 0 };

/**
 * Install the whole-tree resolver, SEPARATELY from `publishRects`.
 *
 * **This is what makes a rect answerable before the first frame is ever drawn**, and that turned out to
 * matter more than the hidden/shown question it was reported as. `rectOf` used to return null whenever no
 * draw list had been published yet, so EVERY geometry query during the manifest load answered nil --
 * including `FCF_UpdateButtonSide`'s `GetScreenWidth() - chatFrame:GetRight()`
 * (`floatingchatframe.lua:1281`), reached from a chat frame's own load path (`:167`), which is arithmetic
 * on nil and killed six of the seven chat windows.
 *
 * The reported symptom was "a HIDDEN frame answers nil". Hidden was never the cause: `layoutRects` walks
 * the whole tree regardless of `shown`, and `resolveAnchors` emits a rect for every node it is given
 * (including an unanchored one -- `unplaceableNodes` filters the DRAW list, not the rect map). The cause
 * was the `items === null` early return, i.e. "asked before anything was drawn".
 *
 * **THIS CANNOT PUT A FRAME IN THE DRAW LIST**, which is the constraint that matters: `layoutRects`
 * returns a `Map` and never touches `drawList`, so the `items` count -- the offscreen target's whole
 * basis -- is untouched by construction, not merely by intention.
 */
export function setRectResolver(resolveEverything: (() => Map<string, Rect>) | null): void {
  resolveAll = resolveEverything;
  allRects = null;
  allRectsRevision = -1;
}
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
/**
 * Widget ids whose DRAWN state is sampled every frame, and the last sample of each.
 *
 * **A probe that has to be called by hand cannot see a hover.** The world-map tooltip is only in the
 * draw list while the pointer is on a POI, and reaching the console ends that -- the owner's report
 * came back `shown: false, drawn: null` for exactly that reason, which is the instrument failing to
 * answer rather than an answer.
 *
 * So the sampling happens where the per-frame list already arrives, and the probe reads the LAST
 * time each id was actually drawn. Empty by default: this costs one `Map#size` check per frame until
 * something asks.
 */
/** Frames since sampling began, so a stale sample is recognisable as stale. */
let frameCounter = 0;

const watched = new Set<string>();

const lastDrawn = new Map<string, { alpha: number; index: number; at: number }>();

/** Start sampling these ids. Idempotent; ids accumulate, which is what a diagnostic wants. */
export function watchDrawn(ids: string[]): void {
  ids.forEach((id) => watched.add(id));
}

/** The last frame each watched id was drawn on, with its CASCADED alpha and list position. */
export function lastDrawnOf(id: string): { alpha: number; index: number; at: number } | null {
  return lastDrawn.get(id) ?? null;
}

export function publishRects(list: DrawItem[], screenHeightUnits: number): void {
  items = list;
  byId = null;
  // See `watched`: sampling here is the only place a hover-only frame can be caught in the act.
  if (watched.size > 0) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (watched.has(item.widget.id)) {
        lastDrawn.set(item.widget.id, { alpha: item.alpha, index: i, at: frameCounter });
      }
    }
    frameCounter += 1;
  }
  screenHeight = screenHeightUnits;
  /**
   * **THIS MUST NOT TOUCH THE RESOLVER, AND A TEST CAUGHT IT DOING SO.** The resolver used to arrive as
   * a third argument here, so once it moved to `setRectResolver` this function was still assigning
   * `resolveAll = undefined ?? null` on every frame -- nulling at the first render the very thing
   * installed at boot. The chat frames would have been fixed during the manifest load and broken again
   * the moment anything drew, which is a worse failure than the original because it looks fixed.
   *
   * `allRects` is NOT cleared either: it is keyed on `layoutRevision()`, which is the honest invalidator.
   * A new draw list does not move a rect, so throwing the map away per frame would just pay for a
   * re-resolve that returns the same answers.
   */
}

/** The last resolved rect for a widget id, or null when it was not drawn. */
/**
 * The draw item for a widget id -- its CASCADED alpha and its position in the list.
 *
 * **`Widget#alpha` is the widget's OWN, and `DrawItem#alpha` is that multiplied down the ancestor
 * chain** (`widget.ts:1014`). A probe that reads the own value cannot see a dimming parent, and
 * that blind spot cost a round on the world-map tooltip: every line reported `alpha: 1` while the
 * pixels were grey.
 *
 * The INDEX matters for the same class of question: a region drawn before its own backdrop is
 * covered by it, and nothing about the region itself would say so.
 */
export function drawItemOf(id: string): { alpha: number; index: number } | null {
  if (items === null) {
    return null;
  }
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].widget.id === id) {
      return { alpha: items[i].alpha, index: i };
    }
  }
  return null;
}

export function rectOf(id: string): Rect | null {
  // NO EARLY RETURN ON A MISSING DRAW LIST. That return is what made every geometry query during the
  // manifest load answer nil; see `setRectResolver`. With no draw list there is simply nothing drawn to
  // prefer, so the on-demand resolve below is the only answer -- and it is a real one.
  if (items !== null && byId === null) {
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
  const drawn = byId === null ? undefined : byId.get(id);
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
      const started = performance.now();
      allRects = resolveAll();
      allRectsRevision = revision;
      rectStats.resolves += 1;
      rectStats.ms += performance.now() - started;
    }
    return allRects.get(id) ?? null;
  }
  return null;
}

/**
 * The UNCLIPPED layout rect for a widget id -- always from the resolver, never from the draw list.
 *
 * **`rectOf` IS WRONG FOR MEASURING CONTENT, and that is an interaction between two features of mine.**
 * It prefers the published draw list, whose rects have been CLIPPED to their scroll frame
 * (`widget.ts#clipItem`). So measuring a scroll child's content through it reports the viewport's own
 * height and the scroll range collapses to 0 -- exactly when clipping is doing its job. Caught by a test
 * that asserted the range before the first publish (266, correct) and again after it (0).
 *
 * `rectOf` keeps its draw-list preference, which is right for its callers: `GetRight` and friends must
 * answer what is on SCREEN. Anything asking "how big is this really" wants this instead.
 */
export function layoutRectOf(id: string): Rect | null {
  if (resolveAll === null) {
    return null;
  }
  const revision = layoutRevision();
  /**
   * THE VISIBLE MAP FIRST, THE WHOLE TREE ONLY IF THAT MISSES.
   *
   * This used to resolve the entire 4211-widget tree on every revision change, and the revision moves
   * 1.22 times a frame (one `SetPoint` from an `OnUpdate` is enough), so it ran every frame. Measured in
   * the owner's HUD as `ui.scroll` **63.4 ms**, against `ui.layout` **0.5 ms** for the same walk and the
   * same solver over the widgets that were going to be drawn. The node count was the whole difference.
   *
   * So the per-frame path pays the visible price. A query about a HIDDEN frame still gets a real answer:
   * it misses the pruned map and resolves the full tree, once per revision, which is what every query
   * paid before. Nothing loses an answer; only the common case stops paying for the rare one.
   */
  if (allVisibleRects === null || allVisibleRevision !== revision) {
    const started = performance.now();
    allVisibleRects = resolveVisible === null ? new Map() : resolveVisible();
    allVisibleRevision = revision;
    rectStats.resolves += 1;
    rectStats.ms += performance.now() - started;
  }
  const visible = allVisibleRects.get(id);
  if (visible !== undefined) {
    return visible;
  }
  if (allRects === null || allRectsRevision !== revision) {
    const started = performance.now();
    allRects = resolveAll();
    allRectsRevision = revision;
    rectStats.resolves += 1;
    rectStats.ms += performance.now() - started;
  }
  return allRects.get(id) ?? null;
}

/** The pruned map and its revision -- see `layoutRectOf`. */
let allVisibleRects: Map<string, Rect> | null = null;

let allVisibleRevision = -1;

/** Resolves the SHOWN subtree only. Installed beside `resolveAll`. */
let resolveVisible: (() => Map<string, Rect>) | null = null;

/** See `setRectResolver`. Split so the pruned and full resolvers are installed together. */
export function setVisibleRectResolver(resolve: (() => Map<string, Rect>) | null): void {
  resolveVisible = resolve;
  allVisibleRects = null;
  allVisibleRevision = -1;
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
