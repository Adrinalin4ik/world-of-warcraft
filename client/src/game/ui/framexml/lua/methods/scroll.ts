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
function rangeOf(ctx: MethodContext, self: number, axis: 'height' | 'width'): number {
  const child = scrollState(self).child;
  if (child === null) {
    return 0;
  }
  const childWidget = ctx.registry.widget(child);
  if (childWidget === null) {
    return 0;
  }
  return Math.max(0, childWidget[axis] - widgetOf(ctx, self)[axis]);
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

const SCROLLFRAME: MethodTable = {
  SetScrollChild: (ctx, self, args) => {
    const id = ctx.frameIdOf(args[0]);
    if (id === null) {
      throw new Error('SetScrollChild: the scroll child must be a frame');
    }
    scrollState(self).child = id;
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
    const error = invokeScriptHandler(ctx, self, 'OnValueChanged', [state.value]);
    if (error !== null) {
      reportScriptError(
        `${ctx.registry.nameOf(self) ?? `frame ${self}`}: OnValueChanged`, error.message,
      );
    }
    return [];
  },
  GetValue: (_ctx, self) => [sliderState(self).value],
  SetMinMaxValues: (_ctx, self, args) => {
    const state = sliderState(self);
    state.min = Number(args[0] ?? 0);
    state.max = Number(args[1] ?? 0);
    // Re-clamped: a range that shrinks under a value has to move the value, or `GetValue` reports a
    // position outside the range it just declared -- which is exactly what
    // `GlueScrollFrame_OnScrollRangeChanged` is written to avoid doing by hand.
    state.value = Math.max(state.min, Math.min(state.max, state.value));
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
  SetOrientation: (_ctx, self, args) => {
    sliderState(self).orientation =
      String(args[0] ?? '').toUpperCase() === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
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

/** The slider's thumb region, created on first use. Keyed by frame id, like the button state slots. */
const thumbTextures = new Map<number, number>();

function ensureThumbTextureId(ctx: MethodContext, self: number): number {
  let id = thumbTextures.get(self);
  if (id === undefined) {
    id = ctx.registry.create('Texture', null, self);
    thumbTextures.set(self, id);
  }
  return id;
}

registerMethods('SCROLLFRAME', SCROLLFRAME);
registerMethods('SLIDER', SLIDER);
