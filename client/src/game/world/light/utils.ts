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
 * Select the area lights that apply at `position`, with weights that sum to 1 by construction --
 * never by normalising after the fact (see the history below for why that was wrong).
 *
 * The reference (benilla) seeds its blend from the map's global light and alpha-lerps each
 * overlapping local sphere over that seed, so the total is always 1 *and* each local light's own
 * share still falls off continuously with distance. This ports that as a weight split: local,
 * falloff-based shares are computed first exactly as before, and whatever they leave unclaimed is
 * handed to the map's default light rather than divided away or spread proportionally.
 *
 * History: an earlier fix normalised the selected weights (divided each by their sum) to stop the
 * scene reading darker the farther the camera sat from the nearest record -- a real bug, since
 * `blendLights` scales ambient/diffuse/fog by whatever the weights sum to. But normalising a SINGLE
 * selected light always drives it to weight 1.0 regardless of distance, which flattens the falloff
 * ramp into a step: the resolved light then only changes when the selected *set* changes, not
 * continuously within it. Reported as fog "changes not smoothly, more like instant".
 *
 * Default-light identification was also too strict: it required both `falloffEnd === 0` AND the
 * record sitting exactly at the map corner (`MAP_CORNER_X`/`MAP_CORNER_Y`). `falloffEnd === 0` is
 * already sufficient -- a light with no falloff radius is a map-wide seed regardless of where its
 * record happens to be positioned in the DBC, and the position match is what made map 571 resolve
 * zero area lights (`falloffEnd === 0` records exist; the position check just rejected them). Keying
 * on falloff alone is also what the reference does: `select_wmo_fog`-style selection treats a
 * zero-radius record as unconditional, never as "unconditional only if also at the origin".
 */
export const selectLightsForPosition = (
  lights: AreaLight[],
  position: THREE.Vector3,
): WeightedAreaLight[] => {
  const selectedLights: WeightedAreaLight[] = [];

  // The map's default/global light -- identified by falloff alone (see doc above), not position.
  // Tracked as the nearest such record in case a map defines more than one; distance is otherwise
  // irrelevant to it, since it always absorbs whatever local falloff didn't claim.
  let defaultLight: WeightedAreaLight | null = null;

  // Nearest ordinary (non-default) record overall, in range or not. Only used as a last-resort seed
  // when the map has no default light at all and nothing is currently in range either -- see below.
  let nearestOverall: WeightedAreaLight | null = null;

  for (const light of lights) {
    const distance = position.distanceTo(light.position);

    if (light.falloffEnd === 0.0) {
      if (!defaultLight || distance < defaultLight.distance) {
        defaultLight = { light, distance, weight: 0.0 };
      }
      continue;
    }

    // Include lights if position is within falloff radii
    if (distance <= light.falloffEnd) {
      selectedLights.push({ light, distance, weight: 0.0 });
    }

    if (!nearestOverall || distance < nearestOverall.distance) {
      nearestOverall = { light, distance, weight: 0.0 };
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

  // Seed whatever is left, rather than normalising it away. Preference order, matching the reference's
  // seed-then-lerp shape as closely as this weight-based model allows:
  //
  //  1. The map's default light, if it has one. Its own weight then IS the leftover -- as local
  //     lights' falloff shares grow (camera approaches) the default's share shrinks to match, and
  //     vice versa, all continuously. This is the common case and the one that matters for map 571.
  //  2. No default record for this map: hand the leftover to the nearest in-range light instead of
  //     spreading it proportionally across every selected light. This still sums to 1 and still
  //     varies continuously as the "nearest" light's own raw share varies (see utils.test.ts's
  //     smoothness case) -- it degrades to the pre-normalisation darkness bug only in the degenerate
  //     case of a single light with nothing else on the map to vary against, which is an accepted,
  //     documented trade-off, not a silent one.
  //  3. Nothing in range and no default: seed from the nearest record overall, so a position outside
  //     every falloff band still resolves to something (continuously, as that nearest record's own
  //     distance changes) instead of leaving the selection empty -- which used to make MapLight freeze
  //     the previous frame's colours rather than resolving anything at all.
  //  4. No light records for the map whatsoever: `selectedLights` stays empty. There is nothing to
  //     seed from; MapLight#updateLights resolves this to its own documented neutral fallback instead
  //     of leaving the frame's params untouched.
  if (availableWeight > 0.0) {
    if (defaultLight) {
      selectedLights.push({ ...defaultLight, weight: availableWeight });
    } else if (selectedLights.length > 0) {
      selectedLights[0].weight += availableWeight;
    } else if (nearestOverall) {
      selectedLights.push({ ...nearestOverall, weight: availableWeight });
    }
  }

  return selectedLights;
};


