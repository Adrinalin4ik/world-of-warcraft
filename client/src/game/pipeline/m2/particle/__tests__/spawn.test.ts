/**
 * @jest-environment node
 */
import { EMITTER_TYPE } from '../../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from '../pool';
import { spawnParticle } from '../spawn';
import { ParticleSpline } from '../spline';

const baseParams = {
  emitterType: EMITTER_TYPE.PLANE,
  flags: 0,
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

// Cross-checked against samples/benilla (crates/benilla/src/particles/emit.rs), a byte-verified
// reverse of the reference client's three shape kernels. The reference prepends a fixed +90 degree
// rotation about local +Z -- rot90(v) = (-v.y, v.x, v.z) -- to EVERY emitter's kernel output, not
// just the sphere's, and the record-position translation stays outside it.
describe('spawnParticle — reference kernel conformance', () => {
  it('pairs plane area axes so the rectangle keeps its authored orientation', () => {
    const pool = new ParticlePool(512);
    // Deliberately anisotropic: an 8 x 2 rectangle. On a square area the pairing is unobservable,
    // which is exactly how benilla carried this bug for two releases.
    const params = {
      ...baseParams, areaLength: 8, areaWidth: 2, verticalRange: 0, horizontalRange: 0,
    };

    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < 300; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);
      maxX = Math.max(maxX, Math.abs(pool.position[slot * 3]));
      maxY = Math.max(maxY, Math.abs(pool.position[slot * 3 + 1]));
    }

    // Kernel puts x <- areaLength and y <- areaWidth; rot90 then swaps them, so the observable
    // extent is areaWidth along x and areaLength along y.
    expect(maxX).toBeGreaterThan(0.8);
    expect(maxX).toBeLessThanOrEqual(1 + 1e-6);
    expect(maxY).toBeGreaterThan(3.5);
    expect(maxY).toBeLessThanOrEqual(4 + 1e-6);
  });

  it('tilts the plane cone symmetrically rather than one-sided', () => {
    const pool = new ParticlePool(512);
    const params = {
      ...baseParams,
      areaLength: 0, areaWidth: 0,
      verticalRange: Math.PI / 4, horizontalRange: 0, speed: 1, speedVariation: 0,
    };

    let positive = 0;
    let negative = 0;
    for (let i = 0; i < 300; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);
      // theta = S11 * verticalRange, so the cone leans both ways. rot90 sends the lean onto +/-y.
      const y = pool.velocity[slot * 3 + 1];
      if (y > 1e-3) { positive++; }
      if (y < -1e-3) { negative++; }
    }

    expect(positive).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(0);
  });

  it('rotates the plane cone onto the reference axis', () => {
    const pool = new ParticlePool(64);
    const params = {
      ...baseParams,
      areaLength: 0, areaWidth: 0,
      verticalRange: Math.PI / 4, horizontalRange: 0, speed: 1, speedVariation: 0,
    };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);
      // With longitude zero the kernel cone leans along +/-x; rot90 puts it on +/-y, leaving x flat.
      expect(Math.abs(pool.velocity[slot * 3])).toBeLessThan(1e-6);
    }
  });

  it('measures zSource from the shape-local birth, excluding the emitter offset', () => {
    const pool = new ParticlePool(8);
    const params = {
      ...baseParams,
      emitterType: -1, // point spawn: shape-local birth is exactly the origin
      areaLength: 0, areaWidth: 0, verticalRange: 0, horizontalRange: 0,
      speed: 1, speedVariation: 0,
      originX: 0, originY: 0, originZ: 50,
      zSource: 2,
    };

    const slot = pool.allocate();
    spawnParticle(pool, slot, params, scriptedRandom([0.5]));

    // The birth sits at shape-local (0,0,0), so the direction from the pivot (0,0,2) is straight
    // down -Z. Measuring after the origin was added instead would put the birth at z=50 and send it
    // straight up, which is what this used to do.
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(-1, 5);
  });

  it('honours the sphere flag that forces emission straight up', () => {
    const pool = new ParticlePool(64);
    const params = {
      ...baseParams,
      emitterType: EMITTER_TYPE.SPHERE,
      flags: 0x100, // file flag; the reference remaps it to runtime 0x4000 for sphere emitters
      areaWidth: 5, areaLength: 5,
      verticalRange: Math.PI, horizontalRange: 0,
      speed: 1, speedVariation: 0,
    };

    for (let i = 0; i < 30; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);
      expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(1, 5);
      expect(Math.abs(pool.velocity[slot * 3])).toBeLessThan(1e-6);
      expect(Math.abs(pool.velocity[slot * 3 + 1])).toBeLessThan(1e-6);
    }
  });
});

