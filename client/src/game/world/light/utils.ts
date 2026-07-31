import * as THREE from 'three';
import { AreaLight, WeightedAreaLight } from './types';

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max);
};

/**
 * Returns number of half minutes since midnight.
 */
export const getDayNightTime = () => {
  const d = new Date();

  const msSinceMidnight = d.getTime() - d.setHours(0, 0, 0, 0);

  return Math.round(msSinceMidnight / 1000.0 / 30.0);
};

/**
 * Given two numbers, linearly interpolate between them according to the given factor.
 *
 * @param value1 - First number
 * @param value2 - Second number
 * @param factor - Interpolation factor
 */
export const lerpNumbers = (value1: number, value2: number, factor: number) =>
  (1.0 - factor) * value1 + factor * value2;

/**
 * Given two colors, linearly interpolate between them according to the given factor.
 *
 * @param value1 - First color
 * @param value2 - Second color
 * @param factor - Interpolation factor
 * @param color - Destination color object used to store the result of the interpolation
 */
export const lerpColors = (value1: THREE.Color, value2: THREE.Color, factor: number, color: THREE.Color) =>
  color.lerpColors(value1, value2, factor);

const getTableKeys = (table: any[], key: number) => {
  // All table entries are key/value pairs
  const size = table.length / 2;

  // Clamp key
  key = Math.min(Math.max(key, 0.0), 1.0);

  let previous: number;
  let previousKey: number;
  let next: number;
  let nextKey: number;

  for (let i = 0; i < size; i++) {
    // Wrap at end
    if (i + 1 >= size) {
      previous = i;
      previousKey = table[previous * 2];

      next = 0;
      nextKey = table[0] + 1.0;

      break;
    }

    // Found matching stops
    if (table[i * 2] <= key && table[(i + 1) * 2] >= key) {
      previous = i;
      previousKey = table[previous * 2];

      next = i + 1;
      nextKey = table[next * 2];

      break;
    }
  }

  return { previous, previousKey, next, nextKey };
};

/**
 * Given a table of key/value pairs with color values and a key, interpolate table values against
 * the key. If the key is in excess of the table's size, interpolate from the last table value to
 * the first table value.
 *
 * @param table
 * @param key
 * @param color
 */
export const interpolateColorTable = (table: any[], key: number, color: THREE.Color): void => {
  // Bands are optional. A light that defines no record for one leaves an empty table, and a table
  // with a single stop has nothing to interpolate between. Both cases used to walk off the end and
  // hand undefined to lerpColors, which threw while reading `.r`.
  if (!table || table.length < 2) {
    return;
  }

  const { previous, previousKey, next, nextKey } = getTableKeys(table, key);

  const previousValue = table[previous * 2 + 1];
  const nextValue = table[next * 2 + 1];

  if (!previousValue || !nextValue) {
    return;
  }

  const keyDistance = nextKey - previousKey;

  if (Math.abs(keyDistance) < 0.001) {
    // Coincident stops, so there is nothing to blend. Written into the destination rather than
    // returned: this function reports its result through `color`, and returning the value left the
    // caller looking at whatever the colour held from the previous light.
    color.copy(previousValue);
    return;
  }

  const factor = (key - previousKey) / keyDistance;

  lerpColors(previousValue, nextValue, factor, color);
};

/**
 * Given a table of key/value pairs with numeric values and a key, interpolate table values against
 * the key. If the key is in excess of the table's size, interpolate from the last table value to
 * the first table value.
 *
 * @param table
 * @param key
 */
export const interpolateNumericTable = (table: any[], key: number): number => {
  // Same optional-band guard as the colour version above. Silently produced NaN before, which then
  // spread through fog parameters.
  if (!table || table.length < 2) {
    return 0;
  }

  const { previous, previousKey, next, nextKey } = getTableKeys(table, key);

  const previousValue = table[previous * 2 + 1];
  const nextValue = table[next * 2 + 1];

  if (previousValue === undefined || nextValue === undefined) {
    return 0;
  }

  const keyDistance = nextKey - previousKey;

  if (Math.abs(keyDistance) < 0.001) {
    return previousValue;
  }

  const factor = (key - previousKey) / keyDistance;

  return lerpNumbers(previousValue, nextValue, factor);
};

/**
 * Choose the map's seed light -- the record that absorbs whatever the local falloff spheres don't
 * claim (see `selectLightsForPosition`'s doc). Deliberately a pure function of `lights` alone, NOT
 * of the camera position: round 2 of this fix found that picking the seed by anything
 * position-dependent (originally: nearest `falloffEnd === 0` record to the camera) reintroduces a
 * step the moment two candidate seeds swap rank, which is exactly the discontinuity this module
 * exists to remove. A map's seed is therefore the same record for every camera position, decided
 * once from the data:
 *
 *  1. Among records with `falloffEnd === 0` (no falloff radius -- a map-wide light by definition),
 *     the one with the lowest `id`. Several such records on one map is a data quirk, not a reason to
 *     let the seed's identity depend on where the camera happens to be standing.
 *  2. Otherwise, the record with the largest `falloffEnd` on the map (tie-broken by lowest `id`).
 *     The light covering the most area is the closest thing to a map-wide default a spatial light
 *     can be, and -- critically -- "largest falloffEnd" is a property of the record, not of the
 *     camera, so this is exactly as stable as case 1.
 *  3. `null` if the map has no light records at all.
 */
