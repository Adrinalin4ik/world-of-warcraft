/** @jest-environment node */
import { FrameStats, FRAME_BUDGET_MS } from '../frame-stats';

describe('FRAME_BUDGET_MS', () => {
  it('is the 60 fps floor', () => {
    expect(FRAME_BUDGET_MS).toBeCloseTo(1000 / 60, 10);
  });
});

describe('FrameStats', () => {
  it('reports zeros before any sample', () => {
    const stats = new FrameStats(300);
    expect(stats.summary()).toEqual({
      last: 0, p50: 0, p99: 0, worst: 0, overBudget: 0, sampleCount: 0,
    });
  });

  it('computes percentiles, worst and over-budget over 1..100 ms', () => {
    const stats = new FrameStats(300);
    for (let i = 1; i <= 100; ++i) stats.push(i);

    const s = stats.summary();
    expect(s.sampleCount).toBe(100);
    expect(s.last).toBe(100);
    expect(s.worst).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p99).toBe(99);
    // Frames strictly over 16.666... ms are 17..100 inclusive.
    expect(s.overBudget).toBe(84);
  });

  it('evicts the oldest sample once the window is full', () => {
    const stats = new FrameStats(3);
    stats.push(1); stats.push(2); stats.push(3); stats.push(4);

    const s = stats.summary();
    expect(s.sampleCount).toBe(3);
    expect(s.worst).toBe(4);
    expect(s.last).toBe(4);
    // Window holds [2,3,4]; p50 index = ceil(0.5*3)-1 = 1 -> 3.
    expect(s.p50).toBe(3);
  });

  it('does not mutate sample order when summarising twice', () => {
    const stats = new FrameStats(4);
    stats.push(9); stats.push(1); stats.push(5);
    const first = stats.summary();
    const second = stats.summary();
    expect(second).toEqual(first);
    expect(second.last).toBe(5);
  });

  it('clears everything on reset', () => {
    const stats = new FrameStats(4);
    stats.push(20);
    stats.reset();
    expect(stats.summary().sampleCount).toBe(0);
  });
});
