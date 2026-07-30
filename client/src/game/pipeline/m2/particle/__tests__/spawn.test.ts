/**
 * @jest-environment node
 */
import { EMITTER_TYPE } from '../../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from '../pool';
import { spawnParticle } from '../spawn';

const baseParams = {
  emitterType: EMITTER_TYPE.PLANE,
  areaWidth: 4,
  areaLength: 6,
  verticalRange: 0,
  horizontalRange: 0,
  speed: 10,
  speedVariation: 0,
  lifespan: 2,
  baseSpin: 0,
  spinSpeed: 0,
};

// A deterministic stand-in for Math.random that cycles a fixed script.
const scriptedRandom = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

describe('spawnParticle — plane emitter', () => {
  it('places the particle inside the emission area', () => {
    const pool = new ParticlePool(64);

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, baseParams, Math.random);

      expect(Math.abs(pool.position[slot * 3])).toBeLessThanOrEqual(baseParams.areaWidth / 2 + 1e-6);
      expect(Math.abs(pool.position[slot * 3 + 1])).toBeLessThanOrEqual(baseParams.areaLength / 2 + 1e-6);
      expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it('sends velocity straight up when both ranges are zero', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.5]));

    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(baseParams.speed, 5);
  });

  it('keeps speed within the variation band', () => {
    const pool = new ParticlePool(64);
    const params = { ...baseParams, speedVariation: 0.5 };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const vx = pool.velocity[slot * 3];
      const vy = pool.velocity[slot * 3 + 1];
      const vz = pool.velocity[slot * 3 + 2];
      const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);

      expect(magnitude).toBeGreaterThanOrEqual(params.speed * 0.5 - 1e-4);
      expect(magnitude).toBeLessThanOrEqual(params.speed * 1.5 + 1e-4);
    }
  });

  it('tilts velocity off the axis when verticalRange is set', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...baseParams, verticalRange: Math.PI / 2 }, scriptedRandom([1, 0]));

    // Full polar angle with azimuth 0 lays the velocity into the XY plane.
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(0, 5);
  });
});

describe('spawnParticle — sphere emitter', () => {
  it('places the particle between the minimum and maximum radius', () => {
    const pool = new ParticlePool(64);
    const params = {
      ...baseParams,
      emitterType: EMITTER_TYPE.SPHERE,
      areaWidth: 10,
      areaLength: 4,
      verticalRange: Math.PI,
      horizontalRange: Math.PI * 2,
    };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const x = pool.position[slot * 3];
      const y = pool.position[slot * 3 + 1];
      const z = pool.position[slot * 3 + 2];
      const radius = Math.sqrt(x * x + y * y + z * z);

      expect(radius).toBeGreaterThanOrEqual(4 - 1e-4);
      expect(radius).toBeLessThanOrEqual(10 + 1e-4);
    }
  });
});

describe('spawnParticle — common state', () => {
  it('records lifespan, resets age, and seeds the particle', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();
    pool.age[slot] = 99;

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.25]));

    expect(pool.lifespan[slot]).toBeCloseTo(2, 5);
    expect(pool.age[slot]).toBe(0);
    expect(pool.seed[slot]).toBeGreaterThanOrEqual(0);
    expect(pool.seed[slot]).toBeLessThan(1);
  });

  it('carries baseSpin and spinSpeed through', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...baseParams, baseSpin: 1.5, spinSpeed: 3 }, scriptedRandom([0]));

    expect(pool.spin[slot]).toBeCloseTo(1.5, 5);
    expect(pool.spinSpeed[slot]).toBeCloseTo(3, 5);
  });

  it('spawns at the origin for spline and bone emitters rather than throwing', () => {
    const pool = new ParticlePool(4);

    for (const emitterType of [EMITTER_TYPE.SPLINE, EMITTER_TYPE.BONE]) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, { ...baseParams, emitterType }, scriptedRandom([0.5]));

      expect(pool.position[slot * 3]).toBeCloseTo(0, 6);
      expect(pool.position[slot * 3 + 1]).toBeCloseTo(0, 6);
      expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 6);
      expect(pool.lifespan[slot]).toBeCloseTo(2, 5);
    }
  });
});
