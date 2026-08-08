/** @jest-environment node */
import * as THREE from 'three';
import { toEngineQuaternion, toEngineTranslation } from '../axes';

/** The mirror the M2 pipeline bakes into geometry and bone pivots. */
const D = new THREE.Matrix4().makeScale(-1, -1, 1);

describe('toEngineTranslation', () => {
  it('mirrors the sampled translation on X and Y and leaves Z alone', () => {
    const out = toEngineTranslation(new THREE.Vector3(), 0, 0, 0, 3, -5, 7);
    expect([out.x, out.y, out.z]).toEqual([-3, 5, 7]);
  });

  it('adds the mirrored translation onto the bind offset', () => {
    const out = toEngineTranslation(new THREE.Vector3(), 10, 20, 30, 1, 2, 3);
    expect([out.x, out.y, out.z]).toEqual([9, 18, 33]);
  });

  it('reproduces the bind offset exactly for an unanimated bone', () => {
    const out = toEngineTranslation(new THREE.Vector3(), -4, 8, 1, 0, 0, 0);
    expect([out.x, out.y, out.z]).toEqual([-4, 8, 1]);
  });

  it('agrees with conjugating the raw translation by diag(-1, -1, 1)', () => {
    const raw = new THREE.Vector3(1.5, -2.25, 0.75);
    const expected = raw.clone().applyMatrix4(D);
    const out = toEngineTranslation(new THREE.Vector3(), 0, 0, 0, raw.x, raw.y, raw.z);
    expect(out.distanceTo(expected)).toBeCloseTo(0, 10);
  });
});

describe('toEngineQuaternion', () => {
  it('leaves the identity rotation alone', () => {
    const out = toEngineQuaternion(new THREE.Quaternion(), 0, 0, 0, 1);
    expect(out.equals(new THREE.Quaternion())).toBe(true);
  });

  it('stays a unit quaternion', () => {
    const raw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 2.0));
    const out = toEngineQuaternion(new THREE.Quaternion(), raw.x, raw.y, raw.z, raw.w);
    expect(out.length()).toBeCloseTo(1, 10);
  });

  it('is the conjugation D R D, matrix for matrix, for an arbitrary rotation', () => {
    // The property that actually matters: posing a bone with the converted quaternion must produce
    // the same orientation as mirroring the raw rotation into engine axes.
    const raw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -0.4, 1.3));

    const expected = new THREE.Matrix4()
      .multiplyMatrices(D, new THREE.Matrix4().makeRotationFromQuaternion(raw))
      .multiply(D);

    const converted = toEngineQuaternion(new THREE.Quaternion(), raw.x, raw.y, raw.z, raw.w);
    const actual = new THREE.Matrix4().makeRotationFromQuaternion(converted);

    for (let i = 0; i < 16; ++i) {
      expect(actual.elements[i]).toBeCloseTo(expected.elements[i], 10);
    }
  });

  it('is its own inverse, as a mirror of a mirror must be', () => {
    const raw = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.9, 0.2, 0.5));
    const once = toEngineQuaternion(new THREE.Quaternion(), raw.x, raw.y, raw.z, raw.w);
    const twice = toEngineQuaternion(new THREE.Quaternion(), once.x, once.y, once.z, once.w);
    expect(twice.equals(raw)).toBe(true);
  });
});
