/** @jest-environment node */
import * as THREE from 'three';
import { AnimBlock, isStep, sampleQuat, sampleScalar, sampleVec3, SeqTrack, trackFor, WRAP, CLAMP, clockLaw, cursorMs } from '../tracks';

const track = (timestamps: number[], values: unknown[]): SeqTrack =>
  ({ animationIndex: 0, timestamps, values });

const linear = track([0, 100, 200], [0, 10, 30]);

describe('isStep', () => {
  it('is step only for interpolationType 0', () => {
    expect(isStep({ interpolationType: 0, globalSequenceID: -1, tracks: [] })).toBe(true);
    expect(isStep({ interpolationType: 1, globalSequenceID: -1, tracks: [] })).toBe(false);
    expect(isStep({ interpolationType: 2, globalSequenceID: -1, tracks: [] })).toBe(false);
  });
});

describe('trackFor', () => {
  const block: AnimBlock = {
    interpolationType: 1,
    globalSequenceID: -1,
    tracks: [track([0], [1]), track([0], [2])],
  };

  it('returns the track for the requested sequence slot', () => {
    expect(trackFor(block, 1)).toBe(block.tracks[1]);
  });

  it('returns null for an out-of-range slot rather than silently using slot 0', () => {
    expect(trackFor(block, 7)).toBeNull();
  });

  it('returns null for a slot whose track has no keys', () => {
    const sparse: AnimBlock = {
      interpolationType: 1, globalSequenceID: -1, tracks: [track([], [])],
    };
    expect(trackFor(sparse, 0)).toBeNull();
  });
});

describe('sampleScalar', () => {
  it('interpolates linearly between bracketing keys', () => {
    expect(sampleScalar(linear, false, 50, 0)).toBeCloseTo(5, 5);
    expect(sampleScalar(linear, false, 150, 0)).toBeCloseTo(20, 5);
  });

  it('holds the previous key when the track is step', () => {
    expect(sampleScalar(linear, true, 50, 0)).toBe(0);
    expect(sampleScalar(linear, true, 199, 0)).toBe(10);
    expect(sampleScalar(linear, true, 200, 0)).toBe(30);
  });

  it('holds the first key before the track starts', () => {
    expect(sampleScalar(linear, false, -50, 0)).toBe(0);
  });

  // The benilla rule that matters most: past the last key, HOLD. Never wrap-lerp back to key 0.
  it('holds the final key past the end instead of wrapping toward key 0', () => {
    expect(sampleScalar(linear, false, 250, 0)).toBe(30);
    expect(sampleScalar(linear, false, 10_000, 0)).toBe(30);
  });

  it('returns the single value when there is one key', () => {
    expect(sampleScalar(track([40], [7]), false, 0, 0)).toBe(7);
    expect(sampleScalar(track([40], [7]), false, 900, 0)).toBe(7);
  });

  it('returns the fallback for an empty track', () => {
    expect(sampleScalar(track([], []), false, 10, -1)).toBe(-1);
  });

  it('clamps to the last real value when timestamps and values array lengths mismatch (timestamps longer)', () => {
    // Malformed track where timestamps array is longer than values array.
    // bracket() returns k0=2 (last timestamp <= 200), but values[2] is out of bounds.
    // Should return the last real value (values[1]), not undefined/NaN.
    expect(sampleScalar(track([0, 100, 200], [0, 10]), false, 200, -1)).toBe(10);
    expect(sampleScalar(track([0, 100, 200], [0, 10]), false, 10_000, -1)).toBe(10);
  });

  it('clamps to the last real value on step interpolation with mismatched array lengths', () => {
    expect(sampleScalar(track([0, 100, 200], [0, 10]), true, 200, -1)).toBe(10);
    expect(sampleScalar(track([0, 100, 200], [0, 10]), true, 10_000, -1)).toBe(10);
  });

  it('always returns a finite number, never undefined or NaN', () => {
    const result1 = sampleScalar(linear, false, 150, -1);
    expect(Number.isFinite(result1)).toBe(true);

    const result2 = sampleScalar(track([0, 100, 200], [0, 10]), false, 200, -1);
    expect(Number.isFinite(result2)).toBe(true);

    const result3 = sampleScalar(track([40], [7]), false, 900, -1);
    expect(Number.isFinite(result3)).toBe(true);
  });

  it('holds the last key on duplicate timestamps', () => {
    // When timestamps[k0] === timestamps[k0+1], fraction returns 0, so we hold at va.
    // This is the correct behavior for authors who keyframe the same value twice.
    expect(sampleScalar(track([0, 100, 100, 200], [0, 5, 9, 12]), false, 100, 0)).toBe(9);
  });
});

