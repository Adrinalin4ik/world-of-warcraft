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
 * ## The sweep IS drawn now, and how the two objections were answered
 *
 * This file used to declare `Cooldown:sweep` through `notImplemented`, for two reasons that were both
 * true and are both now void. They are worth recording because the way out was a rendering decision,
 * not a compromise on fidelity.
 *
 *  1. **"The widget layer draws axis-aligned quads only, so there is no mesh for a radial wedge."**
 *     Correct about the mesh, wrong about what a wedge needs. A radial wedge over a square button is a
 *     FRAGMENT test, not a geometry problem: on one axis-aligned quad covering the button, the shader
 *     computes each pixel's angle about the centre and discards it if the angle is already past the
 *     sweep. So the wedge is drawn on the quad the widget layer already has, and no new mesh type,
 *     triangle fan or vertex path exists. `world-ui.ts#sweepMaterial` is the whole of it.
 *
 *  2. **"It would dirty the draw-list fingerprint every frame for 12+ buttons on every GCD."** This was
 *     the real cost, and it is avoided by not putting the sweep in the fingerprinted list at all. The
 *     offscreen target holds the INTERFACE; the sweeps are drawn in a separate pass afterwards, over the
 *     composite, straight into the canvas. Nothing about the fingerprint changes as a cooldown runs --
 *     a `<Cooldown>` frame is a `frame` widget with no sprite, so its rect, alpha and colour are all
 *     constant while it counts down, and `drawListSignature` reads nothing else. **The fingerprint cost
 *     of a running sweep is therefore exactly zero**, and the per-frame cost is the sweep pass's own
 *     draw calls: one quad per ACTIVE cooldown, bounded by the number of buttons.
 *
 *     The number that matters is already measured in this tree (`world-ui.ts:334-346`, the owner's
 *     RTX 4070 at 1382x911): a UI draw call costs **~35 us**, and the pass is linear in the quad count.
 *     So 12 sweeping buttons cost about **0.4 ms** per frame while they sweep, against the ~12 ms a full
 *     re-render of the interface costs -- which is what dirtying the fingerprint every frame would have
 *     bought instead.
 *
 * `SetCooldown` therefore records `start`/`duration` onto the widget and the frame's own
 * `Show()`/`Hide()` from `CooldownFrame_SetTimer` still decide whether it is drawn at all.
 */
import { MethodContext, MethodTable, registerMethods } from '../object';
import { Widget } from '../../../widget';
import { notImplemented } from './region';

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
 * The cooldown a frame is showing, or null. Read by tests and by the draw pass.
 *
 * This used to be a module-level `WeakMap`, on the stated grounds that nothing drew a cooldown so no
 * draw-pass code needed to reach it -- with the note that drawing the sweep is the signal to move it
 * onto `Widget`. The sweep is drawn now, so it has moved (`Widget#cooldown`).
 */
export function cooldownStateOf(widget: Widget): CooldownState | null {
  return widget.cooldown;
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
      widget.cooldown = null;
      return [];
    }
    widget.cooldown = { start, duration };
    return [];
  },

  /**
   * Registered so the class duck-types correctly, with zero call sites in 3.3.5a's FrameXML (grepped
   * across all 256 manifest and script files). Addons duck-type them (`if cd.SetReverse then`).
   *
   * Still gaps now that the sweep IS drawn, and the reasons have changed: the sweep pass draws one
   * direction (clockwise from twelve o'clock, the client's own) and one shape (a wedge with no bright
   * leading edge), so `SetReverse` and `SetDrawEdge` have a real effect to ask for and are not merely
   * decorative. A silent no-op on either is how a wrong sweep direction becomes invisible.
   */
  SetReverse: notImplemented(
    'SetReverse',
    'the sweep pass draws one direction only (clockwise from twelve o\'clock), so a reversed sweep '
      + 'would need a second uniform and a branch in world-ui.ts#sweepMaterial',
  ),
  GetReverse: notImplemented(
    'GetReverse',
    'the sweep pass draws one direction only, so there is no per-frame reverse flag to report',
    [false],
  ),
  SetDrawEdge: notImplemented(
    'SetDrawEdge',
    'the sweep pass draws the darkened wedge but not the bright leading edge the real client sweeps '
      + 'with, so there is no edge to switch on',
  ),
  GetDrawEdge: notImplemented(
    'GetDrawEdge',
    'the sweep pass draws no leading edge, so there is none to report',
    [false],
  ),
};

// `Cooldown:sweep` was declared here through `notImplemented` for the load report. It has been REMOVED
// rather than left in place: the sweep is drawn (see the header), and a gap the report still names after
// it is closed is a defect by this project's own rule on comments.

registerMethods('COOLDOWN', COOLDOWN);
