/**
 * Fetching a `.toc` manifest and everything it (transitively) names, for ANY of the client's
 * interface directories.
 *
 * This was `runtime.ts`'s own private `prefetch`, hard-coded to `Interface\GlueXML\`. It is a module
 * of its own now because there are two callers with nothing else in common: the glue runtime
 * (`GlueXML.toc`, 17 files) and the world runtime (`FrameXML.toc`, 139 entries). The four decisions
 * `runtime.ts`'s header records still hold verbatim and are not repeated here -- in particular that
 * everything is prefetched before anything runs, because `loadDocument`'s resolver is synchronous by
 * design and the asset host is not.
 *
 * A file that cannot be fetched is simply ABSENT from the cache. The loader reports the miss itself,
 * per reference, so one missing include costs an include rather than the screen.
 */
import Loader from '../../net/loader';
import { GlueArt } from '../art';
import { Widget } from '../widget';
import { parseToc } from './toc';
import { parseXml } from './xml';

/** A manifest path, as the one key a cached file is looked up by. Slash- and case-insensitive. */
export function cacheKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

export interface PrefetchedManifest {
  /** The manifest's entries, in load order, truncated at `stopAfter` when one was given. */
  order: string[];
  /** Every file fetched, including `<Include>` and `<Script file=>` targets, keyed by `cacheKey`. */
  texts: Map<string, string>;
  /** The `.toc` itself could not be fetched -- nothing was loaded and the caller must say so. */
  tocMissing: boolean;
}

/**
 * Fetch `dir + toc` and every file it names, up to and including `stopAfter`.
 *
 * `stopAfter` is optional and an entry NOT FOUND in the manifest means the whole manifest, which is
 * the world runtime's normal case: `FrameXML.toc` is loaded entire.
 */
export async function prefetchManifest(
  dir: string,
  toc: string,
  stopAfter?: string,
): Promise<PrefetchedManifest> {
  const texts = new Map<string, string>();
  const missing = new Set<string>();

  const fetchText = async (path: string): Promise<string | null> => {
    const key = cacheKey(path);
    const cached = texts.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (missing.has(key)) {
      return null;
    }
    try {
      const bytes = await new Loader().load(dir + path);
      const text = new TextDecoder('utf-8').decode(bytes);
      texts.set(key, text);
      return text;
    } catch {
      missing.add(key);
      return null;
    }
  };

  const tocText = await fetchText(toc);
  if (tocText === null) {
    return { order: [], texts, tocMissing: true };
  }

  const all = parseToc(tocText).files;
  const stop = stopAfter === undefined ? -1 : all.findIndex((file) => cacheKey(file) === cacheKey(stopAfter));
  const order = stop === -1 ? all : all.slice(0, stop + 1);

  // The referenced-file closure. Depth-first over `<Include>`, since an included document may include
  // another, and `<Script file=>` targets are leaves.
  const seen = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    const key = cacheKey(path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const text = await fetchText(path);
    if (text === null || !/\.xml$/i.test(path)) {
      return;
    }
    for (const item of parseXml(text).items) {
      if (item.kind === 'include' || item.kind === 'script') {
        await walk(item.path);
      }
    }
  };
  for (const file of order) {
    await walk(file);
  }

  return { order, texts, tocMissing: false };
}

/**
 * Registers every art path the finished tree names, keyed by the path itself, and fetches them.
 *
 * Moved here from `runtime.ts` unchanged, for the same two-caller reason as `prefetchManifest`.
 *
 * A `Backdrop`'s `bgFile` is registered as TILED, because that is the only thing a backdrop background
 * is ever used for (`backdropPieces` repeats it at `tileSize`) -- and the seam-bleed hazard that makes
 * REPEAT opt-in for ordinary sprites does not apply, since a background samples its whole sheet.
 */
export async function registerTreeArt(art: GlueArt, root: Widget): Promise<void> {
  const walk = (widget: Widget): void => {
    if (widget.sprite) {
      art.register(widget.sprite, { path: widget.sprite });
    }
    const backdrop = widget.backdrop;
    if (backdrop) {
      if (backdrop.bgSprite) {
        art.register(backdrop.bgSprite, { path: backdrop.bgSprite, tile: true });
      }
      if (backdrop.edgeSprite) {
        art.register(backdrop.edgeSprite, { path: backdrop.edgeSprite });
      }
    }
    widget.children.forEach(walk);
  };
  walk(root);
  await art.load();
}
