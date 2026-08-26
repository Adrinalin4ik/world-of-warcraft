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
export type BlipKind =
  | 'questAvailable'
  | 'questComplete'
  | 'questIncomplete'
  | 'tracked'
  | 'questArrow'
  | 'party'
  | 'raid'
  | 'partyEdge';

export interface Blip {
  /** World coordinates -- the same space the player's position and the terrain window are in. */
  worldX: number;
  worldY: number;
  kind: BlipKind;
  /**
   * What a tooltip on this blip says. Empty or absent means no tooltip -- a name this client has not
   * queried yet is a real state and silence is the honest answer for it.
   */
  name?: string;
  /**
   * For a `tracked` blip: the icon path, which is the ACTIVE tracking row's own art.
   *
   * On the blip rather than in `ICON_PATHS`, because there are fifteen possible ones and only ever
   * one active -- keying them all into the loader would decode fifteen files to draw with one.
   */
  icon?: string;
  /**
   * For a `questArrow`: the direction to point, in RADIANS clockwise from up.
   *
   * Computed by the builder, which owns the window and therefore knows what "off the edge" means.
   * The art points up at 0 -- measured, see `ICON_PATHS.questArrow` -- so this is a plain rotation
   * and not an offset against some other convention.
   */
  bearing?: number;
  /** Its position in the watch list, 0-based. The digit drawn inside the circle. */
  index?: number;
  /**
   * The member's `classId`, for a group dot. Undefined for a quest glyph and for an unknown class.
   *
   * The dot is drawn in the CLASS colour -- the owner: "это должна быть точка, цвет которой должен
   * отражать цвет класса." So the colour is data on the blip rather than a fixed atlas cell.
   */
  classId?: number;
}

/**
 * Every `DIALOG_STATUS` that draws a glyph, and WHICH of the three it draws.
 *
 * The statuses are 3.3.5a's own (`network/game/object/quest.ts:112-124`), so nothing here is a
 * literal. Three real states rather than two plus a fudge:
 *
 *  - AVAILABLE / AVAILABLE_REP and their LOW_LEVEL twins -> the yellow `!`. An offer is an offer
 *    whether or not the client would grey it in its own gossip list; the minimap shows it.
 *  - REWARD / REWARD2 / REWARD_REP -> the yellow `?`. Finished, come and collect.
 *  - INCOMPLETE and LOW_LEVEL_REWARD_REP -> the GREY `?`. In the log, not done. This is the one the
 *    owner caught twice: absent in the first version, yellow-with-alpha in the second.
 *
 * NONE and UNAVAILABLE draw nothing, which is the whole of what draws nothing.
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
      return 'questComplete';
    case DIALOG_STATUS.INCOMPLETE:
    case DIALOG_STATUS.LOW_LEVEL_REWARD_REP:
      return 'questIncomplete';
    default:
      return null;
  }
}
const ICON_PATHS: Record<
  'questAvailable' | 'questComplete' | 'questIncomplete' | 'questArrow',
  string
> = {
  questAvailable: 'Interface\\GossipFrame\\AvailableQuestIcon.blp',
  questComplete: 'Interface\\GossipFrame\\ActiveQuestIcon.blp',
  questIncomplete: 'Interface\\GossipFrame\\IncompleteQuestIcon.blp',
  /**
   * THE TRACKED-QUEST MARKER, and it is the client's own POI ICON -- not a guide arrow.
   *
   * **The owner compared ours with the real client and the shape was wrong.** I had used
   * `Rotating-MinimapGuideArrow`, a triangle, on the strength of its NAME. His screenshot of the
   * original shows round POI icons distributed around the rim, which is a different thing: the
   * triangle guide arrow belongs to the corpse/destination pointer, not to quest tracking.
   *
   * `UI-QuestPoi-NumberIcons` is what the client itself uses for a tracked quest, and every
   * coordinate below is read out of `questpoi.lua` rather than guessed. The atlas is an 8x8 grid --
   * `QUEST_POI_ICON_SIZE = 0.125` (`:5`).
   *
   * DIRECTION IS POSITION, not rotation: a round icon at the rim in the objective's direction is how
   * the real client conveys it, which is why the rotation and the colour tint this file briefly grew
   * are both gone. The art is already coloured and already round.
   */
  questArrow: 'Interface\\WorldMap\\UI-QuestPoi-NumberIcons.blp',
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

