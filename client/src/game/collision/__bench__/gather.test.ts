/**
 * @jest-environment node
 */
/**
 * **WHAT A COLLISION GATHER COSTS WHEN IT RETURNS ALMOST NOTHING.**
 *
 * The owner is at `ctl.move` 4.7 ms standing still with a measured **69 candidates per frame**
 * (`window.castCensus()`: 3 casts + 1 push-out, `perCast.total` 21.7). The cost model written into
 * `collision-world.ts` assumes ~3000 candidate-solves for 3.8 ms -- about 1.3 us per solve -- so 69
 * solves cannot be 4.7 ms and the cost is NOT in the sweep. This bench prices the part that does not
 * depend on the candidate count at all.
 *
 * WHAT IT MEASURES: `TerrainProvider.gather` against a box that overlaps exactly ONE chunk, with the
 * number of REGISTERED chunks varied. Candidates returned are held constant, so everything the curve
 * shows is fixed per-chunk overhead.
 *
 * **IT MEASURED A REAL PER-CHUNK COST THAT TURNED OUT NOT TO MATTER.** The first run found 8.4 us
 * per registered chunk the query never touches, and `TerrainProvider.gather` now rejects on a cached
 * AABB first -- the assertion below is inverted accordingly. But the owner's controlled A/B then
 * showed the change buys nothing measurable: 4 gathers a frame is **0.4 ms of a 4.6 ms `ctl.move`**,
 * and turning the rejection off did not move the section. **So this bench's number does not scale to
 * his frame** -- the per-frame figure the log line prints is illustrative of THIS machine at THIS
 * chunk count only, and an earlier extrapolation of it to ~2.7 ms was unsound and is withdrawn. Kept
 * as a regression guard on the per-chunk work, not as evidence of a saving.
 *
 * WHAT IT CANNOT TELL YOU: the owner's absolute milliseconds. This is node on a different machine
 * with a different JIT, so the NUMBER is not his -- the SHAPE is. If the cost grows linearly in
 * registered chunks while candidates stay fixed, that is a structural finding and it transfers; the
 * per-chunk constant does not.
 */
import * as THREE from 'three';

import { TerrainProvider, TERRAIN_CELL_SIZE } from '../terrain-provider';
import { Triangle } from '../types';

const ROW_STRIDE = 17;
const CELL = TERRAIN_CELL_SIZE;

/** One MCVT chunk's 145 vertices, placed at `(ox, oy)` with a flat height. */
function chunkAt(ox: number, oy: number) {
  const positions = new Float32Array(145 * 3);
  const put = (i: number, lx: number, ly: number) => {
    positions[i * 3] = lx;
    positions[i * 3 + 1] = ly;
    positions[i * 3 + 2] = 0;
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
    // The mirror the real chunks carry (`gatherChunk` indexes off `-local.x`), plus a placement.
    matrixWorld: new THREE.Matrix4()
      .makeTranslation(ox, oy, 0)
      .multiply(new THREE.Matrix4().makeScale(-1, -1, 1)),
    isHole: () => false,
  };
}

/** Median of `runs` timings of `fn` repeated `iters` times, in microseconds per call. */
function medianUs(runs: number, iters: number, fn: () => void): number {
  const samples: number[] = [];
  for (let r = 0; r < runs; ++r) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; ++i) {
      fn();
    }
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1000 / iters);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/**
 * A provider holding `n` chunks laid out in a row, and a box over the FIRST one -- so the candidates
 * returned are the same however many chunks are registered.
 */
function providerWith(n: number) {
  const provider = new TerrainProvider();
  for (let i = 0; i < n; ++i) {
    provider.add(chunkAt(i * 40, 0));
  }
  const box = new THREE.Box3(
    new THREE.Vector3(-2, -2, -2),
    new THREE.Vector3(2, 2, 2),
  );
  return { provider, box };
}

it('gather cost is FLAT in registered chunks the query does not touch', () => {
  const out: Triangle[] = [];
  const gather = (p: TerrainProvider, box: THREE.Box3) => {
    out.length = 0;
    p.gather(box, out);
  };

  // Warm the JIT on both shapes before timing either.
  for (const n of [1, 64]) {
    const { provider, box } = providerWith(n);
    for (let i = 0; i < 500; ++i) gather(provider, box);
  }

  const one = providerWith(1);
  const many = providerWith(64);

  // The candidate count MUST be identical, or the comparison measures the sweep instead.
  const outOne: Triangle[] = [];
  one.provider.gather(one.box, outOne);
  const outMany: Triangle[] = [];
  many.provider.gather(many.box, outMany);
  expect(outMany.length).toBe(outOne.length);

  const usOne = medianUs(7, 2000, () => gather(one.provider, one.box));
  const usMany = medianUs(7, 2000, () => gather(many.provider, many.box));
  const perChunkUs = (usMany - usOne) / 63;

  // eslint-disable-next-line no-console
  console.log(
    `[gather] candidates ${outOne.length} | 1 chunk ${usOne.toFixed(2)} us`
    + ` | 64 chunks ${usMany.toFixed(2)} us | per idle chunk ${perChunkUs.toFixed(3)} us`
    // Illustrative of THIS machine only -- the live A/B put the gather at ~0.4 ms of the
    // owner's frame whatever this prints. See the header.
    + ` | (this machine: 4 gathers x 65 chunks = ${(perChunkUs * 65 * 4 / 1000).toFixed(2)} ms/frame)`,
  );

  // **THE ASSERTION IS THE INVERSE OF THE ONE THIS BENCH SHIPPED WITH, and the flip is the record.**
  // It first asserted `usMany > usOne * 2` -- that idle chunks DID cost -- and said a failure would
  // mean "the provider grew a broadphase ... which is the outcome to want". It grew one, the
  // assertion failed, and this is that outcome written down.
  //
  // Measured on this machine, same 4 candidates in both arms:
  //
  //     before the broadphase   1 chunk 10.63 us | 64 chunks 539.58 us | 8.4 us   per idle chunk
  //     after                   1 chunk 10.42 us | 64 chunks  10.86 us | 0.007 us per idle chunk
  //
  // A ~50x cut on the 64-chunk arm, and the per-idle-chunk term is gone -- 8.4 us to 7 ns.
  //
  // `* 2` rather than something tight: this is a wall-clock median on a shared machine and the
  // one-chunk arm is ~10 us, so a threshold near 1.0 would flake. Two times still fails loudly if
  // the per-chunk matrix inversion ever comes back, which is the only regression this can see.
  expect(usMany).toBeLessThan(usOne * 2);
});
