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

import { SunGlare, MoonGlare, GLARE_RENDER_ORDER } from '../glare';

function makeCamera(x = 0, y = 0, z = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  return camera;
}

/** Point the camera's forward axis (local -Z) at `dir` from the origin -- Z-up, matching this
 * client's own convention (see `aimat.js`'s driver note: `cam.up` must be `(0, 0, 1)` here). */
function aimAt(camera: THREE.PerspectiveCamera, dir: THREE.Vector3): void {
  camera.up.set(0, 0, 1);
  camera.lookAt(camera.position.clone().add(dir));
  camera.updateMatrixWorld(true);
}

describe('SunGlare', () => {
  it('renders at +1000, after the world -- the one element on the ladder that does', () => {
    const glare = new SunGlare();
    expect(glare.renderOrder).toBe(GLARE_RENDER_ORDER);
    expect(glare.renderOrder).toBe(1000);
  });

  it('places itself at cam + 12*celestialSunDir, the near sphere (never the far plane)', () => {
    const glare = new SunGlare();
    const camera = makeCamera(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);

    glare.updateFromLight(
      camera,
      { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0.5 },
      1,
      false,
      1 / 60,
    );

    expect(glare.position.x).toBeCloseTo(1, 6);
    expect(glare.position.y).toBeCloseTo(2, 6);
    expect(glare.position.z).toBeCloseTo(15, 6); // 3 + 12*1
  });

  it('tints from the light source, never a hardcoded colour', () => {
    const glare = new SunGlare();
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);
    const tint = new THREE.Color(0.9, 0.6, 0.3);

    glare.updateFromLight(
      camera,
      { celestialTint: tint, celestialSunDir: dir, timeProgression: 0.5 },
      1,
      false,
      1 / 60,
    );

    const material = glare.material as THREE.ShaderMaterial;
    expect(material.uniforms.uColor.value.r).toBeCloseTo(0.9, 5);
    expect(material.uniforms.uColor.value.g).toBeCloseTo(0.6, 5);
    expect(material.uniforms.uColor.value.b).toBeCloseTo(0.3, 5);
  });

  it('scales lerp(3, 20) world units as the view swings onto the sun', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    const light = { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0.5 };

    // Looking straight at the sun: cosTheta = 1, f = 1, scale = 20.
    const onAxis = new SunGlare();
    aimAt(camera, dir);
    onAxis.updateFromLight(camera, light, 1, false, 1 / 60);
    expect(onAxis.scale.x).toBeCloseTo(20, 3);

    // Looking the opposite way: cosTheta = -1, f = 0, scale = 3.
    const offAxis = new SunGlare();
    aimAt(camera, dir.clone().negate());
    offAxis.updateFromLight(camera, light, 1, false, 1 / 60);
    expect(offAxis.scale.x).toBeCloseTo(3, 3);
  });

  it('is a DAY flare: builds up at noon, stays at zero all night', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);

    const noon = new SunGlare();
    for (let i = 0; i < 200; i++) {
      noon.updateFromLight(
        camera,
        { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0.5 },
        1,
        false,
        1,
      );
    }
    expect((noon.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBeGreaterThan(0.9);

    const midnight = new SunGlare();
    for (let i = 0; i < 200; i++) {
      midnight.updateFromLight(
        camera,
        { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0 },
        1,
        false,
        1,
      );
    }
    expect((midnight.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBe(0);
  });

  it('dims as cloud coverage rises over the sun (occ1Sun = 1 - R): the coverage field\'s payoff', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);
    const light = { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0.5 };

    const clear = new SunGlare();
    for (let i = 0; i < 200; i++) {
      clear.updateFromLight(camera, light, 1, false, 1); // occ1 = 1: no cloud
    }
    const clearAlpha = (clear.material as THREE.ShaderMaterial).uniforms.uAlpha.value;

    const overcast = new SunGlare();
    for (let i = 0; i < 200; i++) {
      overcast.updateFromLight(camera, light, 0, false, 1); // occ1 = 0: fully occluded
    }
    const overcastAlpha = (overcast.material as THREE.ShaderMaterial).uniforms.uAlpha.value;

    expect(clearAlpha).toBeGreaterThan(0.9);
    expect(overcastAlpha).toBe(0);
  });

  it('the interior gate zeroes the flare even at noon looking straight at the sun', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);
    const light = { celestialTint: new THREE.Color(1, 1, 1), celestialSunDir: dir, timeProgression: 0.5 };

    const glare = new SunGlare();
    for (let i = 0; i < 200; i++) {
      glare.updateFromLight(camera, light, 1, true, 1); // interior = true
    }
    expect((glare.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBe(0);
  });

  it('disposes without throwing', () => {
    const glare = new SunGlare();
    expect(() => glare.dispose()).not.toThrow();
  });
});

