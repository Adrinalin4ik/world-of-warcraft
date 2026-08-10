import * as THREE from 'three';
import { DecodeStream } from 'restructure';
import M2 from '../../../../wow-data-parser/m2';
import Skin from '../../../../wow-data-parser/m2/skin';
import Loader from '../../../net/loader';
import TextureLoader from '../../texture-loader';
import { CELESTIAL_DISTANCE } from '../../../world/sky/celestial/laws';
import { starGlobalAlpha } from '../../../world/light/laws';

/**
 * The night-sky stars (celestial-sky plan, Task 3): the real `Environments\Stars\Stars.m2` -- 7
 * textured patches covering an upper hemisphere, camera-anchored -- the FIRST celestial draw
 * (`renderOrder = -1003`, the plan's ladder), everything else paints over them.
 *
 * ## Why this does not go through `M2ManagerLite`
 *
 * The plan's own text says to load the model through `M2ManagerLite`. That manager's loader,
 * `M2LoaderLite`, is dead scaffolding: `M2LoaderLite.load()` ignores the path it is given and always
 * returns a hardcoded placeholder cube (`createPlaceholderM2Data`) -- there is no real M2 parser
 * behind it at all, and `M2ManagerLite.addInstance()` wraps whatever geometry it is handed in
 * `M2MaterialLite`, a general lit material with no depth-law shader and no per-batch weight concept.
 * Routing Stars.m2 through it would not load the real 7-patch model; it would render a fake cube
 * with the wrong material. Reference fidelity (this project's own stated preference) means loading
 * the real model, so this file decodes `Stars.m2` + its `.skin` directly with the SAME M2/Skin
 * binary parsers `pipeline/m2/loader.js` already uses for the full M2 pipeline (`wow-data-parser/m2`,
 * `wow-data-parser/m2/skin`), and builds its own geometry + a small depth-law shader modelled on
 * `CelestialBillboard`'s (Task 1) -- because the star dome is not a single billboard quad, it is
 * several independently-textured, independently-weighted patches with no per-body direction of their
 * own (see below).
 *
 * ## Geometry convention
 *
 * `pipeline/m2/index.ts::createGeometry` puts every M2 vertex through a swizzle-then-rotate round
 * trip (`(x,y,z) -> (x,z,-y)`, scale `(-1,-1,1)`, then `rotateX(-PI/2)`) to land in this client's
 * Z-up scene. Composing those three steps algebraically cancels the intermediate Y-up detour and
 * reduces to one thing: negate X and Y, keep Z. That reduced form is applied directly here rather
 * than reconstructing the matrix dance, since Stars.m2 is static geometry with no bones to carry
 * through it.
 *
 * ## Placement
 *
 * Not a single `cam + dir*distance` point like a disc -- the whole patch set is camera-anchored
 * (translated to the camera every frame) and scaled uniformly to [`CELESTIAL_DISTANCE`], the same
 * near-sphere every other celestial body sits on in this client (see `world/sky/celestial/laws.ts`'s
 * own module doc: nothing in this sky depth-tests against a shell radius, so there is no reason to
 * split stars onto a different shell than the discs/glares). Patch positions are normalised to a
 * unit dome at load time (dividing by the model's own max vertex radius) so the uniform
 * `CELESTIAL_DISTANCE` scale reproduces the authored relative dot sizes, mirroring benilla
 * `sun/setup.rs`'s own normalise-then-scale step.
 *
 * ## Alpha: two multiplied terms, per the plan
 *
 * `uAlpha = starGlobalAlpha(minute) * patch.weight` -- the model-global star curve (`laws.
 * starGlobalAlpha`, ported from `daynight.rs::STAR_CURVE` + `follow.rs`'s byte quantization) times
 * EACH patch's own authored transparency weight (`Stars.m2`'s per-batch alpha-anim constant, sampled
 * at t=0 since the model is fully static -- see `loadStarPatches`). Losing the per-patch term makes
 * every star group equally bright, which the plan calls out by name.
 *
 * ## The depth law
 *
 * Transparent, so it draws after every opaque object regardless of `renderOrder` (three.js's own
 * pass split) -- `depthTest: true`, `depthWrite: false`, and the fragment shader forces
 * `gl_FragDepth = 1.0`, exactly like `CelestialBillboard` and the cloud dome, or stars would shine
 * through mountains (`sky-depth-law.test.ts` enforces this across every transparent sky element;
 * this file's material is added to it). `blendSrcAlpha = ZeroFactor` / `blendDstAlpha = OneFactor`
 * keeps this material from ever writing the framebuffer alpha channel (the white-fringe class,
 * `d348889`).
 *
 * ## The fallback
 *
 * If the asset does not resolve, the plan asks for a fallback that reads as OBVIOUSLY a fallback
 * rather than a plausible star field -- the opposite of benilla's own `star_field_mesh`, which is
 * deliberately built to look like real stars. `buildFallbackGeometry` scatters a handful of large
 * flat-magenta quads instead: unmissable, and never mistakable for the real 7-patch dome.
 */

