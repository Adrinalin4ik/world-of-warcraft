import React from 'react';

/** Where the mark lives. `localStorage` in the app; a plain object in tests. */
export interface CoordStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

export interface SavedMark {
  mapId: number;
  x: number;
  y: number;
  z: number;
}

export const SAVED_COORDS_KEY = 'debug.savedCoords';

/**
 * Read the mark back, or null.
 *
 * Tolerates anything: this is `localStorage`, which survives across builds, so a mark written by an
 * older shape must not throw on load and take the whole debug panel down with it.
 */
export function readMark(storage: CoordStorage, key = SAVED_COORDS_KEY): SavedMark | null {
  let raw: string | null = null;

  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const { mapId, x, y, z } = parsed ?? {};

    if ([mapId, x, y, z].some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return null;
    }

    return { mapId, x, y, z };
  } catch {
    return null;
  }
}

type Props = {
  player: SavedCoordsTarget | null;
  storage?: CoordStorage;
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
 */
export default class SavedCoords extends React.Component<Props, State> {
  private get storage(): CoordStorage | null {
    if (this.props.storage) {
      return this.props.storage;
    }
    return typeof window !== 'undefined' ? window.localStorage : null;
  }

  state: State = { mark: null };

  componentDidMount() {
    const storage = this.storage;
    if (storage) {
      this.setState({ mark: readMark(storage) });
    }
  }

  private save = () => {
    const player = this.props.player;
    const storage = this.storage;
    if (!player || !storage) {
      return;
    }

    const mark: SavedMark = {
      mapId: player.mapId,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
    };

    try {
      storage.setItem(SAVED_COORDS_KEY, JSON.stringify(mark));
    } catch {
      // A full or blocked storage should not lose the mark for this session.
    }

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
    const storage = this.storage;

    try {
      storage?.removeItem(SAVED_COORDS_KEY);
    } catch {
      // Nothing to do; the state below is what the panel reads.
    }

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
      </div>
    );
  }
}
