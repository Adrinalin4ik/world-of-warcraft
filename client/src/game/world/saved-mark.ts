/**
 * The debug position mark: one saved place, and where the client spawns after a reload.
 *
 * Lives in the game layer rather than beside the debug panel that drives it, because `World`'s
 * startup reads it too -- the panel is one consumer, not the owner. A UI module importing into
 * `world/index.ts` would invert the dependency.
 */

/** Where the mark lives. `localStorage` in the app; a plain object in tests. */
export interface MarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SavedMark {
  mapId: number;
  x: number;
  y: number;
  z: number;
}

export const SAVED_MARK_KEY = 'debug.savedCoords';

/** The browser's storage, or null where there is no window (workers, tests, SSR). */
export function defaultMarkStorage(): MarkStorage | null {
  return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
}

/**
 * Read the mark back, or null.
 *
 * Tolerates anything it finds. `localStorage` outlives builds, so a mark written by an older shape --
 * or a storage that throws outright -- must return null rather than take down the debug panel on
 * mount, or worse, the world's startup port.
 */
export function readMark(
  storage: MarkStorage | null = defaultMarkStorage(),
  key = SAVED_MARK_KEY,
): SavedMark | null {
  if (!storage) {
    return null;
  }

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

    // NaN is rejected explicitly: JSON.stringify writes it as `null`, and a mark that read back as
    // NaN would port the player to nowhere -- with the mover's settle hold armed, which looks like a
    // hang rather than a bad coordinate.
    if ([mapId, x, y, z].some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return null;
    }

    return { mapId, x, y, z };
  } catch {
    return null;
  }
}

/** Store the mark. A refused write (quota, private mode) is not fatal; the caller keeps its copy. */
export function writeMark(
  mark: SavedMark,
  storage: MarkStorage | null = defaultMarkStorage(),
  key = SAVED_MARK_KEY,
): void {
  try {
    storage?.setItem(key, JSON.stringify(mark));
  } catch {
    // Nothing to do -- the mark still holds for this session.
  }
}

export function clearMark(
  storage: MarkStorage | null = defaultMarkStorage(),
  key = SAVED_MARK_KEY,
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // As above.
  }
}
