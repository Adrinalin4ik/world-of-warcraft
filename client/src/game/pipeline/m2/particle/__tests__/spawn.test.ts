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
  zSource: 0,
  originX: 0,
  originY: 0,
  originZ: 0,
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

  it('applies originZ so the emission area sits around the offset, not the model origin', () => {
    const pool = new ParticlePool(64);
    const params = { ...baseParams, originZ: 5 };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      expect(pool.position[slot * 3 + 2]).toBeCloseTo(5, 6);
    }
  });

  it('with the origin at zero, behaviour is unchanged from today', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.5]));

    expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 6);
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

  // The radius assertion above is invariant to azimuth, so it passed just as happily while the sweep
  // covered only half the circle: spawnSphere used `horizontalRange * random()`, giving [0, +h], where
  // spawnPlane used the centred `horizontalRange * (random() - 0.5) * 2`, giving [-h, +h]. A one-sided
  // azimuth makes sin(azimuth) non-negative for every particle, so the whole emission collapses into
  // the +Y half-space -- which is exactly how the dungeon portal rendered: half a ring.
  it('sweeps azimuth symmetrically, reaching both halves of the circle', () => {
    const pool = new ParticlePool(512);
    const params = {
      ...baseParams,
      emitterType: EMITTER_TYPE.SPHERE,
      areaWidth: 10,
      areaLength: 10,
      verticalRange: Math.PI / 2,
      horizontalRange: Math.PI,
    };

    let negativeY = 0;
    let positiveY = 0;

    for (let i = 0; i < 200; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const y = pool.position[slot * 3 + 1];
      if (y < -1e-3) { negativeY++; }
      if (y > 1e-3) { positiveY++; }
    }

    expect(positiveY).toBeGreaterThan(0);
    expect(negativeY).toBeGreaterThan(0);
  });
});

// The values here are read off WORLD\GENERIC\PASSIVEDOODADS\INSTANCEPORTAL\INSTANCEPORTAL.M2 as it
// is loaded in game -- the dungeon-entrance portal, four sphere emitters, all identical. A fixed
// radius with lat = pi and long = 0 describes a *ring*, and in the official client it reads as a thin
// vertical column of light because you see that ring edge-on.
describe('spawnParticle — sphere emitter, dungeon portal parameters', () => {
  const portalParams = {
    ...baseParams,
    emitterType: EMITTER_TYPE.SPHERE,
    areaWidth: 4.17,
    areaLength: 4.17,
    verticalRange: Math.PI,
    horizontalRange: 0,
    speed: 1,
  };

  it('closes the ring instead of drawing half of it', () => {
    const pool = new ParticlePool(512);
    let above = 0;
    let below = 0;

    for (let i = 0; i < 200; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, portalParams, Math.random);

      const y = pool.position[slot * 3 + 1];
      if (y > 1e-3) { above++; }
      if (y < -1e-3) { below++; }
    }

    // polar swept [0, lat] rather than [-lat, +lat], so the ring only ever covered one side.
    expect(above).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it('lays the ring in the YZ plane, not XZ', () => {
    const pool = new ParticlePool(512);

    for (let i = 0; i < 120; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, portalParams, Math.random);

      // With longitude zero the ring is unrotated, so it must lie flat against x = 0. It used to come
      // out as x = sin(polar), z = cos(polar) -- the same ring turned 90 degrees, which is why the
      // portal faced the camera instead of standing edge-on in the doorway.
      expect(Math.abs(pool.position[slot * 3])).toBeLessThan(1e-6);

      const y = pool.position[slot * 3 + 1];
      const z = pool.position[slot * 3 + 2];
      expect(Math.sqrt(y * y + z * z)).toBeCloseTo(4.17, 4);
    }
  });
});

// An M2Particle names the bone it hangs off (`boneId`), and that bone's transform is what orients
// the emitter. Only the emitter's translation was ever applied, so every emitter fired along model
// space's axes with an identity orientation. On a radially symmetric plume that is invisible; on a
// ring emitter -- a dungeon portal -- the ring lands in the wrong plane, face-on instead of edge-on.
describe('spawnParticle — bone basis', () => {
  // Column-major, as THREE.Matrix4#elements is: a +90 deg rotation about X, translated by (5, 0, 0).
  // Under it (0, 0, 1) maps to (0, -1, 0).
  const rotateXTranslate = [
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    5, 0, 0, 1,
  ];

  const pointParams = {
    ...baseParams,
    emitterType: -1, // no generator -- falls through to the deterministic point spawn
    speed: 1,
    originX: 0,
    originY: 0,
    originZ: 1,
  };

  it('rotates the spawn position without applying the bone translation', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...pointParams, basis: rotateXTranslate }, scriptedRandom([0.5]));

    // (0, 0, 1) rotated about X is (0, -1, 0). If the basis translation were applied on top, x would
    // be 5 -- and on a real model that is a double-count, because the emitter's own `position` already
    // places it in model space. INSTANCEPORTAL.M2 has position and pivot both [0, 0, 2.74]; applying
    // both put its ring's centre at 5.48 rather than 2.74.
    expect(pool.position[slot * 3]).toBeCloseTo(0, 5);
    expect(pool.position[slot * 3 + 1]).toBeCloseTo(-1, 5);
    expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 5);
  });

  it('rotates velocity without translating it', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...pointParams, basis: rotateXTranslate }, scriptedRandom([0.5]));

    // The point generator emits along +Z at unit speed; rotated about X that is -Y. If the basis
    // translation leaked into the velocity, x would be 5 rather than 0.
    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 5);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(-1, 5);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(0, 5);
  });

  it('leaves spawns untouched when no basis is supplied', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, pointParams, scriptedRandom([0.5]));

    expect(pool.position[slot * 3]).toBeCloseTo(0, 5);
    expect(pool.position[slot * 3 + 2]).toBeCloseTo(1, 5);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(1, 5);
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

  it('with zSource: 0, velocity is unchanged', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.5]));

    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(baseParams.speed, 5);
  });

  it('with positive zSource and a particle above the source, velocity points away from the source', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...baseParams, zSource: 5 }, scriptedRandom([0.5]));

    // Particle spawned at (x, y, 0) with zSource at z=5.
    // The direction should be normalize((0, 0, 0) - (0, 0, 5)) = normalize((0, 0, -5)) = (0, 0, -1).
    const vx = pool.velocity[slot * 3];
    const vy = pool.velocity[slot * 3 + 1];
    const vz = pool.velocity[slot * 3 + 2];
    const mag = Math.sqrt(vx * vx + vy * vy + vz * vz);

    const expectedDx = 0;
    const expectedDy = 0;
    const expectedDz = -1;

    expect(vx / mag).toBeCloseTo(expectedDx, 5);
    expect(vy / mag).toBeCloseTo(expectedDy, 5);
    expect(vz / mag).toBeCloseTo(expectedDz, 5);
  });

  it('speed magnitude still respects variation with zSource active', () => {
    const pool = new ParticlePool(64);
    const params = { ...baseParams, speedVariation: 0.5, zSource: 10 };

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
});
