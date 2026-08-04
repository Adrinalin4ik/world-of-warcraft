/**
 * The NON-BONE animated channels: UV transform, transparency, and vertex colour.
 *
 * Split out of `M2` for the same reason `bind-pose.ts` was: `M2`'s constructor reaches for
 * `collisionWorld` and `ObjectsManager`, so it cannot be exercised from a test at all. Everything
 * here is a pure function of (keyframes, clocks, output slots), and `M2#evaluateMaterialChannels` is
 * a thin wrapper that hands over its own arrays.
 *
 * COORDINATE SPACE. Bone channels are sampled in raw M2 axes and must be conjugated by
 * `D = diag(-1, -1, 1)` before they reach three (see `anim/axes.ts`). None of the channels here
 * need that, and applying it would be wrong:
 *
 *   * UV translation/rotation/scaling live in TEXTURE space, a 2-D space the geometry mirror never
 *     touched. The vertex shader multiplies the composed matrix straight onto `vec4(uv, 0, 1)`, and
 *     the UVs it multiplies are the file's own `textureCoords` pushed through unmodified
 *     (`M2#createSubmeshGeometry`) into textures loaded with `flipY = false`
 *     (`pipeline/texture-loader.js`). Texture space therefore matches the file byte for byte, and a
 *     mirror on it would scroll every waterfall backwards.
 *   * Vertex colour is an RGB triple and transparency is a scalar. Neither is spatial, so there is
 *     no basis to conjugate.
 *
 * The UV PIVOT is the one thing that is not a straight sample. WoW composes a texture transform
 * about the centre of texture space, not its corner:
 *
 *     M = T(0.5, 0.5, 0) * T(translation) * R(rotation) * S(scaling) * T(-0.5, -0.5, 0)
 *
 * ported from WebWoWViewer's `calcAnimationTransform`/`calcAnimMatrixes` (`animationManager.js:397`,
 * `:472`). Pure translation is unaffected by the pivot -- it is rotation and scaling that land in
 * the wrong place without it, and those are exactly the two the previous code left as a TODO.
 */

import * as THREE from 'three';

import { InstanceAnim, UNARMED_SLOT } from './instance-anim';
import { ModelAnim } from './model-anim';
import { AnimBlock, isStep, sampleQuat, sampleScalar, sampleVec3, trackFor } from './tracks';

/** One UV animation's sampled state. `matrix` is allocated once and rewritten in place. */
export interface UVAnimationValue {
  translation: number[];
  rotation: number[];
  scaling: number[];
  matrix: THREE.Matrix4;
}

/** One vertex-colour animation's sampled state. */
export interface VertexColorValue {
  color: number[];
  alpha: number;
}

/** The parsed blocks, straight off the M2 data. */
export interface MaterialChannelDefs {
  /** `data.uvAnimations` -- each with `translation` / `rotation` / `scaling` blocks. */
  uv: any[];
  /** `data.transparencyAnimations` -- each IS an animation block. */
  transparency: AnimBlock[];
  /** `data.vertexColorAnimations` -- each with `color` / `alpha` blocks. */
  vertexColor: any[];
}

/** The per-placement output slots, allocated once in `M2#createTextureAnimations`. */
export interface MaterialChannelValues {
  uv: UVAnimationValue[];
  transparency: number[];
  vertexColor: VertexColorValue[];
}

// Module-level scratch. This runs per animated placement per frame and must not allocate -- the old
// subscription code built a `new THREE.Matrix4()` per UV animation per update, and GC pauses land
// squarely on the worst-frame metric.
const scratchTranslation = new THREE.Vector3();
const scratchRotation = new THREE.Quaternion();
const scratchScaling = new THREE.Vector3();
const scratchColor = new THREE.Vector3();
const scratchCompose = new THREE.Matrix4();

/** Compared against, never written. */
const IDENTITY = new THREE.Matrix4();

/** `T(0.5, 0.5, 0)` and its inverse. Built once; never mutated. */
const uvPivotTo = new THREE.Matrix4().makeTranslation(0.5, 0.5, 0);
const uvPivotBack = new THREE.Matrix4().makeTranslation(-0.5, -0.5, 0);

/**
 * The cursor a channel samples at.
 *
 * A GLOBAL-SEQUENCE channel reads `ModelAnim.globalSequenceCursor`, which is a pure function of
 * world time and therefore identical for every placement -- a courtyard of braziers evaluates one
 * pulse, not a hundred. An ordinary channel reads THIS placement's own clock, so two copies of a
 * model armed at different moments scroll out of step, as they should.
 *
 * Crossing these two is silent and looks like drift: a shared pulse that should be locked across
 * every placement starts depending on when each one happened to load.
 */
export function channelCursor(
  model: ModelAnim,
  block: AnimBlock,
  inst: InstanceAnim | null,
  worldClockMs: number,
): number {
  if (block.globalSequenceID > -1) {
    return model.globalSequenceCursor(block.globalSequenceID, worldClockMs);
  }
  return inst ? inst.cursor(worldClockMs) : 0;
}

/**
 * Which of a block's tracks to read.
 *
 * A sequence-timeline block has one track per sequence slot, so the playing sequence's index
 * selects it. A GLOBAL-SEQUENCE block has no sequence timeline at all -- it carries a single track,
 * and indexing it by the playing sequence would find nothing and freeze the channel. Both
 * WebWoWViewer (`animationManager.js:343` -- its "Hack" fallback to animation 0) and this repo's own
 * skybox reader (`sky/skybox/model.ts#resolveAlphaTrack`, which takes `block.tracks[0]`
 * unconditionally for global sequences) land on track 0.
 */
export function channelTrackIndex(block: AnimBlock, seqIndex: number): number {
  return block.globalSequenceID > -1 ? 0 : seqIndex;
}

