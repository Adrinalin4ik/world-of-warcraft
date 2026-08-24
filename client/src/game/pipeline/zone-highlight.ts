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
 * its landmass** -- there is no proportion between them and nothing here may be scaled by their ratio.
 *
 * ## HOW THE SHAPE IS PLACED: IT ISN'T. THE ART IS ALREADY IN THE RIGHT PLACE.
 *
 * The measurement above says the outline and the zone rect are not proportional, and FOUR models
 * read that as "so something must be scaled to compensate". It means the opposite. The art is
 * authored against the zone's own `WorldMapArea` rect: the image spans the rect and the outline
 * sits inside it exactly where the land is, coastal water included in the rect and excluded from
 * the shape. Nothing is scaled, nothing is offset, and the bounding box is not read at all.
 *
 * `ZoneHighlights.place` is that one function and carries the numbers that settled it. Both the
 * hover mask and the drawn art read it, so the two are the same shape by construction.
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
 * `opaqueAtSheetPoint` is a handful of arithmetic and one array index. It runs from
 * `WorldMapButton_OnUpdate`, i.e. per frame while the cursor is over the map, which is exactly why it
 * must not be anything more than that. `place` allocates one small object per call on that path and
 * nothing else -- no decode, no scan, no cache lookup beyond the `Map#get` the call already does.
 *
 * ## THE HONEST NULL
 *
 * `opaqueAtSheetPoint` answers **null** until the shape has landed, and the caller falls back to the
 * rect. That keeps the first hover after opening a map responsive instead of dead, and it is a
 * different answer from `false` on purpose: false means "that point is outside the zone", null means
 * "ask again in a moment".
 */

/** What a decoded BLP comes back as. Only the fields this file reads. */
interface BlpSpec {
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
}

/**
 * **NO BOUNDING BOX, and its absence is the fix.**
 *
 * Three models measured the outline's extent inside the image and scaled or offset the drawing by it.
 * All three were correcting a placement that needed no correction: the art is authored against the
 * zone's own `WorldMapArea` rect, so the image spans the rect and the outline is already where the
 * land is. See `ZoneHighlights.place`.
 *
 * The scan that computed it is gone with it -- four compares per bright pixel that fed nothing. What
 * the decode still needs from that pass is one bit: whether ANY pixel is bright, because a file that
 * decodes and carries no outline is absent rather than empty.
 */
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

/**
 * **HOW MUCH OF THE 128x128 IMAGE IS ACTUALLY USED, and it is not all of it vertically.**
 *
 * This is `UpdateMapHighlight`'s `texPercentageX`/`texPercentageY`, which the client feeds straight
 * into `WorldMapHighlight:SetTexCoord(0, texPercentageX, 0, texPercentageY)`
 * (`worldmapframe.lua:763`). Returning 1 for both -- which is what this did -- squeezes a square
 * image into a rect of aspect 1.5, and the owner named the symptom exactly: "ты сузил скейл по оси
 * y".
 *
 * MEASURED by decoding twelve zones' highlight art and taking the bounding box of every pixel above
 * `OPAQUE`, in texels of 128:
 *
 *     zone           bbox x        bbox y
 *     Elwynn          26..109        16..72
 *     Aszhara         14..112         9..77
 *     Duskwood        14..118        13..72
 *     Winterspring    36.. 89         4..78
 *     Barrens         47.. 81         4..78
 *     Felwood         43.. 82         3..80
 *     Durotar         51.. 70        16..60
 *     Silithus        10.. 96        15..82
 *
 * **x reaches 118 and y never passes 82.** So the content is not centred in a square -- it fills the
 * width and stops two thirds of the way down. `128 * 2/3 = 85.33`, and every measured maximum is
 * under it.
 *
 * And 2/3 is not fitted: the sheet is 1002x668 and `668 / 1002 = 2/3` exactly. The art is a
 * power-of-two 128x128 holding a 128x85.33 image of the zone's own rect, which has the sheet's
 * aspect -- so the crop is the aspect ratio, and cropping to it makes the drawn shape undistorted.
 */
const USED_X = 1;

const USED_Y = 668 / 1002;

/**
 * A multiplier on the zone rect the highlight is drawn at, defaulting to **1**.
 *
 * 1 is the derivation itself -- see `ZoneHighlights.place`. The knob stays because the last five
 * models here were each wrong in a way one live `window.worldMapHighlight(1.1)` would have shown in
 * a second, and the owner is the one who can see it.
 */
let highlightScale: number | null = null;

/** Set the drawn highlight scale live. Returns what it settled on, for the console. */
export function setHighlightScale(factor: number | null): number {
  highlightScale = factor !== null && Number.isFinite(factor) && factor > 0
    ? Math.min(factor, 4)
    : null;
  return highlightScale ?? 1;
}

class ZoneHighlights {
  private readonly shapes = new Map<string, Shape | null>();

  private readonly loading = new Set<string>();

