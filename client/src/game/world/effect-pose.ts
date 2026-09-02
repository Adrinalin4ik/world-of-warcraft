import * as THREE from 'three';

import { poseGatedInstance } from '../pipeline/m2/anim/pose-gate';
import { worldClock } from '../pipeline/m2/anim/world-clock';
import { warnOnce } from '../ui/framexml/lua/methods/region';

/**
 * THE POSE PASS FOR FREE-STANDING EFFECT MODELS -- the gap this subsystem named for itself three
 * rounds ago, and the reason a shield buff sits on the player frozen and several times too bright.
 *
 * A unit is advanced by `unit.update`; a doodad by `DoodadManager#animate`. A model that
 * `spell-kit-effects.ts` or `spell-missile.ts` spawns is in neither lane, so nothing sampled its
 * animation at all. TWO separate things were therefore missing, and conflating them is the trap:
 *
 *  1. **The MATERIAL CHANNELS** -- transparency, UV scroll, vertex colour. `M2#evaluateMaterialChannels`
 *     samples them, while `M2#createTransparencyAnimations` (`pipeline/m2/index.ts:897-905`) only
 *     seeds every slot at **1.0** and samples nothing. So an unposed model draws at FULL alpha where
 *     the artist authored a 0 -> 1 birth ramp settling near 0.24-0.30. On an additive shield that is
 *     the whole artefact.
 *  2. **The BONES** -- `solveBones` then `applyPose`.
 *
 * ## The channels are evaluated OUTSIDE the skinning gate, and that is the whole point
 *
 * `DoodadManager#animate` puts `evaluateMaterialChannels` deliberately before and outside its
 * `useSkinning` test, and says why: "a scrolling waterfall or a pulsing glow often has no animated
 * bone at all (so `useSkinning` is false), and a doodad the bone gates denied still has to keep
 * scrolling" (`world/doodad-manager.js:374-386`).
 *
 * That is not hypothetical here -- it is exactly these models. `manashield_state_base` has **zero
 * particle emitters** and its animation is transparency only, so putting the channel evaluation behind
 * `useSkinning` would reproduce the very bug this module exists to fix. It is called unconditionally,
 * and doing so is safe unarmed: `evaluateMaterialChannels` reads `UNARMED_SLOT` rather than slot 0, and
 * a global-sequence channel keeps running on an instance that never armed
 * (`anim/material-channels.ts:206-217`).
 *
 * ## The gate is the SHARED one, not a fourth copy
 *
 * `anim/pose-gate.ts#poseGatedInstance` already serves terrain doodads, WMO-interior doodads and
 * units, and its docstring records the two things a hand-written copy gets wrong. Both would have
 * bitten this lane: the distance must come off `matrixWorld`'s translation rather than `position` --
 * and an effect model parented to a BONE has a `position` local to that bone, so measuring it would
 * decimate on a distance to somewhere near the world origin -- and the phase input must be a dense
 * `poseSlot`, never a sparse content id.
 *
 * **The bone budget is REFUSED, deliberately, and the precedent is units.** `poseGatedInstance` takes
 * a nullable budget where null means "charge nothing, deny nothing", which is exactly how units are
 * admitted. An effect is few, brief and looked at directly: a denied frame on a distant doodad is
 * invisible, while a denied frame on a shield the player is watching is a visible hitch. The DISTANCE
 * decimation IS taken, because it costs nothing and an effect 60 yards off does not need a 60 Hz pose.
 *
 * ## Frame cost at the realistic population
 *
 * Costed at the aura lane's measured population rather than at one projectile: 1.25 models per armed
 * kit, and 20 buffed units x 3 visual-bearing auras = **75 live instances**.
 *
 *  - **Channels: all 75, every frame, ungated.** Per instance one pass over each of the three channel
 *    arrays. The shield models carry a handful of transparency tracks and no UV or vertex colour, so
 *    a few scalar samples each -- a few hundred `sampleScalar` calls per frame in total. That is the
 *    same order as the doodad lane already pays ungated, over a population in the thousands.
 *  - **Bones: gated, and ZERO for the models that matter.** Only `useSkinning` instances reach
 *    `solveBones`, and the shield models are transparency-only, so they contribute no bone work at
 *    all. A lightning ribbon host carries 23-26 bones and the distance gate stages the rest.
 *  - **No allocation.** `poseGatedInstance` allocates nothing by contract, the channel evaluation
 *    writes into preallocated value slots, and the camera vector here is module-level.
 *
 * **NOT MEASURED, and named as owed: the millisecond figure.** `animCounters` already counts
 * `posed`/`skipped`/`bonesSolved`/`materialsEvaluated`, so the live cost is readable off the existing
 * instrument rather than needing a new one -- but reading it needs a browser and this round has none.
 * What is above is a bound argued from the shapes involved, not a timing.
 *
 * ## What this does NOT touch, and why
 *
 * The aura lane's gap 1 -- the kit `CharProc` half, translucency and tint and anim rate -- is not
 * attempted, and the reason is the shared-material rule rather than scope. Those are per-UNIT render
 * properties and this client has no per-unit alpha or tint channel; writing one from an effect pass
 * would mean writing a material the whole zone is drawing, and `ownsBatches` is the test an attachment
 * fails. So a model's OWN transparency track is sampled here -- that is its own material, per
 * instance, and legitimately ours -- while the unit-alpha proc that would also want it stays a named
 * gap for whoever can add a per-unit channel.
 */

