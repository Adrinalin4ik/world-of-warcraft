import * as THREE from 'three';
import { MAP_CORNER_X, MAP_CORNER_Y } from './constants';
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

export const selectLightsForPosition = (
  lights: AreaLight[],
  position: THREE.Vector3,
): WeightedAreaLight[] => {
  const selectedLights = [];

  for (const light of lights) {
    const distance = position.distanceTo(light.position);

    // Include lights if position is within falloff radii
    if (distance <= light.falloffEnd) {
      selectedLights.push({ light, distance, weight: 0.0 });
    }

    // Include default light
    if (
      light.position.x === MAP_CORNER_X &&
      light.position.y === MAP_CORNER_Y &&
      light.falloffEnd === 0.0
    ) {
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

    // Default light has no falloff
    const falloff =
      light.falloffStart > 0.0 && light.falloffEnd > 0.0
        ? (distance - light.falloffStart) / (light.falloffEnd - light.falloffStart)
        : 0.0;

    const weight = clamp(1.0 - falloff, 0.0, availableWeight);

    selectedLight.weight = weight;
    availableWeight -= weight;
  }

  // Normalise so the selected weights sum to 1. A map that has a default-light record at the map
  // corner (falloffEnd === 0) already absorbs the whole 1.0 -- this is then a no-op. A map without
  // one (e.g. 489, Warsong Gulch) leaves a shortfall that used to just vanish, so blendLights
  // accumulated a fraction of a light's contribution and the whole scene read darker the farther the
  // camera sat from the nearest record. Normalising here, rather than in blendLights, means the debug
  // readout -- which reports these same `weight` fields -- shows the weights actually used instead of
  // the pre-shortfall figures.
  const totalWeight = selectedLights.reduce((sum, selectedLight) => sum + selectedLight.weight, 0);

  if (totalWeight > 0) {
    for (const selectedLight of selectedLights) {
      selectedLight.weight /= totalWeight;
    }
  }

  return selectedLights;
};


