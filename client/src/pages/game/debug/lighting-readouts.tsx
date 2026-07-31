import React from 'react';

type Rgb = { r: number; g: number; b: number };
type Xyz = { x: number; y: number; z: number };

/**
 * The slice of MapLight these readouts print. Narrow and structural for the same reasons as
 * `LightingControlsTarget`: no three.js import, and testable with plain objects. Colours and vectors
 * are described by shape, so a THREE.Color and a THREE.Vector3 both satisfy it. Plans 2-5 extend this
 * as they add resolved values (storm bcc, sky warp, interior fog triple, batch-class counts).
 *
 * There is deliberately no WMO-point-light count here: selection moved from MapLight (camera-anchored,
 * one shared answer) to per-object (`laws.selectPointLights` anchored at each instance), so there is no
 * longer a single number that describes the whole scene. A readout describing lighting the renderer is
 * not doing is worse than no readout.
 */
export type LightingReadoutsTarget = {
  mapId: number | undefined;
  sampledPosition: Xyz | null;
  location: 'exterior' | 'interior';
  sunAmbientColor: Rgb;
  sunDiffuseColor: Rgb;
  fogColor: Rgb;
  fogStart: number;
  fogEnd: number;
  /**
   * The resolved (blended, weighted-mean) `LIGHT_FLOAT_BAND.BAND_FOG_START_SCALAR`, BEFORE it is
   * multiplied by `fogEnd` to produce `fogStart` above. A start scalar around -0.5 is not obviously
   * wrong on its own -- the reference authors a negative start deliberately for a storm's near veil --
   * but showing it separately from the already-multiplied `fogStart` is what lets a look this intense
   * be checked against the DBC's own band value instead of guessed at from the final range.
   */
  fogStartScalar: number;
  /**
   * The resolved `LIGHT_FLOAT_BAND.BAND_FOG_END`, BEFORE `MapLight#processFloatBand`'s `1/36` unit
   * conversion (Light.dbc's distances share the light coordinate system, not world yards). Printed
   * beside `fogEnd` (the scaled value used everywhere else) so the two can be checked against each
   * other by inspection: `rawFogEnd / 36` should equal `fogEnd` exactly. If it does not, the scale is
   * being applied somewhere it should not be (or applied twice), and that -- not the fog maths -- is
   * what would be producing an implausible range.
   */
  rawFogEnd: number;
  /**
   * The camera-in-WMO interior fog crossfade's current result (`MapLight#interiorFog`) -- the scene
   * fog blended toward the camera's claimed room fog by `WmoFogRamp`. Equal to the scene triple
   * outdoors, so this doubling as a readout only matters once you are actually standing in a room.
   */
  interiorFog: { color: [number, number, number]; start: number; end: number };
  /** The ramp's current blend weight (`MapLight#fogRampWeight`): 0 outdoors/settled-out, 1 fully
   * faded into a room, travelling over the four-second crossfade. */
  fogRampWeight: number;
  sunDir: Xyz;
  sidnNight: number;
  selectedLights: Array<{
    light: {
      id: number;
      /**
       * The area light's own `params` -- specifically `params[0].id`, the `LightParams` (Light.dbc's
       * `skyFogID`) each selected light resolved its int/float bands from. Optional so existing plain
       * test fixtures (`{ light: { id } }`) keep satisfying this type -- `MapLight#selectedLights`
       * (the real target) always carries the full `AreaLight` shape, `params` included.
       */
      params?: Array<{ id: number }>;
    };
    weight: number;
    distance: number;
  }>;
  /** The WMO the camera is standing in, or null outdoors. */
  wmo: {
    name: string;
    groupIndex: number;
    ext: number;
    int: number;
    trans: number;
  } | null;
};

type Props = {
  mapLight: LightingReadoutsTarget | null;
};

/** 0..1 colour to the 0..255 bytes the reference's own dumps report, so values compare directly. */
const asBytes = (color: Rgb | undefined) => {
  if (!color) {
    return '-';
  }
  const byte = (v: number) => Math.round(v * 255);
  return `${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}`;
};

