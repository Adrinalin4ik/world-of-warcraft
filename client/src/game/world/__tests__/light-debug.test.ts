/**
 * @jest-environment node
 */
import { LightDebug } from '../light-debug';

const m2Like = (y = 1) => ({ uniforms: { materialParams: { value: [1, y, 1, 1] } } });
const wmoLike = (mod: unknown = 1.0) => ({ uniforms: { lightModifier: { value: mod } } });
const terrainLike = () => ({
  uniforms: { lightModifier: { value: 1.0 }, materialParams: { value: [1, 1, 1, 1] } },
});

const mapWith = (materials: any[]) => ({
  materialRegistry: { forEach: (fn: any) => materials.forEach(fn) },
});

describe('LightDebug', () => {
  it('touches nothing while lighting is on', () => {
    const terrain = terrainLike();
    const debug = new LightDebug();

    debug.sync(mapWith([terrain]));

    expect(terrain.uniforms.lightModifier.value).toBe(1.0);
    expect(terrain.uniforms.materialParams.value[1]).toBe(1);
    expect(debug.applied).toBe(0);
  });

  it('pins the M2 light mix to white', () => {
    // M2's only switch: `light = mix(light, vec3(1.0), 1.0 - materialParams.y)`.
    const m2 = m2Like();
    const debug = new LightDebug();
    debug.disabled = true;

    debug.sync(mapWith([m2]));

    expect(m2.uniforms.materialParams.value[1]).toBe(0);
  });

  it('takes the WMO unlit branch', () => {
    // `applyWmoLighting` returns `tex x wmoBrightness` at lightModifier <= 0, skipping MOCV too.
    const wmo = wmoLike();
    const debug = new LightDebug();
    debug.disabled = true;

    debug.sync(mapWith([wmo]));

    expect(wmo.uniforms.lightModifier.value).toBe(0);
  });

  it('sets both switches on terrain, which reads both', () => {
    const terrain = terrainLike();
    const debug = new LightDebug();
    debug.disabled = true;

    debug.sync(mapWith([terrain]));

    expect(terrain.uniforms.lightModifier.value).toBe(0);
    expect(terrain.uniforms.materialParams.value[1]).toBe(0);
  });

  it('restores the exact original, not a blanket 1.0', () => {
    // A batch carrying the M2 unlit render flag legitimately has y = 0 already; restoring 1.0 would
    // light geometry the format says must not be.
    const unlitByFlag = m2Like(0);
    const lit = m2Like(1);
    const debug = new LightDebug();
    const map = mapWith([unlitByFlag, lit]);

    debug.disabled = true;
    debug.sync(map);
    debug.disabled = false;
    debug.sync(map);

    expect(unlitByFlag.uniforms.materialParams.value[1]).toBe(0);
    expect(lit.uniforms.materialParams.value[1]).toBe(1);
  });

  it('restores a lightModifier that was a string, as the materials declare it', () => {
    const wmo = wmoLike('1.0');
    const debug = new LightDebug();
    const map = mapWith([wmo]);

    debug.disabled = true;
    debug.sync(map);
    debug.disabled = false;
    debug.sync(map);

    expect(wmo.uniforms.lightModifier.value).toBe('1.0');
  });

  it('does not stack a stash across frames', () => {
    const terrain = terrainLike();
    const debug = new LightDebug();
    const map = mapWith([terrain]);
    debug.disabled = true;

    debug.sync(map);
    debug.sync(map);
    debug.sync(map);
    debug.disabled = false;
    debug.sync(map);

    expect(terrain.uniforms.lightModifier.value).toBe(1.0);
    expect(terrain.uniforms.materialParams.value[1]).toBe(1);
  });

  it('restores a material that has since left the registry', () => {
    // A map change empties the registry while live geometry still references the material; iterating
    // the registry to restore would leave it unlit forever.
    const m2 = m2Like();
    const debug = new LightDebug();

    debug.disabled = true;
    debug.sync(mapWith([m2]));
    debug.disabled = false;
    debug.sync(mapWith([]));

    expect(m2.uniforms.materialParams.value[1]).toBe(1);
  });

  it('counts only the materials it actually touched', () => {
    const debug = new LightDebug();
    debug.disabled = true;

    debug.sync(mapWith([m2Like(), wmoLike(), { uniforms: {} }, {}, null]));

    expect(debug.applied).toBe(2);
  });

  it('survives a null map and a map with no registry', () => {
    const debug = new LightDebug();
    debug.disabled = true;

    expect(() => debug.sync(null)).not.toThrow();
    expect(() => debug.sync({} as any)).not.toThrow();
    expect(debug.applied).toBe(0);
  });
});
