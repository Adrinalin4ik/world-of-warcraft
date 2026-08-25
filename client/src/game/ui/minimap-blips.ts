/**
 * THE MINIMAP'S BLIPS -- the quest-giver `!`/`?` and the party dots, drawn into the terrain canvas.
 *
 * The owner asked for "индикаторы квестгиверов" and the tracked-quest markers, with a screenshot of the
 * real client showing a `?` inside the circle.
 *
 * ## Engine work, and the engine is us
 *
 * **FrameXML draws no blips at all.** Checked against the served `minimap.lua` and `minimap.xml`: the
 * only `Minimap:` calls in either are `GetZoom`, `SetZoom`, `GetZoomLevels`, `PingLocation`,
 * `SetPlayerTexture*`, `GetWidth`/`GetHeight` and `Show`/`Hide`/`IsShown`. The blips are the engine's,
 * which on this project means TypeScript -- the same division that puts the terrain and the player
 * arrow in `ui/minimap-terrain.ts`. Nothing here is a hand-built frame; there is no frame at all, only
 * pixels in the canvas the `<Minimap>` widget already draws.
 *
 * ## THE ART, and which parts of it are sourced
 *
 * Measured on the served files, because the obvious guess was wrong twice:
 *
 *  - `Interface\Minimap\ObjectIcons.blp` is `BLP2` 256x64, DXT with alpha, **sixteen 32x32 cells whose
 *    alpha is the SAME filled circle** -- decoded and compared, all sixteen are 281 of 1024 pixels
 *    opaque with identical outlines. It is a colour PALETTE of dots, not a set of glyphs. The cell
 *    colours are, in order: two blue-violets, red, amber, green, red, amber, green, amber, orange,
 *    orange, two blues, green, blue-violet, black.
 *  - `Interface\Minimap\Tracking\ObjectIcons.blp` is the same shape and also all circles.
 *
 * So neither atlas holds a `?`. The two glyphs the owner's screenshot shows are the client's own
 * quest-giver icons, `Interface\GossipFrame\AvailableQuestIcon` and `ActiveQuestIcon`, both of which
 * the host serves. **Stated plainly: the real engine may take its minimap `?` from art this project has
 * not identified.** These two are the client's, they are the right two glyphs, and using them is a
 * sourced choice rather than a drawn-by-hand one -- but it is a choice, not a derivation.
 *
 * ## Cost
 *
 * Three BLPs, once per session, at `BACKGROUND` priority in the existing pool, and only in a session
 * that actually has a blip to draw. Per composite it is one `drawImage` per blip inside a pass that was
 * already happening -- the terrain's -- so the blips add no texture upload, no draw call and **no
 * draw-list fingerprint change**. The gate that decides whether to composite at all is in
 * `minimap-terrain.ts` and this file extends its fingerprint rather than bypassing it: a party that has
 * not moved a whole pixel costs nothing.
 */
import WorkerPool, { PRIORITY } from '../pipeline/worker/pool';
import { BLP_IMAGE_FORMAT } from '../../wow-data-parser/blp/const';
import { DIALOG_STATUS } from '../../network/game/object/quest';

/** What a decoded BLP comes back as. Only the fields this file reads. */
interface BlpSpec {
  format: number;
  mipmaps: { width: number; height: number; data: Uint8Array }[];
}

/**
 * The kinds of blip this file knows how to draw.
 *
 * Deliberately not "any texture": a caller that could ask for arbitrary art would make the icon
 * loading unbounded, and the whole cost argument above depends on the set being small and fixed.
 */
export type BlipKind = 'questAvailable' | 'questComplete' | 'party' | 'raid';

export interface Blip {
  /** World coordinates -- the same space the player's position and the terrain window are in. */
  worldX: number;
  worldY: number;
  kind: BlipKind;
  /**
   * Drawn at reduced alpha -- the GREY variant of the same glyph.
   *
   * A separate flag rather than four more kinds, because the ART is identical: WotLK draws the same
   * `!` and `?` desaturated for the low-level and in-progress cases. One texture, two alphas.
   */
  dim?: boolean;
  /**
   * The member's `classId`, for a group dot. Undefined for a quest glyph and for an unknown class.
   *
   * The dot is drawn in the CLASS colour -- the owner: "это должна быть точка, цвет которой должен
   * отражать цвет класса." So the colour is data on the blip rather than a fixed atlas cell.
   */
  classId?: number;
}