  /**
   * Where the whole image sits on the sheet: **the zone's own rect, exactly.** All four 0..1.
   *
   * ## THE SIXTH MODEL, AND THE FIRST ONE THAT IS A DERIVATION RATHER THAN A FIT
   *
   * The art is authored against the zone's `WorldMapArea` rect. So there is no scale to choose and
   * no offset to guess -- the image spans the rect, and the outline sits inside it wherever the land
   * is. `UpdateMapHighlight` returns `textureX`/`textureY` as the rect's SIZE and
   * `scrollChildX`/`scrollChildY` as its top-left, which is exactly the four numbers the client
   * multiplies by the button's width and height (`worldmapframe.lua:765-772`).
   *
   * **The owner's two zones are what settled it, and they rule out a fixed size.** Every zone rect
   * is square as a fraction of its sheet; measured on the served `worldmaparea.dbc` against the
   * continent rows:
   *
   *     zone           rect on sheet    at a fixed 128/1002    verdict
   *     Aszhara        0.138            0.128                  "выглядит как надо"
   *     Winterspring   0.193            0.128                  "маленький", shape right
   *     Teldrassil     0.138            0.128
   *     Elwynn         0.085            0.128
   *     Barrens        0.275            0.128
   *
   * A fixed size is 8% off for Azshara -- invisible -- and 34% short for Winterspring, which is
   * exactly what he saw. The rect predicts both, and it predicts Barrens and Elwynn differing by a
   * factor of three, which no constant can.
   *
   * ## What the four earlier models got wrong
   *
   * Three stretched the outline's BOUNDING BOX onto the rect, which multiplies the image by
   * `rect / bbox` -- 33% too big for Azshara, and far worse for a zone whose land is a small part of
   * its playable water. One drew the image at its authored 128x128, which is right only for a zone
   * whose rect happens to be 0.128 of the sheet. **The bbox was never part of the answer**: the art
   * already carries where the land is, and every model that measured the outline was correcting for
   * a placement that did not need correcting.
   */
  private static place(
    zone: { left: number; right: number; top: number; bottom: number },
  ): { left: number; top: number; width: number; height: number } {
    const factor = highlightScale ?? 1;
    const width = (zone.right - zone.left) * factor;
    const height = (zone.bottom - zone.top) * factor;
    // Grown or shrunk about the CENTRE, so the knob cannot move the shape off the zone.
    return {
      left: (zone.left + zone.right) / 2 - width / 2,
      top: (zone.top + zone.bottom) / 2 - height / 2,
      width,
      height,
    };
  }

  /**
   * Whether the zone's shape covers a point on the SHEET, both 0..1. Null until the art is loaded.
   *
   * Takes the sheet point and the zone rect rather than a fraction inside the rect, because the
   * shape is no longer stretched to that rect -- it is placed on the sheet, and the sheet is the one
   * space where the hover and the drawing can be compared. Passing a pre-divided `u`/`v` is what let
   * the two drift apart.
   *
   * A MISS is remembered as `null` in `shapes` and reported as null for ever, which reads as "keep
   * using the rect" -- the correct behaviour for a zone whose highlight the host does not serve.
   */
  opaqueAtSheetPoint(
    art: string,
    zone: { left: number; right: number; top: number; bottom: number },
    sheetX: number,
    sheetY: number,
  ): boolean | null {
    const key = art.toLowerCase();
    const shape = this.shapes.get(key);
    if (shape === undefined) {
      this.load(art, key);
      return null;
    }
    if (shape === null) {
      return null;
    }
    const at = ZoneHighlights.place(zone);
    // THE SAME CROP THE DRAWING USES. The zone rect maps onto the USED part of the image, not the
    // whole of it, so a v of 1 is texel 85 and not texel 128 -- see `USED_Y`. Without this the mask
    // reads the blank bottom third of the art as "outside the zone" for the southern third of every
    // zone, which is a hover that dies below the middle of the map.
    const tx = ((sheetX - at.left) / at.width) * USED_X;
    const ty = ((sheetY - at.top) / at.height) * USED_Y;
    if (tx < 0 || tx > USED_X || ty < 0 || ty > USED_Y) {
      return false;
    }
    const x = Math.min(shape.width - 1, Math.floor(tx * shape.width));
    const y = Math.min(shape.height - 1, Math.floor(ty * shape.height));
    return shape.mask[y * shape.width + x] >= OPAQUE;
  }

  /**
   * `texPercentageX` / `texPercentageY` -- how much of the image the client should sample.
   *
   * See `USED_X` / `USED_Y`. Constant for every zone, because it is the aspect ratio of the sheet
   * and not a property of any one zone.
   */
  // eslint-disable-next-line class-methods-use-this
  usedTexCoords(): { x: number; y: number } {
    return { x: USED_X, y: USED_Y };
  }

  /**
   * The rect to draw the WHOLE image at -- the SAME placement the hover just read. See `place`.
   */
  drawRectFor(art: string, zone: { left: number; right: number; top: number; bottom: number }):
  { left: number; top: number; width: number; height: number } | null {
    const shape = this.shapes.get(art.toLowerCase()) ?? null;
    return shape === null ? null : ZoneHighlights.place(zone);
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
        let bright = false;
        for (let y = 0; y < level.height; y += 1) {
          for (let x = 0; x < level.width; x += 1) {
            const at = y * level.width + x;
            const o = at * 4;
            const value = (level.data[o] + level.data[o + 1] + level.data[o + 2]) / 3;
            mask[at] = value;
            if (value >= OPAQUE) {
              bright = true;
            }
          }
        }
        if (!bright) {
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
