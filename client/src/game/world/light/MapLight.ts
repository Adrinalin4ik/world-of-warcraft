import * as THREE from 'three';
import DBC from '../../pipeline/dbc';
import { blendLights } from './blend';
import { LIGHT_FLOAT_BAND, LIGHT_PARAM } from './constants';
import { sidnNightFraction } from './laws';
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

  // The world position the area-light blend was last sampled at -- the camera eye, not the player.
  // Surfaced for the debug readout: it and the map id decide every colour below them, and neither is
  // otherwise visible.
  #sampledPosition: THREE.Vector3 | null = null;

  // Must match MAX_WMO_LIGHTS in the M2 fragment shader.
  static MAX_WMO_POINT_LIGHTS = 4;

  // A blended band that no light contributed to stays at exactly zero.
  static #isUnset(color: THREE.Color) {
    return color.r + color.g + color.b < 0.001;
  }

  /**
   * WMO point lights (MOLT) nearest the camera, in world space, refreshed each frame.
   *
   * Selected relative to the camera rather than per doodad because M2 materials are shared between
   * instances of a model -- one material can back hundreds of meshes spread across a building, so
   * there is nowhere to hang a per-doodad set. Interiors are small enough that what is near the
   * camera is near the props around it, and every material can safely share the one selection.
   */
  wmoPointLights: any[] = [];

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

  get selectedLights() {
    return this.#selectedLights;
  }

  get sampledPosition() {
    return this.#sampledPosition;
  }

  /**
   * The SIDN self-illumination night fraction for the current time -- 1 overnight, 0 by day. WMO
   * window materials multiply their authored emissive colour by this (consumed from plan 2 onward).
   */
  get sidnNight() {
    return sidnNightFraction(this.#time / 2);
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
    // Resolved before the light values are computed, since it decides which side they are read from.
    this.#trackCameraLocation(camera);

    // Only update if we have valid data
    if (this.#lights !== undefined) {
      this.#selectLights(camera.position);
      this.#updateTime();
      this.#updateSunDirection();
      this.#updateLights();
    }

    super.update(camera);
  }

  /**
   * Follow the camera between the outside world and WMO interiors.
   *
   * LocationManager already works this out for portal culling and stores it on the camera earlier in
   * the frame, so this only has to read it. The colours themselves come from the light database
   * either way; only the WMO point light selection below differs by side.
   */
  #trackCameraLocation(camera: THREE.Camera) {
    const location = (camera as any).location;
    const interior = !!(location && location.type === 'interior');

    this.location = interior ? 'interior' : 'exterior';

    this.#selectWmoPointLights(interior ? location.wmo : null, camera);
  }

  /**
   * Pick the closest few of the current WMO's point lights.
   *
   * Cleared when outside, which leaves every material with a light count of zero and skips the loop
   * in the shader entirely.
   */
  #selectWmoPointLights(wmo: any, camera: THREE.Camera) {
    const selected = this.wmoPointLights;
    selected.length = 0;

    const lights = wmo && this.#worldSpaceLightsFor(wmo);
    if (!lights || lights.length === 0) {
      return;
    }

    const candidates = [];

    for (const light of lights) {
      const distance = camera.position.distanceTo(light.position);

      // Beyond its own falloff, so it cannot contribute wherever the camera is standing.
      if (distance > light.attenEnd) {
        continue;
      }

      // Ranked by how much the light would actually add, not by raw distance. Sorting on distance
      // alone let a close but nearly spent light displace a brighter one, and meant a light entering
      // the top few arrived at full strength instead of easing in. Matching the shader's own falloff
      // means whatever drops off the end was contributing close to nothing.
      const span = Math.max(light.attenEnd - light.attenStart, 0.001);
      const falloff = 1.0 - Math.min(Math.max((distance - light.attenStart) / span, 0), 1);

      candidates.push({ light, score: falloff * light.intensity });
    }

    candidates.sort((first, second) => second.score - first.score);

    const limit = Math.min(candidates.length, MapLight.MAX_WMO_POINT_LIGHTS);
    for (let index = 0; index < limit; ++index) {
      selected.push(candidates[index].light);
    }
  }

  /**
   * MOLT lights converted to world space, cached on the WMO.
   *
   * MOLT stores positions in WMO local space. A WMO never moves once placed, so the conversion is
   * done once rather than re-running 200-odd matrix transforms every frame.
   */
  #worldSpaceLightsFor(wmo: any) {
    if (!wmo.root || !wmo.root.lights || !wmo.views || !wmo.views.root) {
      return null;
    }

    if (!wmo.worldSpaceLights) {
      const root = wmo.views.root;
      root.updateMatrixWorld(true);

      wmo.worldSpaceLights = wmo.root.lights.map((light) => ({
        position: root.localToWorld(
          new THREE.Vector3(light.position.x, light.position.y, light.position.z)
        ),
        color: light.color,
        intensity: light.intensity,
        attenStart: light.attenStart,
        attenEnd: light.attenEnd
      }));
    }

    return wmo.worldSpaceLights;
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

    // Not negated. The phi/theta tables above are the client's own (DayNight::SetDirection), and with
    // them cosPhi is negative all day, so this already points from the sun down onto the world -- the
    // direction light travels, which is what consumers assume when they compute `dot(normal, -dir)`.
    //
    // A negation was tried here and is wrong: it turns the vector upward, so an upward-facing ground
    // normal produces a negative dot, clamps to zero, and terrain loses its directional sun entirely.
    //
    // Written to both locations: `this.sunDir` only reaches the active one, which would leave the
    // other holding a stale direction the moment the camera moves indoors or back out.
    this.paramsFor('exterior').sunDir.set(x, y, z);
    this.paramsFor('interior').sunDir.set(x, y, z);
  }

  #updateLights() {
    if (!this.#selectedLights || this.#selectedLights.length === 0) {
      return;
    }

    const {
      sunDiffuseColor,
      sunAmbientColor,
      fogColor,
      fogParams,
      riverCloseColor,
      oceanCloseColor
    } = blendLights(
      this.#selectedLights,
      LIGHT_PARAM.PARAM_STANDARD,
      this.#timeProgression,
    );

    // Both sides get the same values. `location` selects which params object the getters return, so
    // any difference between the two would show up as a hard step the frame the camera crosses a
    // portal. Whether a roof blocks the sun is expressed by the WMO's own batch classes (the INT/
    // TRANS bakes), not by varying these params between interior and exterior.
    for (const location of ['exterior', 'interior'] as const) {
      const params = this.paramsFor(location);

      // Ambient and fog come from the light database either way -- Light.dbc has records inside
      // indoor zones, so the blended value already describes wherever the camera is standing.
      params.sunAmbientColor.copy(sunAmbientColor);
      params.fogColor.copy(fogColor);
      params.fogParams.copy(fogParams);

      // Water tints, likewise straight from the database and varying with time of day.
      //
      // River and ocean bands are optional and plenty of lights omit them, in which case the blend
      // stays at zero and water would render black. The sky fog colour stands in: it is always
      // present, comes from the same light record, and tracks the hour the same way.
      params.riverCloseColor.copy(MapLight.#isUnset(riverCloseColor) ? fogColor : riverCloseColor);
      params.oceanCloseColor.copy(MapLight.#isUnset(oceanCloseColor) ? fogColor : oceanCloseColor);

      // Direct sun, same as outside -- the reference does not zero this indoors either.
      params.sunDiffuseColor.copy(sunDiffuseColor);
    }

    // Interior ambient comes from the light database, not from the WMO. Light.dbc carries records
    // positioned inside indoor zones -- standing in Ironforge selects light id 16 -- so the blended
    // value already describes the interior, and it is what varies correctly with time of day. The
    // building's own MOHD ambient was tried here first and is near-black for these WMOs (14,5,5 for
    // the Ironforge gate), which left every doodad indoors unlit.
    const interior = this.paramsFor('interior');
    interior.sunAmbientColor.copy(sunAmbientColor);

    // Fog is carried over from outside. WMO groups do define their own fog, but it is not parsed
    // yet, and reusing the outdoor values is closer than the constructor defaults this side used to
    // keep (a fixed blue at a 577 unit range).
    interior.fogColor.copy(fogColor);
    interior.fogParams.copy(fogParams);
  }

  #selectLights(position: THREE.Vector3) {
    this.#sampledPosition = position;

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
      // Assigned by index rather than appended: consumers look bands up by their LIGHT_INT_BAND /
      // LIGHT_FLOAT_BAND position, so a single missing record would otherwise shift every band after
      // it and silently pair the wrong colour with the wrong slot.
      for (let i = 0; i < 18; i++) {
        const bandId = (lightRecord.skyFogID * 18) - 17 + i;
        if (lightIntBandDb[bandId]) {
          intBands[i] = this.#processIntBand(lightIntBandDb[bandId]);
        }
      }

      // Process float bands
      for (let i = 0; i < 6; i++) {
        const bandId = (lightRecord.skyFogID * 6) - 5 + i;
        if (lightFloatBandDb[bandId]) {
          floatBands[i] = this.#processFloatBand(lightFloatBandDb[bandId], i);
        }
      }

      const areaLight: AreaLight = {
        id: lightRecord.id,
        mapId: lightRecord.mapID,
        position: worldPosition,
        // Scaled by 36 like the position above: Light.dbc stores distances in its own coordinate
        // system. Left raw, the radii came out map-sized (a typical light reached ~16000 units), so
        // every light in the zone contained the camera outright, falloff evaluated to zero for all of
        // them and the nearest one claimed the entire weight. Two lights a metre apart in distance
        // then swapped rank on the smallest movement and the whole scene's ambient and fog colour
        // changed with them.
        falloffStart: lightRecord.fallOffStart / 36.0,
        falloffEnd: lightRecord.fallOffEnd / 36.0,
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
      table.push(this.#bgraIntegerToColor(bandRecord.values[i]));
    }
    return table;
  }

  #processFloatBand(bandRecord: any, band: number): any[] {
    // Fog distances share the light coordinate system and need the same 36 scale as the positions and
    // falloff radii. Without it fog ended ~29000 units out, far past any view distance, so no
    // geometry ever reached a non-zero fog factor. The start scalar is a ratio, so it stays as is.
    const scale = band === LIGHT_FLOAT_BAND.BAND_FOG_END ? 1.0 / 36.0 : 1.0;

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
      table.push(bandRecord.values[i] * scale);
    }
    return table;
  }

  /**
   * Unpack a light band's BGRA integer into a color.
   *
   * Must return a THREE.Color, not a plain array: these values end up in the int band tables that
   * `interpolateColorTable` feeds to `THREE.Color.lerpColors`, which reads `.r`/`.g`/`.b` off its
   * operands. A plain array has none of those, so the lerp evaluates to NaN and every lit surface
   * multiplies its texture by NaN and renders black. Components are normalized to 0-1 for the same
   * reason — THREE.Color is unit-scaled, not 0-255.
   */
  #bgraIntegerToColor(value: number): THREE.Color {
    return new THREE.Color(
      ((value >> 16) & 0xFF) / 255,
      ((value >> 8) & 0xFF) / 255,
      ((value >> 0) & 0xFF) / 255,
    );
  }
}

export default MapLight;
