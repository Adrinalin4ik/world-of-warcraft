/**
 * Named wall-clock spans accumulated per frame — the per-system attribution that decides which
 * optimization stage matters next.
 *
 * Spans under the same name within one frame SUM, so a system called from two places reports its
 * real total. `beginFrame()` clears the accumulator.
 *
 * The clock is injectable purely so the tests can be exact; production passes nothing and gets
 * `performance.now()`.
 */
export class CpuSections {
  private readonly now: () => number;
  private readonly open = new Map<string, number>();
  private readonly accumulated = new Map<string, number>();

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  beginFrame(): void {
    this.open.clear();
    this.accumulated.clear();
  }

  begin(name: string): void {
    const started = this.now();
    // A duplicate begin() keeps the FIRST start: dropping it would silently under-report a
    // re-entrant system, which is the opposite of what this exists to catch.
    if (!this.open.has(name)) {
      this.open.set(name, started);
    }
  }

  end(name: string): void {
    const started = this.open.get(name);
    if (started === undefined) {
      return;
    }
    this.open.delete(name);
    this.accumulated.set(name, (this.accumulated.get(name) ?? 0) + (this.now() - started));
  }

  totals(): ReadonlyMap<string, number> {
    return this.accumulated;
  }
}
