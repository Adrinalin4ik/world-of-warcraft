/**
 * SCROLLFRAME and SLIDER: the value bookkeeping the client's own scroll code reads back.
 *
 * WHY THIS FILE EXISTS, precisely. `GlueScrollFrameTemplate`'s `<OnLoad>` (gluetemplates.xml) calls
 * `GlueScrollFrame_OnScrollRangeChanged(self)`, and that function's first act is
 * `yrange = self:GetVerticalScrollRange()` (gluetemplates.lua:68). With no method there the call
 * returned nil and the handler raised -- eleven of the fifteen load errors on the glue manifest, one
 * per templated scroll frame. The next two lines are `scrollbar:GetValue()` and
 * `scrollbar:SetMinMaxValues(...)`, so SCROLLFRAME alone would have moved the same error two lines
 * down: SLIDER had no methods either. The two classes have to land together or neither is fixed.
 *
 * WHAT IS AND IS NOT REAL HERE. The VALUES are real: a scroll offset, a range, a slider's
 * value/min/max/step are all stored per frame and read back exactly, which is all the client's Lua
 * does with them (disable an arrow at the end of the range, clamp a value, size a child).
 *
 * **THE CLIPPING HALF OF THIS PARAGRAPH IS NO LONGER TRUE, and it predicted its own defect.** It used
 * to read "nothing in `widget.ts` clips a frame's children, so an offset scroll child would draw
 * outside its viewport rather than being scrolled inside it ... an honest gap in the report beats a
 * screen with content spilling out of every scroll box." The trainer round then measured exactly that
 * spill -- a rank string beginning at x=295 inside a 296-wide viewport, drawn in full where the real
 * client clips it. `widget.ts#clipItem` clips now, keyed off `Widget#clippedBy` which `SetScrollChild`
 * below sets, and the draw list gets SHORTER for it (63 items to 18 on a 60-row list in a 220-unit
 * viewport).
 *
 * What is still absent is the SLIDER's pixels: nothing moves a thumb along its track, so a scrollbar's
 * thumb sits where its XML anchors put it. `loader.ts#applyPerKind` carries that one report line, and
 * only that one -- the clipping line is gone from it in spirit and the wording there says so.
 *
 * `GetVerticalScrollRange` is DERIVED, not stored: the scroll child's height minus the viewport's,
 * floored at zero. That is the engine's own definition, it is truthful for a runtime with no scroll
 * child (0 -- there is nothing to scroll), and it is the value the `floor(yrange) == 0` branch in
 * `GlueScrollFrame_OnScrollRangeChanged` needs in order to hide a scrollbar that is not needed.
 *
 * **THIS HEADER USED TO SAY THESE SETTERS FIRE NOTHING, and that rationale is now STALE** -- the same
 * class of defect as `api/secure.ts`'s header, which claimed a live subsystem was missing. It argued
 * that a handler reading `value` as a NAMED PARAMETER would see a nil global because `lua/scripts.ts`
 * compiles bodies as `function(self, ...)`. That is no longer true: `scripts.ts:135` binds
 * `['value']` for `OnValueChanged` and `:141` binds `['offset']` for `OnVerticalScroll`, and
 * `methods/statusbar.ts:148-151` has been dispatching `OnValueChanged` this way all along -- which is
 * how every unit frame's health bar updates.
 *
 * So `SetValue` DOES fire `OnValueChanged` now, and not firing it was the whole of "скролла у нас нет"
 * being more than cosmetic: `FauxScrollFrameTemplate`'s scrollbar carries
 * `<OnValueChanged>FauxScrollFrame_OnVerticalScroll(...)</OnValueChanged>`, and its arrow buttons do
 * nothing but `scrollBar:SetValue(scrollBar:GetValue() -/+ scrollBar:GetValueStep())`. Without the
 * dispatch, an arrow click moved a number and **nothing re-rendered the list** -- so no scroll frame in
 * the client could be scrolled at all, not just the Skills tab.
 *
 * **`SetVerticalScroll` FIRES `OnVerticalScroll` NOW, and declining to was wrong for the case that
 * matters.** The previous note here reasoned that dispatching would "announce a scroll that did not
 * happen" because this file does not move the scroll child. That is true of a real scroll frame and
 * FALSE of a FAUX one -- and every scrolling list in this client is faux. The whole point of
 * `FauxScrollFrameTemplate` is that no child moves: the handler recomputes a ROW OFFSET and re-renders.
 *
 * The chain, end to end, from the client's own files:
 *
 *   1. arrow `<OnClick>`  -> `scrollBar:SetValue(GetValue() -/+ GetValueStep())`
 *   2. slider `<OnValueChanged>` -> `self:GetParent():SetVerticalScroll(value)`   uipaneltemplates.xml:203-205
 *   3. scroll frame `<OnVerticalScroll>` -> `FauxScrollFrame_OnVerticalScroll(self, offset, ...)`
 *                                                                              skillframe.xml:508-510
 *   4. that sets `self.offset = floor(value / itemHeight + 0.5)` and calls the update function
 *                                                                        uipaneltemplates.lua:236-243
 *   5. `SkillFrame_UpdateSkills` re-reads `FauxScrollFrame_GetOffset` and repaints the rows
 *
 * Step 3 was the break. Steps 1 and 2 already worked once `SetValue` dispatched, so the value moved and
 * **no row ever repainted** -- which is exactly "скрол не работает", reported twice, on Skills AND
 * Reputation, because both are faux frames going through this same step.
 *
 * NO INFINITE LOOP, and it is worth stating because the chain is genuinely circular: step 4 ends in
 * `scrollbar:SetValue(value)`, which re-enters step 1. Both setters here dispatch ONLY on a real change,
 * so the second pass finds the value already stored and stops. That guard is load-bearing, not tidiness.
 */
