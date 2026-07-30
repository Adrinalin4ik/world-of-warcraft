import React from 'react';

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
};

type Props = {
  mapLight: LightingControlsTarget | null;
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

/** Everything the control actually displays, collapsed into one comparable value. */
const displayState = (mapLight: LightingControlsTarget | null) => {
  if (!mapLight) {
    return 'none';
  }
  const { following, halfMinutes } = deriveDisplay(mapLight);
  return `${following}:${Math.floor(halfMinutes / 2)}`;
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
class LightingControls extends React.Component<Props> {
  // What was last rendered, cached so shouldComponentUpdate can detect a real change. `mapLight` is a
  // single long-lived object mutated in place -- the same reference every frame -- so comparing
  // `this.props.mapLight` against `nextProps.mapLight` can never see a difference: both reads see the
  // *current* mutated values. The cache below is the only way to tell "what we drew" apart from
  // "what is on the object right now".
  private rendered: string | null = null;

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
   */
  shouldComponentUpdate(nextProps: Props) {
    return displayState(nextProps.mapLight) !== this.rendered;
  }

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

  render() {
    const { mapLight } = this.props;
    if (!mapLight) {
      return null;
    }

    const { following, halfMinutes } = deriveDisplay(mapLight);

    return (
      <div className="lightingControls">
        <h2>Lighting</h2>
        <div className="divider"></div>
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
      </div>
    );
  }
}

export default LightingControls;