const STAR_MODEL_PATH = 'Environments\\Stars\\Stars.m2';
const STAR_TEXTURE_WHITE = 'Environments\\Stars\\Stars.blp';
const STAR_TEXTURE_BLUE = 'Environments\\Stars\\Stars2.blp';

/** The plan's draw-order ladder: stars -1003, sun disc -1002, white moon -1001, ... */
export const STARS_RENDER_ORDER = -1003;

/** The minimal shape `Stars.updateFromLight` needs off `MapLight` -- see `sun.ts`'s own
 * `CelestialLightSource` for why this is a structural interface rather than importing the class. */
export interface StarLightSource {
  readonly timeProgression: number;
}

type StarPatch = {
  geometry: THREE.BufferGeometry;
  /** Which of the two star textures this patch samples. */
  isBlue: boolean;
  /** The patch's own authored transparency weight (1.0 down to ~0.25 across `Stars.m2`'s batches). */
  weight: number;
};

/** Build the depth-law star material: premultiplied gamma-correct blend, textured, one scalar
 * `uAlpha` uniform the caller drives every frame (global star curve x patch weight). Shared by both
 * the real patches and the fallback quads, so both get the SAME depth-law guarantees. */
function buildStarMaterial(texture: THREE.Texture, tint: THREE.Color = new THREE.Color(1, 1, 1)): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      uTint: { value: tint },
      uAlpha: { value: 0 },
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
      uniform vec3 uTint;
      uniform float uAlpha;
      varying vec2 vUv;

      void main() {
        vec4 texel = texture2D(map, vUv);
        float a = texel.a * uAlpha;
        // Premultiplied output, matching CelestialBillboard's disc mode and the cloud dome.
        gl_FragColor = vec4(texel.rgb * uTint * a, a);

        // THE SKY DEPTH LAW. Force every star fragment to the maximum depth so it survives only
        // where the depth buffer still holds its cleared value -- exactly where no world geometry
        // drew. No backticks in this comment: it lives inside a JS template literal.
        gl_FragDepth = 1.0;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/** Deterministic per-star pseudo-random in `[0,1)` from an index -- a small integer bit-mix/hash, no
 * `Math.random` so the fallback field is stable across runs. Ported from benilla `mesh.rs::hash01`. */
function hash01(n: number): number {
  let x = (Math.imul(n, 747796405) + 2891336453) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x & 0x00ffffff) / 0x01000000;
}

/**
 * The assetless/failure fallback geometry: a handful of large flat quads scattered over the upper
 * hemisphere, unit-sphere radius (scaled to [`CELESTIAL_DISTANCE`] like the real patches). Deliberately
 * NOT shaped like a plausible star field (the plan's own instruction) -- few, big, and paired with a
 * solid-magenta 1x1 texture in [`buildFallbackTexture`] rather than the real dot sprite, so a
 * developer sees "asset missing" at a glance instead of dim, plausible stars.
 */
