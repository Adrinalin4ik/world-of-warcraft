/**
 * THE MINIMAP'S TERRAIN -- the game's own minimap BLPs, composited on the CPU and masked to a circle.
 *
 * `pipeline/minimap-tiles.ts` answers "which BLP" and stops there, saying so. This is the other half:
 * the tiles under and around the player, cropped to the visible window, drawn into one canvas, masked
 * round, and adopted into the interface's art table as an ordinary sprite.
 *
 * ## WHY A CANVAS AND NOT A RENDERER FEATURE
 *
 * The obvious shape -- four texture regions with computed `TexCoords` -- cannot work, because the
 * minimap is ROUND and this widget layer has no mask: a square terrain behind a ring border shows at
 * the corners. A circular mask in the draw pass would be a renderer change, a new material and a new
 * uniform, on a path this project cannot verify from here.
 *
 * A CPU composite needs none of that. `ctx.globalCompositeOperation = 'destination-in'` plus one arc
 * is the mask, and the result is a `CanvasTexture` -- which is a thing this renderer already draws,
 * every frame, for every font string (`text.ts:576`). So the minimap becomes a sprite like any other:
 * it takes part in the ordinary draw list, at its real layer, under the client's own border art.
 *
 * `art.adopt` is the seam, and it already exists for exactly this -- the model booth publishes a render
 * target through it (`art.ts:87`). Nothing new in the renderer, nothing new in the widget layer.
 *
 * ## THE COST, WHICH IS THE REASON FOR EVERY POLICY BELOW
 *
 * A composite is 4 `drawImage` calls plus one masking arc into a 256x256 canvas, then one texture
 * upload. That is cheap ONCE and unaffordable every frame -- a 256x256 RGBA upload is 256 KB across
 * the bus, and the player moves every frame he walks.
 *
 * So it is redrawn only when the picture would actually CHANGE BY A PIXEL: `update` quantises the
 * window's origin to whole destination pixels and the composite is skipped when the quantised value has
 * not moved. Walking at ~7 yd/s with a 400-yard window over 256 px is 1.56 yd/px, so this redraws about
 * 4-5 times a second while running and **zero times while standing still**. The same test covers the
 * zoom and the tile set, so there is one gate rather than three.
 *
 * The decoded tiles are cached, and the cache is what makes the redraw cheap: a tile is fetched and
 * decoded once per session, and a composite after that is canvas work only. A tile is 256x256 -- 256 KB
 * as RGBA -- and a continent has 687 of them, so the cache is BOUNDED (`TILE_CACHE_CAP`) and evicts the
 * least recently used. Four tiles are in play at once, so the cap is generous by two orders of
 * magnitude and exists to stop a long session's walk from retaining a continent.
 *
 * Decoding happens in the EXISTING worker pool at `BACKGROUND` priority, behind terrain and characters,
 * because a minimap tile arriving 200 ms late is a minimap that fills in 200 ms late.
 *
 * ## WHAT IS NOT SOURCED, and the knob for it
 *
 * **The window size per zoom level is unsourced.** No DBC, no CVar and no FrameXML line states how many
 * yards the minimap shows, and it is not derivable from the art: the tile is one ADT tile
 * (`ADT.SIZE = 533.33333` yards over 256 pixels) whatever the zoom. The table below is a plain
 * geometric series and it is flagged as a guess rather than dressed up.
 *
 * `window.worldMinimapZoom(yards)` overrides it live, which is the pattern that settled the quest
 * sparkle's scale in one message from the owner rather than three rounds of guessing here.
 *
 * ## ORIENTATION, taken from the code that is already proven rather than re-derived
 *
 * Every orientation defect on this project has been two conventions meeting, so nothing here is
 * derived twice. `ADT.tileFor` and `ADT.positionFor` (`pipeline/adt/index.js:32-38`) are the authority
 * on which tile a world position is in, and they are CALLED rather than reimplemented. The one thing
 * this file adds is the sign of each axis on screen, and it is the same arithmetic
 * `dbc/map-data.ts#normalise` already carries for the world map, checked by that module's test:
 *
 *   - The world's **Y** runs WEST and the screen's x runs EAST, so x grows as worldY shrinks.
 *   - The world's **X** runs NORTH and the screen's y runs DOWN, so y grows as worldX shrinks.
 *
 * Which is why `positionFor(tile)` -- the tile's MAXIMUM coordinate on its axis, since the tile index
 * grows as the coordinate shrinks -- is the tile's LEFT edge on the Y axis and its TOP edge on the X.
 *
 * **The minimap is NOT rotated, and that is the default rather than a gap.** The client's own
 * `rotateMinimap` CVar defaults to "0" and `Minimap_UpdateRotationSetting` reads it; a north-up minimap
 * is what an unmodified client shows. Rotation would need the renderer change this file exists to
 * avoid, and it is named in `map-bridge.ts` alongside the world map's arrow.
 */
import * as THREE from 'three';

import ADT from '../pipeline/adt';
import WorkerPool, { PRIORITY } from '../pipeline/worker/pool';
import minimapTiles from '../pipeline/minimap-tiles';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';
import type { GlueArt } from './art';
import { Blip, MinimapBlips, blipForStatus } from './minimap-blips';
import { resolveUnitToken } from '../world/unit-tokens';
import type { MethodContext } from './framexml/lua/object';
import { zoomOf } from './framexml/lua/methods/minimap';
import type World from '../world';

/** The art key the Minimap's terrain region names. Not a path -- `art.adopt` publishes it directly. */
export const MINIMAP_TERRAIN_KEY = '__minimapTerrain';

/**
 * The composite's side in pixels.
 *
 * 256 rather than the frame's authored 140 so the terrain is not upscaled on a UI that is itself
 * scaled, and a power of two because a `CanvasTexture` of one avoids a resize on upload.
 */
const TERRAIN_PX = 256;

