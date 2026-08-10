import { EMITTER_TYPE } from '../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from './pool';
import { ParticleSpline } from './spline';

/**
 * M2Particle file flag 0x100, honoured only on a sphere emitter: birth velocity is straight +Z
 * instead of radial through the shell point. The shell still decides where each particle is *born*.
 *
 * Note this is the *file* flag. The reference's loader remaps it to runtime flag 0x4000 (and only
 * when the emitter's type word is 2), and secondary sources quote the runtime value -- but 0x4000 in
 * the file is a different flag entirely (follow-emitter motion), so keying off it both misses every
 * real sphere-up emitter and fires on unrelated ones.
 */
export const SPHERE_EMIT_UP = 0x100;

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
  /** M2Particle.flags. Only SPHERE_EMIT_UP is read here. */
  flags: number;
  /**
   * The parsed spline chain for an emitterType 3 emitter, or null. Built once when the emitter is
   * constructed -- the arc-length knots cost a 16-chord walk per segment and never change.
   */
  spline?: ParticleSpline | null;
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

  // Local x takes areaLength and local y takes areaWidth -- the reference pairing, not the one the
  // names suggest. Only observable on an anisotropic rectangle, and here it was transposed while the
  // universal rot90 below was also missing; the two cancelled exactly, so plane positions came out
  // right by luck. Fixing either alone would have broken them.
  pool.position[base] = (random() - 0.5) * params.areaLength;
  pool.position[base + 1] = (random() - 0.5) * params.areaWidth;
  pool.position[base + 2] = 0;

  // Both cone angles are symmetric draws. Latitude used to sweep [0, range] instead of +/-range,
  // which tilted every flame in the game the same way rather than scattering them about +Z.
  const polar = params.verticalRange * (random() - 0.5) * 2;
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

  // Latitude is measured from the equator, not from the pole: at lat = 0 the point sits on the
  // equator, at lat = +/-pi/2 at a pole. Both draws are symmetric. Latitude used to sweep [0, +lat],
  // which on the dungeon portal (lat = pi, long = 0, fixed radius -- a ring) kept the ring from
  // closing and drew exactly half of it.
  const lat = params.verticalRange * (random() - 0.5) * 2;
  const lon = params.horizontalRange * (random() - 0.5) * 2;

  const cosLat = Math.cos(lat);

  // One lat/lon unit vector serves as both the shell point and the radial velocity below. The
  // reference reuses the same pair, which is what keeps a zero-radius sphere spraying uniformly
  // rather than collapsing to a degenerate direction.
  const dirX = cosLat * Math.cos(lon);
  const dirY = cosLat * Math.sin(lon);
  const dirZ = Math.sin(lat);

  pool.position[base] = dirX * radius;
  pool.position[base + 1] = dirY * radius;
  pool.position[base + 2] = dirZ * radius;

  if (params.flags & SPHERE_EMIT_UP) {
    pool.velocity[base] = 0;
    pool.velocity[base + 1] = 0;
    pool.velocity[base + 2] = 1;
    return;
  }

  // Emitted outward along the shell normal.
  pool.velocity[base] = dirX;
  pool.velocity[base + 1] = dirY;
  pool.velocity[base + 2] = dirZ;
};

/**
 * Born ON the authored Bezier chain at a uniform arc fraction. For a spline emitter the generic
 * emission-area fields are repurposed as that fraction's bounds: areaLength is tMin and areaWidth is
 * tMax, both clamped to [0, 1].
 *
 * Velocity is +Z spun about the local curve tangent by an angle drawn from verticalRange -- a
 * Rodrigues rotation, so a flat chain throws straight up and a tilted one throws along its own lean.
 * horizontalRange is then a scatter distance *along* that direction, not an angle. With no vertical
 * range the particle has no velocity at all and simply sits on the curve while gravity and drag act
 * on it, which is how the standing fire-column effects are authored.
 */
