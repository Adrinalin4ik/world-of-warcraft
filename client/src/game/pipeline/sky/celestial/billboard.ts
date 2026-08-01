import * as THREE from 'three';
import { billboardPosition, CELESTIAL_DISTANCE, horizonClipFade } from '../../../world/sky/celestial/laws';

/**
 * The shared celestial billboard -- the ONE thing every sun/moon disc and glare is
 * (`docs/superpowers/plans/2026-08-01-celestial-sky.md`, Task 1): a camera-anchored textured quad at
 * `cam + 12*dir` (world space, no local->world rotation -- the reference's `0x6d3b80` builder),
 * tinted per frame off `MapLight.celestialTint`, and routed through the shared horizon clip+fade
 * (`laws.horizonClipFade`, the reference's `0x6d1960`) when the caller asks for it.
 *
 * This file owns ONLY the mesh, material and per-frame placement -- it takes a texture, a tint, a
 * direction and a scale, and knows nothing about which body it is. Tasks 2-5 (the sun disc, stars,
 * the moons, the glare) are CONFIGURATION of this class, not new rendering code: construct one per
 * sprite (disc or glare), call `setTexture`/`setTint`/`setScale` once, and `update(camera, dir)` every
 * frame. If a later task has to reach past this seam to add a body, this task failed.
 *
 * Ported from `samples/benilla/crates/benilla/src/sun/mesh.rs`'s `quad_mesh` (a unit quad, UV 0..1)
 * and `sun/materials.rs`'s `CelestialExt`/`DISC_HORIZON_FADE` (the disc clip+fade mode; the additive
 * glare mode skips the clip -- `applyHorizonFade: false` -- exactly as the reference's glares never
 * route `0x6d1960`, gated by their own envelope instead). Follows the camera-anchored sky idiom this
 * client already established for the gradient dome and `sky/clouds/index.ts`'s cloud dome:
 * `renderOrder`, `depthTest`/`depthWrite` off, camera-pinned, `frustumCulled = false`.
 *
 * ## Placement and orientation
 *
 * `update(camera, dir)` places the quad at `cam + 12*dir` (`laws.billboardPosition`) and orients its
 * local +Z axis to face back at the camera -- exactly `-dir`, since by construction the vector from
 * the quad to the camera IS `-dir` (the quad sits 12 units from the camera along `dir`). This mirrors
 * the reference's own `Quat::from_rotation_arc(Vec3::Z, -to_light)` (`follow.rs`), and needs no
 * separate "face the camera" step: the direction vector alone determines both position and
 * orientation for a body placed this way.
 *
 * `dir` must be a UNIT vector in this client's unpermuted WoW frame (Z up) -- the frame
 * `MapLight.cloudGlowDir` and `laws.moonDirection` (`world/light/laws.ts`) already produce. A
 * zero-length direction (no resolved body yet) hides the sprite rather than placing it at the camera.
 *
 * ## The tint law (Risk 1 of the plan)
 *
 * The discs' and glares' RGB is NOT hardcoded -- `MapLight.celestialTint` (the newly-blended
 * `LIGHT_INT_BAND.BAND_SUN_COLOR`) drives every one of them, every frame, alpha forced to 1 on the
 * COLOUR side (the reference's per-frame 0xFF diffuse broadcast). `setTint`'s `alpha` parameter is a
 * SEPARATE multiplier -- the body's own opacity law (day curve, view-lerp flare intensity, weather
 * seed, ...) -- not the colour's own alpha byte; the two multiply together in the shader
 * (`uAlpha = tintAlpha * horizonFade`).
 *
 * ## The white-fringe trap (see `d348889`, and `sky/clouds/index.ts`'s own module doc)
 *
 * Any partial-alpha sky material must never let its blend state touch the framebuffer's alpha
 * channel, or a canvas composited over the page (three.js `premultipliedAlpha: true`) picks up
 * `(1 - a)` of whatever sits behind it. `blendSrcAlpha = ZeroFactor` / `blendDstAlpha = OneFactor`
 * pins the alpha channel at the cleared 1.0 regardless of the RGB blend mode, exactly the fix
 * `d348889` applied to M2's `applyBlendingMode` and the cloud dome repeats.
 */

