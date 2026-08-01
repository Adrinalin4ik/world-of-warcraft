import * as THREE from 'three';
import { DecodeStream } from 'restructure';
import M2 from '../../../../wow-data-parser/m2';
import Skin from '../../../../wow-data-parser/m2/skin';
import Loader from '../../../net/loader';
import TextureLoader from '../../texture-loader';
import { applyBlendingModeToMaterial } from '../../m2/material';

/**
 * Shared M2 decode for the two "authored sky as a model" cases this client has (celestial-sky plan,
 * Task 6): the zone skybox (`LightSkybox.dbc`, Step 1) and the WMO skybox (`MOSB`, Step 2). Both are
 * "load a tiny static M2 and draw it as authored, camera-anchored, identity rotation" -- the same
 * treatment `celestial/stars.ts` already gives `Stars.m2` and, per benilla's `wmo_sky.rs` module doc,
 * the treatment the reference itself gives its WMO skybox (`CM2Model`'s matrix stays identity with a
 * ZEROED recentre vector -- the model's own local origin sits exactly at the eye).
 *
 * This does NOT go through `M2ManagerLite` -- see `stars.ts`'s own module doc for why: that manager's
 * loader is dead scaffolding that returns a hardcoded placeholder cube regardless of the path. This
 * file decodes the M2 + `.skin` directly with the same binary parsers `stars.ts` and
 * `pipeline/m2/loader.js` use.
 *
 * ## These are multi-layer, multi-blend-mode, TIME-ANIMATED models
 *
 * Verified against `NagrandSkyBox.m2` (`LightSkybox.dbc` row 12, map 530, 87 batches):
 *
 * 1. Every batch carries a real M2 material with `blendingMode` 2 (alpha blend) or 4 (additive) --
 *    never 0 (opaque). A flat `transparent: false` `MeshBasicMaterial` for every batch paints each
 *    layer's raw RGB straight over whatever drew before it, including wherever a cloud/glow layer's
 *    texture is black at alpha 0 -- Nagrand's large black bands. Fixed by reading each batch's own
 *    `materialIndex` into `data.materials` and threading `blendingMode` through `buildSkyboxMeshes` ->
 *    `buildSkyboxMaterial`, which reuses this client's own WoW-blend-mode mapping
 *    (`applyBlendingModeToMaterial`, extracted from `pipeline/m2/material`'s `M2Material
 *    .applyBlendingMode`) rather than re-deriving GL blend factors here.
 *
 * 2. Fixing (1) alone trades the black bands for a solid white-out: most submeshes are drawn THREE
 *    times, once each with a `..._NIGHT_...`, `..._DAY_...` and `..._SUNSET_...` texture (e.g.
 *    submesh 10 draws `NAGRAND_NIGHT_CLOUDS0X` [batch 16], `NAGRAND_SUNSET_CLOUDS0X` [batch 18] and
 *    `NAGRAND_DAY_CLOUDS0X` [batch 17] in turn) -- three time-of-day variants of the same patch of sky,
 *    meant to be shown one at a time. What actually gates which one is visible right now is NOT static
 *    per-pixel alpha: it's the batch's own `vertexColorAnimationIndex` (-> a per-submesh-group overall
 *    fade, `data.vertexColorAnimations[i].alpha`, looping on a real `globalSequenceID` -- confirmed 0
 *    or 1 on Nagrand, `data.sequences[id]` ms) MULTIPLIED by its `transparencyAnimationLookup` (->
 *    `data.transparencyAnimationLookups[i]` -> `data.transparencyAnimations[j]`, the per-VARIANT
 *    night/day/sunset selector). The transparency track is where this model does something easy to
 *    miss: EVERY entry in `data.transparencyAnimations` reports `globalSequenceID === -1` despite
 *    carrying a real multi-keyframe timeline spanning 320000ms -- because it is not on a GLOBAL
 *    sequence, it is on the model's own single LOCAL animation instead (`track.animationIndex` ->
 *    `data.animations[0]`, `length: 320000`, `probability: 32767` i.e. always active, and matching
 *    `data.sequences[0]` exactly). A static environment model has no `AnimationManager` picking
 *    "Stand" vs "Walk" the way a creature does, so its one sequence is simply always looping, and
 *    `resolveAlphaTrack` uses that sequence's own `length` as the loop duration exactly as it uses
 *    `sequences[globalSequenceID]` for a real global sequence.
 *
 *    Evaluated end-to-end against the real Nagrand data (submesh 10's night/sunset/day triplet, batches
 *    16/18/17), the product crossfades cleanly through a full 320000ms cycle with exactly one variant
 *    "on" (>0) at any sampled instant and a brief overlapping ramp at each transition -- night ->
 *    sunset -> day -> sunset -> night -- confirming this evaluation is correct, not merely plausible.
 *    Get either evaluation wrong (e.g. treat the local-animation track as a static resting value) and
 *    every variant's alpha reads as its keyframe-0 value instead of its CURRENT one -- night/day/sunset
 *    all draw near-opaque at once and wash the sky white with additive batches.
 *
 *    `resolveAlphaTrack` / `evaluateAlphaTrack` below evaluate both against a per-load wall-clock start
 *    (`buildSkyboxMeshes`'s `Date.now()`), and `updateSkyboxAnimatedAlpha` (called every frame by
 *    `Skybox.update`/`WmoSkybox.update`) writes the product into each transparent layer's own
 *    `animatedAlpha` uniform.
 *
 * Batches whose track has exactly one keyframe (a handful of the domes/rays/streams) are genuinely
 * static -- `resolveAlphaTrack` returns their resting value as a constant with no duration to loop,
 * since a single keyframe has nothing to interpolate towards either way.
 *
 * ## Placement
 *
 * `NagrandSkyBox.m2`'s own local extents are a ~263x263x212 shell (x/y +-131, z -78..+133) -- far
 * smaller than the camera's actual far clip (500 in this client's units). Drawn at its authored size,
 * the shell's own boundary edges sit INSIDE the view frustum and are visible as hard angular wedges
 * above a straight seam, with whatever is beyond it (terrain, or the cleared background) showing past
 * its edge. Every other sky shell in this client (the gradient dome, the cloud dome, `Stars.m2`) is
 * normalised to a unit shape at load and rescaled to the camera's own `far` every frame instead of
 * trusting a fixed authored/hardcoded size (`clouds/index.ts`'s own module doc: "a hardcoded radius"
 * once "silently clipped the whole sky away" the moment the far clip disagreed with it). This model
 * gets the same treatment: `loadSkyboxBatches` normalises every batch's geometry by ONE shared max
 * vertex radius across the whole model (not per-batch -- that would distort the shell's authored
 * proportions), and `Skybox`/`WmoSkybox` scale the whole group to `camera.far * 0.9` every frame --
 * the same shell size the gradient dome this model REPLACES already uses (`sky/procedural/index.ts`),
 * so the cloud dome (`far * 0.87`, deliberately just inside it) keeps drawing in front of whichever of
 * the two backdrops is active.
 */

