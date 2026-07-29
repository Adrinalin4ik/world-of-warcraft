import * as THREE from 'three';
import DBC from '../../pipeline/dbc';
import { blendLights } from './blend';
import { LIGHT_PARAM } from './constants';
import SceneLight from './SceneLight';
import { SUN_PHI_TABLE, SUN_THETA_TABLE } from './sun-tables';
import { AreaLight, WeightedAreaLight } from './types';
import { getDayNightTime, interpolateNumericTable, selectLightsForPosition } from './utils';

type MapLightOptions = {
  // Add any options needed for initialization
};

class MapLight extends SceneLight {
  // Area lights indexed by map id
  #lights: Record<number, AreaLight[]> = {};

  // Applicable area lights given current camera position
  #selectedLights: WeightedAreaLight[] = [];

  // Time in half-minutes since midnight (0 - 2879)
  #time = 0;

  // Overridden time in half-minutes since midnight (0 - 2879)
  #timeOverride: number | null = null;

  // Time as a floating point range from 0.0 to 1.0
  #timeProgression = 0.0;

  // Used to filter area lights into the set appropriate for the given map
  #mapId: number | undefined;

  // Camera reference for light calculations
  #camera: THREE.Camera | null = null;

  constructor(options: MapLightOptions = {}) {
    super();

    // Initialize with default values
    this.#lights = {};
    
    console.log('MapLight: Initializing with default lighting...');
    
    // Try to load lights, but don't fail if it doesn't work
    this.#loadLights().catch((error) => {
      console.warn('MapLight: Failed to load light DBC data, using default lighting:', error);
      this.#lights = {};
    });
  }

  get mapId() {
    return this.#mapId;
  }

  set mapId(mapId: number) {
    this.#mapId = mapId;
  }

  get time() {
    return this.#time;
  }

  get timeProgression() {
    return this.#timeProgression;
  }

  get isReady() {
    return this.#lights !== undefined;
  }

  get camera() {
    return this.#camera;
  }

  set camera(camera: THREE.Camera | null) {
    this.#camera = camera;
  }

  /**
   * Manually trigger light loading (useful for debugging or retry)
   */
  async loadLights() {
    await this.#loadLights();
  }

  get timeOverride() {
    return this.#timeOverride;
  }

  set timeOverride(override: number | null) {
    this.#timeOverride = override;
    this.#updateTime();
  }

  update(camera: THREE.Camera) {
    // Only update if we have valid data
    if (this.#lights !== undefined) {
      this.#selectLights(camera.position);
      this.#updateTime();
      this.#updateSunDirection();
      this.#updateLights();
    }

    super.update(camera);
  }

  #updateTime() {
    if (this.#timeOverride !== null) {
      this.#time = this.#timeOverride;
    } else {
      this.#time = getDayNightTime();
    }

    this.#timeProgression = this.#time / 2880;
  }

  #updateSunDirection() {
    // Get spherical coordinates
    const phi = interpolateNumericTable(SUN_PHI_TABLE, this.#timeProgression);
    const theta = interpolateNumericTable(SUN_THETA_TABLE, this.#timeProgression);

    // Convert from spherical coordinates to XYZ
    // x = rho * sin(phi) * cos(theta)
    // y = rho * sin(phi) * sin(theta)
    // z = rho * cos(phi)

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    const x = sinPhi * Math.cos(theta);
    const y = sinPhi * Math.sin(theta);
    const z = cosPhi;

    this.sunDir.set(x, y, z);
  }

  #updateLights() {
    if (!this.#selectedLights || this.#selectedLights.length === 0) {
      return;
    }

    const { sunDiffuseColor, sunAmbientColor, fogColor, fogParams } = blendLights(
      this.#selectedLights,
      LIGHT_PARAM.PARAM_STANDARD,
      this.#timeProgression,
    );

    this.sunDiffuseColor.copy(sunDiffuseColor);
    this.sunAmbientColor.copy(sunAmbientColor);
    this.fogColor.copy(fogColor);
    this.fogParams.copy(fogParams);
  }

  #selectLights(position: THREE.Vector3) {
    if (!this.#lights || this.#mapId === undefined || !this.#lights[this.#mapId]) {
      return;
    }

    this.#selectedLights = selectLightsForPosition(this.#lights[this.#mapId], position);
  }

  async #loadLights() {
    try {
      const lightDb = await DBC.load('Light');
      const lightParamsDb = await DBC.load('LightParams');
      const lightIntBandDb = await DBC.load('LightIntBand');
      const lightFloatBandDb = await DBC.load('LightFloatBand');

      // Check if all DBC data loaded successfully
      if (!lightDb || !lightParamsDb || !lightIntBandDb || !lightFloatBandDb) {
        console.warn('Some light DBC data failed to load, using empty light data');
        this.#lights = {};
        return;
      }

      // Check if records exist
      if (!lightDb.records || !lightParamsDb.records || !lightIntBandDb.records || !lightFloatBandDb.records) {
        console.warn('DBC records are undefined, using empty light data');
        this.#lights = {};
        return;
      }

      this.#lights = this.#getAreaLightsFromDb(lightDb, lightParamsDb, lightIntBandDb, lightFloatBandDb);
    } catch (error) {
      console.error('Error loading light databases:', error);
      this.#lights = {};
    }
  }

  #getAreaLightsFromDb(lightDb: any, lightParamsDb: any, lightIntBandDb: any, lightFloatBandDb: any): Record<number, AreaLight[]> {
    const lights: Record<number, AreaLight[]> = {};

    // Check if records exist and are iterable
    if (!lightDb.records || !Array.isArray(lightDb.records)) {
      console.warn('Light DB records are not available or not an array');
      return lights;
    }

    // Group lights by map ID
    for (const lightRecord of lightDb.records) {
      // Skip invalid records
      if (!lightRecord || typeof lightRecord !== 'object') {
        continue;
      }
      const mapId = lightRecord.mapID;
      
      if (!lights[mapId]) {
        lights[mapId] = [];
      }

      // Convert position from WoW coordinates to world coordinates
      const worldPosition = new THREE.Vector3(
        17066.666 - (lightRecord.position.z / 36.0),
        17066.666 - (lightRecord.position.x / 36.0),
        lightRecord.position.y / 36.0
      );

      // Get light parameters
      const lightParams = lightParamsDb[lightRecord.skyFogID];
      
      // Get color bands
      const intBands = [];
      const floatBands = [];
      
      // Process integer bands (colors)
      for (let i = 0; i < 18; i++) {
        const bandId = (lightRecord.skyFogID * 18) - 17 + i;
        if (lightIntBandDb[bandId]) {
          intBands.push(this.#processIntBand(lightIntBandDb[bandId]));
        }
      }

      // Process float bands
      for (let i = 0; i < 6; i++) {
        const bandId = (lightRecord.skyFogID * 6) - 5 + i;
        if (lightFloatBandDb[bandId]) {
          floatBands.push(this.#processFloatBand(lightFloatBandDb[bandId]));
        }
      }

      const areaLight: AreaLight = {
        id: lightRecord.id,
        mapId: lightRecord.mapID,
        position: worldPosition,
        falloffStart: lightRecord.fallOffStart,
        falloffEnd: lightRecord.fallOffEnd,
        params: [{
          id: lightRecord.skyFogID,
          intBands,
          floatBands
        }]
      };

      lights[mapId].push(areaLight);
    }

    return lights;
  }

  #processIntBand(bandRecord: any): any[] {
    const table = [];
    
    // Check if bandRecord is valid
    if (!bandRecord || typeof bandRecord !== 'object') {
      return table;
    }
    
    // Check if required properties exist
    if (!bandRecord.entryCount || !bandRecord.times || !bandRecord.values) {
      return table;
    }
    
    // Check if arrays have enough elements
    if (bandRecord.times.length < bandRecord.entryCount || bandRecord.values.length < bandRecord.entryCount) {
      console.warn('Band record has insufficient data, skipping');
      return table;
    }
    
    for (let i = 0; i < bandRecord.entryCount; i++) {
      table.push(bandRecord.times[i] / 2880.0); // Convert to 0-1 range
      table.push(this.#bgraIntegerToRGBAVector(bandRecord.values[i]));
    }
    return table;
  }

  #processFloatBand(bandRecord: any): any[] {
    const table = [];
    
    // Check if bandRecord is valid
    if (!bandRecord || typeof bandRecord !== 'object') {
      return table;
    }
    
    // Check if required properties exist
    if (!bandRecord.entryCount || !bandRecord.times || !bandRecord.values) {
      return table;
    }
    
    // Check if arrays have enough elements
    if (bandRecord.times.length < bandRecord.entryCount || bandRecord.values.length < bandRecord.entryCount) {
      console.warn('Float band record has insufficient data, skipping');
      return table;
    }
    
    for (let i = 0; i < bandRecord.entryCount; i++) {
      table.push(bandRecord.times[i] / 2880.0); // Convert to 0-1 range
      table.push(bandRecord.values[i]);
    }
    return table;
  }

  #bgraIntegerToRGBAVector(value: number): number[] {
    const v = [];
    v[0] = (value >> 16) & 0xFF;
    v[1] = (value >> 8) & 0xFF;
    v[2] = (value >> 0) & 0xFF;
    v[3] = (value >> 24) & 0xFF;
    return v;
  }
}

export default MapLight;
