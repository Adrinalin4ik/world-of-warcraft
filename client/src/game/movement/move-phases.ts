/**
 * **WHERE AN AT-REST MOVEMENT FRAME SPENDS ITS TIME.**
 *
 * The owner's controlled A/B settled that the terrain gather is NOT the cost: `gatherUs` ~100 us at
 * 4 gathers a frame is **0.4 ms of a 4.6-5.1 ms `ctl.move`**, and rejecting 440 of 441 chunks changed
 * the section not at all. So roughly 90% of the mover is somewhere nothing had instrumented, and this
 * is the split that finds it.
 *
 * ## The resolution problem, stated up front because it shaped the design
 *
 * `performance.now()` on his browser is quantised to **100 us**. A single phase of tens of
 * microseconds therefore reads `0` or `100` and nothing in between -- which is exactly how the
 * per-gather median came back as `0` on one sample and exactly `100` on two others, reporting the
 * clock instead of the work.
 *
 * So every phase here **accumulates** and is reported as a mean over the frame count. Which side of a
 * 100 us boundary a call lands on is unbiased across many calls, so the mean converges where a median
 * cannot; the residual uncertainty is about `100 / sqrt(frames)` us, which at a few hundred frames is
 * single-digit microseconds. Integer counts are preferred wherever the work can be counted instead of
 * timed -- see `LiquidRegistry#census`, which needs no clock at all.
 *
 * ## The phases, and why these five
 *
 * They are the at-rest execution list, established by reading `frame.ts` and `mover.ts`: a grounded
 * frame with no input runs `surfaceAt`, the swim latch, then one `step` whose own work is the
 * frame-start push-out, the ground classify, and `groundedStep` -- inside which `stepUp` and
 * `moveAndSlide` both correctly early-return on zero speed, leaving only the election snap. Five
 * phases cover it, and `total` minus their sum is whatever is left over (allocation, the swim latch,
 * the arithmetic between them).
 */

import { setMovePhaseSource } from '../collision/collision-world';

/** One accumulated phase: how many times it ran and how long in total, microseconds. */
interface Phase {
  calls: number;
  us: number;
}

const phase = (): Phase => ({ calls: 0, us: 0 });

const phases = {
  /** `frame.ts`'s `deps.surfaceAt` -- the LIQUID registry, not the terrain provider. */
  surfaceAt: phase(),
  /** `mover.ts`'s frame-start push-out, gather and solve together. */
  depenetrate: phase(),
  /** The ground classify cast. */
  classify: phase(),
  /** `groundedStep`: the step-up and slide early-return at rest, so this is the election snap. */
  groundedStep: phase(),
  /** The whole of `movementFrame`, so the phases can be checked against it. */
  total: phase(),
};

export type MovePhaseName = keyof typeof phases;

/**
 * Record one phase's duration. `performance.now()` is read by the CALLER, twice, so this adds two
 * arithmetic ops and nothing else.
 */
export function notePhase(name: MovePhaseName, us: number): void {
  const p = phases[name];
  p.calls += 1;
  p.us += us;
}

/** Per-frame means over `frames`, plus the call counts -- the shape `window.moveProfile()` prints. */
export function readMovePhases(frames: number): Record<string, unknown> {
  const n = Math.max(frames, 1);
  const out: Record<string, unknown> = {};
  let accounted = 0;
  for (const name of Object.keys(phases) as MovePhaseName[]) {
    const p = phases[name];
    out[name] = {
      callsPerFrame: Math.round((p.calls / n) * 10) / 10,
      usPerFrame: Math.round((p.us / n) * 10) / 10,
    };
    if (name !== 'total') {
      accounted += p.us;
    }
  }
  // **THE RESIDUAL IS THE POINT when none of the phases dominates.** `total` is measured
  // independently, so `total - sum(phases)` is the work between them: allocation, the swim latch,
  // the arithmetic. A large residual is itself the finding -- "spread thinly" rather than "one hot
  // spot" -- and it is better to see it than to infer it from phases that do not add up.
  out.unaccountedUsPerFrame = Math.round(((phases.total.us - accounted) / n) * 10) / 10;
  return out;
}

export function resetMovePhases(): void {
  for (const name of Object.keys(phases) as MovePhaseName[]) {
    phases[name].calls = 0;
    phases[name].us = 0;
  }
}

// REGISTERED at module load, so `window.moveProfile()` prints the phases without the collision layer
// having to import this module -- see `collision-world.ts#setMovePhaseSource` on why it is a sink.
setMovePhaseSource({ read: readMovePhases, reset: resetMovePhases });
