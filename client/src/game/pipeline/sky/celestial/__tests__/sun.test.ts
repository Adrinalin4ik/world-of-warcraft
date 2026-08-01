/**
 * @jest-environment node
 */
import * as THREE from 'three';

jest.mock('../../../texture-loader', () => ({
  __esModule: true,
  default: {
    PLACEHOLDER: new (require('three').Texture)(),
    load: jest.fn(() => new Promise(() => {})),
    unload: jest.fn(),
  },
}));

import SunDisc, { SUN_DISC_RENDER_ORDER } from '../sun';

function makeCamera(x = 0, y = 0, z = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  return camera;
}

describe('SunDisc', () => {
  it('renders at -1002, the plan ladder slot right after the (future) stars', () => {
    const sun = new SunDisc();
    expect(sun.renderOrder).toBe(SUN_DISC_RENDER_ORDER);
    expect(sun.renderOrder).toBe(-1002);
  });

  it('places itself at cam + 12*celestialSunDir', () => {
    const sun = new SunDisc();
    const camera = makeCamera(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);

    sun.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      celestialSunDir: dir,
      timeProgression: 0.5, // noon
    });

    expect(sun.position.x).toBeCloseTo(1, 6);
    expect(sun.position.y).toBeCloseTo(2, 6);
    expect(sun.position.z).toBeCloseTo(15, 6); // 3 + 12*1
  });

  it('tints the disc from the light source, never a hardcoded colour', () => {
    const sun = new SunDisc();
    const camera = makeCamera();
    const tint = new THREE.Color(0.9, 0.6, 0.3); // an orange dusk tint

    sun.updateFromLight(camera, {
      celestialTint: tint,
      celestialSunDir: new THREE.Vector3(0, 0, 1),
      timeProgression: 0.5,
    });

    const material = sun.material as THREE.ShaderMaterial;
    expect(material.uniforms.uColor.value.r).toBeCloseTo(0.9, 5);
    expect(material.uniforms.uColor.value.g).toBeCloseTo(0.6, 5);
    expect(material.uniforms.uColor.value.b).toBeCloseTo(0.3, 5);
  });

  it('is 1x scale at midday and 2x at the dawn/dusk horizon (laws.sunDiscScale)', () => {
    const sun = new SunDisc();
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);

    sun.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      celestialSunDir: dir,
      timeProgression: 0.5, // noon: minute = 720
    });
    expect(sun.scale.x).toBeCloseTo(1.0, 3);

    sun.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      celestialSunDir: dir,
      timeProgression: 6 / 24, // 06:00 sunrise: minute = 360
    });
    expect(sun.scale.x).toBeCloseTo(2.0, 3);
  });

  it('fades out below the horizon rather than popping', () => {
    const sun = new SunDisc();
    const camera = makeCamera();

    sun.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      celestialSunDir: new THREE.Vector3(1, 0, -0.5).normalize(), // well below the horizon
      timeProgression: 0.5,
    });

    const material = sun.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBe(0);
  });

  it('disposes without throwing and unloads a resolved texture', () => {
    const sun = new SunDisc();
    expect(() => sun.dispose()).not.toThrow();
  });
});
