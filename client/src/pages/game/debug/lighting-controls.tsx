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

    const following = mapLight.timeOverride === null;
    const halfMinutes = following ? mapLight.time : mapLight.timeOverride!;

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
