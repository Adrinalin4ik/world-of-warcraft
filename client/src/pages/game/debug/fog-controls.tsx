import React from 'react';

/** The slice of `FogDebug` this control drives. */
export type FogControlsTarget = {
  disabled: boolean;
  /** Materials neutralised on the last sync, so a toggle that reached nothing is visible. */
  applied: number;
};

type Props = {
  fog: FogControlsTarget | null;
};

/**
 * Turn fog off globally.
 *
 * One uniform does it for every family: M2, WMO and terrain all read the same `fogParams` ramp
 * (`f1 = distance * x + y`, `factor = 1 - clamp(f1, 0, 1)`), so `x = 0, y = 1` pins the factor at
 * zero everywhere. Nothing to restore -- the per-frame light pass re-copies the real values as soon
 * as this is switched off.
 */
export default class FogControls extends React.Component<Props> {
  private toggle = (disabled: boolean) => {
    const fog = this.props.fog;
    if (!fog) {
      return;
    }
    fog.disabled = disabled;
    this.forceUpdate();
  };

  render() {
    const fog = this.props.fog;

    if (!fog) {
      return null;
    }

    return (
      <div className="fog_controls">
        <p>
          <label>
            <input
              type="checkbox"
              checked={fog.disabled}
              onChange={(e) => this.toggle(e.target.checked)}
            />
            &nbsp;Fog off (M2 + WMO + terrain)
          </label>
        </p>
        { fog.disabled && <p>materials neutralised: { fog.applied }</p> }
      </div>
    );
  }
}
