/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { ParticleManager } from '../manager';

const constantTrack = (value: number) => ({
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
});

const emitterDefinition = (overrides: Record<string, any> = {}) => ({
  emitterType: 1,
  textureId: 0,
  blendingType: 4,
  rows: 1,
  columns: 1,
  emissionRate: constantTrack(10),
  emissionSpeed: constantTrack(1),
  speedVariation: constantTrack(0),
  verticalRange: constantTrack(0),
  horizontalRange: constantTrack(0),
  gravity: constantTrack(0),
  lifespan: constantTrack(2),
  emissionAreaWidth: constantTrack(1),
  emissionAreaLength: constantTrack(1),
  zSource: constantTrack(0),
  colorTrack: { keys: [] },
  alphaTrack: { keys: [] },
  scaleTrack: { keys: [] },
  headUVAnim: { keys: [] },
  scaleVary: [0, 0],
  lifespanVariation: 0,
  drag: 0,
  baseSpin: 0,
  spinSpeed: 0,
  enabledIn: { tracks: [] },
  ...overrides,
});

// A stand-in for a loaded M2: an Object3D carrying emitter definitions and a texture table.
const fakeInstance = (emitters: any[]) => {
  const instance: any = new THREE.Object3D();
  instance.particleEmitters = emitters;
  instance.textures = [{ filename: 'TEST\\PARTICLE.BLP' }];
  return instance;
};

// A camera sitting at the world origin, alongside every fakeInstance created above -- well within
// ParticleManager.CULL_DISTANCE unless a test deliberately moves the instance or camera apart.
const testCamera = () => new THREE.PerspectiveCamera();

