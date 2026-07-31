/**
 * The per-object lighting block.
 *
 * M2 materials are SHARED across every instance of a model -- an `M2` clone reuses the source's
 * `batches` -- but the reference's lighting laws are per-instance: each object has its own terrain-shade
 * intensity, its own interior light probe, and its own set of committed point lights.
 *
 * The reference implementation solves this with a `MeshTag` payload indexing a GPU slab, because Bevy
 * cannot do per-draw uniforms. three.js can: setting `uniformsNeedUpdate` inside a mesh's
 * `onBeforeRender` forces that material's uniforms to be re-uploaded for that draw. So we upload the
 * VALUES directly and need no slab, no slot allocator, no refcounting and no data texture.
 *
 * The cost is one uniform refresh per draw rather than per material. Measure it before assuming it is
 * free -- see the plan's risk note.
 */
import type { ProbeCoeffs, RGB, Vec3 } from '../../../world/light/laws';

/** One point light as the shader consumes it. Colour is pre-multiplied by the authored intensity. */
export type SelectedLight = {
  position: Vec3;
  color: RGB;
  attenStart: number;
  attenEnd: number;
};

export type PerObjectLighting = {
  /** True for a model standing in a WMO interior -- takes the probe lane instead of the sun lobe. */
  interior: boolean;
  /**
   * True when this instance should fog with the interior triple (`wmoFogColor`/`wmoFogParams`)
   * instead of the scene triple. A SEPARATE question from `interior` above: `interior` selects the
   * lighting LANE (probe vs sun lobe), while this selects the fog COLOUR/RANGE the fragment shader
   * mixes toward. For a WMO doodad the two happen to be set from the same `group.lightingInterior`
   * check today, but the reference stages a unit's fog by the unit's OWN light-node classification
   * (samples/benilla wow_model.wgsl: `interior_fogged`, the per-instance tag bit 30) -- an M2 can
   * want interior fog while not being an interior *prop* -- so do not collapse this into `interior`.
   */
  interiorFog: boolean;
  /** The terrain-shade intensity family: 2.5 lit / 0.5 MCSH-shadowed / 1.0 fixed, capped at 1.0. */
  sunIntensity: number;
  /** The folded interior probe, or null on the exterior lane. */
  probe: ProbeCoeffs | null;
  /** The committed point lights -- at most MAX_POINT_LIGHTS are uploaded. */
  pointLights: SelectedLight[];
};

/** Must match MAX_WMO_LIGHTS in the M2 fragment shader. The reference commits at most three. */
export const MAX_POINT_LIGHTS = 3;

/**
 * Write one object's lighting into the shared material, for one draw.
 *
 * `uniformsNeedUpdate` is the load-bearing line. three.js re-uploads a material's uniforms only when
 * the material changes between draws, and it does not change between instances of the same model -- so
 * without this flag every instance after the first renders with the FIRST instance's lighting.
 */
export function applyPerObjectLighting(
  material: { uniforms: Record<string, { value: any }>; uniformsNeedUpdate: boolean },
  lighting: PerObjectLighting,
): void {
  const uniforms = material.uniforms;

  uniforms.sunIntensity.value = lighting.sunIntensity;
  uniforms.interiorProbe.value = lighting.interior && lighting.probe ? 1 : 0;
  uniforms.interiorFog.value = lighting.interiorFog ? 1 : 0;

  if (lighting.probe) {
    // ONE flat Float32Array of 28 floats, not an array of Vector4s. three.js accepts a flat typed array
    // for a `vec4 probeCoeffs[7]` uniform, and writing it is a plain indexed copy -- whereas an array of
    // THREE.Vector4 would need `.set(x, y, z, w)` per row, and indexing those numerically (`row[0]`)
    // silently writes nothing because Vector4 exposes `.x/.y/.z/.w`.
    const out = uniforms.probeCoeffs.value;
    for (let row = 0; row < 7; ++row) {
      const source = lighting.probe[row];
      const base = row * 4;
      out[base] = source[0];
      out[base + 1] = source[1];
      out[base + 2] = source[2];
      out[base + 3] = source[3];
    }
  }

  const count = Math.min(lighting.pointLights.length, MAX_POINT_LIGHTS);
  const positions = uniforms.wmoLightPosition.value;
  const colors = uniforms.wmoLightColor.value;

  for (let index = 0; index < count; ++index) {
    const light = lighting.pointLights[index];
    positions[index].x = light.position[0];
    positions[index].y = light.position[1];
    positions[index].z = light.position[2];
    colors[index].r = light.color[0];
    colors[index].g = light.color[1];
    colors[index].b = light.color[2];
  }

  // Slots past `count` keep whatever the previous object left. The shader guards every read with the
  // count, so clearing them would be wasted work on every draw.
  uniforms.wmoLightCount.value = count;

  material.uniformsNeedUpdate = true;
}

/**
 * Install the per-draw push on one mesh. `getLighting` is called per draw, so it must be cheap -- do
 * the selection and folding when the object moves or its room changes, not here.
 */
export function attachPerObjectLighting(
  mesh: { material: any; onBeforeRender?: Function },
  getLighting: () => PerObjectLighting | null,
): void {
  mesh.onBeforeRender = function perObjectLighting() {
    const lighting = getLighting();
    if (!lighting || !this.material || !this.material.uniforms) {
      return;
    }
    applyPerObjectLighting(this.material, lighting);
  };
}
