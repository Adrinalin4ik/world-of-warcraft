import React from 'react';
import { WeatherKind } from '../../../game/world/light/weather';

/**
 * The slice of `WeatherState` (Task 2) this control drives and reads back. A structural subset
 * rather than the class itself so a plain test double can satisfy it without constructing a real
 * `WeatherState`.
 */
export type LightingControlsWeatherTarget = {
  /** The latest wire type, Fine included -- what the kind selector should show as selected. */
  kind: WeatherKind;
  /** The latest type actually spawning an effect (see `WeatherState.effectKind`'s doc). */
  effectKind: WeatherKind;
  /** Channel A's raw ramped value -- the wire grade, ramped. Live readout only. */
  effectIntensity: number;
  /** The knee-mapped spawn density (`max((A - 0.25) * 4/3, 0)`). Live readout only. */
  effectDensity: number;
  /** Channel B's current value, in the [0, 0.25] knee domain. Live readout only. */
  skyDensity: number;
  /** `WeatherState.setWeather` -- the wire's own (`kind`, `grade`, `instant`) signature. */
  setWeather(kind: WeatherKind, grade: number, instant: boolean): void;
};

/**
 * The slice of MapLight this control drives. Narrow on purpose: it keeps the component testable
 * without a renderer, a DBC load or a network fetch, and it documents exactly what the panel is
 * allowed to touch.
 */
export type LightingControlsTarget = {
  /** Time in HALF-minutes since midnight, 0..2879. */
  time: number;
  /** Manual override in half-minutes, or null to follow the clock. */
  timeOverride: number | null;
  /** WMO brightness multiplier, 1.0..4.0. 1.0 is faithful to the reference. */
  wmoBrightness: number;
  /** `MapLight.weather` -- the zone weather state machine this panel drives directly, since
   * `SMSG_WEATHER` is not wired up yet. */
  weather: LightingControlsWeatherTarget;
  /** `MapLight.stormBlend` -- the resolved storm `LightParams` lerp weight, `laws.stormBlend`
   * applied to `weather.skyDensity`. Live readout only; nothing here writes it. */
  stormBlend: number;
};

type Props = {
  mapLight: LightingControlsTarget | null;
};

/** Dropdown options for the weather kind selector, in wire-value order. */
const WEATHER_KIND_OPTIONS: Array<{ value: WeatherKind; label: string }> = [
  { value: WeatherKind.Fine, label: 'Fine' },
  { value: WeatherKind.Rain, label: 'Rain' },
  { value: WeatherKind.Snow, label: 'Snow' },
  { value: WeatherKind.Sand, label: 'Sand' },
];

const weatherKindLabel = (kind: WeatherKind) =>
  WEATHER_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? `kind ${kind}`;

type State = {
  /** Staged kind/grade/instant for the next `setWeather` call -- `WeatherState` itself only exposes
   * the ramped/last-applied values, not "what the sliders are currently sitting at". */
  selectedKind: WeatherKind;
  grade: number;
  instant: boolean;
};

