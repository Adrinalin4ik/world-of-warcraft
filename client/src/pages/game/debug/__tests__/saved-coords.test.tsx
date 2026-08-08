import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import SavedCoords, { CoordStorage, SAVED_COORDS_KEY, readMark } from '../saved-coords';

/** A localStorage stand-in. Values are strings, exactly as the real one stores them. */
function makeStorage(seed: Record<string, string> = {}): CoordStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

const makePlayer = (overrides: Partial<{ mapId: number; position: any }> = {}) => ({
  mapId: 489,
  position: { x: 1310.5, y: 1463.25, z: 317.75 },
  ...overrides,
  worldport: jest.fn(),
});

describe('readMark', () => {
  it('reads a well-formed mark', () => {
    const storage = makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 1, x: 2, y: 3, z: 4 }),
    });

    expect(readMark(storage)).toEqual({ mapId: 1, x: 2, y: 3, z: 4 });
  });

  it('returns null when nothing is stored', () => {
    expect(readMark(makeStorage())).toBeNull();
  });

  it('returns null rather than throwing on corrupt JSON', () => {
    // localStorage outlives builds, so a mark from an older shape must not take the panel down.
    expect(readMark(makeStorage({ [SAVED_COORDS_KEY]: '{not json' }))).toBeNull();
  });

  it('rejects a mark with a missing or non-numeric field', () => {
    expect(readMark(makeStorage({ [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 1, x: 2 }) })))
      .toBeNull();
    expect(readMark(makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 1, x: 'a', y: 3, z: 4 }),
    }))).toBeNull();
  });

  it('rejects NaN, which JSON.stringify writes as null', () => {
    expect(readMark(makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 1, x: NaN, y: 3, z: 4 }),
    }))).toBeNull();
  });

  it('survives a storage that throws on read', () => {
    const hostile: CoordStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(readMark(hostile)).toBeNull();
  });
});

describe('SavedCoords', () => {
  it('shows no mark before anything is saved', () => {
    render(<SavedCoords player={makePlayer()} storage={makeStorage()} />);

    expect(screen.getByText(/saved: none/i)).toBeTruthy();
  });

  it('saves the current position and map', () => {
    const storage = makeStorage();
    render(<SavedCoords player={makePlayer()} storage={storage} />);

    fireEvent.click(screen.getByRole('button', { name: /save coords/i }));

    expect(JSON.parse(storage.data[SAVED_COORDS_KEY])).toEqual({
      mapId: 489, x: 1310.5, y: 1463.25, z: 317.75,
    });
  });

  it('shows the mark it just saved', () => {
    render(<SavedCoords player={makePlayer()} storage={makeStorage()} />);

    fireEvent.click(screen.getByRole('button', { name: /save coords/i }));

    expect(screen.getByText(/map 489 @ 1310\.5, 1463\.3, 317\.8/)).toBeTruthy();
  });

  it('loads a mark saved before this mount -- the reason it is persisted at all', () => {
    const storage = makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 0, x: -9293, y: -2220, z: 62 }),
    });

    render(<SavedCoords player={makePlayer()} storage={storage} />);

    expect(screen.getByText(/map 0 @ -9293\.0, -2220\.0, 62\.0/)).toBeTruthy();
  });

  it('worldports to the mark, so a cross-map mark changes zone too', () => {
    // teleportTo alone would move the mover without loading the destination map.
    const player = makePlayer();
    const storage = makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 0, x: -9293, y: -2220, z: 62 }),
    });
    render(<SavedCoords player={player} storage={storage} />);

    fireEvent.click(screen.getByRole('button', { name: /go to saved/i }));

    expect(player.worldport).toHaveBeenCalledWith(0, [-9293, -2220, 62]);
  });

  it('cannot go anywhere with no mark', () => {
    render(<SavedCoords player={makePlayer()} storage={makeStorage()} />);

    expect((screen.getByRole('button', { name: /go to saved/i }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('clears the mark from storage and from the readout', () => {
    const storage = makeStorage({
      [SAVED_COORDS_KEY]: JSON.stringify({ mapId: 1, x: 2, y: 3, z: 4 }),
    });
    render(<SavedCoords player={makePlayer()} storage={storage} />);

    fireEvent.click(screen.getByRole('button', { name: /clear/i }));

    expect(storage.data[SAVED_COORDS_KEY]).toBeUndefined();
    expect(screen.getByText(/saved: none/i)).toBeTruthy();
  });

  it('disables saving with no player yet', () => {
    render(<SavedCoords player={null} storage={makeStorage()} />);

    expect((screen.getByRole('button', { name: /save coords/i }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('keeps the mark for this session even when storage refuses the write', () => {
    const hostile: CoordStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => undefined,
    };
    render(<SavedCoords player={makePlayer()} storage={hostile} />);

    fireEvent.click(screen.getByRole('button', { name: /save coords/i }));

    expect(screen.getByText(/map 489 @/)).toBeTruthy();
  });
});