const spawnSpline = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  const base = slot * 3;
  const spline = params.spline!;

  const tMin = Math.min(Math.max(params.areaLength, 0), 1);
  const tMax = Math.min(Math.max(params.areaWidth, 0), 1);
  const t = tMin + random() * (tMax - tMin);

  const point = spline.eval(t);
  pool.position[base] = point.x;
  pool.position[base + 1] = point.y;
  pool.position[base + 2] = point.z;

  if (params.zSource > 0) {
    // The shared tail replaces this with the radial-from-pivot direction, and no scatter applies.
    pool.velocity[base] = 0;
    pool.velocity[base + 1] = 0;
    pool.velocity[base + 2] = 1;
    return;
  }

  if (params.verticalRange === 0) {
    // No spin authored: the particle is born at rest on the curve.
    pool.velocity[base] = 0;
    pool.velocity[base + 1] = 0;
    pool.velocity[base + 2] = 0;
    return;
  }

  const tangent = spline.tangent(t);
  const length = Math.sqrt(
    tangent.x * tangent.x + tangent.y * tangent.y + tangent.z * tangent.z,
  );

  let axisX = 0;
  let axisY = 0;
  let axisZ = 1;
  if (length > 1e-6) {
    axisX = tangent.x / length;
    axisY = tangent.y / length;
    axisZ = tangent.z / length;
  }

  // Rodrigues rotation of +Z about the tangent by psi. With v = +Z this reduces to
  // Z*cos + (axis X Z)*sin + axis*(axis.z)*(1 - cos), and axis X Z is (axis.y, -axis.x, 0).
  const psi = params.verticalRange * (random() - 0.5) * 2;
  const sinPsi = Math.sin(psi);
  const cosPsi = Math.cos(psi);
  const oneMinusCos = axisZ * (1 - cosPsi);

  const dirX = axisY * sinPsi + axisX * oneMinusCos;
  const dirY = -axisX * sinPsi + axisY * oneMinusCos;
  const dirZ = cosPsi + axisZ * oneMinusCos;

  pool.velocity[base] = dirX;
  pool.velocity[base + 1] = dirY;
  pool.velocity[base + 2] = dirZ;

  // A scatter *distance* along the velocity, displacing the birth off the curve.
  if (params.horizontalRange !== 0) {
    const scatter = random() * params.horizontalRange;
    pool.position[base] += scatter * dirX;
    pool.position[base + 1] += scatter * dirY;
    pool.position[base + 2] += scatter * dirZ;
  }
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

    case EMITTER_TYPE.SPLINE:
      // A spline emitter whose chain is missing or malformed falls through to the plane kernel, as
      // the reference does, rather than being dropped.
      if (params.spline) {
        spawnSpline(pool, slot, params, random);
      } else {
        spawnPlane(pool, slot, params, random);
      }
      break;

    default:
      // The bone generator is not implemented. A point spawn keeps it harmless rather than leaving
      // position and velocity holding whatever the previous occupant of the slot left.
      spawnPoint(pool, slot);
      break;
  }

  const base = slot * 3;

  // When zSource > 0, replace the velocity direction with the normalized direction from the source.
  // Measured against the *shape-local* birth, before the emitter's own offset is added: the pivot is
  // at (0, 0, zSource) in the emitter's frame, not the model's. This ran after the offset, so an
  // emitter mounted high on a model measured its fountain from far below the pivot and sprayed
  // almost straight up regardless of where the particle was born.
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

  // A fixed +90 degree rotation about local +Z, prepended to every emitter regardless of shape.
  // It applies to the kernel-relative vectors only -- the emitter offset below stays outside it.
  // This is what stands the portal's ring edge-on across a doorway instead of face-on down the
  // corridor, and it was previously hand-folded into the sphere branch alone, leaving every plane
  // emitter's cone rotated a quarter turn from the reference.
  const localX = pool.position[base];
  pool.position[base] = -pool.position[base + 1];
  pool.position[base + 1] = localX;

  const velocityX = pool.velocity[base];
  pool.velocity[base] = -pool.velocity[base + 1];
  pool.velocity[base + 1] = velocityX;

  // The emitter's own offset in model space.
  pool.position[base] += params.originX;
  pool.position[base + 1] += params.originY;
  pool.position[base + 2] += params.originZ;

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
