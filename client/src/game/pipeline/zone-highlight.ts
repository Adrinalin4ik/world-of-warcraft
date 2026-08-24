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
 * ## HOW THE SHAPE IS PLACED, AND WHY IT IS ONE PLACEMENT AND NOT TWO
 *
 * That measurement is the whole argument. **Nothing here is scaled by the rect.** The image draws at
 * the size the client's own XML authors it -- see `HIGHLIGHT_PX` for the derivation from
 * `worldmapframe.xml` -- and only its POSITION is chosen, by putting the outline's bounding-box centre
 * on the zone rect's centre. `ZoneHighlights.place` is that one function, and BOTH the hover mask and
 * the drawn art read it, so the two are the same shape by construction rather than by agreement.
 *
 * Four earlier models each stretched something onto the rect, and the owner saw each of them as a
 * wrongly sized highlight -- the last one as a single highlight covering half of Kalimdor, which is
 * what `rect / bbox` does when a small bbox meets a big rect. A stretch cannot be right here: the two
 * are not proportional, and that is measured directly above.
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

interface Shape {
  width: number;
  height: number;
  /** One LUMINANCE byte per pixel, row-major from the top -- the decoder's own order. */
  mask: Uint8Array;
  /**
   * The outline's bounding box inside the image, 0..1 -- **the one thing the placement needs.**
   *
   * The outline does not fill the image (Elwynn's occupies x 0.219..0.844, y 0.125..0.562 of the
   * 128x128), so the image cannot simply be pinned to the zone rect: its centre is not the shape's
   * centre. `ZoneHighlights.place` puts THIS box's centre on the zone rect's centre and draws the
   * image at its authored size around it, which is the only use this box has.
   *
   * It was previously STRETCHED onto the zone rect, and the measurement in the file header is why
   * that had to go: box and rect disagree by up to 58% in both directions, so scaling one onto the
   * other multiplies the shape by an arbitrary factor. On a big rect with a small box that factor is
   * large, and the owner saw the result -- one highlight covering half a continent.
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

/**
 * The highlight image's authored size, and the sheet's -- both from the client's own XML.
 *
 * **THIS IS WHY THERE IS NOTHING TO FIT, and both numbers are read out of the game's own files.**
 * `WorldMapHighlight` is `<AbsDimension x="128" y="128"/>` (`worldmapframe.xml:639-642`), and
 * `WorldMapButton_OnUpdate` multiplies the fractions `UpdateMapHighlight` hands back by that
 * button's own `GetWidth()`/`GetHeight()` (`worldmapframe.lua:747-748,765-766`), authored
 * `<AbsDimension x="1002" y="668"/>` (`worldmapframe.xml:698`). So a 128 px image drawn at its
 * NATURAL size is `128/1002` by `128/668` of the sheet -- derived, not fitted.
 *
 * It scales with the map rather than against it: in the minimised state the button is smaller and
 * the same fraction draws a smaller shape, which is what the whole sheet does.
 *
 * MEASURED against four zones -- the outline's decoded bounding box placed at 1:1 with its centre
 * on the zone rect's centre, against that rect:
 *
 *     Elwynn    shape x 0.411..0.491   rect 0.408..0.494  |  y 0.705..0.788   rect 0.704..0.789
 *     Westfall        x 0.389..0.441        0.372..0.458  |    y 0.750..0.852        0.758..0.844
 *     Duskwood        x 0.407..0.511        0.426..0.492  |    y 0.758..0.848        0.770..0.836
 *     Aszhara         x 0.574..0.670        0.553..0.691  |    y 0.322..0.424        0.304..0.442
 *
 * Elwynn lands within a thousandth on both axes. The others sit a little inside or a little over,
 * which is what a zone whose PLAYABLE rect includes coastal water should do -- the rect is not the
 * landmass, and demanding they coincide is the mistake that produced every earlier model here.
 */
const HIGHLIGHT_PX = 128;

const SHEET_WIDTH_UNITS = 1002;

const SHEET_HEIGHT_UNITS = 668;

/**
 * A multiplier on the derived size, defaulting to **1** because the derivation needs none.
 *
 * Kept as a knob rather than hard-coded: if a zone still draws wrong the useful question is whether
 * the derivation holds, and one live `window.worldMapHighlight(0.9)` answers that faster than
 * another round of arithmetic here.
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
   * Where the whole image sits on the sheet, so its outline lands on the zone -- all four 0..1.
   *
   * **ONE PLACEMENT, TWO USES: the hover reads it and the drawing reads it, so they cannot
   * disagree.** The previous version had no placement at all -- it stretched the outline's bounding
   * box onto the zone rect, which for a small box on a big rect is an enormous shape. That is why
   * the owner saw a single highlight covering half of Kalimdor. Nothing is stretched now: the image
   * draws at its authored size (see `HIGHLIGHT_PX`) and only its POSITION is chosen.
   *
   * The centre is the anchor, because it is the only choice that needs no offset from a table this
   * client does not have, and the four-zone measurement at `HIGHLIGHT_PX` says it is right.
   */
  private static place(
    shape: Shape,
    zone: { left: number; right: number; top: number; bottom: number },
  ): { left: number; top: number; width: number; height: number } {
    const factor = highlightScale ?? 1;
    const width = (HIGHLIGHT_PX / SHEET_WIDTH_UNITS) * factor;
    const height = (HIGHLIGHT_PX / SHEET_HEIGHT_UNITS) * factor;
    const midU = (shape.bounds.left + shape.bounds.right) / 2;
    const midV = (shape.bounds.top + shape.bounds.bottom) / 2;
    return {
      left: (zone.left + zone.right) / 2 - midU * width,
      top: (zone.top + zone.bottom) / 2 - midV * height,
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
    const at = ZoneHighlights.place(shape, zone);
    const tx = (sheetX - at.left) / at.width;
    const ty = (sheetY - at.top) / at.height;
    if (tx < 0 || tx > 1 || ty < 0 || ty > 1) {
      return false;
    }
    const x = Math.min(shape.width - 1, Math.floor(tx * shape.width));
    const y = Math.min(shape.height - 1, Math.floor(ty * shape.height));
    return shape.mask[y * shape.width + x] >= OPAQUE;
  }

  /**
   * The rect to draw the WHOLE image at -- the SAME placement the hover just read. See `place`.
   */
  drawRectFor(art: string, zone: { left: number; right: number; top: number; bottom: number }):
  { left: number; top: number; width: number; height: number } | null {
    const shape = this.shapes.get(art.toLowerCase()) ?? null;
    return shape === null ? null : ZoneHighlights.place(shape, zone);
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
