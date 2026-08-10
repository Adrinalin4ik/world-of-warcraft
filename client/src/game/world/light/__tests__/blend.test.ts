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
  options: { highlightSky?: boolean; glow?: number; lightSkyboxID?: number; celestialTint?: THREE.Color; sky?: Partial<Record<'top' | 'middle' | 'band1' | 'band2' | 'smog', THREE.Color>> } = {},
): AreaLight => {
  const intBands: any[][] = [];
  intBands[LIGHT_INT_BAND.BAND_DIRECT_COLOR] = colorBand(new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_AMBIENT_COLOR] = colorBand(new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SUN_COLOR] = colorBand(options.celestialTint ?? new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_TOP_COLOR] = colorBand(options.sky?.top ?? new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_MIDDLE_COLOR] = colorBand(options.sky?.middle ?? new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_BAND_1_COLOR] = colorBand(options.sky?.band1 ?? new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_BAND_2_COLOR] = colorBand(options.sky?.band2 ?? new THREE.Color(0, 0, 0));
  intBands[LIGHT_INT_BAND.BAND_SKY_SMOG_COLOR] = colorBand(options.sky?.smog ?? new THREE.Color(0, 0, 0));
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
    highlightSky: options.highlightSky ?? false,
    glow: options.glow ?? 0.5,
    lightSkyboxID: options.lightSkyboxID ?? 0,
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

/** A light whose PARAM_STORMY slot is a distinct id from PARAM_STANDARD, with its own colours and its
 * own (fogEnd, fogStartScalar) -- so a storm lerp is observable on every band the brief calls out,
 * fog distances included. */
const mkStormyLight = (): AreaLight => {
  const light = mkLight(500, 0.25); // clear: fogEnd 500, fogStart 125

  const stormyIntBands: any[][] = [];
  stormyIntBands[LIGHT_INT_BAND.BAND_DIRECT_COLOR] = colorBand(new THREE.Color(1, 1, 1));
  stormyIntBands[LIGHT_INT_BAND.BAND_AMBIENT_COLOR] = colorBand(new THREE.Color(1, 1, 1));
  stormyIntBands[LIGHT_INT_BAND.BAND_SKY_FOG_COLOR] = colorBand(new THREE.Color(1, 1, 1));

  const stormyFloatBands: any[][] = [];
  stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_END] = numericBand(100); // stormy fog closes in
  stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR] = numericBand(-0.5); // stormy: fogStart -50

  light.params[LIGHT_PARAM.PARAM_STORMY] = {
    id: 1,
    intBands: stormyIntBands,
    floatBands: stormyFloatBands,
    rawFogEndBand: undefined,
    highlightSky: false,
    glow: 0.5,
    lightSkyboxID: 0,
  };

  return light;
};

