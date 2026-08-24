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
 * **And the outline does not fill the image.** A block map of the decoded art puts Elwynn at roughly
 * x 0.25..0.78, y 0.19..0.50 of the 128x128. So the texture covers a region LARGER than the zone, and
 * drawing the whole image over the zone rect squeezes it -- the owner's "выделения не правильно
 * скалированы". `Shape#bounds` is measured in the same pass as the mask and `drawRectFor` inverts it.
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
  /**
   * The shape's bounding box inside the texture, 0..1.
   *
   * **This is what makes the highlight the right SIZE, and it had to be measured rather than
   * assumed.** The art is a fixed 128x128 whatever the zone, and the outline occupies only part of
   * it -- Elwynn's sits at roughly x 0.25..0.78, y 0.19..0.50, decoded and printed as a block map
   * before this was written. So the texture covers a region LARGER than the zone, and the zone rect
   * corresponds to this box rather than to the whole image. Drawing the whole image over the zone
   * rect is what the owner saw as "выделения не правильно скалированы".
   */
  bounds: { left: number; right: number; top: number; bottom: number };
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
    // `u`/`v` are 0..1 across the ZONE, and the zone corresponds to the mask's bounding box -- not
    // to the whole texture. See `Shape#bounds`.
    const tx = shape.bounds.left + u * (shape.bounds.right - shape.bounds.left);
    const ty = shape.bounds.top + v * (shape.bounds.bottom - shape.bounds.top);
    const x = Math.min(shape.width - 1, Math.floor(tx * shape.width));
    const y = Math.min(shape.height - 1, Math.floor(ty * shape.height));
    return shape.mask[y * shape.width + x] >= OPAQUE;
  }

  /**
   * The rect to DRAW the whole texture at, given the zone rect -- both 0..1 on the sheet.
   *
   * The zone rect corresponds to the outline's bounding box INSIDE the texture, so the full texture
   * covers a proportionally larger area: its width is `zoneWidth / boundsWidth`, and its left edge
   * sits `boundsLeft` of that width before the zone's. That is what puts the outline exactly on the
   * zone instead of squeezing a whole 128x128 into the zone rect.
   *
   * Null until the shape has landed, which is the same condition as the hover having a real answer.
   */
  drawRectFor(art: string, zone: { left: number; right: number; top: number; bottom: number }):
  { left: number; top: number; width: number; height: number } | null {
    const shape = this.shapes.get(art.toLowerCase()) ?? null;
    if (shape === null) {
      return null;
    }
    const across = shape.bounds.right - shape.bounds.left;
    const down = shape.bounds.bottom - shape.bounds.top;
    if (across <= 0 || down <= 0) {
      return null;
    }
    const width = (zone.right - zone.left) / across;
    const height = (zone.bottom - zone.top) / down;
    return {
      left: zone.left - shape.bounds.left * width,
      top: zone.top - shape.bounds.top * height,
      width,
      height,
    };
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
        let minX = level.width;
        let maxX = -1;
        let minY = level.height;
        let maxY = -1;
        for (let y = 0; y < level.height; y += 1) {
          for (let x = 0; x < level.width; x += 1) {
            const at = y * level.width + x;
            const o = at * 4;
            const value = (level.data[o] + level.data[o + 1] + level.data[o + 2]) / 3;
            mask[at] = value;
            if (value >= OPAQUE) {
              if (x < minX) { minX = x; }
              if (x > maxX) { maxX = x; }
              if (y < minY) { minY = y; }
              if (y > maxY) { maxY = y; }
            }
          }
        }
        if (maxX < 0) {
          // Nothing bright anywhere: the file decoded and carries no outline. Absent, not empty.
          this.shapes.set(key, null);
          return;
        }
        this.shapes.set(key, {
          width: level.width,
          height: level.height,
          mask,
          bounds: {
            left: minX / level.width,
            right: (maxX + 1) / level.width,
            top: minY / level.height,
            bottom: (maxY + 1) / level.height,
          },
        });
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