/** A unit quad in the XY plane, UV 0..1 -- ported verbatim from `sun/mesh.rs::quad_mesh` (the
 * reference's own billboard geometry; only the winding is preserved, not the Y-up axis labels, since
 * this is a flat local-space quad with no up-axis commitment of its own). */
export function buildCelestialQuadGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = [0, 1, 2, 0, 2, 3];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Local +Z, reused every `update` call rather than reallocated. */
const UNIT_Z = new THREE.Vector3(0, 0, 1);

export type CelestialBlendMode = 'alpha' | 'additive';

export interface CelestialBillboardOptions {
  /** The reference's `renderOrder` slot -- see the plan's draw-order ladder (stars -1003, sun disc
   * -1002, white moon -1001, moon02 -1000.5, gradient dome -1000, cloud dome -999, glare +1000). */
  renderOrder: number;
  /** `'alpha'` (the default): the disc mode, premultiplied-alpha blended, routes through the horizon
   * clip+fade when `applyHorizonFade` is true. `'additive'`: the glare mode, gamma-ADDS onto the
   * scene (the reference's SRC_ALPHA, ONE lens-flare blend) and never clips at the horizon -- its own
   * envelope gates it instead. */
  blending?: CelestialBlendMode;
  /** Whether this sprite routes through `laws.horizonClipFade`. Discs: `true` (the default). Glares:
   * `false` -- the reference's glares never route `0x6d1960` (see `sun/mod.rs`'s module doc). */
  applyHorizonFade?: boolean;
  /** The near-sphere radius (`laws.CELESTIAL_DISTANCE` by default) every body places at. */
  distance?: number;
}

/**
 * One celestial sprite -- a disc or a glare, selected entirely by the constructor options above.
 * Construct one per sprite; Tasks 2-5 own the loop that constructs however many they need (a sun
 * needs two: a disc and a glare) and feed each its own texture/tint/scale/direction.
 */
class CelestialBillboard extends THREE.Mesh {
  private readonly applyHorizonFade: boolean;

  private readonly distance: number;

  /** The body's own opacity multiplier (the caller's day curve / view-lerp / weather seed, NOT the
   * tint colour's own alpha byte -- see this file's module doc). Combined with the horizon fade each
   * `update()` into the shader's `uAlpha`. */
  private tintAlpha = 1;

  constructor(texture: THREE.Texture, options: CelestialBillboardOptions) {
    super();
    this.applyHorizonFade = options.applyHorizonFade ?? true;
    this.distance = options.distance ?? CELESTIAL_DISTANCE;

    this.geometry = buildCelestialQuadGeometry();
    this.material = CelestialBillboard.buildMaterial(texture, options.blending ?? 'alpha');

    this.renderOrder = options.renderOrder;
    // Camera-anchored every frame, like the gradient dome and the cloud dome -- a fixed world-space
    // bounding box would be meaningless and could cull the sprite as the camera moves.
    this.frustumCulled = false;
  }

