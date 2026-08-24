import WorkerPool, { PRIORITY } from './worker/pool';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';

/**
 * A ZONE'S HIGHLIGHT SHAPE -- `Interface\WorldMap\<art>\<art>Highlight.blp`, read for its ALPHA.
 *
 * ## WHY A RECT WAS NEVER GOING TO BE ENOUGH
 *
 * `WorldMapArea` gives a zone a bounding RECTANGLE, and the owner found the consequence immediately:
 * hovering open water far off the coast named Winterspring, "очень далеко от локации". A zone with a
 * ragged coastline has a rect covering a great deal of sea, and no arithmetic over rects can fix that --
 * the shape is the answer, and the shape is in this file.
 *
 * The real engine tests the same thing: `UpdateMapHighlight` returns a highlight TEXTURE, and the texture
 * is the zone's outline with everything outside it transparent. So the alpha channel IS the hit test, and
 * using it is porting the engine's own method rather than approximating it.
 *
 * MEASURED, before any of this was written: `interface/worldmap/elwynn/elwynnhighlight.blp` answers
 * **200** and so does `azeroth/azerothhighlight.blp`, while `elwynn/elwynn_highlight.blp` and a bare
 * `worldmaphighlight.blp` both 404. So the client's own path shape --
 * `"Interface\\WorldMap\\"..fileName.."\\"..fileName.."Highlight"` (`worldmapframe.lua:764`) -- is the
 * served one, with `fileName` being the `WorldMapArea` art name.
 *
 * ## COST, AND WHY IT IS ON DEMAND
 *
 * One BLP per zone the player actually hovers, decoded once in the existing worker pool at `BACKGROUND`
 * priority, and only the ALPHA byte of each pixel is kept -- a quarter of the RGBA the decoder returns,
 * and the only channel a hit test reads. A continent has ~25 zones, so a session that sweeps the whole
 * map keeps a few hundred KB.
 *
 * `opaqueAt` is a single array index. It runs from `WorldMapButton_OnUpdate`, i.e. per frame while the
 * cursor is over the map, which is exactly why it must not be anything more than that.
 *
 * ## THE HONEST NULL
 *
 * `opaqueAt` answers **null** until the shape has landed, and the caller falls back to the rect. That
 * keeps the first hover after opening a map responsive instead of dead, and it is a different answer from
 * `false` on purpose: false means "that point is outside the zone", null means "ask again in a moment".
 */

/** What a decoded BLP comes back as. Only the fields this file reads. */
interface BlpSpec {
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
}

interface Shape {
  width: number;
  height: number;
  /** One byte per pixel, row-major from the TOP -- the decoder's own order. */
  alpha: Uint8Array;
}

/** Below this the pixel is treated as outside the zone. The art is a hard-edged mask, so any cut works. */
const OPAQUE = 8;

class ZoneHighlights {
  private readonly shapes = new Map<string, Shape | null>();

  private readonly loading = new Set<string>();

  /**
   * Whether the zone's shape covers `(u, v)`, both 0..1 from the shape's top-left. Null until loaded.
   *
   * A MISS is remembered as `null` in `shapes` and reported as null for ever, which reads as "keep using
   * the rect" -- the correct behaviour for a zone whose highlight the host does not serve.
   */
  opaqueAt(art: string, u: number, v: number): boolean | null {
    const key = art.toLowerCase();
    const shape = this.shapes.get(key);
    if (shape === undefined) {
      this.load(art, key);
      return null;
    }
    if (shape === null) {
      return null;
    }
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return false;
    }
    const x = Math.min(shape.width - 1, Math.floor(u * shape.width));
    const y = Math.min(shape.height - 1, Math.floor(v * shape.height));
    return shape.alpha[y * shape.width + x] >= OPAQUE;
  }

  /** True once the shape is known to exist -- which is when the client may be told to draw it. */
  has(art: string): boolean {
    return (this.shapes.get(art.toLowerCase()) ?? null) !== null;
  }

  private load(art: string, key: string): void {
    if (this.loading.has(key)) {
      return;
    }
    this.loading.add(key);
    void (async () => {
      try {
        const spec = (await WorkerPool.enqueueAt(
          PRIORITY.BACKGROUND, 'BLP', `Interface\\WorldMap\\${art}\\${art}Highlight.blp`, true,
        )) as BlpSpec | null | undefined;
        const level = spec?.mipmaps[0];
        if (!spec || level === undefined || spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888) {
          // A zone with no highlight art, or one this kernel cannot read. Remembered as absent so the
          // caller keeps using the rect instead of asking every frame.
          this.shapes.set(key, null);
          return;
        }
        // ALPHA ONLY: a quarter of the bytes, and the only channel a hit test reads. The decoder gives
        // RGBA in that order (`pipeline/blp/loader.js`), so alpha is every fourth byte.
        const alpha = new Uint8Array(level.width * level.height);
        for (let i = 0; i < alpha.length; i += 1) {
          alpha[i] = level.data[i * 4 + 3];
        }
        this.shapes.set(key, { width: level.width, height: level.height, alpha });
      } catch (error) {
        // Not remembered as a miss: a network failure is not an absent file, and the next hover asks
        // again. The in-flight release below is what makes that possible.
        console.warn(`zone highlight: ${art} failed to load`, error);
      } finally {
        // **IN A `finally`.** A thrown decode that kept its key would make that zone's shape permanently
        // unaskable -- the dedupe-set defect this project has already paid for twice.
        this.loading.delete(key);
      }
    })();
  }
}

export const zoneHighlights = new ZoneHighlights();

export default zoneHighlights;
