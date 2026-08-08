/** @jest-environment node */
import { worldClock } from '../world-clock';

describe('worldClock', () => {
  beforeEach(() => {
    worldClock.reset();
  });

  it('starts at zero', () => {
    expect(worldClock.ms).toBe(0);
    expect(worldClock.frameIndex).toBe(0);
  });

  it('accumulates seconds as milliseconds', () => {
    worldClock.advance(0.016);
    worldClock.advance(0.016);
    expect(worldClock.ms).toBeCloseTo(32, 6);
  });

  it('counts one frame per advance', () => {
    worldClock.advance(0.016);
    worldClock.advance(0.016);
    worldClock.advance(0.016);
    expect(worldClock.frameIndex).toBe(3);
  });

  it('never goes backwards on a negative delta', () => {
    worldClock.advance(1);
    worldClock.advance(-5);
    expect(worldClock.ms).toBeCloseTo(1000, 6);
  });

  it('rejects a non-finite delta rather than poisoning every armed cursor', () => {
    worldClock.advance(1);
    worldClock.advance(NaN);
    worldClock.advance(Infinity);
    expect(Number.isFinite(worldClock.ms)).toBe(true);
    expect(worldClock.ms).toBeCloseTo(1000, 6);
  });

  it('still counts frames for a rejected delta, so decimation phase keeps moving', () => {
    worldClock.advance(NaN);
    worldClock.advance(NaN);
    expect(worldClock.frameIndex).toBe(2);
  });

  it('is one shared instance, not a per-importer copy', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const again = require('../world-clock').worldClock;
    worldClock.advance(0.5);
    expect(again.ms).toBeCloseTo(500, 6);
  });
});
