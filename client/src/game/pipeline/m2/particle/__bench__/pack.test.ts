/**
 * @jest-environment node
 */
/**
 * THE CPU HALF of the particle cost, and what this bench CANNOT tell you.
 *
 * The owner's frame is 47.8 ms p50 with **gpuMs 20.81** at only 771 calls and 64k triangles. That
 * geometry cannot cost 20.8 ms, so the GPU half is FILL RATE -- pixels shaded, not vertices. **This
 * bench does not measure fill.** Nothing running in node can: there is no rasteriser here. It bounds
 * the CPU half only, and the two must not be conflated.
 *
 * IT ALSO SHOWS WHY THE 2x EXTENT IS NOT A CPU QUESTION: `pack` writes the same fifteen floats per
 * particle whatever the sprite's size is, so `HALF_SIZE_TO_EXTENT` cannot appear in these numbers at
 * all. Its whole cost is area on screen -- fill goes as the square of the extent, so doubling it is
 * ~4x the pixels per particle, and that lands entirely in `gpuMs`.
 *
 * What IS measured: `pack` per emitter per frame against the live-particle count, plus the fixed
 * per-emitter overhead at zero live particles. Multiply by the population his `liveByEmitter()`
 * paste reports and the CPU half is bounded rather than estimated.
 */
import * as THREE from 'three';

import { ParticleBatch } from '../batch';
import { ParticlePool } from '../pool';

const stubMaterial: any = new THREE.MeshBasicMaterial();

const definition = {
  colorTrack: { keys: [{ time: 0, value: { x: 255, y: 128, z: 0 } }] },
  alphaTrack: { keys: [{ time: 0, value: 32767 }] },
  scaleTrack: { keys: [{ time: 0, value: [0.2, 0.2] }, { time: 1, value: [0.4, 0.4] }] },
  headUVAnim: { keys: [{ time: 0, value: 0 }] },
  scaleVary: [0, 0],
};

const fill = (capacity: number, live: number) => {
  const pool = new ParticlePool(capacity);
  for (let i = 0; i < live; i += 1) {
    const slot = pool.allocate();
    if (slot === null || slot === undefined || slot < 0) break;
    pool.position.set([i * 0.1, i * 0.2, i * 0.3], slot * 3);
    pool.lifespan[slot] = 10;
    pool.age[slot] = 5;
    pool.spin[slot] = 0.5;
  }
  return pool;
};

const RUNS = 15;
const CALLS = 2000;

const timePack = (batch: ParticleBatch, pool: ParticlePool, world: THREE.Matrix4) => {
  for (let i = 0; i < CALLS; i += 1) batch.pack(pool, definition, world, 1, true);
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < CALLS; i += 1) batch.pack(pool, definition, world, 1, true);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6 / CALLS);
  }
  samples.sort((a, b) => a - b);
  return samples;
};

describe('ParticleBatch#pack cost', () => {
  it('prices pack per emitter against the live-particle count', () => {
    const world = new THREE.Matrix4().makeTranslation(10, 20, 30);
    const lines: string[] = [];
    for (const live of [0, 8, 32, 128, 512]) {
      const pool = fill(512, live);
      const batch = new ParticleBatch(stubMaterial, 512, 1, 1);
      const s = timePack(batch, pool, world);
      const median = s[(RUNS - 1) >> 1];
      lines.push(`   live=${String(live).padStart(3)}  median=${median.toFixed(5)}ms`
        + `  min=${s[0].toFixed(5)}  max=${s[RUNS - 1].toFixed(5)}`
        + (live > 0 ? `  perParticle=${((median / live) * 1000).toFixed(3)}us` : '  (fixed overhead)'));
    }
    // eslint-disable-next-line no-console
    console.log(['ParticleBatch#pack, ' + String(CALLS) + ' calls x ' + String(RUNS) + ' runs',
      ...lines,
      'NOTE: extent/HALF_SIZE_TO_EXTENT cannot appear here -- pack writes the same floats either way.',
      'The 2x is a FILL cost (area, so ~4x pixels) and lands entirely in gpuMs.',
    ].join(String.fromCharCode(10)));
    expect(lines.length).toBe(5);
  }, 120000);
});

/**
 * THE CULLED WALK. His paste reads `emitters 2255, culled 2234, inRange 21` -- so `animate` walks
 * 2255 entries every frame to reject 2234 of them, and nothing had priced the rejection.
 *
 * This times the cull path's arithmetic per entry, exactly as `animate` performs it: the world
 * position read off `matrixWorld`, the squared camera distance (no sqrt -- `distanceToSquared`), the
 * two instrument writes added in `e954534`, the compare, and the two property writes a culled entry
 * makes. It does NOT run `ParticleManager.animate` itself, and says so rather than implying it: the
 * method needs a registered instance per entry, which needs a decoded model per entry. What is under
 * test is the per-entry cost, which is the quantity the lever depends on.
 */
describe('the culled-entry walk', () => {
  it('prices rejecting an out-of-range emitter, at his population', () => {
    const N = 2234;
    const entries = [] as Array<{
      instance: { matrixWorld: THREE.Matrix4 };
      liveCount: number;
      culled: boolean;
      distSq: number;
      framesSinceLive: number;
      geometry: { instanceCount: number };
      visible: boolean;
    }>;
    for (let i = 0; i < N; i += 1) {
      const m = new THREE.Matrix4().makeTranslation(300 + i * 0.1, 400 + i * 0.1, 50);
      entries.push({
        instance: { matrixWorld: m },
        liveCount: 0,
        culled: true,
        distSq: -1,
        framesSinceLive: 0,
        geometry: { instanceCount: 0 },
        visible: false,
      });
    }
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 0);
    const scratch = new THREE.Vector3();
    const cullSq = 120 * 120;

    const walk = () => {
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        scratch.setFromMatrixPosition(entry.instance.matrixWorld);
        const d = camera.position.distanceToSquared(scratch);
        entry.distSq = d;
        if (entry.liveCount > 0) {
          entry.framesSinceLive = 0;
        } else {
          entry.framesSinceLive += 1;
        }
        if (d > cullSq) {
          entry.geometry.instanceCount = 0;
          entry.visible = false;
          continue;
        }
      }
    };

    const RUNS2 = 15;
    const WALKS = 400;
    for (let i = 0; i < WALKS; i += 1) walk();
    const samples: number[] = [];
    for (let run = 0; run < RUNS2; run += 1) {
      const start = process.hrtime.bigint();
      for (let i = 0; i < WALKS; i += 1) walk();
      samples.push(Number(process.hrtime.bigint() - start) / 1e6 / WALKS);
    }
    samples.sort((a, b) => a - b);
    const median = samples[(RUNS2 - 1) >> 1];
    // eslint-disable-next-line no-console
    console.log([
      `culled walk over ${N} entries: median=${median.toFixed(5)}ms`
        + ` min=${samples[0].toFixed(5)} max=${samples[RUNS2 - 1].toFixed(5)}`,
      `  per entry = ${((median / N) * 1000).toFixed(4)}us`,
      `  at 60 fps that is ${(median * 60).toFixed(3)} ms/sec of frame time`,
    ].join(String.fromCharCode(10)));
    expect(median).toBeGreaterThan(0);
  }, 120000);
});
