/**
 * @jest-environment node
 */
import * as THREE from 'three';

jest.mock('../../../texture-loader', () => ({
  __esModule: true,
  default: {
    PLACEHOLDER: new (require('three').Texture)(),
    load: jest.fn(() => new Promise(() => {})), // never resolves -- irrelevant once the fallback path is forced
    unload: jest.fn(),
  },
}));

// Force the "asset does not resolve" path deterministically (Risk 6's own concern) without needing
// real Stars.m2/.skin bytes: reject before M2.decode ever runs.
jest.mock('../../../../net/loader', () => ({
  __esModule: true,
  default: class {
    load() {
      return Promise.reject(new Error('stars.test.ts: no asset host in this environment'));
    }
  },
}));

import Stars, { STARS_RENDER_ORDER, buildStarMaterial } from '../stars';

function makeCamera(x = 0, y = 0, z = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  return camera;
}

// Let the constructor's rejected promise chain (load -> catch -> buildFallback) settle.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('buildStarMaterial', () => {
  it('is the first celestial draw and forces the sky depth law', () => {
    const material = buildStarMaterial(new THREE.Texture());
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.fragmentShader).toContain('gl_FragDepth = 1.0;');
    expect(material.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(material.blendDstAlpha).toBe(THREE.OneFactor);
  });
});

describe('Stars', () => {
  it('exports the plan ladder slot: -1003, first of all the celestial draws', () => {
    expect(STARS_RENDER_ORDER).toBe(-1003);
  });

  it('falls back to the obvious placeholder field when Stars.m2 fails to resolve', async () => {
    const stars = new Stars();
    await flush();

    expect(stars.children.length).toBeGreaterThan(0);
    const mesh = stars.children[0] as THREE.Mesh;
    expect(mesh.renderOrder).toBe(STARS_RENDER_ORDER);

    const material = mesh.material as THREE.ShaderMaterial;
    // The fallback tint is solid magenta -- unmistakably not a real star, per the plan's own
    // "obviously a fallback" instruction.
    expect(material.uniforms.uTint.value.r).toBeCloseTo(1, 5);
    expect(material.uniforms.uTint.value.g).toBeCloseTo(0, 5);
    expect(material.uniforms.uTint.value.b).toBeCloseTo(1, 5);
  });

  it('camera-anchors the whole dome and scales it to the shared near-sphere distance', async () => {
    const stars = new Stars();
    await flush();

    const camera = makeCamera(5, -3, 2);
    stars.updateFromLight(camera, { timeProgression: 0 }); // midnight -- full star alpha

    expect(stars.position.x).toBeCloseTo(5, 6);
    expect(stars.position.y).toBeCloseTo(-3, 6);
    expect(stars.position.z).toBeCloseTo(2, 6);
    expect(stars.scale.x).toBeCloseTo(12, 6); // CELESTIAL_DISTANCE
  });

  it('drives alpha from the star curve x the patch weight, and is off by day', async () => {
    const stars = new Stars();
    await flush();
    const camera = makeCamera();
    const mesh = stars.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.ShaderMaterial;

    stars.updateFromLight(camera, { timeProgression: 0 }); // midnight
    expect(material.uniforms.uAlpha.value).toBeCloseTo(1.0, 3); // fallback weight is 1.0

    stars.updateFromLight(camera, { timeProgression: 0.5 }); // noon
    expect(material.uniforms.uAlpha.value).toBe(0);
  });

  it('disposes without throwing, before or after the async load settles', async () => {
    const early = new Stars();
    expect(() => early.dispose()).not.toThrow();

    const late = new Stars();
    await flush();
    expect(() => late.dispose()).not.toThrow();
  });
});
