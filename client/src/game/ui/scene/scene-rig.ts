/**
 * The glue scene's fog and light rig, folded for the M2 material's uniforms.
 *
 * **The rig is the client's own, at runtime, not a transcription of it.** `RaceLights` and
 * `CharModelFogInfo` used to be hand-copied into this file; they are gone. `SetLighting`
 * (glueparent.lua:327-372) reads those tables ITSELF and pushes them at the model frame --
 * `SetFogColor`/`SetFogNear`/`SetFogFar` or `ClearFog`, `SetGlow`, `ResetLights`, then
 * `AddCharacterLight`/`AddLight`/`AddPetLight` per enabled row -- and `lua/methods/model.ts` now
 * answers all of those for real, into the `ModelRig` below. So the numbers arrive from
 * `interface/gluexml/glueparent.lua` as the client executes it.
 *
 * What still has to be OURS is the FOLD: three.js has no six-light-set glue rig, so a set of
 * `AddLight` rows becomes one ambient term plus an SH probe (`foldRaceLights`). And two of the
 * client's own comments decide the shape of that fold:
 *   - glueparent.lua:50 "RaceLights[] duplicates the 3.2.2 color values in the models. Henceforth,
 *     the models no longer contain directional lights" -- so the DIRECTIONALS come from the Lua.
 *   - glueparent.lua:361 the engine "pulls the default point lights from the models" -- so the POINT
 *     lights come from the M2, and `glue-scene.ts#buildRig` harvests them there.
 */
import { packFogParams } from '../../world/light/fog';
import { propProbeCoeffs, ProbeCoeffs, RGB, Vec3 } from '../../world/light/laws';

/**
 * One `AddLight` row: `Array` in `SetLighting`'s inner loop, 13 numbers after the light-set index.
 *
 * `f(model, LIGHT_LIVE, unpack(Array))` (glueparent.lua:368) is the call, so a method receives the
 * SET first and then these:
 *   [0] enabled  [1] light slot  [2..4] direction  [5] ambient intensity
 *   [6..8] ambient colour  [9] diffuse intensity  [10..12] diffuse colour
 * Read off the shipped values: `RaceLights.HUMAN`'s first row is a straight-down light with 0.27
 * grey ambient and a black diffuse; its other two are ambient-black with coloured diffuse at
 * intensity 1 and 2.
 */
export type RaceLightRow = [
  number, number,
  number, number, number,
  number,
  number, number, number,
  number,
  number, number, number,
];

/**
 * `LIGHT_LIVE`/`LIGHT_GHOST`, glueparent.lua:97-98 -- the first argument to every `Add*Light`.
 *
 * `SetLighting` only ever passes `LIGHT_LIVE`; the ghost sets exist for the "dead character" glue
 * variant, which no 3.3.5 glue Lua reaches. `ModelRig` records the set a row was added to so a row
 * for the ghost variant is kept apart rather than folded into the live rig by accident.
 */
export const LIGHT_LIVE = 0;
export const LIGHT_GHOST = 1;

/** Which of `ResetLights`'s six sets a row belongs to -- see the comment at glueparent.lua:347-360. */
export type LightSet = 'background' | 'character' | 'pet';

/** One `Add*Light` call, kept whole so nothing about which set it was for is lost in the fold. */
export interface RigLight {
  readonly set: LightSet;
  /** `LIGHT_LIVE` or `LIGHT_GHOST`. */
  readonly liveness: number;
  readonly row: RaceLightRow;
}

/**
 * One MODEL frame's own state, exactly as its Lua and its XML set it.
 *
 * Every field is written by a method in `lua/methods/model.ts` (or, for the three the login screen
 * authors as attributes, by `framexml/loader.ts` calling those same methods). Nothing here is
 * derived from a race token or a screen name -- that is the whole point of the type.
 *
 * `revision` is a monotonic counter bumped by every mutation, and it is how the host notices: the
 * FrameXML screen reads the active model frame's rig once per tick and only re-pushes when the
 * number has moved. Same gate the reference uses for its glue preview (`glue_booth.rs:816-819`),
 * and the reason a `SetCharacterSelectFacing` per drag-frame cannot cost a rig rebuild.
 */
