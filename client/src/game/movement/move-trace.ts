import { SnapTrace } from './mover';
import { SlideIteration } from './slide';
import { StepUpResult, StepUpVerdict } from './step-up';

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
  /** The step-up's intermediate numbers -- see `StepUpResult['detail']` for why they exist. */
  stepUpDetail?: StepUpResult['detail'];
  /**
   * Why the stuck push-out ran or did not, this frame. See the block in `mover.ts` -- a bare
   * `fired: 0` cannot distinguish an absent closure from a gate that is measuring the wrong thing.
   */
  pushOutReason?: 'absent' | 'no-contact' | 'no-input' | 'moved' | 'ran' | 'freed';
  /** Contacts the slide resolved this frame, and the first blocking face. */
  contacts?: number;
  blockedBy?: { normalZ: number; distance: number } | null;
  /** Per-iteration record of the grounded slide, recorded only while the trace is on. */
  slide?: SlideIteration[];
  /** Horizontal distance the whole grounded step actually achieved (yd). */
  travelXY?: number;
}

/**
 * **1200 FRAMES, ABOUT TWENTY SECONDS, AND 120 WAS TOO FEW TO READ.**
 *
 * 120 frames is two seconds, and the player cannot type in the console while holding W -- so every
 * reading of this trace so far has contained only the STANDING frames that followed the gesture,
 * with `travelXY: 0` and an empty slide. That is not a measurement of walking; it is a measurement
 * of stopping, and it read like a conclusion twice.
 *
 * The same window-shorter-than-the-gesture mistake `castTrace` made, in a second instrument, which
 * is what makes it a pattern worth fixing rather than an accident: an instrument someone else has to
 * trigger by hand needs a window longer than the hand.
 *
 * A frame is a dozen numbers and two small arrays, so 1200 is cheap and still bounded.
 */
const HISTORY = 1200;

/**
 * The movement trace recorder.
 *
 * Off by default: set `moveTrace.enabled = true` (or `window.moveTrace.enabled = true` from the
 * console) to record. While off, `frame()` returns immediately and allocates nothing, so leaving
 * the call in the mover's hot path costs a single branch.
 */
class MoveTrace {
  enabled = false;

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
