/**
 * STATUSBAR -- the value methods, and the child texture that draws the fill.
 *
 * This class existed in the chain (`object.ts#WidgetClass`) with NO methods at all, which the loader
 * reported honestly as a gap: "this object model registers no StatusBar methods at all". That gap is
 * the single biggest blocker for any unit frame, because a health bar and a mana bar ARE StatusBars:
 * `TargetFrameHealthBar` and `TargetFrameManaBar` are `<StatusBar>` elements
 * (`Interface\FrameXML\TargetFrame.xml`, `$parentHealthBar`/`$parentManaBar`), and
 * `UnitFrameHealthBar_Update` is nothing but `SetMinMaxValues(0, UnitHealthMax(unit))` followed by
 * `SetValue(UnitHealth(unit))` (`Interface\FrameXML\UnitFrame.lua`).
 *
 * Ported from benilla `crates/benilla-ui/src/script/statusbar.rs`, which is the authority here. Three
 * of its decisions are carried over deliberately, each because getting it wrong is invisible:
 *
 *  1. **The fill is a real child TEXTURE**, created lazily (`ensure_bar`, statusbar.rs:59-101), not a
 *     field the renderer special-cases. That is what makes `SetStatusBarColor` (a vertex colour) and
 *     the draw-layer rules work on it with no new code.
 *  2. **A reversed `SetMinMaxValues(min > max)` swaps rather than rejects**, and the held value
 *     re-clamps into the new range (statusbar.rs:112-115).
 *  3. **The art is CROPPED, never squeezed** -- that half lives in `widget.ts#barFillTexCoords`,
 *     where the client evidence for it is recorded.
 *
 * `SetRotatesTexture` is NOT here and is not in benilla either; it goes through `notImplemented` so
 * the load report names it rather than a silent no-op swallowing it.
 */
import { MethodContext, MethodTable, registerMethods } from '../object';
import { invokeScriptHandler, reportScriptError } from '../scripts';
import { StatusBarState, Widget } from '../../../widget';
import { isDrawLayer, notImplemented, warnOnce, widgetOf } from './region';

/**
 * The bar state, created on first touch.
 *
 * `0..1` with value 1 is the engine's default for a bar nobody has configured, and it matters that it
 * is not `0..0`: `TargetFrame.xml` declares `<BarTexture>` and its `OnLoad` runs before any
 * `SetMinMaxValues`, so a zero range would make the first frame's bar invisible and then pop.
 */
function stateOf(widget: Widget): StatusBarState {
  if (widget.statusBar === null) {
    widget.statusBar = { min: 0, max: 1, value: 1, vertical: false, bar: null };
  }
  return widget.statusBar;
}

/**
 * The child texture the fill is drawn with, created on demand.
 *
 * Created THROUGH THE REGISTRY, like `runtime.ts`'s caret, so it is torn down by the same `reset()`
 * as everything else and cannot outlive the screen. ARTWORK by default, which is benilla's default
 * too (statusbar.rs:59-101) and is what puts the fill above a frame's BACKGROUND/BORDER art and below
 * its OVERLAY text -- the layering every unit frame in the manifest assumes.
 */
function ensureBar(ctx: MethodContext, self: number): Widget | null {
  const owner = widgetOf(ctx, self);
  const state = stateOf(owner);
  if (state.bar !== null) {
    return state.bar;
  }
  const bar = ctx.registry.widget(ctx.registry.create('Texture', null, self));
  if (bar === null) {
    return null;
  }
  bar.layer = 'ARTWORK';
  state.bar = bar;
  return bar;
}

/**
 * `SetValue`'s clamp: into `[min, max]`, with `max` never below `min`. benilla `store_value`,
 * statusbar.rs:49-55. Answers whether the stored value actually MOVED -- see `fireValueChanged`.
 */
function storeValue(state: StatusBarState, raw: number): boolean {
  const value = Number.isFinite(raw) ? raw : state.min;
  const clamped = Math.max(state.min, Math.min(Math.max(state.max, state.min), value));
  if (clamped === state.value) {
    return false;
  }
  state.value = clamped;
  return true;
}