describe('sampleVec3', () => {
  const v = track([0, 100], [[0, 0, 0], [10, 20, -30]]);

  it('interpolates each component', () => {
    const out = sampleVec3(v, false, 50, new THREE.Vector3());
    expect(out.x).toBeCloseTo(5, 5);
    expect(out.y).toBeCloseTo(10, 5);
    expect(out.z).toBeCloseTo(-15, 5);
  });

  it('holds the previous key when step', () => {
    const out = sampleVec3(v, true, 50, new THREE.Vector3());
    expect(out.toArray()).toEqual([0, 0, 0]);
  });

  it('holds the final key past the end', () => {
    const out = sampleVec3(v, false, 5000, new THREE.Vector3());
    expect(out.toArray()).toEqual([10, 20, -30]);
  });

  it('writes into the supplied vector and returns it, allocating nothing', () => {
    const out = new THREE.Vector3(1, 1, 1);
    expect(sampleVec3(v, false, 0, out)).toBe(out);
    expect(out.toArray()).toEqual([0, 0, 0]);
  });

  it('leaves the output untouched for an empty track', () => {
    const out = new THREE.Vector3(3, 4, 5);
    sampleVec3(track([], []), false, 10, out);
    expect(out.toArray()).toEqual([3, 4, 5]);
  });
});

describe('sampleQuat', () => {
  // 0 degrees and 90 degrees about Z.
  const a = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0);
  const b = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const q = track([0, 100], [a.toArray(), b.toArray()]);

  it('slerps rather than component-lerping', () => {
    const out = sampleQuat(q, false, 50, new THREE.Quaternion());
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), Math.PI / 4,
    );
    expect(out.angleTo(expected)).toBeCloseTo(0, 5);
  });

  // The failure a component-lerp produces: a non-unit quaternion, which scales the bone and
  // visibly shortens the limb at mid-swing.
  it('stays unit-length at the midpoint, which a component lerp would not', () => {
    const out = sampleQuat(q, false, 50, new THREE.Quaternion());
    expect(out.length()).toBeCloseTo(1, 6);

    const lerped = new THREE.Quaternion(
      (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, (a.w + b.w) / 2,
    );
    expect(lerped.length()).toBeLessThan(0.99);
  });

  it('holds the previous key when step', () => {
    const out = sampleQuat(q, true, 50, new THREE.Quaternion());
    expect(out.angleTo(a)).toBeCloseTo(0, 6);
  });

  it('holds the final key past the end', () => {
    const out = sampleQuat(q, false, 9999, new THREE.Quaternion());
    expect(out.angleTo(b)).toBeCloseTo(0, 6);
  });
});

describe('clockLaw', () => {
  const gseq: AnimBlock = { interpolationType: 1, globalSequenceID: 3, tracks: [] };
  const seq: AnimBlock = { interpolationType: 1, globalSequenceID: -1, tracks: [] };

  it('always wraps a global sequence, whatever the playing sequence does', () => {
    expect(clockLaw(gseq, true)).toBe(WRAP);
    expect(clockLaw(gseq, false)).toBe(WRAP);
  });

  it('follows the sequence loop flag for an ordinary track', () => {
    expect(clockLaw(seq, true)).toBe(WRAP);
    expect(clockLaw(seq, false)).toBe(CLAMP);
  });
});

describe('cursorMs', () => {
  it('wraps within the period', () => {
    expect(cursorMs(WRAP, 250, 100)).toBe(50);
    expect(cursorMs(WRAP, 100, 100)).toBe(0);
  });

  it('clamps at the period for a one-shot', () => {
    expect(cursorMs(CLAMP, 250, 100)).toBe(100);
    expect(cursorMs(CLAMP, 50, 100)).toBe(50);
  });

  it('never returns a negative cursor', () => {
    expect(cursorMs(WRAP, -30, 100)).toBe(70);
    expect(cursorMs(CLAMP, -30, 100)).toBe(0);
  });

  it('degrades to 0 for a zero-length period instead of dividing by zero', () => {
    expect(cursorMs(WRAP, 250, 0)).toBe(0);
    expect(cursorMs(CLAMP, 250, 0)).toBe(0);
  });
});

/**
 * The regression this whole distinction exists to prevent, stated as the failure it produces:
 * a Death sequence fades every batch to alpha 0, and a wrapped clock snaps it back to a fully
 * opaque body frozen in mid-air one frame later, for ever.
 */
describe('one-shot tail behaviour', () => {
  const fade = track([0, 500, 1000], [1, 0.5, 0]);

  it('holds alpha 0 past the end of a one-shot', () => {
    const t = cursorMs(CLAMP, 1500, 1000);
    expect(sampleScalar(fade, false, t, 1)).toBe(0);
  });

  it('would snap back to opaque if the clock wrapped -- the bug being prevented', () => {
    const t = cursorMs(WRAP, 1500, 1000);
    expect(sampleScalar(fade, false, t, 1)).toBeCloseTo(0.5, 5);
  });
});
