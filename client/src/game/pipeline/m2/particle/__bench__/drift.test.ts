/** @jest-environment node */
/**
 * THE PRICE OF THE WORLD-FROZEN TRAIL.
 *
 * Two arms, because there are two populations and only one of them pays anything:
 *
 *  * A STATIC emitter -- every campfire, torch and brazier in the world -- has an exactly zero
 *    per-frame delta, so it reaches `driftPool`'s three-way compare and returns. That is the
 *    "unchanged path stays unchanged" claim, measured rather than asserted.
 *  * A MOVING emitter pays one pool walk with three subtractions per live particle, plus one
 *    `Matrix4#invert` and one `Matrix3` extraction per emitter per frame in the caller.
 *
 * Reported as a per-call median with min/max, and the round's report carries the noise floor. No
 * timing assertion -- a wall clock in a jest assertion is how this project has flattered itself
 * before.
 */
import { driftPool, followFraction } from '../integrate';
import { ParticlePool } from '../pool';

const CAPACITY = 512;
const RUNS = 15;
const CALLS = 2000;

const fullPool = () => {
  const pool = new ParticlePool(CAPACITY);
  for (let i = 0; i < CAPACITY; i += 1) {
    const slot = pool.allocate();
    if (slot === null || slot === undefined || slot < 0) break;
    pool.lifespan[slot] = 10;
    pool.age[slot] = 0;
  }
  return pool;
};

const time = (fn: () => void) => {
  for (let i = 0; i < CALLS; i += 1) fn();
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < CALLS; i += 1) fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6 / CALLS);
  }
  samples.sort((a, b) => a - b);
  return samples;
};

describe('driftPool cost', () => {
  it('prices the static early-out against a full moving pool', () => {
    const pool = fullPool();
    const live = pool.liveCount ?? CAPACITY;
    const moving = time(() => driftPool(pool, 0.004, 0.002, 0.001));
    const still = time(() => driftPool(pool, 0, 0, 0));
    // eslint-disable-next-line no-console
    console.log([
      `live particles = ${live} of ${CAPACITY}`,
      `MOVING emitter  median=${moving[7].toFixed(5)}ms  min=${moving[0].toFixed(5)}`
        + ` max=${moving[RUNS - 1].toFixed(5)}   (${CALLS} calls x ${RUNS} runs)`,
      `STATIC emitter  median=${still[7].toFixed(5)}ms  min=${still[0].toFixed(5)}`
        + ` max=${still[RUNS - 1].toFixed(5)}`,
    ].join('\n'));
    expect(live).toBeGreaterThan(0);
  }, 120000);

  it('gates the follow fraction on the flag, not on the authored line', () => {
    // Fireball's four emitters all author followSpeeds (2.5, 7) / followScales (0.7, 0.9) and all
    // four leave bit 0x4000 CLEAR. Reading the line without the flag gate would keep 70-90% of the
    // emitter's motion and leave almost no tail -- so this gate is load-bearing, not defensive.
    const fireball = {
      flags: 0x40009, followSpeed1: 2.5, followSpeed2: 7, followScale1: 0.7, followScale2: 0.9,
    };
    expect(followFraction(fireball, 24)).toBe(0);
    // The same emitter with the flag set does read the line, clamped into 0..1.
    const flagged = { ...fireball, flags: 0x40009 | 0x4000 };
    expect(followFraction(flagged, 24)).toBe(1);
    expect(followFraction(flagged, 2.5)).toBeCloseTo(0.7, 5);
    // Coincident speeds are the reference's "no follow response" and must not divide by zero.
    expect(followFraction({ ...flagged, followSpeed1: 0, followSpeed2: 0 }, 24)).toBe(0);
  });
});
