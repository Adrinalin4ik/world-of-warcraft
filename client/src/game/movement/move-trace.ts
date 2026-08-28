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
  /** The horizontal speed the frame was ASKED for (yd/s) -- input, not achievement. */
  speed?: number;
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

  /**
   * **THE SECOND TRIP: consecutive frames that ASKED to move and went nowhere.** `null` to ignore.
   *
   * The owner's "уткнулся в какую-то невидимую преграду" is this and nothing else, and it needs its
   * own trip for the same reason the drop did: by the time a hand reaches the console the state may
   * have resolved, and a stall that resolves is the one whose cause is hardest to name.
   *
   * Asking to move is the load-bearing half of the test. A body standing against a wall also travels
   * nothing and is not stuck -- it is standing -- which is why `speed` is recorded as the input
   * rather than the achievement.
   */
  stopOnStall: number | null = null;

  /** Consecutive stalled frames so far. */
  private stalled = 0;

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
    this.stalled = 0;
    this.stopOnStall = null;
    this.stopOnDrop = yards;
    castTrace.clear();
    castTrace.enabled = true;
    this.enabled = true;
    return `armed: move + cast traces recording, both stop on a grounded frame losing ${yards} yd`;
  }

  /** Arm the stall trip and start recording. Same pairing as `armDrop`: both traces, one event. */
  armStall(frames = 20): string {
    this.clear();
    this.tripped = null;
    this.stalled = 0;
    this.stopOnDrop = null;
    this.stopOnStall = frames;
    castTrace.clear();
    castTrace.enabled = true;
    this.enabled = true;
    return `armed: both traces recording, will stop after ${frames} frames asking to move and not moving`;
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
      this.trip(record);
      return;
    }

    if (this.stopOnStall !== null) {
      /**
       * **A CONTACT WITH NO PROGRESS. It used to test the INPUT, and it never fired.**
       *
       * The owner was stuck, held the key, and the trip stayed armed -- so the reading he could take
       * was thirty frames of standing at the console, which says nothing. `speed` is
       * `state.horizVel.length()`, and a stall is exactly the state where the mover may have clipped
       * that velocity to nothing: the test then reset its own counter on the frames it existed for.
       * Asking about the intent through a value the collision response is allowed to zero was the
       * mistake.
       *
       * A CONTACT is the honest signal and it needs no intent: standing on flat ground the slide
       * resolves no contacts at all -- measured, `no-contact` on 30 of 30 idle frames -- so an idle
       * body cannot trip this, while a body pressed into geometry trips it whatever became of its
       * velocity.
       */
      const went = (record.travelXY ?? 0) >= 1e-3;
      const pressing = (record.contacts ?? 0) > 0;
      this.stalled = pressing && !went ? this.stalled + 1 : 0;
      if (this.stalled >= this.stopOnStall) {
        this.trip(record);
      }
    }
  }

  /**
   * Freeze both records on one event -- **and SAY SO, because an armed trap that reports nothing is
   * indistinguishable from a trap that did not catch anything.**
   *
   * That cost a whole round. The owner armed the stall trip, walked, and read back 519 frames
   * containing no stall at all: 208 `no-obstacle` and not one `net-zero`, so the maneuver never even
   * saw a face. The reading was honest and empty, and neither of us could tell whether the defect was
   * gone, not reached, or the trap broken -- three very different answers -- because there was no
   * moment to point at.
   *
   * One line on the console at the instant of the freeze fixes that: he knows the state was captured
   * without having to read anything back, and silence now means "not reproduced" rather than
   * "unknown". It only ever fires for a trap someone deliberately armed.
   */
  private trip(record: MoveTraceFrame): void {
    this.tripped = record;
    this.enabled = false;
    castTrace.enabled = false;
    const at = `${(record.x ?? 0).toFixed(2)}, ${(record.y ?? 0).toFixed(2)}, ${record.zOut.toFixed(2)}`;
    // eslint-disable-next-line no-console
    console.warn(
      `[moveTrace] TRIPPED and frozen at ${at} -- verdict ${record.stepUpVerdict}, `
      + `drop ${(record.zIn - record.zOut).toFixed(3)}, travel ${(record.travelXY ?? 0).toFixed(4)}, `
      + `${this.frames.length} frames held. Read them now: the trace is no longer recording.`,
    );
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