/** Reused so the per-frame path allocates nothing. */
const cameraPosition = new THREE.Vector3();

/**
 * `AnimationData.dbc` 158 `Hold` -- the sustained leg a state kit hands its birth over to
 * (`benilla-app/src/entities/spell_fx/lifecycle.rs:61-64`).
 */
export const ANIM_HOLD = 158;

/** `AnimationData.dbc` 159 `Decay` -- the fade-out leg armed at the reap (`lifecycle.rs:65-67`). */
export const ANIM_DECAY = 159;

/** Where one instance sits in the reference's three-leg lifecycle. */
export type EffectLifecycle = 'birth' | 'settled' | 'decaying';

let poseSlotCounter = 0;

/**
 * A dense phase slot. The gate's docstring is explicit that a sparse content id puts whole clusters on
 * one phase, which is a worse worst frame than not decimating at all -- so effect models get a rolling
 * counter, dense by construction.
 */
function nextPoseSlot(): number {
  poseSlotCounter = (poseSlotCounter + 1) % 1024;
  return poseSlotCounter;
}

/**
 * Sample one effect model's animation for this frame.
 *
 * Returns true when the BONES were written, which is what tells the caller this model needs an
 * `updateMatrixWorld(true)` -- the same contract `poseGatedInstance` has with the doodad lane.
 */
export function poseEffectModel(
  model: any,
  camera: THREE.Camera | undefined,
  frameIndex: number,
): boolean {
  if (model === null || model === undefined) {
    return false;
  }

  const worldClockMs = worldClock.ms;

  // THE CHANNELS, UNCONDITIONALLY. See the header: gating this on `useSkinning` is the bug.
  if (typeof model.evaluateMaterialChannels === 'function') {
    model.evaluateMaterialChannels(worldClockMs);
  }

  // THE BONES, gated. `useSkinning` false means the bones are orphaned from the scene graph, so
  // solving them would charge for writes nothing reads -- the doodad lane's own reasoning.
  const inst = model.instanceAnim;
  if (camera === undefined || !model.useSkinning || !inst || !inst.armable) {
    return false;
  }

  cameraPosition.copy(camera.position);
  if (typeof model.poseSlot !== 'number') {
    model.poseSlot = nextPoseSlot();
  }

  // NULL BUDGET: the units precedent, for the reason in the header.
  return poseGatedInstance(model, inst, cameraPosition, frameIndex, worldClockMs, null);
}

/**
 * Advance one instance through `Stand` -> `Hold`, and answer its new lifecycle state.
 *
 * The reference's stage-2 arm: "iff the model authors **`Hold` (158)**, arm it and keep it running for
 * the effect's whole life; if it does not, do **nothing at all** (no destroy, no re-loop -- the model
 * simply stays parked on its birth sequence)" (`lifecycle.rs:19-24`). **This is Ice Barrier's pulse**,
 * and its absence is the frozen birth pose.
 *
 * The completion latch is the AUTHORED SPAN, not a loop flag: the reference fires "one notification per
 * authored span" and is explicitly LOOP-flag-independent (`lifecycle.rs:129-135`), which is why this
 * compares elapsed against `current.lengthMs` rather than asking whether a clip finished.
 */
export function advanceEffectLifecycle(model: any, state: EffectLifecycle): EffectLifecycle {
  if (state !== 'birth') {
    return state;
  }
  const inst = model?.instanceAnim;
  const current = inst?.current;
  if (!inst || !current || !(current.lengthMs > 0)) {
    // Nothing armed to hand over from. Settled, so it is not re-asked every frame.
    return 'settled';
  }
  if (worldClock.ms - inst.armedAtMs < current.lengthMs) {
    return 'birth';
  }

  const hold = model.modelAnim?.resolve?.(ANIM_HOLD, false) ?? null;
  if (hold === null) {
    // The reference's own "do nothing whatsoever": park on the birth clip. NOT a defect -- only 163
    // of its 9691-model corpus author a Hold or Decay leg at all.
    return 'settled';
  }
  inst.arm(hold, worldClock.ms);
  return 'settled';
}

/**
 * Arm `Decay` at the reap if the model authors one, and answer its span in milliseconds.
 *
 * `lifecycle.rs:196-215`: arm `Decay` if present, never repeated whatever the sequence flags say,
 * because the instance is destroyed at its completion. `null` when the model authors none, which is
 * the reference's immediate-destroy gate.
 */
export function armEffectDecay(model: any): number | null {
  const decay = model?.modelAnim?.resolve?.(ANIM_DECAY, false) ?? null;
  if (decay === null || !(decay.lengthMs > 0)) {
    return null;
  }
  const inst = model.instanceAnim;
  if (inst?.arm) {
    inst.arm(decay, worldClock.ms);
  } else {
    warnOnce('spell fx: a model authors Decay but has no instanceAnim to arm it on');
  }
  return decay.lengthMs;
}
