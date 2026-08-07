/**
 * The glue scene's fog and light rig, folded for the M2 material's uniforms.
 *
 * TRANSCRIBED FROM OUR CLIENT DATA (`interface/gluexml/glueparent.lua`), and this is where 3.3.5
 * parts company with the 1.12 reference. `glueparent.lua:50` says it outright: "RaceLights[]
 * duplicates the 3.2.2 color values in the models. Henceforth, the models no longer contain
 * directional lights", and `:361` adds that the engine "pulls the default point lights from the
 * models". So the DIRECTIONALS come from the table below and only the POINT lights come from the
 * M2 -- where benilla folds the model's own directional rig, we fold this.
 *
 * Row layout (13 numbers, `AddLight(index, unpack(row))`):
 *   [0] enabled  [1] light slot  [2..4] direction  [5] ambient intensity
 *   [6..8] ambient colour  [9] diffuse intensity  [10..12] diffuse colour
 * Read off the shipped values: Human row 1 is a straight-down light with 0.27 grey ambient and a
 * black diffuse; rows 2 and 3 are ambient-black with coloured diffuse at intensity 1 and 2.
 */
import { packFogParams } from '../../world/light/fog';
import { propProbeCoeffs, ProbeCoeffs, RGB, Vec3 } from '../../world/light/laws';

export type RaceLightRow = [
  number, number,
  number, number, number,
  number,
  number, number, number,
  number,
  number, number, number,
];

/** `glueparent.lua:51` -- verbatim. */
export const RACE_LIGHTS: Record<string, RaceLightRow[]> = {
  HUMAN: [
    [1, 0, 0, 0, -1, 1.0, 0.27, 0.27, 0.27, 1.0, 0, 0, 0],
    [1, 0, -0.45756075, -0.58900136, -0.66611975, 1.0, 0, 0, 0, 1.0, 0.19882353, 0.34921569, 0.43588236],
    [1, 0, -0.64623469, 0.57582057, -0.50081086, 1.0, 0, 0, 0, 2.0, 0.52196085, 0.44, 0.29764709],
  ],
  ORC: [
    [1, 0, 0, 0, -1, 1.0, 0.15, 0.15, 0.15, 1.0, 0, 0, 0],
    [1, 0, -0.74919, 0.35208, -0.56103, 1.0, 0, 0, 0, 1.0, 0.44706, 0.5451, 0.73725],
    [1, 0, 0.53162, -0.8434, 0.0778, 1.0, 0, 0, 0, 2.0, 0.55, 0.338625, 0.148825],
  ],
  DWARF: [
    [1, 0, 0, 0, -1, 1.0, 0.3, 0.3, 0.3, 0.0, 0, 0, 0],
    [1, 0, -0.88314, 0.42916, -0.18945, 1.0, 0, 0, 0, 2.0, 0.44706, 0.67451, 0.760785],
  ],
  TAUREN: [
    [1, 0, -0.48073, 0.71827, -0.50297, 1.0, 0, 0, 0, 2.0, 0.65, 0.397645, 0.2727],
    [1, 0, -0.49767, -0.78677, 0.36513, 1.0, 0, 0, 0, 1.0, 0.6, 0.47059, 0.32471],
  ],
  SCOURGE: [[1, 0, 0, 0, -1, 1.0, 0.2, 0.2, 0.2, 1.0, 0, 0, 0]],
  NIGHTELF: [[1, 0, 0, 0, -1, 1.0, 0.0902, 0.0902, 0.1702, 1.0, 0, 0, 0]],
  DRAENEI: [
    [1, 0, 0.61185, 0.62942, -0.47903, 1.0, 0, 0, 0, 1.0, 0.56941, 0.52, 0.6],
    [1, 0, -0.64345, -0.31052, -0.69968, 1.0, 0, 0, 0, 1.0, 0.60941, 0.60392, 0.7],
    [1, 0, -0.46481, -0.1432, 0.87376, 1.0, 0, 0, 0, 2.0, 0.5835, 0.48941, 0.6],
  ],
  BLOODELF: [
    [1, 0, -0.82249, -0.54912, -0.14822, 1.0, 0, 0, 0, 2.0, 0.581175, 0.50588, 0.42588],
    [1, 0, 0, 0, -1, 1.0, 0.60392, 0.6149, 0.7, 1.0, 0, 0, 0],
    [1, 0, 0.02575, 0.86518, -0.50081, 1.0, 0, 0, 0, 1.0, 0.59137, 0.51745, 0.63471],
  ],
  DEATHKNIGHT: [[1, 0, 0, 0, -1, 1.0, 0.38824, 0.66353, 0.76941, 1.0, 0, 0, 0]],
  CHARACTERSELECT: [
    [1, 0, 0, 0, -1, 1.0, 0.15, 0.15, 0.15, 1.0, 0, 0, 0],
    [1, 0, -0.74919, 0.35208, -0.56103, 1.0, 0, 0, 0, 1.0, 0.44706, 0.5451, 0.73725],
    [1, 0, 0.53162, -0.8434, 0.0778, 1.0, 0, 0, 0, 2.0, 0.55, 0.338625, 0.148825],
  ],
};

