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

/** `accountlogin.xml:93` authors the login scene's fog on the frame itself, not through the table. */
export const MAIN_MENU_FOG = { r: 0.25, g: 0.06, b: 0.015, near: 0, far: 1200 };

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

    const direction: Vec3 = [row[2], row[3], row[4]];
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
