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
 * So it is redrawn only when the picture would actually CHANGE BY A PIXEL: `signature()` quantises the
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

  /** `<mapName>/<A>_<B>` -> the decoded tile, or a remembered miss. LRU by insertion order. */
  private readonly tiles = new Map<string, TileEntry>();

  /** In flight, so a walk across a seam asks once. Released in a `finally` -- see `CLAUDE.md`. */
  private readonly loading = new Set<string>();

  /** The last composite's quantised inputs, so a stationary player costs nothing. */
  private last = '';

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
    this.last = '';
  }

  /**
   * Redraw if the picture would change, otherwise do nothing.
   *
   * Called once per UI tick from the map bridge. The early return is the whole performance story: see
   * this file's header on the pixel-quantised signature.
   */
  update(mapName: string, worldX: number, worldY: number, zoom: number): void {
    if (this.disposed || this.ctx === null || mapName === '') {
      return;
    }
    const windowYards = this.windowFor(zoom);
    const perPixel = windowYards / TERRAIN_PX;
    // Quantised to whole destination pixels: a move smaller than one pixel cannot change the image.
    const signature = `${mapName}/${windowYards}/`
      + `${Math.round(worldX / perPixel)}/${Math.round(worldY / perPixel)}`;
    if (signature === this.last) {
      return;
    }
    this.last = signature;
    this.composite(mapName, worldX, worldY, windowYards);
  }

  private composite(mapName: string, worldX: number, worldY: number, windowYards: number): void {
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
        ctx.drawImage(tile, rect.x, rect.y, rect.size, rect.size);
      }
    }

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
      this.last = '';
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

export default MinimapTerrain;
