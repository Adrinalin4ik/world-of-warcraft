/**
 * FrameXML `Backdrop`: a tiled background image plus an eight-tile edge atlas, resolved into the
 * nine pieces a renderer draws.
 *
 * Deliberately free of three.js, like `layout.ts` -- this is arithmetic over plain rects, so the
 * nine-piece geometry is testable without WebGL.
 *
 * The authored form (accountlogin.xml:190-201, gluedialog.xml's `GlueDialogBackground`):
 *
 *     <Backdrop bgFile="..." edgeFile="..." tile="true">
 *       <BackgroundInsets><AbsInset left="11" right="12" top="12" bottom="11"/></BackgroundInsets>
 *       <TileSize><AbsValue val="32"/></TileSize>
 *       <EdgeSize><AbsValue val="32"/></EdgeSize>
 *     </Backdrop>
 *
 * THE EDGE ATLAS, measured by decoding the shipped BLPs rather than assumed:
 *
 *   - `Interface\DialogFrame\UI-DialogBox-Border` is 256x32 -- eight 32x32 tiles side by side.
 *   - `Interface\Glues\Common\Glue-Tooltip-Border` is 128x16 -- eight 16x16 tiles side by side.
 *
 * Both are 8 tiles wide at exactly their authored `EdgeSize`, so tile `k` is the sub-rect
 * `u0 = k/8, u1 = (k+1)/8, v0 = 0, v1 = 1` in both cases, and `EDGE_INDEX` below is the order.
 *
 * THE PART THAT IS NOT OBVIOUS, and which a plain sub-rect gets wrong: the TOP and BOTTOM tiles are
 * stored ROTATED. Measuring the opaque footprint of each 32x32 tile of `UI-DialogBox-Border`
 * (alpha >= 128) gives:
 *
 *     tile 0 (LEFT)   solid columns 4-11, every row      -- a vertical strip, as drawn
 *     tile 1 (RIGHT)  solid columns 16-27, every row     -- a vertical strip, as drawn
 *     tile 2 (TOP)    solid columns 4-11, every row      -- ALSO a vertical strip
 *     tile 3 (BOTTOM) solid columns 20-27, every row     -- ALSO a vertical strip
 *     tile 4 (TOPLEFT)     top bar rows 4-15,  then tile 0's exact row profile below it
 *     tile 5 (TOPRIGHT)    top bar rows 4-15,  then tile 1's exact row profile below it
 *     tile 6 (BOTTOMLEFT)  tile 0's row profile above, then a bottom bar at rows 20-27
 *     tile 7 (BOTTOMRIGHT) tile 1's row profile above, then a bottom bar at rows 20-27
 *
 * Tiles 2 and 3 are uniform along their stored Y and banded along their stored X -- the shape of a
 * vertical edge, not a horizontal one. Stretching that sub-rect along a horizontal run would smear a
 * vertical strip sideways. Transposing it (drawn row <- stored column, drawn column <- stored row)
 * lands tile 3's band at rows 20-27, which is EXACTLY where tiles 6 and 7 put their bottom bar, and
 * tile 2's band at rows 4-11, inside where tiles 4 and 5 put their top bar. That agreement across
 * four independently authored tiles is what confirms the transpose, and its direction: no mirror.
 *
 * So `BackdropPiece#transposed` is set for TOP and BOTTOM only, and a renderer must honour it by
 * swapping u and v -- which a texture offset/repeat cannot express, since that only scales and
 * translates the two axes independently. It takes per-piece UVs.
 */
import type { Rect } from './layout';
// Type-only: `widget.ts` imports `BackdropDef` from here, so neither side may import a VALUE.
import type { TexCoords } from './widget';

/** `AbsInset` -- logical units taken off each side. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface BackdropDef {
  /** `GlueArt` key for the Backdrop's `bgFile`. Tiled at `tileSize`, never stretched. */
  bgSprite: string | null;
  /** `GlueArt` key for the Backdrop's `edgeFile` -- the eight-tile border atlas. */
  edgeSprite: string | null;
  /** `EdgeSize`: the corner squares' side, and the thickness of every edge run. */
  edgeSize: number;
  /** `TileSize`: how large one repeat of the background is. */
  tileSize: number;
  /** `BackgroundInsets`: how far the background is held off each side of the rect. */
  backgroundInsets: Insets;
}

export type BackdropPart =
  | 'BACKGROUND'
  | 'LEFT'
  | 'RIGHT'
  | 'TOP'
  | 'BOTTOM'
  | 'TOPLEFT'
  | 'TOPRIGHT'
  | 'BOTTOMLEFT'
  | 'BOTTOMRIGHT';

