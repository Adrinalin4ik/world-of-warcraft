import WorkerPool, { PRIORITY } from './worker/pool';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';

/**
 * A ZONE'S HIGHLIGHT SHAPE -- `Interface\WorldMap\<art>\<art>Highlight.blp`, read for its OUTLINE.
 *
 * ## WHY A RECT WAS NEVER GOING TO BE ENOUGH
 *
 * `WorldMapArea` gives a zone a bounding RECTANGLE, and the owner found the consequence immediately:
 * hovering open water far off the coast named Winterspring, "очень далеко от локации". A zone with a
 * ragged coastline has a rect covering a great deal of sea, and no arithmetic over rects can fix
 * that -- the shape is the answer, and the shape is in this file.
 *
 * The real engine tests the same thing: `UpdateMapHighlight` hands back a highlight TEXTURE, which is
 * the zone's outline. Reading it is porting the engine's own method rather than approximating it.
 *
 * ## THE FILE IS NOT WHAT I FIRST ASSUMED, TWICE, AND BOTH ARE MEASURED HERE
 *
 * **It has no alpha channel.** `elwynnhighlight.blp` and `winterspringhighlight.blp` are `BLP2`,
 * 128x128, colour encoding 2 (DXT), **alphaDepth 0**. An alpha test therefore answered "inside"
 * everywhere and the rect behaviour survived the fix meant to replace it. The outline is drawn bright
 * on black, so LUMINANCE is the mask -- see `OPAQUE`.
 *
 * **And the outline does not fill the image, but HOW it sits in it is not derivable from any table I
 * have found.** Measured, four zones, block-mapping the decoded art against each zone rect:
 *
 *     zone       zone rect (x)     outline bbox (x)   bbox*128 px   zone*1002 px
 *     Elwynn     0.408..0.494      0.219..0.844            80             86
 *     Westfall   0.372..0.458      0.281..0.688            52             86
 *     Duskwood   0.426..0.492      0.094..0.906           104             66
 *     Aszhara     0.553..0.691     0.125..0.875            96            138
 *
 * If the outline corresponded to the zone rect those last two columns would agree. They disagree by
 * up to 58%, in both directions, so **the `WorldMapArea` rect is the zone's playable bounds and not
 * its drawn outline** -- and no fixed relation between them exists to invert. I tried three models
 * (whole image over the rect, bbox inverted onto the rect, and the image at its authored 128x128)
 * and the owner saw each of them as a wrongly sized highlight.
 *
 * SO THE ART IS NOT DRAWN. `UpdateMapHighlight` answers the zone NAME and a nil `fileName`, which is
 * the client's own "nothing is highlighted" branch, and the gap is named rather than filled with a
 * fourth guess. `WorldMapHighlight` is authored 128x128 inside `WorldMapDetailFrame`
 * (`worldmapframe.xml`), so the engine draws it at that natural size -- what is missing is where.
 *
 * THE MASK IS STILL WORTH READING, and this is the one part that is not a guess: sampling the image
 * across the zone rect excludes the CORNERS of the rect, which is exactly the case the owner
 * reported -- open sea far off a ragged coast. It is an approximation of the outline's placement and
 * a strict improvement on no test at all, and it is labelled as such rather than presented as the
 * engine's own answer.
 *
 * The art NAME is the `WorldMapArea` row's, and it is not always the zone's: Azshara's art is
 * **"Aszhara"** -- Blizzard's own typo -- so `aszharahighlight.blp` answers 200 where the spelling a
 * human would try 404s. Reading the column rather than the name is what makes that a non-issue.
 *
 * ## COST, AND WHY IT IS ON DEMAND
 *
 * One BLP per zone the player actually hovers, decoded once in the existing worker pool at
 * `BACKGROUND` priority, and one LUMINANCE byte per pixel is kept -- a quarter of the RGBA the
 * decoder returns. 16 KB a zone at 128x128, so a session that sweeps a whole continent keeps ~400 KB.
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
  /** One LUMINANCE byte per pixel, row-major from the top -- the decoder's own order. */
  mask: Uint8Array;
}

/**
 * Below this LUMINANCE the pixel is outside the zone.
 *
 * **LUMINANCE AND NOT ALPHA, because the art has no alpha channel at all.** Measured on the served
 * files: `elwynnhighlight.blp` and `winterspringhighlight.blp` are both `BLP2`, 128x128, colour
 * encoding 2 (DXT) with **alphaDepth 0**. So every pixel decodes to alpha 255 and an alpha test
 * answers "inside" everywhere -- which is what it did, and why the rect behaviour survived a fix
 * meant to replace it.
 *
 * The outline is drawn bright on black, so brightness is the mask. 20 of 255 is well clear of the
 * black field and well under the outline's own value: a block map of Elwynn's art puts the field
 * below 24 and the shape above it.
 */
const OPAQUE = 20;

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
    // `u`/`v` are 0..1 across the zone RECT and are sampled straight across the image. See the
    // header on why that is an approximation and why it is still the right one to make.
    const x = Math.min(shape.width - 1, Math.floor(u * shape.width));
    const y = Math.min(shape.height - 1, Math.floor(v * shape.height));
    return shape.mask[y * shape.width + x] >= OPAQUE;
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
        // LUMINANCE, a quarter of the bytes, and the bounding box in the same pass. The decoder
        // gives RGBA in that order (`pipeline/blp/loader.js`).
        const mask = new Uint8Array(level.width * level.height);
        let bright = 0;
        for (let at = 0; at < mask.length; at += 1) {
          const o = at * 4;
          const value = (level.data[o] + level.data[o + 1] + level.data[o + 2]) / 3;
          mask[at] = value;
          if (value >= OPAQUE) {
            bright += 1;
          }
        }
        if (bright === 0) {
          // Nothing bright anywhere: the file decoded and carries no outline. Absent, not empty.
          this.shapes.set(key, null);
          return;
        }
        this.shapes.set(key, { width: level.width, height: level.height, mask });
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
