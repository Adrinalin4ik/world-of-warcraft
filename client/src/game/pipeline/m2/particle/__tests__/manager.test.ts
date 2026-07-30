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

    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30);
    }

    expect(manager.liveParticleCount).toBeGreaterThan(0);
  });

  it('caps pool capacity from rate and lifespan', () => {
    const manager = new ParticleManager(new THREE.Group());
    // 10 per second for 2 seconds needs about 20 slots, nowhere near the per-emitter ceiling.
    manager.register(fakeInstance([emitterDefinition()]));

    for (let i = 0; i < 200; i++) {
      manager.animate(1 / 30);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
    expect(manager.liveParticleCount).toBeLessThanOrEqual(25);
  });

  it('clamps a pathological definition to the per-emitter ceiling', () => {
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition({
      emissionRate: constantTrack(100000),
      lifespan: constantTrack(100),
    })]));

    for (let i = 0; i < 60; i++) {
      manager.animate(1 / 60);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
  });

  it('tolerates unregistering an instance that was never registered', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(() => manager.unregister(fakeInstance([emitterDefinition()]))).not.toThrow();
  });

  it('survives an emitter whose textureId is out of range', () => {
    const manager = new ParticleManager(new THREE.Group());
    const instance = fakeInstance([emitterDefinition({ textureId: 99 })]);

    expect(manager.register(instance)).toBe(1);
    expect(() => manager.animate(1 / 60)).not.toThrow();
  });
});