export type SkyboxBatch = {
  geometry: THREE.BufferGeometry;
  /** The batch's own texture path, resolved from the M2's texture-lookup table. Never empty --
   * batches whose texture does not resolve to a filename are dropped in `loadSkyboxBatches` rather
   * than kept with a blank path, since nothing could ever load for them anyway. */
  texturePath: string;
  /** The batch's own M2 material `blendingMode` (0-6, `pipeline/m2/material`'s `applyBlendingModeToMaterial`
   * mapping). Defaults to 0 (opaque) if the batch's `materialIndex` does not resolve to a material --
   * defensive only; every real M2 batch has one. */
  blendingMode: number;
  /** The batch's own overall-fade alpha track (`data.vertexColorAnimations[batch.vertexColorAnimationIndex].alpha`),
   * or `null` if the batch names no vertex-colour animation. See the module doc's point 2. */
  vertexColorAlpha: AlphaTrack | null;
  /** The batch's own time-of-day-variant alpha track (`data.transparencyAnimations[...]` via
   * `batch.transparencyAnimationLookup`), or `null` if the batch names none. See the module doc's
   * point 2. */
  transparencyAlpha: AlphaTrack | null;
};

/** One resolved, ready-to-evaluate alpha animation -- either a real looping `globalSequenceID` timeline
 * (`durationMs > 0`) or a single constant resting value (`durationMs === 0`, `timestamps`/`values` both
 * length 1) for a track with no global sequence and no animation player driving it. See
 * `resolveAlphaTrack`/`evaluateAlphaTrack`. */
