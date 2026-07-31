import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import LightingControls from '../lighting-controls';
import { WeatherKind } from '../../../../game/world/light/weather';

// A stand-in for `WeatherState` carrying only what the control reads/writes. `setWeather` records its
// calls on a plain array rather than trying to reproduce the ramp -- these tests are about the panel
// wiring, not the ramp itself (that is `weather.test.ts`'s job).
const makeWeather = (
  overrides: Partial<{
    kind: WeatherKind;
    effectKind: WeatherKind;
    effectIntensity: number;
    effectDensity: number;
    skyDensity: number;
  }> = {}
) => {
  const calls: Array<[WeatherKind, number, boolean]> = [];
  return {
    kind: WeatherKind.Fine,
    effectKind: WeatherKind.Fine,
    effectIntensity: 0,
    effectDensity: 0,
    skyDensity: 0,
    ...overrides,
    setWeather: jest.fn((kind: WeatherKind, grade: number, instant: boolean) => {
      calls.push([kind, grade, instant]);
    }),
    calls,
  };
};

// A stand-in for MapLight carrying only what the control touches. Using the real MapLight here would
// drag in three.js, the DBC loader and a network fetch for a slider.
const makeMapLight = (
  overrides: Partial<{
    time: number;
    timeOverride: number | null;
    wmoBrightness: number;
    weather: ReturnType<typeof makeWeather>;
    stormBlend: number;
  }> = {}
) => ({
  time: 1440,
  timeOverride: null as number | null,
  wmoBrightness: 1.0,
  weather: makeWeather(),
  stormBlend: 0,
  ...overrides,
});