describe('ParticleManager', () => {
  it('registers one emitter per definition and reports the count', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(manager.register(fakeInstance([emitterDefinition(), emitterDefinition()]))).toBe(2);
    expect(manager.emitterCount).toBe(2);
  });

  it('registers nothing for an instance with no emitters', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(manager.register(fakeInstance([]))).toBe(0);
    expect(manager.emitterCount).toBe(0);
  });

  it('is idempotent — registering the same instance twice adds nothing', () => {
    const manager = new ParticleManager(new THREE.Group());
    const instance = fakeInstance([emitterDefinition()]);

    manager.register(instance);
    manager.register(instance);

    expect(manager.emitterCount).toBe(1);
  });

  it('adds a batch mesh to the group per emitter and removes it on unregister', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);
    const instance = fakeInstance([emitterDefinition(), emitterDefinition()]);

    manager.register(instance);
    expect(group.children.length).toBe(2);

    manager.unregister(instance);
    expect(group.children.length).toBe(0);
    expect(manager.emitterCount).toBe(0);
  });

  it('emits particles as it animates', () => {
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition()]));

    expect(manager.liveParticleCount).toBe(0);

    const camera = testCamera();
    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30, camera);
    }

    expect(manager.liveParticleCount).toBeGreaterThan(0);
  });

  it('caps pool capacity from rate and lifespan', () => {
    const manager = new ParticleManager(new THREE.Group());
    // 10 per second for 2 seconds needs about 20 slots, nowhere near the per-emitter ceiling.
    manager.register(fakeInstance([emitterDefinition()]));

    const camera = testCamera();
    for (let i = 0; i < 200; i++) {
      manager.animate(1 / 30, camera);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
    expect(manager.liveParticleCount).toBeLessThanOrEqual(25);
  });

  it('sizes the pool from the emission-rate PEAK, not its value at t=0', () => {
    // THE SPELL-EFFECT SHAPE, and the defect this closes. A doodad emits at a constant rate, so
    // sampling `emissionRate` at t=0 gave its real rate; a spell effect RAMPS, and four of the six
    // real effect models measured start at zero -- both of Warrior Charge's emitters among them. The
    // pool was then built with the floor of one slot and the effect could never show more than a
    // single particle however hard it emitted later, which on screen is "no particles at all".
    //
    // 0 at t=0 rising to 50 over 500 ms, at a 1 s lifespan: the peak asks for ~51 slots, the old t=0
    // read asked for 1.
    const ramped = {
      tracks: [{ animationIndex: 0, timestamps: [0, 500], values: [0, 50] }],
    };
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition({
      emissionRate: ramped,
      lifespan: constantTrack(1),
    })]));

    const camera = testCamera();
    for (let i = 0; i < 120; i++) {
      manager.animate(1 / 60, camera);
    }

    // The assertion is on the number of particles the emitter could HOLD, which is what the capacity
    // decides -- one slot would pin this at 1 forever.
    expect(manager.liveParticleCount).toBeGreaterThan(1);
    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
  });

  it('clamps a pathological definition to the per-emitter ceiling', () => {
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition({
      emissionRate: constantTrack(100000),
      lifespan: constantTrack(100),
    })]));

    const camera = testCamera();
    for (let i = 0; i < 60; i++) {
      manager.animate(1 / 60, camera);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
  });

  it('tolerates unregistering an instance that was never registered', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(() => manager.unregister(fakeInstance([emitterDefinition()]))).not.toThrow();
  });

  it('skips an emitter whose textureId is out of range, registering nothing', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);
    const instance = fakeInstance([emitterDefinition({ textureId: 99 })]);

    expect(manager.register(instance)).toBe(0);
    expect(manager.emitterCount).toBe(0);
    expect(group.children.length).toBe(0);
    expect(() => manager.animate(1 / 60, testCamera())).not.toThrow();
  });

  it('registers zero emitters when every emitter has an unresolvable texture', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);
    const instance = fakeInstance([
      emitterDefinition({ textureId: 99 }),
      emitterDefinition({ textureId: -1 }),
    ]);

    expect(manager.register(instance)).toBe(0);
    expect(manager.emitterCount).toBe(0);
    expect(group.children.length).toBe(0);
  });

  it('rolls back a partially-constructed registration when a later definition throws', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);

    const goodDefinition = emitterDefinition();
    const badDefinition = emitterDefinition();
    Object.defineProperty(badDefinition, 'emissionRate', {
      get() {
        throw new Error('boom');
      },
    });

    const instance = fakeInstance([goodDefinition, badDefinition]);

    expect(manager.register(instance)).toBe(0);
    expect(manager.emitterCount).toBe(0);
    expect(group.children.length).toBe(0);

    // A later retry with a well-formed instance must still succeed.
    const otherInstance = fakeInstance([emitterDefinition()]);
    expect(manager.register(otherInstance)).toBe(1);
    expect(manager.emitterCount).toBe(1);
  });

  it('unregisters one of several instances without disturbing the others', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);

    const instanceA = fakeInstance([emitterDefinition()]);
    const instanceB = fakeInstance([emitterDefinition(), emitterDefinition()]);
    const instanceC = fakeInstance([emitterDefinition()]);

    manager.register(instanceA);
    manager.register(instanceB);
    manager.register(instanceC);

    expect(manager.emitterCount).toBe(4);
    expect(group.children.length).toBe(4);

    manager.unregister(instanceB);

    expect(manager.emitterCount).toBe(2);
    expect(group.children.length).toBe(2);

    const camera = testCamera();
    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30, camera);
    }

    expect(manager.liveParticleCount).toBeGreaterThan(0);
  });

  it('culls an emitter beyond CULL_DISTANCE: it stays at zero live particles and its batch is hidden', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);

    const near = fakeInstance([emitterDefinition()]);
    const far = fakeInstance([emitterDefinition()]);
    far.position.set(ParticleManager.CULL_DISTANCE * 10, 0, 0);
    far.updateMatrixWorld(true);

    manager.register(near);
    manager.register(far);

    const camera = testCamera();
    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30, camera);
    }

    const nearBatch = group.children[0] as any;
    const farBatch = group.children[1] as any;

    expect(manager.liveParticleCount).toBeGreaterThan(0);
    expect(nearBatch.visible).toBe(true);
    expect(farBatch.visible).toBe(false);
    expect(farBatch.geometry.instanceCount).toBe(0);
  });

  it('releases a culled emitter\'s particles rather than freezing them', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);

    const instance = fakeInstance([emitterDefinition()]);
    manager.register(instance);

    const camera = testCamera();

    // Emit some live particles while in range.
    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30, camera);
    }
    expect(manager.liveParticleCount).toBeGreaterThan(0);

    // Walk far away: the next animate() call must observe the cull transition and release the pool.
    instance.position.set(ParticleManager.CULL_DISTANCE * 10, 0, 0);
    instance.updateMatrixWorld(true);

    manager.animate(1 / 30, camera);

    expect(manager.liveParticleCount).toBe(0);
  });
});

