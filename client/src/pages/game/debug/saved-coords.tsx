import React from 'react';

import {
  MarkStorage, SAVED_MARK_KEY, SavedMark, clearMark, defaultMarkStorage, readMark, writeMark,
} from '../../../game/world/saved-mark';

// Re-exported so the panel's own module stays the one surface a caller needs; the storage itself is
// owned by the game layer, because `World`'s startup port reads the same mark.
export type { MarkStorage as CoordStorage, SavedMark };
export { SAVED_MARK_KEY as SAVED_COORDS_KEY, readMark };

/**
 * The slice of `Player` this control needs.
 *
 * `worldport` rather than `teleportTo`: it relocates the mover, arms the settle hold AND changes zone
 * when the mark was dropped on another map. A mark is only useful if returning to it works from
 * wherever you happen to be.
 */
export type SavedCoordsTarget = {
  mapId: number;
  position: { x: number; y: number; z: number };
  worldport(mapId: number, coords: number[]): void;
};

type Props = {
  player: SavedCoordsTarget | null;
  storage?: MarkStorage;
};

type State = {
  mark: SavedMark | null;
};

const fixed = (v: number) => v.toFixed(1);

/**
 * Save the player's position and jump back to it.
 *
 * Persisted, deliberately: debugging this client means reloading constantly, and a mark that did not
 * survive a reload would have to be re-walked every time -- which is most of what it exists to avoid.
 * `World`'s startup reads the same mark and spawns there, so a reload lands where the mark is.
 */
export default class SavedCoords extends React.Component<Props, State> {
  private get storage(): MarkStorage | null {
    return this.props.storage ?? defaultMarkStorage();
  }

  state: State = { mark: null };

  componentDidMount() {
    this.setState({ mark: readMark(this.storage) });
  }

  private save = () => {
    const player = this.props.player;
    if (!player) {
      return;
    }

    const mark: SavedMark = {
      mapId: player.mapId,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
    };

    writeMark(mark, this.storage);
    this.setState({ mark });
  };

  private go = () => {
    const player = this.props.player;
    const mark = this.state.mark;
    if (!player || !mark) {
      return;
    }

    player.worldport(mark.mapId, [mark.x, mark.y, mark.z]);
  };

  private clear = () => {
    clearMark(this.storage);
    this.setState({ mark: null });
  };

  render() {
    const { player } = this.props;
    const { mark } = this.state;

    return (
      <div className="saved_coords">
        <p>
          <button type="button" disabled={!player} onClick={this.save}>save coords</button>
          &nbsp;
          <button type="button" disabled={!player || !mark} onClick={this.go}>go to saved</button>
          &nbsp;
          <button type="button" disabled={!mark} onClick={this.clear}>clear</button>
        </p>
        <p>
          { mark
            ? `saved: map ${mark.mapId} @ ${fixed(mark.x)}, ${fixed(mark.y)}, ${fixed(mark.z)}`
            : 'saved: none' }
        </p>
        <p>a saved mark is also where a page reload spawns</p>
      </div>
    );
  }
}
