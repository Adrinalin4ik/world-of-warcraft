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
  visibleMapDoodads: number;
  loadedMapDoodads: number;
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