describe('blendLights storm weight', () => {
  it('at weight 0, is identical to the clear-only blend', () => {
    const light = mkStormyLight();
    const clear = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);
    const { start: clearStart, end: clearEnd } = unpackFogParams(clear.fogParams.x, clear.fogParams.y);

    const stormed = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0);
    const { start, end } = unpackFogParams(stormed.fogParams.x, stormed.fogParams.y);

    expect(end).toBeCloseTo(clearEnd, 4);
    expect(start).toBeCloseTo(clearStart, 4);
    expect(stormed.sunAmbientColor.r).toBeCloseTo(clear.sunAmbientColor.r, 4);
  });

  it('at weight 1, resolves entirely to the stormy slot -- fog distances included, not just colour', () => {
    const light = mkStormyLight();
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 1);
    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);

    // Colour moved to the stormy slot's white.
    expect(blend.sunAmbientColor.r).toBeCloseTo(1, 4);
    expect(blend.sunDiffuseColor.r).toBeCloseTo(1, 4);
    // Fog DISTANCES moved too -- the regression test for "tint not weather": lerping only the
    // colours would leave `end` at the clear 500 and `start` at the clear 125.
    expect(end).toBeCloseTo(100, 4);
    expect(start).toBeCloseTo(-50, 4); // fogStartScalar -0.5 * fogEnd 100
  });

  it('at weight 0.5, the fog distances (not only the colours) sit exactly halfway', () => {
    const light = mkStormyLight();
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);

    // fogEnd: lerp(500, 100, 0.5) = 300. fogStartScalar: lerp(0.25, -0.5, 0.5) = -0.125.
    // fogStart = fogStartScalar * fogEnd = -0.125 * 300 = -37.5.
    expect(end).toBeCloseTo(300, 4);
    expect(start).toBeCloseTo(-37.5, 4);

    // Colour sits halfway too (clear 0 -> stormy 1).
    expect(blend.sunAmbientColor.r).toBeCloseTo(0.5, 4);
  });

  it('a light with no stormy slot (a hole) is unaffected by any storm weight', () => {
    // mkLight only ever sets PARAM_STANDARD -- PARAM_STORMY is a genuine hole here, as it is for
    // any zone with no authored storm look (see AreaLight.params' doc comment).
    const light = mkLight(500, 0.25); // fogEnd 500, fogStart 125

    for (const stormWeight of [0, 0.5, 1]) {
      const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, stormWeight);
      const { start, end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);
      expect(end).toBeCloseTo(500, 4);
      expect(start).toBeCloseTo(125, 4);
    }
  });

  it('blends a mix of lights -- one with a stormy override, one without -- correctly per light', () => {
    // The brief's own trap: a post-hoc lerp on the final weighted mean cannot express this, because
    // the two lights' storm behaviour differs. `a` has a distinct stormy slot; `b` is a hole.
    const a = mkStormyLight(); // clear fogEnd 500, stormy fogEnd 100
    const b = mkLight(200, 0.5); // no stormy slot at all -- fogEnd 200 regardless of weight

    const blend = blendLights(
      [weighted(a, 0.5), weighted(b, 0.5)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
      1, // full storm
    );
    const { end } = unpackFogParams(blend.fogParams.x, blend.fogParams.y);

    // a resolves fully to its stormy fogEnd (100); b is unaffected (200). Weighted mean: 150.
    expect(end).toBeCloseTo(0.5 * 100 + 0.5 * 200, 4);
  });
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

// Task 4: the five sky-dome gradient stops (rows 2-6) and the glow/highlightSky weighted means.
describe('blendLights sky bands and glow/highlightSky', () => {
  it('publishes all five gradient stops for a single light at full weight', () => {
    const light = mkLight(500, 0.25, undefined, {
      sky: {
        top: new THREE.Color(0.1, 0.2, 0.9),
        middle: new THREE.Color(0.2, 0.3, 0.8),
        band1: new THREE.Color(0.3, 0.4, 0.7),
        band2: new THREE.Color(0.4, 0.5, 0.6),
        smog: new THREE.Color(0.5, 0.6, 0.5),
      },
    });
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.skyTopColor.toArray()).toEqual([0.1, 0.2, 0.9]);
    expect(blend.skyMiddleColor.toArray()).toEqual([0.2, 0.3, 0.8]);
    expect(blend.skyBand1Color.toArray()).toEqual([0.3, 0.4, 0.7]);
    expect(blend.skyBand2Color.toArray()).toEqual([0.4, 0.5, 0.6]);
    expect(blend.skySmogColor.toArray()).toEqual([0.5, 0.6, 0.5]);
  });

  it('blends the gradient stops as a weighted mean across two lights', () => {
    const a = mkLight(500, 0.25, undefined, { sky: { top: new THREE.Color(1, 0, 0) } });
    const b = mkLight(200, 0.5, undefined, { sky: { top: new THREE.Color(0, 1, 0) } });

    const blend = blendLights(
      [weighted(a, 0.5), weighted(b, 0.5)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );

    expect(blend.skyTopColor.r).toBeCloseTo(0.5, 4);
    expect(blend.skyTopColor.g).toBeCloseTo(0.5, 4);
  });

  it('lerps the gradient stops toward the stormy slot by stormWeight', () => {
    const light = mkLight(500, 0.25, undefined, { sky: { top: new THREE.Color(0, 0, 0) } });
    light.params[LIGHT_PARAM.PARAM_STORMY] = {
      ...light.params[LIGHT_PARAM.PARAM_STANDARD]!,
      id: 1,
      intBands: (() => {
        const bands: any[][] = [...light.params[LIGHT_PARAM.PARAM_STANDARD]!.intBands];
        bands[LIGHT_INT_BAND.BAND_SKY_TOP_COLOR] = colorBand(new THREE.Color(1, 1, 1));
        return bands;
      })(),
    };

    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    expect(blend.skyTopColor.r).toBeCloseTo(0.5, 4);
  });

  it('publishes glow/highlightSky at their documented no-data defaults when nothing is selected', () => {
    const blend = blendLights([], LIGHT_PARAM.PARAM_STANDARD, 0);
    expect(blend.glow).toBe(0.5);
    expect(blend.highlightSky).toBe(0);
    expect(blend.lightSkyboxID).toBe(0);
  });

  it('publishes a single light\'s glow and highlightSky verbatim at full weight', () => {
    const light = mkLight(500, 0.25, undefined, { glow: 0.65, highlightSky: true });
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.glow).toBeCloseTo(0.65, 4);
    expect(blend.highlightSky).toBe(1);
  });

  it('blends highlightSky as a weighted mean across a zone boundary -- a fractional gate, not a pick-one', () => {
    const a = mkLight(500, 0.25, undefined, { highlightSky: true });
    const b = mkLight(500, 0.25, undefined, { highlightSky: false });

    const blend = blendLights(
      [weighted(a, 0.3), weighted(b, 0.7)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );
    expect(blend.highlightSky).toBeCloseTo(0.3, 4);
  });

  it('is unaffected by storm weight when the light has no stormy slot (a hole), same as the other bands', () => {
    const light = mkLight(500, 0.25, undefined, { glow: 0.7, highlightSky: true });
    for (const stormWeight of [0, 0.5, 1]) {
      const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, stormWeight);
      expect(blend.glow).toBeCloseTo(0.7, 4);
      expect(blend.highlightSky).toBe(1);
    }
  });
});

