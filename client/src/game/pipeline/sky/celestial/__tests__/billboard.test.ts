import * as THREE from 'three';
import CelestialBillboard, { buildCelestialQuadGeometry } from '../billboard';

function makeTexture(): THREE.Texture {
  return new THREE.Texture();
}

describe('buildCelestialQuadGeometry', () => {
  it('builds a unit quad (4 vertices, 2 triangles) in the XY plane, UV 0..1', () => {
    const geometry = buildCelestialQuadGeometry();
    const position = geometry.getAttribute('position');
    expect(position.count).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(position.getX(i))).toBeCloseTo(0.5, 6);
      expect(Math.abs(position.getY(i))).toBeCloseTo(0.5, 6);
      expect(position.getZ(i)).toBe(0);
    }
    const index = geometry.getIndex();
    expect(index!.count).toBe(6);
  });
});

describe('CelestialBillboard', () => {
  it('renders at the requested renderOrder', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: -1002 });
    expect(sprite.renderOrder).toBe(-1002);
  });

  it('is never frustum-culled -- camera-anchored every frame like the gradient/cloud domes', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    expect(sprite.frustumCulled).toBe(false);
  });

  it('never writes the framebuffer alpha channel (the d348889 white-fringe regression guard)', () => {
    const alphaSprite = new CelestialBillboard(makeTexture(), { renderOrder: 0, blending: 'alpha' });
    const additiveSprite = new CelestialBillboard(makeTexture(), { renderOrder: 0, blending: 'additive' });
    for (const sprite of [alphaSprite, additiveSprite]) {
      const material = sprite.material as THREE.ShaderMaterial;
      expect(material.blendSrcAlpha).toBe(THREE.ZeroFactor);
      expect(material.blendDstAlpha).toBe(THREE.OneFactor);
    }
  });

  it('does not depth-test or depth-write, matching the sky dome idiom', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
  });

  it('places the sprite at cam + 12*dir by default (the shared near-sphere radius)', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);

    sprite.update(camera, dir);

    expect(sprite.position.x).toBeCloseTo(1, 6);
    expect(sprite.position.y).toBeCloseTo(2, 6);
    expect(sprite.position.z).toBeCloseTo(15, 6);
  });

  it('honours a caller-supplied near-sphere distance', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0, distance: 5 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 0);
    const dir = new THREE.Vector3(1, 0, 0);

    sprite.update(camera, dir);

    expect(sprite.position.x).toBeCloseTo(5, 6);
  });

  it('orients local +Z to face back toward the camera (-dir)', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 0);
    const dir = new THREE.Vector3(1, 0, 0).normalize();

    sprite.update(camera, dir);

    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sprite.quaternion);
    expect(normal.x).toBeCloseTo(-1, 5);
    expect(normal.y).toBeCloseTo(0, 5);
    expect(normal.z).toBeCloseTo(0, 5);
  });

  it('hides the sprite for a zero-length direction instead of placing it at the camera', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const camera = new THREE.PerspectiveCamera();
    sprite.update(camera, new THREE.Vector3(0, 0, 0));
    expect(sprite.visible).toBe(false);
  });

  it('clips fully below the horizon (applyHorizonFade default true)', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const camera = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector3(1, 0, -0.1).normalize(); // below the horizon: dirZ < 0
    sprite.update(camera, dir);
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBe(0);
  });

  it('is fully opaque well above the horizon fade band', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    sprite.setTint(new THREE.Color(1, 1, 1), 1);
    const camera = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector3(0, 0, 1); // straight up -- well clear of the fade band
    sprite.update(camera, dir);
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBeCloseTo(1, 6);
  });

  it('a glare (applyHorizonFade: false) ignores the horizon clip entirely', () => {
    const sprite = new CelestialBillboard(makeTexture(), {
      renderOrder: 0,
      blending: 'additive',
      applyHorizonFade: false,
    });
    sprite.setTint(new THREE.Color(1, 1, 1), 1);
    const camera = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector3(1, 0, -0.5).normalize(); // well below the horizon
    sprite.update(camera, dir);
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBeCloseTo(1, 6);
  });

  it('multiplies the caller-supplied tint alpha (opacity law) into uAlpha, not the tint colour', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    sprite.setTint(new THREE.Color(1, 0.5, 0.2), 0.5);
    const camera = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector3(0, 0, 1); // straight up -- fade = 1
    sprite.update(camera, dir);
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.uniforms.uAlpha.value).toBeCloseTo(0.5, 6);
    expect(material.uniforms.uColor.value.r).toBeCloseTo(1, 6);
    expect(material.uniforms.uColor.value.g).toBeCloseTo(0.5, 6);
    expect(material.uniforms.uColor.value.b).toBeCloseTo(0.2, 6);
  });

  it('setScale sets the quad world-space size directly (the unit-quad-at-distance convention)', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    sprite.setScale(3.5);
    expect(sprite.scale.x).toBeCloseTo(3.5, 6);
    expect(sprite.scale.y).toBeCloseTo(3.5, 6);
    expect(sprite.scale.z).toBeCloseTo(3.5, 6);
  });

  it('setTexture swaps the material`s texture uniform', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    const next = makeTexture();
    sprite.setTexture(next);
    const material = sprite.material as THREE.ShaderMaterial;
    expect(material.uniforms.map.value).toBe(next);
  });

  it('disposes its geometry and material without throwing', () => {
    const sprite = new CelestialBillboard(makeTexture(), { renderOrder: 0 });
    expect(() => sprite.dispose()).not.toThrow();
  });
});
