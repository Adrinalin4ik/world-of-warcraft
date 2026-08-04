/** @jest-environment node */
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const model = (over: any = {}) => new ModelAnim({
  animations: [animation()], sequences: [], bones: [], ...over,
});

describe('InstanceAnim clock', () => {
  it('starts unarmed with a zero cursor', () => {
    const inst = new InstanceAnim(model());
    expect(inst.current).toBeNull();
    expect(inst.cursor(5000)).toBe(0);
  });

  it('measures the cursor from the arm time, not from accumulated deltas', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 1000);
    expect(inst.cursor(1000)).toBe(0);
    expect(inst.cursor(1400)).toBe(400);
  });

  it('wraps a looping sequence on its length', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(500);
  });

  it('clamps a one-shot sequence at its length', () => {
    const m = model({ animations: [animation({ flags: 0x01, length: 1000 })] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(1000);
  });
});

/**
 * The load-bearing property. Gating an offscreen instance is only safe if a resumed instance shows
 * the pose the shared clock dictates -- not a pose behind by however long it was skipped. A
 * delta-accumulating clock fails this; a clock-indexed one passes it by construction.
 */
describe('clock-indexed resume', () => {
  it('a paused instance resumes to the same cursor as one that never paused', () => {
    const m = model();

    const continuous = new InstanceAnim(m);
    continuous.arm(m.sequences[0], 0);
    for (let t = 0; t <= 2500; t += 16) {
      continuous.cursor(t);
    }

    const paused = new InstanceAnim(m);
    paused.arm(m.sequences[0], 0);
    paused.cursor(100);
    // ... skipped entirely from 100ms to 2500ms ...

    expect(paused.cursor(2500)).toBe(continuous.cursor(2500));
  });

  it('does not drift across many pause/resume cycles', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    for (let t = 0; t < 100_000; t += 997) {
      inst.cursor(t);
    }
    expect(inst.cursor(100_000)).toBe(0);
  });
});
