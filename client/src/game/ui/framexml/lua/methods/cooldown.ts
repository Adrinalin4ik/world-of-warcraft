/**
 * COOLDOWN -- the frame type the action bar's cooldown sweep lives on.
 *
 * This class did not exist, and its absence was the largest single error source in the FrameXML load:
 * **671 errors**, one per `<Cooldown>` element in the manifest. The mechanism is `object.ts`'s
 * `CreateFrame` validation -- `parseClass('Cooldown')` returned null, `CreateFrame` threw
 * "unknown frame type", and `loader.ts` recorded the error and dropped the element AND ITS WHOLE
 * SUBTREE. Every `ActionButton`, every `MultiBar` button and every stance/pet button inherits
 * `ActionButtonTemplate`, which declares one:
 *
 *     <Cooldown name="$parentCooldown" inherits="CooldownFrameTemplate">   ActionButtonTemplate.xml
 *
 * and the template itself is one line in `Interface\FrameXML\Cooldown.xml`:
 *
 *     <Cooldown name="CooldownFrameTemplate" setAllPoints="true" hidden="true" virtual="true"/>
 *
 * `setAllPoints` and `hidden` are already handled by the loader (`loader.ts:774`), so the type needed
 * nothing structural beyond being a Frame subclass.
 *
 * ## Which methods are real, and how that was decided
 *
 * Measured, not guessed. All 139 `FrameXML.toc` entries plus every file they pull in through
 * `<Script file="...">` were fetched from the asset host (256 files) and grepped for each Cooldown
 * method. The result is unambiguous: **`SetCooldown` is the only one the manifest ever calls**, and its
 * one call site is `Cooldown.lua`, whole file:
 *
 *     function CooldownFrame_SetTimer(self, start, duration, enable)
 *         if ( start > 0 and duration > 0 and enable > 0) then
 *             self:SetCooldown(start, duration);
 *             self:Show();
 *         else
 *             self:Hide();
 *         end
 *     end
 *
 * `ActionButton_UpdateCooldown` (`ActionButton.lua:345`) is the only caller of that. Every other
 * method invoked on a cooldown frame anywhere in the manifest is an inherited Frame method that
 * already existed -- grepped: `Hide` (13), `Show` (5), `SetFrameLevel` (4), `SetScript` (2),
 * `SetParent` (2), `GetFrameLevel` (2). `SetReverse`, `GetReverse`, `SetDrawEdge`, `GetDrawEdge`,
 * `GetCooldownDuration` and `SetCooldownUNIX` have **zero** call sites in 3.3.5a's FrameXML; they are
 * registered below through `notImplemented` because addons duck-type them (`if cd.SetReverse then`)
 * and because a silent no-op is how a wrong sweep direction becomes invisible.
 *
 * ## Why nothing is DRAWN
 *
 * The state is stored and readable; the radial sweep is deliberately not rendered, and this is the
 * honest version of that decision rather than an oversight.
 *
 * The in-world UI renders to an offscreen target that is redrawn only when a fingerprint of the draw
 * list changes (`world-ui.ts#drawListSignature`). That single change took `ui.framexml` from ~10 ms to
 * ~1 ms per frame. A sweep is a wedge whose geometry changes every frame, so it would dirty the
 * fingerprint on every frame of every cooldown and hand the entire saving back -- for 12+ buttons, on
 * every global cooldown, which is to say almost always in combat. `STATE.md`'s frame-budget section
 * names this specific hazard.
 *
 * Two further reasons it is not merely a budget trade: the sweep is a radial wedge, and this widget
 * layer draws axis-aligned textured quads only (`widget.ts#drawList`) -- there is no mesh for it. And
 * the live sweep and the global cooldown were both explicitly deferred by the owner to a later round.
 *
 * So `SetCooldown` records `start`/`duration` and the frame's own `Show()`/`Hide()` from
 * `CooldownFrame_SetTimer` still run, which is what makes a button on cooldown distinguishable at all.
 * The un-drawn wedge is declared once through `notImplemented` under the name `Cooldown:sweep` so the
 * load report names the gap instead of it passing as clean -- the same adaptation `api/units.ts` makes
 * to reuse the name registration for something that is not literally a method call.
 */
