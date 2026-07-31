/**
 * @jest-environment node
 */
import { applyPerObjectLighting, PerObjectLighting } from '../per-object-light';

// A stand-in for the shared ShaderMaterial: only the uniforms and the refresh flag matter.
const makeMaterial = () => ({
  uniforms: {
    sunIntensity: { value: 1.0 },
    interiorProbe: { value: 0 },
    interiorFog: { value: 0 },
    probeCoeffs: { value: new Float32Array(28) },
    wmoLightCount: { value: 0 },
    wmoLightPosition: { value: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }] },
    wmoLightColor: { value: [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }] },
  },
  uniformsNeedUpdate: false,
});

const exterior: PerObjectLighting = {
  interior: false,
  interiorFog: false,
  sunIntensity: 1.0,
  probe: null,
  pointLights: [],
};

describe('applyPerObjectLighting', () => {
  it('flags the shared material for a uniform refresh', () => {
    // Without this the renderer reuses whatever the PREVIOUS instance uploaded, because three.js only
    // re-uploads a material's uniforms when the material changes -- and it does not change between
    // instances of the same model.
    const material = makeMaterial();
    applyPerObjectLighting(material as any, exterior);
    expect(material.uniformsNeedUpdate).toBe(true);
  });

  it('writes the exterior intensity and clears the interior flag', () => {
    const material = makeMaterial();
    applyPerObjectLighting(material as any, { ...exterior, sunIntensity: 0.5 });
    expect(material.uniforms.sunIntensity.value).toBeCloseTo(0.5, 5);
    expect(material.uniforms.interiorProbe.value).toBe(0);
  });

  it('writes the probe rows and sets the interior flag', () => {
    const material = makeMaterial();
    const probe = Array.from({ length: 7 }, (_, row) => [row, row + 1, row + 2, row + 3]);
    applyPerObjectLighting(material as any, {
      interior: true,
      interiorFog: true,
      sunIntensity: 1.0,
      probe: probe as any,
      pointLights: [],
    });
    expect(material.uniforms.interiorProbe.value).toBe(1);
    // Row 3 occupies floats 12..15 of the flat array.
    expect(Array.from(material.uniforms.probeCoeffs.value.slice(12, 16))).toEqual([3, 4, 5, 6]);
  });

  it('pushes interiorFog independently of the interior probe flag', () => {
    // A doodad can want interior fog without taking the probe lane (and vice-versa in principle) --
    // the two are deliberately separate questions. See PerObjectLighting.interiorFog.
    const material = makeMaterial();
    applyPerObjectLighting(material as any, { ...exterior, interior: false, interiorFog: true });
    expect(material.uniforms.interiorProbe.value).toBe(0);
    expect(material.uniforms.interiorFog.value).toBe(1);

    applyPerObjectLighting(material as any, { ...exterior, interior: false, interiorFog: false });
    expect(material.uniforms.interiorFog.value).toBe(0);
  });

  it('caps the point lights at three and folds intensity into the colour', () => {
    const material = makeMaterial();
    const light = (x: number) => ({
      position: [x, 0, 0] as [number, number, number],
      color: [1, 0.5, 0.25] as [number, number, number],
      attenStart: 1,
      attenEnd: 10,
    });
    applyPerObjectLighting(material as any, {
      ...exterior,
      pointLights: [light(1), light(2), light(3), light(4)],
    });
    expect(material.uniforms.wmoLightCount.value).toBe(3);
    expect(material.uniforms.wmoLightPosition.value[0].x).toBe(1);
    expect(material.uniforms.wmoLightColor.value[0].r).toBeCloseTo(1, 5);
  });

  it('zeroes the light count when the object has none', () => {
    const material = makeMaterial();
    applyPerObjectLighting(material as any, exterior);
    expect(material.uniforms.wmoLightCount.value).toBe(0);
  });

  it('leaves stale slots beyond the count alone rather than paying to clear them', () => {
    // The shader guards every read with the count, so clearing is wasted work per draw.
    const material = makeMaterial();
    material.uniforms.wmoLightPosition.value[2].x = 99;
    applyPerObjectLighting(material as any, exterior);
    expect(material.uniforms.wmoLightPosition.value[2].x).toBe(99);
  });
});
