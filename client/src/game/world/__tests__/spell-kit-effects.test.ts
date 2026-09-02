import * as THREE from 'three';

import SpellKitEffects from '../spell-kit-effects';
import { WORLD_EFFECT_TAG, WORLD_SLOT } from '../../classes/spell-kit-fx';

/**
 * WHICH LAYER THIS COVERS: the lifetime decisions and the plant transform, over stub models. It is
 * authoritative for "does a precast instance survive until its reap", "does a cast instance die on its
 * own sequence-0 span", "does a reap honour a `Decay` span", "is a plant baked and not re-transformed"
 * and "is the model handle released when its owner leaves".
 *
 * It is authoritative for NOTHING about pixels. Whether the model is visible, parented to the right
 * bone in the running game, or emitting particles is the owner's check and is handed to him as a list
 * -- `M2#attachTo` and `ParticleManager#register` are both stubbed away here.
 */

/** Sequence spans a stub model reports: `AnimationData` id -> lengthMs. */
type Spans = Record<number, number>;

let mockUnloaded: string[] = [];

function stubModel(path: string, spans: Spans) {
  const model: any = new THREE.Object3D();
  model.path = path;
  model.updateMatrix = jest.fn();
  model.modelAnim = {
    resolve: (id: number, _fallback: boolean) => (
      spans[id] === undefined ? null : { lengthMs: spans[id] }),
  };
  model.instanceAnim = { arm: jest.fn() };
  model.attachTo = jest.fn(() => true);
  return model;
}

let mockNextModel: () => any;

jest.mock('../../pipeline/m2/blueprint', () => ({
  __esModule: true,
  default: {
    load: (path: string) => Promise.resolve(mockNextModel()),
    unload: (model: any) => { mockUnloaded.push(model.path); },
  },
}));

let mockEmitters: any[] = [];
jest.mock('../../classes/spell-kit-fx', () => ({
  ...(jest.requireActual('../../classes/spell-kit-fx')),
  kitEmitters: () => mockEmitters,
}));

function stubUnit(guid: string) {
  const body = stubModel('body', {});
  return {
    guid,
    position: new THREE.Vector3(10, 20, 30),
    facing: Math.PI / 2,
    model: body,
  } as never;
}

const manager = {
  register: jest.fn(() => 0),
  unregister: jest.fn(),
  // The readiness handle the spawn path returns. Resolved, so the handler's chain settles at once.
  ready: jest.fn(() => Promise.resolve()),
};
const nobodyGone = () => false;

beforeEach(() => {
  mockUnloaded = [];
  manager.register.mockClear();
  manager.ready.mockClear();
  manager.unregister.mockClear();
});

