import * as THREE from 'three';
import DBC from '../../pipeline/dbc';
import { batchClassOf } from '../../pipeline/wmo/material/laws';
import { blendLights } from './blend';
import { LIGHT_FLOAT_BAND, LIGHT_PARAM } from './constants';
import { FogTriple, MfogRecord, packFogParams, selectWmoFogTarget, unpackFogParams, WmoFogRamp } from './fog';
import { sidnNightFraction } from './laws';
import SceneLight from './SceneLight';
import { SUN_PHI_TABLE, SUN_THETA_TABLE } from './sun-tables';
import { AreaLight, WeightedAreaLight } from './types';
import { getDayNightTime, interpolateNumericTable, selectLightsForPosition } from './utils';

// Default fog range, matching `SceneLightParams`'s own default -- only visible before the first
// `MapLight.update()` call has resolved anything real.
const DEFAULT_FOG_TRIPLE: FogTriple = { color: [0.25, 0.5, 0.8], start: 0, end: 577 };

// Farclip fallback for callers whose camera is not a THREE.PerspectiveCamera (so has no `.far`) --
// matches the scene fog's own default range, not an arbitrary guess.
const DEFAULT_FARCLIP = 577;

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

  // Debug-panel WMO brightness multiplier -- NOT part of the reference. 1.0 is faithful; see
  // WMOMaterial's fragment shader (applyWmoLighting) for why this exists at all: the INT lane's
  // law has no scene-light term to raise, so this is the only way to brighten a very dark bake.
  #wmoBrightness = 1.0;

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

  // The WMO the camera is standing in, for the debug readout. Null outdoors.
  #wmo: { name: string; groupIndex: number; ext: number; int: number; trans: number } | null = null;

  // The raw `location.wmo` (handler/root/group/views), for the fog resolver -- distinct from `#wmo`
  // above, which is a debug-readout summary, not something a resolver should be parsing back apart.
  #wmoLocation: any = null;

  // The camera position in WMO-local space (`location.camera.local`, already computed by
  // `LocationManager.addCandidates` while placing the camera), for the fog resolver's radius test.
  // MFOG positions/radii are WMO local space, same as MOLT (see `WMORootDefinition.createLights`).
  #wmoCameraLocal: THREE.Vector3 | null = null;

  // The camera-in-WMO interior fog crossfade. Held across frames so the fade-in/out ramps smoothly
  // rather than resetting whenever the camera crosses a portal.
  #fogRamp = new WmoFogRamp();

  // The interior fog triple last published -- `WmoFogRamp.blend`'s result, i.e. the scene fog already
  // crossfaded toward the camera's claimed WMO room fog (or the scene fog verbatim, outdoors or before
  // the ramp has engaged). Surfaced for tests and the next task's debug readout.
  #interiorFog: FogTriple = DEFAULT_FOG_TRIPLE;

  // Wall-clock fallback for callers that have not been plumbed with a real per-frame delta (none of
  // which sit on the live render path -- see `update`'s `dt` doc). Never used when a caller passes
  // `dt` explicitly.
  #lastFrameTime: number | null = null;

  // A blended band that no light contributed to stays at exactly zero.
  static #isUnset(color: THREE.Color) {
    return color.r + color.g + color.b < 0.001;
  }

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

  get wmo() {
    return this.#wmo;
  }

  /**
   * The camera-in-WMO interior fog crossfade's current result: the scene fog, blended toward the
   * camera's claimed room fog by `WmoFogRamp`. Equal to the scene fog outdoors or before the ramp has
   * ever engaged.
   */
  get interiorFog() {
    return this.#interiorFog;
  }

  /** The ramp's current blend weight (0 outdoors/settled-out, 1 fully faded into a room), for the
   * debug readout. */
  get fogRampWeight() {
    return this.#fogRamp.weight;
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

  get wmoBrightness() {
    return this.#wmoBrightness;
  }

  set wmoBrightness(value: number) {
    this.#wmoBrightness = Math.min(Math.max(value, 0), 4);
  }

  /**
   * `dt` is the real elapsed seconds since the previous frame -- `WorldMap.animate`'s `delta`
   * parameter, itself `THREE.Clock.getDelta()` (`pages/game/index.tsx`). It drives the four-second
   * interior-fog crossfade (`WmoFogRamp`), so a caller that hands back a fixed guess (e.g. 1/60)
   * makes that crossfade track frame rate instead of wall-clock time.
   *
   * Callers not yet plumbed with a real delta (the legacy, unwired `WDTManager` / `WDTManagerLite` /
   * `M2LightIntegration` / `WMOLightIntegration` integrations -- none sit on the live render path,
   * see `light/index.ts`'s re-exports vs. their lack of any `new` call site) omit `dt` entirely; this
   * falls back to measuring real wall-clock time between calls rather than assuming any fixed rate.
   */
  update(camera: THREE.Camera, dt?: number) {
    // Resolved before the light values are computed, since it decides which side they are read from.
    this.#trackCameraLocation(camera);

    // Only update if we have valid data
    if (this.#lights !== undefined) {
      this.#selectLights(camera.position);
      this.#updateTime();
      this.#updateSunDirection();
      this.#updateLights();
    }

    this.#updateInteriorFog(camera, this.#resolveDt(dt));

    super.update(camera);
  }

  /** See `update`'s doc for why this is a wall-clock measurement and not a fixed constant. */
  #resolveDt(dt: number | undefined): number {
    if (dt !== undefined) {
      return dt;
    }

    const now = performance.now();
    const delta = this.#lastFrameTime === null ? 0 : (now - this.#lastFrameTime) / 1000;
    this.#lastFrameTime = now;
    return delta;
  }

  /**
   * Follow the camera between the outside world and WMO interiors.
   *
   * LocationManager already works this out for portal culling and stores it on the camera earlier in
   * the frame, so this only has to read it. The colours themselves come from the light database
   * either way. WMO point lights are no longer selected here: each object picks its own nearest few
   * via `laws.selectPointLights` anchored at its own position, not the camera's.
   */
  #trackCameraLocation(camera: THREE.Camera) {
    const location = (camera as any).location;
    const interior = !!(location && location.type === 'interior');

    this.location = interior ? 'interior' : 'exterior';

    this.#wmo = interior ? MapLight.#describeWmo(location.wmo) : null;
    this.#wmoLocation = interior ? location.wmo : null;
    this.#wmoCameraLocal = interior ? location.camera.local : null;
  }

  /**
   * Resolve and publish the camera-in-WMO interior fog for this frame.
   *
   * Selection is the reference's `select_wmo_fog`
   * (`samples/benilla/crates/benilla/src/wmo_portal/fog.rs:52-90`, ported as `fog.ts`'s
   * `selectWmoFogTarget`): seeded from record 0, blending in a candidate from the camera's claimed
   * group's `fogOffsets` only when the WMO-local camera position falls inside that record's radius
   * band, weighted by proximity within the band, falling back to the seed outside every band. A
   * one-record root keeps the scene fog verbatim (the ref forge's "null fog" record shows the
   * storm's veil unmodified). Out-of-range offsets are skipped, not treated as "no fog for this
   * room".
   *
   * The RAW record is handed to `WmoFogRamp.blend`, never a pre-staged triple -- see `fog.ts`'s
   * `blend` doc for why re-staging every call (against the current farclip) is deliberate, not
   * redundant.
   */
  #updateInteriorFog(camera: THREE.Camera, dt: number) {
    const target = this.location === 'interior' && this.#wmoCameraLocal
      ? MapLight.#resolveWmoFogTarget(this.#wmoLocation, this.#wmoCameraLocal)
      : null;

    const farclip = (camera as THREE.PerspectiveCamera).far ?? DEFAULT_FARCLIP;

    const exterior = this.paramsFor('exterior');
    const { start, end } = unpackFogParams(exterior.fogParams.x, exterior.fogParams.y);
    const sceneTriple: FogTriple = {
      color: [exterior.fogColor.r, exterior.fogColor.g, exterior.fogColor.b],
      start,
      end,
    };

    this.#interiorFog = this.#fogRamp.blend(target, sceneTriple, farclip, dt);

    const [x, y, z, w] = packFogParams(this.#interiorFog.start, this.#interiorFog.end);
    const [r, g, b] = this.#interiorFog.color;

    for (const location of ['exterior', 'interior'] as const) {
      const params = this.paramsFor(location);
      params.wmoFogParams.set(x, y, z, w);
      params.wmoFogColor.setRGB(r, g, b);
    }
  }

  /**
   * The camera group's fog target, `null` if the camera is not standing in a WMO interior group, the
   * root carries fewer than two MFOG records, or no candidate from the group's `fogOffsets` falls
   * inside its own radius band. See `selectWmoFogTarget` (`fog.ts`) for the actual selection law --
   * this is only the glue that gathers the root's records, the group's offsets, and the WMO-local
   * camera position it needs.
   *
   * `wmoLocation` is `camera.location.wmo` (`{ handler, root, group, views }` -- see
   * `location-manager.js`). `group.fogOffsets` is read off the group instance directly
   * (`WMOGroup.fogOffsets`) with a `def` fallback, matching `#describeWmo`'s defensiveness about the
   * same two spots for `materialRefs`. `eyeLocal` is `location.camera.local`, already computed by
   * `LocationManager.addCandidates` while placing the camera in this same WMO.
   */
  static #resolveWmoFogTarget(wmoLocation: any, eyeLocal: THREE.Vector3): MfogRecord | null {
    const root = wmoLocation && wmoLocation.root;
    const group = wmoLocation && wmoLocation.group;
    const fogs = root && root.fogs;

    if (!group) {
      return null;
    }

    const offsets = group.fogOffsets || (group.def && group.def.fogOffsets);

    return selectWmoFogTarget(fogs, offsets, eyeLocal);
  }

  /**
   * Summarise the claimed WMO group for the debug readout: which building and group, and how its
   * batches split across the three lighting classes. The counts are the fastest way to tell a
   * misclassified group from a mis-lit one -- an interior room reporting all-ext batches is a
   * classification bug, not a shader bug.
   *
   * `materialRefs` is built on the group's loader definition (`WMOGroup.def.materialRefs`, see
   * `pipeline/wmo/group/loader/definition.js`), not copied onto the group instance itself -- the
   * group only forwards it once, into `createMaterial`. Both spots are checked so the readout keeps
   * working if that gets tidied up later; if neither is reachable, the counts fall back to zero
   * rather than plumbing a new path through the WMO manager.
   */
  static #describeWmo(wmo: any) {
    const group = wmo && wmo.group;
    if (!group) {
      return null;
    }
    const refs = group.materialRefs || (group.def && group.def.materialRefs) || [];
    const count = (cls: 'trans' | 'int' | 'ext') =>
      refs.filter((ref: any) => batchClassOf(ref.batchType) === cls).length;
    return {
      name: (wmo.handler && wmo.handler.filename) || (wmo.root && wmo.root.path) || 'unknown',
      groupIndex: group.index,
      trans: count('trans'),
      int: count('int'),
      ext: count('ext'),
    };
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

    // Fog is carried over from outside for THIS pair (`fogColor`/`fogParams`, consumed by M2
    // materials). The camera's own WMO room fog (MFOG) is a separate uniform pair --
    // `wmoFogColor`/`wmoFogParams`, consumed by WMO materials only -- resolved and crossfaded every
    // frame by `#updateInteriorFog`, not here.
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
