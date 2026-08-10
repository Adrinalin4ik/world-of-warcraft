/**
 * A per-FRAME ring of everything `PerfMonitor` already computes.
 *
 * WHY THIS EXISTS AND WHY THE HUD IS NOT ENOUGH. `PerfHud` writes DOM at 4 Hz and `FrameStats`
 * reports p50/p99/worst over a window. Both answer "how is it going"; neither can answer "what was
 * happening ON the frame that took 180 ms", which is the only question a HITCH has. The owner's
 * report is a hitch -- ~30 FPS while walking, then a bad stall as a group of never-before-seen mobs
 * comes into view -- and the whole diagnosis is the attribution of ONE frame.
 *
 * So this keeps the raw per-frame row: the frame's own wall time, every CPU span's total for that
 * frame, and the scene counters. `programs` is in there deliberately -- three.js compiles a GLSL
 * program on the first render that uses a new material configuration, and a compile shows up as a
 * spike in `render` on the exact frame `programs` steps up. That correlation is a MEASUREMENT of
 * shader compilation cost; without the per-frame row it is only a hypothesis.
 *
 * Off by default and allocating nothing while off, like `game/movement/move-trace.ts` and
 * `network/.../movement.ts#moveWire`. Turn it on with `window.frameTrace.enabled = true`.
 *
 * NOTE ON THE OTHER KIND OF INSTRUMENT. Two of this project's debug read-outs have read zero while
 * the world was fine, because they were only written from inside something a disabled checkbox
 * skipped. This one is written from `PerfMonitor#endFrame`, which runs on every frame the render
 * loop completes, and from nowhere else -- so if it reads empty, the render loop is not running.
 */

export interface FrameTraceRow {
  /** `performance.now()` at the END of the frame. */
  at: number;
  /** The frame's own CPU wall time, ms -- the same number `FrameStats` percentiles. */
  ms: number;
  /**
   * Wall time since the END of the previous frame, ms -- the number the USER experiences.
   *
   * `ms` is the duration of `animate()` and NOTHING ELSE, so any main-thread work that runs outside
   * it is invisible to `ms` and to every percentile this project has recorded. A promise callback
   * that spends 200 ms building a model runs between two `requestAnimationFrame`s: it delays the
   * next frame by 200 ms without adding a microsecond to either frame's `ms`. `dbf71ed` already met
   * this once ("the frame's biggest cost was outside all of them"); the asset pipeline resolves on
   * promises, so it is exactly where the rest hides. `gap - ms` is that hidden remainder.
   */
  gap: number;
  /** Every CPU span's total for THIS frame, ms. */
  sections: Record<string, number>;
  programs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

class FrameTrace {
  enabled = false;

  private rows: FrameTraceRow[] = [];

  /** ~2 minutes at 30 fps. A row is small and the point is to catch a rare stall. */
  private limit = 4000;

  /**
   * Free-form stage marks the asset path writes, so a spike in a frame row can be lined up against
   * the work that produced it: `{ at, stage, ms, detail }`. Recorded through `mark`, which is a
   * single branch while disabled.
   */
  private markRows: { at: number; stage: string; ms: number; detail: string }[] = [];

  push(row: FrameTraceRow): void {
    if (!this.enabled) {
      return;
    }
    this.rows.push(row);
    if (this.rows.length > this.limit) {
      this.rows.shift();
    }
  }

  /** One completed unit of first-sight work: `frameTrace.mark('m2.build', ms, path)`. */
  mark(stage: string, ms: number, detail: string): void {
    if (!this.enabled) {
      return;
    }
    this.markRows.push({ at: performance.now(), stage, ms, detail });
    if (this.markRows.length > this.limit) {
      this.markRows.shift();
    }
  }

  history(): readonly FrameTraceRow[] {
    return this.rows;
  }

  marks(): readonly { at: number; stage: string; ms: number; detail: string }[] {
    return this.markRows;
  }

  clear(): void {
    this.rows.length = 0;
    this.markRows.length = 0;
  }
}

export const frameTrace = new FrameTrace();

if (typeof window !== 'undefined') {
  (window as any).frameTrace = frameTrace;
}

/**
 * Time a synchronous stage and record it, with NO cost at all when the trace is off.
 *
 * The `enabled` check comes first on purpose: `performance.now()` is not free enough to put two of
 * them around a per-instance `clone()` unconditionally.
 */
export function traceStage<T>(stage: string, detail: string, body: () => T): T {
  if (!frameTrace.enabled) {
    return body();
  }
  const t0 = performance.now();
  try {
    return body();
  } finally {
    frameTrace.mark(stage, performance.now() - t0, detail);
  }
}