describe('SpellKitEffects lifetimes', () => {
  it('runs both stage lifetimes: persistent until reap plus Decay, cast on its own span', async () => {
    const fx = new SpellKitEffects(new THREE.Scene());
    // Sequence 0 is 400 ms and Decay (159) is 1100 ms -- a persistent instance must ignore the first
    // and, once reaped, live exactly the second.
    mockNextModel = () => stubModel('glow', { 0: 400, 159: 1100 });
    mockEmitters = [{
      slot: 3, tag: 0x15, effectId: 1, modelPath: 'Spells\\Glow.mdx',
    }];

    fx.play(stubUnit('0x1'), 133, 30, true, manager);
    await Promise.resolve();
    expect(fx.liveCount).toBe(1);
    expect(manager.register).toHaveBeenCalledTimes(1);

    // Well past its own sequence-0 span: a PERSISTENT instance is not on a clock.
    fx.update(5000, nobodyGone);
    expect(fx.liveCount).toBe(1);

    // The reap does not remove it at once, because the model authors a Decay.
    fx.reap('0x1', 133);
    expect(fx.liveCount).toBe(1);
    expect(fx.stats.decayed).toBe(1);

    fx.update(1000, nobodyGone);
    expect(fx.liveCount).toBe(1); // 100 ms of the decay left
    fx.update(200, nobodyGone);
    expect(fx.liveCount).toBe(0);

    // The handle is RELEASED, not merely detached -- `M2Blueprint.unload` is a refcount.
    expect(mockUnloaded).toEqual(['glow']);
    expect(manager.unregister).toHaveBeenCalledTimes(1);

    // ---- the OTHER stage, in the same test because it is the same mechanism seen from the other
    // side: a cast-release instance is on a clock from the moment it spawns and authors no Decay.
    mockUnloaded = [];
    mockNextModel = () => stubModel('flash', { 0: 400 });
    mockEmitters = [{
      slot: 0, tag: 0x14, effectId: 2, modelPath: 'Spells\Flash.mdx',
    }];

    fx.play(stubUnit('0x1'), 133, 38, false, manager);
    await Promise.resolve();
    expect(fx.liveCount).toBe(1);
    fx.update(399, nobodyGone);
    expect(fx.liveCount).toBe(1);
    fx.update(2, nobodyGone);
    expect(fx.liveCount).toBe(0);
    expect(mockUnloaded).toEqual(['flash']);

    // A unit that leaves the world takes its effects with it -- otherwise the model handle leaks,
    // because a bone child dies with the body without anyone calling `unload`.
    mockUnloaded = [];
    fx.play(stubUnit('0x2'), 133, 38, false, manager);
    await Promise.resolve();
    expect(fx.liveCount).toBe(1);
    fx.update(1, (guid) => guid === '0x2');
    expect(fx.liveCount).toBe(0);
    expect(mockUnloaded).toEqual(['flash']);
  });

  it('bakes the world plant transform at spawn and never re-applies it', async () => {
    const scene = new THREE.Scene();
    const fx = new SpellKitEffects(scene);
    mockNextModel = () => stubModel('ring', { 0: 5000 });
    mockEmitters = [{
      slot: WORLD_SLOT, tag: WORLD_EFFECT_TAG, effectId: 3, modelPath: 'Spells\\Ring.mdx',
    }];

    const unit = stubUnit('0x1');
    fx.play(unit, 133, 349, false, manager);
    await Promise.resolve();

    const plant = scene.children.find((c: any) => c.path === 'ring') as any;
    expect(plant).toBeDefined();
    // translate(owner position) * yaw(owner facing) * scale(owner scale) -- `mod.rs:110-120`. The
    // 180-degree term matches the body model's own, whose source `unit.ts:1410` marks unverified.
    expect(plant.position.toArray()).toEqual([10, 20, 30]);
    expect(plant.rotation.z).toBeCloseTo(Math.PI / 2 + Math.PI, 6);
    expect(plant.scale.x).toBe(1);

    // BAKED: the owner moving and turning must not move the ring. This is the reference's behaviour
    // and not a shortcut -- "the model does NOT ride a bone and does not turn with the unit".
    (unit as any).position.set(99, 99, 99);
    (unit as any).facing = 0;
    fx.update(16, nobodyGone);
    expect(plant.position.toArray()).toEqual([10, 20, 30]);
    expect(plant.rotation.z).toBeCloseTo(Math.PI / 2 + Math.PI, 6);
  });
});

/**
 * THE INSTRUMENT MUST SEE A SELF-TERMINATING INSTANCE. Its first version filtered
 * `!instance.persistent` out, so a cast-kit leak would have reported an empty object while being
 * plainly on screen -- a clean number that ends an investigation, which is worse than no number.
 * One assertion, on the case that was blind.
 */
describe('liveDetail', () => {
  it('describes a non-persistent instance and its deadline', async () => {
    const fx = new SpellKitEffects(new THREE.Scene());
    mockNextModel = () => stubModel('glow', { 0: 400 });
    mockEmitters = [{
      slot: 3, tag: 0x15, effectId: 1, modelPath: 'Spells\Glow.mdx',
    }];

    // `persistent: false` -- the cast stage, the one the old `persistentLive()` could not see.
    fx.play(stubUnit('0x1'), 133, 38, false, manager);
    await Promise.resolve();

    const rows = fx.liveDetail();
    expect(rows).toHaveLength(1);
    expect(rows[0].persistent).toBe(false);
    expect(rows[0].key).toBe('0x1:133');
    // A real deadline, not null: `selfTerminateMs` folds a missing or zero span to `SPANLESS_MS`,
    // so a self-terminating instance can never be left without one.
    expect(rows[0].remaining).toBe(400);
    expect(rows[0].stuck).toBe(false);
  });
});
