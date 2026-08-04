/** @jest-environment node */
import { AnimBlock, isStep, sampleScalar, SeqTrack, trackFor } from '../tracks';

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

  it('holds rather than dividing by zero on duplicate timestamps', () => {
    expect(sampleScalar(track([0, 100, 100, 200], [0, 5, 9, 12]), false, 100, 0)).toBe(9);
  });
});