/**
 * Every `DIALOG_STATUS` that draws a glyph, and whether it draws it GREY.
 *
 * **`INCOMPLETE` was the bug, and the owner's own probe found it.** The first version returned null
 * for it on the reasoning that a quest already in the log needs no marker. His session then had
 * eight givers in range, seven at `NONE` and one at `INCOMPLETE`, so the report read
 * `statuses: 8, matched: 8, iconworthy: 0` -- the packet was fine, the guids matched, and my own
 * filter threw away the only thing there was to draw.
 *
 * WotLK draws the same two glyphs desaturated for the cases that are not a fresh offer or a
 * finished turn-in: a grey `?` for a quest in the log and not done, and a grey `!` or `?` for the
 * LOW_LEVEL variants -- a quest so far below the player that the client dims it. So the mapping is
 * a glyph plus a `dim` flag, not four more textures.
 *
 * The statuses are 3.3.5a's own (`network/game/object/quest.ts:112-124`), so nothing here is a
 * literal. `NONE` and `UNAVAILABLE` are the two that genuinely draw nothing.
 */
export function blipForStatus(status: number): { kind: BlipKind; dim: boolean } | null {
  switch (status) {
    case DIALOG_STATUS.AVAILABLE:
    case DIALOG_STATUS.AVAILABLE_REP:
      return { kind: 'questAvailable', dim: false };
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP:
      return { kind: 'questAvailable', dim: true };
    case DIALOG_STATUS.REWARD:
    case DIALOG_STATUS.REWARD2:
    case DIALOG_STATUS.REWARD_REP:
      return { kind: 'questComplete', dim: false };
    case DIALOG_STATUS.LOW_LEVEL_REWARD_REP:
    case DIALOG_STATUS.INCOMPLETE:
      return { kind: 'questComplete', dim: true };
    default:
      return null;
  }
}
const ICON_PATHS: Record<'questAvailable' | 'questComplete', string> = {
  questAvailable: 'Interface\\GossipFrame\\AvailableQuestIcon.blp',
  questComplete: 'Interface\\GossipFrame\\ActiveQuestIcon.blp',
  // `dots` IS GONE: the group dot is drawn as a filled arc in the class colour, so there is one
  // fewer BLP to decode and no dependence on an atlas layout whose colours I measured but whose
  // meaning I did not. See `CLASS_COLOURS`.
};

/**
 * `RAID_CLASS_COLORS`, READ OUT OF THE CLIENT'S OWN FILE -- `constants.lua:54-65`.
 *
 * Keyed by `classId` here rather than by the uppercase token FrameXML uses, because a blip has a
 * `Unit` and a unit carries the id. The ids are 3.3.5a's `ChrClasses` order, which
 * `pipeline/dbc/race-class-data.ts` already resolves to those same tokens.
 *
 * **The dot is drawn, not sampled from an atlas, and that is a change of approach.** The first
 * version took a blue circle out of `ObjectIcons`, which was wrong twice over: the owner reported it
 * as "не точка, а скорее вопросительный знак" -- so whatever that atlas cell drew was not the dot I
 * expected -- and a fixed cell cannot carry a class colour at all. A filled arc needs no atlas, no
 * decode and no assumption about a layout I only measured the alpha of.
 */
const CLASS_COLOURS: Record<number, readonly [number, number, number]> = {
  1: [0.78, 0.61, 0.43], // Warrior
  2: [0.96, 0.55, 0.73], // Paladin
  3: [0.67, 0.83, 0.45], // Hunter
  4: [1.0, 0.96, 0.41], // Rogue
  5: [1.0, 1.0, 1.0], // Priest
  6: [0.77, 0.12, 0.23], // Death Knight
  7: [0.0, 0.44, 0.87], // Shaman
  8: [0.41, 0.8, 0.94], // Mage
  9: [0.58, 0.51, 0.79], // Warlock
  11: [1.0, 0.49, 0.04], // Druid
};

/** What a dot with no known class draws. The client's own unknown-unit grey. */
const UNKNOWN_CLASS: readonly [number, number, number] = [0.63, 0.63, 0.63];

/**
 * How big a blip draws, in canvas pixels of the 256-pixel minimap. UNSOURCED -- see `drawSize`.
 *
 * 16 was too small on the owner's screen ("маленький слишком"), so the quest glyph is 24 and the dot
 * 12. Both are still read off his screenshot of the real client rather than derived, which is why
 * `window.worldMinimapBlipSize(quest, dot)` exists: this is the fourth number on this project that
 * one live call settles faster than any amount of arithmetic here.
 */
let questIconPx = 22;

let dotPx = 13;