import { MethodContext, MethodTable, onFrameTeardown, registerMethods } from '../object';
import { invokeScriptHandler, reportScriptError } from '../scripts';
import { widgetOf } from './region';
import { layoutRectOf } from '../../../rects';
import { layoutRevision } from '../../../widget';
import type { Widget } from '../../../widget';

interface ScrollState {
  vertical: number;
  horizontal: number;
  /** The frame id of the `SetScrollChild` argument, or null if none was ever set. */
  child: number | null;
}

interface SliderState {
  value: number;
  min: number;
  max: number;
  step: number;
  orientation: 'HORIZONTAL' | 'VERTICAL';
}

const scrollStates = new Map<number, ScrollState>();
const sliderStates = new Map<number, SliderState>();

/** Both tables are keyed by frame id, so both go the same way as the frame -- `object.ts`'s
 * `FRAME_TEARDOWN`, the same subscription `kinds.ts` makes for its state-texture tables. */
onFrameTeardown((_ctx, id) => {
  scrollStates.delete(id);
  sliderStates.delete(id);
  scrollRanges.delete(id);
  // A rebuilt screen must re-announce: the revision is a global counter, so without this a new runtime
  // whose tree happens to settle at the same revision would never fire its first range.
  reconciledAt = -1;
});

function scrollState(self: number): ScrollState {
  let state = scrollStates.get(self);
  if (state === undefined) {
    state = { vertical: 0, horizontal: 0, child: null };
    scrollStates.set(self, state);
  }
  return state;
}

function sliderState(self: number): SliderState {
  let state = sliderStates.get(self);
  if (state === undefined) {
    // The engine's own defaults for a slider nothing has configured: a 0..0 range makes
    // `GetMinMaxValues` truthful about "there is nothing to slide over" rather than inventing a span.
    state = { value: 0, min: 0, max: 0, step: 0, orientation: 'VERTICAL' };
    sliderStates.set(self, state);
  }
  return state;
}

/**
 * The scrollable overhang on one axis: the child's extent minus the viewport's, floored at zero.
 *
 * Zero with no scroll child, which is both the honest answer and the one that makes the client's
 * `floor(yrange) == 0` branch hide a scrollbar for content that does not overflow.
 */