function buildFallbackGeometry(count = 24): THREE.BufferGeometry {
  const SIZE = 0.05; // an order of magnitude bigger than a real star dot -- deliberately obvious
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const up = new THREE.Vector3(0, 0, 1);

  for (let i = 0; i < count; i++) {
    const az = hash01(i * 3) * Math.PI * 2;
    const z = 0.3 + 0.65 * hash01(i * 3 + 1); // upper hemisphere, well clear of the horizon
    const h = Math.sqrt(Math.max(0, 1 - z * z));
    const dir = new THREE.Vector3(h * Math.cos(az), h * Math.sin(az), z);

    let right = new THREE.Vector3().crossVectors(dir, up);
    if (right.lengthSq() < 1e-6) {
      right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(1, 0, 0));
    }
    right.normalize();
    const upTangent = new THREE.Vector3().crossVectors(dir, right).normalize();

    const base = positions.length / 3;
    const corners: Array<[number, number, [number, number]]> = [
      [-1, -1, [0, 1]],
      [1, -1, [1, 1]],
      [1, 1, [1, 0]],
      [-1, 1, [0, 0]],
    ];
    for (const [dx, dy, uv] of corners) {
      const p = dir.clone().addScaledVector(right, dx * SIZE).addScaledVector(upTangent, dy * SIZE);
      positions.push(p.x, p.y, p.z);
      uvs.push(uv[0], uv[1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

/** A solid, opaque, unmistakably-not-a-star magenta 1x1 texture for the fallback quads -- a
 * `DataTexture` rather than a canvas bake, so it needs no DOM and works the same in a jest `node`
 * environment as it does in the browser. */
function buildFallbackTexture(): THREE.DataTexture {
  const data = new Uint8Array([255, 0, 255, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Parse `Stars.m2` + its `.skin` with the real M2/Skin binary decoders (the same ones
 * `pipeline/m2/loader.js` uses) and turn each skin batch into one [`StarPatch`]: geometry (normalised
 * to a unit dome), which of the two star textures it samples, and its own authored transparency
 * weight sampled at t=0 (the model is fully static, so any sample point gives the same constant --
 * `Stars.m2`'s weights run 1.0 down to ~0.25 across its batches, per the plan).
 */
async function loadStarPatches(): Promise<StarPatch[]> {
  const loader = new Loader();

  const raw = await loader.load(STAR_MODEL_PATH);
  const data = M2.decode(new DecodeStream(Buffer.from(new Uint8Array(raw))));

  const quality = Math.max(0, data.viewCount - 1);
  const skinPath = STAR_MODEL_PATH.replace(/\.m2/i, `0${quality}.skin`);
  const rawSkin = await loader.load(skinPath);
  const skinData = Skin.decode(new DecodeStream(Buffer.from(new Uint8Array(rawSkin))));

  const patches: StarPatch[] = [];

  for (const batch of skinData.batches) {
    const submesh = skinData.submeshes[batch.submeshIndex];
    if (!submesh || submesh.triangleCount === 0) {
      continue;
    }

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const remap = new Map<number, number>();

    for (let i = submesh.startTriangle; i < submesh.startTriangle + submesh.triangleCount; i++) {
      const vertexIndex = skinData.indices[skinData.triangles[i]];
      let local = remap.get(vertexIndex);
      if (local === undefined) {
        const vertex = data.vertices[vertexIndex];
        const [x, y, z] = vertex.position;
        // The reduced M2->engine swizzle (this file's module doc): negate X and Y, keep Z.
        positions.push(-x, -y, z);
        const uv = vertex.textureCoords[0];
        uvs.push(uv[0], uv[1]);
        local = remap.size;
        remap.set(vertexIndex, local);
      }
      indices.push(local);
    }

    if (positions.length === 0) {
      continue;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);

    // Op 0 only -- Stars.m2's batches are single-texture (no layered/env-mapped ops).
    const textureIndex = data.textureLookups[batch.textureLookup];
    const texture = data.textures[textureIndex];
    const filename: string = (texture && texture.filename) || '';
    const isBlue = filename.toLowerCase().includes('stars2');

    // The authored transparency weight (Task 3's brief): the alpha-combine bake carries any non-1
    // constant as a single baked keyframe -- sampling it at t=0 is exactly right since Stars.m2 has
    // no bones and no time-varying transparency of its own.
    const transparencyIndex = data.transparencyAnimationLookups[batch.transparencyAnimationLookup];
    const transparencyAnim = data.transparencyAnimations[transparencyIndex];
    const weight = transparencyAnim && transparencyAnim.firstKeyframe
      ? transparencyAnim.firstKeyframe.value
      : 1.0;

    patches.push({ geometry, isBlue, weight });
  }

  // Normalise every patch to a unit dome so the uniform CELESTIAL_DISTANCE scale (applied every
  // frame in `updateFromLight`) reproduces the authored relative dot sizes -- benilla `sun/setup.rs`
  // applies the same normalise-then-scale step.
  let maxRadius = 1e-3;
  for (const patch of patches) {
    const position = patch.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
      if (r > maxRadius) {
        maxRadius = r;
      }
    }
  }
  for (const patch of patches) {
    patch.geometry.scale(1 / maxRadius, 1 / maxRadius, 1 / maxRadius);
  }

  return patches;
}

type StarMeshEntry = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  weight: number;
};

/**
 * The night-sky star dome. Constructed empty; the real `Stars.m2` patches (or, on failure, the
 * obvious-fallback quads) populate it once the async load settles, so `updateFromLight` is always
 * safe to call from frame one.
 */
class Stars extends THREE.Group {
  private entries: StarMeshEntry[] = [];

  private disposedFlag = false;

  constructor() {
    super();
    this.name = 'Stars';

    loadStarPatches()
      .then((patches) => {
        if (this.disposedFlag) {
          return;
        }
        if (patches.length === 0) {
          console.warn('Stars: Environments\\Stars\\Stars.m2 decoded to zero patches -- using the fallback field');
          this.buildFallback();
          return;
        }
        this.buildFromPatches(patches);
      })
      .catch((error: unknown) => {
        console.error('Stars: failed to load Environments\\Stars\\Stars.m2 -- falling back to the obvious placeholder field:', error);
        if (!this.disposedFlag) {
          this.buildFallback();
        }
      });
  }

  private buildFromPatches(patches: StarPatch[]): void {
    for (const patch of patches) {
      const material = buildStarMaterial(TextureLoader.PLACEHOLDER);
      const mesh = new THREE.Mesh(patch.geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = STARS_RENDER_ORDER;
      this.add(mesh);
      this.entries.push({ mesh, material, weight: patch.weight });

      const texturePath = patch.isBlue ? STAR_TEXTURE_BLUE : STAR_TEXTURE_WHITE;
      TextureLoader.load(texturePath)
        .then((texture: THREE.Texture) => {
          if (this.disposedFlag) {
            TextureLoader.unload(texture);
            return;
          }
          material.uniforms.map.value = texture;
        })
        .catch((error: unknown) => {
          console.error(`Stars: failed to load ${texturePath}:`, error);
        });
    }
  }

  private buildFallback(): void {
    const texture = buildFallbackTexture();
    // Solid magenta tint on top of the already-magenta texture -- belt and braces against a future
    // edit that swaps the texture for something plausible without noticing this path must stay loud.
    const material = buildStarMaterial(texture, new THREE.Color(1, 0, 1));
    const mesh = new THREE.Mesh(buildFallbackGeometry(), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = STARS_RENDER_ORDER;
    this.add(mesh);
    this.entries.push({ mesh, material, weight: 1.0 });
  }

  /**
   * Per-frame: camera-anchor the whole dome, and drive every patch's alpha = the global star curve
   * (`laws.starGlobalAlpha`) x that patch's own authored weight. Follows the same
   * read-MapLight/delegate-placement shape `SunDisc.updateFromLight` established.
   */
  public updateFromLight(camera: THREE.Camera, light: StarLightSource): void {
    this.position.copy(camera.position);
    this.scale.setScalar(CELESTIAL_DISTANCE);

    const minute = light.timeProgression * 1440;
    const global = starGlobalAlpha(minute);

    for (const entry of this.entries) {
      entry.material.uniforms.uAlpha.value = global * entry.weight;
    }
  }

  public dispose(): void {
    this.disposedFlag = true;
    for (const entry of this.entries) {
      entry.mesh.geometry.dispose();
      const map = entry.material.uniforms.map.value as THREE.Texture | null;
      entry.material.dispose();
      if (map && map !== TextureLoader.PLACEHOLDER) {
        TextureLoader.unload(map);
      }
    }
    this.entries = [];
  }
}

export default Stars;
export { buildStarMaterial };
