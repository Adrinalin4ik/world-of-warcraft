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
 * does with them (disable an arrow at the end of the range, clamp a value, size a child). The
 * PIXELS are not: nothing in `widget.ts` clips a frame's children, so an offset scroll child would
 * draw outside its viewport rather than being scrolled inside it, and nothing draws a slider track
 * or moves a thumb. So the child is deliberately NOT moved, and `loader.ts#applyPerKind` carries one
 * report line per class saying exactly that -- an honest gap in the report beats a screen with
 * content spilling out of every scroll box.
 *
 * `GetVerticalScrollRange` is DERIVED, not stored: the scroll child's height minus the viewport's,
 * floored at zero. That is the engine's own definition, it is truthful for a runtime with no scroll
 * child (0 -- there is nothing to scroll), and it is the value the `floor(yrange) == 0` branch in
 * `GlueScrollFrame_OnScrollRangeChanged` needs in order to hide a scrollbar that is not needed.
 *
 * NO EVENT DISPATCH from these setters, though the engine has some. Real `SetValue` fires
 * `OnValueChanged` and real `SetVerticalScroll` fires `OnVerticalScroll`, and both of those handlers
 * read their argument as a NAMED PARAMETER in the client's own XML (`GlueScrollBarTemplate`'s
 * `<OnValueChanged>` is `self:GetParent():SetVerticalScroll(value)`). `lua/scripts.ts` compiles a
 * handler body as `function(self, ...)`, so `value` would resolve to a nil global and the dispatch
 * would push nil straight back through this file. That is the same convention gap `runtime.ts`
 * declines to fire `OnUpdate` over; firing here would be the same mistake in a smaller place.
 */
import { MethodContext, MethodTable, onFrameTeardown, registerMethods } from '../object';
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

const SCROLLFRAME: MethodTable = {
  SetScrollChild: (ctx, self, args) => {
    const id = ctx.frameIdOf(args[0]);
    if (id === null) {
      throw new Error('SetScrollChild: the scroll child must be a frame');
    }
    scrollState(self).child = id;
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
    scrollState(self).vertical = Math.max(0, Math.min(range, Number(args[0] ?? 0)));
    return [];
  },
  GetVerticalScroll: (ctx, self) => [scrollState(self).vertical],
  GetVerticalScrollRange: (ctx, self) => [rangeOf(ctx, self, 'height')],
  SetHorizontalScroll: (ctx, self, args) => {
    const range = rangeOf(ctx, self, 'width');
    scrollState(self).horizontal = Math.max(0, Math.min(range, Number(args[0] ?? 0)));
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
  SetValue: (_ctx, self, args) => {
    const state = sliderState(self);
    state.value = Math.max(state.min, Math.min(state.max, Number(args[0] ?? 0)));
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
};

registerMethods('SCROLLFRAME', SCROLLFRAME);
registerMethods('SLIDER', SLIDER);
