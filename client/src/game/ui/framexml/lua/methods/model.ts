/**
 * MODEL: the model-frame surface, made real.
 *
 * `MODEL`/`ModelFFX`/`PlayerModel` all resolve here (`object.ts`'s class aliases), and every method
 * below used to be a warn-once `notImplemented`. The whole surface was a no-op while the client's own
 * Lua was calling all of it, on every stage change:
 *
 * ```lua
 * -- glueparent.lua:327
 * function SetLighting(model, race)
 *     model:SetSequence(0);
 *     model:SetCamera(0);
 *     local fogInfo = CharModelFogInfo[race];
 *     if ( fogInfo ) then
 *         model:SetFogColor(fogInfo.r, fogInfo.g, fogInfo.b);
 *         model:SetFogNear(0);
 *         model:SetFogFar(fogInfo.far);
 *     else
 *         model:ClearFog();
 *     end
 *     local glowInfo = CharModelGlowInfo[race];
 *     if ( glowInfo ) then model:SetGlow(glowInfo); else model:SetGlow(0.3); end
 *     model:ResetLights();
 *     local LightValues = RaceLights[race];
 *     if(LightValues) then
 *         for index, Array in pairs (LightValues) do
 *             if (Array[1]==1) then
 *                 for j, f in pairs ({model.AddCharacterLight, model.AddLight, model.AddPetLight }) do
 *                     f(model, LIGHT_LIVE, unpack(Array));
 *                 end
 *             end
 *         end
 *     end
 * end
 * ```
 *
 * That is the whole chain this file closes, and the reason it matters is that `CharModelFogInfo`,
 * `CharModelGlowInfo` and `RaceLights` had been hand-transcribed into `scene/scene-rig.ts` as well --
 * the same facts twice, once executed and ignored and once copied. The transcriptions are gone; the
 * Lua's calls are what move the scene now.
 *
 * ## Where the state goes, and why there is no callback
 *
 * Into `Widget#modelRig`, and nowhere else. The host does not get told; it POLLS -- the FrameXML
 * screen reads the active model frame's rig once per tick and re-pushes only when `revision` has
 * moved (`screens/framexml-screen.ts`). Three reasons that is the right shape here and a sink is not:
 *
 *  - `SetLighting` issues up to 41 calls in a row for one stage change (2 + 3 fog + 1 glow + 1 reset +
 *    3 sets x up to 3 rows x 13 floats). A per-call callback would rebuild the fold 41 times for one
 *    visible change; a revision compare rebuilds it once, on the tick after.
 *  - There is no notification channel through `object.ts` to add one to, and adding one would have to
 *    reach the scene layer from the generic object model.
 *  - It is the reference's own gate: `glue_booth.rs:816-819` compares a monotonic revision for exactly
 *    this, so a yaw-only change skips the rebuild (`apply_yaw`, `:970-974`).
 *
 * ## What is still a declared gap, and why
 *
 * `AdvanceTime` alone. It is `CharacterSelect_UpdateModel`'s animation step
 * (characterselect.lua:295), reached only from an `<OnUpdate>` this runtime does not dispatch -- and
 * if it were dispatched, the glue scene's models are already advanced once per frame from
 * `worldClock` (`screens.ts#tick` -> `GlueSceneView#update`), so honouring a second Lua-driven step
 * would double-advance every clock on the screen. So it stays `notImplemented` with that reason
 * rather than becoming a method that lies about stepping something.
 */
import { MethodTable, onFrameTeardown, registerMethods } from '../object';
import type { MethodContext } from '../object';
import type { LightSet, ModelRig, RaceLightRow } from '../../../scene/scene-rig';
import { emptyRig } from '../../../scene/scene-rig';
import { notImplemented, widgetOf } from './region';

/** The frame's rig, created on first touch. Every setter goes through this, so `revision` cannot drift. */
function rigOf(ctx: MethodContext, self: number): ModelRig {
  const widget = widgetOf(ctx, self);
  if (widget.modelRig === null) {
    widget.modelRig = emptyRig();
  }
  return widget.modelRig;
}

