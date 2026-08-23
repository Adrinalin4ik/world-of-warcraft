import { tileRect, tileSpan } from '../minimap-terrain';

/**
 * ONE test, on the only thing here that can be wrong SILENTLY: which way each axis runs.
 *
 * A sign error does not blank the minimap -- it draws a perfectly good minimap of somewhere else, or of
 * the same place mirrored, and nothing in the code complains. Every orientation defect on this project
 * has been two conventions meeting, so the assertion is the one the composite depends on: **the tile the
 * player is standing in must cover the centre of the canvas.**
 *
 * The position is real, not constructed: Northshire at world (x -8900, y -160), which
 * `pipeline/minimap-tiles.ts` verified end to end against the served files -- ADT tile 32_48, hash
 * `b53fb722...`, HTTP 200.
 */
const NORTHSHIRE_X = -8900;
const NORTHSHIRE_Y = -160;
const WINDOW = 400;

test('the tile the player stands in covers the centre of the composite', () => {
  // The span must contain that tile on both axes -- A from the world's Y, B from its X.
  const spanA = tileSpan(NORTHSHIRE_Y, WINDOW);
  const spanB = tileSpan(NORTHSHIRE_X, WINDOW);
  expect(spanA.from).toBeLessThanOrEqual(32);
  expect(spanA.to).toBeGreaterThanOrEqual(32);
  expect(spanB.from).toBeLessThanOrEqual(48);
  expect(spanB.to).toBeGreaterThanOrEqual(48);

  // And its destination rect must straddle the canvas centre, which is where the player is drawn.
  // A transposed pair or a flipped sign puts this rect off the canvas entirely.
  const rect = tileRect(32, 48, NORTHSHIRE_X, NORTHSHIRE_Y, WINDOW);
  const centre = 128;
  expect(rect.x).toBeLessThanOrEqual(centre);
  expect(rect.x + rect.size).toBeGreaterThanOrEqual(centre);
  expect(rect.y).toBeLessThanOrEqual(centre);
  expect(rect.y + rect.size).toBeGreaterThanOrEqual(centre);
});
