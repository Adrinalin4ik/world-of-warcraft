/**
 * @jest-environment node
 */
import * as THREE from 'three';
import { blendLights } from '../blend';
import { LIGHT_FLOAT_BAND, LIGHT_INT_BAND, LIGHT_PARAM } from '../constants';
import { unpackFogParams } from '../fog';
import { AreaLight, WeightedAreaLight } from '../types';

// A single-stop colour/numeric band returns its one value regardless of the time-of-day key (see
// getTableKeys' wrap-to-self case), so tests do not need to care about timeProgression at all.
const colorBand = (color: THREE.Color): any[] => [0, color];
const numericBand = (value: number): any[] => [0, value];

const mkLight = (
  fogEnd: number,
  fogStartScalar: number,
  rawFogEnd?: number,
): AreaLight => {
  const intBands: any[][] = [];
  intBands[LIGHT_INT_BAND.BAND_DIRECT_COLOR] = colorBand(new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_AMBIENT_COLOR] = colorBand(new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_FOG_COLOR] = colorBand(new THREE.Color(0, 0, 0));

  const floatBands: any[][] = [];
  floatBands[LIGHT_FLOAT_BAND.BAND_FOG_END] = numericBand(fogEnd);
  floatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR] = numericBand(fogStartScalar);

  const params: AreaLight['params'] = [];
  params[LIGHT_PARAM.PARAM_STANDARD] = {
    id: 0,
    intBands,
    floatBands,
    rawFogEndBand: rawFogEnd !== undefined ? numericBand(rawFogEnd) : undefined,
  };

  return {
    id: 0,
    mapId: 0,
    position: new THREE.Vector3(),
    falloffStart: 0,
    falloffEnd: 0,
    params,
  };
};

const weighted = (light: AreaLight, weight: number, distance = 0): WeightedAreaLight => ({
  light,
  weight,
  distance,
});

describe('blendLights fog band', () => {
  it('recovers a single light\'s (fogStart, fogEnd) band at full weight', () => {
    const light = mkLight(500, 0.25); // fogStart = 0.25 * 500 = 125
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
    expect(end).toBeCloseTo(500, 4);
    expect(start).toBeCloseTo(125, 4);
  });

  it('recovers the same band at a PARTIAL weight -- the regression the old packed-then-blended code failed', () => {
    // Under the old code, packing (fogStart, fogEnd) once and then scaling the packed pair by 0.322
    // preserved `end` (a ratio) but blew `start` out to a large negative number. The fix blends the
    // scalars as a weighted mean, so a lone light's own weight cancels out entirely.
    const light = mkLight(500, 0.25); // fogStart = 125
    const blend = blendLights([weighted(light, 0.322)], LIGHT_PARAM.PARAM_STANDARD, 0);

    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
    expect(end).toBeCloseTo(500, 4);
    expect(start).toBeCloseTo(125, 4);
  });

  it('blends two lights with different fog bands as the weighted mean, not a pick-one', () => {
    const a = mkLight(500, 0.25); // end 500, start 125
    const b = mkLight(200, 0.5); // end 200, start 100

    const blend = blendLights(
      [weighted(a, 0.6), weighted(b, 0.4)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );

    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
    // Weighted mean over weights that already sum to 1: 0.6*500 + 0.4*200 = 380, 0.6*125 + 0.4*100 = 115.
    expect(end).toBeCloseTo(380, 4);
    expect(start).toBeCloseTo(115, 4);
  });

  it('divides by the total weight even when the caller\'s weights do not sum to 1', () => {
    // Same two bands as above, but handed in with an unnormalised (shortfall) weight pair -- exactly
    // the shape selectLightsForPosition used to produce before it normalised. The mean must come out
    // identical to the normalised-weight case: the ratio between the two weights is what matters.
    const a = mkLight(500, 0.25);
    const b = mkLight(200, 0.5);

    const blend = blendLights(
      [weighted(a, 0.3), weighted(b, 0.2)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );

    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
    expect(end).toBeCloseTo(380, 4);
    expect(start).toBeCloseTo(115, 4);
  });

  it('does not divide by zero on an empty light list', () => {
    const blend = blendLights([], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(Number.isNaN(blend.fogParams.x)).toBe(false);
    expect(Number.isNaN(blend.fogParams.y)).toBe(false);
    expect(Number.isNaN(blend.fogStartScalar)).toBe(false);
    expect(Number.isNaN(blend.rawFogEnd)).toBe(false);
  });
});

// Debug-readout-only fields (see MapLight#fogStartScalar / #rawFogEnd's doc comments): resolved
// independently of the packed fogParams pair, specifically so a scale bug in #processFloatBand would
// show up as a mismatch between `rawFogEnd / 36` and `fogEnd` rather than being invisible.
describe('blendLights debug fields', () => {
  it('reports the resolved fogStartScalar BEFORE it is multiplied by fogEnd', () => {
    const light = mkLight(500, -0.5);
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.fogStartScalar).toBeCloseTo(-0.5, 4);
  });

  it('reports the raw fogEnd band value, independent of the scaled one', () => {
    // 500 scaled (what floatBands carries) does not have to equal 18000 / 36 by construction here --
    // the two are tracked through entirely separate accumulators, which is the point: if
    // MapLight#processFloatBand's scale were applied to the wrong band, or twice, `fogEnd` here would
    // drift from `rawFogEnd / 36` and the debug readout would show the mismatch.
    const light = mkLight(500, 0.25, 18000);
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    const { end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
    expect(end).toBeCloseTo(500, 4);
    expect(blend.rawFogEnd).toBeCloseTo(18000, 4);
  });

  it('falls back to fogEnd * 36 when a light has no rawFogEndBand at all', () => {
    const light = mkLight(500, 0.25); // no rawFogEnd passed
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.rawFogEnd).toBeCloseTo(500 * 36, 4);
  });

  it('blends fogStartScalar and rawFogEnd as weighted means across multiple lights', () => {
    const a = mkLight(500, 0.25, 18000);
    const b = mkLight(200, -0.5, 3600);

    const blend = blendLights(
      [weighted(a, 0.6), weighted(b, 0.4)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );

    expect(blend.fogStartScalar).toBeCloseTo(0.6 * 0.25 + 0.4 * -0.5, 4);
    expect(blend.rawFogEnd).toBeCloseTo(0.6 * 18000 + 0.4 * 3600, 4);
  });
});