export interface ModelRig {
  /** `SetModel(path)`. Null until the frame's Lua names a model. */
  modelPath: string | null;
  /** `SetSequence(slot)` -- a FILE SLOT, not an `AnimationData` id. */
  sequence: number;
  /** `SetCamera(index)` -- an index into the model's camera TABLE. */
  camera: number;
  /** `SetFogColor`/`SetFogNear`/`SetFogFar`, or null once `ClearFog()` has run. */
  fog: { color: RGB; near: number; far: number } | null;
  /** `SetGlow(value)`. Recorded; see `glue-scene.ts#buildRig` for what consumes it (nothing yet). */
  glow: number;
  /** Every `Add*Light` since the last `ResetLights()`, in call order. */
  lights: RigLight[];
  revision: number;
}

/**
 * A frame's rig before anything has set it.
 *
 * The defaults are the engine's own for an untouched `<ModelFFX>`: no model, sequence and camera 0
 * (which is what both `SetLighting` and every `OnLoad` in the glue set them to anyway), NO fog --
 * `ClearFog()`'s state, since a frame that never mentions fog cannot be fogged -- and no lights, in
 * which case `glue-scene.ts` falls back to the model's own directionals, exactly as `ResetLights()`
 * without a following `AddLight` means "use the background's defaults" (glueparent.lua:348).
 *
 * `glow` starts at 0 rather than at `SetLighting`'s 0.3 fallback: 0.3 is what the client picks for a
 * race with no `CharModelGlowInfo` row, which is a decision `SetLighting` makes and not a default
 * of the widget.
 */
export function emptyRig(): ModelRig {
  return { modelPath: null, sequence: 0, camera: 0, fog: null, glow: 0, lights: [], revision: 0 };
}

/** The fog triple a rig resolves to: the packed `fogParams` vec4 plus its colour. */
export function rigFog(rig: ModelRig | null): { color: RGB; params: [number, number, number, number] } {
  if (rig?.fog) {
    return { color: rig.fog.color, params: packFogParams(rig.fog.near, rig.fog.far) };
  }
  // `ClearFog()`, or a frame that never mentioned fog: push the band past the far plane instead of
  // branching in the shader. Black, because an unfogged surface never samples the colour.
  return { color: [0, 0, 0], params: packFogParams(0, 100000) };
}

/**
 * The rows a rig contributes to the DIRECTIONAL fold, and the two narrowings it makes.
 *
 * `SetLighting` adds every enabled row to all three sets with the same values
 * (`for j, f in pairs({model.AddCharacterLight, model.AddLight, model.AddPetLight})`,
 * glueparent.lua:366-370), so on every screen the client actually drives, background == character ==
 * pet. This client folds ONE rig for the whole scene (`glue-scene.ts#render` pushes it into every
 * material it walks), so it takes the BACKGROUND set and drops the other two -- measurably identical
 * today, and named here rather than hidden so the day a caller sets them apart the divergence is
 * findable. `LIGHT_GHOST` rows are dropped for the same reason: nothing in 3.3.5's glue adds one.
 */
export function rigLightRows(rig: ModelRig | null): RaceLightRow[] {
  if (!rig) {
    return [];
  }
  return rig.lights
    .filter((light) => light.set === 'background' && light.liveness === LIGHT_LIVE)
    .map((light) => light.row);
}

/**
 * The login scene's fog, for the HAND-WRITTEN screens only -- and the one transcription in this file
 * that survived making the model methods real, with its reason.
 *
 * It is the whole of `<ModelFFX name="AccountLogin">`'s authored fog, both halves:
 *   accountlogin.xml:93   `... fogNear="0" fogFar="1200" glow="0.08">`
 *   accountlogin.xml:2501 `<FogColor r="0.25" g="0.06" b="0.015"/>`   (last child, before `</ModelFFX>`)
 *
 * **THE COLOUR IS AUTHORED, and the comment that used to stand here said the opposite.** It claimed
 * `AccountLogin` "declares no such child (nor does any other `<ModelFFX>` in the manifest)" and that
 * (0.25, 0.06, 0.015) "had no source at all". Both are wrong: the element is 2408 lines below the
 * open tag, after `<Scripts>`, which is presumably how it was missed, and those three numbers are
 * exactly what it carries. `UI.xsd`'s `ModelType` does put the colour in an optional CHILD rather
 * than an attribute, which is the only true half of that note. Re-fetched and re-read from
 * `12340/interface/gluexml/accountlogin.xml` this round; the other two `<ModelFFX>`es
 * (`CharacterSelect`, characterselect.xml:153; `CharacterCreate`, charactercreate.xml:200) really do
 * author no fog at all, because `SetLighting` gives them theirs.
 *
 * WHY IT STAYS. `?ui=lua` no longer reads it: the loader now issues `SetFogNear`/`SetFogFar`/
 * `SetGlow`/`SetFogColor` from those very attributes, so the FrameXML login screen's fog comes down
 * the client's own path. `screens/login.ts` and `screens/realms.ts` -- which serve plain `/` -- have
 * no Lua VM at all, so nothing there can call a model method; they are the hand-written oracle and
 * are deliberately out of scope. This is their copy of the same six numbers, and the two paths are
 * now checked against each other by eye rather than one being derived from the other.
 *
 * Measured last round and still true: on this scene the COLOUR is inert -- forcing it to full red
 * moved sampled pixels by at most one 8-bit step, because every surface in `UI_MainMenu_Northrend`
 * sits well inside the 0..1200 band and the sky bowl's materials are flagged UNFOGGED (0x02). The
 * NEAR/FAR pair is not inert, which is why this table could not simply be deleted and left to
 * `rigFog(null)`'s past-the-far-plane band.
 */
