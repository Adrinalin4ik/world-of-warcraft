/**
 * @jest-environment node
 */
import { EMITTER_TYPE } from '../../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from '../pool';
import { RuntimeEmitter } from '../runtime-emitter';

// A definition shaped exactly like the parser's output, with unanimated single-key tracks.
const constantTrack = (value: number) => ({
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
});

const makeDefinition = (overrides: Record<string, any> = {}) => ({
  emitterType: EMITTER_TYPE.PLANE,
  emissionRate: constantTrack(10),
  emissionSpeed: constantTrack(5),
  speedVariation: constantTrack(0),
  verticalRange: constantTrack(0),
  horizontalRange: constantTrack(0),
  gravity: constantTrack(0),
  lifespan: constantTrack(1),
  emissionAreaWidth: constantTrack(2),
  emissionAreaLength: constantTrack(2),
  zSource: constantTrack(0),
  lifespanVariation: 0,
  emissionRateVariation: 0,
  drag: 0,
  baseSpin: 0,
  baseSpinVariation: 0,
  spinSpeed: 0,
  spinSpeedVariation: 0,
  enabledIn: { tracks: [] },
  ...overrides,
});

describe('RuntimeEmitter', () => {
  it('emits at the configured rate over one second', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    // 10 per second for one second, minus none expired yet (lifespan 1s, and the earliest particle is
    // exactly at its lifespan boundary), so allow one either way.
    expect(emitter.liveCount).toBeGreaterThanOrEqual(9);
    expect(emitter.liveCount).toBeLessThanOrEqual(10);
  });

  it('accumulates fractional emission instead of never emitting', () => {
    const pool = new ParticlePool(64);
    // 3 per second stepped at 60 FPS is 0.05 particles per frame.
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(3) }), pool, () => 0.5);

    for (let i = 0; i < 60; i++) {
      emitter.step(1 / 60);
    }

    expect(emitter.liveCount).toBeGreaterThanOrEqual(2);
  });

  it('emits nothing when the rate is zero', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(0) }), pool, () => 0.5);

    for (let i = 0; i < 30; i++) {
      emitter.step(1 / 30);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('stops emitting after stop() but lets existing particles finish', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }
    const afterEmitting = emitter.liveCount;
    expect(afterEmitting).toBeGreaterThan(0);

    emitter.stop();
    emitter.step(0.1);

    expect(emitter.liveCount).toBeLessThanOrEqual(afterEmitting);

    // Everything expires once a full lifespan has elapsed.
    for (let i = 0; i < 20; i++) {
      emitter.step(0.1);
    }
    expect(emitter.liveCount).toBe(0);
  });

  it('respects its capacity cap', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(1000) }), pool, () => 0.5);
    emitter.capacity = 5;

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeLessThanOrEqual(5);
  });

  it('emits nothing while disabled', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);
    emitter.enabled = false;

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('cannot exceed the pool when the pool is smaller than the cap', () => {
    const pool = new ParticlePool(3);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(1000) }), pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeLessThanOrEqual(3);
  });

  it('does not emit while enabledIn evaluates to zero for the current animation', () => {
    const pool = new ParticlePool(16);
    const definition = makeDefinition({
      enabledIn: { tracks: [{ animationIndex: 0, timestamps: [0], values: [0] }] },
    });
    const emitter = new RuntimeEmitter(definition, pool, () => 0.5);

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('emits when enabledIn evaluates to non-zero', () => {
    const pool = new ParticlePool(16);
    const definition = makeDefinition({
      enabledIn: { tracks: [{ animationIndex: 0, timestamps: [0], values: [1] }] },
    });
    const emitter = new RuntimeEmitter(definition, pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeGreaterThan(0);
  });

  it('advances animation time as it steps', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    emitter.step(0.5);

    expect(emitter.animationTimeMs).toBeCloseTo(500, 3);
  });
});