const asFixed = (value: number | undefined, places = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '-';

/** Same byte conversion as `asBytes`, for the `[r, g, b]` tuple `FogTriple.color` uses rather than
 * the `{r, g, b}` shape a THREE.Color satisfies. */
const asBytesTriple = (color: [number, number, number] | undefined) => {
  if (!color) {
    return '-';
  }
  const byte = (v: number) => Math.round(v * 255);
  return `${byte(color[0])}, ${byte(color[1])}, ${byte(color[2])}`;
};

/**
 * The resolved-light numeric probe.
 *
 * Leads with the map id and the sampled eye position deliberately: those two inputs decide every
 * colour below them, neither is visible from the chair, and "is this the atmosphere the zone
 * authored, or the one next door?" is otherwise unanswerable without a session of guessing.
 *
 * Colours print as 0..255 bytes rather than floats so they can be compared directly against the
 * reference's dumps and against the DBC bytes themselves.
 */
class LightingReadouts extends React.Component<Props> {
  render() {
    const { mapLight } = this.props;
    if (!mapLight) {
      return null;
    }

    const position = mapLight.sampledPosition;
    const selected = mapLight.selectedLights || [];

    return (
      <div className="lightingReadouts">
        <h2>Lighting resolve</h2>
        <div className="divider"></div>
        <p>Map: {mapLight.mapId ?? '-'}</p>
        <p>
          Sampled at:{' '}
          {position
            ? `${asFixed(position.x, 1)}, ${asFixed(position.y, 1)}, ${asFixed(position.z, 1)}`
            : '-'}
        </p>
        <p>Location: {mapLight.location}</p>

        <div className="divider"></div>
        <p>Ambient: {asBytes(mapLight.sunAmbientColor)}</p>
        <p>Diffuse: {asBytes(mapLight.sunDiffuseColor)}</p>
        <p>Fog colour: {asBytes(mapLight.fogColor)}</p>
        <p>
          Fog range: {asFixed(mapLight.fogStart)} / {asFixed(mapLight.fogEnd)}
        </p>
        <p>Fog start scalar: {asFixed(mapLight.fogStartScalar, 3)}</p>
        <p>
          Fog end raw / scaled: {asFixed(mapLight.rawFogEnd, 1)} / {asFixed(mapLight.fogEnd, 1)}
        </p>
        <p>Interior fog colour: {asBytesTriple(mapLight.interiorFog.color)}</p>
        <p>
          Interior fog range: {asFixed(mapLight.interiorFog.start)} / {asFixed(mapLight.interiorFog.end)}
        </p>
        <p>Fog ramp weight: {asFixed(mapLight.fogRampWeight, 3)}</p>
        <p>
          Sun dir: {asFixed(mapLight.sunDir.x, 3)}, {asFixed(mapLight.sunDir.y, 3)},{' '}
          {asFixed(mapLight.sunDir.z, 3)}
        </p>

        <div className="divider"></div>
        <p>SIDN night: {asFixed(mapLight.sidnNight, 3)}</p>

        <div className="divider"></div>
        <p>Area lights: {selected.length}</p>
        {selected.slice(0, 4).map((entry) => (
          <p key={entry.light.id}>
            id {entry.light.id} &middot; params {entry.light.params?.[0]?.id ?? '-'} &middot; weight{' '}
            {asFixed(entry.weight, 3)} &middot; dist {asFixed(entry.distance, 1)}
          </p>
        ))}

        <div className="divider"></div>
        <p>
          WMO:{' '}
          {mapLight.wmo
            ? `${mapLight.wmo.name} · group ${mapLight.wmo.groupIndex}`
            : '-'}
        </p>
        {mapLight.wmo && (
          <p>
            Batches: ext {mapLight.wmo.ext} · int {mapLight.wmo.int} · trans {mapLight.wmo.trans}
          </p>
        )}
      </div>
    );
  }
}

export default LightingReadouts;
