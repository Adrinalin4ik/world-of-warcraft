import { EMITTER_TYPE } from '../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from './pool';

/**
 * Initial state for one particle, in the emitter's local space.
 *
 * The width and length fields mean different things per generator, which is a genuine quirk of the
 * format rather than a naming slip:
 *
 *   plane  -- areaWidth and areaLength are the emission rectangle's dimensions, and verticalRange /
 *             horizontalRange bound the initial *velocity* direction. Zero polar angle sends velocity
 *             straight up (+Z).
 *   sphere -- areaWidth is the maximum radius and areaLength the minimum, and the ranges bound the
 *             initial *position* on the shell instead.
 *
 * `random` is injected rather than calling Math.random directly so that spawn distributions are
 * testable.
 */
export interface SpawnParams {
  emitterType: number;
  areaWidth: number;
  areaLength: number;
  verticalRange: number;
  horizontalRange: number;
  speed: number;
  speedVariation: number;
  lifespan: number;
  baseSpin: number;
  spinSpeed: number;
}

const spawnPlane = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  const base = slot * 3;

  pool.position[base] = (random() - 0.5) * params.areaWidth;
  pool.position[base + 1] = (random() - 0.5) * params.areaLength;
  pool.position[base + 2] = 0;

  const polar = params.verticalRange * random();
  const azimuth = params.horizontalRange * (random() - 0.5) * 2;

  const sinPolar = Math.sin(polar);

  pool.velocity[base] = sinPolar * Math.cos(azimuth);
  pool.velocity[base + 1] = sinPolar * Math.sin(azimuth);
  pool.velocity[base + 2] = Math.cos(polar);
};

const spawnSphere = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  const base = slot * 3;

  const maxRadius = params.areaWidth;
  const minRadius = params.areaLength;
  const radius = minRadius + (maxRadius - minRadius) * random();

  const polar = params.verticalRange * random();
  const azimuth = params.horizontalRange * random();

  const sinPolar = Math.sin(polar);
  const dirX = sinPolar * Math.cos(azimuth);
  const dirY = sinPolar * Math.sin(azimuth);
  const dirZ = Math.cos(polar);

  pool.position[base] = dirX * radius;
  pool.position[base + 1] = dirY * radius;
  pool.position[base + 2] = dirZ * radius;

  // Emitted outward along the shell normal.
  pool.velocity[base] = dirX;
  pool.velocity[base + 1] = dirY;
  pool.velocity[base + 2] = dirZ;
};

const spawnPoint = (pool: ParticlePool, slot: number) => {
  const base = slot * 3;

  pool.position[base] = 0;
  pool.position[base + 1] = 0;
  pool.position[base + 2] = 0;

  pool.velocity[base] = 0;
  pool.velocity[base + 1] = 0;
  pool.velocity[base + 2] = 1;
};

export const spawnParticle = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  switch (params.emitterType) {
    case EMITTER_TYPE.PLANE:
      spawnPlane(pool, slot, params, random);
      break;

    case EMITTER_TYPE.SPHERE:
      spawnSphere(pool, slot, params, random);
      break;

    default:
      // Spline and bone generators are Phase 2b+. A point spawn keeps them harmless meanwhile rather
      // than leaving position and velocity holding whatever the previous occupant of the slot left.
      spawnPoint(pool, slot);
      break;
  }

  // The direction written above is a unit vector; scale it to the emission speed.
  const variation = 1 + params.speedVariation * (random() * 2 - 1);
  const speed = params.speed * variation;
  const base = slot * 3;

  pool.velocity[base] *= speed;
  pool.velocity[base + 1] *= speed;
  pool.velocity[base + 2] *= speed;

  pool.age[slot] = 0;
  pool.lifespan[slot] = params.lifespan;
  pool.seed[slot] = random();
  pool.spin[slot] = params.baseSpin;
  pool.spinSpeed[slot] = params.spinSpeed;
};
