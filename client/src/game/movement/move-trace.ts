import { SnapTrace } from './mover';
import { SlideIteration } from './slide';
import { StepUpVerdict } from './step-up';

/**
 * One frame of the movement trace.
 *
 * Feel is not unit-testable, so this is how a "it feels stuck here" report becomes diagnosable: it
 * records every probe number and the step-up's verdict. The reference records that this instrument
 * is what broke its fence and tree cases when reasoning alone could not, which is why it is built
 * up front rather than after the first report that something plays wrong.
 */
export interface MoveTraceFrame {
  zIn: number;
  zOut: number;
  grounded: boolean;
  onWalkable: boolean;
  velZ: number;
  snap: SnapTrace | null;
  climb: number | null;
  stepUpVerdict: StepUpVerdict | null;
  /** Contacts the slide resolved this frame, and the first blocking face. */
  contacts?: number;
  blockedBy?: { normalZ: number; distance: number } | null;
  /** Per-iteration record of the grounded slide, recorded only while the trace is on. */
  slide?: SlideIteration[];
  /** Horizontal distance the whole grounded step actually achieved (yd). */
  travelXY?: number;
}

const HISTORY = 120;

/**
 * The movement trace recorder.
 *
 * Off by default: set `moveTrace.enabled = true` (or `window.moveTrace.enabled = true` from the
 * console) to record. While off, `frame()` returns immediately and allocates nothing, so leaving
 * the call in the mover's hot path costs a single branch.
 */
class MoveTrace {
  enabled = false;

  /**
   * THE CONTROL ARM for the slide's final move (`slide.ts#moveAndSlide`).
   *
   * Set `window.moveTrace.slideFinalMove = false` and the loop reverts to its pre-fix behaviour --
   * the budget ends the frame wherever the last contact left the body, discarding the clipped
   * velocity. Kept because the fix's evidence is an A/B on ONE build at ONE spot: without a control
   * arm, "he walks past the fence now" is indistinguishable from "the doodads streamed in
   * differently this run", which is exactly how the stall's first candidate cause survived several
   * rounds. It is read once per grounded slide -- one boolean, no allocation.
   */
  slideFinalMove = true;

  private frames: MoveTraceFrame[] = [];

  frame(record: MoveTraceFrame): void {
    if (!this.enabled) {
      return;
    }

    this.frames.push(record);
    if (this.frames.length > HISTORY) {
      this.frames.shift();
    }
  }

  last(): MoveTraceFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  history(): readonly MoveTraceFrame[] {
    return this.frames;
  }

  clear(): void {
    this.frames.length = 0;
  }
}

export const moveTrace = new MoveTrace();

if (typeof window !== 'undefined') {
  (window as any).moveTrace = moveTrace;
}
