/**
 * @jest-environment node
 */
import { integratePool } from '../integrate';
import { ParticlePool } from '../pool';

const noForces = { gravity: 0, drag: 0 };

const place = (pool: ParticlePool, position: number[], velocity: number[], lifespan: number) => {
  const slot = pool.allocate();
  pool.position.set(position, slot * 3);
  pool.velocity.set(velocity, slot * 3);
  pool.lifespan[slot] = lifespan;
  pool.age[slot] = 0;
  return slot;
};

describe('integratePool', () => {
  it('advances position by velocity times dt', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [2, 0, 0], 10);

    integratePool(pool, 0.5, noForces);

    expect(pool.position[slot * 3]).toBeCloseTo(1, 5);
  });

  it('accumulates age and frees particles at their lifespan', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 1);

    expect(integratePool(pool, 0.5, noForces)).toBe(0);
    expect(pool.liveCount).toBe(1);
    expect(pool.age[slot]).toBeCloseTo(0.5, 5);

    expect(integratePool(pool, 0.6, noForces)).toBe(1);
    expect(pool.liveCount).toBe(0);
  });

  it('applies gravity along -Z', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 10);

    integratePool(pool, 1, { gravity: 9.8, drag: 0 });

    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(-9.8, 4);
    expect(pool.position[slot * 3 + 2]).toBeCloseTo(-9.8, 4);
  });

  it('decays speed exponentially under drag', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [10, 0, 0], 10);

    integratePool(pool, 1, { gravity: 0, drag: 1 });

    expect(pool.velocity[slot * 3]).toBeCloseTo(10 * Math.exp(-1), 4);
  });

  it('leaves velocity untouched when drag is zero', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [10, 0, 0], 10);

    integratePool(pool, 1, noForces);

    expect(pool.velocity[slot * 3]).toBeCloseTo(10, 5);
  });

  it('advances spin by spinSpeed', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 10);
    pool.spin[slot] = 0;
    pool.spinSpeed[slot] = 2;

    integratePool(pool, 0.5, noForces);

    expect(pool.spin[slot]).toBeCloseTo(1, 5);
  });

  it('frees a particle whose lifespan is zero on the first step', () => {
    const pool = new ParticlePool(4);
    place(pool, [0, 0, 0], [0, 0, 0], 0);

    expect(integratePool(pool, 0.016, noForces)).toBe(1);
    expect(pool.liveCount).toBe(0);
  });

  it('does nothing and frees nothing on an empty pool', () => {
    const pool = new ParticlePool(4);

    expect(integratePool(pool, 0.5, noForces)).toBe(0);
  });
});