/**
 * `OnValueChanged(self, value)` -- fired ONLY when the value actually changed.
 *
 * THIS WAS MISSING, and its absence is why the experience bar was invisible with real xp behind it.
 * `TextStatusBar_UpdateTextString` (`TextStatusBar.lua:32-88`) HIDES a status bar whose `valueMax` is 0
 * -- which is correct and which is what happens at load, since `CharacterFrame_OnLoad:58` calls it on
 * `MainMenuExpBar` before any xp has arrived. The only thing that ever un-hides it is that same
 * function running again, and the only thing that runs it again is the bar's own
 * `<OnValueChanged>TextStatusBar_OnValueChanged(self, value)</OnValueChanged>`
 * (`TextStatusBar.xml:23`). With `SetValue` firing nothing, `MainMenuExpBar_Update`'s
 * `SetMinMaxValues(0, 400)` + `SetValue(280)` moved the fill and left the frame hidden for ever. The
 * same silence also left every unit frame's "1234 / 5678" text stale.
 *
 * benilla is the authority and does exactly this: `store_value` returns the new value only on a real
 * change and both `SetValue` and `SetMinMaxValues` route through `fire_value_changed`
 * (`crates/benilla-ui/src/script/statusbar.rs:47-55, 105-129, 238-250`).
 *
 * ONLY-ON-CHANGE is load-bearing twice over. benilla's own reason (slider.rs:13-17) is recursion: the
 * scrollbar template wires `OnValueChanged -> SetVerticalScroll` and `OnVerticalScroll -> SetValue`
 * back again, so a fire-always `SetValue` never terminates. Here it is also the frame budget --
 * `world-ui.ts` re-renders the UI target when a fingerprint of the draw list changes, and a handler
 * that re-ran on every `SetValue(sameValue)` would repaint text for a number that did not move.
 *
 * A raising handler must not abort the caller: the engine hands a script error to the error handler and
 * lets the `SetValue` return, and this is reached from `UnitFrameHealthBar_Update` deep inside another
 * handler. So it goes through `reportScriptError`, like `region.ts`'s `Show`/`Hide` cascade.
 */
function fireValueChanged(ctx: MethodContext, self: number, changed: boolean): void {
  if (!changed) {
    return;
  }
  const value = stateOf(widgetOf(ctx, self)).value;
  const error = invokeScriptHandler(ctx, self, 'OnValueChanged', [value]);
  if (error !== null) {
    reportScriptError(`${ctx.registry.nameOf(self) ?? `frame ${self}`}: OnValueChanged`, error.message);
  }
}

