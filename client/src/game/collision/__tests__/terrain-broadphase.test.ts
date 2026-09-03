/** @jest-environment node */
/**
 * **THE BROADPHASE RETURNS EXACTLY WHAT THE ALL-CHUNKS WALK RETURNED.**
 *
 * `TerrainProvider.gather` now rejects a chunk on a cached world AABB before paying `gatherChunk`'s
 * matrix inversion. That is a performance change in the one code path where a wrong answer means
 * falling through the world -- and this project's record is that five of six fixes in this area
 * taken from interpreting a symptom had to be reverted, while the one that stuck came from an
 * offline reproduction.
 *
 * So this is that reproduction, and it asserts the only thing worth asserting: over a spread of
 * query boxes -- inside a chunk, straddling two, in the gap between, far away, and one enormous box
 * covering everything -- the gathered triangles are IDENTICAL to what a brute-force walk over every
 * chunk produces. Identical in count and in vertex values, not merely in count.
 */
import * as THREE from 'three';

import { TerrainProvider, TERRAIN_CELL_SIZE } from '../terrain-provider';
import { Triangle } from '../types';

const ROW_STRIDE = 17;
const CELL = TERRAIN_CELL_SIZE;
const SPAN = 8 * CELL;

/** One MCVT chunk at `(ox, oy)`, with a height that varies so the AABB has real Z extent. */
function chunkAt(ox: number, oy: number, height: (lx: number, ly: number) => number) {
  const positions = new Float32Array(145 * 3);
  const put = (i: number, lx: number, ly: number) => {
    positions[i * 3] = lx;
    positions[i * 3 + 1] = ly;
    positions[i * 3 + 2] = height(-lx, -ly);
  };
  for (let row = 0; row <= 8; ++row) {
    for (let col = 0; col <= 8; ++col) {
      put(row * ROW_STRIDE + col, -row * CELL, -col * CELL);
    }
    if (row < 8) {
      for (let col = 0; col < 8; ++col) {
        put(9 + row * ROW_STRIDE + col, -(row + 0.5) * CELL, -(col + 0.5) * CELL);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return {
    geometry,
    matrixWorld: new THREE.Matrix4()
      .makeTranslation(ox, oy, 0)
      .multiply(new THREE.Matrix4().makeScale(-1, -1, 1)),
    isHole: () => false,
  };
}

/** A stable fingerprint of a gather's output, so "identical" means the triangles and not the count. */
function fingerprint(tris: Triangle[]): string {
  return tris
    .map((t) => [t.a, t.b, t.c]
      .map((v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`)
      .join('|'))
    .sort()
    .join(';');
}

/** The reference: what `gather` did before the broadphase -- every chunk, no rejection. */
function bruteForce(provider: TerrainProvider, chunks: any[], box: THREE.Box3): Triangle[] {
  const out: Triangle[] = [];
  for (const chunk of chunks) {
    (provider as any).gatherChunk(chunk, box, out);
  }
  return out;
}

it('gathers identically to the all-chunks walk over every box shape', () => {
  const provider = new TerrainProvider();
  const chunks = [
    chunkAt(0, 0, (x, y) => x * 0.1 + y * 0.05),
    chunkAt(SPAN, 0, (x) => 5 + x * 0.2),
    chunkAt(0, SPAN, (_x, y) => -3 - y * 0.1),
    chunkAt(SPAN, SPAN, () => 12),
    chunkAt(SPAN * 6, SPAN * 6, () => 0),
  ];
  for (const c of chunks) {
    provider.add(c);
  }

  const at = (x: number, y: number, z: number, r: number) => new THREE.Box3(
    new THREE.Vector3(x - r, y - r, z - r),
    new THREE.Vector3(x + r, y + r, z + r),
  );

  const boxes: Array<[string, THREE.Box3]> = [
    ['inside one chunk', at(SPAN * 0.5, SPAN * 0.5, 2, 2)],
    ['straddling two', at(SPAN, SPAN * 0.5, 5, 3)],
    ['the four-corner join', at(SPAN, SPAN, 4, 4)],
    ['far from everything', at(SPAN * 3, SPAN * 3, 0, 2)],
    ['beyond the last chunk', at(SPAN * 20, SPAN * 20, 0, 5)],
    ['Z below every surface', at(SPAN * 0.5, SPAN * 0.5, -500, 2)],
    ['covering all of them', at(SPAN * 3, SPAN * 3, 0, SPAN * 10)],
  ];

  for (const [name, box] of boxes) {
    const viaBroadphase: Triangle[] = [];
    provider.gather(box, viaBroadphase);
    const viaWalk = bruteForce(provider, chunks, box);
    expect(`${name}: ${fingerprint(viaBroadphase)}`).toBe(`${name}: ${fingerprint(viaWalk)}`);
  }

  // And the broadphase is actually rejecting -- otherwise this test would pass on a no-op.
  const tiny: Triangle[] = [];
  provider.gather(at(SPAN * 0.5, SPAN * 0.5, 2, 1), tiny);
  expect(tiny.length).toBeGreaterThan(0);
  const away: Triangle[] = [];
  provider.gather(at(SPAN * 20, SPAN * 20, 0, 1), away);
  expect(away.length).toBe(0);
});

it('recomputes the cached bounds when a chunk is moved', () => {
  // The cache is keyed on the placement, because `gather` has always re-read `matrixWorld` per call.
  // A chunk that moves must not keep answering from its old box.
  const provider = new TerrainProvider();
  const chunk = chunkAt(0, 0, () => 0);
  provider.add(chunk);

  const box = new THREE.Box3(
    new THREE.Vector3(SPAN * 10 - 2, -2, -2),
    new THREE.Vector3(SPAN * 10 + 2, 2, 2),
  );
  const before: Triangle[] = [];
  provider.gather(box, before);
  expect(before.length).toBe(0);

  chunk.matrixWorld = new THREE.Matrix4()
    .makeTranslation(SPAN * 10, 0, 0)
    .multiply(new THREE.Matrix4().makeScale(-1, -1, 1));

  const after: Triangle[] = [];
  provider.gather(box, after);
  expect(after.length).toBeGreaterThan(0);
});
