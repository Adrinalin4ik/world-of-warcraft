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
  /** Map (ADT) doodads — what the distance-fade cull acts on. */
  visibleMapDoodads: number;
  loadedMapDoodads: number;
  /** Doodads belonging to WMO interiors, which the fade cull does not touch. */
  visibleDoodads: number;

  // The animation counters (`pipeline/m2/anim/counters.ts`). Optional because the render loop has
  // always passed them while this HUD rendered none of them -- they were collected and thrown away.
  // Optional rather than required so a caller measuring something else need not invent them.
  animResident?: number;
  animPosed?: number;
  animSkipped?: number;
  animBonesSolved?: number;
  /**
   * Instances whose solved pose reached the bone hierarchy this frame.
   *
   * NOT a bone-texture upload count -- `counters.ts` explains why the two are unrelated on the
   * route that works. Read against `animPosed`: the two differ by every instance that solved but
   * had nothing to write (an unarmed instance with no allocated buffers), so a persistent gap
   * between them is the signature of a population burning `solveBones` for no visible result.
   */
  animPosesApplied?: number;
  /** Instances whose UV / transparency / colour channels were sampled -- ungated by budget. */
  animMaterialsEvaluated?: number;
}

/**
 * The standing perf readout.
 *
 * Deliberately NOT a React component and deliberately not inside the React tree: the existing debug
 * panel re-renders through React every frame and is part of what this exists to measure. This
 * writes `textContent` on one preallocated node, at 4 Hz.
 */
export class PerfHud {
  /** Null until the HUD is first shown -- see the `visible` constructor argument and `setVisible`. */
  private root: HTMLDivElement | null;

  /** Held so `setVisible` can build the node later than the constructor did not. */
  private readonly doc: Document;
  private lastPaint = Number.NEGATIVE_INFINITY;
  private painted = false;

  /**
   * `visible` false builds NO DOM node at all and makes `update` a return.
   *
   * The gate is the display, not the measurement: `PerfMonitor` still pushes every frame into
   * `FrameStats`, still closes every `CpuSections` span and still polls the GPU query, so
   * `window.GameScreen.perf` answers exactly the same numbers with the HUD off as with it on. What
   * stops is one `textContent` write at 4 Hz and the `format()` that builds its string. MEASURED
   * (`scratchpad/d12-hudcost.js`, 400 forced paints with the real payload on the live page): p50
   * **0.0 ms**, p99 **0.1 ms** -- and 0.1 ms is the `performance.now()` resolution the page gets, so
   * that is an upper bound rather than a reading. Four of those a second. **Hiding the HUD is a
   * cosmetic change, not a performance one**, and anyone who reads a frame-time difference into
   * `?debug=true` is reading noise.
   */
  constructor(doc: Document, visible = true) {
    this.doc = doc;
    if (!visible) {
      this.root = null;
      return;
    }
    this.root = this.build();
  }

  /**
   * Show or hide the HUD at runtime -- the owner asked to toggle it from the console.
   *
   * **The node is built LAZILY, which is the whole reason this is not a one-line `display` flip.** The
   * constructor's hidden path creates no DOM at all (see its doc), so a session started without
   * `?debug=true` has nothing to unhide; turning it on has to construct the node then. That also keeps
   * the hidden case exactly as cheap as it was -- nothing is created for a viewer who never asks.
   *
   * Toggling changes NOTHING about the measurement, for the reason the constructor states at length:
   * every span, frame and GPU query runs either way, so a number read with the HUD off is the same
   * number. Turning it on mid-session is therefore safe to compare against a capture taken with
   * `?debug=true` from boot.
   */
  setVisible(visible: boolean): void {
    if (!visible) {
      if (this.root !== null) {
        this.root.remove();
        this.root = null;
      }
      return;
    }
    if (this.root === null) {
      this.root = this.build();
      // A fresh node has never been painted, so let the next `update` write immediately rather than
      // wait out the repaint interval -- otherwise turning it on looks like it did nothing.
      this.painted = false;
    }
  }

  private build(): HTMLDivElement {
    const doc = this.doc;
    const root = doc.createElement('div');
    root.setAttribute('data-perf-hud', '');
    root.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:10000',
      'font:11px/1.45 monospace', 'white-space:pre', 'pointer-events:none',
      'padding:8px 10px', 'border-radius:4px',
      'background:rgba(0,0,0,0.72)', 'color:#d8d8d8',
    ].join(';');
    doc.body.appendChild(root);
    return root;
  }

  update(nowMs: number, payload: PerfPayload): void {
    if (this.root === null || (this.painted && nowMs - this.lastPaint < HUD_REPAINT_MS)) {
      return;
    }
    this.lastPaint = nowMs;
    this.painted = true;
    this.root.textContent = format(payload);
  }

  dispose(): void {
    this.root?.remove();
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
    `chunks ${p.visibleChunks}  groups ${p.visibleGroups}`,
    `map doodads ${p.visibleMapDoodads}/${p.loadedMapDoodads}  wmo doodads ${p.visibleDoodads}`,
  ];

  // ANY animation counter turns the block on, not `animResident` alone. The rows print four other
  // fields, so keying on one of them meant a caller supplying, say, only `animPosed` and
  // `animMaterialsEvaluated` got no rows at all -- the measurement was collected and then silently
  // dropped, which is the same failure these rows were added to fix.
  const hasAnimCounters =
    p.animResident !== undefined ||
    p.animPosed !== undefined ||
    p.animSkipped !== undefined ||
    p.animBonesSolved !== undefined ||
    p.animPosesApplied !== undefined ||
    p.animMaterialsEvaluated !== undefined;

  if (hasAnimCounters) {
    lines.push(
      `anim ${p.animPosed ?? 0}/${p.animResident ?? 0} posed  skipped ${p.animSkipped ?? 0}`,
      `bones ${p.animBonesSolved ?? 0}  applied ${p.animPosesApplied ?? 0}  materials ${p.animMaterialsEvaluated ?? 0}`,
    );
  }

  if (p.sections.size > 0) {
    lines.push('');
    for (const [name, value] of p.sections) {
      lines.push(`${name.padEnd(14)}${ms(value)}ms`);
    }
  }

  return lines.join('\n');
}
