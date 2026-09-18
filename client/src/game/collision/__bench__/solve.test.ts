/**
 * @jest-environment node
 */
/**
 * **IS THE MOVER'S COST PER-CANDIDATE OR FIXED PER CAST?** One bench arm decides it.
 *
 * The owner's phase split, 2060 frames standing still: `depenetrate` 1698 us, `classify` 1586 us,
 * `groundedStep` 1055 us -- and only **36 candidates per frame across 4 gathers**, i.e. about a
 * dozen per cast. The gather is 44.5 us and the residual is 9.6 us, so the split accounts for
 * everything and the three collision phases ARE the mover.
 *
 * A dozen candidates against ~1.5 ms per phase is ~125 us per candidate. A capsule-triangle solve
 * cannot cost that, so either the solve is doing something wildly more expensive than it looks, or
 * the cost is FIXED per cast and the candidate count is irrelevant. Those have different fixes.
 *
 * WHAT THIS MEASURES: `castCapsuleAgainstTriangles` alone -- no gather, no provider -- at 12, 120
 * and 1200 triangles. Flat means fixed; linear means per-candidate. Counts and a mean over many
 * iterations, never a single timing, because `performance.now()` quantisation is what produced the
 * 0-or-100 artefact one round ago.
 *
 * WHAT IT CANNOT TELL YOU: his absolute milliseconds. Node, different JIT, different machine -- the
 * SLOPE is the finding, not the constant. That lesson is already recorded in `gather.test.ts` after
 * an extrapolation from it was withdrawn.
 */
import * as THREE from 'three';

import { castCapsuleAgainstTriangles } from '../capsule-cast';
import { Triangle } from '../types';

/** A flat floor triangle at `z = 0`, tiled so `n` of them cover a strip under the capsule. */
function floorTriangles(n: number): Triangle[] {
  const out: Triangle[] = [];
  for (let i = 0; i < n; ++i) {
    const x = (i % 40) * 2 - 40;
    const y = Math.floor(i / 40) * 2 - 10;
    const a = new THREE.Vector3(x, y, 0);
    const b = new THREE.Vector3(x + 2, y, 0);
    const c = new THREE.Vector3(x, y + 2, 0);
    out.push({
      a, b, c,
      normal: new THREE.Vector3(0, 0, 1),
      source: null as never,
    } as unknown as Triangle);
  }
  return out;
}

/** Mean microseconds per call over `runs` medians of `iters` calls. */
function meanUs(runs: number, iters: number, fn: () => void): number {
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

it('the solve is linear in candidates and cheap per candidate', () => {
  const from = new THREE.Vector3(0, 0, 1.5);
  const down = new THREE.Vector3(0, 0, -1);
  const run = (tris: Triangle[]) => () => {
    castCapsuleAgainstTriangles(from, down, 2, 0.4, 0.5, tris, 0, -Infinity);
  };

  const sets = [12, 120, 1200].map((n) => ({ n, tris: floorTriangles(n) }));
  // Warm every shape before timing any of them.
  for (const { tris } of sets) {
    for (let i = 0; i < 2000; ++i) run(tris)();
  }

  const timed = sets.map(({ n, tris }) => ({ n, us: meanUs(7, 3000, run(tris)) }));
  for (const { n, us } of timed) {
    // eslint-disable-next-line no-console
    console.log(`[solve] ${n} triangles -> ${us.toFixed(3)} us  (${(us * 1000 / n).toFixed(1)} ns each)`);
  }

  const [small, , large] = timed;
  const perTriangleNs = ((large.us - small.us) * 1000) / (large.n - small.n);
  // eslint-disable-next-line no-console
  console.log(`[solve] marginal cost ${perTriangleNs.toFixed(1)} ns per triangle`);

  // THE CLAIM: a solve costs tens of nanoseconds per triangle, so a DOZEN of them cannot be the
  // 1.5 ms the owner's phases report. If this ever exceeds a microsecond each, the solve really is
  // the cost and the diagnosis flips.
  expect(perTriangleNs).toBeLessThan(1000);
  // And it IS linear -- 100x the triangles costs materially more, so the loop is the work here.
  expect(large.us).toBeGreaterThan(small.us * 5);
});