// Task 6 Step 1 of the celestial-sky plan: the zone skybox is a NEAREST-WINS pick, never a blend --
// a model path cannot be lerped the way every scalar/colour band above can.
describe('blendLights zone skybox (nearest-wins pick)', () => {
  it('publishes a single light\'s lightSkyboxID verbatim at full weight', () => {
    const light = mkLight(500, 0.25, undefined, { lightSkyboxID: 42 });
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);
    expect(blend.lightSkyboxID).toBe(42);
  });

  it('picks the GREATEST-WEIGHT light\'s id outright rather than averaging across a zone boundary', () => {
    const near = mkLight(500, 0.25, undefined, { lightSkyboxID: 7 });
    const far = mkLight(500, 0.25, undefined, { lightSkyboxID: 0 });

    const blend = blendLights(
      [weighted(far, 0.3), weighted(near, 0.7)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );
    // A weighted mean would land somewhere between 0 and 7 (e.g. 4.9); nearest-wins takes exactly 7.
    expect(blend.lightSkyboxID).toBe(7);
  });

  it('the nearest light STILL wins even when it names no skybox at all -- "nearest", not "any non-zero"', () => {
    const near = mkLight(500, 0.25, undefined, { lightSkyboxID: 0 });
    const far = mkLight(500, 0.25, undefined, { lightSkyboxID: 99 });

    const blend = blendLights(
      [weighted(far, 0.2), weighted(near, 0.8)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );
    expect(blend.lightSkyboxID).toBe(0);
  });

  it('past the halfway point of a storm crossfade, the STORMY slot\'s id wins outright', () => {
    const light = mkLight(500, 0.25, undefined, { lightSkyboxID: 5 });
    light.params[LIGHT_PARAM.PARAM_STORMY] = {
      ...light.params[LIGHT_PARAM.PARAM_STANDARD]!,
      lightSkyboxID: 9,
    };

    // `blendLights` returns a shared mutable singleton (like every other field on it) -- read each
    // result out immediately rather than holding both `blend` references, or the second call's
    // mutation clobbers the first.
    const below = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.49).lightSkyboxID;
    const above = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.51).lightSkyboxID;
    expect(below).toBe(5);
    expect(above).toBe(9);
  });
});

