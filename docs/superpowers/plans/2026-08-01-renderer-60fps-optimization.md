# Renderer 60 FPS Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold a constant 60 fps (16.7 ms frame budget, no frame over it) in open terrain, dense cities, and doodad-heavy areas.

**Architecture:** Four staged changes behind a measurement gate. Stage 0 builds a perf HUD so every later change is measured rather than guessed. Stage 1 removes fixed per-frame overhead (a per-frame React re-render, a per-frame full-scene traverse). Stage 2 ports the reference client's size-bucketed doodad distance-fade cull. Stage 3 rewrites portal culling from plane-frustums to the reference's narrowing 2-D screen rect, and gates the exterior scene on portal windows. Stage 4 is a measurement decision point, deliberately unspecified.

**Tech Stack:** TypeScript, React 19, three.js r185, Jest 29 (via CRA `react-scripts`), WebGL2.

## Global Constraints

- **Frame budget: 16.666… ms (60 fps floor).** The headline metric is **worst frame ms** over a rolling window, never average fps.
- **All commands run from `client/`.** Test invocation: `CI=true npm test -- --testPathPattern="<pattern>"`.
- **Pure-law tests use the node environment.** Start each such test file with the `/** @jest-environment node */` docblock, matching `src/game/world/light/__tests__/fog.test.ts`.
- **Reference laws are ported, never approximated.** Where `samples/benilla` cites a byte-verified constant, use that exact value. Do not "clean up" epsilons to rounder tolerances.
- **Epsilons, copied verbatim from `wmo_portal/mod.rs`:** on-plane band `0.01`; `w`-clamp band `0.001` (strict `<`); `w` substitute `1.0e-5` (positive regardless of the vertex's sign); rect-collapse minimum NDC extent `0.001`; ray/plane near-parallel `1.0e-4`; eye-embedded-in-plane snap window `0.1` yd.
- **Doodad fade constants, from `model_fade.rs` (`FUN_00683f80`):** never-fade radius `7.0`; buckets `(max_radius, band_start, band_range)` = `(0.5, 40, 10)`, `(2.5, 100, 25)`, `(7.0, 150, 50)`.
- **The doodad bounding-sphere radius is `vertexRadius`, NOT `boundingRadius`.** benilla's `bounding_sphere_radius` is the radius read *before* the collision box (`benilla-m2/src/lib.rs:162`). In `client/src/wow-data-parser/m2/index.js` that field is `vertexRadius:143`; `boundingRadius:147` is the *collision* sphere. The names are inverted between the two codebases. Using `boundingRadius` puts every doodad in the wrong size bucket.
- **Do not change `renderer.outputColorSpace`.** It is deliberately `LinearSRGBColorSpace` (see `pages/game/index.tsx:111`); the whole lighting pipeline is tuned for gamma passthrough.
- **Commit after every task.** Never skip hooks.

---

## File Structure

**Stage 0 — new module `client/src/game/perf/`**

| File | Responsibility |
|---|---|
| `frame-stats.ts` | Ring buffer of frame durations; p50/p99/worst/over-budget. Pure. |
| `cpu-sections.ts` | Named `performance.now()` spans, accumulated per frame. Pure (injected clock). |
| `gpu-timer.ts` | `EXT_disjoint_timer_query_webgl2` wrapper. Returns `null` when unsupported. |
| `hud.ts` | Direct-DOM overlay, throttled to 4 Hz. No React. |
| `index.ts` | `PerfMonitor` — composes the four, exposes one `frame()` API to the render loop. |
| `__tests__/` | One test file per module above. |

**Stage 1 — new file + edits**

| File | Responsibility |
|---|---|
| `client/src/game/world/light/material-registry.ts` | Flat `Set` of light-bound materials, replacing the per-frame `scene.traverse()`. |
| `client/src/pages/game/index.tsx` | Remove per-frame `forceUpdate`; scratch camera vectors. |
| `client/src/game/world/map.js` | Own the registry; drop the traverse. |
| `client/src/game/world/{terrain,doodad,wmo}-manager.js` | Register materials at load time. |
| `client/src/game/pipeline/wmo/portal/index.ts` | Remove the per-portal `setInterval`. |
| `client/src/game/world/visibility-manager.js` | Scratch frustum/matrix objects. |

**Stage 2 — new module `client/src/game/pipeline/m2/fade/`**

| File | Responsibility |
|---|---|
| `laws.ts` | `doodadFadeAlpha(radius, horizDist)` — the pure ported law. |
| `__tests__/laws.test.ts` | Boundary and clamp coverage. |
| `client/src/game/pipeline/m2/index.ts` | Carry `vertexRadius` onto the M2. |
| `client/src/game/world/doodad-manager.js` | Compute and store world radius at placement. |
| `client/src/game/world/visibility-manager.js` | Apply the fade cull; single-pass restructure; bbox invalidation. |

**Stage 3 — new files under `client/src/game/pipeline/wmo/portal/`**

| File | Responsibility |
|---|---|
| `rect.ts` | `ScreenRect`, intersection, collapse test, clip-space projection with the `w` clamp. |
| `__tests__/rect.test.ts` | Rect algebra and the `w`-clamp sign asymmetry. |
| `seed.ts` | Down-ray seed-set generation. |
| `__tests__/seed.test.ts` | Crossing detection and the near-parallel snap. |
| `client/src/game/world/visibility-manager.js` | Flood on rects; exterior windows. |

---

# STAGE 0 — Perf HUD

## Task 1: Frame statistics ring buffer

**Files:**
- Create: `client/src/game/perf/frame-stats.ts`
- Test: `client/src/game/perf/__tests__/frame-stats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FRAME_BUDGET_MS: number`, `SAMPLE_WINDOW: number`, `interface FrameSummary { last: number; p50: number; p99: number; worst: number; overBudget: number; sampleCount: number }`, `class FrameStats { constructor(window?: number); push(ms: number): void; summary(): FrameSummary; reset(): void }`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/perf/__tests__/frame-stats.test.ts`:

```ts
/** @jest-environment node */
import { FrameStats, FRAME_BUDGET_MS } from '../frame-stats';

describe('FRAME_BUDGET_MS', () => {
  it('is the 60 fps floor', () => {
    expect(FRAME_BUDGET_MS).toBeCloseTo(1000 / 60, 10);
  });
});

describe('FrameStats', () => {
  it('reports zeros before any sample', () => {
    const stats = new FrameStats(300);
    expect(stats.summary()).toEqual({
      last: 0, p50: 0, p99: 0, worst: 0, overBudget: 0, sampleCount: 0,
    });
  });

  it('computes percentiles, worst and over-budget over 1..100 ms', () => {
    const stats = new FrameStats(300);
    for (let i = 1; i <= 100; ++i) stats.push(i);

    const s = stats.summary();
    expect(s.sampleCount).toBe(100);
    expect(s.last).toBe(100);
    expect(s.worst).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p99).toBe(99);
    // Frames strictly over 16.666... ms are 17..100 inclusive.
    expect(s.overBudget).toBe(84);
  });

  it('evicts the oldest sample once the window is full', () => {
    const stats = new FrameStats(3);
    stats.push(1); stats.push(2); stats.push(3); stats.push(4);

    const s = stats.summary();
    expect(s.sampleCount).toBe(3);
    expect(s.worst).toBe(4);
    expect(s.last).toBe(4);
    // Window holds [2,3,4]; p50 index = ceil(0.5*3)-1 = 1 -> 3.
    expect(s.p50).toBe(3);
  });

  it('does not mutate sample order when summarising twice', () => {
    const stats = new FrameStats(4);
    stats.push(9); stats.push(1); stats.push(5);
    const first = stats.summary();
    const second = stats.summary();
    expect(second).toEqual(first);
    expect(second.last).toBe(5);
  });

  it('clears everything on reset', () => {
    const stats = new FrameStats(4);
    stats.push(20);
    stats.reset();
    expect(stats.summary().sampleCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/frame-stats"`
Expected: FAIL — `Cannot find module '../frame-stats'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/perf/frame-stats.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/frame-stats"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/perf/frame-stats.ts client/src/game/perf/__tests__/frame-stats.test.ts
git commit -m "feat(perf): frame-duration ring with p50/p99/worst and budget counting"
```

---

## Task 2: Per-system CPU attribution

**Files:**
- Create: `client/src/game/perf/cpu-sections.ts`
- Test: `client/src/game/perf/__tests__/cpu-sections.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class CpuSections { constructor(now?: () => number); beginFrame(): void; begin(name: string): void; end(name: string): void; totals(): ReadonlyMap<string, number> }`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/perf/__tests__/cpu-sections.test.ts`:

```ts
/** @jest-environment node */
import { CpuSections } from '../cpu-sections';

/** A clock that hands out the given readings in order, so timings are exact. */
function fakeClock(readings: number[]) {
  let i = 0;
  return () => readings[i++];
}

describe('CpuSections', () => {
  it('accumulates repeated spans under one name within a frame', () => {
    const sections = new CpuSections(fakeClock([0, 5, 10, 12]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');   // 5 ms
    sections.begin('cull');
    sections.end('cull');   // 2 ms
    expect(sections.totals().get('cull')).toBeCloseTo(7, 10);
  });

  it('keeps separate names separate', () => {
    const sections = new CpuSections(fakeClock([0, 3, 3, 11]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    sections.begin('render');
    sections.end('render');
    expect(sections.totals().get('cull')).toBeCloseTo(3, 10);
    expect(sections.totals().get('render')).toBeCloseTo(8, 10);
  });

  it('clears totals on the next beginFrame', () => {
    const sections = new CpuSections(fakeClock([0, 4, 100, 106]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    expect(sections.totals().get('cull')).toBeCloseTo(6, 10);
  });

  it('ignores end() for a name that was never begun, without throwing', () => {
    const sections = new CpuSections(fakeClock([0, 1]));
    sections.beginFrame();
    expect(() => sections.end('never-opened')).not.toThrow();
    expect(sections.totals().has('never-opened')).toBe(false);
  });

  it('ignores a duplicate begin() rather than losing the earlier start', () => {
    const sections = new CpuSections(fakeClock([0, 5, 20]));
    sections.beginFrame();
    sections.begin('cull');  // starts at 0
    sections.begin('cull');  // ignored; clock reading 5 is consumed
    sections.end('cull');    // ends at 20 -> 20 ms
    expect(sections.totals().get('cull')).toBeCloseTo(20, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/cpu-sections"`
Expected: FAIL — `Cannot find module '../cpu-sections'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/perf/cpu-sections.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/cpu-sections"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/perf/cpu-sections.ts client/src/game/perf/__tests__/cpu-sections.test.ts
git commit -m "feat(perf): per-system CPU span accumulation"
```

---

## Task 3: GPU timing via EXT_disjoint_timer_query_webgl2

**Files:**
- Create: `client/src/game/perf/gpu-timer.ts`
- Test: `client/src/game/perf/__tests__/gpu-timer.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class GpuTimer { static create(gl: WebGL2RenderingContext): GpuTimer | null; begin(): void; end(): void; poll(): number | null }`. `poll()` returns milliseconds when a query has resolved, else `null`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/perf/__tests__/gpu-timer.test.ts`:

```ts
/** @jest-environment node */
import { GpuTimer } from '../gpu-timer';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT_AVAILABLE = 0x8867;
const QUERY_RESULT = 0x8866;

interface FakeQuery { id: number; availableAfter: number; nanos: number }

/** A minimal stand-in for the WebGL2 timer-query surface this class touches. */
function fakeGl(options: { supported?: boolean; disjoint?: boolean } = {}) {
  const { supported = true, disjoint = false } = options;
  let nextId = 1;
  const deleted: number[] = [];
  const ext = { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT };

  const gl: any = {
    QUERY_RESULT_AVAILABLE,
    QUERY_RESULT,
    deleted,
    resolve: null as null | FakeQuery,
    getExtension: (name: string) =>
      supported && name === 'EXT_disjoint_timer_query_webgl2' ? ext : null,
    createQuery: () => ({ id: nextId++, availableAfter: 0, nanos: 0 } as FakeQuery),
    beginQuery: jest.fn(),
    endQuery: jest.fn(),
    deleteQuery: (q: FakeQuery) => deleted.push(q.id),
    getParameter: (pname: number) => (pname === GPU_DISJOINT_EXT ? disjoint : 0),
    getQueryParameter: (q: FakeQuery, pname: number) => {
      if (pname === QUERY_RESULT_AVAILABLE) return gl.resolve?.id === q.id;
      if (pname === QUERY_RESULT) return q.nanos;
      return 0;
    },
  };
  return gl;
}

describe('GpuTimer.create', () => {
  it('returns null when the extension is unavailable', () => {
    expect(GpuTimer.create(fakeGl({ supported: false }))).toBeNull();
  });

  it('returns a timer when the extension is present', () => {
    expect(GpuTimer.create(fakeGl())).toBeInstanceOf(GpuTimer);
  });
});

describe('GpuTimer', () => {
  it('returns null while the query has not resolved', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    expect(timer.poll()).toBeNull();
  });

  it('converts a resolved query from nanoseconds to milliseconds', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    const pending = gl.beginQuery.mock.calls[0][1];
    pending.nanos = 4_500_000;
    gl.resolve = pending;
    expect(timer.poll()).toBeCloseTo(4.5, 6);
  });

  it('discards a disjoint result rather than reporting a bogus time', () => {
    const gl = fakeGl({ disjoint: true });
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.end();
    const pending = gl.beginQuery.mock.calls[0][1];
    pending.nanos = 99_000_000;
    gl.resolve = pending;
    expect(timer.poll()).toBeNull();
    expect(gl.deleted).toContain(pending.id);
  });

  it('ignores a second begin() while one query is already open', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.begin();
    timer.begin();
    expect(gl.beginQuery).toHaveBeenCalledTimes(1);
  });

  it('ignores end() with no open query', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    timer.end();
    expect(gl.endQuery).not.toHaveBeenCalled();
  });

  it('bounds the pending queue rather than leaking queries that never resolve', () => {
    const gl = fakeGl();
    const timer = GpuTimer.create(gl)!;
    for (let i = 0; i < 20; ++i) {
      timer.begin();
      timer.end();
      timer.poll();
    }
    // 20 issued, at most MAX_PENDING retained, the rest deleted.
    expect(gl.deleted.length).toBeGreaterThanOrEqual(20 - 8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/gpu-timer"`
Expected: FAIL — `Cannot find module '../gpu-timer'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/perf/gpu-timer.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/gpu-timer"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/perf/gpu-timer.ts client/src/game/perf/__tests__/gpu-timer.test.ts
git commit -m "feat(perf): GPU frame timing via EXT_disjoint_timer_query_webgl2"
```

---

## Task 4: Throttled direct-DOM HUD overlay

**Files:**
- Create: `client/src/game/perf/hud.ts`
- Test: `client/src/game/perf/__tests__/hud.test.ts`

**Interfaces:**
- Consumes: `FrameSummary` from `../frame-stats`.
- Produces: `HUD_REPAINT_MS: number`, `interface PerfPayload { frame: FrameSummary; gpuMs: number | null; sections: ReadonlyMap<string, number>; calls: number; triangles: number; programs: number; geometries: number; textures: number; visibleChunks: number; visibleGroups: number; visibleDoodads: number }`, `class PerfHud { constructor(doc: Document); update(nowMs: number, payload: PerfPayload): void; dispose(): void }`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/perf/__tests__/hud.test.ts`:

```ts
import { PerfHud, HUD_REPAINT_MS, PerfPayload } from '../hud';

function payload(overrides: Partial<PerfPayload> = {}): PerfPayload {
  return {
    frame: { last: 12, p50: 11, p99: 20, worst: 33, overBudget: 4, sampleCount: 300 },
    gpuMs: 6.25,
    sections: new Map([['cull', 3.5]]),
    calls: 812, triangles: 450000, programs: 40, geometries: 900, textures: 300,
    visibleChunks: 120, visibleGroups: 8, visibleDoodads: 260,
    ...overrides,
  };
}

describe('PerfHud', () => {
  it('mounts a single overlay element into the document', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    expect(document.querySelectorAll('[data-perf-hud]')).toHaveLength(1);
    hud.dispose();
  });

  it('renders the headline worst-frame figure', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    expect(document.body.textContent).toContain('33.0');
    hud.dispose();
  });

  it('shows n/a when GPU timing is unavailable', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload({ gpuMs: null }));
    expect(document.body.textContent).toContain('n/a');
    hud.dispose();
  });

  it('does not repaint before the throttle interval elapses', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.update(HUD_REPAINT_MS - 1, payload({ frame: { ...payload().frame, worst: 99 } }));
    expect(document.body.textContent).not.toContain('99.0');
    hud.dispose();
  });

  it('repaints once the throttle interval elapses', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.update(HUD_REPAINT_MS, payload({ frame: { ...payload().frame, worst: 99 } }));
    expect(document.body.textContent).toContain('99.0');
    hud.dispose();
  });

  it('removes the overlay on dispose', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.dispose();
    expect(document.querySelectorAll('[data-perf-hud]')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/hud"`
Expected: FAIL — `Cannot find module '../hud'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/perf/hud.ts`:

```ts
import { FrameSummary, FRAME_BUDGET_MS } from './frame-stats';

/**
 * Repaint interval, ms (4 Hz). The HUD must not appear meaningfully in its own measurements.
 * Sampling is per frame (cheap counter reads); DOM writes are throttled to this.
 */
export const HUD_REPAINT_MS = 250;

export interface PerfPayload {
  frame: FrameSummary;
  /** null when EXT_disjoint_timer_query_webgl2 is unavailable. */
  gpuMs: number | null;
  sections: ReadonlyMap<string, number>;
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  visibleChunks: number;
  visibleGroups: number;
  visibleDoodads: number;
}

/**
 * The standing perf readout.
 *
 * Deliberately NOT a React component and deliberately not inside the React tree: the existing debug
 * panel re-renders through React every frame and is part of what this exists to measure. This
 * writes `textContent` on a handful of preallocated nodes, at 4 Hz.
 */
export class PerfHud {
  private readonly root: HTMLDivElement;
  private lastPaint = Number.NEGATIVE_INFINITY;
  private painted = false;

  constructor(private readonly doc: Document) {
    this.root = doc.createElement('div');
    this.root.setAttribute('data-perf-hud', '');
    this.root.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:10000',
      'font:11px/1.45 monospace', 'white-space:pre', 'pointer-events:none',
      'padding:8px 10px', 'border-radius:4px',
      'background:rgba(0,0,0,0.72)', 'color:#d8d8d8',
    ].join(';');
    doc.body.appendChild(this.root);
  }

  update(nowMs: number, payload: PerfPayload): void {
    if (this.painted && nowMs - this.lastPaint < HUD_REPAINT_MS) {
      return;
    }
    this.lastPaint = nowMs;
    this.painted = true;
    this.root.textContent = format(payload);
  }

  dispose(): void {
    this.root.remove();
  }
}

function ms(value: number): string {
  return value.toFixed(1);
}

function format(p: PerfPayload): string {
  const f = p.frame;
  const lines = [
    `worst ${ms(f.worst)}ms   budget ${ms(FRAME_BUDGET_MS)}ms`,
    `p50 ${ms(f.p50)}  p99 ${ms(f.p99)}  last ${ms(f.last)}`,
    `over-budget ${f.overBudget}/${f.sampleCount}`,
    `gpu ${p.gpuMs === null ? 'n/a' : `${ms(p.gpuMs)}ms`}`,
    '',
    `calls ${p.calls}  tris ${p.triangles}`,
    `programs ${p.programs}  geom ${p.geometries}  tex ${p.textures}`,
    `chunks ${p.visibleChunks}  groups ${p.visibleGroups}  doodads ${p.visibleDoodads}`,
  ];

  if (p.sections.size > 0) {
    lines.push('');
    for (const [name, value] of p.sections) {
      lines.push(`${name.padEnd(14)}${ms(value)}ms`);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="perf/__tests__/hud"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/perf/hud.ts client/src/game/perf/__tests__/hud.test.ts
git commit -m "feat(perf): throttled direct-DOM perf overlay"
```

---

## Task 5: Compose the monitor and wire it into the render loop

**Files:**
- Create: `client/src/game/perf/index.ts`
- Modify: `client/src/pages/game/index.tsx` (the `animate()` method, currently lines 172-217)

**Interfaces:**
- Consumes: `FrameStats`, `CpuSections`, `GpuTimer`, `PerfHud`, `PerfPayload`.
- Produces: `class PerfMonitor { constructor(doc?: Document); attach(gl: WebGL2RenderingContext): void; beginFrame(): void; endFrame(payload: SceneCounters): void; readonly sections: CpuSections; gpuBegin(): void; gpuEnd(): void; dispose(): void }` and `interface SceneCounters { calls, triangles, programs, geometries, textures, visibleChunks, visibleGroups, visibleDoodads: number }`.

- [ ] **Step 1: Write the composition module**

Create `client/src/game/perf/index.ts`:

```ts
import { CpuSections } from './cpu-sections';
import { FrameStats } from './frame-stats';
import { GpuTimer } from './gpu-timer';
import { PerfHud, PerfPayload } from './hud';

export { FRAME_BUDGET_MS, FrameStats } from './frame-stats';
export { CpuSections } from './cpu-sections';
export { GpuTimer } from './gpu-timer';
export { PerfHud, HUD_REPAINT_MS } from './hud';
export type { FrameSummary } from './frame-stats';
export type { PerfPayload } from './hud';

export interface SceneCounters {
  calls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  visibleChunks: number;
  visibleGroups: number;
  visibleDoodads: number;
}

/**
 * The single object the render loop talks to. Owns the frame ring, the CPU spans, the optional GPU
 * timer and the overlay, so `animate()` gains four call sites rather than a dozen.
 */
export class PerfMonitor {
  readonly sections = new CpuSections();

  private readonly frames = new FrameStats();
  private readonly hud: PerfHud;
  private gpu: GpuTimer | null = null;
  private lastGpuMs: number | null = null;
  private frameStart = 0;

  constructor(doc: Document = document) {
    this.hud = new PerfHud(doc);
  }

  /** Called once the WebGL context exists. Safe to skip: GPU timing then reads `n/a`. */
  attach(gl: WebGL2RenderingContext): void {
    this.gpu = GpuTimer.create(gl);
  }

  beginFrame(): void {
    this.frameStart = performance.now();
    this.sections.beginFrame();
  }

  gpuBegin(): void {
    this.gpu?.begin();
  }

  gpuEnd(): void {
    this.gpu?.end();
  }

  endFrame(counters: SceneCounters): void {
    const now = performance.now();
    this.frames.push(now - this.frameStart);

    const resolved = this.gpu?.poll() ?? null;
    if (resolved !== null) {
      this.lastGpuMs = resolved;
    }

    const payload: PerfPayload = {
      frame: this.frames.summary(),
      gpuMs: this.gpu ? this.lastGpuMs : null,
      sections: this.sections.totals(),
      ...counters,
    };
    this.hud.update(now, payload);
  }

  dispose(): void {
    this.hud.dispose();
  }
}
```

- [ ] **Step 2: Wire it into `animate()`**

In `client/src/pages/game/index.tsx`, add the import alongside the existing ones:

```ts
import { PerfMonitor } from '../../game/perf';
```

Add the field next to `private stats: any = new Stats();` (line 45):

```ts
  private perf: PerfMonitor = new PerfMonitor();
```

In `componentDidMount`, immediately after `console.log('Renderer', renderer);` (line 115):

```ts
    this.perf.attach(renderer.getContext() as WebGL2RenderingContext);
```

Replace the body of `animate()` (lines 172-217) with the instrumented version. Note `stats.begin()`/`stats.end()` are kept — the existing stats-js panel is harmless and useful as a cross-check:

```ts
  animate() {
    this.stats.begin();
    if (!this.renderer) {
      return;
    }

    this.perf.beginFrame();

    const delta = this.clock.getDelta();
    if (this.debugPanel.current) {
      this.debugPanel.current.forceUpdate();
    }

    // Task 4 Step 3: converge the backdrop on the row-7 fog colour, so nothing shows through where the
    // fully-fogged far plane meets the void behind the sky dome. `mapLight.fogColor` already holds raw,
    // unconverted values (every write to it goes through THREE.Color#copy, never `setStyle`/`setHex`,
    // which is what keeps the whole lighting pipeline on the gamma-passthrough lane -- see
    // `renderer.outputColorSpace = LinearSRGBColorSpace` above). `WebGLRenderer#setClearColor` reads
    // the colour back out via `Color#getRGB(target, renderer.outputColorSpace)`, which is a Linear ->
    // Linear identity conversion given that same `outputColorSpace` -- so this stays raw end to end,
    // not merely "close enough".
    const mapLight = this.game.world.mapLight;
    if (mapLight) {
      this.renderer.setClearColor(mapLight.fogColor, 1);
    }

    const cameraMoved: boolean =
      this.prevCameraRotation === null ||
      this.prevCameraPosition === null ||
      !this.prevCameraRotation.equals(this.camera.quaternion) ||
      !this.prevCameraPosition.equals(this.camera.position);

    this.perf.sections.begin('world.animate');
    this.game.world.animate(delta, this.camera, cameraMoved);
    this.perf.sections.end('world.animate');

    this.perf.sections.begin('render');
    this.perf.gpuBegin();
    this.renderer.render(this.game.world.scene, this.camera);
    this.perf.gpuEnd();
    this.perf.sections.end('render');

    if (this.debugRenderer) {
      this.debugCamera.position.set(
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z + this.debugCameraRange,
      );
      this.debugRenderer.render(this.game.world.scene, this.debugCamera);
    }

    this.prevCameraRotation = this.camera.quaternion.clone();
    this.prevCameraPosition = this.camera.position.clone();

    if (this.controls.current) {
      this.controls.current.update(delta);
    }

    const info = this.renderer.info;
    const visibility = this.game.world.map?.visibilityManager;
    this.perf.endFrame({
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      visibleChunks: visibility?.stats.map?.visibleChunks ?? 0,
      visibleGroups: visibility?.stats.wmo.visibleGroups ?? 0,
      visibleDoodads: visibility?.stats.wmo.visibleDoodads ?? 0,
    });

    this.stats.end();
  }
```

- [ ] **Step 3: Add the visible-chunk counter the payload reads**

In `client/src/game/world/visibility-manager.js`, extend the `stats` initialiser in the constructor (lines 15-20) so `stats.map.visibleChunks` exists:

```js
    this.stats = {
      map: {
        visibleChunks: 0,
        visibleDoodads: 0
      },
      wmo: {
        visibleGroups: 0,
        visibleDoodads: 0
      }
    };
```

And in `updateStats()`, before `this.stats.wmo.visibleGroups = visibleGroupCount;`, add:

```js
    let visibleChunkCount = 0;
    for (const chunk of this.map.chunks.values()) {
      if (chunk.visible) {
        visibleChunkCount++;
      }
    }

    let visibleMapDoodadCount = 0;
    for (const doodad of this.map.doodadManager.doodads.values()) {
      if (doodad.visible) {
        visibleMapDoodadCount++;
      }
    }

    this.stats.map.visibleChunks = visibleChunkCount;
    this.stats.map.visibleDoodads = visibleMapDoodadCount;
```

- [ ] **Step 4: Verify the app runs and the HUD appears**

Run: `npm start`
Open the client, log in to a zone, and confirm the overlay is visible top-right showing non-zero `worst`, `calls`, and `tris`. Confirm `gpu` shows either a number or `n/a` — both are acceptable; a crash is not.

Run the whole suite to confirm nothing regressed: `CI=true npm test`
Expected: all existing suites still pass.

- [ ] **Step 5: Record the baseline**

Stand in each of the three locations and record the HUD figures into `docs/superpowers/plans/2026-08-01-perf-measurements.md`. Create that file with this table, filling the Stage 0 row:

```markdown
# Perf measurements

Recorded from the in-client HUD. `worst` is the metric that matters.

## Empty / open terrain

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |

## Dense city (Stormwind)

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |

## Doodad-heavy area

| Stage | p50 | p99 | worst | over-budget | calls | tris |
|---|---|---|---|---|---|---|
| 0 (baseline) | | | | | | |

## Per-system CPU ms (empty terrain, Stage 0)

| section | ms |
|---|---|
| world.animate | |
| render | |
```

- [ ] **Step 6: Commit**

```bash
git add client/src/game/perf/index.ts client/src/pages/game/index.tsx \
        client/src/game/world/visibility-manager.js \
        docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "feat(perf): wire the perf monitor into the render loop and record baselines"
```

---

# STAGE 1 — Fixed per-frame overhead

## Task 6: Stop re-rendering React every frame

**Files:**
- Modify: `client/src/pages/game/index.tsx:150-154` (`callFrame`), and the `debugPanel.forceUpdate()` call inside `animate()`

**Interfaces:**
- Consumes: `PerfMonitor` from Task 5.
- Produces: nothing new.

**Context:** `callFrame()` calls `this.forceUpdate()` on every animation frame, re-rendering the whole `GameScreen` subtree — canvases, `Controls`, `DebugPanel` — 60 times a second. The component's state (`renderer`, `composer`, `currentLocation`) changes at mount and on explicit location changes only. The comment at `index.tsx:39-42` records that `debugPanel.current` was null for a long time and the guarded `forceUpdate()` silently never fired; wiring the ref up connected a full React re-render of the debug panel into the frame loop.

- [ ] **Step 1: Remove the per-frame `forceUpdate` from `callFrame`**

Replace `callFrame()` (lines 150-154) with:

```tsx
  // No forceUpdate here. This component's state (renderer, composer, currentLocation) changes at
  // mount and on explicit user action; re-rendering the subtree at 60 Hz cost a full React
  // reconciliation per frame for nothing. Per-frame numbers go to the perf HUD, which writes DOM
  // directly at 4 Hz (see game/perf/hud.ts).
  callFrame() {
    this.animate();
    window.requestAnimationFrame(this.callFrame.bind(this));
  }
```

- [ ] **Step 2: Throttle the debug panel to the HUD cadence**

Add the field next to the other private fields (near line 45):

```ts
  private lastDebugPanelPaint = 0;
```

In `animate()`, replace:

```ts
    if (this.debugPanel.current) {
      this.debugPanel.current.forceUpdate();
    }
```

with:

```ts
    // The debug panel is a full React subtree. It reads slow-moving values (position, zone, light
    // state) that no one can perceive at 60 Hz, so it repaints on the HUD's 4 Hz cadence.
    const nowMs = performance.now();
    if (this.debugPanel.current && nowMs - this.lastDebugPanelPaint >= HUD_REPAINT_MS) {
      this.lastDebugPanelPaint = nowMs;
      this.debugPanel.current.forceUpdate();
    }
```

Extend the perf import to bring in the constant:

```ts
import { HUD_REPAINT_MS, PerfMonitor } from '../../game/perf';
```

- [ ] **Step 3: Verify in the app**

Run: `npm start`

Confirm: the scene still renders and animates; the controls still respond; the debug panel still updates (visibly slower, ~4×/sec). Record the HUD figures for open terrain into the Stage 1 row of `2026-08-01-perf-measurements.md`.

- [ ] **Step 4: Run the full suite**

Run: `CI=true npm test`
Expected: PASS — no existing suite touches `callFrame`.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/game/index.tsx docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "perf(render): stop re-rendering the React tree every frame"
```

---

## Task 7: Material registry

**Files:**
- Create: `client/src/game/world/light/material-registry.ts`
- Test: `client/src/game/world/light/__tests__/material-registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface LightBoundMaterial { mapLight?: unknown; setMapLight?(light: unknown): void; updateLightUniforms?(): void }`, `interface ApplyResult { seen: number; applied: number }`, `class MaterialRegistry { add(m: LightBoundMaterial): void; addFrom(object: { traverse(cb: (child: any) => void): void }): void; delete(m: LightBoundMaterial): void; clear(): void; readonly size: number; applyLight(current: unknown): ApplyResult }`.

**Context:** `WorldMap.updateAllMaterialsWithLight` (`map.js:293`) currently runs `this.traverse()` over the entire scene graph, visiting every object and every material on it, every single frame. The registry replaces the traversal with a flat set populated at load time. The rebinding semantics documented at `map.js:246-273` must be preserved exactly: the check is `material.mapLight !== current`, **not** a truthiness check, because M2 materials are cached and shared across placements and maps while `changeMap` swaps in a fresh `MapLight` per zone.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/world/light/__tests__/material-registry.test.ts`:

```ts
/** @jest-environment node */
import { LightBoundMaterial, MaterialRegistry } from '../material-registry';

/** A material that records how it was driven, mimicking M2Material's light surface. */
function makeMaterial(): LightBoundMaterial & { bound: unknown[]; refreshes: number } {
  return {
    mapLight: null,
    bound: [] as unknown[],
    refreshes: 0,
    setMapLight(light: unknown) {
      this.mapLight = light;
      (this as any).bound.push(light);
    },
    updateLightUniforms() {
      (this as any).refreshes += 1;
    },
  } as any;
}

describe('MaterialRegistry', () => {
  it('binds an unseen material to the current light', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const light = { id: 'zone-a' };
    expect(registry.applyLight(light)).toEqual({ seen: 1, applied: 1 });
    expect(material.bound).toEqual([light]);
  });

  it('refreshes uniforms instead of rebinding once already bound', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const light = { id: 'zone-a' };
    registry.applyLight(light);
    registry.applyLight(light);

    expect(material.bound).toEqual([light]);
    expect(material.refreshes).toBe(1);
  });

  it('REBINDS when the map light identity changes, not merely when it is absent', () => {
    // The map.js:246-273 staleness trap: M2 materials are cached across maps, so a shared prop
    // keeps the MapLight of whichever zone loaded it first. A truthiness check would leave it
    // bound to a MapLight nobody ticks anymore, freezing its fog and time of day.
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);

    const zoneA = { id: 'zone-a' };
    const zoneB = { id: 'zone-b' };
    registry.applyLight(zoneA);
    registry.applyLight(zoneB);

    expect(material.bound).toEqual([zoneA, zoneB]);
  });

  it('deduplicates a material added twice', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);
    registry.add(material);
    expect(registry.size).toBe(1);
    expect(registry.applyLight({}).seen).toBe(1);
  });

  it('ignores materials with no light surface but still counts them as seen', () => {
    const registry = new MaterialRegistry();
    registry.add({} as LightBoundMaterial);
    expect(registry.applyLight({})).toEqual({ seen: 1, applied: 0 });
  });

  it('stops driving a deleted material', () => {
    const registry = new MaterialRegistry();
    const material = makeMaterial();
    registry.add(material);
    registry.delete(material);
    registry.applyLight({});
    expect(material.bound).toEqual([]);
  });

  it('harvests every material on a subtree, including material arrays', () => {
    const a = makeMaterial();
    const b = makeMaterial();
    const c = makeMaterial();
    const subtree = {
      traverse(cb: (child: any) => void) {
        cb({ material: a });
        cb({ material: [b, c] });
        cb({});
      },
    };

    const registry = new MaterialRegistry();
    registry.addFrom(subtree);
    expect(registry.size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="light/__tests__/material-registry"`
Expected: FAIL — `Cannot find module '../material-registry'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/world/light/material-registry.ts`:

```ts
/** The light-binding surface a material may implement. All members are optional. */
export interface LightBoundMaterial {
  mapLight?: unknown;
  setMapLight?(light: unknown): void;
  updateLightUniforms?(): void;
}

export interface ApplyResult {
  seen: number;
  applied: number;
}

interface Traversable {
  traverse(callback: (child: any) => void): void;
}

/**
 * The set of materials that want per-frame light uniforms.
 *
 * Replaces `WorldMap#updateAllMaterialsWithLight`'s per-frame `scene.traverse()`, which visited
 * every object and every material in the world once per frame purely to find the ones with a light
 * surface. Membership changes only when content streams in or out, so it is maintained at load
 * time and iterated flat per frame.
 *
 * `applyLight` reproduces `WorldMap#applyLightToMaterial` verbatim, including the `!==` identity
 * comparison rather than a truthiness check -- see the long note at world/map.js:246-273. M2
 * materials are cached and shared across placements AND across maps, while `changeMap` installs a
 * brand-new `MapLight` per zone. A truthiness check treats a stale reference as "already bound" and
 * only ever refreshes uniforms against a `MapLight` nobody ticks anymore, freezing that material's
 * fog and time of day.
 */
export class MaterialRegistry {
  private readonly materials = new Set<LightBoundMaterial>();

  get size(): number {
    return this.materials.size;
  }

  add(material: LightBoundMaterial | null | undefined): void {
    if (material) {
      this.materials.add(material);
    }
  }

  /** Harvest every material on a freshly loaded subtree. Call once, at load, never per frame. */
  addFrom(object: Traversable | null | undefined): void {
    if (!object || typeof object.traverse !== 'function') {
      return;
    }
    object.traverse((child: any) => {
      const material = child?.material;
      if (!material) {
        return;
      }
      if (Array.isArray(material)) {
        for (const entry of material) {
          this.add(entry);
        }
      } else {
        this.add(material);
      }
    });
  }

  delete(material: LightBoundMaterial): void {
    this.materials.delete(material);
  }

  clear(): void {
    this.materials.clear();
  }

  applyLight(current: unknown): ApplyResult {
    let seen = 0;
    let applied = 0;

    for (const material of this.materials) {
      ++seen;
      if (material.mapLight !== current && typeof material.setMapLight === 'function') {
        // setMapLight refreshes the uniforms itself.
        material.setMapLight(current);
        ++applied;
      } else if (typeof material.updateLightUniforms === 'function') {
        material.updateLightUniforms();
        ++applied;
      }
    }

    return { seen, applied };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="light/__tests__/material-registry"`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/world/light/material-registry.ts \
        client/src/game/world/light/__tests__/material-registry.test.ts
git commit -m "feat(light): flat material registry to replace the per-frame scene traverse"
```

---

## Task 8: Replace the per-frame scene traverse with the registry

**Files:**
- Modify: `client/src/game/world/map.js` (constructor; `updateAllMaterialsWithLight` at 293-322; `propagateMapLightToAllMaterials` at 209-244)
- Modify: `client/src/game/world/terrain-manager.js:13-20` (`loadChunk`), `:22-27` (`unloadChunk`)
- Modify: `client/src/game/world/doodad-manager.js:120-140` (`loadDoodad`), `:185-197` (`unloadDoodad`)
- Modify: `client/src/game/world/wmo-manager.js` (`entries.set` site at line 190)

**Interfaces:**
- Consumes: `MaterialRegistry` from Task 7.
- Produces: `WorldMap#materialRegistry: MaterialRegistry` — managers register into it at load time.

- [ ] **Step 1: Give `WorldMap` a registry**

In `client/src/game/world/map.js`, add the import next to the others:

```js
import { MaterialRegistry } from './light/material-registry';
```

In the constructor, immediately after `this.visibilityManager = new VisibilityManager(this);`:

```js
    // Materials that want per-frame light uniforms. Populated at content-load time by the managers
    // below, so the per-frame pass never walks the scene graph. See light/material-registry.ts.
    this.materialRegistry = new MaterialRegistry();
```

- [ ] **Step 2: Replace the traverse in `updateAllMaterialsWithLight`**

Replace the whole body of `updateAllMaterialsWithLight()` (lines 293-322) with:

```js
  updateAllMaterialsWithLight() {
    if (!this.mapLight) return;

    // Flat iteration over the registry. This used to be `this.traverse()` across the entire scene
    // graph, every frame, purely to rediscover the same material set. Registration now happens once
    // per loaded object; see light/material-registry.ts for why the rebinding check stays `!==`.
    this.materialRegistry.applyLight(this.mapLight);

    // Object-level lighting, distinct from material uniforms: these iterate their own flat maps
    // already and are not scene walks.
    if (this.wmoManager && this.wmoManager.updateLighting) {
      this.wmoManager.updateLighting();
    }

    if (this.doodadManager && this.doodadManager.updateLighting) {
      this.doodadManager.updateLighting();
    }

    if (this.terrainManager && this.terrainManager.updateLighting) {
      this.terrainManager.updateLighting();
    }
  }
```

Note this adds the previously-missing `terrainManager.updateLighting()` call, which drives the liquid materials.

- [ ] **Step 3: Replace `propagateMapLightToAllMaterials`**

Replace the whole method (lines 209-244) with:

```js
  /**
   * Bind the current light to everything already registered. Runs once from the constructor, when
   * the registry is typically empty -- the streaming managers register as content arrives, and
   * `updateAllMaterialsWithLight` binds each newly seen material on the next frame.
   */
  propagateMapLightToAllMaterials() {
    if (!this.mapLight) return;

    const { seen, applied } = this.materialRegistry.applyLight(this.mapLight);
    console.log(`MapLight: Set MapLight on ${applied}/${seen} materials`);
  }
```

- [ ] **Step 4: Register content at load time**

In `client/src/game/world/terrain-manager.js`, change `loadChunk` and `unloadChunk`:

```js
  loadChunk(_index, terrain) {
    this.view.add(terrain);

    terrain.updateMatrix();
    terrain.updateWorldMatrix();

    // Register this tile's materials once, here, instead of rediscovering them by walking the whole
    // scene every frame.
    this.map.materialRegistry.addFrom(terrain);

    ColliderManager.collidableMeshList.set(terrain.uuid, terrain);
  }

  unloadChunk(_index, terrain) {
    this.view.remove(terrain);

    terrain.traverse((child) => {
      const material = child.material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      materials.forEach((entry) => this.map.materialRegistry.delete(entry));
    });

    terrain.dispose();

    ColliderManager.collidableMeshList.delete(terrain.uuid);
  }
```

In `client/src/game/world/doodad-manager.js`, inside `loadDoodad`, immediately after `this.placeDoodad(doodad, entry.position, entry.rotation, entry.scale);`:

```js
      this.map.materialRegistry.addFrom(doodad);
```

M2 materials are cached and shared across placements, so the registry's `Set` naturally deduplicates. **Do not** remove them in `unloadDoodad`: another placement of the same model may still be live, and `MaterialRegistry.applyLight` on an orphaned material is a cheap uniform write, not a correctness problem. Add this comment above the existing `M2Blueprint.unload(doodad);` line in `unloadDoodad`:

```js
    // Materials are intentionally left in the registry: M2 materials are cached and shared across
    // placements (M2Blueprint.cache), so removing them here would darken every other placement of
    // the same model still on screen.
```

In `client/src/game/world/wmo-manager.js`, at the `this.entries.set(entry.id, wmo);` site (line 190), add immediately after it:

```js
    this.map.materialRegistry.addFrom(wmo);
```

If the surrounding method does not already have `this.map` in scope, use the manager's stored map reference established in its constructor.

- [ ] **Step 5: Verify in the app**

Run: `npm start`

Confirm, in this order:
1. Terrain, doodads and WMOs are lit and fogged exactly as before — not flat-bright, not unfogged.
2. Walk far enough to stream in fresh ADT tiles. Newly streamed terrain must be lit like the tiles around it. (This is the case `map.js:246-273` warns about: `setupLightSystem` runs once from the constructor and reaches nothing.)
3. Change zone (use the location control). Confirm props common to both zones are lit by the *new* zone's light, not frozen at the old one's.

Record open-terrain HUD figures and the `world.animate` CPU section into the measurements file.

- [ ] **Step 6: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/world/map.js client/src/game/world/terrain-manager.js \
        client/src/game/world/doodad-manager.js client/src/game/world/wmo-manager.js \
        docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "perf(light): drive light uniforms from a registry instead of a per-frame scene walk"
```

---

## Task 9: Remove the per-portal timer

**Files:**
- Modify: `client/src/game/pipeline/wmo/portal/index.ts:45-47`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Context:** Every `WMOPortal` constructor starts an interval that reassigns `this.material.color` once a second, forever. The material's `visible` is `false` (`createMaterial`, line 81), so it draws nothing; the interval is never cleared, so live timers accumulate one per portal for the session and each allocates a `THREE.Color`.

- [ ] **Step 1: Delete the interval**

In `client/src/game/pipeline/wmo/portal/index.ts`, remove these lines from the constructor:

```ts
    setInterval(() => {
      this.material.color = new THREE.Color(0xff0000);
    }, 1000)
```

The constructor's last statements become:

```ts
    this.createGeometry(vertices);
    this.createMaterial();
  }
```

- [ ] **Step 2: Verify no other code depended on it**

Run: `grep -rn "setInterval" client/src/game/pipeline/wmo/`
Expected: no matches.

- [ ] **Step 3: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 4: Verify in the app**

Run: `npm start`. Enter a building. Confirm no visual change (the portal material was never drawn) and no console errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/wmo/portal/index.ts
git commit -m "perf(wmo): drop the never-cleared per-portal debug timer"
```

---

## Task 10: Eliminate per-frame allocations in the cull and camera path

**Files:**
- Modify: `client/src/game/world/visibility-manager.js` (constructor; `update` at 23-83; `enableStaticObjectInFrustum` at 163-173)
- Modify: `client/src/game/pipeline/wmo/portal/view.js` (`createFrustum` at 91-141; `intersectFrustum` at 152-180)
- Modify: `client/src/pages/game/index.tsx` (the `prevCameraRotation` / `prevCameraPosition` assignments)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Hoist the frustum and matrix in `VisibilityManager`**

In the constructor of `client/src/game/world/visibility-manager.js`, after the `stats` initialiser, add:

```js
    // Per-frame scratch. `update` runs every frame the camera moves; allocating a Frustum and a
    // Matrix4 here rather than inside it keeps the cull pass allocation-free at its top level.
    this.scratchFrustum = new THREE.Frustum();
    this.scratchViewProjection = new THREE.Matrix4();
```

In `update()`, replace:

```js
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
```

with:

```js
    const frustum = this.scratchFrustum;
    this.scratchViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(this.scratchViewProjection);
```

- [ ] **Step 2: Remove the per-vertex clones in the portal view**

In `client/src/game/pipeline/wmo/portal/view.js`, add a module-level scratch vector above the class:

```js
// Reused across localToWorld conversions. These run per portal vertex, per portal, per frame; a
// fresh Vector3 per vertex was the single largest allocator in the cull pass.
const SCRATCH_VERTEX = new THREE.Vector3();
```

In `createFrustum`, replace the vertex-gathering loop:

```js
    for (let vindex = 0, vcount = this.legacyGeometry.vertices.length; vindex < vcount; ++vindex) {
      const local = this.legacyGeometry.vertices[vindex].clone();
      const world = this.localToWorld(local);
      vertices.push(world);
    }
```

with:

```js
    // These world-space vertices are retained by the clipper, so each needs its own Vector3 -- but
    // the intermediate copy does not.
    for (let vindex = 0, vcount = this.legacyGeometry.vertices.length; vindex < vcount; ++vindex) {
      const world = new THREE.Vector3().copy(this.legacyGeometry.vertices[vindex]);
      this.localToWorld(world);
      vertices.push(world);
    }
```

And replace the distance line:

```js
    const distance = this.portal.plane.distanceToPoint(this.worldToLocal(origin.clone()));
```

with:

```js
    SCRATCH_VERTEX.copy(origin);
    const distance = this.portal.plane.distanceToPoint(this.worldToLocal(SCRATCH_VERTEX));
```

In `intersectFrustum`, replace:

```js
        const vertex = this.localToWorld(vertices[vindex].clone());
        const distance = plane.distanceToPoint(vertex);
```

with:

```js
        SCRATCH_VERTEX.copy(vertices[vindex]);
        this.localToWorld(SCRATCH_VERTEX);
        const distance = plane.distanceToPoint(SCRATCH_VERTEX);
```

- [ ] **Step 3: Remove the per-frame camera clones**

In `client/src/pages/game/index.tsx`, change the field declarations (lines 28-29) from nullable clones to preallocated values plus a seen flag:

```ts
  private prevCameraRotation: THREE.Quaternion = new THREE.Quaternion();
  private prevCameraPosition: THREE.Vector3 = new THREE.Vector3();
  private hasPrevCamera = false;
```

In `animate()`, replace the `cameraMoved` computation:

```ts
    const cameraMoved: boolean =
      !this.hasPrevCamera ||
      !this.prevCameraRotation.equals(this.camera.quaternion) ||
      !this.prevCameraPosition.equals(this.camera.position);
```

and replace the two `.clone()` assignments with copies:

```ts
    this.prevCameraRotation.copy(this.camera.quaternion);
    this.prevCameraPosition.copy(this.camera.position);
    this.hasPrevCamera = true;
```

- [ ] **Step 4: Verify in the app**

Run: `npm start`

Confirm: camera movement still triggers visibility updates (walk around; terrain and buildings appear and disappear as before); standing perfectly still does not. Enter a building and confirm interior culling behaves exactly as it did before this task — no better, no worse. This task is behaviour-neutral by construction; any visual change means a scratch object is being aliased where a distinct instance was required.

- [ ] **Step 5: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/world/visibility-manager.js \
        client/src/game/pipeline/wmo/portal/view.js \
        client/src/pages/game/index.tsx
git commit -m "perf(cull): reuse scratch vectors and matrices in the per-frame cull path"
```

---

## Task 11: Stage 1 measurement gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-perf-measurements.md`

**Interfaces:**
- Consumes: the HUD from Stage 0.
- Produces: the go/no-go decision for Stage 2.

- [ ] **Step 1: Record Stage 1 figures in all three locations**

Run `npm start` and record p50 / p99 / worst / over-budget / calls / tris in open terrain, a dense city, and a doodad-heavy area. Add a `1` row to each table.

- [ ] **Step 2: Record the per-system CPU breakdown**

Add a Stage 1 column to the per-system table, covering `world.animate` and `render`.

- [ ] **Step 3: Evaluate the gate**

The spec's stop condition: **if the empty-zone worst-frame figure has not moved substantially, the model behind this plan is wrong.**

If it has not moved, stop. Do not begin Stage 2. Instead write a short note in the measurements file recording what the `world.animate` and `render` sections actually say, and take that back for a fresh diagnosis — the next stage should be chosen from the attribution, not from this plan's ordering.

If it has moved, note whether open terrain now holds 60. If all three locations hold 60 with zero over-budget frames, the goal is met and Stages 2-4 are unnecessary.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "docs(perf): record Stage 1 measurements and gate decision"
```

---

# STAGE 2 — Doodad distance law and cull restructure

## Task 12: The doodad fade law

**Files:**
- Create: `client/src/game/pipeline/m2/fade/laws.ts`
- Test: `client/src/game/pipeline/m2/fade/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NEVER_FADE_RADIUS: number`, `FADE_BUCKETS: ReadonlyArray<readonly [number, number, number]>`, `doodadFadeAlpha(radius: number, horizDist: number): number`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/fade/__tests__/laws.test.ts`:

```ts
/** @jest-environment node */
import { doodadFadeAlpha, NEVER_FADE_RADIUS } from '../laws';

describe('doodadFadeAlpha size bucketing', () => {
  it('never fades a doodad larger than 7.0 yd, however far away', () => {
    expect(doodadFadeAlpha(7.01, 10_000)).toBe(1);
    expect(NEVER_FADE_RADIUS).toBe(7.0);
  });

  it('puts a doodad of exactly 7.0 yd in the LARGE band, not the never-fade class', () => {
    // The cutoff is `radius <= max_r`, so 7.0 takes the (150, 50) bucket. d = 10000 - 7 is far past
    // the band end, so it culls.
    expect(doodadFadeAlpha(7.0, 10_000)).toBe(0);
  });

  it('puts a doodad of exactly 0.5 yd in the SMALL band', () => {
    // d = 40 - 0.5 = 39.5, which is below the 40 yd band start -> fully opaque.
    expect(doodadFadeAlpha(0.5, 40)).toBe(1);
    // d = 50.5 - 0.5 = 50, exactly the band end -> fully faded.
    expect(doodadFadeAlpha(0.5, 50.5)).toBe(0);
  });

  it('puts a doodad of exactly 2.5 yd in the MID band', () => {
    // d = 102.5 - 2.5 = 100, the band start -> still opaque.
    expect(doodadFadeAlpha(2.5, 102.5)).toBe(1);
    // d = 127.5 - 2.5 = 125, the band end -> fully faded.
    expect(doodadFadeAlpha(2.5, 127.5)).toBe(0);
  });
});

describe('doodadFadeAlpha ramp', () => {
  it('is fully opaque inside the band start', () => {
    expect(doodadFadeAlpha(0.25, 20)).toBe(1);
  });

  it('is exactly half way through the small band', () => {
    // radius 0 -> d == horizDist. Band 40 -> 50, so the midpoint is 45.
    expect(doodadFadeAlpha(0, 45)).toBeCloseTo(0.5, 10);
  });

  it('is fully faded past the band end', () => {
    expect(doodadFadeAlpha(0, 60)).toBe(0);
  });

  it('subtracts the radius, so a bigger doodad in the same band survives further out', () => {
    // Both take the mid band (100 -> 125). The larger one has a smaller d at the same distance.
    const small = doodadFadeAlpha(0.6, 112.5);
    const large = doodadFadeAlpha(2.4, 112.5);
    expect(large).toBeGreaterThan(small);
  });

  it('clamps to [0, 1] for a camera inside the doodad', () => {
    expect(doodadFadeAlpha(2.0, 0)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="m2/fade/__tests__/laws"`
Expected: FAIL — `Cannot find module '../laws'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/pipeline/m2/fade/laws.ts`:

```ts
/**
 * The faithful 1.12 world-doodad distance fade, ported from samples/benilla
 * `crates/benilla/src/model_fade.rs` (`doodad_fade_alpha`), which cites `FUN_00683f80` in
 * `WoW.exe` 5875 with verified operand bytes:
 *
 *   radius cutoffs  0x810188 = 0.5,  0x81018c = 2.5,  0x810190 = 7.0
 *   band ends       0x8101a0 = 50,   0x8101a4 = 125,  0x8101a8 = 200
 *   band ranges     0x810194 = 10,   0x810198 = 25,   0x81019c = 50
 *
 * The band is selected PURELY by the doodad's bounding-sphere radius -- big things stay, small
 * props fade near. Do not substitute a distance-only scheme; the size split is the mechanism.
 */

/** Radius above which a doodad never distance-fades (trees, buildings). Strictly greater. */
export const NEVER_FADE_RADIUS = 7.0;

/**
 * `(max_radius, band_start_yd, band_range_yd)`, ordered small to large. A doodad takes the first
 * bucket whose `max_radius` it does not exceed.
 */
export const FADE_BUCKETS: ReadonlyArray<readonly [number, number, number]> = [
  [0.5, 40, 10],                 // <= 0.5 yd -> 40..50    fences, hay, pumpkins
  [2.5, 100, 25],                // <= 2.5 yd -> 100..125  mid props
  [NEVER_FADE_RADIUS, 150, 50],  // <= 7.0 yd -> 150..200  large props
];

/**
 * Per-object fade alpha for a doodad whose world bounding-sphere radius is `radius` yd (already
 * multiplied by the placement scale) and whose centre is `horizDist` yd from the camera **in the
 * horizontal plane** -- the reference ignores vertical offset.
 *
 *  - `1`        fully opaque; draw normally.
 *  - `0`        fully faded; the caller must CULL the object, not draw it transparent.
 *  - `0 < a < 1` feathering; draw blended so the fade reads as a gradient rather than a pop.
 */
export function doodadFadeAlpha(radius: number, horizDist: number): number {
  if (radius > NEVER_FADE_RADIUS) {
    return 1;
  }

  // Distance to the sphere's surface, not its centre: a bigger object therefore begins fading at a
  // greater centre distance.
  const d = horizDist - radius;

  let start = 150;
  let range = 50;
  for (const [maxRadius, bucketStart, bucketRange] of FADE_BUCKETS) {
    if (radius <= maxRadius) {
      start = bucketStart;
      range = bucketRange;
      break;
    }
  }

  const alpha = 1 - (d - start) / range;
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="m2/fade/__tests__/laws"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/fade/laws.ts \
        client/src/game/pipeline/m2/fade/__tests__/laws.test.ts
git commit -m "feat(m2): port the size-bucketed doodad distance-fade law"
```

---

## Task 13: Carry the bounding-sphere radius onto placed doodads

**Files:**
- Modify: `client/src/game/pipeline/m2/index.ts` (field declarations near line 25; constructor near line 85)
- Modify: `client/src/game/world/doodad-manager.js` (`placeDoodad` at 200-228)

**Interfaces:**
- Consumes: `vertexRadius` from the parsed M2 header.
- Produces: `M2#vertexRadius: number` and `doodad.worldFadeRadius: number` — read by Task 14.

**Context — the trap:** benilla's `bounding_sphere_radius` is the radius read *immediately after the vertex bounding box and before the collision box* (`benilla-m2/src/lib.rs:158-168`). In `client/src/wow-data-parser/m2/index.js` the field order is `minVertexBox, maxVertexBox, vertexRadius:143` then `minBoundingBox, maxBoundingBox, boundingRadius:147`. So **our `vertexRadius` is benilla's `bounding_sphere_radius`, and our `boundingRadius` is benilla's `collision_sphere_radius`.** The names are inverted between the two codebases. Using `boundingRadius` silently puts every doodad in the wrong size bucket.

- [ ] **Step 1: Declare and assign the field on `M2`**

In `client/src/game/pipeline/m2/index.ts`, add to the field declarations beside `boundingVertices` (line 25):

```ts
  vertexRadius: number;
```

In the constructor, beside `this.boundingVertices = data.boundingVertices;` (line 85):

```ts
    // The AUTHORED render bounding-sphere radius (M2 header, immediately after the vertex box).
    // This is benilla's `bounding_sphere_radius`, the one the doodad fade law buckets on -- NOT
    // `data.boundingRadius`, which is the COLLISION sphere. The two names are swapped relative to
    // benilla's parser; see fade/laws.ts.
    this.vertexRadius = data.vertexRadius ?? 0;
```

- [ ] **Step 2: Compute the world radius at placement**

In `client/src/game/world/doodad-manager.js`, inside `placeDoodad`, replace the scale block:

```js
    if (scale !== 1024) {
      const scaleFloat = scale / 1024;
      doodad.scale.set(scaleFloat, scaleFloat, scaleFloat);
    }
```

with:

```js
    const scaleFloat = scale / 1024;

    if (scale !== 1024) {
      doodad.scale.set(scaleFloat, scaleFloat, scaleFloat);
    }

    // World bounding-sphere radius = authored M2 radius x placement scale, matching the reference's
    // `rec+0x68` (`FUN_006952a0`: radius x scale). Read by the distance-fade cull; see
    // pipeline/m2/fade/laws.ts.
    doodad.worldFadeRadius = (doodad.vertexRadius || 0) * scaleFloat;
```

- [ ] **Step 3: Verify the field reaches placed doodads**

Run: `npm start`. In the browser console:

```js
[...world.map.doodadManager.doodads.values()].slice(0, 20).map(d => d.worldFadeRadius)
```

Expected: a spread of positive numbers, most small (well under 7) with occasional larger values for trees and buildings. **If every value is 0, `vertexRadius` is not surviving the worker transfer** — check `pipeline/worker/` and confirm the parsed header is passed through whole.

Sanity-check the split against art: pick a tree and a fence and confirm the tree's radius is the larger.

- [ ] **Step 4: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/index.ts client/src/game/world/doodad-manager.js
git commit -m "feat(m2): carry the authored vertex bounding-sphere radius onto placed doodads"
```

---

## Task 14: Apply the fade cull, and fix the stale bounding-box cache

**Files:**
- Modify: `client/src/game/world/visibility-manager.js` (`enableStaticObjectInFrustum` at 163-173; the group bbox cache at 116-121)

**Interfaces:**
- Consumes: `doodadFadeAlpha` (Task 12), `doodad.worldFadeRadius` (Task 13).
- Produces: `object.fadeAlpha: number` on culled/feathering doodads — read by the material in Task 15.

**Context:** `worldBoundingBox` is computed on first use and cached forever (lines 117 and 165) with no invalidation, so anything that moves after its first culled frame is tested against a stale box.

- [ ] **Step 1: Add the imports and camera scratch**

At the top of `client/src/game/world/visibility-manager.js`:

```js
import { doodadFadeAlpha } from '../pipeline/m2/fade/laws';
```

In the constructor, beside the other scratch objects added in Task 10:

```js
    // Camera position for the horizontal fade distance, refreshed once per update().
    this.cameraX = 0;
    this.cameraY = 0;
```

In `update()`, immediately after the `if (!camera) { return; }` guard:

```js
    this.cameraX = camera.position.x;
    this.cameraY = camera.position.y;
```

- [ ] **Step 2: Apply the fade in `enableStaticObjectInFrustum` and invalidate stale boxes**

Replace `enableStaticObjectInFrustum` (lines 163-173) with:

```js
  enableStaticObjectInFrustum(object, frustum) {
    // The distance fade runs BEFORE the frustum test: it is far cheaper (two subtractions and a
    // compare against the object's own radius) and it rejects the bulk of a dense zone's props
    // outright. See pipeline/m2/fade/laws.ts for the ported law.
    const radius = object.worldFadeRadius;
    if (radius !== undefined) {
      const dx = object.position.x - this.cameraX;
      const dy = object.position.y - this.cameraY;
      const horizDist = Math.sqrt(dx * dx + dy * dy);
      const alpha = doodadFadeAlpha(radius, horizDist);

      object.fadeAlpha = alpha;

      // `fade <= 0` means the object contributes nothing and is not added to the draw list at all.
      if (alpha <= 0) {
        return;
      }
    }

    this.refreshWorldBoundingBox(object);

    if (THREEUtil.frustumContainsBox(frustum, object.worldBoundingBox)) {
      object.visible = true;
    }
  }

  /**
   * Recompute the cached world-space bounding box when the object's world matrix has changed.
   *
   * This used to be a compute-once cache with no invalidation, so any object that moved after its
   * first culled frame was tested against a stale box forever.
   */
  refreshWorldBoundingBox(object) {
    const matrix = object.matrixWorld;
    const version = matrix.elements.join(',');

    if (object.worldBoundingBox && object.worldBoundingBoxKey === version) {
      return;
    }

    const source = object.geometry && object.geometry.boundingBox;
    if (!source) {
      return;
    }

    object.worldBoundingBox = source.clone().applyMatrix4(matrix);
    object.worldBoundingBoxKey = version;
  }
```

Note: `matrix.elements.join(',')` is a string per changed object per frame, which is only acceptable because it is computed **once per object, and only when the object has moved** — a static doodad hits the early return. If the HUD shows this in the profile, replace it with a numeric revision counter bumped by whatever moves the object.

- [ ] **Step 3: Apply the same invalidation to WMO group views**

In `enablePortalsFromExterior`, replace the group bbox cache block (lines 116-121):

```js
        // Cache world-space bounding box on group view
        if (!view.worldBoundingBox) {
          view.worldBoundingBox = group.boundingBox.clone().applyMatrix4(wmo.views.root.matrixWorld);
        }
```

with:

```js
        // Cache world-space bounding box on group view, invalidated when the root moves.
        const rootMatrixKey = wmo.views.root.matrixWorld.elements.join(',');
        if (!view.worldBoundingBox || view.worldBoundingBoxKey !== rootMatrixKey) {
          view.worldBoundingBox = group.boundingBox.clone().applyMatrix4(wmo.views.root.matrixWorld);
          view.worldBoundingBoxKey = rootMatrixKey;
        }
```

- [ ] **Step 4: Verify in the app**

Run: `npm start`

Confirm, standing in a doodad-heavy area:
1. Small props (fences, bushes, hay) disappear at roughly 50 yd; mid props at ~125; large props at ~200. Trees and buildings do not distance-fade at all.
2. `visibleDoodads` on the HUD drops substantially versus the Stage 1 figure.
3. Walking toward a faded prop brings it back — the cull is distance-driven, not sticky.

Record the doodad-heavy and dense-city figures.

- [ ] **Step 5: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/world/visibility-manager.js \
        docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "perf(cull): cull doodads by the ported distance-fade law, and invalidate stale bboxes"
```

---

## Task 15: Feather the fade instead of popping

**Files:**
- Modify: `client/src/game/pipeline/m2/material/index.ts` (add a fade-alpha uniform hook)
- Modify: `client/src/game/world/doodad-manager.js` (`animate`, lines 230-252)

**Interfaces:**
- Consumes: `object.fadeAlpha` from Task 14.
- Produces: `M2Material#setFadeAlpha(alpha: number): void`.

**Context:** Task 14 culls at `alpha <= 0`, which is the performance win and is already complete. This task delivers the `0 < alpha < 1` band so the disappearance reads as a gradient rather than a pop, matching the reference's per-instance render-alpha slot (`CM2Model+0x19c`).

- [ ] **Step 1: Add the uniform setter to the M2 material**

In `client/src/game/pipeline/m2/material/index.ts`, beside `setMapLight` (line 577), add:

```ts
  /**
   * The per-object distance-fade alpha (pipeline/m2/fade/laws.ts). 1 is opaque; the material only
   * needs to blend while it is below 1. Mirrors the reference's single render-alpha slot.
   */
  setFadeAlpha(alpha: number): void {
    if (this.fadeAlpha === alpha) {
      return;
    }
    this.fadeAlpha = alpha;

    const blending = alpha < 1;
    if (this.transparent !== blending) {
      this.transparent = blending;
      this.needsUpdate = true;
    }
    this.opacity = alpha;
  }
```

And declare the backing field beside `private mapLight` (line 162):

```ts
  private fadeAlpha: number = 1;
```

- [ ] **Step 2: Push the alpha from the doodad animate pass**

In `client/src/game/world/doodad-manager.js`, in `animate()`, inside the `this.animatedDoodads.forEach` block is the wrong place — the fade applies to every doodad, animated or not. Add a separate loop at the end of `animate()`:

```js
    // Feather the distance fade. `visibility-manager` already culled anything at alpha <= 0; this
    // only drives the 0 < alpha < 1 band so the disappearance reads as a gradient.
    this.doodads.forEach((doodad) => {
      if (!doodad.visible) {
        return;
      }
      const alpha = doodad.fadeAlpha;
      if (alpha === undefined || !doodad.setFadeAlpha) {
        return;
      }
      doodad.setFadeAlpha(alpha);
    });
```

- [ ] **Step 3: Add the `setFadeAlpha` fan-out on the M2**

In `client/src/game/pipeline/m2/index.ts`, add a method beside the other light fan-outs:

```ts
  setFadeAlpha(alpha: number): void {
    this.batches.forEach((batch: any) => {
      if (batch.material && batch.material.setFadeAlpha) {
        batch.material.setFadeAlpha(alpha);
      }
    });
  }
```

- [ ] **Step 4: Verify in the app**

Run: `npm start`

Confirm: walking away from a small prop, it feathers out over roughly the last 10 yd of its band rather than vanishing in one frame. Confirm no white fringing appears (the opaque-backbuffer reasoning at `index.tsx:84-102` must still hold) and that fully opaque doodads are unaffected.

Record whether the HUD figures moved — blending is not free, and if this costs measurable time it is worth noting.

- [ ] **Step 5: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/material/index.ts client/src/game/pipeline/m2/index.ts \
        client/src/game/world/doodad-manager.js
git commit -m "feat(m2): feather the doodad distance fade instead of popping"
```

---

## Task 16: Single-pass cull restructure

**Files:**
- Modify: `client/src/game/world/visibility-manager.js` (`update` at 23-83; the four `hideAll*` methods at 277-318)

**Interfaces:**
- Consumes: everything from Tasks 10 and 14.
- Produces: nothing new.

**Context:** `update()` currently runs `hideAllMapChanks`, `hideAllMapDoodads`, `hideAllWMOGroups` and `hideAllWMODoodads` — four full sweeps writing `visible = false` over every loaded object — before any culling decision exists. Then the enable passes walk the same collections again. Every loaded object is touched at least twice per frame.

Replacing this with a true single pass means the enable passes must be able to distinguish "not yet decided this frame" from "decided invisible". A frame counter on each object does that without a reset sweep.

- [ ] **Step 1: Add the frame stamp**

In the constructor:

```js
    // Monotonic frame counter. An object whose `visibleFrame` equals the current frame was reached
    // by this frame's traversal; anything else is invisible. This replaces four full "hide
    // everything" sweeps that ran before any culling decision existed.
    this.frame = 0;
```

- [ ] **Step 2: Replace the hide sweeps with the stamp**

In `update()`, replace:

```js
    this.hideAllMapChanks();
    this.hideAllMapDoodads();
    this.hideAllWMOGroups();
    this.hideAllWMODoodads();
```

with:

```js
    ++this.frame;
```

- [ ] **Step 3: Stamp on enable, and resolve at the end**

Change `enableStaticObjectInFrustum`'s success branch from `object.visible = true;` to:

```js
      object.visibleFrame = this.frame;
```

Change the two group-view enables — `view.visible = true;` in `enablePortalsFromExterior` and `groupView.visible = true;` / `destinationView.visible = true;` in the interior and traversal paths — to `.visibleFrame = this.frame;` in each case.

Then add a resolve pass, called from `update()` immediately before `this.updateStats()`:

```js
  /**
   * Write the frame's verdict onto `visible`. One pass over each collection, at the end, instead of
   * a hide sweep at the start plus an enable sweep in the middle.
   */
  resolveVisibility() {
    const frame = this.frame;

    for (const chunk of this.map.chunks.values()) {
      chunk.visible = chunk.visibleFrame === frame;
    }

    for (const doodad of this.map.doodadManager.doodads.values()) {
      doodad.visible = doodad.visibleFrame === frame;
    }

    for (const wmo of this.map.wmoManager.entries.values()) {
      for (const group of wmo.groups.values()) {
        const view = wmo.views.groups.get(group.index);
        if (view) {
          view.visible = view.visibleFrame === frame;
        }
      }

      for (const doodad of wmo.doodads.values()) {
        doodad.visible = doodad.visibleFrame === frame;
      }
    }
  }
```

In `update()`:

```js
    this.resolveVisibility();
    this.updateStats();
```

- [ ] **Step 4: Delete the now-dead hide methods**

Remove `hideAllWMOGroups`, `hideAllWMODoodads`, `hideAllMapDoodads` and `hideAllMapChanks` (lines 277-318).

Run: `grep -rn "hideAll" client/src/`
Expected: no matches outside the large commented-out block at the bottom of the file.

- [ ] **Step 5: Verify in the app**

Run: `npm start`

Confirm behaviour is identical to Task 15: walk through open terrain, a city and a building interior, checking that objects appear and disappear exactly as they did. Any object that stays visible when it should not means an enable site was missed in Step 3; any object that flickers means `resolveVisibility` runs before that site.

Record the figures.

- [ ] **Step 6: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/world/visibility-manager.js \
        docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "perf(cull): resolve visibility in one pass instead of hide-then-enable sweeps"
```

---

## Task 17: Stage 2 measurement gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-perf-measurements.md`

- [ ] **Step 1: Record Stage 2 figures in all three locations**

Add a `2` row to each table.

- [ ] **Step 2: Evaluate**

If all three locations now hold 60 with zero over-budget frames, stop — Stages 3 and 4 are unnecessary for the performance goal. Note in the file that Stage 3 remains outstanding as a **correctness** item (portals are known broken independently of framerate) and should be scheduled on that basis.

If interiors and cities are still short, continue to Stage 3.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "docs(perf): record Stage 2 measurements and gate decision"
```

---

# STAGE 3 — Portal flood as screen rects

## Task 18: Screen-rect algebra and clip-space projection

**Files:**
- Create: `client/src/game/pipeline/wmo/portal/rect.ts`
- Test: `client/src/game/pipeline/wmo/portal/__tests__/rect.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RECT_EPS`, `W_CLAMP_BAND`, `W_CLAMP_SUB`, `ON_PLANE_EPS: number`; `interface ScreenRect { minX, minY, maxX, maxY: number }`; `FULL_SCREEN_RECT: ScreenRect`; `isCollapsed(rect: ScreenRect): boolean`; `intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null`; `ndcFromClip(clip: ArrayLike<number>): [number, number]`; `rectFromClipPolygon(vertices: ReadonlyArray<ArrayLike<number>>): ScreenRect | null`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/wmo/portal/__tests__/rect.test.ts`:

```ts
/** @jest-environment node */
import {
  FULL_SCREEN_RECT,
  intersectRect,
  isCollapsed,
  ndcFromClip,
  rectFromClipPolygon,
  RECT_EPS,
  W_CLAMP_BAND,
  W_CLAMP_SUB,
} from '../rect';

describe('constants', () => {
  it('carries the client epsilons verbatim', () => {
    expect(RECT_EPS).toBe(0.001);
    expect(W_CLAMP_BAND).toBe(0.001);
    expect(W_CLAMP_SUB).toBe(1.0e-5);
  });
});

describe('intersectRect', () => {
  it('narrows to the overlap', () => {
    const a = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    const b = { minX: 0, minY: -0.5, maxX: 0.5, maxY: 0.5 };
    expect(intersectRect(a, b)).toEqual({ minX: 0, minY: -0.5, maxX: 0.5, maxY: 0.5 });
  });

  it('returns null when the rects do not overlap at all', () => {
    const a = { minX: -1, minY: -1, maxX: -0.5, maxY: 1 };
    const b = { minX: 0.5, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('returns null when the overlap collapses below the epsilon in X', () => {
    const a = { minX: -1, minY: -1, maxX: 0, maxY: 1 };
    const b = { minX: -0.0005, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('returns null when the overlap collapses below the epsilon in Y', () => {
    const a = { minX: -1, minY: -1, maxX: 1, maxY: 0 };
    const b = { minX: -1, minY: -0.0005, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).toBeNull();
  });

  it('keeps an overlap exactly at the epsilon', () => {
    const a = { minX: -1, minY: -1, maxX: 0, maxY: 1 };
    const b = { minX: -RECT_EPS, minY: -1, maxX: 1, maxY: 1 };
    expect(intersectRect(a, b)).not.toBeNull();
  });

  it('is the identity against the full-screen rect for an inner rect', () => {
    const inner = { minX: -0.25, minY: -0.25, maxX: 0.25, maxY: 0.25 };
    expect(intersectRect(FULL_SCREEN_RECT, inner)).toEqual(inner);
  });
});

describe('isCollapsed', () => {
  it('is true below the epsilon and false at it', () => {
    expect(isCollapsed({ minX: 0, minY: 0, maxX: 0.0005, maxY: 1 })).toBe(true);
    expect(isCollapsed({ minX: 0, minY: 0, maxX: RECT_EPS, maxY: 1 })).toBe(false);
  });
});

describe('ndcFromClip w clamping', () => {
  it('divides by w normally well outside the band', () => {
    expect(ndcFromClip([2, 4, 0, 4])).toEqual([0.5, 1]);
  });

  it('substitutes a POSITIVE w for a small NEGATIVE w inside the band', () => {
    // |w| < 0.001 -> substitute +1e-5, regardless of the vertex's sign.
    const [x] = ndcFromClip([1, 0, 0, -0.0005]);
    expect(x).toBeCloseTo(1 / W_CLAMP_SUB, 3);
    expect(x).toBeGreaterThan(0);
  });

  it('does NOT clamp a w of exactly -0.001, because the band test is strict', () => {
    const [x] = ndcFromClip([1, 0, 0, -0.001]);
    expect(x).toBeCloseTo(-1000, 6);
  });

  it('does NOT clamp a w of exactly +0.001', () => {
    const [x] = ndcFromClip([1, 0, 0, 0.001]);
    expect(x).toBeCloseTo(1000, 6);
  });
});

describe('rectFromClipPolygon', () => {
  it('takes the screen-space AABB of the projected polygon', () => {
    const rect = rectFromClipPolygon([
      [-1, -1, 0, 2],  // -0.5, -0.5
      [1, -1, 0, 2],   //  0.5, -0.5
      [1, 1, 0, 2],    //  0.5,  0.5
      [-1, 1, 0, 2],   // -0.5,  0.5
    ]);
    expect(rect).toEqual({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 });
  });

  it('returns null for fewer than three vertices', () => {
    expect(rectFromClipPolygon([[0, 0, 0, 1], [1, 1, 0, 1]])).toBeNull();
  });

  it('returns null when the projected polygon is degenerate', () => {
    const rect = rectFromClipPolygon([
      [0, 0, 0, 1],
      [0.0001, 0, 0, 1],
      [0.0001, 0.0001, 0, 1],
    ]);
    expect(rect).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="portal/__tests__/rect"`
Expected: FAIL — `Cannot find module '../rect'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/pipeline/wmo/portal/rect.ts`:

```ts
/**
 * Screen-rect algebra for the WMO portal flood.
 *
 * The reference client does NOT carry a plane frustum through the portal graph -- it carries a 2-D
 * screen rectangle, intersects it with each portal's projected AABB, and kills the branch when the
 * rect collapses to zero area (samples/benilla `crates/benilla/src/wmo_portal/mod.rs`, VERIFIED
 * against WoW.exe 5875). That collapse is exactly why the Stormwind cathedral culls from the Trade
 * District but draws from the gates.
 *
 * Every constant here is the client's own, read from the binary. Do not round them.
 */

/** Minimum NDC extent for a narrowed rect to count as non-empty. Client `0x801360`. */
export const RECT_EPS = 0.001;

/** The `|w|` band below which a clip-space `w` is substituted before the perspective divide. */
export const W_CLAMP_BAND = 0.001;

/**
 * The substituted `w` -- POSITIVE regardless of the vertex's sign (client immediate `0x3727c5ac`).
 * A vertex with `w <= -W_CLAMP_BAND` is NOT clamped: it divides by its real negative `w`.
 */
export const W_CLAMP_SUB = 1.0e-5;

/** Eye-on-portal-plane band, WMO yards. Client `0x6b46f0` / `0x8029d0`. */
export const ON_PLANE_EPS = 0.01;

export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The unrestricted window: the ordinary full-screen frustum. */
export const FULL_SCREEN_RECT: ScreenRect = Object.freeze({
  minX: -1, minY: -1, maxX: 1, maxY: 1,
}) as ScreenRect;

export function isCollapsed(rect: ScreenRect): boolean {
  return rect.maxX - rect.minX < RECT_EPS || rect.maxY - rect.minY < RECT_EPS;
}

/** The narrowed window, or null if the branch dies here. */
export function intersectRect(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const narrowed: ScreenRect = {
    minX: a.minX > b.minX ? a.minX : b.minX,
    minY: a.minY > b.minY ? a.minY : b.minY,
    maxX: a.maxX < b.maxX ? a.maxX : b.maxX,
    maxY: a.maxY < b.maxY ? a.maxY : b.maxY,
  };
  return isCollapsed(narrowed) ? null : narrowed;
}

/** Perspective divide with the client's `w` clamp. `clip` is `[x, y, z, w]`. */
export function ndcFromClip(clip: ArrayLike<number>): [number, number] {
  let w = clip[3];
  // Strict `<` on both sides: a `w` of exactly +/-W_CLAMP_BAND is left alone.
  if (w > -W_CLAMP_BAND && w < W_CLAMP_BAND) {
    w = W_CLAMP_SUB;
  }
  return [clip[0] / w, clip[1] / w];
}

/** Screen-space AABB of a clip-space polygon, or null if degenerate. */
export function rectFromClipPolygon(
  vertices: ReadonlyArray<ArrayLike<number>>,
): ScreenRect | null {
  if (vertices.length < 3) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < vertices.length; ++i) {
    const [x, y] = ndcFromClip(vertices[i]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const rect = { minX, minY, maxX, maxY };
  return isCollapsed(rect) ? null : rect;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="portal/__tests__/rect"`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/wmo/portal/rect.ts \
        client/src/game/pipeline/wmo/portal/__tests__/rect.test.ts
git commit -m "feat(wmo): screen-rect algebra and clip-space w clamp for the portal flood"
```

---

## Task 19: Project a portal to a screen rect

**Files:**
- Modify: `client/src/game/pipeline/wmo/portal/view.js`

**Interfaces:**
- Consumes: `rectFromClipPolygon`, `intersectRect`, `ON_PLANE_EPS`, `FULL_SCREEN_RECT` from Task 18.
- Produces: `WMOPortalView#projectToRect(viewProjection: THREE.Matrix4, incoming: ScreenRect, cameraLocal: THREE.Vector3): ScreenRect | null`.

- [ ] **Step 1: Add the method**

In `client/src/game/pipeline/wmo/portal/view.js`, add the import:

```js
import { FULL_SCREEN_RECT, intersectRect, ON_PLANE_EPS, rectFromClipPolygon } from './rect';
```

Add a module-level scratch buffer beside `SCRATCH_VERTEX`:

```js
// Clip-space scratch, grown on demand. Portal polygons are small (4-8 vertices in practice).
const SCRATCH_CLIP = [];
```

Add the method to the class:

```js
  /**
   * Project this portal into the screen rect the flood should carry through it.
   *
   * Returns the incoming rect narrowed by this portal's screen-space AABB, or null when the branch
   * dies -- either because the portal projects to nothing or because the narrowed rect collapses.
   *
   * The reference's special case: an eye within ON_PLANE_EPS of the portal's plane gets the FULL
   * screen rect for that portal rather than a projected one, because the projection is degenerate
   * there (client `0x6b46f0`).
   */
  projectToRect(viewProjection, incoming, cameraLocal) {
    const onPlane = Math.abs(this.portal.plane.distanceToPoint(cameraLocal)) <= ON_PLANE_EPS;
    if (onPlane) {
      return intersectRect(incoming, FULL_SCREEN_RECT);
    }

    const vertices = this.legacyGeometry.vertices;

    for (let vindex = 0, vcount = vertices.length; vindex < vcount; ++vindex) {
      SCRATCH_VERTEX.copy(vertices[vindex]);
      this.localToWorld(SCRATCH_VERTEX);

      const e = viewProjection.elements;
      const { x, y, z } = SCRATCH_VERTEX;

      let clip = SCRATCH_CLIP[vindex];
      if (!clip) {
        clip = SCRATCH_CLIP[vindex] = [0, 0, 0, 0];
      }

      // Column-major, as THREE.Matrix4 stores it.
      clip[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
      clip[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      clip[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      clip[3] = e[3] * x + e[7] * y + e[11] * z + e[15];
    }

    const projected = rectFromClipPolygon(SCRATCH_CLIP.slice(0, vertices.length));
    if (!projected) {
      return null;
    }

    return intersectRect(incoming, projected);
  }
```

- [ ] **Step 2: Verify the projection against a known case in the browser**

Run: `npm start`. Enter a building with a visible doorway. In the console:

```js
const cam = world.game.camera;
const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
const wmo = [...world.map.wmoManager.entries.values()][0];
const view = [...wmo.views.portals.values()][0];
view.projectToRect(vp, { minX: -1, minY: -1, maxX: 1, maxY: 1 }, view.worldToLocal(cam.position.clone()));
```

Expected: either a rect with all four components inside roughly `[-1, 1]` when the doorway is on screen, or `null` when it is behind you. A rect whose extents are wildly outside `[-1, 1]` for an on-screen doorway means the matrix indexing in Step 1 is transposed.

- [ ] **Step 3: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/game/pipeline/wmo/portal/view.js
git commit -m "feat(wmo): project a portal polygon to its narrowing screen rect"
```

---

## Task 20: Flood the portal graph on rects

**Files:**
- Modify: `client/src/game/world/visibility-manager.js` (`update`, `enablePortalsFromInterior`, `traversePortalsAndEnable`)

**Interfaces:**
- Consumes: `WMOPortalView#projectToRect` (Task 19), `FULL_SCREEN_RECT` (Task 18).
- Produces: `VisibilityManager#exteriorWindows: ScreenRect[]` — consumed by Task 21.

- [ ] **Step 1: Carry a rect instead of a frustum through the flood**

In `client/src/game/world/visibility-manager.js`, add the import:

```js
import { FULL_SCREEN_RECT } from '../pipeline/wmo/portal/rect';
```

In the constructor:

```js
    // Portal windows onto the exterior left by this frame's flood. Empty means a sealed room: the
    // exterior scene is not drawn at all. See exterior_cull.rs.
    this.exteriorWindows = [];
    this.scratchViewProjectionForPortals = new THREE.Matrix4();
```

In `update()`, after the existing view-projection computation, add:

```js
    this.exteriorWindows.length = 0;
    this.scratchViewProjectionForPortals.copy(this.scratchViewProjection);
```

- [ ] **Step 2: Rewrite `traversePortalsAndEnable` to flood on rects**

Replace `traversePortalsAndEnable` (lines 175-275) with:

```js
  /**
   * Flood the portal graph from `group`, carrying a screen rect that narrows at every portal.
   *
   * Ported from samples/benilla `wmo_portal/mod.rs`. The rect -- not a plane frustum -- is the
   * working frustum, and a branch terminates the instant the rect collapses below RECT_EPS. The old
   * implementation built an N-plane frustum per portal per frame and never terminated on area,
   * which is why interiors over-drew.
   */
  traversePortalsAndEnable(depth, camera, wmo, group, rect, visitedPortals) {
    if (depth > 10) return;

    const view = wmo.views.groups.get(group.index);
    if (!view) return;

    SCRATCH_CAMERA_LOCAL.copy(camera.position);
    const cameraLocal = view.worldToLocal(SCRATCH_CAMERA_LOCAL);

    for (const doodad of wmo.doodadsForGroup(group)) {
      this.enableStaticObjectInRect(doodad, rect);
    }

    for (let pindex = 0, pcount = group.portals.length; pindex < pcount; ++pindex) {
      const portal = group.portals[pindex];
      const ref = group.portalRefs[pindex];
      const destination = wmo.groups.get(ref.groupIndex);

      // Destination group is pending load.
      if (!destination) continue;

      const portalView = wmo.views.portals.get(ref.portalIndex);
      const destinationView = wmo.views.groups.get(destination.index);
      const exteriorDestination = (destination.header.flags & 0x08) !== 0;

      if (!portalView || !destinationView) continue;
      if (visitedPortals.has(portalView)) continue;

      if (portalView.legacyGeometry.vertices.length < 4) continue;

      // The side test: portals are traversed outward only. Exactly 0.0 is the client's threshold.
      const distance = portal.plane.distanceToPoint(cameraLocal);
      const insidePortal = ref.side < 0 ? distance <= 0 : distance >= 0;
      if (!insidePortal) continue;

      // Narrow the window through this portal. Null means the branch dies here.
      const nextRect = portalView.projectToRect(
        this.scratchViewProjectionForPortals,
        rect,
        cameraLocal,
      );
      if (!nextRect) continue;

      visitedPortals.add(portalView);
      destinationView.visibleFrame = this.frame;

      if (exteriorDestination) {
        // A doorway onto the outdoors. The exterior scene is drawn once per such window, with the
        // frustum narrowed to it -- and not at all if there are none.
        this.exteriorWindows.push(nextRect);
        continue;
      }

      this.traversePortalsAndEnable(depth + 1, camera, wmo, destination, nextRect, visitedPortals);
    }
  }
```

Add the scratch vector at module level, beside the imports:

```js
const SCRATCH_CAMERA_LOCAL = new THREE.Vector3();
```

- [ ] **Step 3: Add the rect-based static-object test**

Add beside `enableStaticObjectInFrustum`:

```js
  /**
   * Admit a static object against a screen-rect window by building the window's sub-frustum.
   *
   * An NDC rect is a scale-and-offset on clip space, so `rectToNdc * viewProjection` fed to
   * THREE.Frustum extracts the same 6 planes the reference builds by bilerping its corner rays --
   * one plane-extraction implementation instead of a private corner-ray port (exterior_cull.rs).
   */
  enableStaticObjectInRect(object, rect) {
    this.enableStaticObjectInFrustum(object, this.frustumForRect(rect));
  }

  frustumForRect(rect) {
    const sx = 2 / (rect.maxX - rect.minX);
    const sy = 2 / (rect.maxY - rect.minY);
    const tx = -(rect.maxX + rect.minX) / (rect.maxX - rect.minX);
    const ty = -(rect.maxY + rect.minY) / (rect.maxY - rect.minY);

    this.scratchRectToNdc.set(
      sx, 0, 0, tx,
      0, sy, 0, ty,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );

    this.scratchRectMatrix.multiplyMatrices(
      this.scratchRectToNdc,
      this.scratchViewProjectionForPortals,
    );
    this.scratchRectFrustum.setFromProjectionMatrix(this.scratchRectMatrix);
    return this.scratchRectFrustum;
  }
```

And the scratch objects in the constructor:

```js
    this.scratchRectToNdc = new THREE.Matrix4();
    this.scratchRectMatrix = new THREE.Matrix4();
    this.scratchRectFrustum = new THREE.Frustum();
```

**Note:** `frustumForRect` returns a shared scratch frustum. It is safe here because `enableStaticObjectInRect` consumes it immediately and does not retain it. Do not hold the return value across a recursion.

- [ ] **Step 4: Update the two flood entry points**

In `enablePortalsFromInterior`, replace the signature and body's frustum use with a rect:

```js
  enablePortalsFromInterior(depth, camera, rect = FULL_SCREEN_RECT, visitedPortals = new Set()) {
    const wmo = camera.location.wmo.handler;
    const group = camera.location.wmo.group;
    const groupView = camera.location.wmo.views.group;

    // The group the camera is currently in is always visible.
    groupView.visibleFrame = this.frame;

    for (const doodad of wmo.doodadsForGroup(group)) {
      this.enableStaticObjectInRect(doodad, rect);
    }

    this.traversePortalsAndEnable(depth, camera, wmo, group, rect, visitedPortals);
  }
```

In `update()`, change the interior call site to pass the full-screen rect:

```js
    if (camera.location.type === 'exterior') {
      this.enablePortalsFromExterior(0, camera, frustum);
    } else {
      this.enablePortalsFromInterior(0, camera, FULL_SCREEN_RECT);
    }
```

In `enablePortalsFromExterior`, the traversal call at the end of the group loop becomes:

```js
        this.traversePortalsAndEnable(depth, camera, wmo, group, FULL_SCREEN_RECT, visitedPortals);
```

- [ ] **Step 5: Verify in the app**

Run: `npm start`

Confirm, from inside a multi-room building:
1. Rooms not visible through any doorway are no longer drawn. Check the HUD's `groups` count: it must drop versus Stage 2.
2. Standing in a doorway, both rooms draw.
3. Walking through a doorway, the next room appears before you cross the threshold, not after.
4. No room flickers as you turn — a flicker means the side test or the rect narrowing is rejecting a portal it should keep.

Test specifically in Stormwind: the cathedral must cull from the Trade District and draw from the gates.

- [ ] **Step 6: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/world/visibility-manager.js
git commit -m "feat(wmo): flood the portal graph on narrowing screen rects"
```

---

## Task 21: Gate the exterior scene on portal windows

**Files:**
- Modify: `client/src/game/world/visibility-manager.js` (`update`, `enablePortalsFromExterior`)

**Interfaces:**
- Consumes: `VisibilityManager#exteriorWindows` (Task 20).
- Produces: nothing new.

**Context:** `enablePortalsFromExterior` currently sets `map.exterior.visible = true` and walks every map doodad and every chunk on any exterior reach. Per `exterior_cull.rs`, the reference instead walks the exterior **once per portal window**, with the frustum narrowed to that window — and **skips the walk entirely when the window count is zero**. A sealed room draws no exterior at all.

- [ ] **Step 1: Drive the exterior walk from the window list**

Add a method:

```js
  /**
   * Draw the exterior scene once per portal window left by the interior flood.
   *
   * Zero windows means a sealed room: no exterior content, with no second path for it to leak
   * through. Ported from samples/benilla `exterior_cull.rs`, which carves the law out of the world
   * scene driver `0x681070` (`0x681199 jbe 0x681204` skips the whole walk on a zero count).
   */
  enableExteriorThroughWindows(camera) {
    if (this.exteriorWindows.length === 0) {
      this.map.exterior.visible = false;
      return;
    }

    this.map.exterior.visible = true;

    for (let i = 0; i < this.exteriorWindows.length; ++i) {
      const frustum = this.frustumForRect(this.exteriorWindows[i]);

      for (const doodad of this.map.doodadManager.doodads.values()) {
        this.enableStaticObjectInFrustum(doodad, frustum);
      }

      for (const chunk of this.map.chunks.values()) {
        this.enableStaticObjectInFrustum(chunk, frustum);
      }
    }
  }
```

**Note:** this deliberately does NOT gate WMO placements or liquid, matching benilla's stated scope. Those already have their own visibility authority (the portal flood for WMO groups), and adding a second writer to the same objects is the exact two-authorities bug benilla's decision 0025 forbids. A distant building seen through a wall remains a known, accepted deviation until those authorities are taught to consume windows.

- [ ] **Step 2: Call it from the interior path**

In `update()`, replace the branch:

```js
    if (camera.location.type === 'exterior') {
      this.enablePortalsFromExterior(0, camera, frustum);
    } else {
      this.enablePortalsFromInterior(0, camera, FULL_SCREEN_RECT);
      // The flood has now filled `exteriorWindows`. Draw the outdoors only through them.
      this.enableExteriorThroughWindows(camera);
    }
```

- [ ] **Step 3: Verify in the app**

Run: `npm start`

Confirm:
1. In a windowless interior (a cellar, an inner room), the outdoor world is not drawn. The HUD's `chunks` count must reach 0 and `worst` must drop sharply.
2. Standing at an open doorway, terrain and props outside are drawn — but only roughly within the doorway's cone, not the whole hemisphere.
3. Stepping outside restores the full exterior immediately, with no missing terrain.
4. Turning to face away from the only doorway culls the exterior again.

Record the interior figures — this is the change that should show the largest interior improvement.

- [ ] **Step 4: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/world/visibility-manager.js \
        docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "feat(wmo): draw the exterior only through portal windows, and not at all when sealed"
```

---

## Task 22: Down-ray seed set for the camera's current group

**Files:**
- Create: `client/src/game/pipeline/wmo/portal/seed.ts`
- Test: `client/src/game/pipeline/wmo/portal/__tests__/seed.test.ts`
- Modify: `client/src/game/world/visibility-manager.js` (`enablePortalsFromInterior`)

**Interfaces:**
- Consumes: `PORTAL_NEAR_PARALLEL`, `SNAP_WINDOW` (defined here).
- Produces: `PORTAL_NEAR_PARALLEL: number`, `SNAP_WINDOW: number`, `interface PortalCrossing { portalIndex: number; groupIndex: number }`, `crossesDownRay(planeNormalZ: number, signedDistance: number): boolean`.

**Context:** `enablePortalsFromInterior` seeds the flood from a single group (`camera.location.wmo.group`). Per `wmo_portal/seed.rs`, walking-collision faces race portal crossings under the eye, so the reference's verdict is a **seed set** — in-group plus across-group — each flooded as an independent root. A single seed is why standing on a threshold can blank a room.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/wmo/portal/__tests__/seed.test.ts`:

```ts
/** @jest-environment node */
import { crossesDownRay, PORTAL_NEAR_PARALLEL, SNAP_WINDOW } from '../seed';

describe('constants', () => {
  it('carries the client epsilons verbatim', () => {
    expect(PORTAL_NEAR_PARALLEL).toBe(1.0e-4);
    expect(SNAP_WINDOW).toBe(0.1);
  });
});

describe('crossesDownRay', () => {
  it('crosses a horizontal portal the eye sits above', () => {
    // Plane normal points up; eye is 5 yd in front of it. A downward ray reaches it.
    expect(crossesDownRay(1, 5)).toBe(true);
  });

  it('does not cross a horizontal portal the eye sits below', () => {
    expect(crossesDownRay(1, -5)).toBe(false);
  });

  it('snaps a near-parallel (vertical) portal when the eye is inside the snap window', () => {
    // A vertical doorway is parallel to the downward ray: it counts as crossed only via the snap.
    expect(crossesDownRay(0, 0.05)).toBe(true);
    expect(crossesDownRay(0, -0.05)).toBe(true);
  });

  it('does not snap a near-parallel portal outside the snap window', () => {
    expect(crossesDownRay(0, 0.5)).toBe(false);
  });

  it('treats a normal-Z just under the near-parallel threshold as parallel', () => {
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL / 2, 5)).toBe(false);
    expect(crossesDownRay(PORTAL_NEAR_PARALLEL / 2, 0.05)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npm test -- --testPathPattern="portal/__tests__/seed"`
Expected: FAIL — `Cannot find module '../seed'`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/pipeline/wmo/portal/seed.ts`:

```ts
/**
 * Down-ray seed generation for the portal flood.
 *
 * The camera's "current group" is not one group: walking-collision faces race portal crossings
 * under the eye, so the reference's verdict is a SEED SET -- in-group and across-group -- each
 * flooded as an independent root (samples/benilla `wmo_portal/seed.rs`, byte-audited against
 * `wmo-current-group.md` / `wmo-portal-audit.md`).
 */

/**
 * Ray-vs-plane near-parallel threshold on the denominator (the client's f64 `0x811658`). Below it,
 * the down-ray is parallel to the portal plane and the crossing exists only via the snap.
 */
export const PORTAL_NEAR_PARALLEL = 1.0e-4;

/**
 * The "eye embedded in the plane" snap window, WMO yards (the client's `0.1` immediate pushed at
 * `0x6a40c0`): a vertical doorway counts as crossed by the vertical down-ray only when the eye is
 * this close to its plane.
 */
export const SNAP_WINDOW = 0.1;

export interface PortalCrossing {
  portalIndex: number;
  groupIndex: number;
}

/**
 * Does a downward ray from the eye cross this portal's plane?
 *
 * @param planeNormalZ  the portal plane normal's Z component in WMO local space -- the denominator
 *                      of the ray/plane intersection for a straight-down ray.
 * @param signedDistance  the plane's signed distance to the eye.
 */
export function crossesDownRay(planeNormalZ: number, signedDistance: number): boolean {
  if (Math.abs(planeNormalZ) < PORTAL_NEAR_PARALLEL) {
    // Parallel: a vertical doorway. It counts as crossed only when the eye is embedded in its
    // plane, within the snap window.
    return Math.abs(signedDistance) <= SNAP_WINDOW;
  }

  // A downward ray reaches the plane when the eye is on the plane's positive side.
  return signedDistance > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npm test -- --testPathPattern="portal/__tests__/seed"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Flood from the seed set**

In `client/src/game/world/visibility-manager.js`, add the import:

```js
import { crossesDownRay } from '../pipeline/wmo/portal/seed';
```

Replace `enablePortalsFromInterior` with a version that floods every seed:

```js
  enablePortalsFromInterior(depth, camera, rect = FULL_SCREEN_RECT, visitedPortals = new Set()) {
    const wmo = camera.location.wmo.handler;
    const group = camera.location.wmo.group;
    const groupView = camera.location.wmo.views.group;

    // The group the camera is currently in is always visible.
    groupView.visibleFrame = this.frame;

    for (const doodad of wmo.doodadsForGroup(group)) {
      this.enableStaticObjectInRect(doodad, rect);
    }

    this.traversePortalsAndEnable(depth, camera, wmo, group, rect, visitedPortals);

    // Across-group seeds: a portal crossed by the straight-down ray under the eye puts its
    // destination in the seed set too, flooded as an independent root. Without this, standing on a
    // threshold blanks whichever room the collision face happened not to pick.
    const view = wmo.views.groups.get(group.index);
    if (!view) return;

    SCRATCH_CAMERA_LOCAL.copy(camera.position);
    const cameraLocal = view.worldToLocal(SCRATCH_CAMERA_LOCAL);

    for (let pindex = 0, pcount = group.portals.length; pindex < pcount; ++pindex) {
      const portal = group.portals[pindex];
      const ref = group.portalRefs[pindex];

      if (!crossesDownRay(portal.plane.normal.z, portal.plane.distanceToPoint(cameraLocal))) {
        continue;
      }

      const seedGroup = wmo.groups.get(ref.groupIndex);
      const seedView = seedGroup && wmo.views.groups.get(seedGroup.index);
      if (!seedGroup || !seedView) continue;

      seedView.visibleFrame = this.frame;
      this.traversePortalsAndEnable(depth, camera, wmo, seedGroup, rect, visitedPortals);
    }
  }
```

- [ ] **Step 6: Verify in the app**

Run: `npm start`

Confirm: standing exactly in a doorway, both rooms draw and neither blanks as you shuffle across the threshold. Walk slowly through several doorways and stair landings watching for a one-frame blank.

- [ ] **Step 7: Run the full suite**

Run: `CI=true npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/game/pipeline/wmo/portal/seed.ts \
        client/src/game/pipeline/wmo/portal/__tests__/seed.test.ts \
        client/src/game/world/visibility-manager.js
git commit -m "feat(wmo): seed the portal flood from a down-ray seed set, not a single group"
```

---

## Task 23: Stage 3 measurement gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-perf-measurements.md`

- [ ] **Step 1: Record Stage 3 figures**

Add a `3` row to each table, and add a fourth table for **building interior**, which Stage 3 targets specifically.

- [ ] **Step 2: Evaluate**

If all locations hold 60 with zero over-budget frames, the goal is met. Stop; Stage 4 is unnecessary.

Otherwise, record which counter the HUD identifies as the constraint — `calls`, `tris`, a named CPU section, or `gpu` — and carry that into Task 24.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "docs(perf): record Stage 3 measurements and gate decision"
```

---

# STAGE 4 — Draw-call reduction (conditional)

## Task 24: Choose the Stage 4 work from measurement

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-perf-measurements.md`

**Interfaces:**
- Consumes: the Stage 3 gate's identified constraint.
- Produces: a decision, and if work is warranted, a new plan.

**This task deliberately specifies no implementation.** Committing to draw-call work before Stages 1-3 measurements exist would be guessing, and the spec says so explicitly.

- [ ] **Step 1: Identify the constraint from the HUD**

Read the Stage 3 figures and classify:

- **`gpu` at or above the budget while CPU sections are small** ⇒ GPU-bound. Draw-call merging will not help much; look at overdraw, texture bandwidth, and shader cost instead.
- **`calls` in the high hundreds or thousands with low `gpu`** ⇒ draw-call bound. Merging is the right lever.
- **A single named CPU section dominating** ⇒ that system is the constraint, whatever it is. Fix it directly rather than reaching for batching.

- [ ] **Step 2: If draw-call bound, evaluate the candidates in this order**

1. **ADT chunk merging.** `CHUNK_RENDER_RADIUS = 10` (`client/src/game/settings.ts:4`) with `CHUNKS_PER_ROW = 64 * 16` gives a 21×21 window — roughly 441 separate chunk meshes resident, each its own draw. Merging per ADT tile trades cull granularity for call count; note that benilla's decision 0780 records the reference's own drawn unit is the 33.3 yd MCNK cell, not the 533 yd tile, so merging past the cell is a deviation to make deliberately.
2. **Doodad instancing** through the existing `client/src/game/pipeline/m2/batch-manager.js`.
3. **Material and program dedup** — the HUD's `programs` count says whether this is worth anything.
4. **Front-to-back opaque sorting.**

- [ ] **Step 3: Record the decision**

Write the classification and the chosen next step into the measurements file. If work is warranted, that is a new brainstorm and a new plan, not an extension of this one.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-01-perf-measurements.md
git commit -m "docs(perf): record the Stage 4 constraint classification and decision"
```

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to tasks: Stage 0 → Tasks 1-5; Stage 1 → Tasks 6-11; Stage 2 → Tasks 12-17; Stage 3 → Tasks 18-23; Stage 4 → Task 24. The testing section's five named laws map to Tasks 12 (fade bands), 18 (rect intersection, `w`-clamp asymmetry), 22 (seed generation) and 14 (bbox re-test after a move).

**Two corrections made while writing.**

1. **The radius field is inverted between codebases.** benilla's `bounding_sphere_radius` is our `vertexRadius`, not our `boundingRadius` — see the Task 13 context note. The spec did not name a field; this plan does, because getting it wrong is silent.

2. **The bbox re-test is verified in the app, not by a unit test.** The spec's testing section listed it as a unit test, but the cache lives on the `VisibilityManager` and depends on `THREE.Object3D` matrices and a live map. Extracting it purely would mean inventing an abstraction that exists only for the test. Task 14 Step 4 verifies it against real moving content instead, and the invalidation code is small enough to read.

**One deviation carried forward deliberately.** Task 21 does not gate WMO placements or open-world liquid on portal windows, matching benilla's own stated scope: both already have a visibility authority, and adding a second writer to the same objects is the two-authorities bug its decision 0025 forbids. A distant building visible through a wall remains until those authorities are taught to consume windows.
