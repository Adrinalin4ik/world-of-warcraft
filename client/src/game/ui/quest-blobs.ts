/**
 * THE QUEST BLOB -- the shaded area an objective covers, which is the other half of the POI reply.
 *
 * The owner, with the pins working: "должна быть еще и область на которой квест выполняется." The pins
 * come from `QuestPOIGetIconInfo`; the area comes from `WorldMapBlobFrame:DrawQuestBlob(questId, show)`
 * and the same `SMSG_QUEST_POI_QUERY_RESPONSE` polygon. One reply, two drawings.
 *
 * ## Why a canvas and not widgets
 *
 * The widget layer draws axis-aligned quads. A POI area is an arbitrary polygon, so it cannot be built
 * out of regions -- and this is the pattern the project already proved twice: rasterise into a canvas,
 * hand the canvas to `art.adopt` under a key, and let one existing region draw it. `ui/minimap-terrain.ts`
 * is the precedent for the terrain and for both player arrows.
 *
 * The region already exists in the client's own XML: `WorldMapBlobFrameTexture`, declared
 * `setAllPoints="true"` inside `<QuestPOIFrame name="WorldMapBlobFrame">` at 1002x668
 * (`worldmapframe.xml:675-689`). So nothing is created here -- the blob frame's own texture gets a
 * sprite, which is exactly what an engine would do with it.
 *
 * ## `DrawQuestBlob(questId, show)` is ONE blob, not a set
 *
 * Read off the client's ten call sites rather than assumed: every one draws the hovered or selected
 * quest with `true` and takes it away with `false` (`worldmapframe.lua:1571,1629,1647,1689-1691,
 * 1785,1801,1846,2065,2078`). The quest LIST pass draws every row with `false`, i.e. it clears. So the
 * state here is a single active quest id, and `false` for the active one erases.
 *
 * ## Cost
 *
 * **Zero per frame.** The canvas is redrawn only when the active quest id, the alphas or the polygon
 * set change, and the texture is uploaded only on that redraw -- the same fingerprint discipline the
 * offscreen interface target depends on. A redraw is one 1002x668 clear plus a few dozen `lineTo`s;
 * measured against nothing per frame, which is the point.
 *
 * The canvas is allocated on the first `DrawQuestBlob` and never on a map that is only ever opened
 * without a quest selected.
 */
import * as THREE from 'three';

import WorkerPool, { PRIORITY } from '../pipeline/worker/pool';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';
import type { GlueArt } from './art';
import type { MethodContext } from './framexml/lua/object';

/** The key `WorldMapBlobFrameTexture`'s sprite is adopted under. */
const BLOB_KEY = '__worldMapQuestBlob';

/**
 * The canvas size, and it is the blob frame's own authored size.
 *
 * `<QuestPOIFrame name="WorldMapBlobFrame">` is `<AbsDimension x="1002" y="668"/>`
 * (`worldmapframe.xml:676-678`), the same numbers as `WorldMapButton`. Drawing at that size means one
 * canvas pixel is one sheet pixel at full size, so the polygon needs no scale of its own -- and the
 * client scales the frame itself in the windowed state, which stretches the texture with it.
 */
const BLOB_WIDTH = 1002;

const BLOB_HEIGHT = 668;

/**
 * THE CLIENT'S OWN BLOB ART, and the reason there are two files rather than one colour.
 *
 * `WorldMapBlobFrame_OnLoad` names them: `SetFillTexture("Interface\\WorldMap\\UI-QuestBlob-Inside")`
 * and `SetBorderTexture("...-Outside")` (`worldmapframe.lua:1912-1913`). Measured on the served
 * files -- the inside is `BLP2` 64x64, DXT, **alphaDepth 0**, so an opaque TILE; the outside is
 * `BLP2` 16x16, DXT, alphaDepth 8, alphaType 7, a small strip for the edge.
 *
 * They are loaded and used as canvas PATTERNS rather than approximated by a flat colour. The first
 * version of this file filled with a flat yellow and the owner saw it at once: "она желтая, а в
 * оригинале светло синяя". Guessing a colour twice is worse than reading the file once.
 */
const FILL_ART = 'Interface\\WorldMap\\UI-QuestBlob-Inside.blp';

const BORDER_ART = 'Interface\\WorldMap\\UI-QuestBlob-Outside.blp';

/**
 * What is drawn until the art arrives -- and these are MEASURED, not chosen.
 *
 * The mean of every DXT endpoint pair in each file's top mip: the inside is `(57, 111, 127)`, a
 * desaturated blue-teal, and the outside `(102, 190, 255)`, a light blue. So the fallback is the
 * right hue even on the first hover before the decode lands, which is the frame the owner sees
 * first.
 */
const FILL_FALLBACK = [57, 111, 127];

const BORDER_FALLBACK = [102, 190, 255];

/** What a decoded BLP comes back as. Only the fields this file reads. */
interface BlpSpec {
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
}

/** One objective area, already projected to 0..1 of the displayed sheet. */
export interface BlobPolygon {
  points: { x: number; y: number }[];
}