/**
 * Yards across the minimap at each zoom level, index 0 being fully zoomed OUT.
 *
 * **UNSOURCED** -- see this file's header. A geometric series from 400 yards, and
 * `window.worldMinimapZoom(yards)` overrides the whole table live so the owner can name the right
 * number in one message.
 */
const WINDOW_YARDS = [400, 300, 220, 160, 120];

/**
 * Decoded tiles retained, LRU.
 *
 * 64 tiles is 16 MB as RGBA against the four in play at any moment. It is not sized for the working
 * set -- it is a ceiling, so a session that walks a continent cannot retain its 687 tiles.
 */
const TILE_CACHE_CAP = 64;

/** What a decoded BLP comes back as. Only the fields this file reads. */
interface BlpSpec {
  width: number;
  height: number;
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
}

/**
 * The destination rect, in canvas pixels, that one whole ADT tile occupies.
 *
 * Exported and pure because it is the only arithmetic here that can be wrong SILENTLY: a sign error
 * puts the terrain somewhere plausible rather than nowhere, and the minimap would look like a minimap
 * of the wrong place. See this file's header on which axis is which.
 *
 * `tileA` indexes the world's Y axis (screen x) and `tileB` its X axis (screen y) -- the same order as
 * the file name `Map_<A>_<B>.adt` that `ADT.loadTile` builds, so a caller cannot silently transpose
 * them relative to the tile it just looked up.
 */
export function tileRect(
  tileA: number,
  tileB: number,
  centreX: number,
  centreY: number,
  windowYards: number,
): { x: number; y: number; size: number } {
  const perPixel = windowYards / TERRAIN_PX;
  const half = windowYards / 2;
  // `positionFor` is the tile's MAXIMUM coordinate on its axis, so it is the left edge on the Y axis
  // (west is left) and the top edge on the X axis (north is up).
  const leftWorldY = ADT.positionFor(tileA);
  const topWorldX = ADT.positionFor(tileB);
  return {
    x: (centreY + half - leftWorldY) / perPixel,
    y: (centreX + half - topWorldX) / perPixel,
    size: ADT.SIZE / perPixel,
  };
}

/** The inclusive tile range an axis's visible span covers. Tile indices grow as the coordinate shrinks. */
export function tileSpan(centre: number, windowYards: number): { from: number; to: number } {
  const half = windowYards / 2;
  return { from: ADT.tileFor(centre + half), to: ADT.tileFor(centre - half) };
}

/**
 * One decoded minimap tile as a canvas, or `null` while it is in flight or genuinely absent.
 *
 * A tile that fails is remembered as a MISS rather than retried for ever: the continents are not
 * rectangles and most coordinates near an edge have no tile at all, so a null here is the common case
 * and not an error.
 */
type TileEntry = { canvas: HTMLCanvasElement | null };

export class MinimapTerrain {
  private readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D | null;

  private readonly texture: THREE.CanvasTexture;

  /** The blip layer, drawn into this same canvas before the mask. See `ui/minimap-blips.ts`. */
  private readonly blips = new MinimapBlips();

  /** The last composite's blip fingerprint, so a party that has not moved costs nothing. */
  private lastBlips = '';

  /** `<mapName>/<A>_<B>` -> the decoded tile, or a remembered miss. LRU by insertion order. */
  private readonly tiles = new Map<string, TileEntry>();

  /** In flight, so a walk across a seam asks once. Released in a `finally` -- see `CLAUDE.md`. */
  private readonly loading = new Set<string>();

  /**
   * The last composite's quantised inputs, so a stationary player costs nothing.
   *
   * Four fields rather than one joined string, and deliberately: this is compared once per UI tick, and
   * a template literal there would allocate a string every frame for the life of the session to answer
   * a question four numeric compares answer for free. `lastMap` empty is the never-composited state.
   */
  private lastMap = '';

  private lastYards = 0;

  private lastPx = 0;

  private lastPy = 0;

  private disposed = false;

  /** Set by `window.worldMinimapZoom(yards)`; overrides the whole unsourced table. */
  private override: number | null = null;

