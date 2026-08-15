/**
 * Startup wiring for the persistent asset cache: ask for persistent storage, report the quota we
 * were actually granted, and publish the instrument.
 *
 * Split out of `asset-cache.ts` because that module is also imported inside web workers
 * (`pipeline/wmo/group/loader/worker.js` -> `net/loader.js`), where there is no `window` to install
 * onto and no reason to request storage a second time. This half runs once, from `index.tsx`.
 */
import assetCache from './asset-cache';

export interface StorageGrant {
  /** Whether the origin's storage is exempt from the UA's own best-effort eviction. */
  persisted: boolean;
  /** Bytes the UA says this origin may use, or null if it does not report one. */
  quota: number | null;
  /** Bytes currently attributed to this origin, or null if not reported. */
  usage: number | null;
}

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) { return 'unknown'; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  if (bytes < 1024 * 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/**
 * Ask the UA to make this origin's storage persistent, and read back what it actually granted.
 *
 * The request is the whole point of the exercise. Without it Cache Storage is "best-effort" and the
 * UA may clear it under disk pressure -- which is the same eviction that made the HTTP cache
 * unreliable, reappearing one layer down. `persist()` is not guaranteed to be granted: Chrome
 * decides from site engagement, installation and bookmark signals, so the answer is REPORTED rather
 * than assumed. A refusal still leaves a working cache, just an evictable one.
 *
 * Never rejects -- a browser without the Storage API must not take the app's startup with it.
 */
export const requestPersistence = async (): Promise<StorageGrant> => {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage) {
    return { persisted: false, quota: null, usage: null };
  }

  let persisted = false;
  try {
    // `persisted()` first: re-asking when already granted is pointless, and in some UAs a repeated
    // `persist()` is what triggers a permission prompt.
    persisted = typeof storage.persisted === 'function' ? await storage.persisted() : false;
    if (!persisted && typeof storage.persist === 'function') {
      persisted = await storage.persist();
    }
  } catch {
    persisted = false;
  }

  let quota: number | null = null;
  let usage: number | null = null;
  try {
    if (typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      quota = typeof estimate.quota === 'number' ? estimate.quota : null;
      usage = typeof estimate.usage === 'number' ? estimate.usage : null;
    }
  } catch {
    // Leave both null; the cache works regardless of whether we can describe it.
  }

  return { persisted, quota, usage };
};

/**
 * Install the cache's startup half. Idempotent and safe to call before the app renders.
 *
 * Publishes `window.assetCache` -- the instrument the cold/warm measurement reads. It reports hits,
 * misses and bytes from each source, plus `census()`, which counts the entries actually in the store
 * rather than trusting the counters. Two independent readings of the same fact, because a counter
 * that only ever agrees with itself cannot catch a cache that is silently storing nothing.
 */
export const installAssetCache = (): void => {
  if (typeof window === 'undefined') { return; }

  (window as any).assetCache = {
    stats: () => assetCache.getStats(),
    resetStats: () => assetCache.resetStats(),
    census: () => assetCache.census(),
    clear: () => assetCache.clear(),
    storage: () => requestPersistence(),
  };

  Promise.all([requestPersistence(), assetCache.isAvailable()]).then(([grant, available]) => {
    (window as any).assetCacheStorage = grant;
    // `available` is awaited off a real `caches.open()`, not off the presence of `caches` -- see
    // `asset-cache.ts#isAvailable` for the failure that distinction exists to catch.
    console.log(
      `[asset-cache] available=${available} persisted=${grant.persisted} ` +
      `quota=${formatBytes(grant.quota)} usage=${formatBytes(grant.usage)}`
    );
  });
};

export default installAssetCache;
