import * as THREE from 'three';
import { LIGHT_FLOAT_BAND, LIGHT_INT_BAND, LIGHT_PARAM } from './constants';
import { packFogParams } from './fog';
import { WeightedAreaLight } from './types';
import { interpolateColorTable, interpolateNumericTable } from './utils';

const table = {
  sunDiffuseColor: new THREE.Color(),
  sunAmbientColor: new THREE.Color(),
  fogColor: new THREE.Color(),
  fogParams: new THREE.Vector4(),
  riverCloseColor: new THREE.Color(),
  oceanCloseColor: new THREE.Color(),
};

const blend = {
  sunDiffuseColor: new THREE.Color(),
  sunAmbientColor: new THREE.Color(),
  fogColor: new THREE.Color(),
  fogParams: new THREE.Vector4(),
  riverCloseColor: new THREE.Color(),
  oceanCloseColor: new THREE.Color(),
};

const tempColor = new THREE.Color();
const tempVector = new THREE.Vector4();

const addWeightedColor = (color: THREE.Color, add: THREE.Color, weight: number) => {
  color.add(tempColor.copy(add).multiplyScalar(weight));
};

const addWeightedVector = (vector: THREE.Vector4, add: THREE.Vector4, weight: number) => {
  vector.add(tempVector.copy(add).multiplyScalar(weight));
};

/**
 * Interpolate one optional int band and fold it into the running blend.
 *
 * Not every light defines every band. When one is absent the interpolation leaves its scratch colour
 * as it was, so accumulating unconditionally would add whatever the previous light left there. This
 * skips the light instead, which is what "no band" should mean.
 */
const blendOptionalBandColor = (
  intBands: any[],
  band: LIGHT_INT_BAND,
  timeProgression: number,
  scratch: THREE.Color,
  target: THREE.Color,
  weight: number,
) => {
  const bandTable = intBands[band];

  if (!bandTable || bandTable.length < 2) {
    return;
  }

  interpolateColorTable(bandTable, timeProgression, scratch);
  addWeightedColor(target, scratch, weight);
};

export const blendLights = (
  weightedLights: WeightedAreaLight[],
  param: LIGHT_PARAM,
  timeProgression: number,
) => {
  blend.sunDiffuseColor.setScalar(0);
  blend.sunAmbientColor.setScalar(0);
  blend.fogColor.setScalar(0);
  blend.fogParams.setScalar(0);
  blend.riverCloseColor.setScalar(0);
  blend.oceanCloseColor.setScalar(0);

  for (const weightedLight of weightedLights) {
    const { light, weight } = weightedLight;
    const { intBands, floatBands } = light.params[param];

    // Sun

    interpolateColorTable(
      intBands[LIGHT_INT_BAND.BAND_DIRECT_COLOR],
      timeProgression,
      table.sunDiffuseColor,
    );

    addWeightedColor(blend.sunDiffuseColor, table.sunDiffuseColor, weight);

    interpolateColorTable(
      intBands[LIGHT_INT_BAND.BAND_AMBIENT_COLOR],
      timeProgression,
      table.sunAmbientColor,
    );

    addWeightedColor(blend.sunAmbientColor, table.sunAmbientColor, weight);

    // Fog

    interpolateColorTable(
      intBands[LIGHT_INT_BAND.BAND_SKY_FOG_COLOR],
      timeProgression,
      table.fogColor,
    );

    addWeightedColor(blend.fogColor, table.fogColor, weight);

    const fogEnd = interpolateNumericTable(
      floatBands[LIGHT_FLOAT_BAND.BAND_FOG_END],
      timeProgression,
    );

    const fogStartScalar = interpolateNumericTable(
      floatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR],
      timeProgression,
    );

    const fogStart = fogStartScalar * fogEnd;

    // Packed so the shader's `f1 = distance * x + y` falls from 1 at fogStart to 0 at fogEnd, which
    // is what it then turns into a fog factor via `1 - min(pow(max(f1, 0), z), 1)`.
    // Passing (fogStep, fogEnd) instead left f1 permanently far above 1, pinning the fog factor at
    // zero, so fog never applied no matter how distant the geometry.
    table.fogParams.set(...packFogParams(fogStart, fogEnd));

    addWeightedVector(blend.fogParams, table.fogParams, weight);

    // Water. Optional: plenty of lights define no river or ocean band at all.

    blendOptionalBandColor(
      intBands,
      LIGHT_INT_BAND.BAND_RIVER_CLOSE_COLOR,
      timeProgression,
      table.riverCloseColor,
      blend.riverCloseColor,
      weight,
    );

    blendOptionalBandColor(
      intBands,
      LIGHT_INT_BAND.BAND_OCEAN_CLOSE_COLOR,
      timeProgression,
      table.oceanCloseColor,
      blend.oceanCloseColor,
      weight,
    );
  }

  return blend;
};