const findSeedLight = (lights: AreaLight[]): AreaLight | null => {
  if (lights.length === 0) {
    return null;
  }

  const defaultLights = lights.filter((light) => light.falloffEnd === 0.0);

  if (defaultLights.length > 0) {
    return defaultLights.reduce((best, light) => (light.id < best.id ? light : best));
  }

  return lights.reduce((best, light) => {
    if (light.falloffEnd > best.falloffEnd) {
      return light;
    }
    if (light.falloffEnd === best.falloffEnd && light.id < best.id) {
      return light;
    }
    return best;
  });
};

/**
 * Select the area lights that apply at `position`, with weights that sum to 1 by construction --
 * never by normalising after the fact (see the history below for why that was wrong).
 *
 * The reference (benilla) seeds its blend from the map's global light and alpha-lerps each
 * overlapping local sphere over that seed, so the total is always 1 *and* each local light's own
 * share still falls off continuously with distance. This ports that as a weight split: the map's
 * seed light (`findSeedLight`, chosen once from the data and never from the camera) is excluded from
 * the local falloff pool entirely, the remaining lights' falloff-based shares are computed exactly as
 * before, and whatever they leave unclaimed goes to the seed.
 *
 * History, round 1: an earlier fix normalised the selected weights (divided each by their sum) to
 * stop the scene reading darker the farther the camera sat from the nearest record -- a real bug,
 * since `blendLights` scales ambient/diffuse/fog by whatever the weights sum to. But normalising a
 * SINGLE selected light always drives it to weight 1.0 regardless of distance, which flattens the
 * falloff ramp into a step. Reported as fog "changes not smoothly, more like instant".
 *
 * Round 1's replacement fix (hand the leftover to the map's default light, identified by
 * `falloffEnd === 0` -- the old position-gated check was too strict and likely why map 571 resolved
 * zero area lights) was right in spirit but picked BOTH the default-light tie-break AND the
 * no-default fallback by distance to the camera. That just relocates the step: whichever record was
 * "nearest" (and so held the leftover) changes as the camera moves, and the leftover transfers
 * instantaneously between records on that swap -- observable as one light jumping straight from a
 * partial weight to 1.0 the instant a nearer light drops out of range. `findSeedLight` removes camera
 * position from the decision entirely, which is what actually closes the gap.
 */
export const selectLightsForPosition = (
  lights: AreaLight[],
  position: THREE.Vector3,
): WeightedAreaLight[] => {
  const seed = findSeedLight(lights);
  const selectedLights: WeightedAreaLight[] = [];

  for (const light of lights) {
    // The seed never competes for a falloff share -- it only ever receives the leftover, below. Were
    // it left in this pool it could be selected AND seeded, double-counting its weight. Every OTHER
    // falloffEnd === 0 record (a map can define more than one) is skipped too: it has no falloff
    // radius to speak of, so it is not a spatial candidate at all, just a losing tie-break for the
    // seed slot -- without this, such a record would only ever satisfy `distance <= 0` (i.e. the
    // camera standing exactly on top of it) and grab the entire pool at that single point, which is a
    // degenerate special case, not a real local light.
    if (light === seed || light.falloffEnd === 0.0) {
      continue;
    }

    const distance = position.distanceTo(light.position);

    // Include lights if position is within falloff radii
    if (distance <= light.falloffEnd) {
      selectedLights.push({ light, distance, weight: 0.0 });
    }
  }

  // Sort selected lights by distance (closer -> farther)
  selectedLights.sort(
    (light1: WeightedAreaLight, light2: WeightedAreaLight) => light1.distance - light2.distance,
  );

  // Distribute weights by falloff
  let availableWeight = 1.0;
  for (const selectedLight of selectedLights) {
    if (availableWeight === 0.0) {
      break;
    }

    const { light, distance } = selectedLight;

    const falloff =
      light.falloffStart > 0.0 && light.falloffEnd > 0.0
        ? (distance - light.falloffStart) / (light.falloffEnd - light.falloffStart)
        : 0.0;

    const weight = clamp(1.0 - falloff, 0.0, availableWeight);

    selectedLight.weight = weight;
    availableWeight -= weight;
  }

  // The leftover always goes to the seed -- never to `selectedLights[0]` (the nearest in-range
  // light). Handing it to "nearest" was round 1's mistake: that assignment target changes identity as
  // the camera moves, so the leftover would jump between records instead of the seed's own weight
  // moving smoothly. The seed's identity never changes for a given map (see `findSeedLight`), so this
  // assignment is a continuous function of distance even though which OTHER lights are competing for
  // the remaining pool changes as the camera moves.
  if (seed) {
    selectedLights.push({
      light: seed,
      distance: position.distanceTo(seed.position),
      weight: availableWeight,
    });
  }

  // No light records for the map whatsoever: `selectedLights` stays empty (there is nothing to seed
  // from). MapLight#updateLights resolves this to its own documented neutral fallback instead of
  // leaving the frame's params untouched.
  return selectedLights;
};


