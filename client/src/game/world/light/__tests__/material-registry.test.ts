/** @jest-environment node */
import { LightBoundMaterial, MaterialRegistry } from '../material-registry';

/** A material that records how it was driven, mimicking M2Material's light surface. */
function makeMaterial(): LightBoundMaterial & { bound: unknown[]; refreshes: number } {
  return {
    mapLight: null,
    bound: [] as unknown[],
    refreshes: 0,
    setMapLight(light: unknown) {
      this.mapLight = light;
      (this as any).bound.push(light);
    },
    updateLightUniforms() {
      (this as any).refreshes += 1;
    },
  } as any;
}

describe('MaterialRegistry', () => {
  it('binds an unseen material to the current light', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const light = { id: 'zone-a' };
    expect(registry.applyLight(light)).toEqual({ seen: 1, applied: 1 });
    expect(material.bound).toEqual([light]);
  });

  it('refreshes uniforms instead of rebinding once already bound', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const light = { id: 'zone-a' };
    registry.applyLight(light);
    registry.applyLight(light);

    expect(material.bound).toEqual([light]);
    expect(material.refreshes).toBe(1);
  });

  it('REBINDS when the map light identity changes, not merely when it is absent', () => {
    // The map.js:246-273 staleness trap: M2 materials are cached across maps, so a shared prop
    // keeps the MapLight of whichever zone loaded it first. A truthiness check would leave it
    // bound to a MapLight nobody ticks anymore, freezing its fog and time of day.
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const zoneA = { id: 'zone-a' };
    const zoneB = { id: 'zone-b' };
    registry.applyLight(zoneA);
    registry.applyLight(zoneB);

    expect(material.bound).toEqual([zoneA, zoneB]);
  });

  it('deduplicates a material added twice', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);
    registry.add(material);
    expect(registry.size).toBe(1);
    expect(registry.applyLight({}).seen).toBe(1);
  });

  it('ignores materials with no light surface but still counts them as seen', () => {
    const registry = new MaterialRegistry();
    registry.add({} as LightBoundMaterial);
    expect(registry.applyLight({})).toEqual({ seen: 1, applied: 0 });
  });

  it('stops driving a deleted material', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);
    registry.delete(material);
    registry.applyLight({});
    expect(material.bound).toEqual([]);
  });

  it('harvests every material on a subtree, including material arrays', () => {
    const a = makeMaterial();
    const b = makeMaterial();
    const c = makeMaterial();
    const subtree = {
      traverse(cb: (child: any) => void) {
        cb({ material: a });
        cb({ material: [b, c] });
        cb({});
      },
    };

    const registry = new MaterialRegistry();
    registry.addFrom(subtree);
    expect(registry.size).toBe(3);
  });
});
