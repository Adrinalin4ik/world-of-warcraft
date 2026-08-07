import * as THREE from 'three';

import { evalProbe } from '../../../world/light/laws';
import { lightingKey, raceKey, sceneFromPath, sceneToken, scenePath } from '../tokens';
import {
  CHAR_MODEL_FOG,
  fogTriple,
  foldRaceLights,
  modelLightRows,
  modelToRender,
  RACE_LIGHTS,
  verticalFov,
} from '../scene-rig';

describe('sceneToken', () => {
  it('maps the main menu by the trial flag, not by expansion', () => {
    // `accountlogin.lua:32-37`: a streaming-trial account gets the vanilla arch, everyone else gets
    // the Wrath causeway. The Northrend scene is therefore the DEFAULT 3.3.5 login screen.
    expect(sceneToken({ kind: 'mainmenu', streamingTrial: true })).toBe('MainMenu');
    expect(sceneToken({ kind: 'mainmenu', streamingTrial: false })).toBe('MainMenu_Northrend');
  });

  it('shares scenes the way the reference does', () => {
    // glueparent.lua's SetBackgroundModel mapping: Troll rides Orc's stage, Gnome rides Dwarf's.
    // The witness is the client's own tables -- glueparent.lua:20-67 has no GNOME and no TROLL key
    // in CharModelFogInfo, GlueAmbienceTracks or RaceLights.
    expect(raceKey(2)).toBe('ORC');
    expect(raceKey(8)).toBe('ORC');
    expect(raceKey(3)).toBe('DWARF');
    expect(raceKey(7)).toBe('DWARF');
    expect(raceKey(4)).toBe('NIGHTELF');
    expect(raceKey(5)).toBe('SCOURGE');
    expect(raceKey(6)).toBe('TAUREN');
    expect(raceKey(1)).toBe('HUMAN');
  });

  it("builds the client's own model path", () => {
    expect(scenePath({ kind: 'model', token: 'Human' })).toBe(
      'Interface\\Glues\\Models\\UI_Human\\UI_Human.m2',
    );
  });
});

describe('sceneFromPath', () => {
  /**
   * THE round trip the character-select background rides on, end to end and in the client's own
   * order: a race id -> `GetSelectBackgroundModel`'s name (`raceKey`) -> the path
   * `SetBackgroundModel` builds out of it (glueparent.lua:376) -> the scene this host loads.
   *
   * The path string here is not a fixture, it is `"Interface\\Glues\\Models\\UI_"..name.."\\UI_"
   * ..name..".m2"` with `name` substituted, so a change to either end fails here.
   */
  it("recovers the scene from the path SetBackgroundModel builds for a Human", () => {
    const name = raceKey(1);
    const scene = sceneFromPath(`Interface\\Glues\\Models\\UI_${name}\\UI_${name}.m2`)!;

    expect(scene).toEqual({ kind: 'model', token: 'HUMAN' });
    expect(sceneToken(scene)).toBe('HUMAN');
    expect(lightingKey(scene)).toBe('HUMAN'); // SetLighting's strupper(name) key
    expect(RACE_LIGHTS[lightingKey(scene)!]).toBe(RACE_LIGHTS.HUMAN);
  });
});

describe('fogTriple', () => {
  it('reads a CharModelFogInfo row', () => {
    const fog = fogTriple('SCOURGE')!;

    expect(fog.color).toEqual([0, 0.22, 0.22]);
    // near is always 0 in SetLighting; far comes from the row.
    expect(CHAR_MODEL_FOG.SCOURGE.far).toBe(26);
    expect(fog.params).toHaveLength(4);
  });

  it('has the dedicated CHARACTERSELECT row -- our select screen IS fogged', () => {
    // benilla found 1.12 renders select unfogged; 3.3.5 runs the same SetLighting for both screens
    // and ships this row. Where they disagree, our client data wins.
    expect(CHAR_MODEL_FOG.CHARACTERSELECT).toEqual({ r: 0.8, g: 0.65, b: 0.73, far: 222 });
  });

  it('returns null for a race with no row, which means ClearFog', () => {
    expect(fogTriple('NOSUCHRACE')).toBeNull();
  });
});

describe('foldRaceLights', () => {
  it('sums the ambient-only rows into ambient and the coloured rows into lobes', () => {
    const folded = foldRaceLights(RACE_LIGHTS.HUMAN);

    // Human row 1 is ambient 0.27 grey with a black diffuse; rows 2 and 3 are diffuse-only.
    expect(folded.ambient[0]).toBeCloseTo(0.27);
    expect(folded.probe).toHaveLength(7);
    folded.probe.forEach((row) => row.forEach((value) => expect(Number.isFinite(value)).toBe(true)));
  });

  it('folds every shipped race table to finite coefficients', () => {
    Object.values(RACE_LIGHTS).forEach((rows) => {
      const folded = foldRaceLights(rows);
      folded.probe.forEach((row) => row.forEach((v) => expect(Number.isFinite(v)).toBe(true)));
    });
  });

  it('lights an up-facing surface from above', () => {
    // The defect this pins: `AddLight`'s direction is the direction the light SHINES, and
    // `propProbeCoeffs` wants the toward-light unit. Fed the row verbatim, Human's two coloured
    // lobes -- both shining downward -- reached an up-facing normal on their negative-dip side, so
    // the probe returned LESS than the 0.27 ambient there and character select's cobblestone ground
    // rendered near-black. Up must beat down, and up must beat ambient alone.
    const { probe } = foldRaceLights(RACE_LIGHTS.HUMAN);
    const up = evalProbe(probe, [0, 0, 1]);
    const down = evalProbe(probe, [0, 0, -1]);

    expect(up[0]).toBeGreaterThan(0.27);
    expect(up[0]).toBeGreaterThan(down[0]);
  });

  it('skips a disabled row', () => {
    const row = [...RACE_LIGHTS.SCOURGE[0]] as typeof RACE_LIGHTS.SCOURGE[0];
    row[0] = 0;

    expect(foldRaceLights([row]).ambient).toEqual([0, 0, 0]);
  });
});