/** Read a Lua number argument, falling back rather than propagating `NaN` into a uniform. */
function numberAt(args: unknown[], index: number, fallback = 0): number {
  const value = Number(args[index]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * `Add*Light(set, enabled, slot, dx, dy, dz, ambI, ar, ag, ab, diffI, dr, dg, db)`.
 *
 * FOURTEEN arguments, and the first is the LIGHT SET (`LIGHT_LIVE`/`LIGHT_GHOST`), not part of the
 * row -- `f(model, LIGHT_LIVE, unpack(Array))` at glueparent.lua:368 is what fixes that, and reading
 * the row from index 0 instead would have shifted every direction into the enabled flag and folded a
 * rig one channel out of step. A DISABLED row (`enabled == 0`) is still recorded rather than dropped:
 * `foldRaceLights` skips it, and dropping it here would make `ResetLights` + `AddLight(disabled)`
 * indistinguishable from `ResetLights` alone, which means the model's own directionals instead of a
 * deliberately dark set.
 */
function addLight(set: LightSet) {
  return (ctx: MethodContext, self: number, args: unknown[]): unknown[] => {
    const rig = rigOf(ctx, self);
    const row = Array.from({ length: 13 }, (_unused, index) =>
      numberAt(args, index + 1),
    ) as RaceLightRow;
    rig.lights.push({ set, liveness: numberAt(args, 0), row });
    rig.revision += 1;
    return [];
  };
}

const MODEL: MethodTable = {
  /**
   * `SetModel(path)` -- which `.m2` this frame draws.
   *
   * `AccountLogin_OnLoad` is the one caller in the glue manifest (accountlogin.lua:34,36, forked on
   * `IsStreamingTrial()`), and it is why the FrameXML login screen's background no longer has to be
   * chosen by the host: `framexml-screen.ts` used to set `{ kind: 'mainmenu' }` itself with a comment
   * saying it did so because this method was a stub. An empty string clears it, the same way
   * `Texture:SetTexture("")` does.
   */
  SetModel: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    const path = typeof args[0] === 'string' && args[0].trim() !== '' ? args[0] : null;
    rig.modelPath = path;
    rig.revision += 1;
    return [];
  },

  /**
   * `SetSequence(slot)` -- the model's animation, as a FILE SLOT and not an `AnimationData.dbc` id.
   *
   * Every glue caller passes 0, which for a `UI_*` stage is its own ambient loop (the dragon circling
   * Icecrown, the banners). `GlueSceneView` already armed slot 0 by hand; now it arms whichever slot
   * the frame was told.
   */
  SetSequence: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    rig.sequence = Math.trunc(numberAt(args, 0));
    rig.revision += 1;
    return [];
  },

  /**
   * `SetCamera(index)` -- an index into the model's camera TABLE, not a `cameraLookups` slot.
   *
   * These scenes ship one camera whose `cameraLookups` entry is the 0xffff none sentinel, so a
   * lookup-based selection finds nothing; `glue-scene.ts`'s own header records that. Every glue
   * caller passes 0.
   */
  SetCamera: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    rig.camera = Math.trunc(numberAt(args, 0));
    rig.revision += 1;
    return [];
  },

  /**
   * The three fog setters and `ClearFog`.
   *
   * They are INDEPENDENT calls against one triple, which is why the rig holds a fog object rather
   * than three loose fields: `SetLighting` issues colour, then near, then far, and the login screen
   * authors near/far as attributes and the colour as a `<FogColor>` child 2408 lines later
   * (accountlogin.xml:93 and :2501). So any one of them arriving first has to materialize the object
   * and leave the other two at their current values -- black and 0/0 for a frame that has said
   * nothing yet, which is what an unspecified `ColorType` is everywhere else in this renderer.
   *
   * `SetFogNear`/`SetFogFar` deliberately materialize fog on a frame that has none. That is not a
   * guess: it is the only reading under which `<ModelFFX fogNear="0" fogFar="1200">` fogs anything at
   * all, since that element names no colour in the same place.
   */
  SetFogColor: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    const fog = rig.fog ?? { color: [0, 0, 0] as [number, number, number], near: 0, far: 0 };
    rig.fog = {
      color: [numberAt(args, 0), numberAt(args, 1), numberAt(args, 2)],
      near: fog.near,
      far: fog.far,
    };
    rig.revision += 1;
    return [];
  },
  SetFogNear: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    const fog = rig.fog ?? { color: [0, 0, 0] as [number, number, number], near: 0, far: 0 };
    rig.fog = { color: fog.color, near: numberAt(args, 0), far: fog.far };
    rig.revision += 1;
    return [];
  },
  SetFogFar: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    const fog = rig.fog ?? { color: [0, 0, 0] as [number, number, number], near: 0, far: 0 };
    rig.fog = { color: fog.color, near: fog.near, far: numberAt(args, 0) };
    rig.revision += 1;
    return [];
  },
  ClearFog: (ctx, self) => {
    const rig = rigOf(ctx, self);
    rig.fog = null;
    rig.revision += 1;
    return [];
  },

  /**
   * `SetGlow(value)` -- `CharModelGlowInfo[race]`, or 0.3 when the race has no row
   * (glueparent.lua:339-344). RECORDED, and nothing draws it.
   *
   * Real state rather than a `notImplemented`, and the distinction is deliberate: the value arrives,
   * it is readable, and `SetLighting` therefore runs to completion instead of tripping a warning in
   * the middle of a fan-out where every other call now works. What is missing is a BLOOM PASS -- this
   * renderer has one forward pass into the canvas and no post-processing chain at all -- so
   * `glue-scene.ts` logs the value once per scene and draws without it. That gap is named there and in
   * the task report; it is a renderer feature, not a model-frame one.
   */
  SetGlow: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    rig.glow = numberAt(args, 0);
    rig.revision += 1;
    return [];
  },

  /**
   * `ResetLights()` -- "sets all 6 light sets to default for the background", and the client's own
   * comment block (glueparent.lua:347-360) is the specification: "If you add a light to any one of
   * these, NONE of the default lights are used for that set (most backgrounds have 3)."
   *
   * So an EMPTY list means "use the model's defaults", which is exactly the fallback
   * `glue-scene.ts#buildRig` already had for a scene with no Lua row -- and that fallback is not an
   * approximation, it is byte-identical data (see the check written out there, against `UI_Human.m2`'s
   * three directionals and `RaceLights.HUMAN`'s three rows).
   */
  ResetLights: (ctx, self) => {
    const rig = rigOf(ctx, self);
    rig.lights = [];
    rig.revision += 1;
    return [];
  },
  AddLight: addLight('background'),
  AddCharacterLight: addLight('character'),
  AddPetLight: addLight('pet'),

  // The one method on this surface that is still a gap; see the file header for the double-advance
  // reason, which is a better one than "no per-widget model state" was.
  AdvanceTime: notImplemented(
    'AdvanceTime',
    'the glue scene advances every model once per frame from worldClock (screens.ts#tick), so a ' +
      'Lua-driven step would double-advance it -- and its only caller is an OnUpdate this runtime ' +
      'does not dispatch',
  ),
};

/**
 * A released frame drops its rig with it.
 *
 * Registered even though the rig lives on the `Widget` and not in a side table: `FrameRegistry.reset`
 * detaches the widgets from the root but the widget objects themselves may still be reachable from a
 * caller that held one, and a stale rig on a detached widget would be pushed at the scene if that
 * widget were ever re-adopted. Cheap, and it keeps this module's teardown story the same as every
 * other `methods/` module's.
 */
onFrameTeardown((ctx, id) => {
  const widget = ctx.registry.widget(id);
  if (widget) {
    widget.modelRig = null;
  }
});

registerMethods('MODEL', MODEL);