describe('spawnParticle — spline emitter', () => {
  // A single straight segment running 0 -> 3 along +X, control points at exact thirds.
  const straightSpline = () => ParticleSpline.create([
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 },
  ]);

  const splineParams = () => ({
    ...baseParams,
    emitterType: EMITTER_TYPE.SPLINE,
    spline: straightSpline(),
    // For a spline emitter these are repurposed as the arc-fraction bounds, not an area.
    areaLength: 0,
    areaWidth: 1,
    verticalRange: 0,
    horizontalRange: 0,
    speed: 1,
    speedVariation: 0,
  });

  it('births particles along the curve rather than at a single point', () => {
    const pool = new ParticlePool(512);
    const params = splineParams();

    let minAlong = Infinity;
    let maxAlong = -Infinity;

    for (let i = 0; i < 200; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      // The chain runs along +X, and the universal rot90 turns that onto +Y.
      expect(Math.abs(pool.position[slot * 3])).toBeLessThan(1e-6);
      expect(Math.abs(pool.position[slot * 3 + 2])).toBeLessThan(1e-6);

      const along = pool.position[slot * 3 + 1];
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
    }

    // Spread over the whole chain -- the point-spawn fallback this replaces put every particle at 0.
    expect(minAlong).toBeLessThan(0.5);
    expect(maxAlong).toBeGreaterThan(2.5);
    expect(maxAlong).toBeLessThanOrEqual(3 + 1e-6);
  });

  it('honours the arc-fraction bounds carried in the area fields', () => {
    const pool = new ParticlePool(512);
    const params = { ...splineParams(), areaLength: 0.5, areaWidth: 1 };

    for (let i = 0; i < 200; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      // t restricted to [0.5, 1] means the back half of a 3-unit chain.
      expect(pool.position[slot * 3 + 1]).toBeGreaterThanOrEqual(1.5 - 1e-4);
    }
  });

  it('leaves the particle at rest when no spin is authored', () => {
    const pool = new ParticlePool(8);
    const slot = pool.allocate();

    spawnParticle(pool, slot, splineParams(), scriptedRandom([0.5]));

    // It sits on the curve and only gravity and drag move it.
    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(0, 6);
  });

  it('spins velocity about the curve tangent when verticalRange is authored', () => {
    const pool = new ParticlePool(512);
    const params = { ...splineParams(), verticalRange: Math.PI / 2 };

    let sawTilt = false;
    for (let i = 0; i < 200; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const vx = pool.velocity[slot * 3];
      const vy = pool.velocity[slot * 3 + 1];
      const vz = pool.velocity[slot * 3 + 2];

      // Unit direction scaled by speed 1, so the magnitude stays 1 whatever the spin angle.
      expect(Math.sqrt(vx * vx + vy * vy + vz * vz)).toBeCloseTo(1, 4);
      if (Math.abs(vz) < 0.9) { sawTilt = true; }
    }

    expect(sawTilt).toBe(true);
  });

  it('falls back to the plane kernel when the chain is missing', () => {
    const pool = new ParticlePool(64);
    // A type-3 emitter with no parsed chain is ordinary in game data; the reference degrades to the
    // plane kernel rather than dropping the emitter.
    const params = {
      ...splineParams(), spline: null, areaLength: 6, areaWidth: 4,
    };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      expect(Math.abs(pool.position[slot * 3])).toBeLessThanOrEqual(4 / 2 + 1e-6);
      expect(Math.abs(pool.position[slot * 3 + 1])).toBeLessThanOrEqual(6 / 2 + 1e-6);
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

/**
 * THE INHERITED EMITTER MOTION (file flag 0x40) -- one arm, on the arithmetic that matters.
 *
 * `speedVariation: 0` so the `(1 + S11*speedVariation)` factor is exactly 1 and the assertion is on
 * the inherit itself rather than on a random draw. `verticalRange`/`horizontalRange` 0 sends the
 * emission velocity straight up local +Z at `speed`, so the inherit's X and Y land on axes the
 * emission does not touch and cannot be confused with it.
 */
describe('spawnParticle — inherited emitter motion', () => {
  it('adds the inherit vector to the birth velocity, on top of the emission speed', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();
    spawnParticle(pool, slot, {
      ...baseParams, inheritX: 3, inheritY: -4, inheritZ: 5,
    }, scriptedRandom([0.5]));

    expect(pool.velocity[slot * 3]).toBeCloseTo(3, 5);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(-4, 5);
    // The emission's own 10 along +Z, plus the inherited 5.
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(15, 5);
  });

  it('leaves the birth velocity untouched when the emitter is not moving', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();
    spawnParticle(pool, slot, {
      ...baseParams, inheritX: 0, inheritY: 0, inheritZ: 0,
    }, scriptedRandom([0.5]));

    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 5);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(0, 5);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(10, 5);
  });
});