export type AlphaTrack = {
  timestamps: number[];
  values: number[];
  durationMs: number;
};

/**
 * Resolve one M2 `AnimationBlock<color16>` (`vertexColorAnimations[i].alpha` or a
 * `transparencyAnimations[j]` entry -- both decode to the same shape, and `color16` already normalises
 * its raw fixed16 to 0..1 at parse time -- see `wow-data-parser/types/color16.js`) into an
 * [`AlphaTrack`].
 *
 * A block with `globalSequenceID > -1` loops on that global sequence's own duration
 * (`sequences[globalSequenceID]`, ms) independently of any animation player -- this is
 * `vertexColorAnimations`' own mechanism on `NagrandSkyBox.m2` (globalSequenceID 0 or 1).
 *
 * A block with NO global sequence but more than one keyframe is bound to a LOCAL animation instead
 * (`track.animationIndex` -> `data.animations[i]`) -- confirmed against the SAME model's
 * `transparencyAnimations` (every one of its 14 entries has `globalSequenceID === -1` but up to 10
 * keyframes spanning a full 320000ms). That is `NagrandSkyBox.m2`'s ONLY animation (`animations[0]`,
 * `length: 320000`, `probability: 32767` -- i.e. always active): a static environment model has no
 * `AnimationManager` picking "Stand" vs "Walk", so its one sequence is simply always looping, and its
 * `length` is this track's loop duration. A track with exactly one keyframe (truly static) needs no
 * duration at all and is left constant either way.
 */
export function resolveAlphaTrack(block: any, sequences: number[], animations: any[]): AlphaTrack | null {
  if (!block) {
    return null;
  }

  const track = block.tracks[0];
  if (!track || track.timestamps.length === 0) {
    return null;
  }

  if (track.timestamps.length === 1) {
    return { timestamps: track.timestamps, values: track.values, durationMs: 0 };
  }

  let durationMs = 0;
  if (block.globalSequenceID > -1) {
    durationMs = sequences[block.globalSequenceID] || 0;
  } else {
    const animation = animations[track.animationIndex];
    durationMs = animation ? animation.length : 0;
  }

  return { timestamps: track.timestamps, values: track.values, durationMs };
}

/**
 * Evaluate an [`AlphaTrack`] at `elapsedMs` (wall-clock ms since the skybox started loading -- see
 * `buildSkyboxMeshes`). A constant track (`durationMs === 0`) always returns its one value. A looping
 * track wraps `elapsedMs` into `[0, durationMs)` and linearly interpolates between the bracketing
 * keyframes, holding flat before the first and after the last -- ordinary M2 keyframe semantics, just
 * with the "current time" coming from a free-running clock instead of a played animation's own cursor.
 * `null` (no track at all -- see `resolveAlphaTrack`) means the batch has no fade of this kind and
 * defaults to fully contributing, matching the M2 combiner default for an unanimated input.
 */
