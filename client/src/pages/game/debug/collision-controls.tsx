import React from 'react';

import { COLLISION_DEBUG_COLORS, CollisionDebugCounts } from '../../../game/collision/debug-view';
import { CollisionLayer } from '../../../game/collision/types';

/**
 * The slice of `CollisionDebugView` this section drives. Structural rather than the class itself,
 * for the same reason `LightingControlsTarget` is: a plain object satisfies it, so the component is
 * testable without a renderer, a scene or any loaded world.
 */
export type CollisionControlsTarget = {
  /** Draw the wireframe at all. Nothing is gathered while this is off. */
  enabled: boolean;
  /** Draw through walls. */
  xray: boolean;
  /** Half-extent of the gathered box around the player (yards). */
  radius: number;
  /** Which MOPY-filtered audience to show. */
  layer: CollisionLayer;
  /** Last rebuild's gathered totals, plus what is registered world-wide. */
  counts: CollisionDebugCounts;
  /** Force a rebuild now rather than waiting for the player to move. */
  invalidate(): void;
};

type Props = {
  view: CollisionControlsTarget | null;
};

const RADIUS_OPTIONS = [10, 25, 50, 100];

const swatch = (color: { getHexString(): string }): React.CSSProperties => ({
  display: 'inline-block',
  width: '8px',
  height: '8px',
  marginRight: '4px',
  background: `#${color.getHexString()}`,
});

/**
 * The Collisions section of the debug panel.
 *
 * What it shows is deliberately the GATHER, not the scene: collision comes from the WMO BSP, the
 * MCVT heightmap and each M2's authored hull, so "the wall is drawn" and "the wall collides" are
 * independent facts. Every collision defect here so far has been a face that was drawn but never
 * gathered, and the per-provider counts below are what separate the two in one glance -- a doodad
 * count of 0 standing in a forest is a registration bug, not a cast bug.
 */
export default class CollisionControls extends React.Component<Props> {
  /**
   * The target is a live mutable object, not React state -- it is the running overlay. Writing to
   * it and forcing a repaint is the whole update path; the panel's own 4 Hz repaint keeps the
   * counts below fresh between interactions.
   */
  private apply(mutate: (view: CollisionControlsTarget) => void) {
    const view = this.props.view;
    if (!view) {
      return;
    }
    mutate(view);
    this.forceUpdate();
  }

  render() {
    const view = this.props.view;

    if (!view) {
      return <div className="collision_controls">no world yet</div>;
    }

    const { counts } = view;

    return (
      <div className="collision_controls">
        <p>
          <label>
            <input
              type="checkbox"
              checked={view.enabled}
              onChange={(e) => this.apply((v) => { v.enabled = e.target.checked; })}
            />
            &nbsp;Show collision geometry
          </label>
        </p>

        <p>
          <label>
            <input
              type="checkbox"
              checked={view.xray}
              disabled={!view.enabled}
              onChange={(e) => this.apply((v) => { v.xray = e.target.checked; })}
            />
            &nbsp;X-ray (draw through walls)
          </label>
        </p>

        <p>
          Audience:&nbsp;
          <select
            value={view.layer}
            disabled={!view.enabled}
            onChange={(e) => this.apply((v) => { v.layer = e.target.value as CollisionLayer; })}
          >
            <option value={CollisionLayer.Walk}>walk (drops DETAIL)</option>
            <option value={CollisionLayer.Camera}>camera (drops NOCAMCOLLIDE)</option>
          </select>
        </p>

        <p>
          Radius:&nbsp;
          <select
            value={view.radius}
            disabled={!view.enabled}
            onChange={(e) => this.apply((v) => { v.radius = Number(e.target.value); })}
          >
            { RADIUS_OPTIONS.map((r) => (
              <option key={r} value={r}>{r} yd</option>
            )) }
          </select>
          &nbsp;
          <button
            type="button"
            disabled={!view.enabled}
            onClick={() => this.apply((v) => v.invalidate())}
          >
            rebuild
          </button>
        </p>

        <div className="divider"></div>

        <p>Gathered faces</p>
        <p>
          <span style={swatch(COLLISION_DEBUG_COLORS.terrain)}></span>
          terrain: { counts.terrain }
        </p>
        <p>
          <span style={swatch(COLLISION_DEBUG_COLORS.wmo)}></span>
          wmo: { counts.wmo }
        </p>
        <p>
          <span style={swatch(COLLISION_DEBUG_COLORS.doodad)}></span>
          doodads: { counts.doodad }
        </p>
        <p>total: { counts.total }</p>

        <div className="divider"></div>

        <p>Registered</p>
        <p>terrain chunks: { counts.registeredChunks }</p>
        <p>wmo groups: { counts.registeredWmoGroups }</p>
        <p>m2 hulls: { counts.registeredHulls }</p>
      </div>
    );
  }
}
