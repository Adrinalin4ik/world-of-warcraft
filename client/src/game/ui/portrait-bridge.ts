/**
 * `SetPortraitTexture(texture, unit)` -- the unit frames' 3D faces.
 *
 * ## What it is and why it lives here
 *
 * It is an ENGINE global, not a frame method: `UnitFramePortrait_Update` calls
 * `SetPortraitTexture(self.portrait, self.unit)` and nothing else in FrameXML defines it
 * (`unitframe.lua:96-100`). `api/units.ts` declared it a gap with the reason "no portrait render
 * target exists in this client", which was exactly true and is not any more -- `scene/model-booth.ts`
 * is that render target.
 *
 * It lives in its own module rather than in `api/units.ts` because it needs `ctx.frameIdOf`: its first
 * argument is a texture region's Lua table, and turning a Lua handle back into a widget is something
 * only the object model can do, while `installUnitsApi` is handed a bare `LuaVM`.
 *
 * ## It is installed BEFORE the manifest load, and that ordering is the whole feature
 *
 * `UnitFrame_Initialize` asks for the portrait ONCE, from the frame's own `<OnLoad>`:
 * `UnitFrame_Update` -> `UnitFramePortrait_Update` -> `SetPortraitTexture` (`unitframe.lua:34-56`).
 * Nothing asks again -- `PlayerFrame`'s `<OnEvent>` is `PlayerFrame_OnEvent`, which does not handle
 * `UNIT_PORTRAIT_UPDATE` at all, so the event `UnitFrame_Initialize` registers is delivered to a
 * handler that ignores it. Registered from a BRIDGE (after the load, beside the unit and action
 * bridges) this global therefore existed for every caller EXCEPT the only one that matters.
 *
 * MEASURED: with it attached as a bridge, the only portraits that ever appeared were
 * `CharacterFramePortrait` and `MicroButtonPortrait` -- both set from a keystroke long after the load
 * -- and re-running `UnitFrame_Initialize(PlayerFrame, ...)` by hand rigged the player's portrait
 * immediately. So it is installed in `framexml/world-runtime.ts` alongside the other pre-load
 * installers, each of which is there for the same class of reason (`installBindingsApi`,
 * `installCastingApi`, `installItemsApi`).
 *
 * ## Why a `<Texture>` ends up carrying a `modelRig`
 *
 * Because that is the honest description of what has happened to it: its pixels now come from a model.
 * `Widget#modelRig` is the one field the DRAW pass can see per widget (`world-ui.ts` polls the draw
 * list for it), and the booth's whole design is that a pane is an ordinary sprite in the ordinary draw
 * list. A side table keyed by widget would be invisible to that pass -- the mistake
 * `methods/cooldown.ts` already had to undo when the sweep started being drawn.
 *
 * The rig's `framing` field is what keeps a portrait from being framed like a paper doll: a portrait is
 * the model's own authored bust camera, a body pane is a fitted full-figure camera, and the reference
 * keeps them apart as two laws rather than one with a zoom (`benilla/.../portrait/mod.rs:12-19`).
 *
 * ## The one thing this must not do
 *
 * Bump the rig's `revision` when nothing changed. `UnitFramePortrait_Update` runs from
 * `UnitFrame_Update`, which every unit event reaches, so this is called often -- and a revision bump is
 * a re-bake. So the unit token is compared first and the counter moves only when the answer is
 * genuinely different. Getting that wrong would put a scene render on every unit event, which is the
 * whole cost this subsystem is built to avoid.
 *
 * ## What is still missing, named rather than hidden
 *
 * The ROUND MASK. The real client stamps a circular alpha stencil into the portrait it bakes
 * (`benilla/.../portrait/mod.rs:4-8`). This bakes a square and relies on the unit frame's own art
 * covering the corners, which is what `PlayerFrameTexture` is drawn over the top for. If the corners
 * read as square in a screenshot, a mask in the bake is the fix and not a crop here.
 */
import { emptyRig } from './scene/scene-rig';
import type { FrameRegistry, MethodContext } from './framexml/lua/object';
import type { LuaVM } from './framexml/lua/vm';

/** Names already reported as unresolvable, so a bad call warns once rather than per unit event. */
const warned = new Set<string>();

/**
 * Register the global. No teardown: the VM is disposed with its runtime, so the closure cannot outlive
 * the registry it holds.
 */
export function installPortraitApi(
  vm: LuaVM,
  ctx: MethodContext,
  registry: FrameRegistry,
): void {
  warned.clear();

  vm.registerFunction('SetPortraitTexture', (args: unknown[]) => {
    const id = ctx.frameIdOf(args[0]);
    const unit = typeof args[1] === 'string' && args[1].trim() !== '' ? args[1] : null;
    if (id === null) {
      // Not a frame table. Real FrameXML always passes `self.portrait`, so this is a bug in a script
      // rather than a case to handle -- but it is named, because a portrait that never appears has
      // three indistinguishable causes and this is one of them.
      if (!warned.has('arg')) {
        warned.add('arg');
        console.warn('SetPortraitTexture: first argument is not a texture region; nothing to draw on');
      }
      return [];
    }
    const widget = registry.widget(id);
    if (!widget) {
      return [];
    }
    if (widget.modelRig === null) {
      widget.modelRig = emptyRig();
    }
    const rig = widget.modelRig;
    rig.framing = 'portrait';
    // ONLY on a real change -- see the header. `UnitFrame_Update` calls this on every unit event.
    if (rig.unit !== unit) {
      rig.unit = unit;
      rig.revision += 1;
    }
    return [];
  });
}
