/**
 * @jest-environment node
 */
import {
  evaluateAnimationTrack,
  evaluateAnimationTrackStep,
  evaluateFBlockAlpha,
  evaluateFBlockCell,
  evaluateFBlockColor,
  evaluateFBlockScalar,
  evaluateFBlockVec2,
} from '../tracks';

const scalarBlock = { keys: [{ time: 0, value: 10 }, { time: 0.5, value: 20 }, { time: 1, value: 0 }] };

describe('evaluateFBlockScalar', () => {
  it('returns the endpoints exactly', () => {
    expect(evaluateFBlockScalar(scalarBlock, 0)).toBeCloseTo(10, 5);
    expect(evaluateFBlockScalar(scalarBlock, 1)).toBeCloseTo(0, 5);
  });

  it('interpolates linearly between keys', () => {
    expect(evaluateFBlockScalar(scalarBlock, 0.25)).toBeCloseTo(15, 5);
    expect(evaluateFBlockScalar(scalarBlock, 0.75)).toBeCloseTo(10, 5);
  });

  it('clamps outside the key range instead of extrapolating', () => {
    expect(evaluateFBlockScalar(scalarBlock, -1)).toBeCloseTo(10, 5);
    expect(evaluateFBlockScalar(scalarBlock, 5)).toBeCloseTo(0, 5);
  });

  it('returns zero for an empty block', () => {
    expect(evaluateFBlockScalar({ keys: [] }, 0.5)).toBe(0);
  });

  it('returns the single value when there is only one key', () => {
    expect(evaluateFBlockScalar({ keys: [{ time: 0.3, value: 7 }] }, 0.9)).toBeCloseTo(7, 5);
  });
});

describe('evaluateFBlockColor', () => {
  it('normalises 0-255 channels to 0-1 and interpolates', () => {
    const block = { keys: [{ time: 0, value: { x: 255, y: 0, z: 0 } },
                           { time: 1, value: { x: 0, y: 0, z: 255 } }] };
    const out = { r: 0, g: 0, b: 0 };

    evaluateFBlockColor(block, 0, out);
    expect(out).toEqual({ r: 1, g: 0, b: 0 });

    evaluateFBlockColor(block, 0.5, out);
    expect(out.r).toBeCloseTo(0.5, 3);
    expect(out.b).toBeCloseTo(0.5, 3);
  });

  it('leaves the output white for an empty block', () => {
    const out = { r: 0, g: 0, b: 0 };
    evaluateFBlockColor({ keys: [] }, 0.5, out);
    expect(out).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe('evaluateFBlockVec2', () => {
  it('reads array-shaped values and interpolates both components', () => {
    const block = { keys: [{ time: 0, value: [1, 3] }, { time: 1, value: [3, 1] }] };
    const out = { x: 0, y: 0 };

    evaluateFBlockVec2(block, 0.5, out);
    expect(out.x).toBeCloseTo(2, 5);
    expect(out.y).toBeCloseTo(2, 5);
  });

  it('leaves the output at 1,1 for an empty block', () => {
    const out = { x: 0, y: 0 };
    evaluateFBlockVec2({ keys: [] }, 0.5, out);
    expect(out).toEqual({ x: 1, y: 1 });
  });
});

describe('evaluateFBlockAlpha', () => {
  it('divides the raw int16 by 32767', () => {
    const block = { keys: [{ time: 0, value: 32767 }, { time: 1, value: 0 }] };

    expect(evaluateFBlockAlpha(block, 0)).toBeCloseTo(1, 5);
    expect(evaluateFBlockAlpha(block, 1)).toBeCloseTo(0, 5);
    expect(evaluateFBlockAlpha(block, 0.5)).toBeCloseTo(0.5, 3);
  });

  it('is fully opaque for an empty block', () => {
    expect(evaluateFBlockAlpha({ keys: [] }, 0.5)).toBe(1);
  });
});

describe('evaluateFBlockCell', () => {
  it('floors to the lower bracketing key rather than interpolating or rounding', () => {
    const block = { keys: [{ time: 0, value: 0 }, { time: 1, value: 8 }] };

    expect(evaluateFBlockCell(block, 0.1)).toBe(0);
    // Real clients hold the lower key for the whole interval and only advance at the next key's
    // own timestamp, so t=0.9 (still short of t=1) must still read the lower key (0), not the
    // upper one -- rounding to nearest would advance the frame half an interval early.
    expect(evaluateFBlockCell(block, 0.9)).toBe(0);
  });

  it('reaches the upper key only at its own timestamp', () => {
    const block = { keys: [{ time: 0, value: 0 }, { time: 1, value: 8 }] };

    expect(evaluateFBlockCell(block, 1)).toBe(8);
  });

  it('is cell zero for an empty block', () => {
    expect(evaluateFBlockCell({ keys: [] }, 0.5)).toBe(0);
  });
});

describe('evaluateAnimationTrack', () => {
  const track = {
    tracks: [
      { animationIndex: 0, timestamps: [0, 1000], values: [2, 6] },
      { animationIndex: 1, timestamps: [0], values: [9] },
    ],
  };

  it('interpolates within the requested animation', () => {
    expect(evaluateAnimationTrack(track, 0, 500, -1)).toBeCloseTo(4, 5);
  });

  it('clamps past the last timestamp', () => {
    expect(evaluateAnimationTrack(track, 0, 99999, -1)).toBeCloseTo(6, 5);
  });

  it('handles a single-key animation', () => {
    expect(evaluateAnimationTrack(track, 1, 500, -1)).toBeCloseTo(9, 5);
  });

  it('falls back to animation zero when the index is absent', () => {
    expect(evaluateAnimationTrack(track, 7, 0, -1)).toBeCloseTo(2, 5);
  });

  it('returns the fallback when the track holds nothing', () => {
    expect(evaluateAnimationTrack({ tracks: [] }, 0, 0, -1)).toBe(-1);
    expect(evaluateAnimationTrack(undefined, 0, 0, -1)).toBe(-1);
  });
});

describe('evaluateAnimationTrackStep', () => {
  const track = {
    tracks: [
      { animationIndex: 0, timestamps: [0, 1000], values: [1, 0] },
      { animationIndex: 1, timestamps: [0], values: [9] },
    ],
  };

  it('holds the lower key across the whole interval instead of interpolating', () => {
    // A flag-style track (e.g. enabledIn) must never read a blended value like 0.5 between an ON
    // key and an OFF key.
    expect(evaluateAnimationTrackStep(track, 0, 1, -1)).toBe(1);
    expect(evaluateAnimationTrackStep(track, 0, 500, -1)).toBe(1);
    expect(evaluateAnimationTrackStep(track, 0, 999, -1)).toBe(1);
  });

  it('clamps past the last timestamp', () => {
    expect(evaluateAnimationTrackStep(track, 0, 1000, -1)).toBe(0);
    expect(evaluateAnimationTrackStep(track, 0, 99999, -1)).toBe(0);
  });

  it('handles a single-key track', () => {
    expect(evaluateAnimationTrackStep(track, 1, 500, -1)).toBe(9);
  });

  it('returns the fallback when the block holds nothing', () => {
    expect(evaluateAnimationTrackStep({ tracks: [] }, 0, 0, -1)).toBe(-1);
    expect(evaluateAnimationTrackStep(undefined, 0, 0, -1)).toBe(-1);
  });
});
