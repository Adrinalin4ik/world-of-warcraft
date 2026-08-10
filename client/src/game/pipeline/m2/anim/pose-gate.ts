import { animCounters } from './counters';
import { BoneBudget, shouldPose } from './gating';
import { InstanceAnim } from './instance-anim';

/**
 * The minimum an object must expose to be posed through the gates below.
 *
 * Deliberately structural rather than `M2`: this module is imported by `doodad-manager.js` (JS),
 * `pipeline/wmo/index.js` (JS) and `world/index.ts` (TS), and `M2` itself cannot be constructed in a
 * test -- its constructor reaches for `collisionWorld` and `ObjectsManager`. A duck type is what lets
 * the gate be tested at all.
 */
export interface PoseTarget {
  /** World matrix. Its translation, NOT `position`, is what the distance gate measures from. */
  matrixWorld: { elements: ArrayLike<number> };
  /** Dense per-instance phase slot; see `shouldPose`. */
  poseSlot: number;
  applyPose(): void;
}

/** Just the three components read off a camera -- `THREE.Vector3` satisfies it. */
export interface PosePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Distance-decimate, budget, solve and apply ONE visible instance's pose.
 *
 * Returns whether the bones were actually written, which is what decides whether this object needs
 * a scene-graph walk this frame (`World#updateDynamicMatrices`).
 *
 * Shared by all three animated populations -- terrain doodads, WMO-interior doodads and units --
 * because the gate is subtle in two ways that a second hand-written copy gets wrong:
 *
 *   * The distance comes off `matrixWorld`'s translation, never `position`. A terrain doodad's
 *     parent sits at the origin so the two agree, but a WMO doodad's `position` is LOCAL to its
 *     building and a unit model's is local to its `view` group -- both would measure a distance from
 *     the camera to a point near the world origin, and decimate on it.
 *   * The phase input is a dense `poseSlot`, never a content id. Entry ids are sparse, large and
 *     clustered by chunk, so `id % period` puts whole clusters on one phase -- the single-phase
 *     pile-up the stagger exists to prevent, and a worse worst frame than not decimating at all.
 *
 * `boneBudget` is nullable, and null means "charge nothing, deny nothing". That is how units are
 * admitted: see `World#animateEntities` for why they take the decimation gate but not the budget.
 *
 * Allocates nothing.
 */
export function poseGatedInstance(
  target: PoseTarget,
  inst: InstanceAnim,
  camPos: PosePoint,
  frameIndex: number,
  worldClockMs: number,
  boneBudget: BoneBudget | null,
): boolean {
  const e = target.matrixWorld.elements;
  const dx = e[12] - camPos.x;
  const dy = e[13] - camPos.y;
  const dz = e[14] - camPos.z;
  const distanceYd = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (!shouldPose(target.poseSlot, distanceYd, frameIndex)) {
    animCounters.skipped++;
    return false;
  }

  // The backstop. Denied instances hold last frame's pose for a frame, which a clock-indexed
  // sampler makes safe.
  if (boneBudget !== null && !boneBudget.request(inst.model.boneDefs.length)) {
    animCounters.skipped++;
    return false;
  }

  animCounters.posed++;
  animCounters.bonesSolved += inst.solveBones(worldClockMs);
  target.applyPose();

  return true;
}