export const MAIN_MENU_FOG = { r: 0.25, g: 0.06, b: 0.015, near: 0, far: 1200 };

/** One keyframe track, as `wow-data-parser/m2/animation-block.js` hands it back. */
interface Track<T> {
  firstKeyframe?: { timestamp: number; value: T } | null;
}

/** The fields of a parsed M2 `Light` this module reads. Structural, so the parser stays untyped. */
export interface ModelLight {
  /** 0 directional, 1 point (`wow-data-parser/m2/index.js#Light`). */
  type: number;
  ambientColor?: Track<number[]> | null;
  ambientIntensity?: Track<number> | null;
  diffuseColor?: Track<number[]> | null;
  diffuseIntensity?: Track<number> | null;
  visibility?: Track<number> | null;
}

/**
 * An M2's own DIRECTIONAL lights, as `RaceLights` rows.
 *
 * The row layout above is exactly `AddLight`'s argument list, and the M2 `Light` record carries the
 * same five fields (direction, ambient colour + intensity, diffuse colour + intensity) -- see
 * `glue-scene.ts#buildRig` for the byte-level check that the two really are the same data for a
 * scene that has both.
 *
 * A directional M2 light's DIRECTION lives in its bone's orientation, not in the `position` field
 * (which is the bone-space offset), and this does not chase it: rows are emitted pointing straight
 * down, the direction every ambient-only row in `RaceLights` uses. That is exact for a light whose
 * diffuse intensity is zero -- `foldRaceLights` never builds a lobe for one, so the direction is
 * multiplied by nothing -- and approximate for one with a coloured diffuse. `UI_MainMenu_Northrend`,
 * the only scene that reaches this path today, ships exactly one light and its diffuse intensity is
 * 0, so nothing about the login screen is approximated. A scene that needs the other case needs the
 * bone walk, and this is where it goes.
 *
 * `type` 0 is directional; point lights are not folded here because the engine keeps them separate
 * ("pulls the default point lights from the models", glueparent.lua:361) and `glue-scene.ts`
 * harvests those into the point table itself.
 */
export function modelLightRows(lights: readonly ModelLight[]): RaceLightRow[] {
  const rows: RaceLightRow[] = [];

  for (const light of lights) {
    if (light?.type !== 0) {
      continue;
    }
    if (light.visibility?.firstKeyframe?.value === 0) {
      continue; // a light the asset ships explicitly dark, as `glue-scene.ts` skips for points
    }
    const ambient = light.ambientColor?.firstKeyframe?.value ?? [0, 0, 0];
    const diffuse = light.diffuseColor?.firstKeyframe?.value ?? [0, 0, 0];
    rows.push([
      1,
      0,
      0, 0, -1,
      light.ambientIntensity?.firstKeyframe?.value ?? 0,
      ambient[0], ambient[1], ambient[2],
      light.diffuseIntensity?.firstKeyframe?.value ?? 0,
      diffuse[0], diffuse[1], diffuse[2],
    ]);
  }

  return rows;
}

/**
 * Fold a race's light rows into the ambient term plus the SH probe the M2 material's `probeCoeffs`
 * lane expects. Disabled rows (`row[0] === 0`) are skipped, as `SetLighting` skips them.
 */
