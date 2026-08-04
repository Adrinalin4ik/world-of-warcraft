import { ModelAnim, Sequence } from './model-anim';
import { ClockLaw, clockLaw, cursorMs } from './tracks';

/**
 * Per-placement animation state: a clock, and nothing else that could have lived on the model.
 *
 * Sampling is CLOCK-INDEXED (`cursor = worldClock - armedAt`), never delta-accumulated
 * (benilla `doodad_anim.rs:14-16`). That is not a stylistic choice -- it is what makes the
 * offscreen gating in `gating.ts` correct. A delta-accumulated clock falls behind by exactly the
 * time it was skipped, so a doodad that leaves the frustum for ten seconds resumes ten seconds
 * behind every other copy of the same model, and the whole set drifts apart permanently. A
 * clock-indexed one resumes to the pose the shared clock dictates: pausing costs nothing and
 * drifts nothing.
 */
export class InstanceAnim {
  readonly model: ModelAnim;

  current: Sequence | null = null;
  armedAtMs = 0;

  /** Cached from `current`, so the per-frame path does not re-derive it. */
  private law: ClockLaw = 0;
  private periodMs = 0;

  constructor(model: ModelAnim) {
    this.model = model;
  }

  /**
   * Start a sequence at `worldClockMs`.
   *
   * The clock law is resolved once, here, from the sequence's own loop flag -- never per sample.
   */
  arm(seq: Sequence, worldClockMs: number): void {
    this.current = seq;
    this.armedAtMs = worldClockMs;
    this.periodMs = seq.lengthMs;
    // A sequence-timeline channel: `globalSequenceID` -1 defers to the sequence's loop flag.
    this.law = clockLaw({ interpolationType: 1, globalSequenceID: -1, tracks: [] }, seq.loops);
  }

  /** Where this instance's own sequence clock stands at `worldClockMs`. */
  cursor(worldClockMs: number): number {
    if (this.current === null) {
      return 0;
    }
    return cursorMs(this.law, worldClockMs - this.armedAtMs, this.periodMs);
  }

  /** Has the current one-shot or loop reached the end of its play window? */
  windowElapsed(worldClockMs: number): boolean {
    if (this.current === null || this.periodMs <= 0) {
      return false;
    }
    return worldClockMs - this.armedAtMs >= this.periodMs;
  }
}
