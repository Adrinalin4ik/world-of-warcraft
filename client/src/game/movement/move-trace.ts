import { castTrace } from '../collision/collision-world';
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
  /**
   * Where this frame ended, horizontally.
   *
   * Recorded because the owner's report is "это происходит всегда в одном месте" -- a defect that
   * repeats at ONE spot is a geometry defect, and the spot is the most valuable thing about it. A
   * trace that says what happened but not where cannot be walked back to.
   *
   * Optional to match the rest of this interface -- the readout's own fixtures build frames
   * without them -- but the mover always supplies both.
   */
  x?: number;
  y?: number;
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

  /**
   * **THE SELF-STOPPING TRIP, in yards of drop. `null` to record continuously.**
   *
   * `armDrop(n)` turns the trace on and stops it again the instant a single grounded frame loses
   * `n` yards of height -- which freezes the ring buffer with the event as its LAST entry and the
   * run-up to it intact.
   *
   * This exists because the alternative does not work, twice proven on this project: an instrument
   * a human switches off by hand records the frames AFTER the gesture, and both `castTrace` and
   * this trace have already produced a reading that was entirely standing-still frames. Falling
   * through a stair is worse than a feel report -- by the time the owner reaches the keyboard the
   * body has landed, slid and settled somewhere else entirely, and the frames that explain it are
   * long out of a window of any length. So the EVENT has to be what stops the recording.
   */
  stopOnDrop: number | null = null;

  /** The frame that tripped `stopOnDrop`, kept after the trace disarms itself. */
  tripped: MoveTraceFrame | null = null;

  /**
   * Arm the trip and start recording. One call, so the console cannot half-arm it.
   *
   * **IT ARMS THE CAST TRACE TOO, and that pairing is the point.** The movement trace says the floor
   * was suddenly 1.5 yd below; only the cast trace can say whether that probe was even OFFERED the
   * surface that had been there the frame before. Provider counts separate the two diagnoses that
   * this symptom cannot distinguish on its own: `wmo` zero at that spot is a broadphase or BSP hole,
   * `wmo` non-zero with no walkable hit is a face the filter refused. Those live in different files.
   *
   * Both freeze on the same event, so the two records are of the same instant rather than of two
   * runs.
   */
  armDrop(yards = 0.5): string {
    this.clear();
    this.tripped = null;
    this.stopOnDrop = yards;
    castTrace.clear();
    castTrace.enabled = true;
    this.enabled = true;
    return `armed: move + cast traces recording, both stop on a grounded frame losing ${yards} yd`;
  }

  frame(record: MoveTraceFrame): void {
    if (!this.enabled) {
      return;
    }

    this.frames.push(record);
    if (this.frames.length > HISTORY) {
      this.frames.shift();
    }

    // AFTER the push, so the tripping frame is in the history rather than only in `tripped`.
    if (this.stopOnDrop !== null && record.zIn - record.zOut >= this.stopOnDrop) {
      this.tripped = record;
      this.enabled = false;
      castTrace.enabled = false;
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
