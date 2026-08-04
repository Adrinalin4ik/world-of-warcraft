/** @jest-environment node */
import * as THREE from 'three';
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

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const vec3Block = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});
const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

const matrixOf = (inst: InstanceAnim, index: number) =>
  new THREE.Matrix4().fromArray(inst.palette, index * 16);

describe('solveBones', () => {
  it('produces identity for an unanimated bone', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);
    expect(matrixOf(inst, 0).equals(new THREE.Matrix4())).toBe(true);
  });

  it('applies a translated bone at the sampled cursor', () => {
    const m = model({
      bones: [bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(500);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0));
    expect(p.x).toBeCloseTo(5, 4);
  });

  it('composes a child onto its parent', () => {
    // NOTE: sequence length is overridden to 2000ms (not the fixture default of 1000ms). The
    // default model()'s sequence loops (flags 0) with length 1000ms, and the WRAP clock law wraps
    // an elapsed time exactly equal to the period back to cursor 0 (verified by
    // 'does not drift across many pause/resume cycles' above) -- so solveBones(1000) against the
    // default-length sequence would sample the START of the translation track, not the end, and
    // this test would assert a wrong pose rather than exercise parent composition. Lengthening the
    // sequence keeps 1000ms strictly inside the window.
    const m = model({
      animations: [{
        id: 0, subID: 0, length: 2000, flags: 0, probability: 32767,
        blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0,
      }],
      bones: [
        bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) }),
        bone({ parentID: 0, translation: vec3Block([[0, 0, 0], [0, 4, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(1000);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 1));
    expect(p.x).toBeCloseTo(10, 4);
    expect(p.y).toBeCloseTo(4, 4);
  });

  it('solves each bone exactly once however many children request it', () => {
    const m = model({
      bones: [bone(), bone({ parentID: 0 }), bone({ parentID: 0 }), bone({ parentID: 1 })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.solveBones(0)).toBe(4);
  });

  it('allocates no new palette between frames', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    const first = inst.palette;
    inst.solveBones(0);
    inst.solveBones(16);
    expect(inst.palette).toBe(first);
  });
});
