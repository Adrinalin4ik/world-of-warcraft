/**
 * A persistent, browser-managed store for the game's own asset files.
 *
 * WHY THIS EXISTS. The asset host already sends good caching headers -- measured on
 * `https://data-direct.spelunkerdb.com/12340/dbfilesclient/map.dbc`: `Cache-Control: max-age=14400`,
 * an `etag`, a `Last-Modified` and a `cf-cache-status` of REVALIDATED. So HTTP caching was never
 * missing. What fails is RETENTION: the browser's HTTP cache is a single shared pool with its own
 * eviction, and this client streams enough data through it to push its own entries out --
 * `dbfilesclient/spell.dbc` alone is 48,967,121 bytes (measured with curl). The complaint "долго
 * скачиваются, хочется чтобы один раз скачал" is that eviction, not a missing header.
 *
 * Cache Storage is the fix because it is the one web store the UA does not evict on its own
 * schedule, and `navigator.storage.persist()` (requested at startup, see `index.tsx`) takes it out
 * of best-effort eviction entirely.
 *
 * WHY NOT A SERVICE WORKER. `workbox-webpack-plugin` is already a dependency and `index.tsx` has a
 * `serviceWorker.unregister()` sitting there, so a SW was the obvious route and it is deliberately
 * NOT taken. A service worker caches by INTERCEPTING fetches, which puts it in front of every
 * request the page makes -- including the dev server's hot-reload channel and anything else on the
 * page's own origin. This module is called from exactly one place (`net/loader.js#load`) and
 * intercepts nothing, so no request that is not a game asset can pass through it. That is a
 * structural guarantee rather than a scoping rule someone has to keep correct.
 *
 * THE KEY is the full absolute asset URL, e.g.
 * `https://data-direct.spelunkerdb.com/12340/dbfilesclient/map.dbc`. It therefore carries the build
 * number and the complete path already, with no key-building of our own to get wrong. Point the
 * client at another build (`REACT_APP_DATA_URI`) and every key changes with it, so a 12340 asset can
 * never be served for a different build.
 *
 * INVALIDATION POLICY: none, deliberately, and here is why that is safe. These are extracted files
 * from a frozen game build -- 3.3.5a build 12340 shipped in 2010 and the served copies carry a
 * `Last-Modified` of 2023 -- so the bytes behind a given URL do not change. The host's 4-hour
 * `max-age` is a CDN freshness policy for mutable web content, not a statement that this .dbc will
 * differ in four hours. We do not revalidate, because there is nothing to revalidate against.
 * The two escape hatches, for the case where that reasoning is ever wrong:
 *   - `CACHE_NAME`'s `-v1` suffix. Bumping it orphans the whole previous cache at once, which is the
 *     right lever if we ever change WHAT we store (raw bodies today).
 *   - `window.assetCache.clear()` at runtime.
 *
 * EVICTION POLICY: none of our own. We never delete an entry to make room, and there is no LRU. The
 * full extracted 12340 tree the client actually touches is small against a persisted origin's quota
 * (reported at startup; typically tens of GB on a desktop). Adding an LRU would mean tracking access
 * times and choosing a bound, and a wrong bound reintroduces exactly the eviction being fixed. If a
 * write fails -- quota exhausted or otherwise -- `store` swallows it and the asset is simply fetched
 * again next time, so the failure mode is the old behaviour and never a broken load.
 */

/**
 * Bumping the version suffix orphans every previously stored entry. Change it when the STORED FORM
 * changes, not when an asset does -- see the invalidation policy above.
 */
const CACHE_NAME = 'wow-assets-v1';

/**
 * A 404 from the asset host is an HTML error page with a 27,150-byte body, and -- measured -- it is
 * served with `Cache-Control: max-age=14400` just like a real asset, so it is exactly the thing a
 * naive cache would keep forever. Handing that markup to a BLP or DBC decoder produces an error
 * naming the decoder, not the missing file, which is a defect that costs days to trace.
 *
 * `net/loader.js#load` already rejects a non-ok response, so the status check below is the primary
 * guard. This content-type check is the second one, against a host that ever answers 200 with an
 * error page. It is safe to be this blunt because NO legitimate asset is served as HTML -- measured
 * against the live host: `.toc`, `.lua`, `.blp` and `.dbc` come back with no `content-type` header
 * at all, and `.xml` comes back as `application/xml`. Only the error page is `text/html`.
 */
const isErrorPage = (response: Response): boolean =>
  (response.headers.get('content-type') || '').toLowerCase().includes('text/html');

/**
 * THESE COUNTERS ARE PER-REALM, and reading them as a whole-app total is wrong.
 *
 * This module is instantiated separately in the window and in every web worker
 * (`pipeline/wmo/group/loader/worker.js` and friends reach it through `net/loader.js`), and each
 * copy counts only its own traffic. All copies write to the SAME origin-wide Cache Storage, so the
 * store is shared while the statistics are not.
 *
 * Measured on a cold offline-world load: the window's copy reported 316 misses while `census()`
 * reported 2,586 entries in the cache -- the other ~2,270 were fetched and stored by workers. Use
 * `census()` (origin-wide) or `navigator.storage.estimate()` for a total; use these counters for
 * "did the main thread go to the network".
 */
export interface AssetCacheStats {
  /** Served out of Cache Storage, no network request made. */
  hits: number;
  /** Not in Cache Storage; the loader went to the network. */
  misses: number;
  /** Responses successfully written to Cache Storage. */
  stored: number;
  /** Responses the guards refused to store (see `isErrorPage`). */
  rejected: number;
  /** Writes that threw -- quota, or the store being unavailable. */
  writeErrors: number;
  bytesFromCache: number;
  bytesFromNetwork: number;
}

