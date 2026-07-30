/**
 * @jest-environment node
 */
import { ParticlePool } from '../pool';

describe('ParticlePool', () => {
  it('allocates distinct slots up to capacity, then reports full', () => {
    const pool = new ParticlePool(3);
    const slots = [pool.allocate(), pool.allocate(), pool.allocate()];

    expect(new Set(slots).size).toBe(3);
    expect(slots.every((s) => s >= 0 && s < 3)).toBe(true);
    expect(pool.allocate()).toBe(-1);
    expect(pool.liveCount).toBe(3);
  });

  it('reuses a freed slot', () => {
    const pool = new ParticlePool(2);
    const first = pool.allocate();
    pool.allocate();

    pool.free(first);
    expect(pool.liveCount).toBe(1);

    expect(pool.allocate()).toBe(first);
    expect(pool.liveCount).toBe(2);
  });

  it('sizes position and velocity for three components per particle', () => {
    const pool = new ParticlePool(4);

    expect(pool.position.length).toBe(12);
    expect(pool.velocity.length).toBe(12);
    expect(pool.age.length).toBe(4);
    expect(pool.lifespan.length).toBe(4);
    expect(pool.seed.length).toBe(4);
    expect(pool.spin.length).toBe(4);
    expect(pool.spinSpeed.length).toBe(4);
  });

  it('visits exactly the live slots', () => {
    const pool = new ParticlePool(4);
    const a = pool.allocate();
    const b = pool.allocate();
    const c = pool.allocate();
    pool.free(b);

    const visited: number[] = [];
    pool.forEachLive((slot) => visited.push(slot));

    expect(visited.sort()).toEqual([a, c].sort());
  });

  it('does not visit anything when empty', () => {
    const pool = new ParticlePool(3);
    let count = 0;
    pool.forEachLive(() => count++);

    expect(count).toBe(0);
  });

  it('tolerates freeing a slot that is already free', () => {
    const pool = new ParticlePool(2);
    const slot = pool.allocate();

    pool.free(slot);
    pool.free(slot);

    expect(pool.liveCount).toBe(0);
    expect(pool.allocate()).toBe(slot);
    expect(pool.allocate()).toBeGreaterThanOrEqual(0);
    expect(pool.allocate()).toBe(-1);
  });

  it('clears live state on reset and hands out a usable slot afterwards', () => {
    // Per the documented contract, reset() only clears live state and the free list -- it does not
    // zero per-particle attribute arrays, because spawnParticle overwrites every one of them on
    // allocation. So the contract to test is: live count goes to zero, and a fresh allocate after
    // reset returns a usable slot (not -1), regardless of what stale data that slot still holds.
    const pool = new ParticlePool(2);
    const slot = pool.allocate();
    pool.age[slot] = 5;

    pool.reset();

    expect(pool.liveCount).toBe(0);

    const reallocated = pool.allocate();
    expect(reallocated).toBeGreaterThanOrEqual(0);
    expect(pool.liveCount).toBe(1);
  });
});