/**
 * Where the polygons come from. Installed by `ui/map-bridge.ts`, which owns the world, the quest
 * handler and the selected row.
 *
 * A separate sink rather than a constructor argument because `QUESTPOIFRAME.DrawQuestBlob` lives in the
 * method table (`framexml/lua/methods/frame.ts`) and a `MethodContext` carries no `World` -- the same
 * reason `ui/map-selection.ts` is a module sink.
 */
export type BlobSource = (questId: number) => BlobPolygon[];

let source: BlobSource | null = null;

export function setBlobSource(next: BlobSource | null): void {
  source = next;
}

class QuestBlobs {
  private canvas: HTMLCanvasElement | null = null;

  private texture: THREE.CanvasTexture | null = null;

  private art: GlueArt | null = null;

  /** The two patterns, null until their BLP has decoded. See `FILL_ART`. */
  private fillPattern: CanvasPattern | null = null;

  private borderPattern: CanvasPattern | null = null;

  private loadingArt = false;

  /**
   * The last context a draw came through, so a LATE art arrival can repaint.
   *
   * The alternative was threading a context into the async callback, which would pin one from
   * whenever the load started -- and this host can be double-mounted with one copy disposed, which
   * is the documented way a stale handle gets held here. The most recent draw is the live one.
   */
  private lastCtx: MethodContext | null = null;

  private active = 0;

  private fillAlpha = 128;

  private borderAlpha = 192;

  /** What the last paint was drawn from. The redraw gate -- see the header on cost. */
  private painted = '';

  /**
   * Set on every repaint, cleared by `takeRepainted`. **The interface will not redraw without it.**
   *
   * The offscreen UI target is repainted only when the draw-list FINGERPRINT changes, and a canvas
   * whose contents change does not change the draw list at all -- the region, its rect and its sprite
   * key are identical from one quest to the next. So the first blob would appear (the sprite key is
   * new) and every blob after it would be invisible: the texture uploads and nothing redraws.
   *
   * This is the documented trap on this project -- `boothBaked` and the minimap's `tick()` return
   * exist for exactly the same reason -- and it is the kind of defect where every piece of state is
   * right and only the last hop is missing.
   */
  private repainted = false;

  /** Installed by the world UI host, which is where a `GlueArt` exists. */
  attach(art: GlueArt): void {
    this.art = art;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.canvas = null;
    this.art = null;
    this.active = 0;
    this.painted = '';
    this.repainted = false;
  }

  /**
   * Whether a repaint happened since the last call, and CLEARS the flag. Polled once per frame by
   * `ui/world-ui.ts`, which feeds it into the same dirty test `boothBaked` uses.
   *
   * One boolean read and write per frame, which is the whole per-frame cost of this file.
   */
  takeRepainted(): boolean {
    const was = this.repainted;
    this.repainted = false;
    return was;
  }

  /** `SetFillAlpha` / `SetBorderAlpha` -- 0..255, which is the scale the client passes. */
  setFillAlpha(value: number): void {
    this.fillAlpha = Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : this.fillAlpha;
  }

  setBorderAlpha(value: number): void {
    this.borderAlpha = Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : this.borderAlpha;
  }

  /**
   * `DrawQuestBlob(questId, show)`.
   *
   * `show` false for the ACTIVE quest erases; false for any other quest is the list pass and is
   * ignored, because erasing there would undo the selection the same frame it was made.
   */
  draw(ctx: MethodContext, questId: number, show: boolean): void {
    const wanted = show ? questId : 0;
    if (!show && questId !== this.active) {
      return;
    }
    this.active = wanted;
    this.repaint(ctx);
  }

  /**
   * Decode the two art files once, then force a repaint so the flat fallback is replaced.
   *
   * At `BACKGROUND` priority in the existing pool, the same way `pipeline/zone-highlight.ts` reads
   * its outline -- 3.9 KB and 1.5 KB, once per session. Kicked off from the first repaint rather
   * than at attach, so a session that never selects a quest never asks for them.
   *
   * A failure leaves the patterns null and the measured fallbacks in place, which is why the
   * fallbacks are the real colours and not placeholders. `loadingArt` is never released: one attempt
   * is enough for a file that either exists or does not, and retrying per hover would be a request
   * per mouse move.
   */
  private loadArt(): void {
    if (this.loadingArt) {
      return;
    }
    this.loadingArt = true;
    void (async () => {
      const make = async (path: string): Promise<CanvasPattern | null> => {
        const spec = (await WorkerPool.enqueueAt(
          PRIORITY.BACKGROUND, 'BLP', path, true,
        )) as BlpSpec | null | undefined;
        const level = spec?.mipmaps[0];
        if (!spec || level === undefined || spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888) {
          return null;
        }
        const tile = document.createElement('canvas');
        tile.width = level.width;
        tile.height = level.height;
        const into = tile.getContext('2d');
        if (into === null) {
          return null;
        }
        // The decoder gives RGBA in that order (`pipeline/blp/loader.js`), which is what
        // `ImageData` wants, so this is a copy and not a conversion.
        into.putImageData(
          new ImageData(new Uint8ClampedArray(level.data), level.width, level.height), 0, 0,
        );
        return this.canvas?.getContext('2d')?.createPattern(tile, 'repeat') ?? null;
      };
      try {
        const [fill, border] = await Promise.all([make(FILL_ART), make(BORDER_ART)]);
        this.fillPattern = fill;
        this.borderPattern = border;
      } catch (error) {
        console.warn('quest blob: the blob art failed to load, keeping the flat fill', error);
        return;
      }
      // Force the gate: the fingerprint has not changed, but what it would paint has.
      this.painted = '';
      if (this.lastCtx !== null) {
        this.repaint(this.lastCtx);
      }
    })();
  }

