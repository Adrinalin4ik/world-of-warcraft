import * as THREE from 'three';

/**
 * The visible cloud dome (procedural-clouds plan, Task 5) -- the drawn half of the shared
 * coverage-field design (see the plan's "architecture" section): the same 128x128 RGBA tile the
 * (separately-owned) kernel builds for glare occlusion is rendered here as a texture, so a cloud
 * on screen and a cloud dimming the sun/moon can never desynchronize.
 *
 * Ported from `samples/benilla/crates/benilla/src/clouds/layer.rs`'s `cloud_dome_mesh`
 * (`0x6d0530`) and `cloud.wgsl`'s fragment shader. This file owns ONLY the mesh, material and
 * camera-follow -- it takes the coverage bytes as an injected `Uint8Array` (see `setCoverageTexture`
 * below) and knows nothing about the kernel, the noise walk or `MapLight`. Whoever wires the kernel
 * (Task 6, not this file) calls that one method once per frame.
 *
 * ## Frame convention
 *
 * This client is unpermuted WoW (Z up), NOT the reference's Bevy (Y up) -- confirmed against
 * `MapLight#updateSunDirection`'s own spherical convention (`z = cos(phi)`, doc comment: "Both
 * vectors are in this client's unpermuted WoW frame (Z up)"). The reference's mesh recentres on Y
 * (`phi.cos() - shift`) with (x, z) as the horizontal plane; here the up axis is Z, so the recentre
 * lands on Z and the horizontal plane is (x, y). The pole therefore sits at `z = +1` and the rim at
 * `z = 0` (not `y`, as the reference's own test asserts it).
 *
 * The UV mapping preserves the reference's STRUCTURE, not its axis labels: `u` tracks the `sin`
 * horizontal component, `v` the `cos` horizontal component -- which in the reference's Y-up frame
 * are (world x, world z) and here are (world x, world y), since Y is no longer "the other
 * horizontal axis" once Z is up. Whatever ends up sampling this same field for occlusion must use
 * the identical (x, y) horizontal pair, or the drawn cloud and the sampled occlusion stop
 * co-locating -- the entire point of the shared field.
 *
 * ## Depth/order/placement
 *
 * The reference relies on a squashed depth-range slice this client does not use (see
 * `sky/procedural/index.ts`'s own module doc for the equivalent reasoning on the sky gradient dome,
 * including the radius/winding bugs that made that dome invisible until fixed). This dome instead:
 * - `renderOrder = -999`, immediately after the sky gradient's `-1000` and before all world
 *   geometry, so terrain occludes the clouds through ordinary depth testing rather than a shader
 *   trick.
 * - `depthWrite: false`, `depthTest: false` (matching the sky dome).
 * - Uniform radius per vertex (not the reference's squashed cap), scaled to the camera's actual
 *   `far * 0.87` every frame -- inside the sky gradient dome's `far * 0.9`, so the clouds sit
 *   between the terrain and the sky rather than clipping through either.
 * - Pinned to the camera position each frame, matching the sky dome's `follow_camera` idiom.
 *
 * ## The white-fringe trap (see `d348889`)
 *
 * A canvas composited over the page plus three.js's `premultipliedAlpha: true` context means any
 * fragment that leaves sub-1 alpha in the framebuffer picks up `(1 - a)` of whatever sits behind the
 * canvas. `d348889` fixed this for M2 (`applyBlendingMode`) by routing the alpha *framebuffer*
 * channel through `blendSrcAlpha = Zero` / `blendDstAlpha = One` so draws never touch it, independent
 * of whatever the RGB blend does. That fix does not cover this material, so it is repeated here.
 * (This client's renderer has SEPARATELY been switched to `alpha: false` -- an opaque drawing buffer
 * -- in that same commit, which would mask this class of bug on its own; the Zero/One factors below
 * are kept anyway as the actual regression guard `d348889` established, in case that renderer flag
 * ever moves back, and because it is one line.)
 *
 * The RGB side follows the reference's own `cloud.wgsl` exactly: color math (gradient + glow) already
 * happened CPU-side into gamma bytes, and the shader premultiplies by the combined coverage/rim alpha
 * itself (`texel.rgb * a, a`) rather than leaning on GL blend-factor premultiplication -- so the alpha
 * channel is only ever touched by depth/blend STATE (which we override to Zero/One), never by the
 * fragment's own alpha output value.
 *
 * ## The texture's colour space
 *
 * `texture.colorSpace = THREE.NoColorSpace`. The texels are the kernel's own gamma bytes (already
 * colour-managed CPU-side, matching the reference's non-sRGB texture format) and this client's whole
 * lighting pipeline runs on the gamma-passthrough lane (`renderer.outputColorSpace =
 * THREE.LinearSRGBColorSpace`, see `sky/procedural/index.ts` and `pages/game/index.tsx`). `NoColorSpace`
 * is three.js's explicit "never decode, pass the bytes through raw" value -- distinct from leaving the
 * field at its default (which happens to also be `NoColorSpace` today, but would silently start
 * sRGB-decoding the field if three.js ever changed that default, the same class of surprise `r152`'s
 * output-colour-space default change caused for the renderer itself, per that file's own comment).
 */

