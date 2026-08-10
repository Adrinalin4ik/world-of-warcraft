/**
 * @jest-environment node
 */
import { WmoDebug, WmoDebugMode } from '../wmo-debug';

/** A WorldMap-shaped stub: one entry per WMO, each holding a Map of group views. */
function mapWith(groupsPerEntry: number[]) {
  const meshes: any[] = [];

  const entries = groupsPerEntry.map((count) => {
    const groups = new Map<number, any>();

    for (let i = 0; i < count; ++i) {
      const mesh = { material: { name: `real-${meshes.length}` }, geometry: {} };
      meshes.push(mesh);
      groups.set(i, { mesh });
    }

    return { views: { groups } };
  });

  return {
    meshes,
    map: { wmoManager: { entries: { forEach: (fn: any) => entries.forEach(fn) } } },
  };
}

describe('WmoDebug', () => {
  it('changes nothing while off', () => {
    const { map, meshes } = mapWith([2]);
    const debug = new WmoDebug();
    const originals = meshes.map((m) => m.material);

    debug.sync(map);

    expect(meshes.map((m) => m.material)).toEqual(originals);
    expect(debug.overridden).toBe(0);
  });

  it('overrides every group mesh across every placed WMO', () => {
    const { map, meshes } = mapWith([2, 3, 1]);
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.VertexColor;

    debug.sync(map);

    expect(debug.overridden).toBe(6);
    for (const mesh of meshes) {
      expect(mesh.material.isMeshBasicMaterial).toBe(true);
      expect(mesh.material.vertexColors).toBe(true);
    }
  });

  it('reads MOCV through three own shader, with no fog and both sides', () => {
    // The point of the mode: nothing of ours in the path -- no combiner, no light term, no `mocv * 2`.
    const { map, meshes } = mapWith([1]);
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.VertexColor;

    debug.sync(map);

    expect(meshes[0].material.fog).toBe(false);
    expect(meshes[0].material.side).toBe(2); // THREE.DoubleSide
  });

  it('flat mode ignores MOCV as well as the texture', () => {
    const { map, meshes } = mapWith([1]);
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.Flat;

    debug.sync(map);

    expect(meshes[0].material.vertexColors).toBe(false);
    expect(meshes[0].material.color.getHex()).toBe(0xffffff);
  });

  it('shares one material across every group rather than one each', () => {
    const { map, meshes } = mapWith([3]);
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.VertexColor;

    debug.sync(map);

    expect(meshes[0].material).toBe(meshes[1].material);
    expect(meshes[1].material).toBe(meshes[2].material);
  });

  it('restores the exact original material when switched off', () => {
    const { map, meshes } = mapWith([2]);
    const debug = new WmoDebug();
    const originals = meshes.map((m) => m.material);
    debug.mode = WmoDebugMode.VertexColor;
    debug.sync(map);

    debug.mode = WmoDebugMode.Off;
    debug.sync(map);

    expect(meshes.map((m) => m.material)).toEqual(originals);
    expect(debug.overridden).toBe(0);
  });

  it('does not stack overrides when synced every frame', () => {
    const { map, meshes } = mapWith([1]);
    const debug = new WmoDebug();
    const original = meshes[0].material;
    debug.mode = WmoDebugMode.VertexColor;

    debug.sync(map);
    debug.sync(map);
    debug.sync(map);
    debug.mode = WmoDebugMode.Off;
    debug.sync(map);

    expect(meshes[0].material).toBe(original);
  });

  it('keeps the original across a mode switch, not the previous override', () => {
    const { map, meshes } = mapWith([1]);
    const debug = new WmoDebug();
    const original = meshes[0].material;

    debug.mode = WmoDebugMode.VertexColor;
    debug.sync(map);
    debug.mode = WmoDebugMode.Flat;
    debug.sync(map);
    debug.mode = WmoDebugMode.Off;
    debug.sync(map);

    expect(meshes[0].material).toBe(original);
  });

  it('picks up a group that streamed in after the mode was set', () => {
    const { map, meshes } = mapWith([1]);
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.VertexColor;
    debug.sync(map);

    const late = { material: { name: 'late' }, geometry: {} };
    (map.wmoManager.entries as any).forEach((wmo: any) => wmo.views.groups.set(99, { mesh: late }));
    debug.sync(map);

    expect(debug.overridden).toBe(2);
    expect(late.material).not.toEqual({ name: 'late' });
    expect(meshes).toHaveLength(1);
  });

  it('survives a map with no wmoManager, and a null map', () => {
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.VertexColor;

    expect(() => debug.sync(null)).not.toThrow();
    expect(() => debug.sync({} as any)).not.toThrow();
    expect(debug.overridden).toBe(0);
  });

  it('skips a group view carrying no mesh yet', () => {
    const groups = new Map<number, any>([[0, { mesh: null }], [1, {}]]);
    const map = { wmoManager: { entries: { forEach: (fn: any) => fn({ views: { groups } }) } } };
    const debug = new WmoDebug();
    debug.mode = WmoDebugMode.Flat;

    expect(() => debug.sync(map)).not.toThrow();
    expect(debug.overridden).toBe(0);
  });
});