export function evaluateAlphaTrack(track: AlphaTrack | null, elapsedMs: number): number {
  if (!track || track.timestamps.length === 0) {
    return 1;
  }
  if (track.timestamps.length === 1 || track.durationMs <= 0) {
    return track.values[0];
  }

  const t = elapsedMs % track.durationMs;
  const { timestamps, values } = track;

  if (t <= timestamps[0]) {
    return values[0];
  }
  for (let i = 1; i < timestamps.length; i++) {
    if (t <= timestamps[i]) {
      const t0 = timestamps[i - 1];
      const t1 = timestamps[i];
      const v0 = values[i - 1];
      const v1 = values[i];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * f;
    }
  }
  return values[values.length - 1];
}

/**
 * Decode `path` (an M2) + its lowest-quality `.skin` into one [`SkyboxBatch`] per skin batch whose
 * submesh has any triangles and whose texture resolves to a real filename. Geometry uses the same
 * reduced engine swizzle `stars.ts` derives (negate X and Y, keep Z) -- these models are static, so
 * there is no bone/animation state to carry through it (the alpha TRACKS above are the one exception,
 * evaluated independently of bones/animation-player state).
 *
 * Every batch's geometry is then rescaled by ONE shared `1 / maxRadius` (the largest vertex distance
 * from the model's own local origin, across every batch together) -- the module doc's own "Placement"
 * section: this bakes the model down to a unit shell at load time, exactly like `stars.ts` does for
 * `Stars.m2`'s patches, so the per-frame `camera.far`-based rescale in `Skybox`/`WmoSkybox` reproduces
 * the model's authored proportions instead of a fixed, easily-outgrown size.
 *
 * Batches are pushed in `skinData.batches` order and MUST stay that way: M2 batches are authored in
 * draw order, and once a layer blends (every layer here does -- see the module doc), drawing them out
 * of order changes the picture. `buildSkyboxMeshes` turns this array order into an ascending
 * `renderOrder` per mesh for exactly that reason.
 *
 * Returns an empty array (never throws past the caller) when the model decodes to zero usable
 * batches; throws if the M2/skin themselves fail to load or decode, so the caller can log which path
 * failed rather than silently drawing nothing (the plan's Risk 6: "verify each loads before building
 * its consumer, and report any that do not resolve rather than silently falling back").
 */
export async function loadSkyboxBatches(path: string): Promise<SkyboxBatch[]> {
  const loader = new Loader();

  const raw = await loader.load(path);
  const data = M2.decode(new DecodeStream(Buffer.from(new Uint8Array(raw))));

  const quality = Math.max(0, data.viewCount - 1);
  const skinPath = path.replace(/\.m2/i, `0${quality}.skin`);
  const rawSkin = await loader.load(skinPath);
  const skinData = Skin.decode(new DecodeStream(Buffer.from(new Uint8Array(rawSkin))));

  const batches: SkyboxBatch[] = [];

  for (const batch of skinData.batches) {
    const submesh = skinData.submeshes[batch.submeshIndex];
    if (!submesh || submesh.triangleCount === 0) {
      continue;
    }

    const textureIndex = data.textureLookups[batch.textureLookup];
    const texture = data.textures[textureIndex];
    const texturePath: string = (texture && texture.filename) || '';
    if (!texturePath) {
      continue;
    }

    const material = data.materials[batch.materialIndex];
    const blendingMode = material ? material.blendingMode : 0;

    const vca = batch.vertexColorAnimationIndex >= 0
      ? data.vertexColorAnimations[batch.vertexColorAnimationIndex]
      : null;
    const vertexColorAlpha = resolveAlphaTrack(vca ? vca.alpha : null, data.sequences, data.animations);

    const transparencyIndex = data.transparencyAnimationLookups[batch.transparencyAnimationLookup];
    const transparencyBlock = transparencyIndex !== undefined && transparencyIndex >= 0
      ? data.transparencyAnimations[transparencyIndex]
      : null;
    const transparencyAlpha = resolveAlphaTrack(transparencyBlock, data.sequences, data.animations);

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
        // The reduced M2->engine swizzle (see stars.ts's module doc): negate X and Y, keep Z.
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

    batches.push({
      geometry,
      texturePath,
      blendingMode,
      vertexColorAlpha,
      transparencyAlpha,
    });
  }

  // Normalise the WHOLE model (every batch sharing one radius, not each batch its own -- that would
  // distort the shell's authored proportions) to a unit shell, per the module doc's "Placement"
  // section.
  let maxRadius = 1e-3;
  for (const { geometry } of batches) {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
      if (r > maxRadius) {
        maxRadius = r;
      }
    }
  }
  for (const { geometry } of batches) {
    geometry.scale(1 / maxRadius, 1 / maxRadius, 1 / maxRadius);
  }

  return batches;
}