  constructor(private readonly art: GlueArt) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TERRAIN_PX;
    this.canvas.height = TERRAIN_PX;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    // The same three settings `text.ts` gives its glyph sheets, and for the same reasons: no mipmaps
    // on a canvas that is redrawn (a mip chain would be regenerated on every upload), and clamped so
    // the masked-away corners cannot wrap in along an edge.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    /**
     * **`flipY = false`, AND LEAVING IT AT THREE'S DEFAULT IS WHY THE MINIMAP CAME OUT INVERTED.**
     *
     * The owner put our minimap beside the real client's at the same spot and the picture was turned
     * over. This is the third orientation defect on this project and the third time it was TWO
     * CONVENTIONS MEETING rather than a wrong texture -- and the convention was already written
     * down: `TextureLoader` creates every texture in this renderer with `flipY = false`,
     * `renderer.ts#writeQuadUVs` builds its UVs on that basis (`renderer.ts:157`), and
     * `material.ts:120` records the two cancelling flips. A `THREE.CanvasTexture` defaults to
     * `flipY = true`, so these two were the only textures in the interface sampled upside down.
     *
     * `text.ts:578` is the precedent and it is exact: every glyph sheet is a canvas too, and it sets
     * this line for this reason. Grepping the convention's existing home would have found it -- which
     * is the rule `CLAUDE.md` states about adopting a camera's whole convention, including the parts
     * that look like defaults.
     *
     * It fixes three things at once: the terrain's vertical axis, the arrow art, and the arrow's
     * apparent rotation DIRECTION -- the `-facing` derivation was made for an unflipped canvas, so a
     * mirrored one reverses it.
     */
    this.texture.flipY = false;
    this.art.adopt(MINIMAP_TERRAIN_KEY, this.texture);
  }

  /** Yards across, for a zoom level. */
  private windowFor(zoom: number): number {
    if (this.override !== null) {
      return this.override;
    }
    const clamped = Math.max(0, Math.min(WINDOW_YARDS.length - 1, Math.floor(zoom)));
    return WINDOW_YARDS[clamped];
  }

  /** The live override, for the owner's knob. Forces the next `update` to redraw. */
  setWindowYards(yards: number | null): void {
    this.override = yards !== null && Number.isFinite(yards) && yards > 0 ? yards : null;
    this.invalidate();
  }

  /** What the last blip pass was asked to draw. For `window.worldMinimapBlips()`. */
  blipReport(): Record<string, unknown> {
    return this.blips.report();
  }

  /** Force the next `update` to composite, whatever the player has done since. */
  private invalidate(): void {
    this.lastMap = '';
  }

  /**
   * Redraw if the picture would change, otherwise do nothing.
   *
   * Called once per UI tick from the map bridge. The early return is the whole performance story: see
   * this file's header on the pixel-quantised signature.
   */
  update(
    mapName: string,
    worldX: number,
    worldY: number,
    zoom: number,
    blips: Blip[] = [],
  ): boolean {
    if (this.disposed || this.ctx === null || mapName === '') {
      return false;
    }
    const windowYards = this.windowFor(zoom);
    const perPixel = windowYards / TERRAIN_PX;
    // Quantised to whole destination pixels: a move smaller than one pixel cannot change the image.
    const px = Math.round(worldX / perPixel);
    const py = Math.round(worldY / perPixel);
    // THE BLIPS ARE PART OF THE GATE, not drawn outside it. A quest giver appearing or a party
    // member walking has to force a composite, and nothing else here would notice: the four
    // numbers above are the player's own state. Quantised to whole yards inside `fingerprint`, so
    // a member standing still is free.
    const blipPrint = this.blips.fingerprint(blips);
    // `takeArtArrived` CLEARS, so it must be read every frame and BEFORE the short-circuit -- an
    // icon landing has to force one composite even though nothing moved. See its own doc.
    const artArrived = this.blips.takeArtArrived();
    if (!artArrived && mapName === this.lastMap && windowYards === this.lastYards
      && px === this.lastPx && py === this.lastPy && blipPrint === this.lastBlips) {
      return false;
    }
    this.lastBlips = blipPrint;
    this.lastMap = mapName;
    this.lastYards = windowYards;
    this.lastPx = px;
    this.lastPy = py;
    this.composite(mapName, worldX, worldY, windowYards, blips);
    return true;
  }

  private composite(
    mapName: string,
    worldX: number,
    worldY: number,
    windowYards: number,
    blips: Blip[],
  ): void {
    const ctx = this.ctx!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, TERRAIN_PX, TERRAIN_PX);

    // `tileSpan` on each axis: A from the world's Y, B from the world's X. Both inclusive, and the
    // span is 1 or 2 tiles wide for any window smaller than a tile -- which every zoom level is.
    const spanA = tileSpan(worldY, windowYards);
    const spanB = tileSpan(worldX, windowYards);
    for (let a = spanA.from; a <= spanA.to; a += 1) {
      for (let b = spanB.from; b <= spanB.to; b += 1) {
        const tile = this.tile(mapName, a, b);
        if (tile === null) {
          continue;
        }
        const rect = tileRect(a, b, worldX, worldY, windowYards);
        // `drawImage` clips to the canvas itself, so a tile hanging off an edge needs no arithmetic
        // here -- which is also why a fifth partially-visible tile costs nothing to include.
        /**
         * SOURCE INSET BY HALF A TEXEL, DESTINATION EXPANDED BY HALF A PIXEL -- the seam fix.
         *
         * The owner saw "полосы на стыках": a visible line along every tile boundary. Two things
         * produce it and this covers both, because from here they are indistinguishable.
         *
         *  1. `drawImage` at FRACTIONAL destination coordinates antialiases the tile's outer edge
         *     against the transparent canvas, so each tile ends in a half-transparent row -- and two
         *     of those meeting is a line darker than either tile.
         *  2. A minimap tile's own outermost row is frequently not terrain at all but the edge the
         *     artist left, which upscaling then smears across a whole destination pixel.
         *
         * Skipping the outer half-texel of the source removes (2); overlapping the destination by half
         * a pixel on every side removes (1), since the neighbour now paints over the feathered edge.
         * The cost is a 0.4% scale-up of each tile at this size, which no eye resolves, and it is
         * cheaper and more certain than trying to round every rect onto integer boundaries -- the tile
         * size is fractional at every zoom level, so rounding leaves gaps instead of overlaps.
         */
        ctx.drawImage(
          tile,
          0.5, 0.5, tile.width - 1, tile.height - 1,
          rect.x - 0.5, rect.y - 0.5, rect.size + 1, rect.size + 1,
        );
      }
    }

    /**
     * THE BLIPS, on top of the terrain and BEFORE the mask.
     *
     * Before the mask so the same arc that rounds the terrain clips a blip near the rim -- an icon
     * hanging outside the circle would draw over the client's own border art, which is a frame this
     * canvas sits under rather than inside.
     *
     * The world-to-canvas mapping is passed in rather than duplicated in `minimap-blips.ts`: the
     * window and its rounding belong to this file, and a second copy of that arithmetic would be a
     * second chance to disagree with the tiles underneath.
     *
     * The minimap's vertical axis is the world's X and its horizontal is the world's Y, which is the
     * same convention `tileSpan` above uses -- `spanA` from the world Y and `spanB` from the world X.
     * Both increase toward the top-left in world space, so both are subtracted.
     */
    const perPixel = windowYards / TERRAIN_PX;
    this.blips.draw(ctx, blips, (blipX, blipY) => ({
      x: TERRAIN_PX / 2 - (blipY - worldY) / perPixel,
      y: TERRAIN_PX / 2 - (blipX - worldX) / perPixel,
    }));

    /**
     * THE MASK, and this is why the whole file is a canvas.
     *
     * `destination-in` keeps only what the new shape covers, so one filled circle turns the square
     * composite into the round minimap the client's border art is drawn for. A 1-pixel inset keeps the
     * antialiased rim inside the texture rather than on its edge, where clamped wrapping would smear
     * it.
     */
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(TERRAIN_PX / 2, TERRAIN_PX / 2, (TERRAIN_PX / 2) - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    this.texture.needsUpdate = true;
  }

  /** The cached tile, kicking off its decode on a miss. Null until it lands, and null for good if absent. */
  private tile(mapName: string, tileA: number, tileB: number): HTMLCanvasElement | null {
    const key = `${mapName.toLowerCase()}/${tileA}_${tileB}`;
    const entry = this.tiles.get(key);
    if (entry !== undefined) {
      // Touch for the LRU: delete and re-insert moves it to the end of the iteration order.
      this.tiles.delete(key);
      this.tiles.set(key, entry);
      return entry.canvas;
    }
    if (!this.loading.has(key)) {
      this.loading.add(key);
      void this.load(mapName, tileA, tileB, key);
    }
    return null;
  }

  private async load(mapName: string, tileA: number, tileB: number, key: string): Promise<void> {
    try {
      await minimapTiles.ensureLoaded();
      const path = minimapTiles.tileFor(mapName, tileA, tileB);
      if (path === null) {
        // A coordinate with no tile. Remembered so the walk does not ask again -- most of the space
        // just outside a continent's edge is this.
        this.remember(key, null);
        return;
      }
      const spec = (await WorkerPool.enqueueAt(
        PRIORITY.BACKGROUND, 'BLP', path, true,
      )) as BlpSpec | null | undefined;
      if (!spec || spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888 || spec.mipmaps.length === 0) {
        // `decompress` gives RGBA for every colour format BLP2 has, so this is the "a format this
        // kernel cannot read must be NAMED rather than blitted as if it were RGBA" case that
        // `scene/body-composite.ts` already guards. Remembered as a miss, not retried.
        this.remember(key, null);
        return;
      }
      this.remember(key, toCanvas(spec));
      // The composite that asked for this tile has already run without it, so the next `update` has
      // to be allowed to redraw even from a standstill.
      this.invalidate();
    } catch (error) {
      // Retryable rather than remembered: a network failure is not an absent tile, and the next
      // composite that needs it will ask again.
      console.warn(`minimap terrain: ${key} failed to decode`, error);
    } finally {
      // **IN A `finally`.** A thrown decode that left its key in the in-flight set would make that
      // tile permanently unaskable -- the exact defect the quest template cache had.
      this.loading.delete(key);
    }
  }

  private remember(key: string, canvas: HTMLCanvasElement | null): void {
    this.tiles.set(key, { canvas });
    while (this.tiles.size > TILE_CACHE_CAP) {
      const oldest = this.tiles.keys().next();
      if (oldest.done) {
        break;
      }
      this.tiles.delete(oldest.value);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.tiles.clear();
    this.loading.clear();
    this.blips.dispose();
    this.texture.dispose();
  }
}

