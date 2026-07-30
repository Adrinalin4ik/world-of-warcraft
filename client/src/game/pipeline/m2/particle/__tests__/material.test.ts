/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { applyParticleBlending, PARTICLE_BLEND_MODE } from '../material';

describe('applyParticleBlending', () => {
  it('leaves mode 0 unblended', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.OPAQUE);

    expect(material.blending).toBe(THREE.NoBlending);
    expect(material.transparent).toBe(false);
  });

  it('alpha-keys mode 1 with a mid alpha test', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ALPHA_KEY);

    expect(material.alphaTest).toBeCloseTo(0.5, 5);
  });

  it('uses src-alpha over one-minus-src-alpha for mode 2', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ALPHA);

    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
  });

  it('uses additive factors for mode 4', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ADD_ALPHA);

    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(material.blendDst).toBe(THREE.OneFactor);
  });

  it('marks every blended mode transparent and disables depth write', () => {
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      const material = new THREE.MeshBasicMaterial();
      applyParticleBlending(material, mode);

      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
  });

  it('falls back to alpha blending for an unknown mode rather than leaving it unset', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, 99);

    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
  });
});
