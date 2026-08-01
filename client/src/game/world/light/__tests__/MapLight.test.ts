import * as THREE from 'three';
import { LIGHT_PARAM } from '../constants';

// `MapLight` reaches the DBC loader through `../../pipeline/dbc` (from MapLight.ts's own folder),
// which is `../../../pipeline/dbc` from here. Mocked entirely: the real loader goes through a
// worker pool and a network fetch, neither of which belongs in a unit test of the band-id
// arithmetic and slot-sparseness this file exists to cover.
jest.mock('../../../pipeline/dbc', () => ({
  __esModule: true,
  default: { load: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DBC = require('../../../pipeline/dbc').default;

import MapLight from '../MapLight';

const MAP_ID = 42;

// A single-stop int/float band, keyed by DBC band id, matching `#processIntBand`/`#processFloatBand`'s
// expected shape (`entryCount`/`times`/`values`).
const intBand = (bgra: number) => ({ entryCount: 1, times: [0], values: [bgra] });
const floatBand = (value: number) => ({ entryCount: 1, times: [0], values: [value] });

/** Populate every LightIntBand/LightFloatBand row a given LightParams id would resolve to, using
 * the exact `#getAreaLightsFromDb` formulas (`(id * 18) - 17 + i` / `(id * 6) - 5 + i`), so the
 * test fixture and the code under test can never silently drift apart. */
const populateBandsForId = (
  intBandDb: Record<number, any>,
  floatBandDb: Record<number, any>,
  id: number,
  directColorBgra: number,
  fogEndValue: number,
) => {
  // BAND_DIRECT_COLOR is LIGHT_INT_BAND index 0.
  intBandDb[(id * 18) - 17 + 0] = intBand(directColorBgra);
  // BAND_FOG_END is LIGHT_FLOAT_BAND index 0.
  floatBandDb[(id * 6) - 5 + 0] = floatBand(fogEndValue);
};

const mockLightRecord = (overrides: Partial<Record<string, number>> = {}) => ({
  id: 1,
  mapID: MAP_ID,
  position: { x: 0, y: 0, z: 0 },
  fallOffStart: 0,
  fallOffEnd: 0, // falloffEnd === 0 -> this record is the map's seed light, always selected at weight 1.
  paramsStandard: 100,
  paramsUnderwater: 0,
  paramsStormy: 200,
  paramsStormyUnderwater: 0,
  paramsDeath: 0,
  reserved5: 0,
  reserved6: 0,
  reserved7: 0,
  ...overrides,
});

const setupDbcMocks = (lightRecord: ReturnType<typeof mockLightRecord>, lightParamsRows: Record<number, any>) => {
  const intBandDb: Record<number, any> = {};
  const floatBandDb: Record<number, any> = {};

  populateBandsForId(intBandDb, floatBandDb, lightRecord.paramsStandard, 0xff0000, 500);
  if (lightRecord.paramsStormy) {
    populateBandsForId(intBandDb, floatBandDb, lightRecord.paramsStormy, 0x0000ff, 100);
  }

  const lightDb: Record<string, any> = { records: [lightRecord] };
  const lightParamsDb: Record<string, any> = { records: Object.values(lightParamsRows) };
  Object.assign(lightParamsDb, lightParamsRows);
  const lightIntBandDb: Record<string, any> = { records: [] };
  Object.assign(lightIntBandDb, intBandDb);
  const lightFloatBandDb: Record<string, any> = { records: [] };
  Object.assign(lightFloatBandDb, floatBandDb);

  (DBC.load as jest.Mock).mockImplementation((name: string) => {
    switch (name) {
      case 'Light':
        return Promise.resolve(lightDb);
      case 'LightParams':
        return Promise.resolve(lightParamsDb);
      case 'LightIntBand':
        return Promise.resolve(lightIntBandDb);
      case 'LightFloatBand':
        return Promise.resolve(lightFloatBandDb);
      default:
        return Promise.resolve({ records: [] });
    }
  });
};

/** Drives a `MapLight` through a real `update()` so `selectedLights` is populated the same way
 * production code populates it, rather than reaching into private state. */
const selectSingleLight = async (mapLight: MapLight) => {
  await mapLight.loadLights();
  mapLight.mapId = MAP_ID;

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld();

  mapLight.update(camera, 0);

  return mapLight.selectedLights[0].light;
};

describe('MapLight#getAreaLightsFromDb slot loading', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('loads the sparse params array indexed by LIGHT_PARAM, with holes for undefined slots', async () => {
    const lightRecord = mockLightRecord();
    setupDbcMocks(lightRecord, {
      100: { id: 100, highlightSky: true, glow: 0.7 },
      200: { id: 200, highlightSky: false, glow: 0.3 },
    });

    const mapLight = new MapLight();
    const light = await selectSingleLight(mapLight);

    // Defined slots: standard (0) and stormy (2).
    expect(light.params[LIGHT_PARAM.PARAM_STANDARD]).toBeDefined();
    expect(light.params[LIGHT_PARAM.PARAM_STORMY]).toBeDefined();

    // Undefined slots (id 0 in the record) are holes, not copies of slot 0.
    expect(light.params[LIGHT_PARAM.PARAM_STANDARD_UNDERWATER]).toBeUndefined();
    expect(light.params[LIGHT_PARAM.PARAM_STORMY_UNDERWATER]).toBeUndefined();
    expect(light.params[LIGHT_PARAM.PARAM_DEATH]).toBeUndefined();
  });

  it('computes each slot\'s bands from that slot\'s OWN id, not slot 0\'s', async () => {
    const lightRecord = mockLightRecord();
    setupDbcMocks(lightRecord, {
      100: { id: 100, highlightSky: false, glow: 0.5 },
      200: { id: 200, highlightSky: false, glow: 0.5 },
    });

    const mapLight = new MapLight();
    const light = await selectSingleLight(mapLight);

    const standard = light.params[LIGHT_PARAM.PARAM_STANDARD]!;
    const stormy = light.params[LIGHT_PARAM.PARAM_STORMY]!;

    // The two slots point at different LightParams ids and therefore different band tables --
    // reusing slot 0's id for every slot would load identical bands and make every slot the same.
    expect(standard.id).toBe(100);
    expect(stormy.id).toBe(200);
    expect(standard.floatBands[0]).not.toEqual(stormy.floatBands[0]);
    expect(standard.intBands[0]).not.toEqual(stormy.intBands[0]);

    // Assert on the actual resolved values, not just "they differ": standard was set up with
    // fogEnd 500 (scaled by 1/36) and a red direct colour; stormy with fogEnd 100 and a blue one.
    expect(standard.floatBands[0][1]).toBeCloseTo(500 / 36, 4);
    expect(stormy.floatBands[0][1]).toBeCloseTo(100 / 36, 4);
    expect(standard.intBands[0][1].r).toBeCloseTo(1, 4); // 0xff0000
    expect(stormy.intBands[0][1].b).toBeCloseTo(1, 4); // 0x0000ff
  });

  it('carries highlightSky, glow and lightSkyboxID off the LightParams row onto each loaded slot', async () => {
    const lightRecord = mockLightRecord();
    setupDbcMocks(lightRecord, {
      100: { id: 100, highlightSky: true, glow: 0.9, lightSkyboxID: 12 },
      200: { id: 200, highlightSky: false, glow: 0.2, lightSkyboxID: 0 },
    });

    const mapLight = new MapLight();
    const light = await selectSingleLight(mapLight);

    expect(light.params[LIGHT_PARAM.PARAM_STANDARD]!.highlightSky).toBe(true);
    expect(light.params[LIGHT_PARAM.PARAM_STANDARD]!.glow).toBeCloseTo(0.9, 4);
    expect(light.params[LIGHT_PARAM.PARAM_STANDARD]!.lightSkyboxID).toBe(12);
    expect(light.params[LIGHT_PARAM.PARAM_STORMY]!.highlightSky).toBe(false);
    expect(light.params[LIGHT_PARAM.PARAM_STORMY]!.glow).toBeCloseTo(0.2, 4);
    expect(light.params[LIGHT_PARAM.PARAM_STORMY]!.lightSkyboxID).toBe(0);
  });

  it('defaults glow to 0.5, highlightSky to false and lightSkyboxID to 0 when the LightParams row is missing', async () => {
    // Slot id 100 has no matching LightParams row at all (not even present in the fixture).
    const lightRecord = mockLightRecord({ paramsStormy: 0 });
    setupDbcMocks(lightRecord, {});

    const mapLight = new MapLight();
    const light = await selectSingleLight(mapLight);

    const standard = light.params[LIGHT_PARAM.PARAM_STANDARD]!;
    expect(standard.highlightSky).toBe(false);
    expect(standard.glow).toBeCloseTo(0.5, 4);
    expect(standard.lightSkyboxID).toBe(0);

    // paramsStormy was zeroed for this fixture -- still a hole, not a slot with defaulted params.
    expect(light.params[LIGHT_PARAM.PARAM_STORMY]).toBeUndefined();
  });

  it('publishes the resolved lightSkyboxID off MapLight#lightSkyboxID after a full update()', async () => {
    const lightRecord = mockLightRecord();
    setupDbcMocks(lightRecord, {
      100: { id: 100, highlightSky: false, glow: 0.5, lightSkyboxID: 77 },
      200: { id: 200, highlightSky: false, glow: 0.5, lightSkyboxID: 0 },
    });

    const mapLight = new MapLight();
    await selectSingleLight(mapLight);

    expect(mapLight.lightSkyboxID).toBe(77);
  });
});

describe('MapLight cloud glow body (clouds Task 4)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  /** Drive the light to a given time of day and return the resolved glow state. */
  const glowAt = async (hour: number) => {
    const lightRecord = mockLightRecord();
    setupDbcMocks(lightRecord, { 100: { id: 100, highlightSky: false, glow: 0.5 } });

    const mapLight = new MapLight();
    await mapLight.loadLights();
    mapLight.mapId = MAP_ID;
    // `time` is half-minutes since midnight, so an hour is 120 of them.
    mapLight.timeOverride = hour * 120;

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 0);
    camera.updateMatrixWorld();
    mapLight.update(camera, 0);

    return {
      dir: mapLight.cloudGlowDir.clone(),
      track: mapLight.cloudGlowTrack,
      sunDir: mapLight.sunDir.clone(),
    };
  };

  it('points the daytime glow AT the sun, not along the direction light travels', async () => {
    // The negation is the subtlety. `sunDir` is sun-down-onto-the-world and stays below the horizon
    // all day (see `#updateSunDirection`); the kernel intersects a camera->body ray with the sky
    // dome, so handing it the travel direction would place the glow under the world. Feeding the
    // unnegated vector still renders -- it just lights the wrong hemisphere -- which is exactly the
    // kind of wrong that survives a visual check.
    const { dir, sunDir } = await glowAt(12);

    expect(dir.x).toBeCloseTo(-sunDir.x, 6);
    expect(dir.y).toBeCloseTo(-sunDir.y, 6);
    expect(dir.z).toBeCloseTo(-sunDir.z, 6);
    // Z is up in this client's unpermuted WoW frame, so the daytime body is above the horizon.
    expect(dir.z).toBeGreaterThan(0);
  });

  it('swaps the body to the moon at night, still above the horizon', async () => {
    // Deep night runs at FULL glow envelope because of the verified 22:10 seam wrap, so the body
    // genuinely matters here -- keeping the sun would track one parked below the horizon.
    const { dir, track } = await glowAt(2);

    expect(track).toBeCloseTo(1, 5);
    expect(dir.z).toBeGreaterThan(0);
  });

  it('notches the envelope to zero at the dawn twilight boundary', async () => {
    const { track } = await glowAt(0.2013889 * 24);
    expect(track).toBeCloseTo(0, 5);
  });
});
