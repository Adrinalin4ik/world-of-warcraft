/** @jest-environment node */
import { animCounters } from '../counters';

describe('animCounters', () => {
  beforeEach(() => animCounters.reset());

  it('starts at zero', () => {
    expect(animCounters.snapshot()).toEqual({
      resident: 0, posed: 0, skipped: 0, bonesSolved: 0, posesApplied: 0,
      materialsEvaluated: 0,
    });
  });

  it('accumulates within a frame', () => {
    animCounters.resident = 12;
    animCounters.posed += 3;
    animCounters.posed += 2;
    animCounters.bonesSolved += 40;
    animCounters.materialsEvaluated += 7;
    expect(animCounters.snapshot()).toEqual({
      resident: 12, posed: 5, skipped: 0, bonesSolved: 40, posesApplied: 0,
      materialsEvaluated: 7,
    });
  });

  it('reset clears every field, so a frame never inherits the last one', () => {
    animCounters.resident = 9;
    animCounters.posed = 9;
    animCounters.skipped = 9;
    animCounters.bonesSolved = 9;
    animCounters.posesApplied = 9;
    animCounters.materialsEvaluated = 9;
    animCounters.reset();
    expect(animCounters.snapshot()).toEqual({
      resident: 0, posed: 0, skipped: 0, bonesSolved: 0, posesApplied: 0,
      materialsEvaluated: 0,
    });
  });
});