/** Set both blip sizes live. Returns what they settled on, for the console. */
export function setBlipSizes(quest?: number, dot?: number): { quest: number; dot: number } {
  if (typeof quest === 'number' && Number.isFinite(quest) && quest > 0) {
    questIconPx = Math.min(quest, 64);
  }
  if (typeof dot === 'number' && Number.isFinite(dot) && dot > 0) {
    dotPx = Math.min(dot, 64);
  }
  return { quest: questIconPx, dot: dotPx };
}

/**
 * **NO DIMMING. The owner asked for it gone: "полупрозрачность нужно убрать".**
 *
 * The grey `?` was my approximation of what WotLK draws for an in-progress quest, done by alpha on
 * the yellow texture. He looked at it beside the real client and said no, so the `dim` flag is kept
 * on the data -- it is a true fact about the status, and a later change may want it -- and it no
 * longer changes what is painted.
 *
 * Kept rather than deleted deliberately: throwing away the distinction would mean re-deriving
 * `blipForStatus` from scratch if the grey variant turns out to want a different TEXTURE, which is
 * what the real client actually uses.
 */
const DIM_ALPHA = 1;

/**
 * The dark ring around a GROUP DOT, and only around a dot.
 *
 * Asked for as "обводка вокруг как в оригинале", then withdrawn for the quest glyphs once he saw it:
 * a circle around an icon reads as a second object rather than as its edge. The real client carries
 * the border inside the icon texture, which is why stroking around one cannot look like it.
 *
 * On a dot it is doing real work: a flat class colour on light terrain has no edge of its own.
 */
const OUTLINE_RGBA = 'rgba(0, 0, 0, 0.85)';

const OUTLINE_PX = 2;

export class MinimapBlips {
  private readonly icons = new Map<string, HTMLCanvasElement | null>();

  private loading = false;

  /**
   * Set when an icon lands, cleared by `takeArtArrived`. **Without it the first blips never draw.**
   *
   * `draw` is what kicks the load off, so the composite that first wanted a blip has no icon yet and
   * draws nothing. The composite GATE then rejects every later frame, because the fingerprint has
   * not changed -- the blip is in the same place. So the icons arrive and nothing ever paints them.
   *
   * Third instance of this exact shape on this project (`boothBaked`, the quest blob's art), and
   * the same rule catches it: a canvas whose CONTENTS change must announce it, because the
   * draw-list fingerprint cannot see inside a texture.
   */
  private artArrived = false;

  /** Whether an icon landed since the last call, and CLEARS the flag. Polled by the terrain gate. */
  takeArtArrived(): boolean {
    const was = this.artArrived;
    this.artArrived = false;
    return was;
  }

  /**
   * What the last `draw` was asked to paint, for `window.worldMinimapBlips()`.
   *
   * The owner reports no dots. Every piece of state here could be right with the LAST HOP missing --
   * an empty list, an icon that never decoded, or a mapping that puts every blip off-canvas -- and
   * those three look identical on screen. This separates them in one console call.
   */
  private lastDraw: Record<string, unknown> = { drawn: 0, asked: 0 };

  report(): Record<string, unknown> {
    return {
      ...this.lastDraw,
      icons: Object.fromEntries(
        Object.entries(ICON_PATHS).map(([name, path]) => [
          name, this.icons.has(path) ? (this.icons.get(path) ? 'loaded' : 'MISSING') : 'pending',
        ]),
      ),
    };
  }

  /**
   * A cheap fingerprint of a blip set, for the composite gate in `minimap-terrain.ts`.
   *
   * Quantised to whole yards, so a party member walking on the spot cannot force a repaint, and summed
   * per axis rather than concatenated so the cost is one pass and one string of fixed length. A sum can
   * collide in principle -- two members swapping positions -- and that is acceptable here: the failure
   * mode is one stale composite until anything else moves, and the alternative is a per-frame string
   * build proportional to the party.
   */
  // eslint-disable-next-line class-methods-use-this
  fingerprint(blips: Blip[]): string {
    let x = 0;
    let y = 0;
    let kinds = 0;
    for (const blip of blips) {
      x += Math.round(blip.worldX);
      y += Math.round(blip.worldY);
      kinds += blip.kind.length;
    }
    return `${blips.length}:${x}:${y}:${kinds}`;
  }