/** `glueparent.lua:22` -- verbatim. `near` is always 0 in `SetLighting`. */
export const CHAR_MODEL_FOG: Record<string, { r: number; g: number; b: number; far: number }> = {
  HUMAN: { r: 0.8, g: 0.65, b: 0.73, far: 222 },
  ORC: { r: 0.5, g: 0.5, b: 0.5, far: 270 },
  DWARF: { r: 0.85, g: 0.88, b: 1.0, far: 500 },
  NIGHTELF: { r: 0.25, g: 0.22, b: 0.55, far: 611 },
  TAUREN: { r: 1.0, g: 0.61, b: 0.42, far: 153 },
  SCOURGE: { r: 0, g: 0.22, b: 0.22, far: 26 },
  CHARACTERSELECT: { r: 0.8, g: 0.65, b: 0.73, far: 222 },
};

/**
 * The login scene's fog. **`near` and `far` are authored; the colour is not, and this comment used
 * to claim otherwise.**
 *
 * accountlogin.xml:93 is, in full:
 *   `<ModelFFX name="AccountLogin" ... fogNear="0" fogFar="1200" glow="0.08">`
 * `UI.xsd`'s `ModelType` puts the colour in an OPTIONAL `<FogColor>` CHILD element, not in an
 * attribute, and `AccountLogin` declares no such child (nor does any other `<ModelFFX>` in the
 * manifest). So 0/1200 are the client's numbers and the colour is the engine's unstated default,
 * which is in no file we can read.
 *
 * Black is what an unspecified `ColorType` is elsewhere in this renderer, and it is what
 * `glue-scene.ts` already uses for a scene whose `CharModelFogInfo` row is missing -- so it is the
 * consistent unknown rather than a new invention. **Measured, the choice is inert on this scene:**
 * setting the colour to full red (1, 0, 0) and re-shooting the login screen moved the sampled
 * pixels by at most one 8-bit step (bridge 10,24,29 -> 11,24,29), because every surface in
 * `UI_MainMenu_Northrend` sits well inside the authored 0..1200 band and the sky bowl's own
 * materials are flagged UNFOGGED (0x02). The value that was here before -- (0.25, 0.06, 0.015) --
 * had no source at all.
 */
export const MAIN_MENU_FOG = { r: 0, g: 0, b: 0, near: 0, far: 1200 };

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
 * The fog triple for a scene key, or null when the client would `ClearFog()`.
 * `params` is the packed `fogParams` vec4 the M2 shader consumes.
 */
export function fogTriple(
  key: string,
): { color: RGB; params: [number, number, number, number] } | null {
  const row = CHAR_MODEL_FOG[key];
  if (!row) {
    return null;
  }
  return { color: [row.r, row.g, row.b], params: packFogParams(0, row.far) };
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