/**
 * How far the scroll child's CONTENT extends past its own declared box, in logical units.
 *
 * **THIS IS WHY NOTHING SCROLLED, and it is upstream of every input path.**
 * `QuestDetailScrollChildFrame` is authored 300x334 inside a 300x334 viewport
 * (`questframe.xml:344-348`) and **nothing ever resizes it** -- `QuestInfo_Display` positions its
 * elements with `SetPoint` chains and never touches the child's height (`questinfo.lua:68-80`). So a
 * range measured from the child's own `height` is structurally **0**, whatever the text does.
 *
 * With a 0 range the slider's max is 0, `SetValue` clamps every value to 0, the transition guard then
 * returns early, and the arrows, the drag and the thumb's travel are all correctly dead. One cause, three
 * symptoms -- which is what the coordinator suspected from three inputs failing at once.
 *
 * The real engine measures the scroll child's actual EXTENT, descendants included, which is how 334 of
 * box holds 600 of text and yields a 266 range. Measured here from the resolved rects, which is the same
 * layout the draw pass uses -- and `rects.ts` answers before the first frame is drawn now, so a panel
 * opening mid-load is measurable too.
 */
function contentExtent(ctx: MethodContext, child: Widget, axis: 'height' | 'width'): number {
  const base = layoutRectOf(child.id);
  if (base === null) {
    return child[axis];
  }
  const start = axis === 'height' ? base.top : base.left;
  let far = axis === 'height' ? base.top + base.height : base.left + base.width;
  const walk = (node: Widget): void => {
    for (const kid of node.children) {
      const rect = layoutRectOf(kid.id);
      if (rect !== null) {
        const edge = axis === 'height' ? rect.top + rect.height : rect.left + rect.width;
        if (edge > far) {
          far = edge;
        }
      }
      walk(kid);
    }
  };
  walk(child);
  return Math.max(child[axis], far - start);
}

function rangeOf(ctx: MethodContext, self: number, axis: 'height' | 'width'): number {
  const child = scrollState(self).child;
  if (child === null) {
    return 0;
  }
  const childWidget = ctx.registry.widget(child);
  if (childWidget === null) {
    return 0;
  }
  return Math.max(0, contentExtent(ctx, childWidget, axis) - widgetOf(ctx, self)[axis]);
}

/**
 * Dispatch `OnVerticalScroll`/`OnHorizontalScroll`, reporting a failure instead of raising.
 *
 * `scripts.ts:141-142` binds `['offset']` for both, so the client's own
 * `FauxScrollFrame_OnVerticalScroll(self, offset, ...)` reads its argument by name. Same treatment
 * `statusbar.ts#fireValueChanged` gives `OnValueChanged`: a broken handler must not take out the caller,
 * which here is an arrow-button click.
 */
function fireScroll(ctx: MethodContext, self: number, script: string, offset: number): void {
  const error = invokeScriptHandler(ctx, self, script, [offset]);
  if (error !== null) {
    reportScriptError(`${ctx.registry.nameOf(self) ?? `frame ${self}`}: ${script}`, error.message);
  }
}

/**
 * Every frame that has been given a scroll child, and the range each was last told about.
 *
 * Keyed by frame ID and cleared by `onFrameTeardown` below -- NOT a bare module `Map` left to leak, which
 * is the mistake `thumbTextures` made when ids restarted from 1 between registries.
 */
const scrollRanges = new Map<number, { x: number; y: number }>();

/** The `layoutRevision()` the ranges were last reconciled at. See `reconcileScrollRanges`. */
let reconciledAt = -1;

/**
 * Fire `OnScrollRangeChanged` on any scroll frame whose range has moved.
 *
 * **THE ENGINE FIRES THIS FROM ITS LAYOUT PASS and nothing in this client fired it at all**, so
 * `ScrollFrame_OnScrollRangeChanged` -- the only thing that calls `scrollbar:SetMinMaxValues(0, yrange)`
 * (`uipaneltemplates.lua:275-285`) -- never ran. A scrollbar with a 0..0 range clamps every `SetValue` to
 * 0, so the arrows, the drag and the thumb's travel were all dead at once.
 *
 * Called once per frame by the UI host, which is our layout pass. **Gated on `layoutRevision()`, so in
 * steady state it is a single integer comparison for the whole client** -- the walk over a scroll child's
 * subtree happens only on a frame where something actually moved or resized. Firing Lua per frame
 * unconditionally is exactly what the offscreen target cannot afford; this fires only on a real change.
 */
