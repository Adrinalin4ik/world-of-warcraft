import WorldMap from '../map';

/**
 * `applyLightToMaterial` is tested against `WorldMap.prototype` directly rather than a constructed
 * `WorldMap` -- the constructor loads DBC/WDT data and stands up every manager, none of which this
 * unit cares about. All the method touches is `this.mapLight` and the material argument, so a plain
 * fake `this` exercises the real logic with no scaffolding.
 */
describe('WorldMap#applyLightToMaterial', () => {
  const currentMapLight = { name: 'current' };

  const fakeMaterial = (overrides = {}) => ({
    mapLight: null,
    setMapLight: jest.fn(function (mapLight) {
      this.mapLight = mapLight;
    }),
    updateLightUniforms: jest.fn(),
    ...overrides,
  });

  it('binds a material that has never been bound', () => {
    const material = fakeMaterial();
    const self = { mapLight: currentMapLight };

    const applied = WorldMap.prototype.applyLightToMaterial.call(self, material);

    expect(applied).toBe(true);
    expect(material.setMapLight).toHaveBeenCalledWith(currentMapLight);
    expect(material.updateLightUniforms).not.toHaveBeenCalled();
    expect(material.mapLight).toBe(currentMapLight);
  });

  it('just refreshes uniforms on a material already bound to the CURRENT map light', () => {
    const material = fakeMaterial({ mapLight: currentMapLight });
    const self = { mapLight: currentMapLight };

    const applied = WorldMap.prototype.applyLightToMaterial.call(self, material);

    expect(applied).toBe(true);
    expect(material.setMapLight).not.toHaveBeenCalled();
    expect(material.updateLightUniforms).toHaveBeenCalledTimes(1);
  });

  // The regression this guards: a material cached and shared across zones (M2Blueprint.cache /
  // M2#batches -- a shipwreck prop, a floating log pile) keeps whatever MapLight it was first bound
  // to. `changeMap` swaps `WorldMap.mapLight` for a fresh `MapLight` on every zone change without
  // touching that cache, so the STALE MapLight the material is still holding never receives another
  // `.update()` call -- its fog/sun/time-of-day are frozen at whatever they were the instant the old
  // zone stopped ticking. A truthiness check on `material.mapLight` treats that stale reference as
  // "already bound" and never re-syncs it; comparing against the CURRENT map light does.
  it('re-binds a material whose mapLight is a STALE reference from a previous map/zone', () => {
    const staleMapLight = { name: 'stale-from-old-zone' };
    const material = fakeMaterial({ mapLight: staleMapLight });
    const self = { mapLight: currentMapLight };

    const applied = WorldMap.prototype.applyLightToMaterial.call(self, material);

    expect(applied).toBe(true);
    expect(material.setMapLight).toHaveBeenCalledWith(currentMapLight);
    expect(material.mapLight).toBe(currentMapLight);
  });

  it('returns false for a material with neither setMapLight nor updateLightUniforms', () => {
    const material = {};
    const self = { mapLight: currentMapLight };

    expect(WorldMap.prototype.applyLightToMaterial.call(self, material)).toBe(false);
  });

  it('returns false for a null/undefined material', () => {
    const self = { mapLight: currentMapLight };

    expect(WorldMap.prototype.applyLightToMaterial.call(self, null)).toBe(false);
    expect(WorldMap.prototype.applyLightToMaterial.call(self, undefined)).toBe(false);
  });
});
