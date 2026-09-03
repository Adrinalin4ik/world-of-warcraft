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