/** Which of the eight atlas tiles each edge part is. See the file comment for how this was measured. */
export const EDGE_INDEX: Record<Exclude<BackdropPart, 'BACKGROUND'>, number> = {
  LEFT: 0,
  RIGHT: 1,
  TOP: 2,
  BOTTOM: 3,
  TOPLEFT: 4,
  TOPRIGHT: 5,
  BOTTOMLEFT: 6,
  BOTTOMRIGHT: 7,
};

/** Every edge atlas is eight tiles wide, whatever its pixel size. */
export const EDGE_TILE_COUNT = 8;

/** The sub-rect of one edge tile. Fractions, so it holds for a 128x16 and a 256x32 sheet alike. */
export function edgeTexCoords(part: Exclude<BackdropPart, 'BACKGROUND'>): TexCoords {
  const index = EDGE_INDEX[part];
  return { u0: index / EDGE_TILE_COUNT, v0: 0, u1: (index + 1) / EDGE_TILE_COUNT, v1: 1 };
}

export interface BackdropPiece {
  part: BackdropPart;
  /** Which of the Backdrop's two sprites this piece samples. */
  sprite: 'bg' | 'edge';
  rect: Rect;
  /** The atlas sub-rect. Null for BACKGROUND, which uses the whole sheet and repeats it. */
  texCoords: TexCoords | null;
  /** TOP and BOTTOM only: sample with u and v swapped. See the file comment. */
  transposed: boolean;
  /** BACKGROUND only: tile repeats across and down, fractional so the last tile may be partial. */
  repeat: { x: number; y: number } | null;
}

/**
 * The nine pieces of a Backdrop over `rect`, back to front.
 *
 * Background first so every border piece draws over it, then the four edge runs, then the four
 * corners -- the corners are ornate and overlap where the runs end, so they must land last.
 *
 * An edge run is omitted when it would have no length (a rect narrower or shorter than two corners).
 * The corners are always emitted at exactly `edgeSize`, never shrunk to fit: the client does not
 * scale them either, and silently resizing them would make a cramped frame look subtly different
 * rather than obviously wrong.
 */
export function backdropPieces(rect: Rect, def: BackdropDef): BackdropPiece[] {
  const pieces: BackdropPiece[] = [];
  const { left, top, width, height } = rect;
  const edge = def.edgeSize;

  if (def.bgSprite) {
    const insets = def.backgroundInsets;
    const bgWidth = width - insets.left - insets.right;
    const bgHeight = height - insets.top - insets.bottom;
    if (bgWidth > 0 && bgHeight > 0) {
      pieces.push({
        part: 'BACKGROUND',
        sprite: 'bg',
        rect: { left: left + insets.left, top: top + insets.top, width: bgWidth, height: bgHeight },
        texCoords: null,
        transposed: false,
        // `tile="true"` at `TileSize`: the background repeats at its authored size rather than
        // stretching, so a 512-wide dialog and a 200-wide edit box show the same grain.
        repeat:
          def.tileSize > 0
            ? { x: bgWidth / def.tileSize, y: bgHeight / def.tileSize }
            : { x: 1, y: 1 },
      });
    }
  }

  if (!def.edgeSprite || edge <= 0) {
    return pieces;
  }

  const runWidth = width - 2 * edge;
  const runHeight = height - 2 * edge;
  const rightEdge = left + width - edge;
  const bottomEdge = top + height - edge;

  const push = (
    part: Exclude<BackdropPart, 'BACKGROUND'>,
    pieceRect: Rect,
    transposed = false,
  ): void => {
    pieces.push({
      part,
      sprite: 'edge',
      rect: pieceRect,
      texCoords: edgeTexCoords(part),
      transposed,
      repeat: null,
    });
  };

  if (runHeight > 0) {
    push('LEFT', { left, top: top + edge, width: edge, height: runHeight });
    push('RIGHT', { left: rightEdge, top: top + edge, width: edge, height: runHeight });
  }
  if (runWidth > 0) {
    push('TOP', { left: left + edge, top, width: runWidth, height: edge }, true);
    push('BOTTOM', { left: left + edge, top: bottomEdge, width: runWidth, height: edge }, true);
  }

  push('TOPLEFT', { left, top, width: edge, height: edge });
  push('TOPRIGHT', { left: rightEdge, top, width: edge, height: edge });
  push('BOTTOMLEFT', { left, top: bottomEdge, width: edge, height: edge });
  push('BOTTOMRIGHT', { left: rightEdge, top: bottomEdge, width: edge, height: edge });

  return pieces;
}
