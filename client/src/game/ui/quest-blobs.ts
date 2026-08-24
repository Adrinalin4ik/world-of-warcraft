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

  private repaint(ctx: MethodContext): void {
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
    paint.fillStyle = `rgba(255, 208, 64, ${this.fillAlpha / 255})`;
    paint.strokeStyle = `rgba(255, 240, 160, ${this.borderAlpha / 255})`;
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
      paint.stroke();
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
