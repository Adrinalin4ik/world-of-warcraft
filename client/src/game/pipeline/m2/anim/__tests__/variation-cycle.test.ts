/** @jest-environment node */
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { armDoodad, cycleDoodad, SharedRng, sharedRng } from '../variation-cycle';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const twoVariations = () => new ModelAnim({
  animations: [
    animation({ id: 0, subID: 0, length: 1000, probability: 16000 }),
    animation({ id: 0, subID: 1, length: 700, probability: 16767 }),
  ],
  sequences: [], bones: [],
});

describe('SharedRng', () => {
  it('stays within the client rand() range', () => {
    const rng = new SharedRng(1);
    for (let i = 0; i < 500; ++i) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });

  it('is deterministic from a seed, so tests can assert exact sequences', () => {
    expect(new SharedRng(7).next()).toBe(new SharedRng(7).next());
  });

  it('advances -- consecutive draws differ', () => {
    const rng = new SharedRng(1);
    const a = rng.next();
    const b = rng.next();
    expect(a).not.toBe(b);
  });
});

describe('armDoodad', () => {
  it('arms animation id 0 at the given world time', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 500, new SharedRng(1));
    expect(inst.current!.id).toBe(0);
    expect(inst.armedAtMs).toBe(500);
  });

  it('leaves an instance unarmed when the model owns no animation 0', () => {
    const m = new ModelAnim({ animations: [], sequences: [], bones: [] });
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    expect(inst.current).toBeNull();
  });
});

describe('cycleDoodad', () => {
  it('does not re-arm before the play window elapses', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    const armedAt = inst.armedAtMs;
    expect(cycleDoodad(inst, 500, new SharedRng(1))).toBe(false);
    expect(inst.armedAtMs).toBe(armedAt);
  });

  it('re-arms once the window elapses', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    const length = inst.current!.lengthMs;
    expect(cycleDoodad(inst, length + 1, new SharedRng(1))).toBe(true);
    expect(inst.armedAtMs).toBe(length + 1);
  });
});

/**
 * De-sync comes from ONE shared stream drawn consecutively -- not from a per-placement seed.
 * benilla shipped a position hash first: it de-synced correctly but PERMANENTLY, so the Blasted
 * Lands lightning struck from one fixed spot every session (`doodad_anim.rs:37-45`).
 */
describe('de-sync through the shared stream', () => {
  it('gives consecutive instances different variations from one stream', () => {
    const m = twoVariations();
    const rng = new SharedRng(1);
    const picked = new Set<number>();
    for (let i = 0; i < 40; ++i) {
      const inst = new InstanceAnim(m);
      armDoodad(inst, 0, rng);
      picked.add(inst.current!.subId);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  it('re-arming the same instance can change its variation, so it is not permanent', () => {
    const m = twoVariations();
    const rng = new SharedRng(1);
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, rng);
    const seen = new Set<number>([inst.current!.subId]);
    let clock = 0;
    for (let i = 0; i < 40; ++i) {
      clock += inst.current!.lengthMs + 1;
      cycleDoodad(inst, clock, rng);
      seen.add(inst.current!.subId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('sharedRng singleton', () => {
  it('exists and produces in-range values', () => {
    sharedRng.reset(1);
    expect(sharedRng.next()).toBeGreaterThanOrEqual(0);
  });
});
