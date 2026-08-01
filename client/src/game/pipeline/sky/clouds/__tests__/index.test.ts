import * as THREE from 'three';
import CloudDome, { buildCloudDomeGeometry, CLOUD_TEXTURE_SIZE } from '../index';

const RINGS = 12;
const AZ_STEPS = 16;

describe('buildCloudDomeGeometry', () => {
  // Mirrors the reference's own mesh assertions (`layer.rs::dome_matches_the_reference_build`),
  // translated to this client's Z-up frame (see the module doc): the reference asserts `y`, we
  // assert `z`, confirmed against `MapLight#updateSunDirection`'s own `z = cos(phi)` convention.
  it('builds 192 vertices (12 rings x 16 azimuth steps)', () => {
    const geometry = buildCloudDomeGeometry();
    const position = geometry.getAttribute('position');
    expect(position.count).toBe(RINGS * AZ_STEPS);
    expect(position.count).toBe(192);
  });

  it('builds the 11 band strips as 11 x 16 x 6 triangle-list indices', () => {
    const geometry = buildCloudDomeGeometry();
    const index = geometry.getIndex();
    expect(index).not.toBeNull();
    expect(index!.count).toBe(11 * AZ_STEPS * 6);
  });

  it('places every vertex at unit radius', () => {
    const geometry = buildCloudDomeGeometry();
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const r = Math.hypot(x, y, z);
      expect(Math.abs(r - 1)).toBeLessThan(1e-5);
    }
  });

  it('puts the pole at z = +1 (this frame is Z-up, not the reference`s Y-up)', () => {
    const geometry = buildCloudDomeGeometry();
    const position = geometry.getAttribute('position');
    // Ring 0, azimuth 0 -- the first vertex emitted.
    expect(position.getX(0)).toBeCloseTo(0, 6);
    expect(position.getY(0)).toBeCloseTo(0, 6);
    expect(position.getZ(0)).toBeCloseTo(1, 6);
  });

  it('puts the rim at z = 0', () => {
    const geometry = buildCloudDomeGeometry();
    const position = geometry.getAttribute('position');
    // Ring 11 (the last ring, colat 0.25*pi) is the rim; check every azimuth step on it.
    for (let j = 0; j < AZ_STEPS; j++) {
      const i = 11 * AZ_STEPS + j;
      expect(Math.abs(position.getZ(i))).toBeLessThan(1e-5);
    }
  });

  it('uses the reference`s per-ring alpha table (opaque inner 9, half ring 10, transparent rim)', () => {
    const geometry = buildCloudDomeGeometry();
    const alpha = geometry.getAttribute('alpha');
    for (let ring = 0; ring < 9; ring++) {
      expect(alpha.getX(ring * AZ_STEPS)).toBeCloseTo(1, 6);
    }
    expect(alpha.getX(9 * AZ_STEPS)).toBeCloseTo(128 / 255, 6);
    expect(alpha.getX(10 * AZ_STEPS)).toBeCloseTo(0, 6);
    expect(alpha.getX(11 * AZ_STEPS)).toBeCloseTo(0, 6);
  });

  it('maps UV off the same (sin, cos) horizontal pair the dome`s position uses', () => {
    const geometry = buildCloudDomeGeometry();
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    // Ring 6 (mid-dome, nonzero radius), azimuth step 0 (az = 0 -> sin = 0, cos = 1).
    const ring = 6;
    const i = ring * AZ_STEPS + 0;
    const vr = ring / 24;
    expect(uv.getX(i)).toBeCloseTo(0 * vr + 0.5, 6);
    expect(uv.getY(i)).toBeCloseTo(1 * vr + 0.5, 6);
    // Sanity: this vertex's un-normalised horizontal components are (0, +something), matching the
    // uv's (u=0.5, v>0.5) reading -- i.e. uv really does track this vertex's own (x, y).
    expect(Math.abs(position.getX(i))).toBeLessThan(1e-6);
    expect(position.getY(i)).toBeGreaterThan(0);
  });
});