describe('LightingControls', () => {
  it('renders nothing without a map light', () => {
    const { container } = render(<LightingControls mapLight={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current time as hours and minutes', () => {
    // 1440 half-minutes = minute 720 = 12:00.
    render(<LightingControls mapLight={makeMapLight({ time: 1440 })} />);
    expect(screen.getByText(/12:00/)).toBeInTheDocument();
  });

  it('follows the clock until the override checkbox is cleared', () => {
    const mapLight = makeMapLight();
    render(<LightingControls mapLight={mapLight} />);
    const follow = screen.getByLabelText(/follow clock/i) as HTMLInputElement;
    expect(follow.checked).toBe(true);

    fireEvent.click(follow);
    // Taking manual control seeds the override from the time currently displayed, so the light does
    // not jump the instant the box is unticked.
    expect(mapLight.timeOverride).toBe(1440);
  });

  it('writes the slider position into timeOverride in half-minutes', () => {
    const mapLight = makeMapLight({ timeOverride: 1440 });
    render(<LightingControls mapLight={mapLight} />);
    // The slider is in MINUTES; MapLight wants half-minutes.
    fireEvent.change(screen.getByLabelText(/time of day/i), { target: { value: '390' } });
    expect(mapLight.timeOverride).toBe(780);
  });

  it('returns to the clock when the checkbox is re-ticked', () => {
    const mapLight = makeMapLight({ timeOverride: 780 });
    render(<LightingControls mapLight={mapLight} />);
    fireEvent.click(screen.getByLabelText(/follow clock/i));
    expect(mapLight.timeOverride).toBeNull();
  });

  it('still updates the displayed time when the same mapLight object is mutated in place', () => {
    // mapLight is the same long-lived object every frame (the parent panel force-updates and passes
    // the identical reference each time). A naive `shouldComponentUpdate` that compares
    // `this.props.mapLight !== nextProps.mapLight` would always see equal references here and freeze.
    const mapLight = makeMapLight({ time: 1440 });
    const { rerender } = render(<LightingControls mapLight={mapLight} />);
    expect(screen.getByText(/12:00/)).toBeInTheDocument();

    mapLight.time = 1500; // 750 minutes = 12:30, still the same object reference.
    rerender(<LightingControls mapLight={mapLight} />);

    expect(screen.getByText(/12:30/)).toBeInTheDocument();
  });

  it('does not re-render when nothing displayed has changed', () => {
    // This is what happens 60 times a second in the real app: the parent panel force-updates every
    // animation frame and passes the same (mutated-in-place) mapLight down again. Without
    // shouldComponentUpdate, render() would run every time and React would rewrite the controlled
    // inputs' checked/value/disabled on every commit, fighting the user's own click or drag.
    const renderSpy = jest.spyOn(LightingControls.prototype, 'render');
    const mapLight = makeMapLight({ time: 1440 });
    const { rerender } = render(<LightingControls mapLight={mapLight} />);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // Simulate the parent's per-frame forceUpdate: re-render with the same, unchanged object.
    rerender(<LightingControls mapLight={mapLight} />);
    rerender(<LightingControls mapLight={mapLight} />);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    renderSpy.mockRestore();
  });

  it('shows the current WMO brightness value', () => {
    render(<LightingControls mapLight={makeMapLight({ wmoBrightness: 2.5 })} />);
    expect(screen.getByLabelText(/wmo brightness/i)).toHaveValue('2.5');
  });

  it('writes the slider position into wmoBrightness', () => {
    const mapLight = makeMapLight({ wmoBrightness: 1.0 });
    render(<LightingControls mapLight={mapLight} />);
    fireEvent.change(screen.getByLabelText(/wmo brightness/i), { target: { value: '3.25' } });
    expect(mapLight.wmoBrightness).toBe(3.25);
  });

  it('re-renders when only wmoBrightness changes on the same mutated-in-place object', () => {
    // Same failure mode as the time-of-day case above: if wmoBrightness were left out of
    // displayState, shouldComponentUpdate would never see a difference and the slider would look
    // stuck while the underlying value kept changing.
    const renderSpy = jest.spyOn(LightingControls.prototype, 'render');
    const mapLight = makeMapLight({ wmoBrightness: 1.0 });
    const { rerender } = render(<LightingControls mapLight={mapLight} />);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    mapLight.wmoBrightness = 2.0;
    rerender(<LightingControls mapLight={mapLight} />);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(/wmo brightness/i)).toHaveValue('2');
    renderSpy.mockRestore();
  });

  it('calls setWeather with the selected kind, the staged grade and the instant flag', () => {
    const mapLight = makeMapLight();
    render(<LightingControls mapLight={mapLight} />);

    fireEvent.click(screen.getByLabelText(/instant/i));
    fireEvent.change(screen.getByLabelText(/grade/i), { target: { value: '0.75' } });
    fireEvent.change(screen.getByLabelText(/weather/i), { target: { value: String(WeatherKind.Rain) } });

    expect(mapLight.weather.calls).toEqual([
      [WeatherKind.Fine, 0.75, true],
      [WeatherKind.Rain, 0.75, true],
    ]);
  });

  it('shows both ramped weather channels and the resolved storm blend', () => {
    const mapLight = makeMapLight({
      weather: makeWeather({ effectIntensity: 0.4, effectDensity: 0.2, skyDensity: 0.125 }),
      stormBlend: 0.5,
    });
    render(<LightingControls mapLight={mapLight} />);

    expect(screen.getByText(/effect intensity.*0\.400/i)).toBeInTheDocument();
    expect(screen.getByText(/sky density.*0\.125/i)).toBeInTheDocument();
    expect(screen.getByText(/storm blend.*0\.500/i)).toBeInTheDocument();
  });

  it('re-renders when only the weather channels change on the same mutated-in-place object', () => {
    // Same trap as wmoBrightness: `weather.effectIntensity`/`skyDensity` ramp continuously while the
    // panel force-updates every frame. If they were left out of displayState, the readout would look
    // frozen while the real ramp kept moving underneath it.
    const renderSpy = jest.spyOn(LightingControls.prototype, 'render');
    const weather = makeWeather({ effectIntensity: 0, skyDensity: 0 });
    const mapLight = makeMapLight({ weather });
    const { rerender } = render(<LightingControls mapLight={mapLight} />);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    weather.effectIntensity = 0.5;
    weather.skyDensity = 0.2;
    rerender(<LightingControls mapLight={mapLight} />);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/effect intensity.*0\.500/i)).toBeInTheDocument();
    renderSpy.mockRestore();
  });

  it('re-renders when only the storm blend readout changes', () => {
    const renderSpy = jest.spyOn(LightingControls.prototype, 'render');
    const mapLight = makeMapLight({ stormBlend: 0 });
    const { rerender } = render(<LightingControls mapLight={mapLight} />);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    mapLight.stormBlend = 1;
    rerender(<LightingControls mapLight={mapLight} />);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/storm blend.*1\.000/i)).toBeInTheDocument();
    renderSpy.mockRestore();
  });
});