export function reconcileScrollRanges(ctx: MethodContext): void {
  const revision = layoutRevision();
  if (revision === reconciledAt) {
    return;
  }
  reconciledAt = revision;
  for (const [frameId, last] of scrollRanges) {
    const widget = ctx.registry.widget(frameId);
    if (widget === undefined) {
      continue;
    }
    const y = rangeOf(ctx, frameId, 'height');
    const x = rangeOf(ctx, frameId, 'width');
    if (x === last.x && y === last.y) {
      continue;
    }
    last.x = x;
    last.y = y;
    const error = invokeScriptHandler(ctx, frameId, 'OnScrollRangeChanged', [x, y]);
    if (error !== null) {
      reportScriptError(
        `${ctx.registry.nameOf(frameId) ?? `frame ${frameId}`}: OnScrollRangeChanged`, error.message,
      );
    }
  }
}

const SCROLLFRAME: MethodTable = {
  SetScrollChild: (ctx, self, args) => {
    const id = ctx.frameIdOf(args[0]);
    if (id === null) {
      throw new Error('SetScrollChild: the scroll child must be a frame');
    }
    scrollState(self).child = id;
    // Registered for the range pass. Seeded with -1 so the FIRST reconcile always announces, which is
    // what gives the scrollbar its initial min/max.
    scrollRanges.set(self, { x: -1, y: -1 });
    /**
     * THE CLIP LINK, and it is what makes a real `<ScrollFrame>` behave like one.
     *
     * This file's header used to predict the consequence of not having it: "nothing in `widget.ts` clips
     * a frame's children, so an offset scroll child would draw outside its viewport rather than being
     * scrolled inside it". The trainer round then measured it -- a rank string beginning at x=295 inside
     * a 296-wide viewport, which the real client hides by clipping and we drew in full.
     *
     * Set on the CHILD, not on the frame: the scrollbar is also a child of the ScrollFrame
     * (`uipaneltemplates.xml:287`) and lives outside the viewport, so clipping every child would delete
     * it. Only the one frame `SetScrollChild` names is clipped, which is exactly the engine's rule.
     */
    const frame = widgetOf(ctx, self);
    const child = ctx.registry.widget(id);
    if (child !== undefined) {
      child.clippedBy = frame;
    }
    return [];
  },
  GetScrollChild: (ctx, self) => {
    const id = scrollState(self).child;
    return [id === null ? null : ctx.wrapper(id)];
  },

  // Clamped to the live range, as the engine clamps: the client's scroll-up handler happily calls
  // `SetVerticalScroll(GetVerticalScroll() - height/2)` straight past zero and expects the engine to
  // stop it there, then reads the value back to decide whether to disable the arrow.
  SetVerticalScroll: (ctx, self, args) => {
    const range = rangeOf(ctx, self, 'height');
    const state = scrollState(self);
    const wanted = Math.max(0, Math.min(range, Number(args[0] ?? 0)));
    if (wanted === state.vertical) {
      // The transition only -- see the header on why this guard stops the circular chain.
      return [];
    }
    state.vertical = wanted;
    // THE CHILD ACTUALLY MOVES NOW. `drawList` offsets the clipped subtree by this, which is the half of
    // a real `<ScrollFrame>` this file's header called "a real remaining gap". Inert for a faux frame:
    // its scroll child has no drawable descendants (see `Widget#scrollOffset`).
    widgetOf(ctx, self).scrollOffset.y = wanted;
    fireScroll(ctx, self, 'OnVerticalScroll', wanted);
    return [];
  },
  GetVerticalScroll: (ctx, self) => [scrollState(self).vertical],
  GetVerticalScrollRange: (ctx, self) => [rangeOf(ctx, self, 'height')],
  SetHorizontalScroll: (ctx, self, args) => {
    const range = rangeOf(ctx, self, 'width');
    const state = scrollState(self);
    const wanted = Math.max(0, Math.min(range, Number(args[0] ?? 0)));
    if (wanted === state.horizontal) {
      return [];
    }
    state.horizontal = wanted;
    widgetOf(ctx, self).scrollOffset.x = wanted;
    fireScroll(ctx, self, 'OnHorizontalScroll', wanted);
    return [];
  },
  GetHorizontalScroll: (ctx, self) => [scrollState(self).horizontal],
  GetHorizontalScrollRange: (ctx, self) => [rangeOf(ctx, self, 'width')],

  /**
   * A genuine no-op rather than a stub, and the distinction matters for the report.
   *
   * In the engine this recomputes the scroll child's rect after its size changed, because the engine
   * caches it. `layout.ts` resolves every rect from anchors on every frame, so there is no cached
   * rect here to invalidate -- the next `GetVerticalScrollRange` already reads the child's current
   * height. Declaring it through `notImplemented` would put a false gap in the load report; there is
   * nothing left undone.
   */
  UpdateScrollChildRect: () => [],
};

