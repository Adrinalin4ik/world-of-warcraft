import * as THREE from 'three';
import DBC from '../../pipeline/dbc';
import { batchClassOf } from '../../pipeline/wmo/material/laws';
import { blendLights } from './blend';
import { LIGHT_FLOAT_BAND, LIGHT_PARAM, LIGHT_PARAM_LABELS } from './constants';
import { FogTriple, MfogRecord, packFogParams, selectWmoFogTarget, unpackFogParams, WmoFogRamp } from './fog';
import { quantizeGlow, sidnNightFraction, skyWarp, stormBlend } from './laws';
import SceneLight from './SceneLight';
import { SUN_PHI_TABLE, SUN_THETA_TABLE } from './sun-tables';
import { AreaLight, AreaLightParams, WeightedAreaLight } from './types';
import { getDayNightTime, interpolateNumericTable, selectLightsForPosition } from './utils';
import { WeatherState } from './weather';

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

  // The `LightFloatBand` DBC table, kept around ONLY for `dumpLightSlotBands` (diagnostic 1's
  // on-demand console sweep) -- `#getAreaLightsFromDb` already reads it once at load time to build
  // each loaded slot's `floatBands`, but that pass discards the table itself. Null until
  // `#loadLights` resolves, or if it failed.
  #lightFloatBandDb: any = null;

  // The loaded WMOManager, for the near-camera WMO-group survey (diagnostic 2). Set externally
  // (`WorldMap.setupLightSystem`) rather than constructed here -- MapLight has no reason to know how
  // WMOs are loaded, only where to find the ones that already are. Null until wired up, or on a map
  // with no WMOs at all.
  #wmoManager: any = null;

  // The nearest few loaded WMO groups to the camera, regardless of which one (if any) claims it --
  // see `#collectNearbyWmoGroups`'s doc comment for why this exists alongside `#wmo` above.
  #nearbyWmoGroups: Array<{
    entryId: string;
    name: string;
    groupIndex: number;
    flags: number;
    lightingInterior: boolean;
    distance: number;
    ext: number;
    int: number;
    trans: number;
  }> = [];

  // The resolved (blended) `LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR`, before it is multiplied by
  // `#rawFogEnd`'s scaled counterpart to produce `fogStart`. Debug-readout-only -- see
  // `lighting-readouts.tsx`'s doc comment on the field it feeds.
  #fogStartScalar = 0;

  // The resolved `LIGHT_FLOAT_BAND.BAND_FOG_END`, before `#processFloatBand`'s `1/36` unit
  // conversion. Debug-readout-only, same reasoning as `#fogStartScalar` above.
  #rawFogEnd = DEFAULT_FOG_TRIPLE.end * 36;

  // Wall-clock fallback for callers that have not been plumbed with a real per-frame delta (none of
  // which sit on the live render path -- see `update`'s `dt` doc). Never used when a caller passes
  // `dt` explicitly.
  #lastFrameTime: number | null = null;

  // The zone weather state machine (Task 2) -- driven from the debug UI for now, ticked from the same
  // per-frame `dt` that drives the interior fog crossfade below. NOT a second timing source: see
  // `update`'s doc for why `#resolveDt` is called exactly once per frame and its result handed to
  // both this and `#updateInteriorFog`.
  #weather = new WeatherState();

  // The resolved (weighted-mean) per-zone bloom weight, before `laws.quantizeGlow`'s byte quantization
  // -- see `blendLights`' `glow` doc comment. `0.5` matches its own no-data default. Task 4: nothing
  // consumes the quantized value yet (there is no bloom pass in this client) -- publishing it off the
  // `glow` getter below IS the task; see this file's doc history / the task report.
  #glow = 0.5;

  // The resolved (weighted-mean) dawn/dusk warp gate, 0..1 -- see `blendLights`' `highlightSky` doc
  // comment. A continuous weighted mean rather than a hard boolean pick, so a zone boundary between a
  // highlightSky=1 and a highlightSky=0 light fades the warp rather than stepping it.
  #highlightSky = 0;

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
   * The nearest few loaded WMO groups to the camera (diagnostic 2), regardless of which one -- if
   * any -- claims it. See `#collectNearbyWmoGroups`'s doc comment for why this exists alongside
   * `#wmo`: that field only ever describes the group the camera is standing IN, which is empty
   * outdoors even when a badly-lit building is right in front of the camera.
   */
  get nearbyWmoGroups() {
    return this.#nearbyWmoGroups;
  }

  /**
   * Wired up externally (`WorldMap.setupLightSystem`) once the map's `WMOManager` exists.
   * `WMOManager` already takes a `MapLight` the other way (`setMapLight`, for shading); this is the
   * reverse link, used only to walk `entries` for the debug readout above -- not for anything that
   * feeds a lighting or fog computation.
   */
  set wmoManager(wmoManager: any) {
    this.#wmoManager = wmoManager;
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
   * The resolved `LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR`, before it is multiplied by `fogEnd` to
   * produce `fogStart` (`SceneLight#fogStart`). Debug-readout-only -- see `lighting-readouts.tsx`'s
   * doc comment on the field it feeds.
   */
  get fogStartScalar() {
    return this.#fogStartScalar;
  }

  /**
   * The resolved `LIGHT_FLOAT_BAND.BAND_FOG_END`, before `#processFloatBand`'s `1/36` unit conversion
   * -- i.e. the same quantity `fogEnd` (`SceneLight#fogEnd`) reports, but unscaled. Debug-readout-only:
   * printing both side by side is what lets a misplaced (or doubled) scale be spotted by inspection.
   */
  get rawFogEnd() {
    return this.#rawFogEnd;
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
   * The zone weather state (Task 2's `WeatherState`) -- exposed so the debug panel can call
   * `setWeather` directly and read both ramped channels for its live readout. `setWeather`'s own
   * signature is the wire's (`kind`, `grade`, `instant`), so the network path can drive this the same
   * way once it exists.
   */
  get weather() {
    return this.#weather;
  }

  /**
   * The storm `LightParams` blend weight `laws.stormBlend` resolves from the weather state's sky
   * channel -- what `#updateLights` actually lerps every light's stormy slot in by. Surfaced
   * separately from `#weather` itself so the debug readout can show the resolved weight beside the
   * two raw channels that produce it.
   */
  get stormBlend() {
    return stormBlend(this.#weather.skyDensity);
  }

  /**
   * The per-zone bloom weight, quantized to the byte the reference packs
   * (`laws.quantizeGlow`) -- see `#glow`'s doc comment. Task 4: nothing in this client consumes
   * this yet, there is no bloom pass -- publishing it is the task itself.
   */
  get glow() {
    return quantizeGlow(this.#glow);
  }

  /**
   * The dawn/dusk sky-dome warp strength `S` (`laws.skyWarp`) at the current time-of-day and the
   * resolved (weighted-mean) `highlightSky` gate. 0 across all of midday and deep night, and 0 at
   * every hour when the selected lights' `highlightSky` is entirely 0 (e.g. Duskwood) -- see
   * `laws.skyWarp`'s own doc for why that identity case matters more than the dusk warp itself.
   */
  get skyWarp() {
    return skyWarp(this.#time / 2, this.#highlightSky);
  }

  /**
   * The sun's own compass bearing in this client's Z-up horizontal plane (`atan2(y, x)` of the
   * TOWARD-the-sun direction) -- the dome shader's azimuth reference for the dawn/dusk warp
   * (`laws.applySkyAzimuthWarp`). `sunDir` (`SceneLight`) points the OTHER way -- the direction light
   * travels, sun down onto the world (see `#updateSunDirection`'s own doc) -- so this negates it
   * before taking the bearing.
   */
  get sunAzimuth() {
    const dir = this.sunDir;
    return Math.atan2(-dir.y, -dir.x);
  }

  /**
   * Manually trigger light loading (useful for debugging or retry)
   */
  async loadLights() {
    await this.#loadLights();
  }

  /**
   * One-shot console sweep for diagnostic 1 ("which LightParams slot are we actually reading?") --
   * deliberately NOT run every frame (the task's own constraint against adding another per-frame log
   * to an already-busy console). Wired to a debug-panel button, not a lifecycle hook.
   *
   * For each currently selected light, and each of its eight Light.dbc slots (`AreaLight.lightSlots`)
   * that is non-zero, recomputes BAND_FOG_END and BAND_FOG_START_SCALAR from THAT SLOT's own id --
   * `(slotId * 6) - 5 + i`, the exact formula `#getAreaLightsFromDb` already uses, just run against
   * every candidate slot instead of always `paramsStandard` (slot 0). Slot 0's row in the printed
   * table is always the one actually feeding `fogStart`/`fogEnd` every frame (see
   * `#getAreaLightsFromDb`/`#updateLights`, which blend `LIGHT_PARAM.PARAM_STANDARD` only -- the other
   * slots are now loaded but nothing consumes them yet) -- comparing it against the other seven
   * settles the question directly: if a DIFFERENT slot reads the storm-like scalar, slot selection is
   * wrong; if slot 0 itself already does, the zone's own data authors it.
   *
   * Read-only: this recomputes the same bands `#getAreaLightsFromDb`/`blendLights` already produce
   * for slot 0, against additional slots, entirely for inspection. It does not write anything back
   * into `#lights`, `#selectedLights`, or any fog/lighting uniform.
   */
  dumpLightSlotBands() {
    if (!this.#lightFloatBandDb) {
      console.warn('MapLight#dumpLightSlotBands: LightFloatBand DBC not loaded (yet)');
      return;
    }

    if (this.#selectedLights.length === 0) {
      console.warn('MapLight#dumpLightSlotBands: no selected lights to sweep');
      return;
    }

    const SLOT_LABELS = LIGHT_PARAM_LABELS;

    const rows: Array<{
      lightId: number;
      slotIndex: number;
      slot: string;
      slotId: number;
      loadedSlot: boolean;
      fogEndRaw: number | '-';
      fogEndScaled: number | '-';
      fogStartScalar: number | '-';
    }> = [];

    for (const { light } of this.#selectedLights) {
      const slots = light.lightSlots || [];

      slots.forEach((slotId, slotIndex) => {
        // Slot 0 (paramsStandard) is always non-zero in practice (every Light.dbc record names a standard
        // params row), but the other seven frequently are not -- a light with no water/sunset/death
        // override just repeats slot 0's id or reads 0. Per the task: EVERY non-zero slot, not every
        // slot.
        if (!slotId) {
          return;
        }

        const fogEndBandId = (slotId * 6) - 5 + LIGHT_FLOAT_BAND.BAND_FOG_END;
        const fogStartScalarBandId = (slotId * 6) - 5 + LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR;

        const fogEndRecord = this.#lightFloatBandDb[fogEndBandId];
        const fogStartScalarRecord = this.#lightFloatBandDb[fogStartScalarBandId];

        const fogEndRaw = fogEndRecord
          ? interpolateNumericTable(
              this.#processFloatBand(fogEndRecord, LIGHT_FLOAT_BAND.BAND_FOG_END, true),
              this.#timeProgression,
            )
          : '-';

        const fogEndScaled = fogEndRecord
          ? interpolateNumericTable(
              this.#processFloatBand(fogEndRecord, LIGHT_FLOAT_BAND.BAND_FOG_END, false),
              this.#timeProgression,
            )
          : '-';

        const fogStartScalar = fogStartScalarRecord
          ? interpolateNumericTable(
              this.#processFloatBand(fogStartScalarRecord, LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR, false),
              this.#timeProgression,
            )
          : '-';

        rows.push({
          lightId: light.id,
          slotIndex,
          slot: SLOT_LABELS[slotIndex] ?? `slot${slotIndex}`,
          slotId,
          loadedSlot: slotIndex === 0,
          fogEndRaw,
          fogEndScaled,
          fogStartScalar,
        });
      });
    }

    console.log('MapLight: per-slot fog band sweep (diagnostic 1) -- "loadedSlot" marks the row that actually feeds fogStart/fogEnd every frame');
    console.table(rows);
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

    // Resolved exactly ONCE per frame and handed to every per-frame-delta consumer below (the interior
    // fog crossfade AND the weather ramp) -- this project has already shipped a duplicated per-frame
    // `MapLight.update()` that halved a crossfade rate by measuring `dt` twice, and calling
    // `#resolveDt` a second time here would be the same bug again.
    const resolvedDt = this.#resolveDt(dt);
    this.#weather.tick(resolvedDt);

    // Only update if we have valid data
    if (this.#lights !== undefined) {
      this.#selectLights(camera.position);
      this.#updateTime();
      this.#updateSunDirection();
      this.#updateLights();
    }

    this.#updateInteriorFog(camera, resolvedDt);

    // Debug-readout-only (diagnostic 2). Independent of `#trackCameraLocation`/`#wmo` above: this
    // walks EVERY loaded WMO group near the camera, not only the one (if any) that claims it, so a
    // building the camera is standing outside of still shows up here.
    this.#nearbyWmoGroups = MapLight.#collectNearbyWmoGroups(this.#wmoManager, camera.position);

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

  /**
   * The nearest few loaded WMO groups to `position`, walked from `WMOManager.entries` -- NOT via a
   * raycast, per the task's own instruction: the manager already holds every loaded group, and
   * raycasting would only find whatever surface is directly under the cursor, not "what building is
   * this dark silhouette".
   *
   * Exists to settle (not assume) a specific hypothesis: `isLightingInterior` (`laws.ts`) is
   * `(flags & 0x48) === 0`, which reads true for a group with NO flags set at all, not only for one
   * that explicitly declares itself interior. An exterior group whose MOGP flags happen to carry
   * neither `EXTERIOR` (0x8) nor `EXTERIOR_LIT` (0x40) would be misclassified as interior, take the
   * bake-only INT law, and render black if its vertex bake is dark -- exactly the black-silhouette
   * symptom this diagnostic exists for. Printing the raw flags in hex beside the resolved
   * `lightingInterior` is what tells "flags say exterior" apart from "flags are zero" at a glance.
   *
   * Every loaded WMO's every loaded group is a candidate (not just the one MOGI marks `interior`, and
   * not just the WMO nearest the camera) because the whole point is to catch a group the existing
   * camera-claimed readout (`#describeWmo`/`#wmo`) cannot see: the camera is OUTSIDE the building in
   * the reported bug, so it claims no group at all.
   *
   * A group's world position is its local bounding-box centre transformed by its owning WMO's root
   * view matrix -- `WMOGroupView` (group/view.js) is added as a child of `views.root` at the identity
   * transform, so the geometry (and therefore the bounding box) is already expressed in the root's
   * local space, and `views.root.matrixWorld` alone places it in the world. `updateMatrixWorld` is
   * not called here: `WMOManager.placeWMOView`/`WMO.placeGroupView` already called it once when each
   * view was placed, and neither the WMO nor the camera moves after that, so it stays current.
   */
  static #collectNearbyWmoGroups(wmoManager: any, position: THREE.Vector3, limit = 5) {
    if (!wmoManager || !wmoManager.entries) {
      return [];
    }

    const center = new THREE.Vector3();
    const results: Array<{
      entryId: string;
      name: string;
      groupIndex: number;
      flags: number;
      lightingInterior: boolean;
      distance: number;
      ext: number;
      int: number;
      trans: number;
    }> = [];

    // Iterate with the Map KEY, not just the value: the key is the placement's id, and it is the only
    // thing that distinguishes two placements of the same WMO file. Keying a rendered row on
    // name + groupIndex alone collides across placements, and React then duplicates or omits rows.
    for (const [entryId, wmo] of wmoManager.entries.entries()) {
      if (!wmo.views || !wmo.views.root || !wmo.groups) {
        continue;
      }

      for (const group of wmo.groups.values()) {
        if (!group.boundingBox) {
          continue;
        }

        group.boundingBox.getCenter(center);
        center.applyMatrix4(wmo.views.root.matrixWorld);

        const refs = group.materialRefs || (group.def && group.def.materialRefs) || [];
        const count = (cls: 'trans' | 'int' | 'ext') =>
          refs.filter((ref: any) => batchClassOf(ref.batchType) === cls).length;

        results.push({
          entryId: String(entryId),
          name: wmo.filename || 'unknown',
          groupIndex: group.index,
          flags: (group.header && group.header.flags) ?? 0,
          lightingInterior: !!group.lightingInterior,
          distance: center.distanceTo(position),
          ext: count('ext'),
          int: count('int'),
          trans: count('trans'),
        });
      }
    }

    results.sort((a, b) => a.distance - b.distance);

    return results.slice(0, limit);
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
    // `selectLightsForPosition` now always seeds a resolve from the map's seed light (see utils.ts's
    // `findSeedLight` -- chosen once from the data, never from the camera) whenever the map has ANY
    // light data at all, so an empty selection here means there are no light records for this map
    // whatsoever -- not merely "nothing currently in range". Bailing out used to freeze the previous
    // frame's colours until a light came back into range, then
    // snap; resolving to a documented neutral fallback every frame instead avoids both the freeze and
    // the snap.
    if (!this.#selectedLights || this.#selectedLights.length === 0) {
      this.#applyFallbackLights();
      return;
    }

    const {
      sunDiffuseColor,
      sunAmbientColor,
      fogColor,
      fogParams,
      riverCloseColor,
      oceanCloseColor,
      fogStartScalar,
      rawFogEnd,
      skyTopColor,
      skyMiddleColor,
      skyBand1Color,
      skyBand2Color,
      skySmogColor,
      glow,
      highlightSky,
    } = blendLights(
      this.#selectedLights,
      LIGHT_PARAM.PARAM_STANDARD,
      this.#timeProgression,
      this.stormBlend,
    );

    // Debug-readout-only (see the getters' doc comments) -- resolved alongside the packed `fogParams`
    // above rather than re-derived from it, since the whole point is to compare the two independently.
    this.#fogStartScalar = fogStartScalar;
    this.#rawFogEnd = rawFogEnd;

    // Task 4: the per-zone glow weight and the dawn/dusk warp gate -- see `#glow`/`#highlightSky`'s
    // doc comments and the `glow`/`skyWarp` getters that publish them.
    this.#glow = glow;
    this.#highlightSky = highlightSky;

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

      // The five sky-dome gradient stops (Task 4). Only `exterior` is ever actually read by the sky
      // dome (there is no sky indoors), but both sides get them for the same reason as everything
      // else in this loop: consistency, and no seam if a future consumer reads the interior side.
      params.skyTopColor.copy(skyTopColor);
      params.skyMiddleColor.copy(skyMiddleColor);
      params.skyBand1Color.copy(skyBand1Color);
      params.skyBand2Color.copy(skyBand2Color);
      params.skySmogColor.copy(skySmogColor);
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

  /**
   * Neutral, documented resolve for a map with no light records at all -- distinct from "nothing
   * currently in range", which `selectLightsForPosition` now always seeds from the map's seed light
   * (`findSeedLight` in utils.ts) instead of leaving empty. Written to every param every frame (not
   * cached or applied once) so it reads as a steady value rather than whatever the params happened to
   * hold before this map was selected.
   *
   * Values match `DEFAULT_FOG_TRIPLE`/`SceneLightParams`'s own pre-resolve defaults: a mid-grey
   * ambient, full-white direct sun, and the same fog colour/range used before the first real
   * `update()` call resolves anything.
   */
  #applyFallbackLights() {
    const [x, y, z, w] = packFogParams(DEFAULT_FOG_TRIPLE.start, DEFAULT_FOG_TRIPLE.end);
    const [r, g, b] = DEFAULT_FOG_TRIPLE.color;

    for (const location of ['exterior', 'interior'] as const) {
      const params = this.paramsFor(location);

      params.sunAmbientColor.setRGB(0.5, 0.5, 0.5);
      params.sunDiffuseColor.setRGB(1, 1, 1);
      params.fogColor.setRGB(r, g, b);
      params.fogParams.set(x, y, z, w);
      params.riverCloseColor.setRGB(r, g, b);
      params.oceanCloseColor.setRGB(r, g, b);

      // Sky bands (Task 4) follow the same neutral-fallback convention as river/ocean above -- this
      // is the documented "no light records for this map at all" resolve, already a plausible default
      // for everything else it touches, so the sky bands match it rather than standing out on their
      // own. (The DELIBERATELY obvious fallback the brief asks for lives one level up, in
      // `ProceduralSky`'s own handling of "no `MapLight` reference (yet)" -- a different, earlier
      // failure than "this map's DBC data resolved to nothing".)
      params.skyTopColor.setRGB(r, g, b);
      params.skyMiddleColor.setRGB(r, g, b);
      params.skyBand1Color.setRGB(r, g, b);
      params.skyBand2Color.setRGB(r, g, b);
      params.skySmogColor.setRGB(r, g, b);
    }

    // Debug-readout-only. `DEFAULT_FOG_TRIPLE.start` is 0, so the scalar is 0 regardless of `end`;
    // `#rawFogEnd` is reconstructed by inverting `#processFloatBand`'s `1/36` scale, since there is no
    // real band to read raw here at all -- this is the no-light-data fallback.
    this.#fogStartScalar = 0;
    this.#rawFogEnd = DEFAULT_FOG_TRIPLE.end * 36;

    // Task 4: no light data means no authored glow/highlightSky either -- same documented defaults
    // `blendLights` itself falls back to on an empty selection.
    this.#glow = 0.5;
    this.#highlightSky = 0;
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

      // Debug-readout-only (diagnostic 1's on-demand slot sweep, `dumpLightSlotBands`). Kept
      // alongside `#lights` rather than re-fetched per dump so the sweep never re-triggers a DBC
      // load of its own.
      this.#lightFloatBandDb = lightFloatBandDb;
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

      // The five meaningful Light.dbc slots, in `LIGHT_PARAM` order. Slots 5-7 are read (see
      // `lightSlots` below) but carry no documented semantic meaning -- see light.js's doc comment on
      // why `reserved7` being non-zero on some records does not make them a sixth real param.
      const slotIds = [
        lightRecord.paramsStandard,
        lightRecord.paramsUnderwater,
        lightRecord.paramsStormy,
        lightRecord.paramsStormyUnderwater,
        lightRecord.paramsDeath,
      ];

      // Sparse, indexed by LIGHT_PARAM -- a slot id of 0 means the record does not define that param,
      // so it stays a hole rather than being backfilled from another slot's data.
      const params: Array<AreaLightParams | undefined> = [];

      for (let slotIndex = 0; slotIndex < slotIds.length; slotIndex++) {
        const paramsId = slotIds[slotIndex];

        if (!paramsId) {
          continue;
        }

        // Get color bands
        const intBands: any[] = [];
        const floatBands: any[] = [];

        // Process integer bands (colors). Assigned by index rather than appended: consumers look
        // bands up by their LIGHT_INT_BAND / LIGHT_FLOAT_BAND position, so a single missing record
        // would otherwise shift every band after it and silently pair the wrong colour with the wrong
        // slot.
        //
        // The band-id arithmetic below uses THIS slot's own `paramsId`, not the standard slot's id --
        // reusing slot 0's id for every slot would load the same eighteen/six bands five times over
        // and make every slot identical, which presents as "the storm has no effect" rather than as a
        // bug.
        for (let i = 0; i < 18; i++) {
          const bandId = (paramsId * 18) - 17 + i;
          if (lightIntBandDb[bandId]) {
            intBands[i] = this.#processIntBand(lightIntBandDb[bandId]);
          }
        }

        // Process float bands
        let rawFogEndBand: any[] | undefined;
        for (let i = 0; i < 6; i++) {
          const bandId = (paramsId * 6) - 5 + i;
          if (lightFloatBandDb[bandId]) {
            floatBands[i] = this.#processFloatBand(lightFloatBandDb[bandId], i);

            // Debug-readout-only: the same band, interpolated again with the `1/36` scale withheld, so
            // the raw DBC value can be shown beside the scaled one (see AreaLightParams.rawFogEndBand's
            // doc comment).
            if (i === LIGHT_FLOAT_BAND.BAND_FOG_END) {
              rawFogEndBand = this.#processFloatBand(lightFloatBandDb[bandId], i, true);
            }
          }
        }

        const lightParams = lightParamsDb[paramsId];

        params[slotIndex] = {
          id: paramsId,
          intBands,
          floatBands,
          rawFogEndBand,
          // highlightSky gates the dawn/dusk sky warp; glow is the per-zone bloom weight. Both were
          // already parsed and already looked up here -- the result was simply discarded.
          highlightSky: !!lightParams?.highlightSky,
          glow: lightParams?.glow ?? 0.5,
        };
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
        params,
        // Debug-readout-only (diagnostic 1). All eight Light.dbc slot ids, in field order -- `params`
        // above only carries the five meaningful slots, so this is the only place the reserved words
        // are exposed at all.
        lightSlots: [
          lightRecord.paramsStandard,
          lightRecord.paramsUnderwater,
          lightRecord.paramsStormy,
          lightRecord.paramsStormyUnderwater,
          lightRecord.paramsDeath,
          lightRecord.reserved5,
          lightRecord.reserved6,
          lightRecord.reserved7,
        ],
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

  /**
   * `raw`, when true, withholds the `1/36` unit conversion regardless of `band` -- used ONLY to build
   * `AreaLightParams.rawFogEndBand` for the debug readout (see its doc comment), never for the real
   * `floatBands` table.
   */
  #processFloatBand(bandRecord: any, band: number, raw = false): any[] {
    // Fog distances share the light coordinate system and need the same 36 scale as the positions and
    // falloff radii. Without it fog ended ~29000 units out, far past any view distance, so no
    // geometry ever reached a non-zero fog factor. The start scalar is a ratio, so it stays as is.
    const scale = !raw && band === LIGHT_FLOAT_BAND.BAND_FOG_END ? 1.0 / 36.0 : 1.0;

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
