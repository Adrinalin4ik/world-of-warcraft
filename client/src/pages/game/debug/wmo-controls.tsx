import React from 'react';

import { WmoDebugMode } from '../../../game/world/wmo-debug';

/** The slice of `WmoDebug` this section drives. */
export type WmoControlsTarget = {
  mode: WmoDebugMode;
  /** How many group meshes the last sync had overridden -- confirms the toggle reached anything. */
  overridden: number;
};

type Props = {
  wmo: WmoControlsTarget | null;
};

const OPTIONS: Array<{ value: WmoDebugMode; label: string; hint: string }> = [
  { value: WmoDebugMode.Off, label: 'real material', hint: '' },
  {
    value: WmoDebugMode.VertexColor,
    label: 'MOCV vertex colour',
    hint: 'what you see IS the loader\'s vertex colour: no combiner, no light, no x2, no fog. '
      + 'Mid-grey is a fully lit surface under the shader\'s doubling; black leaves the light term '
      + 'nothing to multiply.',
  },
  {
    value: WmoDebugMode.Flat,
    label: 'flat white',
    hint: 'geometry and draw only -- ignores both texture and MOCV.',
  },
];

/**
 * The WMO surfaces section: draw buildings with something other than their own material.
 *
 * The bisection that settled the character body, pointed at WMOs. A building's black faces cannot be
 * diagnosed from averages -- on the house that mattered, 1837 of 2016 vertices read below byte 51
 * with a maximum of exactly 127, which cannot separate "the data is dark" from "the dark vertices are
 * not the faces on screen". Painting the values answers it at a glance.
 */
export default class WmoControls extends React.Component<Props> {
  private select = (mode: WmoDebugMode) => {
    const wmo = this.props.wmo;
    if (!wmo) {
      return;
    }
    wmo.mode = mode;
    this.forceUpdate();
  };

  render() {
    const wmo = this.props.wmo;

    if (!wmo) {
      return <div className="wmo_controls">no world yet</div>;
    }

    const active = OPTIONS.find((o) => o.value === wmo.mode);

    return (
      <div className="wmo_controls">
        { OPTIONS.map((option) => (
          <p key={option.value}>
            <label>
              <input
                type="radio"
                name="wmoDebugMode"
                checked={wmo.mode === option.value}
                onChange={() => this.select(option.value)}
              />
              &nbsp;{option.label}
            </label>
          </p>
        )) }

        <p>groups overridden: { wmo.overridden }</p>

        { active && active.hint && <p className="wmo_controls-hint">{ active.hint }</p> }
      </div>
    );
  }
}