// Task 1 of the celestial-sky plan: the celestial diffuse (`LIGHT_INT_BAND.BAND_SUN_COLOR`), the "big
// 0485 correction" -- one colour drives every celestial disc/glare's RGB, resolved through the same
// per-light storm lerp and weighted-mean machinery as the sun/sky bands above.
describe('blendLights celestial tint', () => {
  it('publishes a single light\'s celestial tint verbatim at full weight', () => {
    const light = mkLight(500, 0.25, undefined, { celestialTint: new THREE.Color(0.9, 0.6, 0.3) });
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.celestialTint.toArray()).toEqual([0.9, 0.6, 0.3]);
  });

  it('blends the celestial tint as a weighted mean across two lights', () => {
    const a = mkLight(500, 0.25, undefined, { celestialTint: new THREE.Color(1, 0, 0) });
    const b = mkLight(200, 0.5, undefined, { celestialTint: new THREE.Color(0, 1, 0) });

    const blend = blendLights(
      [weighted(a, 0.5), weighted(b, 0.5)],
      LIGHT_PARAM.PARAM_STANDARD,
      0,
    );

    expect(blend.celestialTint.r).toBeCloseTo(0.5, 4);
    expect(blend.celestialTint.g).toBeCloseTo(0.5, 4);
  });

  it('lerps the celestial tint toward the stormy slot by stormWeight, same as every other band', () => {
    const light = mkLight(500, 0.25, undefined, { celestialTint: new THREE.Color(0, 0, 0) });
    light.params[LIGHT_PARAM.PARAM_STORMY] = {
      ...light.params[LIGHT_PARAM.PARAM_STANDARD]!,
      id: 1,
      intBands: (() => {
        const bands: any[][] = [...light.params[LIGHT_PARAM.PARAM_STANDARD]!.intBands];
        bands[LIGHT_INT_BAND.BAND_SUN_COLOR] = colorBand(new THREE.Color(1, 1, 1));
        return bands;
      })(),
    };

    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    expect(blend.celestialTint.r).toBeCloseTo(0.5, 4);
  });

  it('is unaffected by storm weight when the light has no stormy slot (a hole)', () => {
    const light = mkLight(500, 0.25, undefined, { celestialTint: new THREE.Color(0.4, 0.5, 0.6) });
    for (const stormWeight of [0, 0.5, 1]) {
      const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, stormWeight);
      expect(blend.celestialTint.toArray()).toEqual([0.4, 0.5, 0.6]);
    }
  });

  it('does not divide by zero (and is not NaN) on an empty light list', () => {
    const blend = blendLights([], LIGHT_PARAM.PARAM_STANDARD, 0);
    expect(Number.isNaN(blend.celestialTint.r)).toBe(false);
    expect(blend.celestialTint.toArray()).toEqual([0, 0, 0]);
  });
});