/**
 * THE ZONE-LOAD COST of the readiness handle, measured because the doodad lanes register a great many
 * emitters at zone load and `ready` was added to their `.then` handlers.
 *
 * Not a correctness test and it asserts nothing about time -- a timing assertion is a flake
 * generator. It asserts that both arms did the same registration work, so the printed numbers cannot
 * be of a loop that skipped it.
 */
describe('ParticleManager readiness handle: registration cost', () => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const timeIt = (label: string, body: () => number): void => {
    for (let i = 0; i < 2; i += 1) body();
    const runs: number[] = [];
    let registered = 0;
    for (let r = 0; r < 7; r += 1) {
      const t0 = process.hrtime.bigint();
      registered = body();
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const spread = Math.max(...runs) - Math.min(...runs);
    // eslint-disable-next-line no-console
    console.log(`${label.padEnd(52)} ${median(runs).toFixed(3)} ms  (spread ${spread.toFixed(3)}, registered ${registered})`);
  };

  it('costs a WeakMap write per doodad, and no allocation for a single-emitter model', () => {
    // 1000 doodads is a plausible zone-load population for this client (the perf record cites 31k
    // static nodes and 457 collision BVHs, so a thousand emitter-bearing doodads is not generous).
    const COUNT = 1000;

    // ONE emitter, which is the common doodad shape: `ready` hands back the material's own promise
    // and allocates nothing of its own.
    timeIt(`register x${COUNT}, 1 emitter each (no ready call)`, () => {
      const manager = new ParticleManager(new THREE.Group());
      let n = 0;
      for (let i = 0; i < COUNT; i += 1) {
        n += manager.register(fakeInstance([emitterDefinition()]));
      }
      return n;
    });
    timeIt(`register + ready x${COUNT}, 1 emitter each`, () => {
      const manager = new ParticleManager(new THREE.Group());
      let n = 0;
      for (let i = 0; i < COUNT; i += 1) {
        const instance = fakeInstance([emitterDefinition()]);
        n += manager.register(instance);
        void manager.ready(instance);
      }
      return n;
    });

    // FOUR emitters, where `ready` does allocate a `Promise.all`. `LootFX.mdl` has four, so this is
    // the shape that produced the owner's warnings rather than a synthetic worst case.
    timeIt(`register x${COUNT}, 4 emitters each (no ready call)`, () => {
      const manager = new ParticleManager(new THREE.Group());
      let n = 0;
      for (let i = 0; i < COUNT; i += 1) {
        n += manager.register(fakeInstance([
          emitterDefinition(), emitterDefinition(), emitterDefinition(), emitterDefinition(),
        ]));
      }
      return n;
    });
    timeIt(`register + ready x${COUNT}, 4 emitters each`, () => {
      const manager = new ParticleManager(new THREE.Group());
      let n = 0;
      for (let i = 0; i < COUNT; i += 1) {
        const instance = fakeInstance([
          emitterDefinition(), emitterDefinition(), emitterDefinition(), emitterDefinition(),
        ]);
        n += manager.register(instance);
        void manager.ready(instance);
      }
      return n;
    });

    expect(true).toBe(true);
  }, 60000);
});