/** Shared vertex shader for a blended skybox layer: no lighting, no fog, no skinning -- an unlit
 * camera-anchored quad, same as every other sky element's own minimal vertex stage
 * (`celestial/billboard.ts`, `clouds/index.ts`). */
const SKYBOX_LAYER_VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Shared fragment shader for a blended skybox layer. `alphaKey` mirrors the M2 combiner shaders'
 * own alpha-key cutout (`pipeline/m2/material/shader.frag`) for blend mode 1 -- the mapping this file
 * reuses (`applyBlendingModeToMaterial`) sets the matching GL blend factors for mode 1 but, unlike
 * `M2Material`'s hand-written combiners, this shader has no other alpha-key consumer to inherit the
 * discard from, so it is repeated here rather than left silently unapplied. `animatedAlpha` is this
 * batch's own vertex-colour x transparency alpha TRACK product (module doc point 2), refreshed every
 * frame by `updateSkyboxAnimatedAlpha` -- multiplying it into the texture's own alpha before the
 * alpha-key test and the GL blend is what lets three same-shaped batches (night/day/sunset) share one
 * patch of sky and only ever show one at a time. */
const SKYBOX_LAYER_FRAGMENT_SHADER = `
  uniform sampler2D map;
  uniform float alphaKey;
  uniform float animatedAlpha;
  varying vec2 vUv;

  void main() {
    vec4 texel = texture2D(map, vUv);
    float a = texel.a * animatedAlpha;

    if (alphaKey == 1.0 && a <= 0.5) {
      discard;
    }

    gl_FragColor = vec4(texel.rgb, a);

    // THE SKY DEPTH LAW (see sky/__tests__/sky-depth-law.test.ts and clouds/index.ts's own doc on
    // it). This layer is TRANSPARENT (every blend mode this model carries is >= 1 -- see the module
    // doc), so three.js draws it after all opaque geometry regardless of renderOrder; forcing the far
    // depth here is what lets the depth test below still have the world occlude it correctly.
    gl_FragDepth = 1.0;
  }
`;

/**
 * Build the material for one skybox batch, keyed entirely off its own `blendingMode` -- NOT a single
 * shared material for the whole model, because (per the module doc) these models mix opaque and
 * blended layers batch-by-batch.
 *
 * `blendingMode === 0` (opaque): the fast, pre-existing path -- flat `MeshBasicMaterial`,
 * `transparent: false`, exempt from the depth law's transparent half exactly like the gradient dome
 * (`sky/__tests__/sky-depth-law.test.ts`'s own carve-out), because the world always wins the depth
 * battle without a test as long as this stays in the opaque pass.
 *
 * `blendingMode >= 1`: a `ShaderMaterial` that forces `gl_FragDepth = 1.0` and depth-tests
 * (`depthTest: true`, `depthWrite: false`), because becoming `transparent: true` moves it out of the
 * opaque pass -- three.js draws every transparent material after every opaque one, and `renderOrder`
 * only sorts within a pass (see the depth-law test's own module doc). `MeshBasicMaterial` cannot force
 * `gl_FragDepth` without `onBeforeCompile`, so the blended layers get this small hand-written shader
 * instead of the fast path. Blend factors come from `applyBlendingModeToMaterial` -- this file's own
 * reuse of `M2Material`'s tested mapping, including the mode >= 1 fix that pins
 * `blendSrcAlpha = ZeroFactor` / `blendDstAlpha = OneFactor` so a draw never writes the framebuffer's
 * alpha channel (`d348889`; see that function's own comment for the premultiplied-canvas mechanics).
 *
 * `fog` is left at `false` for both paths (`MeshBasicMaterial`'s own default is `true`; the
 * hand-written shader simply never samples fog uniforms) -- these are unlit, camera-anchored sky
 * layers the reference does not fog, exactly like every other sky element in this file's neighbourhood
 * (`clouds/index.ts`, `celestial/billboard.ts`).
 */