  /**
   * Draw the blips into a composite already in progress, in the terrain's own pixel space.
   *
   * `toCanvas` maps a world position to canvas pixels -- passed in rather than recomputed, because the
   * terrain owns the window and the rounding, and two copies of that arithmetic would be two chances
   * to disagree with the tiles underneath.
   *
   * Called BEFORE the circular mask, so a blip near the rim is clipped by the same arc the terrain is
   * and cannot spill outside the minimap.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    blips: Blip[],
    toCanvas: (worldX: number, worldY: number) => { x: number; y: number },
  ): void {
    this.lastDraw = { asked: blips.length, drawn: 0, samples: [] as unknown[] };
    if (blips.length === 0) {
      return;
    }
    this.load();
    for (const blip of blips) {
      const at = toCanvas(blip.worldX, blip.worldY);
      const side = MinimapBlips.drawSize(blip.kind);
      const samples = this.lastDraw.samples as unknown[];
      if (samples.length < 6) {
        samples.push({
          kind: blip.kind,
          world: [Math.round(blip.worldX), Math.round(blip.worldY)],
          canvas: [Math.round(at.x), Math.round(at.y)],
        });
      }
      this.lastDraw.drawn = (this.lastDraw.drawn as number) + 1;
      if (blip.kind === 'party' || blip.kind === 'raid') {
        /**
         * A FILLED DOT IN THE CLASS COLOUR, drawn rather than sampled.
         *
         * See `CLASS_COLOURS` for why the atlas is gone. The ring is the same one the glyphs get,
         * so a dot on light terrain stays visible -- which is the whole job of a border here.
         */
        const [r, g, b] = CLASS_COLOURS[blip.classId ?? -1] ?? UNKNOWN_CLASS;
        ctx.beginPath();
        ctx.arc(at.x, at.y, side / 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
        ctx.fill();
        ctx.lineWidth = OUTLINE_PX;
        ctx.strokeStyle = OUTLINE_RGBA;
        ctx.stroke();
        continue;
      }
      const icon = this.icons.get(ICON_PATHS[blip.kind]);
      if (!icon) {
        continue;
      }
      // The GREY variant, by alpha on the same texture -- see `Blip#dim`. Restored immediately, so
      // one dim blip cannot fade the blips after it or the mask that follows them.
      const alpha = ctx.globalAlpha;
      if (blip.dim === true) {
        ctx.globalAlpha = alpha * DIM_ALPHA;
      }
      // **NO RING ON A GLYPH.** The owner asked for a border and then saw what it does to a `?`:
      // "теперь вокруг квеста появился круг, убери его". A circle around a shape that is already an
      // icon reads as a second object, not as an edge -- which is why the real client puts the border
      // INSIDE the texture instead of stroking around it. The ring stays on the group dot, where a
      // flat colour on light terrain genuinely needs an edge.
      ctx.drawImage(icon, at.x - side / 2, at.y - side / 2, side, side);
      ctx.globalAlpha = alpha;
    }
  }

  /**
   * How big a blip draws, in canvas pixels of the 256-pixel minimap.
   *
   * **UNSOURCED, and it has to be**: the engine's blip size is not in any file this project has, and
   * the minimap's own texture is 256 across where the client's is whatever its frame is. The values
   * are read off the owner's screenshot of the real client, and 16 was his "маленький слишком" -- so
   * they are settled by `window.worldMinimapBlipSize(quest, dot)` rather than by argument.
   */
  private static drawSize(kind: BlipKind): number {
    return kind === 'party' || kind === 'raid' ? dotPx : questIconPx;
  }

  /**
   * Decode the three files once. A failure is remembered as null and never retried.
   *
   * One attempt is enough for a file that either exists or does not, and a retry per composite would be
   * a request per step the player takes.
   */
  private load(): void {
    if (this.loading) {
      return;
    }
    this.loading = true;
    for (const path of Object.values(ICON_PATHS)) {
      void (async () => {
        try {
          const spec = (await WorkerPool.enqueueAt(
            PRIORITY.BACKGROUND, 'BLP', path, true,
          )) as BlpSpec | null | undefined;
          const level = spec?.mipmaps[0];
          if (!spec || level === undefined || spec.format !== BLP_IMAGE_FORMAT.IMAGE_ABGR8888) {
            this.icons.set(path, null);
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = level.width;
          canvas.height = level.height;
          const into = canvas.getContext('2d');
          if (into === null) {
            this.icons.set(path, null);
            return;
          }
          // The decoder gives RGBA in that order (`pipeline/blp/loader.js`), which is what `ImageData`
          // wants, so this is a copy and not a conversion.
          into.putImageData(
            new ImageData(new Uint8ClampedArray(level.data), level.width, level.height), 0, 0,
          );
          this.icons.set(path, canvas);
          // See `artArrived`: the gate cannot see that this changed what a composite would paint.
          this.artArrived = true;
        } catch (error) {
          this.icons.set(path, null);
          console.warn(`minimap blips: ${path} failed to load`, error);
        }
      })();
    }
  }

  dispose(): void {
    this.icons.clear();
    this.loading = false;
  }
}