/**
 * The RIM MARKER's size -- its own, not a fraction of the giver glyph's.
 *
 * It was `questIconPx * 0.7` -- 15 px -- and the owner could not find it on screen: "она очень
 * маленькая, в этом проблема". Deriving it from the glyph was the mistake: a marker at the rim is
 * read at a glance and from further away than an icon under the cursor, so it wants to be LARGER,
 * not smaller. 32 against the glyph's 22 -- 26 was still too small when he looked at it, which is
 * why this is a knob and not a derivation: 15 was invisible, 26 too small, 32 close, 38 his.
 *
 * The DIGIT inside it is the quest's place in the watch list, which is what the client draws too --
 * `QuestPOI_DisplayButton` is passed the tracker row index and `questpoi.lua:72-73` turns it into an
 * atlas cell. A quest whose objective is inside the window gets no rim marker, so the digits on
 * screen can start at 2: the numbering follows the LIST, not the markers, and that is correct.
 *
 * UNSOURCED like the other two, and settled the same way -- `window.worldMinimapBlipSize` takes it
 * as a third argument.
 */
let arrowPx = 38;

/** Set both blip sizes live. Returns what they settled on, for the console. */
export function setBlipSizes(
  quest?: number,
  dot?: number,
  arrow?: number,
): { quest: number; dot: number; arrow: number } {
  if (typeof quest === 'number' && Number.isFinite(quest) && quest > 0) {
    questIconPx = Math.min(quest, 64);
  }
  if (typeof dot === 'number' && Number.isFinite(dot) && dot > 0) {
    dotPx = Math.min(dot, 64);
  }
  if (typeof arrow === 'number' && Number.isFinite(arrow) && arrow > 0) {
    arrowPx = Math.min(arrow, 64);
  }
  return { quest: questIconPx, dot: dotPx, arrow: arrowPx };
}

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

/**
 * Where a rim marker's CENTRE sits, as a fraction of the radius. UNSOURCED.
 *
 * Not "how far out before an inset": the inset used to be applied twice, here and again as
 * `side / 2` at the call. 0.86 puts a 38-px marker at 110 of 128 with its outer edge at 129 -- a
 * couple of pixels past the mask, which is what "at the edge" looks like and is why the mask exists
 * rather than a hard clamp.
 */
const EDGE_REACH = 0.78;

/**
 * The rim arrow for an out-of-range group member. UNSOURCED, like every blip size here.
 *
 * Smaller than a quest marker on purpose: that one carries a digit and has to be READ, this one only
 * has to be seen and pointed.
 */
const PARTY_ARROW_PX = 16;

/**
 * The atlas cell for a tracked quest, READ OUT OF `questpoi.lua`.
 *
 * In progress: `normalTexture:SetTexCoord(0.500, 0.625, 0.875, 1.0)` (`:67`) -- the numbered circle.
 * Ready to hand in: `(0.500, 0.625, 0.375, 0.5)` (`:134`) -- the same circle in its complete state.
 *
 * **`complete` IS KEPT AND NOTHING DRAWS IT, deliberately.** A finished quest gets no objective
 * marker on the minimap at all (the owner's call, and the right one: the marker points at where the
 * objective is done, and there is nothing left to do there). The cell stays because it is a READ of
 * the client's own file, and deleting it would lose the citation and make the pair look unresearched
 * the next time someone wants the world map to draw both states.
 *
 * So the STATE and the CELL are both the client's, and nothing here is a hue I chose.
 */
const POI_CELL = { x: 0.5, size: 0.125, active: 0.875, complete: 0.375 } as const;

/**
 * Where the DIGIT for the n-th tracked quest lives in the same atlas.
 *
 * `yOffset = 0.5 + floor(i / QUEST_POI_ICONS_PER_ROW) * 0.125` and
 * `xOffset = mod(i, QUEST_POI_ICONS_PER_ROW) * 0.125` (`questpoi.lua:72-73`), with the index being
 * the button number the client passes -- 1-based in its own list, so 0-based here.
 *
 * `QUEST_POI_ICONS_PER_ROW` is not in `questpoi.lua`; it is 8, which the 0.125 cell size states
 * arithmetically -- a row of an 8x8 grid.
 */
