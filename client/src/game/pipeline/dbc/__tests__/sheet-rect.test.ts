import { sheetRect } from '../map-data';

/**
 * THE PROJECTION ONTO A CONTINENT SHEET, and the numbers are TIGHT because a loose check let a wrong one
 * through once already.
 *
 * The first version of `sheetRect` went through `WorldMapContinent.bounds` read as tile indices, and I
 * accepted it because Elwynn came out "south-central, where it is". It came out at x 0.17-0.53 -- twice
 * too wide and shifted left -- and the owner saw the result as a highlight drawn over open sea and a
 * hover that named Winterspring from the middle of the ocean. So this test asserts the values to three
 * decimals rather than a plausible band: a band is what failed.
 *
 * EVERY NUMBER IS DECODED, not invented. The three zone rects and the two continent rects are read out of
 * the served `worldmaparea.dbc`, and the expectations are what the correct projection produces -- checked
 * against the real maps: Elwynn south-central on Eastern Kingdoms, Winterspring in northern Kalimdor,
 * Azshara on its north-east coast.
 */
const AZEROTH = {
  id: 14, mapId: 0, areaId: 0, art: 'Azeroth',
  left: 18172.0, right: -22569.2, top: 11176.3, bottom: -15973.3,
};

const KALIMDOR = {
  id: 13, mapId: 1, areaId: 0, art: 'Kalimdor',
  left: 17066.6, right: -19733.2, top: 12799.9, bottom: -11733.3,
};

const ELWYNN = {
  id: 30, mapId: 0, areaId: 12, art: 'Elwynn',
  left: 1535.4, right: -1935.4, top: -7939.6, bottom: -10254.2,
};

/** A zone rect and its continent's, both from the served file, and the answer to three decimals. */
function around(value: number, expected: number): void {
  expect(value).toBeGreaterThan(expected - 0.01);
  expect(value).toBeLessThan(expected + 0.01);
}

test('a zone projects onto its continent sheet exactly where the sheet draws it', () => {
  const rect = sheetRect(ELWYNN, AZEROTH)!;
  expect(rect).not.toBeNull();

  // MEASURED: x 0.408..0.494, y 0.704..0.789 -- the southern middle of Eastern Kingdoms, ON the
  // landmass. The old projection gave 0.17..0.53 horizontally, which is open sea for half its width.
  around(rect.left, 0.408);
  around(rect.right, 0.494);
  around(rect.top, 0.704);
  around(rect.bottom, 0.789);

  // A row with no rect answers null rather than dividing by zero -- and so does a CONTINENT with none,
  // which is the case a map whose `areaId == 0` row is missing would hit.
  expect(sheetRect({ ...ELWYNN, left: 0, right: 0 }, AZEROTH)).toBeNull();
  expect(sheetRect(ELWYNN, { ...KALIMDOR, top: 0, bottom: 0 })).toBeNull();
});