describe('modelLightRows', () => {
  /**
   * The claim `glue-scene.ts#buildRig` rests on, pinned: glueparent.lua:50 says "RaceLights[]
   * duplicates the 3.2.2 color values in the models", so a model's own directionals folded into rows
   * must come out as the race's Lua rows do. These three lights are `UI_Human.m2`'s, read out of the
   * shipped file (build 12340) -- colour x intensity for each equals `RaceLights.HUMAN`'s, which is
   * what makes the model an honest source for a scene the Lua table does not name.
   */
  it("folds UI_Human.m2's own directionals to RaceLights.HUMAN's light", () => {
    const track = <T,>(value: T) => ({ firstKeyframe: { timestamp: 0, value } });
    const uiHumanLights = [
      {
        type: 0,
        ambientColor: track([1, 1, 1]),
        ambientIntensity: track(0),
        diffuseColor: track([0.9490196704864502, 0.8000000715255737, 0.5411764979362488]),
        diffuseIntensity: track(1.100000023841858),
        visibility: track(1),
      },
      {
        type: 0,
        ambientColor: track([1, 1, 1]),
        ambientIntensity: track(0),
        diffuseColor: track([0.30588236451148987, 0.5372549295425415, 0.6705882549285889]),
        diffuseIntensity: track(0.6499999761581421),
        visibility: track(1),
      },
      {
        type: 0,
        ambientColor: track([1, 1, 1]),
        ambientIntensity: track(0.27000001072883606),
        diffuseColor: track([1, 1, 1]),
        diffuseIntensity: track(0),
        visibility: track(1),
      },
    ];

    // What is compared is each row's LIGHT -- colour times intensity, which is the only thing
    // `foldRaceLights` ever uses the two for. Not the folded probe: the Lua rows carry authored
    // DIRECTIONS and a directional M2 light's direction lives in its bone, which `modelLightRows`
    // does not chase (it says so). Rows are matched by their place in the file: model light 2 is
    // the ambient one and Lua row 0 is, and the two diffuse rows come in opposite order.
    const light = (row: readonly number[]) => ({
      ambient: [row[6] * row[5], row[7] * row[5], row[8] * row[5]],
      diffuse: [row[10] * row[9], row[11] * row[9], row[12] * row[9]],
    });
    const model = modelLightRows(uiHumanLights).map(light);
    const lua = RACE_LIGHTS.HUMAN.map(light);
    const pairs: Array<[number, number]> = [[2, 0], [1, 1], [0, 2]];

    for (const [fromModel, fromLua] of pairs) {
      for (let channel = 0; channel < 3; ++channel) {
        expect(model[fromModel].ambient[channel]).toBeCloseTo(lua[fromLua].ambient[channel], 6);
        expect(model[fromModel].diffuse[channel]).toBeCloseTo(lua[fromLua].diffuse[channel], 6);
      }
    }
  });
});

describe('verticalFov', () => {
  it("converts the diagonal FOV at 4:3 to the reference's 0.6x vertical", () => {
    // The client builds its projection from a DIAGONAL angle: half-angle = (fov/2)/sqrt(aspect^2+1),
    // so the full vertical angle at 4/3 is 0.6 * fov.
    expect(verticalFov(1, 4 / 3)).toBeCloseTo(0.6);
  });

  it('narrows vertically as the window widens, which reveals width', () => {
    expect(verticalFov(1, 16 / 9)).toBeLessThan(verticalFov(1, 4 / 3));
  });
});

describe('modelToRender', () => {
  /**
   * The pipeline's own vertex transform, reproduced step for step from `M2#createGeometry`:
   * build as (x, z, -y), mirror X and Y, rotate -90 degrees about X. If that ever changes, this
   * test fails and `modelToRender` must follow it.
   */
  function pipelineTransform(x: number, y: number, z: number): THREE.Vector3 {
    const v = new THREE.Vector3(x, z, -y);
    v.applyMatrix4(new THREE.Matrix4().makeScale(-1, -1, 1));
    v.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    return v;
  }

  it('matches the transform the M2 pipeline applies to vertices', () => {
    const samples: Array<[number, number, number]> = [
      [3.84, 2.01, -1.03],
      [-1.37, 0.76, 0.92],
      [0, 0, 0],
      [100, -250.5, 33.25],
    ];

    for (const [x, y, z] of samples) {
      const expected = pipelineTransform(x, y, z);
      const actual = modelToRender([x, y, z]);

      expect(actual[0]).toBeCloseTo(expected.x, 5);
      expect(actual[1]).toBeCloseTo(expected.y, 5);
      expect(actual[2]).toBeCloseTo(expected.z, 5);
    }
  });

  it('is a half turn about Z: X and Y flip, Z is untouched', () => {
    expect(modelToRender([1, 2, 3])).toEqual([-1, -2, 3]);
  });

  it('is its own inverse', () => {
    expect(modelToRender(modelToRender([7, -8, 9]))).toEqual([7, -8, 9]);
  });
});
