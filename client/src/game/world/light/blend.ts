import * as THREE from 'three';
import { LIGHT_FLOAT_BAND, LIGHT_INT_BAND, LIGHT_PARAM } from './constants';
import { packFogParams } from './fog';
import { WeightedAreaLight } from './types';
import { interpolateColorTable, interpolateNumericTable } from './utils';

const table = {
  sunDiffuseColor: new THREE.Color(),
  sunAmbientColor: new THREE.Color(),
  fogColor: new THREE.Color(),
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
  // Debug-readout-only (see MapLight#fogStartScalar / #rawFogEnd's doc comments). Plain numbers, so
  // -- unlike the colours/vector above -- these are just reassigned each call, not mutated in place.
  fogStartScalar: 0,
  rawFogEnd: 0,
};

const tempColor = new THREE.Color();

const addWeightedColor = (color: THREE.Color, add: THREE.Color, weight: number) => {
  color.add(tempColor.copy(add).multiplyScalar(weight));
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
  blend.riverCloseColor.setScalar(0);
  blend.oceanCloseColor.setScalar(0);

  // Blended as plain scalars -- a weighted MEAN, not a raw weighted sum -- and packed exactly ONCE
  // below, never packed per light and then blended. Two things matter here:
  //  - Packing (`packFogParams`) is not linear in the weight: scaling the packed (x, y) pair
  //    preserves `end` (the ratio -y/x) but destroys `start`, which depends on the pair's magnitude.
  //    Blending the scalars first and packing the result once avoids that entirely.
  //  - Dividing by the total weight (rather than assuming it already sums to 1) means the fog band
  //    is correct even if the caller's weights are not normalised -- a future regression in the
  //    weight distribution upstream (see `selectLightsForPosition`) cannot silently reintroduce the
  //    fog distortion even if it reintroduces the darkness.
  let fogEndBlend = 0;
  let fogStartBlend = 0;
  let fogWeightTotal = 0;

  // Debug-readout-only accumulators (see MapLight#fogStartScalar / #rawFogEnd's doc comments) --
  // blended the same weighted-mean way as fogEnd/fogStart above, so they describe the same resolve.
  let fogStartScalarBlend = 0;
  let rawFogEndBlend = 0;

  for (const weightedLight of weightedLights) {
    const { light, weight } = weightedLight;
    const { intBands, floatBands, rawFogEndBand } = light.params[param];

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

    fogEndBlend += fogEnd * weight;
    fogStartBlend += fogStart * weight;
    fogWeightTotal += weight;

    // Debug-readout-only. `rawFogEndBand` is absent exactly when `floatBands[BAND_FOG_END]` is (see
    // `AreaLightParams.rawFogEndBand`'s doc comment) -- reconstruct from the scaled value in that case
    // rather than lose the readout entirely; a light that never had the band cannot expose a scale bug
    // either way.
    const rawFogEnd = rawFogEndBand
      ? interpolateNumericTable(rawFogEndBand, timeProgression)
      : fogEnd * 36;

    fogStartScalarBlend += fogStartScalar * weight;
    rawFogEndBlend += rawFogEnd * weight;

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

  // Packed so the shader's `f1 = distance * x + y` falls from 1 at fogStart to 0 at fogEnd, which is
  // what it then turns into a fog factor via `1 - min(pow(max(f1, 0), z), 1)`. Packing happens exactly
  // once, from the already-blended (and mean-normalised) scalar pair -- see the comment above the
  // loop for why packing per light and then blending the packed pairs is wrong, and for why dividing
  // by the total weight here rather than trusting it to already be 1.
  const [fogEndMean, fogStartMean] = fogWeightTotal > 0
    ? [fogEndBlend / fogWeightTotal, fogStartBlend / fogWeightTotal]
    : [0, 0];

  blend.fogParams.set(...packFogParams(fogStartMean, fogEndMean));

  // Debug-readout-only -- see the accumulators' doc comments above.
  blend.fogStartScalar = fogWeightTotal > 0 ? fogStartScalarBlend / fogWeightTotal : 0;
  blend.rawFogEnd = fogWeightTotal > 0 ? rawFogEndBlend / fogWeightTotal : 0;

  return blend;
};


