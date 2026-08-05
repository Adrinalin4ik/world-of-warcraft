import * as THREE from 'three';

import { sceneToken, scenePath } from '../tokens';
import {
  CHAR_MODEL_FOG,
  fogTriple,
  foldRaceLights,
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
    expect(sceneToken({ kind: 'race', race: 2 })).toBe('Orc');
    expect(sceneToken({ kind: 'race', race: 8 })).toBe('Orc');
    expect(sceneToken({ kind: 'race', race: 3 })).toBe('Dwarf');
    expect(sceneToken({ kind: 'race', race: 7 })).toBe('Dwarf');
    expect(sceneToken({ kind: 'race', race: 4 })).toBe('NightElf');
    expect(sceneToken({ kind: 'race', race: 5 })).toBe('Scourge');
    expect(sceneToken({ kind: 'race', race: 6 })).toBe('Tauren');
    expect(sceneToken({ kind: 'race', race: 1 })).toBe('Human');
  });

  it("builds the client's own model path", () => {
    expect(scenePath({ kind: 'race', race: 1 })).toBe(
      'Interface\\Glues\\Models\\UI_Human\\UI_Human.m2',
    );
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

  it('skips a disabled row', () => {
    const row = [...RACE_LIGHTS.SCOURGE[0]] as typeof RACE_LIGHTS.SCOURGE[0];
    row[0] = 0;

    expect(foldRaceLights([row]).ambient).toEqual([0, 0, 0]);
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