describe('MoonGlare', () => {
  it('renders at +1000, sharing the sun glare\'s slot (additive order does not matter)', () => {
    const glare = new MoonGlare();
    expect(glare.renderOrder).toBe(GLARE_RENDER_ORDER);
    expect(glare.renderOrder).toBe(1000);
  });

  it('scales 2.0*moonDiscScale regardless of view angle (both lerp endpoints share the curve)', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    const light = { celestialTint: new THREE.Color(1, 1, 1), moonDir: dir, timeProgression: 60 / 1440 }; // 01:00, scale x1.0

    const onAxis = new MoonGlare();
    aimAt(camera, dir);
    onAxis.updateFromLight(camera, light, 1, false, 1 / 60);

    const offAxis = new MoonGlare();
    aimAt(camera, dir.clone().negate());
    offAxis.updateFromLight(camera, light, 1, false, 1 / 60);

    expect(onAxis.scale.x).toBeCloseTo(2.0, 3);
    expect(offAxis.scale.x).toBeCloseTo(2.0, 3);
  });

  it('is a DEEP-NIGHT halo: a 22:30 moonrise carries no halo, midnight is full', () => {
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);

    const moonrise = new MoonGlare();
    for (let i = 0; i < 200; i++) {
      moonrise.updateFromLight(
        camera,
        { celestialTint: new THREE.Color(1, 1, 1), moonDir: dir, timeProgression: (22 * 60 + 30) / 1440 },
        1,
        false,
        1,
      );
    }
    expect((moonrise.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBe(0);

    const midnight = new MoonGlare();
    for (let i = 0; i < 200; i++) {
      midnight.updateFromLight(
        camera,
        { celestialTint: new THREE.Color(1, 1, 1), moonDir: dir, timeProgression: 0 },
        1,
        false,
        1,
      );
    }
    expect((midnight.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBeGreaterThan(0.9);
  });

  it('dims under the moon\'s thin-cloud tent (occ1Moon): zero at R=0 and R=1, blooming at R=0.5', () => {
    // This test exercises the caller contract directly -- occ1 is the number `occ1Moon(coverage)`
    // already resolves to, not something MoonGlare recomputes -- see `world/sky/clouds/kernel.ts`.
    const camera = makeCamera();
    const dir = new THREE.Vector3(0, 0, 1);
    aimAt(camera, dir);
    const light = { celestialTint: new THREE.Color(1, 1, 1), moonDir: dir, timeProgression: 0 }; // midnight

    const clearSky = new MoonGlare();
    for (let i = 0; i < 200; i++) {
      clearSky.updateFromLight(camera, light, 0, false, 1); // occ1Moon(R=0) = 0
    }
    expect((clearSky.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBe(0);

    const wispCrossing = new MoonGlare();
    for (let i = 0; i < 200; i++) {
      wispCrossing.updateFromLight(camera, light, 1, false, 1); // occ1Moon(R=0.5) = 1
    }
    expect((wispCrossing.material as THREE.ShaderMaterial).uniforms.uAlpha.value).toBeGreaterThan(0.9);
  });

  it('disposes without throwing', () => {
    const glare = new MoonGlare();
    expect(() => glare.dispose()).not.toThrow();
  });
});