const STATUSBAR: MethodTable = {
  SetMinMaxValues: (ctx, self, args) => {
    const state = stateOf(widgetOf(ctx, self));
    let min = Number(args[0] ?? 0);
    let max = Number(args[1] ?? 0);
    if (!Number.isFinite(min)) {
      min = 0;
    }
    if (!Number.isFinite(max)) {
      max = 0;
    }
    // Reversed ranges SWAP rather than error -- benilla statusbar.rs:112-115. The held value then
    // re-clamps, which is why `storeValue` runs on the value we already had.
    if (min > max) {
      [min, max] = [max, min];
    }
    state.min = min;
    state.max = max;
    // A value the caller did not set explicitly but that the new RANGE moved is still a change, and it
    // fires -- benilla `statusbar.rs:105-118` ("a move fires OnValueChanged").
    fireValueChanged(ctx, self, storeValue(state, state.value));
    return [];
  },
  GetMinMaxValues: (ctx, self) => {
    const state = stateOf(widgetOf(ctx, self));
    return [state.min, state.max];
  },

  SetValue: (ctx, self, args) => {
    fireValueChanged(ctx, self, storeValue(stateOf(widgetOf(ctx, self)), Number(args[0] ?? 0)));
    return [];
  },
  GetValue: (ctx, self) => [stateOf(widgetOf(ctx, self)).value],

  // "HORIZONTAL" (the default) or "VERTICAL". Anything else keeps the current orientation and warns,
  // rather than silently making the bar horizontal -- a typo'd orientation that quietly works is the
  // kind of thing that costs an afternoon.
  SetOrientation: (ctx, self, args) => {
    const value = String(args[0] ?? '').toUpperCase();
    if (value !== 'HORIZONTAL' && value !== 'VERTICAL') {
      warnOnce(`SetOrientation: unknown orientation '${value}'`);
      return [];
    }
    stateOf(widgetOf(ctx, self)).vertical = value === 'VERTICAL';
    return [];
  },
  GetOrientation: (ctx, self) => [
    stateOf(widgetOf(ctx, self)).vertical ? 'VERTICAL' : 'HORIZONTAL',
  ],

  /**
   * `SetStatusBarTexture(path [, layer])` -- and it also accepts `(r, g, b [, a])`, which is not a
   * convenience: benilla takes both forms (statusbar.rs:174-188) because the real API does, and
   * `UnitFrame.lua` uses the colour form for power bars whose art is a flat fill.
   */
  SetStatusBarTexture: (ctx, self, args) => {
    const bar = ensureBar(ctx, self);
    if (bar === null) {
      return [];
    }
    if (typeof args[0] === 'number') {
      bar.sprite = null;
      bar.solid = true;
      bar.vertexColor = toHex(Number(args[0]), Number(args[1] ?? 0), Number(args[2] ?? 0));
      bar.alpha = typeof args[3] === 'number' ? args[3] : 1;
      return [];
    }
    const path = typeof args[0] === 'string' ? args[0] : '';
    if (path !== '') {
      // The sprite KEY is the PATH -- the same identity `methods/frame.ts#SetBackdrop` relies on, and
      // what `runtime.ts#registerTreeArt` makes true by registering each path it finds under itself.
      bar.sprite = path;
      bar.solid = false;
    }
    if (typeof args[1] === 'string') {
      const layer = args[1].toUpperCase();
      if (isDrawLayer(layer)) {
        bar.layer = layer;
      } else {
        warnOnce(`SetStatusBarTexture: unknown layer '${layer}'`);
      }
    }
    return [];
  },
  GetStatusBarTexture: (ctx, self) => {
    const bar = ensureBar(ctx, self);
    if (bar === null) {
      return [];
    }
    const id = ctx.registry.idOfWidget(bar);
    return id === null ? [] : [ctx.wrapper(id)];
  },

  // The bar's TINT, multiplied into whatever art `SetStatusBarTexture` put there. This is how a unit
  // frame paints reaction colour (`UnitFrame.lua`'s red/yellow/green) and power colour (mana blue,
  // rage red, energy yellow) onto one shared grey ramp texture.
  SetStatusBarColor: (ctx, self, args) => {
    const bar = ensureBar(ctx, self);
    if (bar === null) {
      return [];
    }
    bar.vertexColor = toHex(Number(args[0] ?? 1), Number(args[1] ?? 1), Number(args[2] ?? 1));
    if (typeof args[3] === 'number') {
      bar.alpha = args[3];
    }
    return [];
  },
  GetStatusBarColor: (ctx, self) => {
    const bar = ensureBar(ctx, self);
    if (bar === null) {
      return [1, 1, 1, 1];
    }
    const hex = bar.vertexColor;
    const channel = (at: number) => parseInt(hex.substr(at, 2), 16) / 255;
    return [channel(1), channel(3), channel(5), bar.alpha];
  },

  /**
   * Not in this engine and not in benilla either (grepped: zero hits repo-wide).
   *
   * `SetRotatesTexture(true)` makes a VERTICAL bar rotate its art 90 degrees rather than crop it
   * bottom-up, so a horizontal ramp reads correctly when stood on end. `barFillTexCoords` crops on the
   * V axis instead, which is right for an untextured or symmetric fill and wrong for a directional
   * ramp -- so this is declared rather than swallowed.
   */
  SetRotatesTexture: notImplemented(
    'SetRotatesTexture',
    'a vertical bar crops its art bottom-up instead of rotating it (widget.ts#barFillTexCoords)',
  ),
};

/** `0..1` floats to `#rrggbb`. The same conversion `methods/region.ts` does; duplicated rather than
 * exported across files because it is four lines and the alternative is a new shared module. */
function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

registerMethods('STATUSBAR', STATUSBAR);
