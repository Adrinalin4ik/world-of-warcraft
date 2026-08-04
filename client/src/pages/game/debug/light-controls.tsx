import React from 'react';

/** The slice of `LightDebug` this control drives. */
export type LightControlsTarget = {
  disabled: boolean;
  /** Materials neutralised on the last sync, so a switch that reached nothing is visible. */
  applied: number;
};

type Props = {
  light: LightControlsTarget | null;
};

/**
 * Turn scene lighting off globally: every surface at its own albedo.
 *
 * Worth knowing what it does per family, because they differ. On WMO it takes the shader's own UNLIT
 * branch, which is `tex x wmoBrightness` and skips MOCV entirely -- so a building that only goes black
 * because its MOCV is zero comes back textured here, while one that is black for any other reason
 * stays black. On M2 and terrain it pins the light term to white.
 */
export default class LightControls extends React.Component<Props> {
  private toggle = (disabled: boolean) => {
    const light = this.props.light;
    if (!light) {
      return;
    }
    light.disabled = disabled;
    this.forceUpdate();
  };

  render() {
    const light = this.props.light;

    if (!light) {
      return null;
    }

    return (
      <div className="light_controls">
        <p>
          <label>
            <input
              type="checkbox"
              checked={light.disabled}
              onChange={(e) => this.toggle(e.target.checked)}
            />
            &nbsp;Scene lighting off (albedo only)
          </label>
        </p>
        { light.disabled && (
          <>
            <p>materials neutralised: { light.applied }</p>
            <p className="light_controls-hint">
              on WMO this takes the shader&apos;s unlit branch, which skips MOCV too
            </p>
          </>
        ) }
      </div>
    );
  }
}
