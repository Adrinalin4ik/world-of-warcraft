import { mapData } from '../map-data';

/**
 * THE PROJECTION'S AXIS CROSSING, which is the one thing here a wrong answer looks plausible for.
 *
 * WoW's world X runs NORTH and its Y runs WEST, while a map image's x runs east and its y runs down. So
 * the horizontal fraction is measured from `left` using the world's **Y** and the vertical from `top`
 * using the world's **X**. Every other pairing also returns two numbers in a believable range, which is
 * why this is asserted rather than eyeballed.
 *
 * THE INPUTS ARE REAL, decoded from the served `worldmaparea.dbc` rather than invented: Elwynn's rect is
 * `left 1535.4, right -1935.4, top -7939.6, bottom -10254.2`. The probe position is Northshire's, taken
 * from a live marker log in this repo's own history (`bone world pos = -8902.6, -162.7`).
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

test('a world position normalises into its zone rect, and out-of-rect answers null', () => {
  const at = mapData.normalise(ELWYNN, -8902.6, -162.7);
  expect(at).not.toBeNull();
  // Northshire sits in the northern middle of Elwynn: just under half way across, just under half down.
  // A swapped pairing puts x at 3.4 and y at -0.4, so these bounds are what separate right from wrong.
  expect(at!.x).toBeGreaterThan(0.45);
  expect(at!.x).toBeLessThan(0.55);
  expect(at!.y).toBeGreaterThan(0.35);
  expect(at!.y).toBeLessThan(0.5);

  // Outside the rect is NULL and not a clamp: the engine answers (0, 0) for a unit that is not on the
  // displayed map, and the client's callers hide the arrow on it. Clamping would pin it to an edge and
  // draw an arrow where the player is not.
  expect(mapData.normalise(ELWYNN, 0, 0)).toBeNull();
});