/** A decoded RGBA level as a canvas `drawImage` can crop and scale. */
function toCanvas(spec: BlpSpec): HTMLCanvasElement | null {
  const level = spec.mipmaps[0];
  const canvas = document.createElement('canvas');
  canvas.width = level.width;
  canvas.height = level.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    return null;
  }
  // `Uint8ClampedArray` over the SAME buffer rather than a copy: the decoder already gave this file
  // its own tightly-fitted allocation (`pipeline/blp/loader.js` copies each level out of the shared
  // download), so there is nothing to protect it from and a 256 KB copy per tile to avoid.
  // `as ArrayBuffer` because a typed array's `buffer` is `ArrayBufferLike`, which `ImageData` will not
  // take: the decoder allocates plain `Uint8Array`s, never a `SharedArrayBuffer`.
  const bytes = new Uint8ClampedArray(
    level.data.buffer as ArrayBuffer, level.data.byteOffset, level.data.byteLength,
  );
  ctx.putImageData(new ImageData(bytes, level.width, level.height), 0, 0);
  return canvas;
}

/**
 * THE PLAYER ARROW, its own 64x64 canvas and its own region -- deliberately NOT part of the composite.
 *
 * It could have been drawn into the terrain canvas, and that would have been worse: the arrow turns
 * whenever the player turns, and a facing change would then force a full terrain recomposite -- four
 * `drawImage`s, the mask, and a 256 KB upload -- for a 40-pixel marker. On its own canvas a turn costs
 * one clear, one rotated blit and a **4 KB** upload, and the terrain is untouched.
 *
 * `ctx.rotate` is why this works at all without a renderer change. The widget layer draws axis-aligned
 * quads only, which is what made the world map's rotating arrow a declared gap -- but a canvas rotates
 * for free, so the minimap gets the facing the world map cannot have yet.
 *
 * THE ART: `<Minimap>` names the arrow as an ATTRIBUTE rather than art --
 * `minimapPlayerModel="Interface\Minimap\MinimapArrow.mdx"` (`minimap.xml`) -- so the authored form is
 * an M2. `interface/minimap/minimaparrow.blp` is the same art beside it and answers 200 (measured: 32x32,
 * BLP2, palettized with an 8-bit alpha), which is what this draws. A model would give the same picture
 * through the model pipeline for a marker that is 40 pixels wide.
 *
 * THE SIZE IS SOURCED, and it is the one number in this whole feature that is: the client asks for it
 * itself, `Minimap:SetPlayerTextureHeight(40)` / `SetPlayerTextureWidth(40)` in `MinimapPing_OnLoad`
 * (`minimap.lua:11-12`). `methods/minimap.ts` records those calls and this is the reader its comment
 * promised -- that note said "read by nothing yet", and it no longer applies.
 */