/** Half-minutes since midnight to a 24-hour clock string. */
const formatGameTime = (halfMinutes: number) => {
  const minute = Math.floor(halfMinutes / 2);
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/**
 * The single definition of "what is on screen": whether the control is following the clock, and the
 * half-minutes value it is showing either way. `render` and `displayState` both go through this, so
 * they can never disagree about what is displayed.
 */
const deriveDisplay = (mapLight: LightingControlsTarget) => {
  const following = mapLight.timeOverride === null;
  const halfMinutes = following ? mapLight.time : mapLight.timeOverride!;
  return { following, halfMinutes };
};

/**
 * Everything the control actually displays, collapsed into one comparable value.
 *
 * The weather channels (`effectIntensity`/`skyDensity`) and `stormBlend` ramp continuously over the
 * ~ten-second swing, so they MUST be in this string -- any displayed value left out renders once and
 * then looks frozen while the real number keeps moving underneath it (the exact trap this component
 * already has a regression test for around `wmoBrightness`). Rounded to 3dp so float noise below the
 * readout's own precision doesn't force a render on every frame once a ramp has settled.
 */
const displayState = (mapLight: LightingControlsTarget | null) => {
  if (!mapLight) {
    return 'none';
  }
  const { following, halfMinutes } = deriveDisplay(mapLight);
  const { weather } = mapLight;
  return [
    following,
    Math.floor(halfMinutes / 2),
    mapLight.wmoBrightness,
    weather.kind,
    weather.effectKind,
    weather.effectIntensity.toFixed(3),
    weather.effectDensity.toFixed(3),
    weather.skyDensity.toFixed(3),
    mapLight.stormBlend.toFixed(3),
  ].join(':');
};

/**
 * Time-of-day driver for lighting work.
 *
 * The shader-side lighting laws are not unit-testable, so they are verified by eye -- which means
 * being able to sit at 21:30 and watch windows come up, rather than waiting for a server clock to
 * get there. `MapLight.timeOverride` has existed all along with nothing able to reach it.
 *
 * The parent panel force-updates every frame, so this reads MapLight directly as the source of truth
 * instead of mirroring it into component state, which would drift.
 */
class LightingControls extends React.Component<Props, State> {
  // What was last rendered, cached so shouldComponentUpdate can detect a real change. `mapLight` is a
  // single long-lived object mutated in place -- the same reference every frame -- so comparing
  // `this.props.mapLight` against `nextProps.mapLight` can never see a difference: both reads see the
  // *current* mutated values. The cache below is the only way to tell "what we drew" apart from
  // "what is on the object right now".
  private rendered: string | null = null;

  state: State = {
    selectedKind: this.props.mapLight?.weather.kind ?? WeatherKind.Fine,
    grade: 0,
    instant: false,
  };

  componentDidMount() {
    this.rendered = displayState(this.props.mapLight);
  }

  componentDidUpdate() {
    this.rendered = displayState(this.props.mapLight);
  }

  /**
   * The parent debug panel calls `forceUpdate()` on itself every animation frame (~60/sec), and
   * `forceUpdate()` on a parent only skips *that* component's own `shouldComponentUpdate` -- children
   * are still reconciled normally, so this is honoured. Without it, every controlled input here (the
   * checkbox's `checked`, the range's `value`/`disabled`) gets its DOM re-asserted by React on every
   * commit, 60 times a second, which fights the user's own click/drag. Compare against `this.rendered`
   * (see above), never against `this.props.mapLight` directly -- that comparison is always trivially
   * true/false regardless of real change, because the object is mutated in place rather than replaced.
   *
   * Also compares `nextState` against `this.state`: the weather selector/grade/instant toggle below
   * are local component state (see `State`'s doc), and a `setState` call must still get through even
   * when nothing on `mapLight` itself has changed yet.
   */
  shouldComponentUpdate(nextProps: Props, nextState: State) {
    const stateChanged = nextState.selectedKind !== this.state.selectedKind
      || nextState.grade !== this.state.grade
      || nextState.instant !== this.state.instant;
    return stateChanged || displayState(nextProps.mapLight) !== this.rendered;
  }

  private applyWeather = (kind: WeatherKind, grade: number, instant: boolean) => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    mapLight.weather.setWeather(kind, grade, instant);
  };

  private changeWeatherKind = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const kind = Number(event.target.value) as WeatherKind;
    this.setState({ selectedKind: kind });
    this.applyWeather(kind, this.state.grade, this.state.instant);
  };

  private scrubWeatherGrade = (event: React.ChangeEvent<HTMLInputElement>) => {
    const grade = Number(event.target.value);
    this.setState({ grade });
    this.applyWeather(this.state.selectedKind, grade, this.state.instant);
  };

  private toggleWeatherInstant = () => {
    // Instant only takes effect on the NEXT `setWeather` call (the wire's own semantics -- it is a
    // flag on the update, not a standing mode) -- toggling it alone stages the flag without ramping
    // anything.
    this.setState((state) => ({ instant: !state.instant }));
  };

  private toggleFollowClock = () => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    // Seed the override from whatever is on screen, so taking manual control does not jump the light.
    mapLight.timeOverride = mapLight.timeOverride === null ? mapLight.time : null;
  };

  private scrubTime = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    mapLight.timeOverride = Number(event.target.value) * 2;
  };

  private scrubWmoBrightness = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    mapLight.wmoBrightness = Number(event.target.value);
  };

  render() {
    const { mapLight } = this.props;
    if (!mapLight) {
      return null;
    }

    const { following, halfMinutes } = deriveDisplay(mapLight);

    return (
      <div className="lightingControls">
        <p>
          <label htmlFor="lighting-follow-clock">Follow clock</label>
          <input
            id="lighting-follow-clock"
            type="checkbox"
            checked={following}
            onChange={this.toggleFollowClock}
          />
        </p>
        <p>Time: {formatGameTime(halfMinutes)}</p>
        <p>
          <label htmlFor="lighting-time-of-day">Time of day</label>
          <input
            id="lighting-time-of-day"
            type="range"
            min={0}
            max={1439}
            step={1}
            value={Math.floor(halfMinutes / 2)}
            disabled={following}
            onChange={this.scrubTime}
          />
        </p>
        <p>
          <label htmlFor="lighting-wmo-brightness">
            WMO brightness (1.0 = faithful): {mapLight.wmoBrightness.toFixed(2)}
          </label>
          <input
            id="lighting-wmo-brightness"
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={mapLight.wmoBrightness}
            onChange={this.scrubWmoBrightness}
          />
        </p>

        <div className="divider"></div>
        <p>
          <label htmlFor="lighting-weather-kind">Weather</label>
          <select
            id="lighting-weather-kind"
            value={this.state.selectedKind}
            onChange={this.changeWeatherKind}
          >
            {WEATHER_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="lighting-weather-grade">
            Grade: {this.state.grade.toFixed(2)}
          </label>
          <input
            id="lighting-weather-grade"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={this.state.grade}
            onChange={this.scrubWeatherGrade}
          />
        </p>
        <p>
          <label htmlFor="lighting-weather-instant">Instant</label>
          <input
            id="lighting-weather-instant"
            type="checkbox"
            checked={this.state.instant}
            onChange={this.toggleWeatherInstant}
          />
        </p>
        <p>
          Kind: {weatherKindLabel(mapLight.weather.kind)} &middot; effect{' '}
          {weatherKindLabel(mapLight.weather.effectKind)}
        </p>
        <p>
          Effect intensity (A): {mapLight.weather.effectIntensity.toFixed(3)} &middot; density{' '}
          {mapLight.weather.effectDensity.toFixed(3)}
        </p>
        <p>
          Sky density (B): {mapLight.weather.skyDensity.toFixed(3)} &middot; storm blend{' '}
          {mapLight.stormBlend.toFixed(3)}
        </p>
      </div>
    );
  }
}

export default LightingControls;
