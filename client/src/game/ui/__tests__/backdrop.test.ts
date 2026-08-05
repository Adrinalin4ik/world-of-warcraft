/**
 * The nine-piece geometry of a FrameXML `Backdrop`.
 *
 * Worth a test because every number in it is authored and none of it is self-evident: a corner at the
 * wrong size, or a background inset applied to the wrong side, draws a plausible-looking frame that is
 * simply not the client's. The transposed TOP/BOTTOM flag is asserted here too -- it is the one thing
 * about the edge atlas a reader would not guess, and `backdrop.ts` records how it was measured.
 */
import { BackdropDef, backdropPieces } from '../backdrop';

/** The edit boxes' authored Backdrop (accountlogin.xml:190-201). */
const EDITBOX: BackdropDef = {
  bgSprite: 'bg',
  edgeSprite: 'edge',
  edgeSize: 16,
  tileSize: 16,
  backgroundInsets: { left: 10, right: 5, top: 4, bottom: 9 },
};

describe('backdropPieces', () => {
  it('cuts an authored edit box into the nine expected pieces', () => {
    // The account box: 200x37 (accountlogin.xml:157-165), placed at the origin for legibility.
    const pieces = backdropPieces({ left: 0, top: 0, width: 200, height: 37 }, EDITBOX);

    expect(Object.fromEntries(pieces.map((piece) => [piece.part, piece.rect]))).toEqual({
      // The rect shrunk by the background insets: 200-10-5 by 37-4-9.
      BACKGROUND: { left: 10, top: 4, width: 185, height: 24 },
      // Corners at exactly edgeSize, never scaled to fit.
      TOPLEFT: { left: 0, top: 0, width: 16, height: 16 },
      TOPRIGHT: { left: 184, top: 0, width: 16, height: 16 },
      BOTTOMLEFT: { left: 0, top: 21, width: 16, height: 16 },
      BOTTOMRIGHT: { left: 184, top: 21, width: 16, height: 16 },
      // Edge runs span only what the corners leave: 200-32 across, 37-32 down.
      TOP: { left: 16, top: 0, width: 168, height: 16 },
      BOTTOM: { left: 16, top: 21, width: 168, height: 16 },
      LEFT: { left: 0, top: 16, width: 16, height: 5 },
      RIGHT: { left: 184, top: 16, width: 16, height: 5 },
    });

    // Background first so the border draws over it; corners last so they cover the runs' ends.
    expect(pieces[0].part).toBe('BACKGROUND');
    expect(pieces.slice(-4).map((piece) => piece.part)).toEqual([
      'TOPLEFT',
      'TOPRIGHT',
      'BOTTOMLEFT',
      'BOTTOMRIGHT',
    ]);

    // The background is TILED at TileSize, not stretched: fractional repeats, and the whole sheet
    // rather than an atlas sub-rect.
    const background = pieces.find((piece) => piece.part === 'BACKGROUND')!;
    expect(background.repeat).toEqual({ x: 185 / 16, y: 24 / 16 });
    expect(background.texCoords).toBeNull();

    // The two tiles stored rotated in the sheet, and only those two.
    expect(pieces.filter((piece) => piece.transposed).map((piece) => piece.part)).toEqual([
      'TOP',
      'BOTTOM',
    ]);

    // Eight tiles side by side, so each edge tile is one eighth of the sheet's width, full height.
    expect(pieces.find((piece) => piece.part === 'LEFT')!.texCoords).toEqual({
      u0: 0,
      v0: 0,
      u1: 0.125,
      v1: 1,
    });
  });
});
