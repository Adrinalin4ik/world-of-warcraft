import { ParticlePool } from './pool';

export interface Forces {
  gravity: number;
  drag: number;
  zSource: number;
}

/**
 * Step every live particle in a pool and free the expired ones.
 *
 * Order matters: forces adjust velocity, then velocity moves the particle. Doing it the other way
 * round makes the first frame of a particle's life ignore gravity entirely.
 *
 * @returns how many particles were freed this step
 */
export const integratePool = (pool: ParticlePool, dt: number, forces: Forces): number => {
  // exp() once per step rather than once per particle.
  const dragFactor = forces.drag > 0 ? Math.exp(-forces.drag * dt) : 1;
  const gravityStep = forces.gravity * dt;

  let freed = 0;

  pool.forEachLive((slot) => {
    pool.age[slot] += dt;

    if (pool.age[slot] >= pool.lifespan[slot]) {
      pool.free(slot);
      freed++;
      return;
    }

    const base = slot * 3;

    if (gravityStep !== 0) {
      pool.velocity[base + 2] -= gravityStep;
    }

    if (dragFactor !== 1) {
      pool.velocity[base] *= dragFactor;
      pool.velocity[base + 1] *= dragFactor;
      pool.velocity[base + 2] *= dragFactor;
    }

    if (forces.zSource > 0) {
      // Documented as: velocity is pushed along (particle.position - (0, 0, zSource)) normalised.
      const dx = pool.position[base];
      const dy = pool.position[base + 1];
      const dz = pool.position[base + 2] - forces.zSource;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length > 1e-6) {
        const scale = gravityStep !== 0 ? Math.abs(gravityStep) : dt;

        pool.velocity[base] += (dx / length) * scale;
        pool.velocity[base + 1] += (dy / length) * scale;
        pool.velocity[base + 2] += (dz / length) * scale;
      }
    }

    pool.position[base] += pool.velocity[base] * dt;
    pool.position[base + 1] += pool.velocity[base + 1] * dt;
    pool.position[base + 2] += pool.velocity[base + 2] * dt;

    pool.spin[slot] += pool.spinSpeed[slot] * dt;
  });

  return freed;
};