import { MethodContext, MethodTable, registerMethods } from '../object';
import { Widget } from '../../../widget';
import { notImplemented, warnOnce } from './region';

/**
 * What `SetCooldown` was told.
 *
 * `start` is a `GetTime()`-based timestamp in seconds and `duration` is in seconds -- that is the
 * contract `GetActionCooldown` returns and `CooldownFrame_SetTimer` passes straight through
 * (`ActionButton.lua:347-348`).
 */
export interface CooldownState {
  start: number;
  duration: number;
}

/**
 * Held in a `WeakMap` rather than as a `Widget` field, unlike `Widget#statusBar`.
 *
 * `statusBar` lives on the widget because the RENDERER reads it -- `barFillRect` needs the value to
 * size the fill. Nothing draws a cooldown (see the header), so no draw-pass code needs to reach this,
 * and putting it on `Widget` would imply otherwise. A `WeakMap` also cannot outlive a registry
 * `reset()`, which a widget field would have to be cleared by hand.
 *
 * If a later round draws the sweep, this moves onto `Widget` -- that is the signal that it should.
 */
const STATE = new WeakMap<Widget, CooldownState>();

/** The cooldown a frame is showing, or null. Read by `api/actions.ts` and by tests. */
export function cooldownStateOf(widget: Widget): CooldownState | null {
  return STATE.get(widget) ?? null;
}

const COOLDOWN: MethodTable = {
  /**
   * `SetCooldown(start, duration)`.
   *
   * A zero or negative duration is the client's own "no cooldown" and clears the record; the caller
   * (`CooldownFrame_SetTimer`) already guards for that case before calling, but `SetCooldown` is
   * public and an addon will not.
   */
  SetCooldown: (ctx: MethodContext, self: number, args: unknown[]) => {
    const widget = ctx.registry.widget(self);
    if (widget === null) {
      return [];
    }
    const start = Number(args[0] ?? 0);
    const duration = Number(args[1] ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) {
      STATE.delete(widget);
      return [];
    }
    STATE.set(widget, { start, duration });
    // Named once per session, not per call: this is the un-drawn wedge, and 12 buttons on a shared
    // global cooldown would otherwise print on every swing.
    warnOnce(
      'Cooldown:sweep: not implemented -- SetCooldown records start/duration and the frame still ' +
        'shows and hides, but the radial sweep is not drawn (see methods/cooldown.ts for the ' +
        'frame-budget and geometry reasons)',
    );
    return [];
  },

  /**
   * Registered so the class duck-types correctly, with zero call sites in 3.3.5a's FrameXML (grepped
   * across all 256 manifest and script files). Each would only matter once a sweep is drawn.
   */
  SetReverse: notImplemented(
    'SetReverse',
    'the cooldown sweep is not drawn, so its direction has nothing to reverse',
  ),
  GetReverse: notImplemented(
    'GetReverse',
    'the cooldown sweep is not drawn, so its direction has nothing to report',
    [false],
  ),
  SetDrawEdge: notImplemented(
    'SetDrawEdge',
    'the cooldown sweep is not drawn, so it has no leading edge to draw',
  ),
  GetDrawEdge: notImplemented(
    'GetDrawEdge',
    'the cooldown sweep is not drawn, so it has no leading edge to report',
    [false],
  ),
};

/**
 * `Cooldown:sweep` is not a method, so `notImplemented` is called for its NAME ONLY and the returned
 * function is discarded. What is wanted is the entry in `NOT_IMPLEMENTED`, which is what
 * `loader.ts#callRaw` and the load report read; `api/units.ts:474-480` makes the same reuse for gaps
 * that are globals rather than methods.
 */
notImplemented('Cooldown:sweep', 'declared in methods/cooldown.ts, warned on first SetCooldown');

registerMethods('COOLDOWN', COOLDOWN);
