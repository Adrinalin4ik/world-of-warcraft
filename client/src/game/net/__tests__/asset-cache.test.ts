/**
 * The persistent asset cache, through `Loader#load` -- the one place every asset URL is built.
 *
 * Two tests, both on the path that matters:
 *   1. the deliverable itself -- a second load of the same asset does NOT go to the network;
 *   2. the poisoning trap -- a 200 response carrying the host's HTML error page is never stored.
 *
 * @jest-environment jsdom
 */
import Loader from '../loader';
import assetCache from '../asset-cache';

/**
 * A minimal Cache Storage stand-in. Real `cache.put` consumes the response body and real
 * `cache.match` hands back a fresh one, so this does the same -- otherwise a test would pass on a
 * body the production path could not actually have read twice.
 */
const installFakeCaches = () => {
  const entries = new Map<string, ArrayBuffer>();

  const cache = {
    match: async (uri: string) =>
      entries.has(uri) ? new Response(entries.get(uri)!) : undefined,
    put: async (uri: string, response: Response) => {
      entries.set(uri, await response.arrayBuffer());
    },
    keys: async () => [...entries.keys()],
  };

  (globalThis as any).caches = {
    open: async () => cache,
    delete: async () => true,
  };

  return entries;
};

beforeEach(() => {
  assetCache.resetStats();
});

afterEach(() => {
  delete (globalThis as any).caches;
  delete (globalThis as any).fetch;
});

it('serves a second load of the same asset from the store without touching the network', async () => {
  const entries = installFakeCaches();
  const bytes = new Uint8Array([0x42, 0x4c, 0x50, 0x32]); // "BLP2"

  const fetchMock = jest.fn(async () => new Response(bytes, { status: 200 }));
  (globalThis as any).fetch = fetchMock;

  const loader = new Loader();
  loader.prefix = 'https://host.example/12340';

  const cold = await loader.load('Textures\\SunGlare.blp');
  expect(new Uint8Array(cold)).toEqual(bytes);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // `store` is deliberately not awaited by the loader, so let its microtasks settle -- the same
  // thing a page reload gives it in production.
  await Promise.resolve();
  await Promise.resolve();

  // The key is the full absolute URL: it carries the build number and the whole path already.
  expect(entries.has('https://host.example/12340/textures/sunglare.blp')).toBe(true);

  const warm = await loader.load('Textures\\SunGlare.blp');
  expect(new Uint8Array(warm)).toEqual(bytes);
  expect(fetchMock).toHaveBeenCalledTimes(1); // still one -- the warm load made no request

  const stats = assetCache.getStats();
  expect(stats.hits).toBe(1);
  expect(stats.misses).toBe(1);
});

it('never stores the asset host\'s HTML error page', async () => {
  const entries = installFakeCaches();

  // The host answers a missing asset with a 27,150-byte `text/html` page carrying
  // `Cache-Control: max-age=14400` -- measured. This asserts the second guard, the content type,
  // by handing it back with a 200 that `loader.js`'s status check would let through.
  // Byte-by-byte rather than `TextEncoder`, which this jsdom environment does not provide.
  const html = '<!DOCTYPE html><title>404</title>';
  const markup = Uint8Array.from([...html].map((c) => c.charCodeAt(0)));
  await assetCache.store(
    'https://host.example/12340/does/not/exist.blp',
    markup.buffer,
    new Response(markup, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  );

  expect(entries.size).toBe(0);
  expect(assetCache.getStats().rejected).toBe(1);
  expect(assetCache.getStats().stored).toBe(0);
});
