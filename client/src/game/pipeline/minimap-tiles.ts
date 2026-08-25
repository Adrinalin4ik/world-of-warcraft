import Loader from '../net/loader';

/**
 * WHICH BLP IS THE MINIMAP TILE UNDER A GIVEN ADT TILE -- `textures/minimap/md5translate.trs`.
 *
 * The minimap's terrain is not one image; it is one BLP per ADT tile, and in 3.3.5a those BLPs are
 * stored under MD5-hashed names with this file as the index. So drawing a minimap starts here.
 *
 * ## THE WHOLE CHAIN IS VERIFIED END TO END, on the served files
 *
 * Not one link of this was assumed:
 *
 *  1. Our own ADT naming is `Map_<tileY>_<tileX>.adt` (`pipeline/adt/index.js:41`), and the tile indices
 *     come from `Chunk.tileFor(Chunk.chunkFor(axis))`.
 *  2. Northshire's world position (x -8900, y -160) therefore gives tileY 32, tileX 48.
 *  3. `md5translate.trs` contains `Azeroth\map32_48.blp` -> `b53fb722839e0c7a81bae678ea694f5c.blp`.
 *  4. `textures/minimap/b53fb722839e0c7a81bae678ea694f5c.blp` answers **200**.
 *
 * So the minimap tile for the zone the owner has been testing in is reachable, and the naming convention
 * is our own proven one rather than a guess about WoW's.
 *
 * ## THE FILE IS MOSTLY NOT MINIMAP TILES, and reading it naively would be wrong
 *
 * MEASURED: 19,089 lines, of which 445 are `dir:` headers and 18,644 are tab-separated pairs. **Only
 * 7,534 of those pairs are minimap tiles.** The other 11,110 are ordinary textures that happen to live in
 * the same index -- entries like
 * `Kalimdor\Tanaris\PassiveDoodads\Ruins\TanarisRuins03_000_00_00.blp`. So the parse matches the
 * `<dir>\map<X>_<Y>.blp` shape and ignores everything else; taking every pair would fill the table with
 * doodad textures keyed by nonsense coordinates.
 *
 * Azeroth alone has 687 tiles, which is the scale of one continent.
 *
 * ## COST
 *
 * **1.5 MB, fetched once and on demand.** That is real and it is why `ensureLoaded` is not called at
 * boot: a session that never shows a minimap should not pay for it. Parsed with one regex per line into
 * a `Map` of about 7,500 entries; the raw text is not retained.
 *
 * ## WHAT THIS DOES NOT DO
 *
 * Nothing draws. This answers "which file", and the drawing -- four tiles, a rotating crop, the circular
 * mask and the zoom levels -- is the next step and a larger one. Naming the split rather than implying
 * the minimap is done.
 */
/**
 * Parse `md5translate.trs` into `<mapname>/<tileY>_<tileX>` -> hashed file name.
 *
 * Exported and pure because the SHAPE TEST is the whole risk here. The file indexes many things and only
 * a minority of its lines are minimap tiles -- measured, 7,534 of 18,644 pairs -- so a parse that took
 * every tab-separated pair would fill the table with doodad textures keyed by whatever digits happened to
 * be in their names. **That failure is silent**: the table would be full and every lookup wrong, which is
 * worse than an empty one.
 */
export function parseTranslate(text: string): {
  tiles: Map<string, string>; lines: number; pairs: number;
} {
  const tiles = new Map<string, string>();
  let lines = 0;
  let pairs = 0;
  for (const line of text.split('\n')) {
    lines += 1;
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    pairs += 1;
    const left = line.slice(0, tab).trim();
    const right = line.slice(tab + 1).trim();
    // THE `map<X>_<Y>.blp` SHAPE ONLY, anchored at both ends so a doodad texture whose own name happens
    // to end in two numbers cannot pass. See this function's note.
    const match = /^(.+)\\map(-?\d+)_(-?\d+)\.blp$/i.exec(left);
    if (match === null || right === '') {
      continue;
    }
    tiles.set(`${match[1].toLowerCase()}/${match[2]}_${match[3]}`, right);
  }
  return { tiles, lines, pairs };
}

class MinimapTiles {
  private pending: Promise<void> | null = null;

  /** `<mapname>/<tileY>_<tileX>` (lowercased) -> the hashed BLP's file name. */
  private tiles = new Map<string, string>();

  /** For the arm: how much of the file was tiles, so a bad parse is visible rather than silent. */
  public stats = { lines: 0, pairs: 0, tiles: 0 };

  ensureLoaded(): Promise<void> {
    if (this.pending === null) {
      this.pending = this.load().catch((error) => {
        // Retryable rather than poisoning the session, like every other table here. Until it succeeds
        // `tileFor` answers null and the minimap draws no terrain -- blank, not wrong.
        this.pending = null;
        console.warn('minimapTiles: md5translate.trs failed to load; the minimap will have no terrain', error);
      });
    }
    return this.pending;
  }

  private async load(): Promise<void> {
    const loader = new (Loader as unknown as { new (): { load: (p: string) => Promise<ArrayBuffer> } })();
    const raw = await loader.load('textures\\minimap\\md5translate.trs');
    // `latin1`, not utf-8: the file is a plain ASCII index and a stray high byte in a doodad path must
    // not become a replacement character in the middle of a name we are about to key on.
    const text = new TextDecoder('latin1').decode(new Uint8Array(raw));
    const parsed = parseTranslate(text);
    this.tiles = parsed.tiles;
    this.stats = { lines: parsed.lines, pairs: parsed.pairs, tiles: parsed.tiles.size };
  }

  get loaded(): boolean {
    return this.tiles.size > 0;
  }

  /**
   * The served path of the minimap tile for an ADT tile, or **null** when there is none.
   *
   * `mapName` is the map's internal name -- "Azeroth", "Kalimdor" -- which is what the `dir:` headers use
   * and what `World\Maps\<name>` uses too. The index order is `(tileY, tileX)` because that is the order
   * our own ADT filenames carry (`pipeline/adt/index.js:41`), and the two conventions agree: the chain in
   * this file's header was checked against a real tile.
   *
   * Null covers "table not loaded" and "no tile for that coordinate" alike, and both mean draw nothing.
   * A great many coordinates legitimately have no tile -- the continents are not rectangles.
   */
  tileFor(mapName: string, tileY: number, tileX: number): string | null {
    const hash = this.tiles.get(`${mapName.toLowerCase()}/${tileY}_${tileX}`);
    return hash === undefined ? null : `textures\\minimap\\${hash}`;
  }
}

export const minimapTiles = new MinimapTiles();

export default minimapTiles;