/** 128x128 RGBA8 coverage tile -- matches the (separately-owned) kernel's `COLS`. */
export const CLOUD_TEXTURE_SIZE = 128;

/** Ring co-latitude fractions x pi (`0x811570`, `0x6d0530`): pole -> the 45-degree rim, bunched
 * toward the rim. Copied verbatim from `layer.rs`'s `RING_COLAT`. */
const RING_COLAT = [
  0.0, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.205, 0.23, 0.245, 0.25,
];

/** Per-ring vertex alpha (`0x8115a0`): opaque inner 9 rings, half ring 10, transparent rim. Copied
 * verbatim from `layer.rs`'s `RING_ALPHA`. */
const RING_ALPHA = [1, 1, 1, 1, 1, 1, 1, 1, 1, 128 / 255, 0, 0];

const RINGS = RING_COLAT.length; // 12
const AZ_STEPS = 16;

/**
 * The reference dome (`0x6d0530`, radius 1) rebuilt in this client's Z-up frame: positions
 * recentred `-cos(pi/4)` along Z so the rim sits at eye level, then pushed to UNIFORM radius (the
 * reference relies on a squashed depth range at real depth instead -- see the module doc). Polar UV
 * `(sin*V + 0.5, cos*V + 0.5)` with `V = ring / 24`, `u` off world x and `v` off world y (this
 * frame's other horizontal axis -- see the module doc's frame-convention section). Normals are the
 * unit sky direction. Exported for direct testing against the reference's own mesh assertions.
 */
