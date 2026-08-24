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
}

/**
 * The `!` a giver with an offer wears and the `?` one with a turn-in wears, from `DIALOG_STATUS`.
 *
 * The statuses are 3.3.5a's own (`network/game/object/quest.ts:112-124`), so nothing here is a
 * literal. `INCOMPLETE` deliberately produces NOTHING: the real client shows no minimap icon for a
 * quest already in the log and not yet finished, and drawing one would put a marker on every NPC the
 * player is mid-quest for.
 */
export function blipForStatus(status: number): BlipKind | null {
  switch (status) {
    case DIALOG_STATUS.AVAILABLE:
    case DIALOG_STATUS.AVAILABLE_REP:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE:
    case DIALOG_STATUS.LOW_LEVEL_AVAILABLE_REP:
      return 'questAvailable';
    case DIALOG_STATUS.REWARD:
    case DIALOG_STATUS.REWARD2:
    case DIALOG_STATUS.REWARD_REP:
    case DIALOG_STATUS.LOW_LEVEL_REWARD_REP:
      return 'questComplete';
    default:
      return null;
  }
}

const ICON_PATHS: Record<'questAvailable' | 'questComplete' | 'dots', string> = {
  questAvailable: 'Interface\\GossipFrame\\AvailableQuestIcon.blp',
  questComplete: 'Interface\\GossipFrame\\ActiveQuestIcon.blp',
  dots: 'Interface\\Minimap\\ObjectIcons.blp',
};

/**
 * Which 32x32 cell of `ObjectIcons` a dot blip uses.
 *
 * From the measured colours in the header: cell 11 is `(0, 121, 255)` and cell 12 `(0, 137, 255)`, the
 * two blues -- which is what the real client draws party and raid members in. **The ASSIGNMENT of blue
 * to party is the client's convention and not something the atlas states**; what is measured is which
 * cells are blue.
 */
const DOT_CELL: Record<'party' | 'raid', number> = { party: 11, raid: 12 };

const DOT_CELL_PX = 32;

const DOT_ATLAS_COLUMNS = 8;

/** How big a blip draws in canvas pixels. UNSOURCED -- see `drawSize`. */
const QUEST_ICON_PX = 16;

const DOT_PX = 8;

export class MinimapBlips {
  private readonly icons = new Map<string, HTMLCanvasElement | null>();

  private loading = false;

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
    if (blips.length === 0) {
      return;
    }
    this.load();
    for (const blip of blips) {
      const at = toCanvas(blip.worldX, blip.worldY);
      const side = MinimapBlips.drawSize(blip.kind);
      if (blip.kind === 'party' || blip.kind === 'raid') {
        const atlas = this.icons.get(ICON_PATHS.dots);
        if (!atlas) {
          continue;
        }
        const cell = DOT_CELL[blip.kind];
        ctx.drawImage(
          atlas,
          (cell % DOT_ATLAS_COLUMNS) * DOT_CELL_PX,
          Math.floor(cell / DOT_ATLAS_COLUMNS) * DOT_CELL_PX,
          DOT_CELL_PX, DOT_CELL_PX,
          at.x - side / 2, at.y - side / 2, side, side,
        );
        continue;
      }
      const icon = this.icons.get(ICON_PATHS[blip.kind]);
      if (!icon) {
        continue;
      }
      ctx.drawImage(icon, at.x - side / 2, at.y - side / 2, side, side);
    }
  }

  /**
   * How big a blip draws, in canvas pixels of the 256-pixel minimap.
   *
   * **UNSOURCED, and it has to be**: the engine's blip size is not in any file this project has, and
   * the minimap's own texture is 256 across where the client's is whatever its frame is. 16 for a quest
   * glyph and 8 for a dot are read off the owner's screenshot of the real client, where the `?` is
   * roughly a twelfth of the circle. If they are wrong the fix is one number each, and the owner is the
   * one who can see it.
   */
  private static drawSize(kind: BlipKind): number {
    return kind === 'party' || kind === 'raid' ? DOT_PX : QUEST_ICON_PX;
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