const SLIDER: MethodTable = {
  // Clamped, like the scroll offsets above and for the same reason: `GlueScrollFrame_Update` and both
  // arrow-button handlers push the value past an end and read it back.
  SetValue: (ctx, self, args) => {
    const state = sliderState(self);
    const wanted = Math.max(state.min, Math.min(state.max, Number(args[0] ?? 0)));
    if (wanted === state.value) {
      // ON THE TRANSITION ONLY, like `statusbar.ts`: the arrow handlers push a value past an end and
      // read it back, so an unchanged write is the ordinary case and must not re-run the handler.
      return [];
    }
    state.value = wanted;
    syncThumb(ctx, self);
    const error = invokeScriptHandler(ctx, self, 'OnValueChanged', [state.value]);
    if (error !== null) {
      reportScriptError(
        `${ctx.registry.nameOf(self) ?? `frame ${self}`}: OnValueChanged`, error.message,
      );
    }
    return [];
  },
  GetValue: (_ctx, self) => [sliderState(self).value],
  SetMinMaxValues: (ctx, self, args) => {
    const state = sliderState(self);
    state.min = Number(args[0] ?? 0);
    state.max = Number(args[1] ?? 0);
    // Re-clamped: a range that shrinks under a value has to move the value, or `GetValue` reports a
    // position outside the range it just declared -- which is exactly what
    // `GlueScrollFrame_OnScrollRangeChanged` is written to avoid doing by hand.
    state.value = Math.max(state.min, Math.min(state.max, state.value));
    // The RANGE moves the thumb as surely as the value does: `FauxScrollFrame_Update` sets the range
    // every refresh, and a thumb sized against a stale range would sit at the wrong place.
    syncThumb(ctx, self);
    return [];
  },
  GetMinMaxValues: (_ctx, self) => {
    const state = sliderState(self);
    return [state.min, state.max];
  },
  SetValueStep: (_ctx, self, args) => {
    sliderState(self).step = Number(args[0] ?? 0);
    return [];
  },
  GetValueStep: (_ctx, self) => [sliderState(self).step],
  SetOrientation: (ctx, self, args) => {
    sliderState(self).orientation =
      String(args[0] ?? '').toUpperCase() === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
    syncThumb(ctx, self);
    return [];
  },
  GetOrientation: (_ctx, self) => [sliderState(self).orientation],
  /**
   * `SetThumbTexture` / `GetThumbTexture` -- the draggable part of a scrollbar, and NOTHING created it.
   *
   * `<ThumbTexture>` is a first-class XML element on a `<Slider>` and `loader.ts` had no handling for
   * it at all (its state-texture list covers Normal/Pushed/Disabled/Highlight/Checked and stops). Six
   * exist in the loaded manifest, and **two of them are in `uipaneltemplates.xml`** -- the scrollbar
   * template every scroll frame in the client inherits -- so no scrollbar anywhere had a visible thumb.
   *
   * The region is created as a child Texture and left for the loader to size and anchor from the
   * element, exactly as `applyButton` does for its slots. **It is NOT positioned by the slider's
   * value**: this widget layer models no thumb travel, so the thumb sits where the XML anchors it. That
   * is a real and stated limit -- the arrows and the mouse wheel scroll correctly through
   * `OnValueChanged` (see the header), and it is the thumb's POSITION that lags, not the list.
   */
  SetThumbTexture: (ctx, self, args) => {
    const id = ensureThumbTextureId(ctx, self);
    const region = ctx.registry.widget(id);
    if (region === undefined) {
      return [];
    }
    const arg = args[0];
    if (typeof arg === 'string') {
      region.sprite = arg;
      region.solid = false;
    }
    return [];
  },
  GetThumbTexture: (ctx, self) => [ctx.wrapper(ensureThumbTextureId(ctx, self))],
};

