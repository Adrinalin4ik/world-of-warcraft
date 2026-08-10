/** Below this, pose every frame. */
export const NEAR_YD = 40;
/** Below this, pose every second frame; beyond it, every fourth. */
export const MID_YD = 120;

/**
 * How many frames apart an instance at this distance is re-posed.
 *
 * A non-finite distance takes the SAFEST bucket, not the cheapest. Written as a pair of `<`
 * comparisons the NaN case falls all the way through to period 4, because every comparison against
 * NaN is false -- so an uninitialised position would surface as a doodad animating at a quarter
 * rate for no visible reason, which is a far harder bug to see than one animating at full rate.
 */
export function decimationPeriod(distanceYd: number): number {
  if (!(distanceYd >= NEAR_YD)) {
    return 1;
  }
  return distanceYd < MID_YD ? 2 : 4;
}

/**
 * Whether this instance is posed on this frame.
 *
 * The modulo is taken on `frameIndex + instanceId` rather than `frameIndex` alone, and that stagger
 * is the whole point. Decimating without it means every instance shares one phase: three frames
 * cost nothing and the fourth poses the entire set at once, which is a WORSE worst-frame number
 * than never decimating at all. The headline metric here is worst frame, not average.
 *
 * Holding the previous palette between poses is safe because sampling is clock-indexed -- a stale
 * pose is a slightly old pose, never a drifting one. See `InstanceAnim`.
 *
 * `instanceId` must be a DENSE per-instance counter, not a content id. Feeding it doodad ENTRY ids
 * -- which are sparse, large and clustered by chunk -- lets many instances share one residue and
 * degrades the spread back toward the single-phase case this exists to prevent. Callers assign the
 * slot at registration; see `DoodadManager#enableDoodadAnimations`.
 */
export function shouldPose(instanceId: number, distanceYd: number, frameIndex: number): boolean {
  const period = decimationPeriod(distanceYd);
  if (period === 1) {
    return true;
  }
  return (frameIndex + instanceId) % period === 0;
}

/**
 * A hard per-frame ceiling on bone evaluations, spent in caller-chosen priority order.
 *
 * This is the backstop that actually protects the worst-frame number. Rounding a corner into a
 * dense city is exactly when the animated-instance count jumps, and exactly when a scheme tuned
 * against an average fails. Instances denied a grant hold last frame's pose for a frame.
 */
export class BoneBudget {
  readonly limit: number;
  spent = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  beginFrame(): void {
    this.spent = 0;
  }

  /**
   * Request `bones` evaluations. Returns whether the caller may proceed.
   *
   * The first request of a frame is always granted, whatever its size: a single model with more
   * bones than the whole budget would otherwise never animate at all, which reads as a broken model
   * rather than a busy frame.
   */
  request(bones: number): boolean {
    if (this.spent === 0) {
      this.spent += bones;
      return true;
    }
    if (this.spent + bones > this.limit) {
      return false;
    }
    this.spent += bones;
    return true;
  }
}