/** The track a channel plays this frame, or null when it has nothing to say. */
function channelTrack(block: AnimBlock | undefined, seqIndex: number) {
  if (!block || !block.tracks) {
    return null;
  }
  return trackFor(block, channelTrackIndex(block, seqIndex));
}

/**
 * Sample one UV animation and recompose its matrix in place.
 *
 * Each of the three sub-channels falls back to its own IDENTITY when the block has no track for
 * this sequence -- not to last frame's value. Holding a stale sample would leave a texture frozen
 * mid-scroll the moment a model switched to a sequence that does not drive it.
 */
export function evaluateUVAnimation(
  model: ModelAnim,
  def: any,
  value: UVAnimationValue,
  seqIndex: number,
  inst: InstanceAnim | null,
  worldClockMs: number,
): void {
  scratchTranslation.set(0, 0, 0);
  scratchRotation.set(0, 0, 0, 1);
  scratchScaling.set(1, 1, 1);

  const translation = channelTrack(def.translation, seqIndex);
  const rotationTrack = channelTrack(def.rotation, seqIndex);
  const scalingTrack = channelTrack(def.scaling, seqIndex);

  // Nothing drives this animation under the playing sequence. If the slot is already identity there
  // is nothing to reset either, so skip the compose entirely -- a model in `animatedDoodads` for its
  // BONES alone reaches here once per UV animation per frame and would otherwise pay three matrix
  // multiplies to rewrite an identity it already has.
  if (!translation && !rotationTrack && !scalingTrack) {
    if (value.matrix.equals(IDENTITY)) {
      return;
    }
  }

  if (translation) {
    sampleVec3(
      translation, isStep(def.translation),
      channelCursor(model, def.translation, inst, worldClockMs), scratchTranslation,
    );
  }

  if (rotationTrack) {
    sampleQuat(
      rotationTrack, isStep(def.rotation),
      channelCursor(model, def.rotation, inst, worldClockMs), scratchRotation,
    );
  }

  if (scalingTrack) {
    sampleVec3(
      scalingTrack, isStep(def.scaling),
      channelCursor(model, def.scaling, inst, worldClockMs), scratchScaling,
    );
  }

  value.translation[0] = scratchTranslation.x;
  value.translation[1] = scratchTranslation.y;
  value.translation[2] = scratchTranslation.z;
  value.rotation[0] = scratchRotation.x;
  value.rotation[1] = scratchRotation.y;
  value.rotation[2] = scratchRotation.z;
  value.rotation[3] = scratchRotation.w;
  value.scaling[0] = scratchScaling.x;
  value.scaling[1] = scratchScaling.y;
  value.scaling[2] = scratchScaling.z;

  scratchCompose.compose(scratchTranslation, scratchRotation, scratchScaling);
  value.matrix.copy(uvPivotTo).multiply(scratchCompose).multiply(uvPivotBack);
}

/**
 * Sample every UV, transparency and vertex-colour channel into `values`.
 *
 * Writes in place into slots the caller already owns. Nothing here is pushed at a material: M2
 * materials are cached and shared across every placement of a model, so a per-placement value can
 * only reach the GPU per DRAW -- see `applyAnimatedUniformsBeforeRender` in `m2/submesh.js`.
 */
export function evaluateMaterialChannels(
  model: ModelAnim,
  inst: InstanceAnim | null,
  defs: MaterialChannelDefs,
  values: MaterialChannelValues,
  worldClockMs: number,
): void {
  // UNARMED reads `UNARMED_SLOT`, a non-slot, NOT slot 0 -- see the constant's own note. Slot 0 may
  // be a quarantined external sequence, and nothing upstream checks `inst.current` before calling
  // here. A GLOBAL-SEQUENCE channel is unaffected: `channelTrackIndex` overrides any slot with 0 for
  // those, so a clock-driven glow keeps pulsing on an instance that never armed, as it must.
  const seqIndex = inst && inst.current ? inst.current.index : UNARMED_SLOT;

  const uvDefs = defs.uv;
  for (let i = 0, len = uvDefs.length; i < len; ++i) {
    const value = values.uv[i];
    if (!value) {
      continue;
    }
    evaluateUVAnimation(model, uvDefs[i], value, seqIndex, inst, worldClockMs);
  }

  const transparencyDefs = defs.transparency;
  for (let i = 0, len = transparencyDefs.length; i < len; ++i) {
    const def = transparencyDefs[i];
    const track = channelTrack(def, seqIndex);
    values.transparency[i] = track
      ? sampleScalar(track, isStep(def), channelCursor(model, def, inst, worldClockMs), 1.0)
      : 1.0;
  }

  const colorDefs = defs.vertexColor;
  for (let i = 0, len = colorDefs.length; i < len; ++i) {
    const def = colorDefs[i];
    const value = values.vertexColor[i];
    if (!value) {
      continue;
    }

    const colorTrack = channelTrack(def.color, seqIndex);
    if (colorTrack) {
      sampleVec3(
        colorTrack, isStep(def.color),
        channelCursor(model, def.color, inst, worldClockMs), scratchColor,
      );
      value.color[0] = scratchColor.x;
      value.color[1] = scratchColor.y;
      value.color[2] = scratchColor.z;
    } else {
      // White, not last frame's colour -- same argument as the UV identities above.
      value.color[0] = 1.0;
      value.color[1] = 1.0;
      value.color[2] = 1.0;
    }

    const alphaTrack = channelTrack(def.alpha, seqIndex);
    value.alpha = alphaTrack
      ? sampleScalar(alphaTrack, isStep(def.alpha), channelCursor(model, def.alpha, inst, worldClockMs), 1.0)
      : 1.0;
  }
}