export function buildSkyboxMaterial(blendingMode: number): THREE.Material {
  if (blendingMode === 0) {
    return new THREE.MeshBasicMaterial({
      map: TextureLoader.PLACEHOLDER,
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
  }

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: TextureLoader.PLACEHOLDER },
      alphaKey: { value: blendingMode === 1 ? 1.0 : 0.0 },
      animatedAlpha: { value: 1.0 },
    },
    vertexShader: SKYBOX_LAYER_VERTEX_SHADER,
    fragmentShader: SKYBOX_LAYER_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    fog: false,
  });

  applyBlendingModeToMaterial(material, blendingMode);
  return material;
}

/** The texture uniform/property name differs between the two material kinds `buildSkyboxMaterial`
 * can return; this is the one place that needs to know that, so texture load/dispose stay generic
 * everywhere else (`resolveSkyboxTexture`'s callers, and `disposeSkyboxMesh`). */
function assignSkyboxTexture(material: THREE.Material, texture: THREE.Texture): void {
  if (material instanceof THREE.ShaderMaterial) {
    material.uniforms.map.value = texture;
  } else {
    (material as THREE.MeshBasicMaterial).map = texture;
  }
  material.needsUpdate = true;
}

/**
 * Build one `THREE.Mesh` per batch, in `batches` array order, via `buildSkyboxMaterial`. Each mesh's
 * own alpha tracks (`vertexColorAlpha`/`transparencyAlpha`) are stashed on `mesh.userData.alphaTracks`
 * for `updateSkyboxAnimatedAlpha` to evaluate every frame -- see the module doc's point 2.
 *
 * `renderOrder` is `baseRenderOrder + index * ORDER_STEP` -- NOT a single shared value the way this
 * function used to assign one. These batches blend (see the module doc), so once more than one is
 * transparent, three.js's own transparent-pass sort (back-to-front by depth, since every layer here
 * shares `depthWrite: false` and camera-anchored layers can sit at very similar depths) can reorder
 * them and change the picture; distinct `renderOrder` values pin the model's own authored draw order
 * instead. `ORDER_STEP` is small enough that even this model's largest observed batch count (87, on
 * `NagrandSkyBox.m2`) stays inside `baseRenderOrder`'s own slot on the sky's `renderOrder` ladder
 * (`sky/skybox/index.ts`'s `ZONE_SKYBOX_RENDER_ORDER`, `sky/skybox/wmo.ts`'s `WMO_SKYBOX_RENDER_ORDER`
 * -- both -1000, half a unit below the cloud dome's -999).
 *
 * One known limitation, not exercised by any skybox this client has decoded so far (verified:
 * `NagrandSkyBox.m2`'s 87 batches are 100% blend mode 2 or 4, never 0): if a model ever interleaves an
 * OPAQUE batch between blended ones, that opaque batch still draws in the opaque pass -- entirely
 * before every transparent batch, regardless of `renderOrder` -- because `renderOrder` only sorts
 * within a pass (the depth-law test's own module doc). Handling that would mean forcing every batch of
 * such a model through the transparent path together; left as a follow-up since no real data needs it
 * yet, rather than adding untested complexity for a case nothing exercises.
 */
