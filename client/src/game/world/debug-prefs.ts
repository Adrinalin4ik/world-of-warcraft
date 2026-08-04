/**
 * Persistence for the debug panel's own switches.
 *
 * Debugging this client means reloading constantly, and a switch that reset on every reload made the
 * before/after comparison it exists for impossible to hold: you reload to test a code change and lose
 * the very state you were comparing against.
 *
 * Deliberately in the game layer next to the debug singletons that own the state, not in the panel:
 * the singletons are constructed before any panel mounts, and they are what the render loop reads.
 */

const PREFIX = 'debug.pref.';

/** Storage, or null where there is no window. */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read a preference, or `fallback`.
 *
 * Type-checked against the fallback: `localStorage` outlives builds, so a value written by an older
 * shape must not come back as the wrong type and be pushed into a uniform.
 */
export function loadPref<T extends string | boolean>(key: string, fallback: T): T {
  const store = storage();
  if (!store) {
    return fallback;
  }

  let raw: string | null = null;

  try {
    raw = store.getItem(PREFIX + key);
  } catch {
    return fallback;
  }

  if (raw === null) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === typeof fallback ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string | boolean): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // A refused write costs the next reload's state and nothing else.
  }
}
