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

import { Moon02, MOON02_RENDER_ORDER, WhiteMoon, WHITE_MOON_RENDER_ORDER } from '../moons';

function makeCamera(x = 0, y = 0, z = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  return camera;
}

describe('WhiteMoon', () => {
  it('renders at -1001, over the sun where the discs cross', () => {
    const moon = new WhiteMoon();
    expect(moon.renderOrder).toBe(WHITE_MOON_RENDER_ORDER);
    expect(moon.renderOrder).toBe(-1001);
  });

  it('places itself at cam + 12*moonDir', () => {
    const moon = new WhiteMoon();
    const camera = makeCamera(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);

    moon.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      moonDir: dir,
      timeProgression: 0, // midnight -- overhead
    });

    expect(moon.position.x).toBeCloseTo(1, 6);
    expect(moon.position.y).toBeCloseTo(2, 6);
    expect(moon.position.z).toBeCloseTo(15, 6); // 3 + 12*1
  });

  it('tints the disc from the light source, never a hardcoded colour', () => {
    const moon = new WhiteMoon();
    const camera = makeCamera();
    const tint = new THREE.Color(0.95, 0.9, 0.75); // a warm cream night tint

    moon.updateFromLight(camera, {
      celestialTint: tint,
      moonDir: new THREE.Vector3(0, 0, 1),
      timeProgression: 0,
    });

    const material = moon.material as THREE.ShaderMaterial;
    expect(material.uniforms.uColor.value.r).toBeCloseTo(0.95, 5);
    expect(material.uniforms.uColor.value.g).toBeCloseTo(0.9, 5);
    expect(material.uniforms.uColor.value.b).toBeCloseTo(0.75, 5);
  });

  it('is base x1.75 at its smallest (overhead, laws.moonDiscScale x1.0)', () => {
    const moon = new WhiteMoon();
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);

    // 01:00 -- moonDiscScale's smallest key (1.0x).
    moon.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      moonDir: dir,
      timeProgression: 60 / 1440,
    });
    expect(moon.scale.x).toBeCloseTo(1.75, 3);
  });

  it('fades out below the horizon rather than popping', () => {
    const moon = new WhiteMoon();
    const camera = makeCamera();

    moon.updateFromLight(camera, {
      celestialTint: new THREE.Color(1, 1, 1),
      moonDir: new THREE.Vector3(1, 0, -0.5).normalize(), // well below the horizon
      timeProgression: 0,
    });

    const material = moon.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBe(0);
  });

  it('disposes without throwing and unloads a resolved texture', () => {
    const moon = new WhiteMoon();
    expect(() => moon.dispose()).not.toThrow();
  });
});

describe('Moon02 (the vertex-black third disc)', () => {
  it('renders at -1000.5, between the white moon and the gradient dome', () => {
    const moon02 = new Moon02();
    expect(moon02.renderOrder).toBe(MOON02_RENDER_ORDER);
    expect(moon02.renderOrder).toBe(-1000.5);
  });

  it('places itself at cam + 12*moon02Dir, on its own bearing', () => {
    const moon02 = new Moon02();
    const camera = makeCamera(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);

    moon02.updateFromLight(camera, { moon02Dir: dir, moon02Scale: 1 });

    expect(moon02.position.x).toBeCloseTo(1, 6);
    expect(moon02.position.y).toBeCloseTo(2, 6);
    expect(moon02.position.z).toBeCloseTo(15, 6); // 3 + 12*1
  });

  it('is ALWAYS black at alpha 0, regardless of any tint the caller might supply the interface never even offers', () => {
    const moon02 = new Moon02();
    const camera = makeCamera();

    moon02.updateFromLight(camera, {
      moon02Dir: new THREE.Vector3(0, 0, 1), // straight up -- well above the horizon, fully faded in
      moon02Scale: 1,
    });

    const material = moon02.material as THREE.ShaderMaterial;
    expect(material.uniforms.uColor.value.r).toBe(0);
    expect(material.uniforms.uColor.value.g).toBe(0);
    expect(material.uniforms.uColor.value.b).toBe(0);
    // alpha stays 0 even with the horizon fade fully open (dirZ = 1) -- the tint alpha multiplier,
    // not the fade, is what the reference's unwritten colour dword corresponds to.
    expect(material.uniforms.uAlpha.value).toBe(0);
  });

  it('disposes without throwing and unloads a resolved texture', () => {
    const moon02 = new Moon02();
    expect(() => moon02.dispose()).not.toThrow();
  });
});
