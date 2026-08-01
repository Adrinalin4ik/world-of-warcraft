/**
 * GPU frame time via `EXT_disjoint_timer_query_webgl2`.
 *
 * This is what makes "CPU-bound or GPU-bound?" a measurement instead of a guess. The extension is
 * not universally available (and is disabled outright in some browsers); where it is missing,
 * `create()` returns null and the HUD shows `n/a`. It never falls back to a fabricated number.
 *
 * Timer queries resolve asynchronously, some frames after they are issued, so results are polled
 * rather than awaited. A GPU_DISJOINT event means the timer was interrupted and its result is
 * meaningless: that result is discarded, not reported.
 */
export class GpuTimer {
  /** Cap on unresolved queries. Queries that never resolve must not accumulate forever. */
  private static readonly MAX_PENDING = 8;

  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    return ext ? new GpuTimer(gl, ext) : null;
  }

  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: any,
  ) {}

  begin(): void {
    if (this.active) {
      return;
    }
    const query = this.gl.createQuery();
    if (!query) {
      return;
    }
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(): void {
    if (!this.active) {
      return;
    }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;

    while (this.pending.length > GpuTimer.MAX_PENDING) {
      const stale = this.pending.shift() as WebGLQuery;
      this.gl.deleteQuery(stale);
    }
  }

  /** Milliseconds for the most recently resolved query, or null if none resolved this call. */
  poll(): number | null {
    let ms: number | null = null;

    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)) {
        break;
      }
      this.pending.shift();

      const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        ms = this.gl.getQueryParameter(query, this.gl.QUERY_RESULT) / 1e6;
      }
      this.gl.deleteQuery(query);
    }

    return ms;
  }
}
