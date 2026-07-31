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

// Scratch for the STORMY slot's resolve, per band, per light -- lerped into `table`'s matching entry
// by `stormWeight` before that light's contribution is added to the running blend. Kept separate from
// `table` (rather than reusing it) because a band's clear and stormy values must both be live at once
// to lerp between them.
const stormTable = {
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

/** Linear interpolation between two plain numbers -- the fog scalars' storm lerp. */
const lerpScalar = (from: number, to: number, t: number) => from + (to - from) * t;

/**
 * Resolve one required int band's colour for a light, lerped toward its STORMY counterpart by
 * `stormWeight`. `stormyIntBands` is the light's own stormy slot's bands when it has one, or the
 * SAME clear slot's bands when it does not (see `blendLights`'s per-light resolve) -- lerping a value
 * toward itself at any weight is that value, so a light with no stormy override needs no separate
 * branch here: the fallback alone makes the weight a no-op for it.
 */
const resolveBandColor = (
  clearIntBands: any[],
  stormyIntBands: any[],
  band: LIGHT_INT_BAND,
  timeProgression: number,
  stormWeight: number,
  scratch: THREE.Color,
  stormScratch: THREE.Color,
) => {
  interpolateColorTable(clearIntBands[band], timeProgression, scratch);
  if (stormWeight > 0) {
    interpolateColorTable(stormyIntBands[band], timeProgression, stormScratch);
    scratch.lerp(stormScratch, stormWeight);
  }
  return scratch;
};

/**
 * Interpolate one optional int band and fold it into the running blend, lerped toward its stormy
 * counterpart the same way `resolveBandColor` does for the required bands above.
 *
 * Not every light defines every band, clear or stormy, independently -- a light can have a river
 * colour on its clear slot and none on its stormy one, or vice versa. When NEITHER side has the band
 * this skips the light entirely (accumulating unconditionally would add whatever the previous light
 * left in the scratch colour); when only one side has it, that side is used as-is with no lerp,
 * which is "the storm doesn't touch this band for this light" rather than blending toward black.
 */
const blendOptionalBandColor = (
  clearIntBands: any[],
  stormyIntBands: any[],
  band: LIGHT_INT_BAND,
  timeProgression: number,
  stormWeight: number,
  scratch: THREE.Color,
  stormScratch: THREE.Color,
  target: THREE.Color,
  weight: number,
) => {
  const clearTable = clearIntBands[band];
  const stormyTable = stormWeight > 0 ? stormyIntBands[band] : undefined;

  const hasClear = !!(clearTable && clearTable.length >= 2);
  const hasStorm = !!(stormyTable && stormyTable.length >= 2);

  if (!hasClear && !hasStorm) {
    return;
  }

  if (hasClear) {
    interpolateColorTable(clearTable, timeProgression, scratch);
  }
  if (hasStorm) {
    interpolateColorTable(stormyTable, timeProgression, stormScratch);
    if (hasClear) {
      scratch.lerp(stormScratch, stormWeight);
    } else {
      scratch.copy(stormScratch);
    }
  }

  addWeightedColor(target, scratch, weight);
};

export const blendLights = (
  weightedLights: WeightedAreaLight[],
  param: LIGHT_PARAM,
  timeProgression: number,
  // The weight `laws.stormBlend(skyDensity)` resolves -- 0 is the clear-only look every call site used
  // before this existed. Lerped PER LIGHT inside the loop below, never applied to the final weighted
  // mean: see the loop's own comment for why (a zone can mix a light with a stormy override and one
  // without, which a post-hoc lerp on the blended result cannot express).
  stormWeight = 0,
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
    // `param` is `PARAM_STANDARD` at every call site today (see `MapLight#updateLights`), and every
    // loaded `AreaLight` carries that slot -- `#getAreaLightsFromDb` always resolves it from
    // `paramsStandard`, which every real Light.dbc record defines. The array is typed sparse (other
    // slots CAN be holes) because nothing consumes them yet; this asserts non-null rather than
    // widening every consumer here to handle a slot this call never actually leaves empty.
    const clearParams = light.params[param]!;

    // `PARAM_STORMY` genuinely can be a hole (a zone with no authored storm look at all -- see
    // `AreaLight.params`'s doc comment). Falling back to the light's OWN clear slot rather than
    // skipping the lerp is what makes the weight a no-op for that light: every band below lerps the
    // clear value toward itself, which is the clear value, at any weight. This must stay INSIDE the
    // loop -- each light carries its own slots, and a zone can mix a light with a stormy override
    // beside one without; a lerp applied to the final weighted mean cannot express that.
    const stormyParams = light.params[LIGHT_PARAM.PARAM_STORMY] ?? clearParams;

    const { intBands: clearIntBands, floatBands: clearFloatBands, rawFogEndBand: clearRawFogEndBand } =
      clearParams;
    const { intBands: stormyIntBands, floatBands: stormyFloatBands, rawFogEndBand: stormyRawFogEndBand } =
      stormyParams;

    // Sun

    resolveBandColor(
      clearIntBands,
      stormyIntBands,
      LIGHT_INT_BAND.BAND_DIRECT_COLOR,
      timeProgression,
      stormWeight,
      table.sunDiffuseColor,
      stormTable.sunDiffuseColor,
    );

    addWeightedColor(blend.sunDiffuseColor, table.sunDiffuseColor, weight);

    resolveBandColor(
      clearIntBands,
      stormyIntBands,
      LIGHT_INT_BAND.BAND_AMBIENT_COLOR,
      timeProgression,
      stormWeight,
      table.sunAmbientColor,
      stormTable.sunAmbientColor,
    );

    addWeightedColor(blend.sunAmbientColor, table.sunAmbientColor, weight);

    // Fog

    resolveBandColor(
      clearIntBands,
      stormyIntBands,
      LIGHT_INT_BAND.BAND_SKY_FOG_COLOR,
      timeProgression,
      stormWeight,
      table.fogColor,
      stormTable.fogColor,
    );

    addWeightedColor(blend.fogColor, table.fogColor, weight);

    // The fog DISTANCES lerp exactly like the colours above -- and this is the whole of the
    // reference's storm draw-in. Lerping only the colours yields a storm that goes grey without
    // closing in, which reads as a tint rather than as weather (see this function's own doc/the
    // task brief). `fogStart`/`rawFogEnd` are debug-readout-only, but resolving them here (rather
    // than re-deriving from the packed pair afterward) keeps every number describing the same
    // per-light resolve.
    const clearFogEnd = interpolateNumericTable(
      clearFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_END],
      timeProgression,
    );
    const clearFogStartScalar = interpolateNumericTable(
      clearFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR],
      timeProgression,
    );
    // Debug-readout-only. `rawFogEndBand` is absent exactly when `floatBands[BAND_FOG_END]` is (see
    // `AreaLightParams.rawFogEndBand`'s doc comment) -- reconstruct from the scaled value in that case
    // rather than lose the readout entirely; a light that never had the band cannot expose a scale bug
    // either way.
    const clearRawFogEnd = clearRawFogEndBand
      ? interpolateNumericTable(clearRawFogEndBand, timeProgression)
      : clearFogEnd * 36;

    let fogEnd = clearFogEnd;
    let fogStartScalar = clearFogStartScalar;
    let rawFogEnd = clearRawFogEnd;

    if (stormWeight > 0) {
      const stormyFogEnd = interpolateNumericTable(
        stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_END],
        timeProgression,
      );
      const stormyFogStartScalar = interpolateNumericTable(
        stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR],
        timeProgression,
      );
      const stormyRawFogEnd = stormyRawFogEndBand
        ? interpolateNumericTable(stormyRawFogEndBand, timeProgression)
        : stormyFogEnd * 36;

      fogEnd = lerpScalar(clearFogEnd, stormyFogEnd, stormWeight);
      fogStartScalar = lerpScalar(clearFogStartScalar, stormyFogStartScalar, stormWeight);
      rawFogEnd = lerpScalar(clearRawFogEnd, stormyRawFogEnd, stormWeight);
    }

    const fogStart = fogStartScalar * fogEnd;

    fogEndBlend += fogEnd * weight;
    fogStartBlend += fogStart * weight;
    fogWeightTotal += weight;

    fogStartScalarBlend += fogStartScalar * weight;
    rawFogEndBlend += rawFogEnd * weight;

    // Water. Optional: plenty of lights define no river or ocean band at all, clear or stormy.

    blendOptionalBandColor(
      clearIntBands,
      stormyIntBands,
      LIGHT_INT_BAND.BAND_RIVER_CLOSE_COLOR,
      timeProgression,
      stormWeight,
      table.riverCloseColor,
      stormTable.riverCloseColor,
      blend.riverCloseColor,
      weight,
    );

    blendOptionalBandColor(
      clearIntBands,
      stormyIntBands,
      LIGHT_INT_BAND.BAND_OCEAN_CLOSE_COLOR,
      timeProgression,
      stormWeight,
      table.oceanCloseColor,
      stormTable.oceanCloseColor,
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


