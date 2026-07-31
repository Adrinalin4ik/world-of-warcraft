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
  sunDir: Xyz;
  sidnNight: number;
  selectedLights: Array<{ light: { id: number }; weight: number; distance: number }>;
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
            id {entry.light.id} &middot; weight {asFixed(entry.weight, 3)} &middot; dist{' '}
            {asFixed(entry.distance, 1)}
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