// Step 2/3: cloud density (`LIGHT_FLOAT_BAND.BAND_CLOUD_DENSITY`) and the three cloud-palette colours
// (`LIGHT_INT_BAND.BAND_CLOUD_SUN_COLOR`/`BAND_CLOUD_SLOPE_COLOR`/`BAND_CLOUD_BASE_COLOR`).
describe('blendLights cloud bands', () => {
  /** A light whose clear cloud density is distinct from its PARAM_STORMY slot's, so the storm lerp is
   * directly observable -- the same shape as `mkStormyLight`, but adding the cloud density float band
   * (BAND_CLOUD_DENSITY) to both slots instead of colour/fog bands. */
  const mkCloudLight = (clearDensity: number, stormyDensity: number): AreaLight => {
    const light = mkLight(500, 0.25);

    const standardFloatBands = light.params[LIGHT_PARAM.PARAM_STANDARD]!.floatBands;
    standardFloatBands[LIGHT_FLOAT_BAND.BAND_CLOUD_DENSITY] = numericBand(clearDensity);

    const stormyFloatBands: any[][] = [];
    stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_END] = numericBand(500);
    stormyFloatBands[LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR] = numericBand(0.25);
    stormyFloatBands[LIGHT_FLOAT_BAND.BAND_CLOUD_DENSITY] = numericBand(stormyDensity);

    light.params[LIGHT_PARAM.PARAM_STORMY] = {
      id: 1,
      intBands: [],
      floatBands: stormyFloatBands,
      rawFogEndBand: undefined,
      highlightSky: false,
      glow: 0.5,
      lightSkyboxID: 0,
    };

    return light;
  };

  it('rides the per-light storm lerp -- weight 0 reads the clear density', () => {
    const light = mkCloudLight(0.2, 0.9);
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0);
    expect(blend.cloudDensity).toBeCloseTo(0.2, 4);
  });

  it('rides the per-light storm lerp -- weight 1 reads the stormy density entirely', () => {
    const light = mkCloudLight(0.2, 0.9);
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 1);
    expect(blend.cloudDensity).toBeCloseTo(0.9, 4);
  });

  it('rides the per-light storm lerp -- a fractional weight sits between the two', () => {
    const light = mkCloudLight(0.2, 0.9);
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    expect(blend.cloudDensity).toBeCloseTo(0.55, 4); // lerp(0.2, 0.9, 0.5)
  });

  it('defaults to 0.0 -- not a hole or NaN -- when the band is entirely absent', () => {
    const light = mkLight(500, 0.25); // no BAND_CLOUD_DENSITY set at all
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    expect(blend.cloudDensity).toBe(0);
    expect(Number.isNaN(blend.cloudDensity)).toBe(false);
  });

  it('does not divide by zero (and is not NaN) on an empty light list', () => {
    const blend = blendLights([], LIGHT_PARAM.PARAM_STANDARD, 0);
    expect(blend.cloudDensity).toBe(0);
    expect(Number.isNaN(blend.cloudDensity)).toBe(false);
  });

  it('publishes the three cloud-palette colours for a single light at full weight', () => {
    const light = mkLight(500, 0.25);
    const intBands = light.params[LIGHT_PARAM.PARAM_STANDARD]!.intBands;
    intBands[LIGHT_INT_BAND.BAND_CLOUD_SUN_COLOR] = colorBand(new THREE.Color(1, 0.9, 0.7));
    intBands[LIGHT_INT_BAND.BAND_CLOUD_SLOPE_COLOR] = colorBand(new THREE.Color(0.3, 0.4, 0.5));
    intBands[LIGHT_INT_BAND.BAND_CLOUD_BASE_COLOR] = colorBand(new THREE.Color(0.6, 0.6, 0.7));

    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.cloudSunColor.toArray()).toEqual([1, 0.9, 0.7]);
    expect(blend.cloudSlopeColor.toArray()).toEqual([0.3, 0.4, 0.5]);
    expect(blend.cloudBaseColor.toArray()).toEqual([0.6, 0.6, 0.7]);
  });

  it('is optional -- a light that authors none of the three cloud colours contributes nothing', () => {
    const light = mkLight(500, 0.25); // no cloud int bands set
    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0);

    expect(blend.cloudSunColor.toArray()).toEqual([0, 0, 0]);
    expect(blend.cloudSlopeColor.toArray()).toEqual([0, 0, 0]);
    expect(blend.cloudBaseColor.toArray()).toEqual([0, 0, 0]);
  });

  it('lerps the cloud colours toward the stormy slot by stormWeight, same as sky/water', () => {
    const light = mkLight(500, 0.25);
    const intBands = light.params[LIGHT_PARAM.PARAM_STANDARD]!.intBands;
    intBands[LIGHT_INT_BAND.BAND_CLOUD_SUN_COLOR] = colorBand(new THREE.Color(0, 0, 0));

    light.params[LIGHT_PARAM.PARAM_STORMY] = {
      ...light.params[LIGHT_PARAM.PARAM_STANDARD]!,
      id: 1,
      intBands: (() => {
        const bands: any[][] = [...intBands];
        bands[LIGHT_INT_BAND.BAND_CLOUD_SUN_COLOR] = colorBand(new THREE.Color(1, 1, 1));
        return bands;
      })(),
    };

    const blend = blendLights([weighted(light, 1.0)], LIGHT_PARAM.PARAM_STANDARD, 0, 0.5);
    expect(blend.cloudSunColor.r).toBeCloseTo(0.5, 4);
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
