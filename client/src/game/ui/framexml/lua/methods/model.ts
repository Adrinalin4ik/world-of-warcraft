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
 * moved (`screens/framexml-screen.ts`), and in the world `world-ui.ts` polls every model frame in the
 * draw list the same way for the model booth (`scene/model-booth.ts`). Three reasons that is the
 * right shape here and a sink is not:
 *
 *  - `SetLighting` issues up to 41 calls in a row for one stage change (2 + 3 fog + 1 glow + 1 reset +
 *    3 sets x up to 3 rows x 13 floats). A per-call callback would rebuild the fold 41 times for one
 *    visible change; a revision compare rebuilds it once, on the tick after.
 *  - There is no notification channel through `object.ts` to add one to, and adding one would have to
 *    reach the scene layer from the generic object model.
 *  - It is the reference's own gate: `glue_booth.rs:816-819` compares a monotonic revision for exactly
 *    this, so a yaw-only change skips the rebuild (`apply_yaw`, `:970-974`).
 *
 * ## The world half: `SetUnit`, `RefreshUnit`, `SetRotation`
 *
 * Added this round, and they are the whole of what a `<PlayerModel>` pane needs. `CharacterModelFrame`
 * (`paperdollframe.xml:460`) authors no model file at all -- its content is
 * `CharacterModelFrame:SetUnit("player")` from `PaperDollFrame_OnEvent` (`paperdollframe.lua:159`)
 * and its pose is `Model_OnLoad`'s `self:SetRotation(0.61)` (`uiparent.lua:2824-2827`). Both were
 * absent, so both RAISED: measured live on an ordinary online login before this round,
 * `CharacterModelFrame.SetUnit` and `.SetRotation` both read `nil` and `Model_OnLoad` failed with
 * "attempt to call a nil value (method 'SetRotation')". That is why the pane was a black rectangle --
 * not a renderer gap first, a missing engine method.
 *
 * ## What is still a declared gap, and why
 *
 * `SetCreature`, `TryOn` and `AdvanceTime`; the first two are documented at their own entries.
 * `AdvanceTime` is `CharacterSelect_UpdateModel`'s animation step
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
   * `SetUnit(token)` -- draw this UNIT's dressed model, not a file.
   *
   * The paper doll's only supply. `CharacterModelFrame` never calls `SetModel`: it is a
   * `<PlayerModel>` whose content arrives entirely from `PaperDollFrame_OnEvent` ->
   * `CharacterModelFrame:SetUnit("player")` on `PLAYER_ENTERING_WORLD` and `UNIT_MODEL_CHANGED`
   * (`paperdollframe.lua:157-160`), and from `CharacterModelFrame_OnMouseUp`'s equip path re-firing
   * the same event. Its absence was not a silent gap: `Model_OnLoad` died on `SetRotation` at
   * `uiparent.lua:2826` and this died at `paperdollframe.lua:159`, so the frame had NO rig at all --
   * measured live before this round, `CharacterModelFrame.SetUnit` read `nil`.
   *
   * The token is recorded VERBATIM and not resolved here. Resolution is the host's: `world-ui.ts`
   * hands the booth whichever unit the token names, and the only token any 3.3.5 model pane passes is
   * `"player"` (`paperdollframe.lua:159`, `dressupframe.lua:8`, `tabardframe.lua:27`) or `"pet"`
   * (`petpaperdollframe.lua:471`). A method table has no world to ask -- the same reason
   * `methods/gametooltip.ts` reaches its item feed through a hook.
   */
  SetUnit: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    const unit = typeof args[0] === 'string' && args[0].trim() !== '' ? args[0] : null;
    rig.unit = unit;
    rig.revision += 1;
    return [];
  },

  /**
   * `RefreshUnit()` -- re-read the unit this frame is already showing.
   *
   * `CharacterModelFrame`'s `<OnEvent>` is literally `self:RefreshUnit();`, on
   * `DISPLAY_SIZE_CHANGED` (`paperdollframe.xml:474-478`). It carries no arguments and names no
   * unit, so all it can mean is "whatever `SetUnit` last said, build it again" -- which here is a
   * revision bump, because the booth rebuilds from the rig whenever the revision moves. Not a
   * `notImplemented`: the call has a real effect, and the effect is the one the client asks for.
   */
  RefreshUnit: (ctx, self) => {
    const rig = rigOf(ctx, self);
    rig.revision += 1;
    return [];
  },

  /**
   * `SetRotation(radians)` -- the figure's yaw in the pane.
   *
   * The most-called method on this surface in the world manifest (12 call sites against 6 for
   * `SetUnit`), and the only one that moves at interactive rates: `Model_OnLoad` sets 0.61,
   * `Model_RotateLeft`/`Right` step it by 0.03 per click, and `Model_OnUpdate` sweeps it
   * continuously while a rotate button is held (`uiparent.lua:2824-2865`).
   *
   * NOT normalised. `Model_OnUpdate` does its own wrapping into [0, 2*PI) and `Model_RotateLeft`
   * deliberately does not, so `Model_OnLoad`'s 0.61 minus twenty clicks is a legitimate 0.01 and
   * clamping or wrapping here would fight the client's own arithmetic.
   */
  SetRotation: (ctx, self, args) => {
    const rig = rigOf(ctx, self);
    rig.rotation = numberAt(args, 0);
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

  /**
   * `SetCreature(displayId)` -- the pet-stable panes.
   *
   * ONE caller in the whole world manifest (`petstable.lua`, the stable's slot preview), and it is a
   * `CreatureDisplayInfo` id rather than a unit. Declared rather than written because the booth's one
   * supply today is a `CharacterLook` off a live unit, and a display id takes the OTHER dressing path
   * (`classes/unit.ts#resolveDisplay`) which no model pane is wired to. The stable is not reachable in
   * this client anyway -- there is no stable master.
   */
  SetCreature: notImplemented(
    'SetCreature',
    'the model booth builds a CharacterLook from a live unit; a CreatureDisplayInfo id takes the ' +
      "display-id dressing path instead, and its only caller is the pet stable's slot preview",
  ),

  /**
   * `TryOn(item)` -- the dress-up frame previewing an item the player does not wear.
   *
   * ONE caller (`dressupframe.lua`). Declared rather than written because it needs a look built from
   * the player's gear WITH one slot overridden, and `character-equipment.ts#wornEquipmentFor` reads
   * the unit's real equipment array -- an override parameter is a change to the look resolver, not to
   * this surface. `DressUpModel` also still counts as a missing frame type in the load report, so the
   * frame it belongs to does not exist yet either.
   */
  TryOn: notImplemented(
    'TryOn',
    'previewing an unworn item needs a CharacterLook with one equipment slot overridden, which is a ' +
      'change to character-equipment.ts rather than to the model surface',
  ),

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
