/**
 * The ONE monotonic animation clock the whole world reads.
 *
 * `InstanceAnim` is clock-indexed by design (`cursor = worldClock - armedAt`), so every consumer
 * has to be handed the same monotonic millisecond count. It is deliberately a module singleton
 * rather than a field on each manager:
 *
 *   * `ModelAnim#globalSequenceCursor(gseq, worldClockMs)` is documented as "a pure function of
 *     world time, identical for every placement of a model". Two clocks -- one in `DoodadManager`,
 *     one per WMO -- would make that flatly untrue the moment they disagreed, and they disagree
 *     immediately: a manager constructed mid-session starts at 0 while the terrain's clock is
 *     already minutes in. The same brazier inside and outside a building would then pulse out of
 *     phase, with nothing in the data to explain it.
 *   * Managers are created and destroyed per zone (`changeMap` builds a fresh `WorldMap`). A clock
 *     owned by one of them restarts on every zone change, which yanks every armed instance's
 *     cursor backwards. A shared clock survives the swap.
 *
 * Advanced exactly once per frame, from `World#animate`, before anything reads it.
 */
class WorldClock {
  /** Milliseconds since the clock started. Monotonic non-decreasing. */
  ms = 0;

  /** Frames advanced. The phase input for `shouldPose`'s decimation stagger. */
  frameIndex = 0;

  /**
   * Advance by one frame's `delta`, in SECONDS (three's `Clock#getDelta` unit).
   *
   * A non-finite or negative delta advances the frame counter but not the clock. `getDelta` can
   * return garbage across a tab suspend or a debugger pause, and a NaN here would propagate into
   * every armed instance's cursor and freeze the entire world in a NaN pose -- irrecoverably, since
   * `armedAtMs` would be NaN too.
   */
  advance(deltaSeconds: number): void {
    this.frameIndex++;
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0) {
      this.ms += deltaSeconds * 1000;
    }
  }

  /** Test seam. Production never rewinds this. */
  reset(): void {
    this.ms = 0;
    this.frameIndex = 0;
  }
}

export const worldClock = new WorldClock();