export function foldRaceLights(rows: RaceLightRow[]): { ambient: RGB; probe: ProbeCoeffs } {
  const ambient: RGB = [0, 0, 0];
  const lobes: Array<{ dir: Vec3; color: RGB }> = [];

  for (const row of rows) {
    if (row[0] === 0) {
      continue;
    }

    // Two corrections, and both are needed before this row can be a `propProbeCoeffs` lobe.
    //
    // 1. `AddLight`'s `[2..4]` is the direction the light SHINES. `propProbeCoeffs` documents its
    //    lobe direction as the TOWARD-LIGHT unit -- its linear band is `+= 2K * s * u`, so
    //    evaluating it against a normal yields `mu = dot(N, u)`. Its other caller,
    //    `foldInteriorProbe`, passes `(lightPos - refPoint)`, which is toward-light. So a row has to
    //    be negated. The table's own comment names the convention: Human row 1's `(0, 0, -1)` is
    //    "a straight-down light", i.e. shining down, reaching an up-facing surface from above.
    // 2. A value read against the M2's geometry has to make `modelToRender`'s trip --
    //    `(x, y, z) -> (-x, -y, z)` -- exactly as the authored camera, the attachment point and the
    //    point lights in `glue-scene.ts#buildRig` already do.
    //
    // Composed, the two are a flip of Z alone: `-modelToRender(d)` is `(d.x, d.y, -d.z)`.
    //
    // Measured before this, on character select's `UI_Human` stage: the cobblestone ground plane's
    // light factor read 0.225 where the walls read 1.0, because an up-facing normal saw only
    // `HUMAN`'s 0.27 ambient minus both key lobes' negative dip (-0.038 warm, -0.013 cool, hand-sum
    // 0.219). The ground is the reference frame's dominant surface and it rendered near-black.
    // The login screen is unaffected: `pickLightRows` gives it `modelLightRows` over
    // `UI_MainMenu_Northrend`'s single directional, whose diffuse intensity is 0, so no lobe is
    // built for it and only the ambient DC lane carries anything.
    const direction: Vec3 = [row[2], row[3], -row[4]];
    const ambientIntensity = row[5];
    const diffuseIntensity = row[9];

    ambient[0] += row[6] * ambientIntensity;
    ambient[1] += row[7] * ambientIntensity;
    ambient[2] += row[8] * ambientIntensity;

    const color: RGB = [
      row[10] * diffuseIntensity,
      row[11] * diffuseIntensity,
      row[12] * diffuseIntensity,
    ];

    if (color[0] > 0 || color[1] > 0 || color[2] > 0) {
      lobes.push({ dir: direction, color });
    }
  }

  return { ambient, probe: propProbeCoeffs(ambient, lobes) };
}

/**
 * The authored FOV is the client's DIAGONAL opening angle. Its projection build takes
 * `half = (fov / 2) / sqrt(aspect^2 + 1)`, so the full vertical angle is `fov / sqrt(aspect^2 + 1)`
 * -- 0.6 x fov at 4:3. A wider window therefore narrows vertically and widens horizontally, which
 * is how the reference reveals more of the stage on a widescreen display.
 */
export function verticalFov(diagonalFov: number, aspect: number): number {
  return diagonalFov / Math.sqrt(aspect * aspect + 1);
}

/**
 * WoW model space to the space the M2 pipeline actually puts its vertices in.
 *
 * `M2#createGeometry` does not upload raw model coordinates. It builds each vertex as `(x, z, -y)`,
 * mirrors the result over X and Y, then rotates -90 degrees about X. Composed, those three steps are
 * a 180-degree yaw about Z: `(x, y, z) -> (-x, -y, z)`.
 *
 * Anything read straight out of the model file and used ALONGSIDE that geometry -- an authored
 * camera's eye and target, a light's position, an attachment point -- has to make the same trip, or
 * it sits in a space rotated half a turn away from the thing it is meant to describe. That is not a
 * hypothetical: the glue scene's camera was aimed with raw model values and pointed away from the
 * stage, which drew a mostly empty frame for one scene and the inside of a mesh for another.
 *
 * `__tests__/scene-rig.test.ts` pins this against the pipeline's own matrix chain, so a change there
 * fails here rather than silently re-rotating every glue scene.
 */
export function modelToRender(v: Vec3): Vec3 {
  return [-v[0], -v[1], v[2]];
}