  private repaint(ctx: MethodContext): void {
    this.lastCtx = ctx;
    const art = this.art;
    if (art === null) {
      return;
    }
    const polygons = this.active > 0 && source !== null ? source(this.active) : [];
    // The gate: the id, the two alphas and the polygon count and first point. A polygon set only ever
    // changes with the quest, so this is enough to make a re-hover of the same row free.
    const fingerprint = [
      this.active, this.fillAlpha, this.borderAlpha, polygons.length,
      polygons[0]?.points.length ?? 0,
      polygons[0]?.points[0]?.x ?? 0, polygons[0]?.points[0]?.y ?? 0,
    ].join(':');
    if (fingerprint === this.painted) {
      return;
    }
    this.painted = fingerprint;
    this.repainted = true;

    if (this.canvas === null) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = BLOB_WIDTH;
      this.canvas.height = BLOB_HEIGHT;
      this.texture = new THREE.CanvasTexture(this.canvas);
      // `flipY = false` -- this renderer's own convention, and a `CanvasTexture` defaults to true.
      // The third orientation defect on this project was exactly this line missing; see
      // `ui/minimap-terrain.ts` for the write-up.
      this.texture.flipY = false;
      art.adopt(BLOB_KEY, this.texture);
    }
    const paint = this.canvas.getContext('2d');
    if (paint === null || this.texture === null) {
      return;
    }
    paint.clearRect(0, 0, BLOB_WIDTH, BLOB_HEIGHT);
    /**
     * THE ALPHAS ARE THE CLIENT'S; THE RGB IS NOT, AND IS LABELLED AS SUCH.
     *
     * `WorldMapBlobFrame_OnLoad` sets `SetFillAlpha(128)` and `SetBorderAlpha(192)`
     * (`worldmapframe.lua:1914-1915`) and `WorldMapFrame_SetOpacity` rescales both
     * (`worldmapframe.lua:2150-2151`), so those two numbers come from the client and arrive through
     * the setters above.
     *
     * The COLOURS are named art -- `Interface\WorldMap\UI-QuestBlob-Inside` and `-Outside`
     * (`worldmapframe.lua:1912-1913`) -- and this fills with a flat approximation of them rather
     * than the decoded files. That is a real difference from the client and it is stated rather
     * than hidden: the art is a tiling pattern, and reading it needs the BLP decoded and used as a
     * canvas pattern. Worth doing; not done here.
     */
    this.loadArt();
    paint.globalAlpha = this.fillAlpha / 255;
    paint.fillStyle = this.fillPattern
      ?? `rgb(${FILL_FALLBACK[0]}, ${FILL_FALLBACK[1]}, ${FILL_FALLBACK[2]})`;
    paint.strokeStyle = this.borderPattern
      ?? `rgb(${BORDER_FALLBACK[0]}, ${BORDER_FALLBACK[1]}, ${BORDER_FALLBACK[2]})`;
    paint.lineWidth = 2;
    for (const polygon of polygons) {
      if (polygon.points.length < 2) {
        continue;
      }
      paint.beginPath();
      polygon.points.forEach((point, at) => {
        const x = point.x * BLOB_WIDTH;
        const y = point.y * BLOB_HEIGHT;
        if (at === 0) {
          paint.moveTo(x, y);
        } else {
          paint.lineTo(x, y);
        }
      });
      paint.closePath();
      paint.fill();
      // The border carries its own alpha, so it is set per stroke rather than once: the two are
      // different numbers in the client (128 and 192) and one `globalAlpha` cannot serve both.
      paint.globalAlpha = this.borderAlpha / 255;
      paint.stroke();
      paint.globalAlpha = this.fillAlpha / 255;
    }
    this.texture.needsUpdate = true;

    // The region is the client's own, and it only needs its sprite set once.
    const region = ctx.registry.byName('WorldMapBlobFrameTexture');
    const widget = region === null ? null : ctx.registry.widget(region);
    if (widget !== null && widget.sprite !== BLOB_KEY) {
      widget.sprite = BLOB_KEY;
    }
  }
}

/**
 * The one instance. A singleton for the same reason the source is a sink: the method table reaches it
 * without a `World`, and there is exactly one world map.
 */
export const questBlobs = new QuestBlobs();
