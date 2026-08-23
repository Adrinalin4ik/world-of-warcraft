import { sheetRect } from '../map-data';

/**
 * ONE test, on the projection that fails SILENTLY.
 *
 * A wrong axis crossing or a wrong sign does not blank the map -- it puts the zone somewhere else on the
 * continent sheet, and the click that zooms in then goes confidently to the wrong place. Every previous
 * orientation defect on this project was of exactly that shape.
 *
 * **BOTH INPUTS ARE DECODED FROM SERVED FILES, not invented.** Elwynn's `WorldMapArea` rect and Eastern
 * Kingdoms' `WorldMapContinent` bounds are quoted in `map-data.ts`, and the expected answer is checked
 * against the real map: Elwynn Forest sits in the SOUTH-CENTRAL part of Eastern Kingdoms, so the vertical
 * fractions must be in the lower third and the horizontal ones must straddle the middle.
 */
const ELWYNN = {
  id: 30,
  mapId: 0,
  areaId: 12,
  art: 'Elwynn',
  left: 1535.4,
  right: -1935.4,
  top: -7939.6,
  bottom: -10254.2,
};

/** Eastern Kingdoms: 18 tiles across by 52 down, which is the shape that corroborated the units. */
const EASTERN_KINGDOMS = { left: 26, right: 44, top: 8, bottom: 60 };

test('a zone projects onto its continent sheet where the zone actually is', () => {
  const rect = sheetRect(ELWYNN, EASTERN_KINGDOMS)!;
  expect(rect).not.toBeNull();

  // Left edge before right, top before bottom. A flipped sign shows up here first.
  expect(rect.left).toBeLessThan(rect.right);
  expect(rect.top).toBeLessThan(rect.bottom);

  // SOUTH: the lower third of the sheet. Swapping the axes puts this at 0.17-0.53 instead.
  expect(rect.top).toBeGreaterThan(0.7);
  expect(rect.bottom).toBeLessThan(0.9);

  // CENTRAL: straddling the middle of the sheet's width.
  expect(rect.left).toBeLessThan(0.5);
  expect(rect.right).toBeGreaterThan(0.5);

  // And a row with no rect answers null rather than dividing by zero.
  expect(sheetRect({ ...ELWYNN, left: 0, right: 0 }, EASTERN_KINGDOMS)).toBeNull();
});
