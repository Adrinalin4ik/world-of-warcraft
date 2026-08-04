/**
 * @jest-environment node
 */
import { FogDebug } from '../fog-debug';

/** A vec4-shaped uniform value with the `set` the sync calls. */
function vec4(x = 1, y = 2, z = 3, w = 4) {
  return {
    x, y, z, w,
    set(nx: number, ny: number, nz: number, nw: number) {
      this.x = nx; this.y = ny; this.z = nz; this.w = nw;
      return this;
    },
  };
}

function mapWith(materials: any[]) {
  return { materialRegistry: { forEach: (fn: any) => materials.forEach(fn) } };
}

const fogged = () => ({ uniforms: { fogParams: { value: vec4() }, wmoFogParams: { value: vec4() } } });

describe('FogDebug', () => {
  it('touches nothing while enabled', () => {
    const material = fogged();
    const debug = new FogDebug();

    debug.sync(mapWith([material]));

    expect(material.uniforms.fogParams.value.x).toBe(1);
    expect(debug.applied).toBe(0);
  });

  it('pins the ramp so the factor resolves to zero', () => {
    // The law every family shares: f1 = d * x + y, factor = 1 - clamp(f1, 0, 1). At x=0, y=1 the
    // factor is zero at every distance.
    const material = fogged();
    const debug = new FogDebug();
    debug.disabled = true;

    debug.sync(mapWith([material]));

    expect(material.uniforms.fogParams.value.x).toBe(0);
    expect(material.uniforms.fogParams.value.y).toBe(1);
  });

  it('neutralises the interior triple as well', () => {
    // A camera inside a WMO room takes `wmoFogParams` instead, so leaving it alone would keep fogging
    // exactly the interiors this is most often used to inspect.
    const material = fogged();
    const debug = new FogDebug();
    debug.disabled = true;

    debug.sync(mapWith([material]));

    expect(material.uniforms.wmoFogParams.value.x).toBe(0);
    expect(material.uniforms.wmoFogParams.value.y).toBe(1);
  });

  it('counts only the materials it actually touched', () => {
    const debug = new FogDebug();
    debug.disabled = true;

    debug.sync(mapWith([fogged(), fogged(), { uniforms: {} }, {}, null]));

    expect(debug.applied).toBe(2);
  });

  it('handles a material carrying only the scene triple', () => {
    const material = { uniforms: { fogParams: { value: vec4() } } };
    const debug = new FogDebug();
    debug.disabled = true;

    expect(() => debug.sync(mapWith([material]))).not.toThrow();
    expect(debug.applied).toBe(1);
  });

  it('reports zero applied once switched back on, since the light pass restores it', () => {
    const material = fogged();
    const debug = new FogDebug();
    debug.disabled = true;
    debug.sync(mapWith([material]));

    debug.disabled = false;
    debug.sync(mapWith([material]));

    expect(debug.applied).toBe(0);
  });

  it('survives a null map and a map with no registry', () => {
    const debug = new FogDebug();
    debug.disabled = true;

    expect(() => debug.sync(null)).not.toThrow();
    expect(() => debug.sync({} as any)).not.toThrow();
    expect(debug.applied).toBe(0);
  });
});