function digitCell(index: number): { x: number; y: number } {
  const perRow = 8;
  return {
    x: (index % perRow) * POI_CELL.size,
    y: 0.5 + Math.floor(index / perRow) * POI_CELL.size,
  };
}export class MinimapBlips {
  private readonly icons = new Map<string, HTMLCanvasElement | null>();

  private loading = false;

  /** Paths with a decode in flight, so a per-frame builder cannot queue the same file twice. */
  private readonly decoding = new Set<string>();


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

  /**
   * Where each blip actually landed, for the hover test. Rebuilt on every composite.
   *
   * The DRAWN positions and not the world ones: the hover arrives in canvas pixels and comparing in
   * that space needs no second copy of the window arithmetic -- which is the same reason `draw` takes
   * a `toCanvas` rather than computing one.
   */
  private placed: { x: number; y: number; radius: number; name: string }[] = [];

  /**
   * The name of the blip under a point in canvas pixels, or null.
   *
   * NEAREST rather than first, because blips overlap: two party members standing together are two
   * circles a few pixels apart, and the topmost by draw order is not the one the pointer is closest
   * to. Radius is the drawn half-size, so the hit area is exactly what is on screen.
   */
  /** The hoverable blips as plain data, for the probe. Empty means no blip carries a name yet. */
  placedList(): unknown[] {
    return this.placed.map((blip) => ({
      at: [Math.round(blip.x), Math.round(blip.y)],
      radius: blip.radius,
      name: blip.name,
    }));
  }

  nameAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const blip of this.placed) {
      const dx = x - blip.x;
      const dy = y - blip.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= blip.radius && distance < bestDistance) {
        bestDistance = distance;
        best = blip.name;
      }
    }
    return best;
  }

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
    /**
     * The canvas side in pixels, PASSED IN rather than known here.
     *
     * Importing it from `minimap-terrain.ts` was a circular import -- that module already depends on
     * this one, so the constant was in its temporal dead zone at load and the whole bundle threw
     * `Cannot access TERRAIN_PX before initialization`. Deriving a value is right; reaching across a
     * dependency edge to do it is not.
     *
     * And it is the better shape anyway: the blip layer rasterises into a canvas someone else owns,
     * so its size is an input like `toCanvas` is, not a fact about this file.
     */
    canvasPx: number,
  ): void {
    this.lastDraw = { asked: blips.length, drawn: 0, samples: [] as unknown[] };
    this.placed = [];
    if (blips.length === 0) {
      return;
    }
    this.load();
    for (const blip of blips) {
      const at = toCanvas(blip.worldX, blip.worldY);
      const side = MinimapBlips.drawSize(blip.kind);

      // NO `record` HERE. Each branch records with the position it actually DREW at -- an edge
      // arrow draws on the rim, not at `at` -- and a call here as well double-counted `drawn` and
      // put two hover boxes on every blip.
      if (blip.kind === 'partyEdge') {
        /**
         * AN ARROW, and this is the OWNER'S CHOICE rather than a claim about the real client.
         *
         * The history is worth keeping straight. I drew a triangle first from reasoning; he compared
         * it with the original and said it did not match, and his screenshot showed only round rim
         * markers -- so it became a clamped dot. Looking at that, he asked for the arrow back:
         * "давай оставим стрелку как было". He has seen both, so this is preference, and the comment
         * says so instead of pretending the round version was wrong.
         *
         * DRAWN rather than a texture because it needs the CLASS colour, and the one arrow texture
         * here is a fixed dark gold. Same `CLASS_COLOURS` and same `onRim` as the dot, so colour and
         * position cannot drift between the two.
         */
        const [ar, ag, ab] = CLASS_COLOURS[blip.classId ?? -1] ?? UNKNOWN_CLASS;
        const tip = MinimapBlips.onRim(canvasPx, blip.bearing ?? 0);
        ctx.save();
        ctx.translate(tip.x, tip.y);
        ctx.rotate(blip.bearing ?? 0);
        ctx.beginPath();
        // Apex forward: at `-side / 2` before the rotation, which after it is the member's
        // direction. `rotate` is cumulative, hence the save/restore rather than an inverse turn.
        ctx.moveTo(0, -side / 2);
        ctx.lineTo(side / 2, side / 2);
        ctx.lineTo(-side / 2, side / 2);
        ctx.closePath();
        ctx.fillStyle = `rgb(${Math.round(ar * 255)}, ${Math.round(ag * 255)}, ${Math.round(ab * 255)})`;
        ctx.fill();
        ctx.lineWidth = OUTLINE_PX;
        ctx.strokeStyle = OUTLINE_RGBA;
        ctx.stroke();
        ctx.restore();
        this.record(blip, tip, side);
        continue;
      }
      if (blip.kind === 'party' || blip.kind === 'raid') {
        /**
         * A FILLED DOT IN THE CLASS COLOUR, drawn rather than sampled.
         *
         * See `CLASS_COLOURS` for why the atlas is gone. The ring is the same one the glyphs get,
         * so a dot on light terrain stays visible -- which is the whole job of a border here.
         */
        /**
         * A FILLED DOT IN THE CLASS COLOUR, drawn rather than sampled -- see `CLASS_COLOURS` for why
         * the atlas is gone. The ring keeps it visible on light terrain, which is its whole job.
         *
         * IN RANGE only: a member beyond the window is `partyEdge` and is handled above.
         */
        const [r, g, b] = CLASS_COLOURS[blip.classId ?? -1] ?? UNKNOWN_CLASS;
        ctx.beginPath();
        ctx.arc(at.x, at.y, side / 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
        ctx.fill();
        ctx.lineWidth = OUTLINE_PX;
        ctx.strokeStyle = OUTLINE_RGBA;
        ctx.stroke();
        this.record(blip, at, side);
        continue;
      }
      /**
       * A TRACKED blip carries its own icon path; the quest glyphs are keyed by kind.
       *
       * Loaded on demand through the same map, so switching tracking category decodes one file and
       * then costs nothing. `ensureIcon` returns undefined until it lands, and an undefined icon
       * simply skips -- the blip appears a moment later, which is what every other art here does.
       */
      const path = blip.kind === 'tracked' ? blip.icon : ICON_PATHS[blip.kind];
      if (path === undefined) {
        continue;
      }
      const icon = this.ensureIcon(path);
      if (!icon) {
        continue;
      }
      if (blip.kind === 'questArrow') {
        /**
         * ON THE RIM in the objective's direction, and NOT rotated -- the icon is round.
         *
         * Inset by its own half-size: the client draws its border art OVER this texture, so an icon
         * at the very edge sits under the ring and is invisible. That was the "стрелки не видно"
         * round.
         */
        const half = canvasPx / 2;
        // `EDGE_REACH` alone: it IS where the centre goes. Subtracting `side / 2` on top of it was a
        // double inset, and at 38 px that was 19 more pixels inward -- the markers sat at 67% of the
        // radius while the constant said 82%, which is why they read as central.
        const reach = half * EDGE_REACH;
        const bearing = blip.bearing ?? 0;
        const rim = {
          x: half + Math.sin(bearing) * reach,
          y: half - Math.cos(bearing) * reach,
        };
        // The CIRCLE, then the DIGIT inside it. Both cells come from `questpoi.lua`; see `POI_CELL`.
        // ALWAYS THE IN-PROGRESS CELL. A completed quest is not pushed here at all -- see the skip
        // in `minimap-terrain.ts` -- so there is nothing left to choose between.
        const cellY = POI_CELL.active;
        MinimapBlips.blit(ctx, icon, POI_CELL.x, cellY, rim, side);
        const digit = digitCell(blip.index ?? 0);
        MinimapBlips.blit(ctx, icon, digit.x, digit.y, rim, side);
        this.record(blip, rim, side);
        continue;
      }
      // **NO RING ON A GLYPH.** The owner asked for a border and then saw what it does to a `?`:
      // "теперь вокруг квеста появился круг, убери его". A circle around a shape that is already an
      // icon reads as a second object, not as an edge -- which is why the real client puts the border
      // INSIDE the texture instead of stroking around it. The ring stays on the group dot, where a
      // flat colour on light terrain genuinely needs an edge. No alpha either: the grey variant is
      // its own texture now (see `ICON_PATHS`).
      ctx.drawImage(icon, at.x - side / 2, at.y - side / 2, side, side);
      this.record(blip, at, side);
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

    if (kind === 'partyEdge') {
      return PARTY_ARROW_PX;
    }
    if (kind === 'party' || kind === 'raid') {
      return dotPx;
    }
    return kind === 'questArrow' ? arrowPx : questIconPx;
  }

  /**
   * Decode the three files once. A failure is remembered as null and never retried.
   *
   * One attempt is enough for a file that either exists or does not, and a retry per composite would be
   * a request per step the player takes.
   */
  /**
   * The decoded icon for a path, kicking off its decode on a miss.
   *
   * Separate from `load` because a TRACKED blip's art is chosen at runtime -- the player picks one of
   * fifteen -- and the three quest glyphs are fixed. One map, two ways in.
   */
  /**
   * Register a drawn blip for the hover test. Nameless blips are not hoverable.
   *
   * One method rather than the same three lines in each draw branch: the arrow branch was added
   * after the others and an inline copy is how one of them ends up not recording.
   */
  private record(blip: Blip, at: { x: number; y: number }, side: number): void {
    this.lastDraw.drawn = (this.lastDraw.drawn as number) + 1;
    /**
     * THE SAMPLE IS TAKEN HERE, where the DRAWN position is known.
     *
     * It used to be pushed at the top of the loop from `at`, which for an edge arrow is the player,
     * not the rim it draws at -- so the probe reported `[128, 128]` for two arrows that were drawn
     * elsewhere, and cost a round chasing a position the code never used. A probe that reports
     * something other than what the code does is the documented hazard on this project, and that was
     * one.
     */
    const samples = this.lastDraw.samples as unknown[];
    if (samples.length < 8) {
      samples.push({
        kind: blip.kind,
        world: [Math.round(blip.worldX), Math.round(blip.worldY)],
        drawnAt: [Math.round(at.x), Math.round(at.y)],
        side,
      });
    }
    if (blip.name !== undefined && blip.name !== '') {
      this.placed.push({ x: at.x, y: at.y, radius: side / 2, name: blip.name });
    }
  }

  /**
   * A point on the rim in a given direction. Shared by both kinds of rim marker.
   *
   * `EDGE_REACH` is where the CENTRE goes; screen up is `-y` and bearing 0 is up, so the offset is
   * `(sin, -cos)`. One helper because two callers computing the same circle is how they drift apart.
   */
  private static onRim(canvasPx: number, bearing: number): { x: number; y: number } {
    const half = canvasPx / 2;
    const reach = half * EDGE_REACH;
    return { x: half + Math.sin(bearing) * reach, y: half - Math.cos(bearing) * reach };
  }

  /**
   * Draw one cell of an atlas centred on a point.
   *
   * The cell is given in the same 0..1 fractions the client uses in `SetTexCoord`, so the numbers at
   * the call site are literally the ones in `questpoi.lua` and can be compared with it by eye.
   */
  private static blit(
    ctx: CanvasRenderingContext2D,
    atlas: HTMLCanvasElement,
    cellX: number,
    cellY: number,
    at: { x: number; y: number },
    side: number,
  ): void {
    ctx.drawImage(
      atlas,
      cellX * atlas.width, cellY * atlas.height,
      POI_CELL.size * atlas.width, POI_CELL.size * atlas.height,
      at.x - side / 2, at.y - side / 2, side, side,
    );
  }

  private ensureIcon(path: string): HTMLCanvasElement | null | undefined {
    if (!this.icons.has(path)) {
      this.decode(path);
      return undefined;
    }
    return this.icons.get(path);
  }

  private load(): void {
    if (this.loading) {
      return;
    }
    this.loading = true;
    for (const path of Object.values(ICON_PATHS)) {
      this.decode(path);
    }
  }

  /**
   * Decode one icon into a canvas, once. A failure is remembered as null and never retried.
   *
   * One attempt is enough for a file that either exists or does not, and a retry per composite would
   * be a request per step the player takes.
   */
  private decode(path: string): void {
    if (this.icons.has(path) || this.decoding.has(path)) {
      return;
    }
    this.decoding.add(path);
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
  dispose(): void {
    this.icons.clear();
    this.decoding.clear();
    this.loading = false;
  }
}
