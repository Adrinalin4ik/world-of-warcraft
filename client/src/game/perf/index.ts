import { setAnimSectionSink } from './anim-section';
import { CpuSections } from './cpu-sections';
import { frameTrace } from './frame-trace';
import { FrameStats } from './frame-stats';
import { GpuTimer } from './gpu-timer';
import { PerfHud, PerfPayload } from './hud';

export { FRAME_BUDGET_MS, FrameStats } from './frame-stats';
export { CpuSections } from './cpu-sections';
export {
  ANIM_SECTION, beginAnimSection, endAnimSection, setAnimSectionSink, beginSection, endSection,
} from './anim-section';
export { GpuTimer } from './gpu-timer';
export { PerfHud, HUD_REPAINT_MS } from './hud';
export { frameTrace, traceStage } from './frame-trace';
export type { FrameTraceRow } from './frame-trace';
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
  visibleMapDoodads: number;
  loadedMapDoodads: number;
  visibleDoodads: number;
  animResident: number;
  animPosed: number;
  animSkipped: number;
  animBonesSolved: number;
  /** Instances whose solved pose was written into the bone hierarchy. See `counters.ts`. */
  animPosesApplied: number;
  /** Instances whose material channels were sampled. Neither decimated nor bone-budgeted. */
  animMaterialsEvaluated: number;
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
  /** End of the previous frame, so `frame-trace.ts` can report the gap the user actually feels. */
  private lastFrameEnd = 0;

  /**
   * `hudVisible` false hides the overlay and CHANGES NOTHING ELSE: the frame ring, the CPU spans and
   * the GPU query all run exactly as before, so `endFrame`'s payload is identical and anything
   * reading `sections`/`frames` off this object -- a probe, `frameTrace`, a future in-game readout --
   * sees the same numbers. See `PerfHud`'s constructor for what the hidden path actually skips.
   */
  constructor(doc: Document = document, hudVisible = true) {
    this.hud = new PerfHud(doc, hudVisible);
    // Hand the animation loops a way to open the `'anim'` span without any of them knowing about
    // this object. See `anim-section.ts` for why this is a registration and not a second monitor.
    setAnimSectionSink(this.sections);
  }

  /**
   * Show or hide the overlay at runtime. See `PerfHud#setVisible`: the node is built lazily, so this
   * works in a session that never passed `?debug=true`, and it changes no measurement either way.
   */
  setHudVisible(visible: boolean): void {
    this.hud.setVisible(visible);
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
    const frameMs = now - this.frameStart;
    this.frames.push(frameMs);

    const resolved = this.gpu?.poll() ?? null;
    if (resolved !== null) {
      this.lastGpuMs = resolved;
    }

    const sections = this.sections.totals();
    const payload: PerfPayload = {
      frame: this.frames.summary(),
      gpuMs: this.gpu ? this.lastGpuMs : null,
      sections,
      ...counters,
    };
    this.hud.update(now, payload);

    // The per-frame row, for the questions a percentile cannot answer. Off by default; see
    // `frame-trace.ts`. Deliberately AFTER the HUD, so the trace never lengthens a frame the HUD is
    // about to report on.
    if (frameTrace.enabled) {
      frameTrace.push({
        at: now,
        ms: frameMs,
        gap: this.lastFrameEnd === 0 ? frameMs : now - this.lastFrameEnd,
        sections: Object.fromEntries(sections),
        programs: counters.programs,
        calls: counters.calls,
        triangles: counters.triangles,
        geometries: counters.geometries,
        textures: counters.textures,
      });
    }
    this.lastFrameEnd = now;
  }

  dispose(): void {
    setAnimSectionSink(null);
    this.hud.dispose();
  }
}