/**
 * Every group token the minimap can draw a dot for, built ONCE.
 *
 * `MAX_PARTY_MEMBERS` is 4 and `MAX_RAID_MEMBERS` 40 in 3.3.5a. Built at module scope because
 * `blipsNow` runs every frame and building 44 strings there would allocate for nothing -- the list
 * never changes.
 */
const GROUP_TOKENS: string[] = [
  ...Array.from({ length: 4 }, (unused, i) => `party${i + 1}`),
  ...Array.from({ length: 40 }, (unused, i) => `raid${i + 1}`),
];

const ARROW_KEY = '__minimapPlayerArrow';

/**
 * The WORLD MAP's own arrow, drawn by the same canvas as the minimap's.
 *
 * A second key and a second instance rather than a shared texture: the two rotate together (both
 * follow the player's heading) but they are different SIZES, and `art.adopt` keys a texture by name.
 * Sharing one would make the world map draw at the minimap's 30 px.
 */
const WORLD_ARROW_KEY = '__worldMapPlayerArrow';

/**
 * How big the world map's arrow is drawn, in its own region's pixels.
 *
 * UNSOURCED, like the minimap's: `<Minimap>` names the minimap arrow as a model and the world map
 * names nothing at all -- `PlayerArrowEffectFrame` is created in code by the engine
 * (`worldmapframe.lua:108`) and its size comes from the arrow model it holds. 24 is a little smaller
 * than the minimap's 30 because the world map is a wider view of the same world, and
 * `window.worldMapArrow(px)` settles it the way `worldMinimapArrow` settled the other one.
 */
const DEFAULT_WORLD_ARROW_PX = 24;

let worldArrowDrawPx: number | null = null;

/** Set the world map arrow's drawn size live. Returns what it settled on, for the console. */
export function setWorldArrowDrawPx(px: number | null): number {
  worldArrowDrawPx = px !== null && Number.isFinite(px) && px > 0 ? Math.min(px, ARROW_PX) : null;
  return worldArrowDrawPx ?? DEFAULT_WORLD_ARROW_PX;
}

/**
 * The arrow canvas's side, and the REGION's -- which is deliberately larger than the arrow itself.
 *
 * The owner's first sighting was "он очень маленький", and the arithmetic says why: the art is 32 px,
 * it was drawn at its native 32 into a 64 canvas, and that canvas was then squeezed into a 40 px
 * region -- so the arrow came out at 32/64 x 40 = **20 px** on a 140 px minimap, half the size the
 * client asked for.
 *
 * The client asks for the ARROW to be 40 px (`Minimap:SetPlayerTextureWidth(40)`), not the box around
 * it. A rotating square needs its diagonal to fit, so the box has to be at least 40 * sqrt(2) = 56.6.
 * 64 is that rounded up to a power of two, which a `CanvasTexture` uploads without a resize.
 *
 * So: region 64 px, art drawn at 40 px centred inside it, and the arrow is 40 px on screen at every
 * heading -- the number the client itself named, with the rotation slack around it rather than
 * inside it.
 */
const ARROW_PX = 64;

/**
 * How big the arrow is DRAWN, in the region's own pixels. Unsourced -- see the note at the `drawImage`.
 *
 * 30 rather than the client's 40: the owner compared ours against the real client and named this value
 * directly. 40 is the box the engine reserves for a MODEL, not the arrow drawn inside it.
 * `window.worldMinimapArrow(px)` overrides it.
 */
const DEFAULT_ARROW_DRAW_PX = 30;

/** The live override from `window.worldMinimapArrow(px)`, or null for the default above. */
let arrowDrawPx: number | null = null;

/** Set the drawn arrow size live. Returns what it settled on, for the console. */
export function setArrowDrawPx(px: number | null): number {
  arrowDrawPx = px !== null && Number.isFinite(px) && px > 0 ? Math.min(px, ARROW_PX) : null;
  return arrowDrawPx ?? DEFAULT_ARROW_DRAW_PX;
}

class PlayerArrowSprite {
  private readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D | null;

  private readonly texture: THREE.CanvasTexture;

  private art: HTMLCanvasElement | null = null;

  private loading = false;

  /**
   * The last facing drawn, quantised to whole degrees.
   *
   * Quantised so that standing still with a trembling heading costs nothing, and to DEGREES rather than
   * anything coarser because the arrow is the one thing on the minimap whose angle a player reads
   * directly -- a 5-degree step is visible as a stutter when turning slowly.
   */
  private lastDegrees = Number.NaN;

  constructor(
    private readonly glue: GlueArt,
    private readonly key: string,
    private readonly drawPx: () => number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ARROW_PX;
    this.canvas.height = ARROW_PX;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    /**
     * **`flipY = false`, AND LEAVING IT AT THREE'S DEFAULT IS WHY THE MINIMAP CAME OUT INVERTED.**
     *
     * The owner put our minimap beside the real client's at the same spot and the picture was turned
     * over. This is the third orientation defect on this project and the third time it was TWO
     * CONVENTIONS MEETING rather than a wrong texture -- and the convention was already written
     * down: `TextureLoader` creates every texture in this renderer with `flipY = false`,
     * `renderer.ts#writeQuadUVs` builds its UVs on that basis (`renderer.ts:157`), and
     * `material.ts:120` records the two cancelling flips. A `THREE.CanvasTexture` defaults to
     * `flipY = true`, so these two were the only textures in the interface sampled upside down.
     *
     * `text.ts:578` is the precedent and it is exact: every glyph sheet is a canvas too, and it sets
     * this line for this reason. Grepping the convention's existing home would have found it -- which
     * is the rule `CLAUDE.md` states about adopting a camera's whole convention, including the parts
     * that look like defaults.
     *
     * It fixes three things at once: the terrain's vertical axis, the arrow art, and the arrow's
     * apparent rotation DIRECTION -- the `-facing` derivation was made for an unflipped canvas, so a
     * mirrored one reverses it.
     */
    this.texture.flipY = false;
    this.glue.adopt(this.key, this.texture);
  }