const stats: AssetCacheStats = {
  hits: 0,
  misses: 0,
  stored: 0,
  rejected: 0,
  writeErrors: 0,
  bytesFromCache: 0,
  bytesFromNetwork: 0,
};

/**
 * Cache Storage is a secure-context API. It is present on localhost and on https, and absent on a
 * plain-http LAN address -- where this must degrade to the pre-existing fetch-every-time behaviour
 * rather than throw. Read off `globalThis` because the asset loaders also run inside web workers
 * (`pipeline/wmo/group/loader/worker.js`), where `window` does not exist.
 */
const cacheStorage = (): CacheStorage | null => {
  try {
    const store = (globalThis as any).caches;
    return store && typeof store.open === 'function' ? (store as CacheStorage) : null;
  } catch {
    // Some privacy modes throw on the property access itself rather than returning undefined.
    return null;
  }
};

/**
 * Whether the store can actually be OPENED, which is not the same question as whether `caches`
 * exists -- and the difference is a measured failure, not a hypothetical. Under a long profile path
 * Chrome exposes a perfectly normal `caches` object whose every `open()` rejects with
 * `UnknownError: ... Unexpected internal error`. A presence check answers "yes" there and the whole
 * cache is silently inert, so this awaits a real open.
 */
export const isAvailable = async (): Promise<boolean> => (await open()) !== null;

let openHandle: Promise<Cache | null> | null = null;

const open = (): Promise<Cache | null> => {
  if (!openHandle) {
    const store = cacheStorage();
    openHandle = store
      ? store.open(CACHE_NAME).catch(() => null)
      : Promise.resolve(null);
  }
  return openHandle;
};

/**
 * Look an asset up. Returns its bytes on a hit and `null` on a miss.
 *
 * Never rejects: a store that cannot be read is counted as a miss, so a broken cache costs a
 * download and not a failed load.
 *
 * An UNAVAILABLE store counts as a miss too, deliberately. The alternative reads far worse under
 * the failure that actually happened: an arm that ran with the cache inert reported `misses: 0`
 * beside 316 real downloads, which looks like "nothing was requested" rather than like a fault.
 * `census().available` is what says WHY; these counters say what the loader did.
 */
export const lookup = async (uri: string): Promise<ArrayBuffer | null> => {
  try {
    const cache = await open();
    if (!cache) { stats.misses++; return null; }

    const hit = await cache.match(uri);
    if (!hit) {
      stats.misses++;
      return null;
    }

    const body = await hit.arrayBuffer();
    stats.hits++;
    stats.bytesFromCache += body.byteLength;
    return body;
  } catch {
    stats.misses++;
    return null;
  }
};

/**
 * Write an asset that has been fetched AND fully read.
 *
 * Takes the decoded `body` rather than the `Response`, and that ordering is the point. The obvious
 * shape -- `cache.put(uri, response.clone())` before reading -- can store a TRUNCATED asset: a
 * response whose body stream errors part-way (a short read, a dropped connection) rejects at
 * `arrayBuffer()`, so the caller correctly sees a failure, but the clone handed to `put` has already
 * been accepted. That writes a partial file under a permanent key, and every later session decodes
 * garbage from cache with no network request to blame. Reading first means only a complete body can
 * ever be stored. `response` is still passed, unread, for its headers.
 *
 * Never rejects, for the same reason `lookup` does not: a write that fails must cost a re-download
 * next session, never this session's load.
 */
export const store = async (uri: string, body: ArrayBuffer, response: Response): Promise<void> => {
  try {
    // `loader.js` has already rejected a non-ok response before reaching here; this repeats the
    // check so the guarantee holds for any future caller too.
    //
    // The zero-length guard is the cheap half of the same worry as the truncation one above: an
    // empty file is not a legitimate asset here and is never worth making permanent.
    if (!response.ok || isErrorPage(response) || body.byteLength === 0) {
      stats.rejected++;
      return;
    }

    const cache = await open();
    if (!cache) { return; }

    // A fresh Response over the bytes we actually read. The host's own headers are deliberately not
    // carried over: nothing revalidates (see the invalidation policy), so an `etag` or a `max-age`
    // in the store would be dead weight that later reads might be tempted to act on.
    await cache.put(uri, new Response(body));
    stats.stored++;
  } catch {
    stats.writeErrors++;
  }
};

/** Record a network-sourced body against the stats, so cold and warm runs are comparable. */
export const recordNetworkBytes = (bytes: number): void => {
  stats.bytesFromNetwork += bytes;
};

export const getStats = (): AssetCacheStats => ({ ...stats });

export const resetStats = (): void => {
  stats.hits = 0;
  stats.misses = 0;
  stats.stored = 0;
  stats.rejected = 0;
  stats.writeErrors = 0;
  stats.bytesFromCache = 0;
  stats.bytesFromNetwork = 0;
};

/** How many assets are held, and the cache's own name. The instrument's independent check. */
export const census = async (): Promise<{ name: string; entries: number; available: boolean }> => {
  const cache = await open();
  if (!cache) { return { name: CACHE_NAME, entries: 0, available: false }; }
  const keys = await cache.keys();
  return { name: CACHE_NAME, entries: keys.length, available: true };
};

/** The manual invalidation lever named in the policy above. */
export const clear = async (): Promise<boolean> => {
  const store_ = cacheStorage();
  if (!store_) { return false; }
  openHandle = null;
  return store_.delete(CACHE_NAME);
};

export default { lookup, store, recordNetworkBytes, getStats, resetStats, census, clear, isAvailable };