export function buildSkyboxMeshes(batches: SkyboxBatch[], baseRenderOrder: number): THREE.Mesh[] {
  const ORDER_STEP = 0.001;

  return batches.map(({ geometry, texturePath, blendingMode, vertexColorAlpha, transparencyAlpha }, index) => {
    const material = buildSkyboxMaterial(blendingMode);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.skyboxTexture = TextureLoader.PLACEHOLDER;
    mesh.userData.alphaTracks = { vertexColorAlpha, transparencyAlpha };

    TextureLoader.load(texturePath)
      .then((texture: THREE.Texture) => {
        assignSkyboxTexture(material, texture);
        mesh.userData.skyboxTexture = texture;
      })
      .catch((error: unknown) => {
        console.error(`Skybox: failed to load texture ${texturePath}:`, error);
      });

    mesh.frustumCulled = false;
    mesh.renderOrder = baseRenderOrder + index * ORDER_STEP;
    mesh.matrixAutoUpdate = false;
    return mesh;
  });
}

/**
 * Evaluate every mesh's own `alphaTracks` (stashed by `buildSkyboxMeshes`) at `elapsedMs` and write the
 * product into its `animatedAlpha` uniform -- the per-frame half of the module doc's point 2. A no-op
 * for `blendingMode === 0` (`MeshBasicMaterial`) meshes: nothing in this model uses that path today
 * (see `buildSkyboxMeshes`'s own doc), and a genuinely opaque batch has no variant to cross-fade away
 * from in the first place.
 *
 * Callers: `Skybox.update` and `WmoSkybox.update`, both already called once per frame with the current
 * camera; `elapsedMs` is wall-clock time since that skybox instance's own `buildSkyboxMeshes` call
 * (`Date.now()` at load, not a synced "M2 animation clock" this client does not otherwise have --
 * matches the module doc's global-sequence semantics, which loop on a free-running timer either way).
 */
export function updateSkyboxAnimatedAlpha(meshes: THREE.Mesh[], elapsedMs: number): void {
  for (const mesh of meshes) {
    const material = mesh.material as THREE.ShaderMaterial;
    if (!(material instanceof THREE.ShaderMaterial)) {
      continue;
    }
    const tracks = mesh.userData.alphaTracks as
      | { vertexColorAlpha: AlphaTrack | null; transparencyAlpha: AlphaTrack | null }
      | undefined;
    if (!tracks) {
      continue;
    }
    const alpha = evaluateAlphaTrack(tracks.vertexColorAlpha, elapsedMs)
      * evaluateAlphaTrack(tracks.transparencyAlpha, elapsedMs);
    material.uniforms.animatedAlpha.value = alpha;
  }
}

/**
 * Tear down one skybox mesh built by `buildSkyboxMeshes`: dispose its geometry and material, and
 * release the resolved texture back to `TextureLoader` -- unless it never resolved past the shared
 * `PLACEHOLDER`, which is never refcounted and must not be handed back. Centralised here (rather than
 * duplicated in `Skybox.clearMeshes` and `WmoSkybox.dispose`, which is where this logic used to live,
 * reading `material.map` directly) because that read assumed every skybox material was a
 * `MeshBasicMaterial` -- true before this file also started building blended `ShaderMaterial` layers,
 * whose texture lives in `uniforms.map.value` instead. Both callers now read the resolved texture off
 * `mesh.userData.skyboxTexture`, which `buildSkyboxMeshes` keeps current regardless of which material
 * kind backs the mesh.
 */
export function disposeSkyboxMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  const map = mesh.userData.skyboxTexture as THREE.Texture | undefined;
  if (map && map !== TextureLoader.PLACEHOLDER) {
    TextureLoader.unload(map);
  }
}
