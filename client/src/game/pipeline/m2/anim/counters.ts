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
  /** Bone-texture uploads issued this frame. */
  paletteUploads: number;
}

class AnimCounters implements AnimCountersSnapshot {
  resident = 0;
  posed = 0;
  skipped = 0;
  bonesSolved = 0;
  paletteUploads = 0;

  reset(): void {
    this.resident = 0;
    this.posed = 0;
    this.skipped = 0;
    this.bonesSolved = 0;
    this.paletteUploads = 0;
  }

  snapshot(): AnimCountersSnapshot {
    return {
      resident: this.resident,
      posed: this.posed,
      skipped: this.skipped,
      bonesSolved: this.bonesSolved,
      paletteUploads: this.paletteUploads,
    };
  }
}

export const animCounters = new AnimCounters();
