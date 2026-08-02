/**
 * jsdom, not node: importing the map pulls in the doodad manager and through it the M2 pipeline,
 * whose cache manager probes `window.indexedDB` at module load. jsdom has no IndexedDB, which is
 * the case that module already handles by logging and returning.
 *
 * @jest-environment jsdom
 */
import WorldMap from '../map';

/**
 * A WorldMap with only the fields `unload`/`unloadChunkByIndex` touch.
 *
 * `Object.create` rather than `new`: the real constructor builds five managers, a MaterialRegistry,
 * a MapLight and a particle group, and reads DBC data -- none of which a teardown test needs, and
 * all of which would drag a network fetch into it.
 */
function mapWithChunks(indices) {
  const map = Object.create(WorldMap.prototype);

  const calls = { terrain: [], doodad: [], wmo: [] };

  map.terrainManager = { unloadChunk: (i) => calls.terrain.push(i) };
  map.doodadManager = { unloadChunk: (i) => calls.doodad.push(i) };
  map.wmoManager = { unloadChunk: (i) => calls.wmo.push(i) };

  map.chunks = new Map(indices.map((i) => [i, { doodadEntries: [], wmoEntries: [] }]));
  map.queuedChunks = new Map(indices.map((i) => [i, Promise.resolve()]));
  map.unloaded = false;

  return { map, calls };
}

describe('WorldMap#unload', () => {
  it('unloads every loaded chunk through the three managers', () => {
    // The whole point: a zone change used to drop the map reference and nothing else, so the
    // collision world kept every terrain chunk, WMO collider and M2 hull of every zone visited.
    const { map, calls } = mapWithChunks([1, 2, 3]);

    map.unload();

    expect(calls.terrain).toEqual([1, 2, 3]);
    expect(calls.doodad).toEqual([1, 2, 3]);
    expect(calls.wmo).toEqual([1, 2, 3]);
    expect(map.chunks.size).toBe(0);
  });

  it('walks a snapshot, since unloading deletes from the map being walked', () => {
    const { map, calls } = mapWithChunks([10, 20, 30, 40, 50]);

    map.unload();

    expect(calls.terrain).toHaveLength(5);
  });

  it('drops the queued-chunk records', () => {
    const { map } = mapWithChunks([1, 2]);

    map.unload();

    expect(map.queuedChunks.size).toBe(0);
  });

  it('is idempotent', () => {
    const { map, calls } = mapWithChunks([7]);

    map.unload();
    map.unload();

    expect(calls.terrain).toEqual([7]);
  });

  it('latches `unloaded`, so a chunk still in flight cannot re-register', () => {
    // `loadChunkByIndex`'s continuation checks this flag. Without it a chunk whose load resolves
    // after the zone change registers its terrain, WMO groups and doodad hulls with the collision
    // world just after everything else was taken back out -- a leak that survives the teardown.
    const { map } = mapWithChunks([1]);

    map.unload();

    expect(map.unloaded).toBe(true);
  });

  it('survives a map with nothing loaded', () => {
    const { map, calls } = mapWithChunks([]);

    expect(() => map.unload()).not.toThrow();
    expect(calls.terrain).toEqual([]);
  });
});