describe('CloudDome', () => {
  it('renders immediately after the sky gradient dome and before world geometry', () => {
    const dome = new CloudDome();
    expect(dome.renderOrder).toBe(-999);
  });

  it('never writes the framebuffer alpha channel (the d348889 white-fringe regression guard)', () => {
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    expect(material.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(material.blendDstAlpha).toBe(THREE.OneFactor);
  });

  it('never sRGB-decodes the coverage texture', () => {
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    const texture = material.uniforms.cloudTex.value as THREE.DataTexture;
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('samples the coverage texture with LINEAR filtering and toroidal wrapping', () => {
    // `THREE.DataTexture` defaults both filters to `NearestFilter`, unlike other texture paths, and
    // a 128x128 tile across the whole sky at nearest renders as a patchwork of flat squares -- how
    // this first shipped. The kernel's `t == 0` hole fill (previous cell's RGB at alpha 0) exists
    // specifically so a linear sampler blends toward neighbouring cloud rather than black; under
    // nearest it is dead code. Wrapping must be Repeat because the tile is toroidal --
    // `CloudKernel.coverage` masks with `& (COLS - 1)` -- so clamping puts a seam at the boundary.
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    const texture = material.uniforms.cloudTex.value as THREE.DataTexture;

    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
  });

  it('depth-tests against a forced far depth, and writes no depth', () => {
    // This originally asserted `depthTest: false`, copying the opaque gradient dome -- and that is
    // what let clouds paint over mountains and buildings. three.js draws every TRANSPARENT material
    // after every opaque one, and `renderOrder` sorts only within a pass, so this dome (unlike the
    // `transparent: false` gradient dome) draws AFTER the world. With the test off it ignored depth
    // entirely. See the shared law in `sky/__tests__/sky-depth-law.test.ts`.
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    expect(material.depthWrite).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(material.fragmentShader).toContain('gl_FragDepth = 1.0;');
  });

  it('starts fully transparent until the first coverage upload', () => {
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    const texture = material.uniforms.cloudTex.value as THREE.DataTexture;
    const data = texture.image.data as Uint8Array;
    expect(data.length).toBe(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4);
    expect(data.every((byte) => byte === 0)).toBe(true);
  });

  it('accepts a coverage upload through the Task 6 seam and flags the texture for re-upload', () => {
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    const texture = material.uniforms.cloudTex.value as THREE.DataTexture;
    // `needsUpdate` is write-only in three.js (it bumps `version` internally, see Texture.js) --
    // `version` is the readable signal that the setter actually ran.
    const versionBefore = texture.version;

    const rgba = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4).fill(200);
    dome.setCoverageTexture(rgba, true);

    expect(texture.version).toBeGreaterThan(versionBefore);
    expect((texture.image.data as Uint8Array)[0]).toBe(200);
  });

  it('ignores an upload when the caller signals nothing changed', () => {
    const dome = new CloudDome();
    const material = dome.material as THREE.ShaderMaterial;
    const texture = material.uniforms.cloudTex.value as THREE.DataTexture;
    const versionBefore = texture.version;

    const rgba = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4).fill(200);
    dome.setCoverageTexture(rgba, false);

    expect(texture.version).toBe(versionBefore);
    expect((texture.image.data as Uint8Array)[0]).toBe(0);
  });

  it('rejects a coverage buffer of the wrong size', () => {
    const dome = new CloudDome();
    expect(() => dome.setCoverageTexture(new Uint8Array(4), true)).toThrow();
  });

  it('pins to the camera and scales inside the sky gradient dome`s far * 0.9', () => {
    const dome = new CloudDome();
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    camera.position.set(10, 20, 30);

    dome.update(camera);

    expect(dome.position.x).toBe(10);
    expect(dome.position.y).toBe(20);
    expect(dome.position.z).toBe(30);
    expect(dome.scale.x).toBeCloseTo(1000 * 0.87, 5);
  });

  it('falls back to a default far plane when the camera does not expose one', () => {
    const dome = new CloudDome();
    const camera = new THREE.Camera();

    dome.update(camera);

    expect(dome.scale.x).toBeCloseTo(500 * 0.87, 5);
  });
});
