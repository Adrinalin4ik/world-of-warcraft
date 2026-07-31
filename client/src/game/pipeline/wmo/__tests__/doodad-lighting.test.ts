import * as THREE from 'three';
// @ts-ignore -- index.js is plain JS (allowJs), no .d.ts to satisfy the checker.
import WMO from '../index';

/**
 * Regression coverage for the fix-round-1 finding: `foldDoodadLighting` used to return early for
 * every doodad whose owning group was not `lightingInterior`, which meant an exterior-lane doodad
 * (a porch, a courtyard, any EXTERIOR_LIT group) never got a `PerObjectLighting` block at all --
 * `attachPerObjectLighting` was never called for it, so it rendered with zero point lights even
 * standing right next to its building's own MOLT fixture.
 *
 * These tests exercise `foldDoodadLighting` directly against a real (unloaded) `WMO` instance, with
 * just enough of `root`/`views.root` faked for `worldSpaceLightsForWmo` to resolve real lights.
 */
describe('WMO#foldDoodadLighting exterior lane', () => {
  function makeWmo(lights: any[]) {
    const wmo = new (WMO as any)('Test.wmo');
    wmo.root = { lights };
    wmo.views.root = new THREE.Object3D();
    return wmo;
  }

  function makeDoodad(x: number, y: number, z: number) {
    const doodad: any = new THREE.Object3D();
    doodad.position.set(x, y, z);
    doodad.updateMatrixWorld();
    doodad.submeshes = [];
    return doodad;
  }

  it('gives a non-interior (exterior-owned) doodad its building\'s nearest MOLT point lights', () => {
    const nearLight = {
      position: { x: 10, y: 0, z: 0 },
      color: { r: 1, g: 1, b: 1 },
      intensity: 1,
      attenStart: 5,
      attenEnd: 40,
    };
    const farLight = {
      position: { x: 500, y: 0, z: 0 },
      color: { r: 1, g: 0, b: 0 },
      intensity: 1,
      attenStart: 5,
      attenEnd: 40,
    };

    const wmo = makeWmo([nearLight, farLight]);
    // A courtyard/porch group: present, but explicitly not the interior lighting class.
    wmo.doodadLightingGroups.set(1, { lightingInterior: false, lightRefs: [] });

    const doodad = makeDoodad(0, 0, 0);

    wmo.foldDoodadLighting({ id: 1 }, doodad);

    expect(doodad.perObjectLighting).toBeTruthy();
    expect(doodad.perObjectLighting.interior).toBe(false);
    expect(doodad.perObjectLighting.interiorFog).toBe(false);
    expect(doodad.perObjectLighting.probe).toBeNull();
    // The far light is outside its own attenEnd from the doodad's origin, so only the near one
    // should have been selected.
    expect(doodad.perObjectLighting.pointLights.length).toBe(1);
    expect(doodad.perObjectLighting.pointLights[0].position).toEqual([10, 0, 0]);
  });

  it('gives a doodad with no owning group record the same exterior treatment', () => {
    const light = {
      position: { x: 3, y: 0, z: 0 },
      color: { r: 1, g: 1, b: 1 },
      intensity: 1,
      attenStart: 5,
      attenEnd: 40,
    };
    const wmo = makeWmo([light]);
    // No doodadLightingGroups entry at all for this id.
    const doodad = makeDoodad(0, 0, 0);

    wmo.foldDoodadLighting({ id: 2 }, doodad);

    expect(doodad.perObjectLighting.interior).toBe(false);
    expect(doodad.perObjectLighting.interiorFog).toBe(false);
    expect(doodad.perObjectLighting.pointLights.length).toBe(1);
  });

  it('still folds an interior group into a probe with no point lights of its own', () => {
    const wmo = makeWmo([]);
    wmo.doodadLightingGroups.set(3, { lightingInterior: true, lightRefs: [] });

    const doodad = makeDoodad(0, 0, 0);
    (doodad as any).color = undefined;

    wmo.foldDoodadLighting({ id: 3, color: 0x00706050 }, doodad);

    expect(doodad.perObjectLighting.interior).toBe(true);
    // Interior fog is a SEPARATE flag from `interior` (see PerObjectLighting.interiorFog) -- it just
    // happens to be set from the same group check for a WMO doodad.
    expect(doodad.perObjectLighting.interiorFog).toBe(true);
    expect(doodad.perObjectLighting.probe).toBeTruthy();
    expect(doodad.perObjectLighting.pointLights).toEqual([]);
  });
});