export function buildCloudDomeGeometry(): THREE.BufferGeometry {
  const shift = Math.cos(Math.PI / 4);

  const positions = new Float32Array(RINGS * AZ_STEPS * 3);
  const normals = new Float32Array(RINGS * AZ_STEPS * 3);
  const uvs = new Float32Array(RINGS * AZ_STEPS * 2);
  const alphas = new Float32Array(RINGS * AZ_STEPS);

  let v = 0;
  for (let ring = 0; ring < RINGS; ring++) {
    const phi = RING_COLAT[ring] * Math.PI;
    const alpha = RING_ALPHA[ring];
    const vr = ring / 24; // polar UV radius
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let j = 0; j < AZ_STEPS; j++) {
      const az = (j / AZ_STEPS) * Math.PI * 2;
      const sa = Math.sin(az);
      const ca = Math.cos(az);

      // Recentred sky direction: Z (up in this frame) carries the `cos(phi) - shift` recentre; X/Y
      // are the horizontal plane the reference builds from (x, z) in its own Y-up frame.
      const x = sinPhi * sa;
      const y = sinPhi * ca;
      const z = cosPhi - shift;
      const len = Math.hypot(x, y, z) || 1;
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      positions[v * 3] = nx;
      positions[v * 3 + 1] = ny;
      positions[v * 3 + 2] = nz;

      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;

      // u <- world x, v <- world y (this frame's stand-in for the reference's world z -- see the
      // module doc). Must match whatever samples the same coverage field for occlusion.
      uvs[v * 2] = sa * vr + 0.5;
      uvs[v * 2 + 1] = ca * vr + 0.5;

      alphas[v] = alpha;
      v++;
    }
  }

  // The reference's 11 band strips (34 indices each) as a triangle list.
  const indices: number[] = [];
  for (let ring = 0; ring < RINGS - 1; ring++) {
    for (let j = 0; j < AZ_STEPS; j++) {
      const jn = (j + 1) % AZ_STEPS;
      const a = ring * AZ_STEPS + j;
      const b = (ring + 1) * AZ_STEPS + j;
      const c = ring * AZ_STEPS + jn;
      const d = (ring + 1) * AZ_STEPS + jn;
      indices.push(a, b, c, c, b, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
  geometry.setIndex(indices);
  return geometry;
}

class CloudDome extends THREE.Mesh {
  private cloudTexture: THREE.DataTexture;

  constructor() {
    super();
    this.name = 'CloudDome';

    this.createGeometry();
    this.createMaterial();

    this.position.set(0, 0, 0);
    this.frustumCulled = false; // Camera-pinned every frame, like the sky gradient dome.
    this.renderOrder = -999; // Immediately after the sky gradient (-1000), before world geometry.
  }

  private createGeometry(): void {
    this.geometry = buildCloudDomeGeometry();
  }

  private createMaterial(): void {
    // Fully transparent until the kernel's first upload -- matches the reference's own
    // "fully transparent until the field primes" initial image.
    const initial = new Uint8Array(CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4);
    this.cloudTexture = new THREE.DataTexture(
      initial,
      CLOUD_TEXTURE_SIZE,
      CLOUD_TEXTURE_SIZE,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    // Never sRGB-decode: the texels are the kernel's own gamma bytes (see the module doc's
    // colour-space section).
    this.cloudTexture.colorSpace = THREE.NoColorSpace;

    // LINEAR filtering, explicitly. `THREE.DataTexture` defaults BOTH filters to `NearestFilter`,
    // unlike every other texture path -- and a 128x128 tile stretched across the whole sky at
    // nearest reads as a patchwork of large flat squares, which is exactly how this first rendered.
    //
    // Filtering is what the reference expects, not a smoothing liberty: the kernel's colour pass
    // fills `t == 0` cells with the PREVIOUS cell's RGB at alpha 0 rather than leaving them black,
    // and its own comment calls that "the filtering-friendly hole fill". That fill exists solely so
    // a linear sampler blending across a coverage edge pulls neighbouring cloud colour instead of
    // black. Under nearest it is dead code.
    this.cloudTexture.magFilter = THREE.LinearFilter;
    this.cloudTexture.minFilter = THREE.LinearFilter;

    // The tile is TOROIDAL -- `CloudKernel.coverage` masks its lookup with `& (COLS - 1)` on both
    // axes -- so the texture must wrap, not clamp. Clamping stretches the edge row/column outward
    // and puts a seam where the dome's UV crosses the tile boundary.
    this.cloudTexture.wrapS = THREE.RepeatWrapping;
    this.cloudTexture.wrapT = THREE.RepeatWrapping;

    // No mipmaps: the tile is re-uploaded ~10x a second, and each upload would rebuild the whole
    // chain for a texture that is never minified far (it covers the sky, not a distant surface).
    this.cloudTexture.generateMipmaps = false;

    this.cloudTexture.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        cloudTex: { value: this.cloudTexture },
      },
      vertexShader: `
        attribute float alpha;
        varying vec2 vUv;
        varying float vAlpha;

        void main() {
          vUv = uv;
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D cloudTex;
        varying vec2 vUv;
        varying float vAlpha;

        void main() {
          // Byte-for-byte match of the reference's \`cloud.wgsl\`: the texel alpha (curve-mapped
          // coverage) combines with the dome's own per-vertex rim fade, and RGB is premultiplied by
          // that combined alpha IN the shader -- not left to a GL premultiply blend factor -- exactly
          // like the reference's \`vec4(texel.rgb * a, a)\`.
          vec4 texel = texture2D(cloudTex, vUv);
          float a = texel.a * vAlpha;
          gl_FragColor = vec4(texel.rgb * a, a);
        }
      `,
      side: THREE.DoubleSide, // No culling -- the dome is viewed from inside.
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // The white-fringe trap (see the module doc): never let this material touch the framebuffer's
      // alpha channel. RGB keeps the premultiplied-over blend the shader's own output already assumes
      // (src factor One, since the shader premultiplies RGB by alpha itself); alpha stays pinned at
      // the cleared 1.0 via Zero/One, exactly the fix `d348889` applied to M2's `applyBlendingMode`.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });

    this.material = material;
  }

  /**
   * The seam Task 6 (or whoever owns the kernel) calls once per frame: hand over the freshly-built
   * 128x128 RGBA8 coverage tile plus whether its contents actually changed this tick (the kernel's own
   * `tick()`/`rebuild()`/`recolor()` return that signal -- this dome does not re-derive it and does
   * not throttle on its own, per the plan's "no second timer" instruction for Task 6). A `false`
   * signal is a no-op: the GPU keeps sampling the last upload, cheaper than re-uploading unchanged
   * bytes every frame.
   */
  public setCoverageTexture(rgba: Uint8Array, changed: boolean): void {
    if (!changed) {
      return;
    }

    const expected = CLOUD_TEXTURE_SIZE * CLOUD_TEXTURE_SIZE * 4;
    if (rgba.length !== expected) {
      throw new Error(
        `CloudDome.setCoverageTexture: expected ${expected} bytes (${CLOUD_TEXTURE_SIZE}x${CLOUD_TEXTURE_SIZE} RGBA), got ${rgba.length}`,
      );
    }

    (this.cloudTexture.image.data as Uint8Array).set(rgba);
    this.cloudTexture.needsUpdate = true;
  }

  /**
   * Pin the dome to the camera and rescale to its actual `far` plane, mirroring
   * `sky/procedural/index.ts`'s `follow_camera` idiom. Reads `camera.far` rather than assuming a
   * fixed value -- the sky gradient dome's own module doc documents what a hardcoded radius did once
   * the game's actual far clip disagreed with it (silently clipped the whole sky away).
   */
  public update(camera: THREE.Camera): void {
    this.position.copy(camera.position);

    const far = (camera as THREE.PerspectiveCamera).far ?? 500;
    this.scale.setScalar(far * 0.87); // Inside the sky gradient dome's far * 0.9.
  }

  public dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.cloudTexture) {
      this.cloudTexture.dispose();
    }
    if (this.material) {
      if (Array.isArray(this.material)) {
        this.material.forEach((material) => material.dispose());
      } else {
        this.material.dispose();
      }
    }
  }
}

export default CloudDome;