/**
 * The slider's thumb region, created on first use.
 *
 * **A `WeakMap` ON THE WIDGET, not a `Map` on the frame id, and the first version got this wrong.**
 * Frame ids are minted per REGISTRY and restart from 1, so a module-level id map leaks one runtime's
 * thumbs into the next one's by number collision -- and a torn-down and rebuilt screen is the ordinary
 * case here (glue -> world). The stale id then resolves to nothing in the new registry, so the thumb is
 * never created and the scrollbar has no knob.
 *
 * `methods/gametooltip.ts#stateByWidget` records this hazard verbatim for the same reason. Mine
 * reproduced it: two sliders in one jest file, the second one silently thumbless because the first had
 * already claimed frame id 1.
 */
const thumbTextures = new WeakMap<Widget, number>();

function ensureThumbTextureId(ctx: MethodContext, self: number): number {
  const slider = widgetOf(ctx, self);
  let id = thumbTextures.get(slider);
  if (id === undefined) {
    id = ctx.registry.create('Texture', null, self);
    thumbTextures.set(slider, id);
    // The back-link `drawList` needs to place it. A thumb's position is the engine's to choose --
    // `<ThumbTexture>` carries no `<Anchors>` at all -- so it must not be left to the loader's
    // anchorless fill, which gave it the whole track's rect.
    const thumb = ctx.registry.widget(id);
    if (thumb !== undefined) {
      thumb.thumbOf = slider;
    }
    /**
     * THE DRAG'S WAY BACK INTO LUA. `ui/input.ts` owns the gesture -- no `<Slider>` in the client binds
     * a press-and-move handler, so it is the engine's, like a model pane's spin -- and this is the only
     * thing it calls. Routed through `SLIDER.SetValue` rather than writing `state.value`, so the drag
     * gets the same clamp, the same `syncThumb` and the same `OnValueChanged` dispatch as an arrow
     * click; writing the state directly would move the knob and tell the scroll frame nothing.
     *
     * `step` is honoured because `SetValue` is: the client sets one on faux lists
     * (`FauxScrollFrame_Update`'s `valueStep`), and a drag that ignored it would land between rows.
     */
    slider.onSliderDrag = (fraction) => {
      const state = sliderState(self);
      const wanted = state.min + fraction * (state.max - state.min);
      const snapped = state.step > 0 ? Math.round(wanted / state.step) * state.step : wanted;
      SLIDER.SetValue?.(ctx, self, [snapped]);
    };
  }
  return id;
}

/** Recompute where the thumb sits, from the live value and range. See `Widget#sliderTravel`. */
function syncThumb(ctx: MethodContext, self: number): void {
  const state = sliderState(self);
  const span = state.max - state.min;
  const widget = widgetOf(ctx, self);
  widget.sliderTravel.fraction = span > 0
    ? Math.max(0, Math.min(1, (state.value - state.min) / span))
    : 0;
  widget.sliderTravel.vertical = state.orientation === 'VERTICAL';
}

registerMethods('SCROLLFRAME', SCROLLFRAME);
registerMethods('SLIDER', SLIDER);
