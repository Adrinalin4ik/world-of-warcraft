/**
 * @jest-environment node
 */
import { stormBlend } from '../laws';
import { WeatherKind, WeatherState, weatherKindFromWire } from '../weather';

/** Advance in small steps, as a frame loop would, so the ramp is exercised rather than jumped. */
const run = (state: WeatherState, seconds: number, step = 1 / 60) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    state.tick(step);
  }
};

describe('WeatherState', () => {
  it('starts fine and fully clear', () => {
    const state = new WeatherState();
    expect(state.kind).toBe(WeatherKind.Fine);
    expect(state.effectIntensity).toBeCloseTo(0, 5);
    expect(state.skyDensity).toBeCloseTo(0, 5);
  });

  it('ramps the effect channel to full over about ten seconds', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 5);
    // Half way through the swing, not yet arrived.
    expect(state.effectIntensity).toBeGreaterThan(0.3);
    expect(state.effectIntensity).toBeLessThan(0.7);
    run(state, 6);
    expect(state.effectIntensity).toBeCloseTo(1, 2);
  });

  it('ramps the SKY channel over the same ~10s, not four times slower', () => {
    // The sky channel's span scale is 4, which looks like it should take 4x as long -- but its
    // endpoints live in the [0, 0.25] knee domain, so the x4 cancels the quarter-span. Both channels
    // swing in about ten seconds. Getting this wrong makes the overcast lag the rain badly.
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 11);
    expect(state.skyDensity).toBeCloseTo(0.25, 2);
  });

  it('clamps the sky channel into the [0, 0.25] knee domain for any grade', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, true);
    expect(state.skyDensity).toBeLessThanOrEqual(0.25);
    expect(state.skyDensity).toBeGreaterThanOrEqual(0);
  });

  it('applies an instant change without ramping', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Snow, 1, true);
    expect(state.effectIntensity).toBeCloseTo(1, 5);
    expect(state.skyDensity).toBeCloseTo(0.25, 5);
    expect(state.kind).toBe(WeatherKind.Snow);
  });

  it('re-aims from the OLD TARGET when the target changes mid-ramp, not from the current value', () => {
    // The plan asked for the opposite -- re-aim from the current ramped value, so a change of mind
    // mid-swing never snaps. That is smoother and it is not what the reference does: `SetWeather`
    // writes `from <- old *target*`, so retargeting Fine five seconds into a rain upswing JUMPS the
    // channel to 1.0 and ramps down from there. benilla invented the smooth version and reverted it
    // (its own comment: "resuming from the current value was a benilla-invented smoothing"), so
    // asserting the smooth behaviour here would lock in the bug the reference already fixed.
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 5);
    const midway = state.effectIntensity;
    expect(midway).toBeGreaterThan(0.3);
    expect(midway).toBeLessThan(0.7);

    state.setWeather(WeatherKind.Fine, 0, false);
    // The jump to the old target happens on the retarget itself.
    expect(state.effectIntensity).toBeCloseTo(1, 3);
    state.tick(1 / 60);
    // ...and then it ramps DOWN from 1.0, so it is below the endpoint but still above where the
    // upswing had got to.
    expect(state.effectIntensity).toBeLessThan(1);
    expect(state.effectIntensity).toBeGreaterThan(midway);
  });

  it('ramps back down to clear', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, true);
    state.setWeather(WeatherKind.Fine, 0, false);
    run(state, 11);
    expect(state.effectIntensity).toBeCloseTo(0, 2);
    expect(state.skyDensity).toBeCloseTo(0, 2);
  });
});

describe('WeatherState effect density knee', () => {
  it('spawns nothing until channel A clears 0.25, then maps 0.25..1 onto 0..1', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 0.25, true);
    expect(state.effectIntensity).toBeCloseTo(0.25, 5);
    expect(state.effectDensity).toBeCloseTo(0, 5);

    state.setWeather(WeatherKind.Rain, 1, true);
    expect(state.effectDensity).toBeCloseTo(1, 5);

    state.setWeather(WeatherKind.Rain, 0.625, true);
    expect(state.effectDensity).toBeCloseTo(0.5, 5);
  });

  it('gives the ramped density only to the active effect type', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Snow, 1, true);
    expect(state.densityFor(WeatherKind.Snow)).toBeCloseTo(1, 5);
    expect(state.densityFor(WeatherKind.Rain)).toBe(0);
  });

  it('cuts the effect type over at once on a type change, including to Fine', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, true);
    expect(state.effectKind).toBe(WeatherKind.Rain);
    state.setWeather(WeatherKind.Fine, 0, false);
    expect(state.effectKind).toBe(WeatherKind.Fine);
    expect(state.densityFor(WeatherKind.Rain)).toBe(0);
  });
});

describe('the overcast leads the rain up and clears immediately down', () => {
  it('has the storm blend already engaged while nothing is yet falling', () => {
    // Channel B ramps linearly across the whole swing; channel A must clear its 0.25 knee first.
    // So a couple of seconds into an upswing the fog is visibly in and no rain has started.
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 2);
    expect(stormBlend(state.skyDensity)).toBeGreaterThan(0.15);
    expect(state.effectDensity).toBe(0);
  });
});

describe('weatherKindFromWire', () => {
  it('decodes the wire type word, treating anything unrecognised as fine', () => {
    expect(weatherKindFromWire(0)).toBe(WeatherKind.Fine);
    expect(weatherKindFromWire(1)).toBe(WeatherKind.Rain);
    expect(weatherKindFromWire(2)).toBe(WeatherKind.Snow);
    expect(weatherKindFromWire(3)).toBe(WeatherKind.Sand);
    expect(weatherKindFromWire(99)).toBe(WeatherKind.Fine);
  });
});
