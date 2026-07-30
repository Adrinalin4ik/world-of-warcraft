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
  zSource: number;
  // The emitter's own offset, in model space, relative to its bone (bone binding itself is a later
  // phase -- see the module docs on RuntimeEmitter). Applied to the generator's local spawn position
  // before anything else reads it, including zSource below.
  originX: number;
  originY: number;
  originZ: number;
  /**
   * The emitter bone's transform in *model* space, column-major, as `THREE.Matrix4#elements` is.
   * Only the rotation part is read; the translation column is deliberately ignored.
   *
   * An M2Particle names its bone in `boneId`, and that bone is what orients the emitter. Without it
   * every emitter fires along model space's axes with an identity orientation -- unnoticeable on a
   * radially symmetric plume, but a ring emitter's ring lands in the wrong plane entirely.
   *
   * The translation is skipped because `position` (originX/Y/Z above) already places the emitter in
   * model space, so applying the pivot on top double-counts it. Measured on INSTANCEPORTAL.M2, whose
   * emitter position and bone pivot are the same [0, 0, 2.74]: applying both put the portal ring's
   * centre at 5.48 instead of 2.74, floating it a full radius above the doorway.
   *
   * Null or absent means "no reorientation", which is exactly the behaviour this had before.
   */
  basis?: ArrayLike<number> | null;
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

  // Both angles sweep [-range, +range], centred on zero, as the plane generator's azimuth does.
  // Latitude used to sweep [0, +lat], which on the dungeon portal (lat = pi, long = 0, fixed radius
  // -- a ring) kept sin(polar) non-negative and so drew exactly half the ring.
  const polar = params.verticalRange * (random() - 0.5) * 2;
  const azimuth = params.horizontalRange * (random() - 0.5) * 2;

  const sinPolar = Math.sin(polar);

  // At longitude zero the ring lies in the YZ plane -- x = 0 -- and longitude rotates it about Z.
  // This had cos and sin the other way round, putting the unrotated ring in the XZ plane instead:
  // the same ring turned 90 degrees. Invisible on a full spherical shell, and invisible on the plane
  // emitters that make up 694 of the 698 emitters loaded at Blackrock, but on the portal it stood
  // face-on to the corridor rather than edge-on across the doorway.
  const dirX = sinPolar * Math.sin(azimuth);
  const dirY = sinPolar * Math.cos(azimuth);
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

  const base = slot * 3;

  // The emitter's own offset in model space, applied before zSource reads the position -- per
  // wowdev, zSource's direction is computed from the particle's (already-offset) position.
  pool.position[base] += params.originX;
  pool.position[base + 1] += params.originY;
  pool.position[base + 2] += params.originZ;

  // When zSource > 0, replace the velocity direction with the normalized direction from the source.
  if (params.zSource > 0) {
    const dx = pool.position[base];
    const dy = pool.position[base + 1];
    const dz = pool.position[base + 2] - params.zSource;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (length > 1e-6) {
      pool.velocity[base] = dx / length;
      pool.velocity[base + 1] = dy / length;
      pool.velocity[base + 2] = dz / length;
    }
  }

  // Reorient out of the emitter's own frame and into model space. Done here, after zSource, because
  // zSource's direction is defined relative to the emitter -- rotating first would measure it against
  // the wrong axis.
  const basis = params.basis;
  if (basis) {
    const px = pool.position[base];
    const py = pool.position[base + 1];
    const pz = pool.position[base + 2];

    // Rotation only -- no translation column. See the note on `basis` in SpawnParams.
    pool.position[base] = basis[0] * px + basis[4] * py + basis[8] * pz;
    pool.position[base + 1] = basis[1] * px + basis[5] * py + basis[9] * pz;
    pool.position[base + 2] = basis[2] * px + basis[6] * py + basis[10] * pz;

    // Velocity is a direction, so it takes the rotation without the translation column.
    const vx = pool.velocity[base];
    const vy = pool.velocity[base + 1];
    const vz = pool.velocity[base + 2];

    pool.velocity[base] = basis[0] * vx + basis[4] * vy + basis[8] * vz;
    pool.velocity[base + 1] = basis[1] * vx + basis[5] * vy + basis[9] * vz;
    pool.velocity[base + 2] = basis[2] * vx + basis[6] * vy + basis[10] * vz;
  }

  // The direction written above is a unit vector; scale it to the emission speed.
  const variation = 1 + params.speedVariation * (random() * 2 - 1);
  const speed = params.speed * variation;

  pool.velocity[base] *= speed;
  pool.velocity[base + 1] *= speed;
  pool.velocity[base + 2] *= speed;

  pool.age[slot] = 0;
  pool.lifespan[slot] = params.lifespan;
  pool.seed[slot] = random();
  pool.spin[slot] = params.baseSpin;
  pool.spinSpeed[slot] = params.spinSpeed;
};
