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
  private readonly root: HTMLDivElement;
  private lastPaint = Number.NEGATIVE_INFINITY;
  private painted = false;

  constructor(doc: Document) {
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
    p.animMaterialsEvaluated !== undefined;

  if (hasAnimCounters) {
    lines.push(
      `anim ${p.animPosed ?? 0}/${p.animResident ?? 0} posed  skipped ${p.animSkipped ?? 0}`,
      `bones ${p.animBonesSolved ?? 0}  materials ${p.animMaterialsEvaluated ?? 0}`,
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