  private static buildMaterial(texture: THREE.Texture, blending: CelestialBlendMode): THREE.ShaderMaterial {
    const additive = blending === 'additive';

    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        // rgb: the celestial diffuse tint (`MapLight.celestialTint`). a: the body's own opacity
        // multiplier x the horizon fade, combined once per frame in `update()` -- see the module doc.
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAlpha: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 uColor;
        uniform float uAlpha;
        varying vec2 vUv;

        void main() {
          vec4 texel = texture2D(map, vUv);
          float a = texel.a * uAlpha;
          // Premultiplied output, matching the cloud dome's own shader -- the fragment premultiplies
          // RGB by its own alpha rather than leaning on a GL premultiply blend factor.
          gl_FragColor = vec4(texel.rgb * uColor * a, a);

          // THE SKY DEPTH LAW (the reference's SKY_FAR_DEPTH). Force every celestial fragment to the
          // maximum depth so it survives only where the depth buffer still holds its cleared value --
          // exactly where no world geometry drew. Without it a body draws through mountains and
          // buildings, because a transparent material is drawn AFTER all opaque geometry (see the
          // depthTest note on the material below) and its shell radius does not order it against
          // the world. No backticks in this comment: it lives inside a JS template literal.
          gl_FragDepth = 1.0;
        }
      `,
      transparent: true,
      depthWrite: false,
      // depthTest MUST be on for a TRANSPARENT sky element. three.js draws every transparent
      // material after every opaque one; `renderOrder` sorts only within a pass and cannot lift a
      // transparent object ahead of opaque geometry. The gradient dome gets away with the test off
      // only because it is `transparent: false`, so its `renderOrder = -1000` genuinely puts it
      // first. A celestial billboard is transparent, so the depth test against the forced far depth
      // above is the only thing that lets terrain occlude it. `depthWrite` stays off so bodies never
      // occlude each other -- the ladder's `renderOrder` decides that.
      depthTest: true,
      side: THREE.DoubleSide,
      // The white-fringe trap (module doc): RGB blends premultiplied-over (src ONE, since the shader
      // already premultiplies) for the alpha mode, or gamma-ADDS for the glare mode; the ALPHA channel
      // is pinned Zero/One either way so this material never writes the framebuffer's alpha byte.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
  }

  private get shaderMaterial(): THREE.ShaderMaterial {
    return this.material as THREE.ShaderMaterial;
  }

  /** Swap the sprite's texture (e.g. once the real BLP resolves over an assetless placeholder). */
  public setTexture(texture: THREE.Texture): void {
    this.shaderMaterial.uniforms.map.value = texture;
  }

  /**
   * The celestial diffuse tint (`MapLight.celestialTint`, alpha forced to 1 on the colour side per
   * the reference's per-frame 0xFF broadcast) and this sprite's own opacity multiplier -- the body's
   * day curve, view-lerp flare intensity, or weather seed, NOT a second colour alpha. Call every
   * frame the tint or the body's own envelope changes; `update()` folds in the horizon fade on top.
   */
  public setTint(color: THREE.Color, alpha: number): void {
    this.shaderMaterial.uniforms.uColor.value.copy(color);
    this.tintAlpha = alpha;
  }

  /** The quad's world-space size at the shared near-sphere distance -- directly the angular size,
   * since 1 world unit of quad scale at `laws.CELESTIAL_DISTANCE` subtends a fixed angle (the
   * reference's unit-quad-at-12 convention, `sun/follow.rs::SUN_SIZE`). */
  public setScale(units: number): void {
    this.scale.setScalar(units);
  }

  /**
   * Place and orient the sprite for this frame, and resolve its alpha (tint alpha x horizon fade).
   * `dir` is the unit camera->body direction, this client's unpermuted WoW (Z-up) frame -- see the
   * module doc. A zero-length direction (no resolved body) hides the sprite instead of placing it at
   * the camera.
   */
  public update(camera: THREE.Camera, dir: THREE.Vector3): void {
    if (dir.lengthSq() < 1e-12) {
      this.visible = false;
      return;
    }
    this.visible = true;

    const pos = billboardPosition(camera.position, dir, this.distance);
    this.position.set(pos.x, pos.y, pos.z);

    // Local +Z faces back toward the camera: by construction the quad-to-camera vector IS -dir (the
    // quad sits `distance` units from the camera along `dir`) -- see the module doc.
    const target = new THREE.Vector3(-dir.x, -dir.y, -dir.z).normalize();
    this.quaternion.setFromUnitVectors(UNIT_Z, target);

    const fade = this.applyHorizonFade ? horizonClipFade(dir.z) : 1;
    this.shaderMaterial.uniforms.uAlpha.value = this.tintAlpha * fade;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.shaderMaterial.dispose();
  }
}

export default CelestialBillboard;