  update(facing: number): boolean {
    if (this.ctx === null) {
      return false;
    }
    if (this.art === null) {
      this.load();
      return false;
    }
    const degrees = Math.round((facing * 180) / Math.PI);
    if (degrees === this.lastDegrees) {
      return false;
    }
    this.lastDegrees = degrees;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ARROW_PX, ARROW_PX);
    ctx.translate(ARROW_PX / 2, ARROW_PX / 2);
    /**
     * `-facing`, and the sign is the whole of the orientation question here.
     *
     * The game's orientation is 0 at NORTH and grows toward the world's +Y, which is WEST. On a
     * north-up minimap west is LEFT, and a canvas `rotate` with y pointing down turns CLOCKWISE for a
     * positive angle. So the arrow has to turn anticlockwise as the heading grows: negated.
     *
     * The same two conventions meeting that every orientation defect on this project has been -- named
     * here rather than discovered by negating a coordinate until it looked right.
     */
    ctx.rotate(-facing);
    /**
     * THE DRAWN SIZE, and `playerArrow`'s 40 turned out NOT to be it.
     *
     * The client asks for a 40 px player texture (`minimap.lua:11-12`) and that is what this drew,
     * and the owner's side-by-side against the real client says it is about twice too big. The reason
     * is that `<Minimap>` names a MODEL for the arrow -- `minimapPlayerModel="...MinimapArrow.mdx"`
     * -- and a model does not fill its texture box; the BLP beside it does. So 40 is the box the
     * engine reserves and the visible arrow inside it is smaller by a factor no file states.
     *
     * **UNSOURCED, and given a knob instead of a third guess**: `window.worldMinimapArrow(px)` sets
     * it live. That is the shape that settled the quest sparkle in one message from the owner rather
     * than three rounds of arithmetic here, and it is the same kind of number -- a proportion only a
     * side-by-side can judge.
     */
    const side = this.drawPx();
    ctx.drawImage(this.art, -side / 2, -side / 2, side, side);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.texture.needsUpdate = true;
    return true;
  }

  /** Force the next `update` to draw, whatever the heading has done. */
  invalidate(): void {
    this.lastDegrees = Number.NaN;
  }

  private load(): void {
    if (this.loading) {
      return;
    }
    this.loading = true;
    void (async () => {
      try {
        const spec = (await WorkerPool.enqueueAt(
          PRIORITY.BACKGROUND, 'BLP', 'Interface\\Minimap\\MinimapArrow.blp', true,
        )) as BlpSpec | null | undefined;
        if (spec && spec.format === BLP_IMAGE_FORMAT.IMAGE_ABGR8888 && spec.mipmaps.length > 0) {
          this.art = toCanvas(spec);
          // The heading has not changed, but the art has -- so the next update must be allowed to draw.
          this.lastDegrees = Number.NaN;
        } else {
          console.warn('minimap arrow: MinimapArrow.blp did not decode to RGBA');
        }
      } catch (error) {
        console.warn('minimap arrow: MinimapArrow.blp failed to load', error);
      } finally {
        // Left latched on purpose after a failure: a missing arrow is a cosmetic gap, and retrying a
        // 404 once per frame for the session is not a trade worth making.
        this.loading = true;
      }
    })();
  }

  dispose(): void {
    this.texture.dispose();
    this.art = null;
  }
}

/**
 * What the host holds: a per-tick draw and the teardown.
 *
 * SEPARATE FROM `map-bridge.ts`, and the split is load-bearing rather than tidy. The map bridge's Lua
 * globals must be registered **before the manifest runs**, because the client calls them from `OnLoad`:
 * `MinimapCluster:OnLoad` is `Minimap_Update()`, whose first line is `GetMinimapZoneText()`. So the
 * bridge is seeded (`world-runtime.ts#WorldRuntimeOptions.seed`). The drawing cannot be -- it needs the
 * object model's registry to create regions on a `Minimap` frame the manifest has not built yet. Two
 * lifetimes, two attachments.
 */
export interface MinimapTerrainHost {
  /**
   * Composite for this frame, and answer **whether any pixel changed**.
   *
   * The boolean is not a convenience. The interface renders to an offscreen target re-rendered only
   * when a draw-list FINGERPRINT changes, and these two canvases change their CONTENTS without changing
   * the list at all -- same widget, same rect, same sprite key. So the arrow turned only on the frames
   * something else happened to dirty the interface, which is what the owner saw.
   *
   * `ui/scene/model-booth.ts` had this exact problem with the same answer: `boothBaked` forces the full
   * draw "because a bake changes pixels the fingerprint cannot see". Same class of change, same signal.
   */
  tick: () => boolean;
  dispose: () => void;
}

/**
 * Give the client's `Minimap` frame its terrain and its player arrow, and keep both current.
 *
 * Both regions are created ENGINE-SIDE and neither is authored, which is correct rather than a
 * shortcut: there is no `<Texture>` for either anywhere in `minimap.xml`, because both are the engine's
 * own surface -- `<Minimap>` names the arrow as an attribute, not as art. `methods/statusbar.ts` creates
 * its bar fill the same way and for the same reason.
 *
 * The terrain sits at `BACKGROUND` so every piece of the client's own art lands on top of it, and fills
 * the frame exactly so the circular mask lines up with the round border drawn over it. The arrow sits at
 * `OVERLAY`, centred, at the size the client itself asked for.
 *
 * Created LAZILY on the first tick that finds the frame: this attaches right after the manifest, but a
 * frame that failed to load would otherwise mean a null captured for the whole session.
 */
