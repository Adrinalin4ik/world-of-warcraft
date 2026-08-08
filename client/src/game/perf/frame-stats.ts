/**
 * The frame budget: a 60 fps floor. No frame should exceed this.
 *
 * Ported from samples/benilla `crates/benilla/src/perf.rs` (`FRAME_BUDGET_MS`).
 */
export const FRAME_BUDGET_MS = 1000 / 60;

/** Recent frames kept for the percentiles (~5 s at 60 fps). benilla's `SAMPLE_WINDOW`. */
export const SAMPLE_WINDOW = 300;

export interface FrameSummary {
  /** Duration of the most recent frame, ms. */
  last: number;
  p50: number;
  p99: number;
  /** The metric that matters: averages hide the hitch a player feels. */
  worst: number;
  /** Count of samples in the window strictly over FRAME_BUDGET_MS. */
  overBudget: number;
  sampleCount: number;
}

const EMPTY: FrameSummary = {
  last: 0, p50: 0, p99: 0, worst: 0, overBudget: 0, sampleCount: 0,
};

/**
 * A fixed-size ring of recent frame durations.
 *
 * Preallocated and never resized: this runs inside the frame it measures, so it must not allocate
 * per push. `summary()` sorts into a reusable scratch array and is called at the HUD's 4 Hz
 * cadence, not per frame.
 */
export class FrameStats {
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  private count = 0;
  private next = 0;
  private last = 0;

  constructor(window: number = SAMPLE_WINDOW) {
    this.samples = new Float64Array(window);
    this.scratch = new Float64Array(window);
  }

  push(ms: number): void {
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    if (this.count < this.samples.length) {
      ++this.count;
    }
    this.last = ms;
  }

  summary(): FrameSummary {
    const n = this.count;
    if (n === 0) {
      return { ...EMPTY };
    }

    const scratch = this.scratch;
    let worst = 0;
    let overBudget = 0;

    for (let i = 0; i < n; ++i) {
      const value = this.samples[i];
      scratch[i] = value;
      if (value > worst) {
        worst = value;
      }
      if (value > FRAME_BUDGET_MS) {
        ++overBudget;
      }
    }

    const sorted = scratch.subarray(0, n);
    sorted.sort();

    return {
      last: this.last,
      p50: percentile(sorted, 0.5),
      p99: percentile(sorted, 0.99),
      worst,
      overBudget,
      sampleCount: n,
    };
  }

  reset(): void {
    this.count = 0;
    this.next = 0;
    this.last = 0;
  }
}

/** Nearest-rank percentile over an ascending-sorted view. */
function percentile(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  const index = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[index];
}
