/**
 * Per-frame animation counters, read by the perf HUD.
 *
 * A mutable singleton rather than a returned value: the evaluator increments these from several
 * call sites per frame, and threading a counters object through every one of them would be a
 * larger change to the hot path than the measurement is worth.
 *
 * `reset()` is called at the top of each frame. A counter that is never reset silently reports a
 * running total as if it were a per-frame figure, which is worse than no measurement at all.
 */
export interface AnimCountersSnapshot {
  /** Animated instances currently loaded, whether or not they were posed. */
  resident: number;
  /** Instances actually evaluated this frame. */
  posed: number;
  /** Instances skipped by a gate (not drawn, decimated, or over the bone budget). */
  skipped: number;
  /** Bones solved this frame across every posed instance. */
  bonesSolved: number;
  /**
   * Instances whose solved pose was written into the bone hierarchy this frame.
   *
   * NOT a bone-texture upload count, which is what this field was originally named for. Under the
   * plan's abandoned direct-palette route the two would have been the same number; on the route
   * that actually works they are not related. three raises `boneTexture.needsUpdate` inside
   * `Skeleton#update()`, which `WebGLObjects.update` calls once per frame for every skinned mesh it
   * is about to DRAW -- posed or not, gated or not. The real upload count is therefore a property of
   * the draw list, not of this loop, and nothing here can observe it.
   */
  posesApplied: number;
  /**
   * CALLS to `M2#evaluateMaterialChannels` this frame -- one per drawn instance with an
   * `InstanceAnim`, whether or not that instance declares a single UV, transparency or colour
   * channel.
   *
   * Deliberately the call count and NOT "instances that had channels", which is what this doc used
   * to claim. The two differ by a lot: `ModelAnim.classify()` admits a model on ANY animated channel
   * including bone tracks, so a purely bone-animated doodad is counted here while sampling nothing.
   * The call is still the unit of cost -- `DoodadManager#animate` makes it unconditionally past the
   * draw gate, and each one is a call through `M2` into the evaluator plus three empty-array checks.
   *
   * Counted separately from `posed` because it is a separately GATED population: material channels
   * are evaluated for every drawn instance, with no distance decimation and no bone budget (there
   * are no bones to budget). It is therefore the one per-frame animation cost nothing throttles, and
   * Task 20 has to re-derive the frame gate from measurement -- from a number that means what the
   * frame actually spends, which is why the doc was corrected to the code rather than the reverse.
   */
  materialsEvaluated: number;
  /**
   * Instances that solved a MASKED UPPER-BODY OVERLAY this frame -- a second sampled track on the
   * bones inside the split subtree (`anim/upper-body.ts`).
   *
   * The population that pays for the split, counted separately from `posed` because that is the whole
   * cost question: the overlay is armed for the length of one swing clip and retires itself, so a
   * fight among forty units still only ever has a handful of these. A number here that tracks `posed`
   * would mean something is failing to retire.
   */
  overlays: number;
}

class AnimCounters implements AnimCountersSnapshot {
  resident = 0;
  posed = 0;
  skipped = 0;
  bonesSolved = 0;
  posesApplied = 0;
  materialsEvaluated = 0;
  overlays = 0;

  reset(): void {
    this.resident = 0;
    this.posed = 0;
    this.skipped = 0;
    this.bonesSolved = 0;
    this.posesApplied = 0;
    this.materialsEvaluated = 0;
    this.overlays = 0;
  }

  snapshot(): AnimCountersSnapshot {
    return {
      resident: this.resident,
      posed: this.posed,
      skipped: this.skipped,
      bonesSolved: this.bonesSolved,
      posesApplied: this.posesApplied,
      materialsEvaluated: this.materialsEvaluated,
      overlays: this.overlays,
    };
  }
}

export const animCounters = new AnimCounters();

/**
 * Readable as `window.animCounters` -- the same publish `blendControl`/`overlayControl` get, and for
 * the same reason: the per-frame animation population is only measurable from a probe, and the perf
 * HUD's payload copy (`pages/game/index.tsx`) is behind `showDebug`. Read only in practice; nothing
 * in the client reads it back off `window`.
 */
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).animCounters = animCounters;
}