export function attachMinimapTerrain(
  ctx: MethodContext, art: GlueArt, world: World,
): MinimapTerrainHost {
  let terrain: MinimapTerrain | null = null;
  let arrow: PlayerArrowSprite | null = null;
  let worldArrow: PlayerArrowSprite | null = null;
  let worldArrowFrame: number | null = null;
  let built = false;
  let minimapId: number | null = null;
  let disposed = false;

  const ensure = (): boolean => {
    if (built) {
      return true;
    }
    minimapId = ctx.registry.byName('Minimap');
    if (minimapId === null) {
      return false;
    }
    const frame = ctx.registry.widget(minimapId);
    if (frame === null) {
      return false;
    }

    terrain = new MinimapTerrain(art);
    const terrainRegion = ctx.registry.widget(ctx.registry.create('Texture', null, minimapId));
    if (terrainRegion === null) {
      return false;
    }
    terrainRegion.layer = 'BACKGROUND';
    terrainRegion.sprite = MINIMAP_TERRAIN_KEY;
    const fill = (point: 'TOPLEFT' | 'BOTTOMRIGHT') => ({
      point, relativePoint: point, relativeTo: frame.id, x: 0, y: 0,
    });
    terrainRegion.setAnchors(fill('TOPLEFT'), fill('BOTTOMRIGHT'));

    arrow = new PlayerArrowSprite(art, ARROW_KEY, () => arrowDrawPx ?? DEFAULT_ARROW_DRAW_PX);
    const arrowRegion = ctx.registry.widget(ctx.registry.create('Texture', null, minimapId));
    if (arrowRegion !== null) {
      arrowRegion.layer = 'OVERLAY';
      arrowRegion.sprite = ARROW_KEY;
      // `ARROW_PX`, not `playerArrow`: the region is the BOX and the client's 40 is the ARROW inside
      // it. Sizing the region to 40 shrank the arrow to 20 -- see the note on `ARROW_PX`.
      arrowRegion.setSize(ARROW_PX, ARROW_PX);
      arrowRegion.setAnchors({
        point: 'CENTER', relativePoint: 'CENTER', relativeTo: frame.id, x: 0, y: 0,
      });
    }

    /**
     * THE OWNER'S KNOB for the one number in the terrain that no file states.
     *
     * `window.worldMinimapZoom(400)` sets how many yards the minimap shows; no argument restores the
     * table. This is the shape that settled the quest sparkle's scale in a single message -- he looked,
     * named the value that fitted, and the guessing stopped.
     */
    (window as unknown as Record<string, unknown>).worldMinimapZoom = (yards?: number) => {
      terrain?.setWindowYards(typeof yards === 'number' ? yards : null);
      return yards ?? 'restored to the (unsourced) default table';
    };
    /**
     * `window.worldMinimapArrow(px)` -- the arrow's drawn size, the other unsourced number here.
     *
     * Invalidates the arrow's own gate as well as setting the value: that gate is the HEADING alone, so
     * a size change while standing still would otherwise not be drawn until the player turned.
     */
    /**
     * `window.worldMinimapBlips()` -- what the blip pass was asked to draw and whether its art is in.
     *
     * Three different failures look identical on screen: an empty list, an icon that never decoded,
     * and a mapping that puts every blip outside the 256-pixel canvas. This tells them apart.
     */
    /**
     * `window.worldMinimapBlipSource()` -- why the list is the length it is.
     *
     * The other probe says how many blips were ASKED for; this says where they did not come from.
     * `statuses` is what the server has told us about givers, `matched` how many of those have an
     * entity in the world to take a position from, and `group` how many party or raid tokens
     * resolve. A `statuses` of 0 is a packet problem; `statuses` high with `matched` 0 is a guid
     * format mismatch between the status map and `World#entities`, which is a real hazard here --
     * a 64-bit guid does not survive a JS number and `network/guid-hex.ts` is the one formatter.
     */
    (window as unknown as Record<string, unknown>).worldMinimapBlipSource = () => {
      const quests = world.game?.objectHandler?.questHandler ?? null;
      let matched = 0;
      let iconworthy = 0;
      const sample: unknown[] = [];
      quests?.status.forEach((status: number, guid: string) => {
        const marker = blipForStatus(status);
        if (marker !== null) {
          iconworthy += 1;
        }
        if (world.entities.get(guid)) {
          matched += 1;
        }
        if (sample.length < 5) {
          sample.push({
            guid,
            status,
            kind: marker?.kind ?? null,
            dim: marker?.dim ?? null,
            inWorld: !!world.entities.get(guid),
          });
        }
      });
      return {
        statuses: quests?.status.size ?? null,
        iconworthy,
        matched,
        entities: world.entities.size,
        group: GROUP_TOKENS.filter((t) => resolveUnitToken(t, world) !== null).length,
        sample,
      };
    };

    (window as unknown as Record<string, unknown>).worldMinimapBlips = () => (
      terrain?.blipReport() ?? { note: 'no terrain host yet' }
    );

    (window as unknown as Record<string, unknown>).worldMinimapArrow = (px?: number) => {
      const settled = setArrowDrawPx(typeof px === 'number' ? px : null);
      arrow?.invalidate();
      return settled;
    };
    (window as unknown as Record<string, unknown>).worldMapArrow = (px?: number) => {
      const settled = setWorldArrowDrawPx(typeof px === 'number' ? px : null);
      worldArrow?.invalidate();
      return settled;
    };
    built = true;
    return true;
  };

  /**
   * THE WORLD MAP'S ARROW, in the frame the engine creates for it.
   *
   * `WorldMapPlayer` -- the frame the client positions from `GetPlayerMapPosition` -- carries no
   * texture at all: the owner's own reading showed it shown, visible, alpha 1 and `sprite: null`. It
   * is the mouseover target, and the visible marker is the ENGINE's arrow, which the client asks for
   * with `CreateWorldMapArrowFrame` and then only ever calls `SetAlpha`/`SetFrameLevel` on
   * (`worldmapframe.lua:108,1421`). So the marker was never missing data -- it had nothing to draw.
   *
   * `ui/map-bridge.ts` creates `PlayerArrowEffectFrame` and `PositionWorldMapArrowFrame` already
   * moves it to where the client says, so this only has to put art inside it -- the same rotated
   * canvas the minimap uses, which is why that class is shared rather than copied.
   *
   * Lazily, because the frame is created during the manifest and this host attaches after it but the
   * world map may never be opened.
   */
  /**
   * The blips to draw this frame: quest givers, then the group.
   *
   * ## Quest givers come from the DESCRIPTOR-adjacent status map, not from a scan
   *
   * `QuestHandler.status` is guid -> `DIALOG_STATUS`, filled by `SMSG_QUESTGIVER_STATUS` and
   * `SMSG_QUESTGIVER_STATUS_MULTIPLE` -- the server's own answer to "what does this NPC have for
   * you", which is exactly what the icon shows. `blipForStatus` maps it to the `!` or the `?` and
   * answers null for everything else, so an NPC mid-quest gets no marker -- which is what the real
   * client does.
   *
   * An entry whose entity is not in the world is skipped rather than dropped: the status map
   * outlives an NPC leaving range, and it is the right cache to keep -- re-entering range should not
   * need a new query.
   *
   * ## The group is resolved through the same tokens everything else uses
   *
   * `party1..4` and `raid1..40`, through `resolveUnitToken`, so membership means here what it means
   * in the unit frames and on the world map. A member out of range resolves to null and gets no dot,
   * which is correct: the minimap only shows what is nearby.
   *
   * ## Cost
   *
   * Called once per frame, and it is a walk of the status map plus 44 token lookups -- but the LIST
   * is only ever fed to a composite that the fingerprint gate rejects unless something moved a whole
   * yard. So the per-frame cost is the walk, and the drawing is as rare as the terrain repaint.
   * `RAID_TOKENS` is built once for that reason; building it here would allocate 40 strings a frame.
   */
  const blipsNow = (): Blip[] => {
    const out: Blip[] = [];
    const quests = world.game?.objectHandler?.questHandler ?? null;
    if (quests !== null) {
      quests.status.forEach((status: number, guid: string) => {
        const marker = blipForStatus(status);
        const unit = marker === null ? null : world.entities.get(guid) ?? null;
        if (marker !== null && unit) {
          out.push({
            worldX: unit.position.x,
            worldY: unit.position.y,
            kind: marker.kind,
            dim: marker.dim,
          });
        }
      });
    }
    for (const token of GROUP_TOKENS) {
      const unit = resolveUnitToken(token, world);
      if (unit) {
        out.push({
          worldX: unit.position.x,
          worldY: unit.position.y,
          kind: token.startsWith('raid') ? 'raid' : 'party',
        });
      }
    }
    return out;
  };

  const ensureWorldArrow = (): boolean => {
    if (worldArrowFrame !== null) {
      return true;
    }
    // The ARROW's frame and not the EFFECT's: the client sets the effect frame to alpha 0.65 and a
    // child cannot undo that. `ui/map-bridge.ts` creates this sibling at full alpha for exactly this,
    // and moves both with the same `PositionWorldMapArrowFrame`.
    const frame = ctx.registry.byName('__worldMapPlayerArrow');
    if (frame === null) {
      return false;
    }
    const parent = ctx.registry.widget(frame);
    if (parent === null) {
      return false;
    }
    worldArrow = new PlayerArrowSprite(
      art, WORLD_ARROW_KEY, () => worldArrowDrawPx ?? DEFAULT_WORLD_ARROW_PX,
    );
    const region = ctx.registry.widget(ctx.registry.create('Texture', null, frame));
    if (region === null) {
      return false;
    }
    region.layer = 'OVERLAY';
    region.sprite = WORLD_ARROW_KEY;
    region.setSize(ARROW_PX, ARROW_PX);
    region.setAnchors({
      point: 'CENTER', relativePoint: 'CENTER', relativeTo: parent.id, x: 0, y: 0,
    });
    worldArrowFrame = frame;
    return true;
  };

  return {
    /**
     * Composite for where the player is now. Called once per UI tick.
     *
     * A tick that changes nothing costs the `visible` walk, four numeric compares in the terrain's gate
     * and one in the arrow's -- see this file's header on why both gates are quantised rather than
     * timed. Gated on the frame being VISIBLE too, so `ToggleMinimap` costs nothing at all.
     */
    tick: () => {
      if (disposed || !ensure()) {
        return false;
      }
      const frame = minimapId === null ? null : ctx.registry.widget(minimapId);
      if (frame === null || !frame.visible) {
        return false;
      }
      const player = world.player;
      const map = world.map as unknown as { internalName?: string } | null;
      if (!player || !map || typeof map.internalName !== 'string') {
        return false;
      }
      // BOTH evaluated, not short-circuited: a `||` between the calls would skip the arrow on any
      // frame the terrain happened to repaint.
      const painted = terrain === null ? false : terrain.update(
        map.internalName, player.position.x, player.position.y, zoomOf(frame), blipsNow(),
      );
      const turned = arrow === null ? false : arrow.update(player.facing ?? 0);
      // `onMap`, not `world`: this closure already has a `world` -- the World itself.
      const onMap = ensureWorldArrow()
        ? (worldArrow?.update(player.facing ?? 0) ?? false)
        : false;
      return painted || turned || onMap;
    },
    dispose: () => {
      disposed = true;
      terrain?.dispose();
      arrow?.dispose();
      worldArrow?.dispose();
      terrain = null;
      arrow = null;
      worldArrow = null;
      delete (window as unknown as Record<string, unknown>).worldMinimapZoom;
      delete (window as unknown as Record<string, unknown>).worldMinimapArrow;
      delete (window as unknown as Record<string, unknown>).worldMinimapBlips;
      delete (window as unknown as Record<string, unknown>).worldMinimapBlipSource;
      delete (window as unknown as Record<string, unknown>).worldMapArrow;
    },
  };
}

export default MinimapTerrain;
