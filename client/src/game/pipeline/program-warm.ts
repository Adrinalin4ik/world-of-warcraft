import * as THREE from 'three';

/**
 * Warm a newly-built body's GLSL programs OFF the frame that would otherwise have to compile them,
 * and reveal it when they are ready.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MEASUREMENT THIS COMES FROM
 *
 * The owner reported ~30 FPS while walking and a bad hitch on approaching a place where mobs he had
 * not seen before spawn. His own reading was "the server sends new data and the client renders it on
 * the main thread", and the striking part of the report was that it is only NEW KINDS that hurt --
 * repeat instances do not -- which points at a per-model-type one-time cost rather than a
 * per-instance one.
 *
 * `perf/frame-trace.ts` was built to answer which one. Measured on a real 40.6 s walk as `Gesf`
 * through Northshire on ANGLE (headless Chrome, `--use-gl=angle`), 2387 frames, recorded WHILE
 * MOVING (every performance number previously on record for this project was taken standing still):
 *
 * | metric                                   | value |
 * | ---------------------------------------- | ----- |
 * | frame gap p50 / p90 / p99 / worst        | 16.7 / 20.3 / 28.2 / **73.3** ms |
 * | frames whose `programs` count grew       | 5 |
 * | mean frame on a frame that COMPILED      | **37.8 ms** (worst 61.8) |
 * | mean frame on a frame that did not       | **12.7 ms** (worst 29.8) |
 * | mean `render` span, all walking frames   | 2.5 ms |
 * | mean `render` span, frames over 60 ms    | **24.1 ms** |
 *
 * So: a frame that compiles a program costs about three times a frame that does not, the whole of
 * the excess is inside the `render` span, and the two worst frames in the walk (61.8 ms and 53.1 ms)
 * are both frames on which `programs` stepped up, with `render` reading 50.2 and 41.3 ms. That is
 * shader program compilation, and it is by a wide margin the largest single per-frame cost the walk
 * contained.
 *
 * WHAT THE SAME MEASUREMENT ACQUITTED, so this is not a guess between six candidates:
 *  - **M2 geometry construction and cloning**: `m2.build` and `m2.clone` marks totalled 195 ms over
 *    the 40.6 s walk -- 0.5 % of wall time. Per call: doodad clone p50 0.10 ms, doodad build p50
 *    0.60 ms (max 16.4), creature clone mean 9.3 ms (n=3, max 10.9). Real, and an order of magnitude
 *    below one program compile.
 *  - **M2 parse** is already in the worker (`M2Blueprint.load` -> `WorkerPool.enqueue('M2', path)`),
 *    as is **BLP decode**, which earlier notes claimed and this confirms.
 *  - **The composite bake for humanoid NPCs**: there is none, and the brief was right to suspect one
 *    would be a bug. `ui/scene/npc-look.ts` sets `bodyLayers: []` and binds the pre-baked
 *    `textures/bakednpctextures/` atlas named by `CreatureDisplayInfoExtra`, so an NPC costs one
 *    texture fetch and no blit. Already correct as of `b04bed6`.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `compileAsync` AND NOT "COMPILE IT EARLIER"
 *
 * Moving `renderer.compile()` to another point in the same frame moves the stall, it does not remove
 * it: the cost is `glLinkProgram` and the driver's blocking status query, and that bill is due
 * wherever it is issued. What removes it is `KHR_parallel_shader_compile`, which lets the link run on
 * the driver's own thread while the main thread carries on. three's `compileAsync` is exactly that
 * (`three/build/three.module.js:17481`): it calls `compile()` to ISSUE the compile and link, then
 * polls `program.isReady()` -- consulting the extension where present -- instead of blocking on the
 * link status. Nothing new is installed; `three@0.185.1` already ships it.
 *
 * So the body is built invisible, its programs are issued, and it is revealed on the frame they are
 * ready. THE PICTURE IS PRESERVED EXACTLY: nothing is skipped, decimated, or drawn at lower detail,
 * and the only difference is that a mob appears a few tens of milliseconds later than it otherwise
 * would -- while its textures are still streaming in anyway.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE THINGS THAT MAKE THIS SAFE
 *
 *  1. **NOTHING STAYS INVISIBLE.** `REVEAL_DEADLINE_MS` is a hard cap: past it the body is revealed
 *     whether or not its programs reported ready. A missing extension, a rejected promise, a
 *     renderer that was disposed mid-flight -- every one of them ends in a visible mob. An
 *     invisible-forever creature would be a far worse defect than the hitch this fixes, and this
 *     project has already shipped a look that "could not be resolved [and] left the unit invisible"
 *     once (`6edb06d`).
 *  2. **NO WARMER REGISTERED MEANS NO BEHAVIOUR CHANGE.** `revealWhenWarm` reveals immediately when
 *     nothing has registered, which is the state in every test and in `/game?offline=1`. Same shape,
 *     and for the same reason, as `perf/anim-section.ts`: the renderer is owned by the React page and
 *     must not become a singleton to be reachable from here.
 *  3. **A FRAME BUDGET, so a GROUP of new mobs is spread rather than issued at once.** This is the
 *     owner's actual case -- a group, not one -- and issuing eight compiles in one frame would rebuild
 *     the stall out of the parts meant to prevent it.
 */

/** Concurrent warm-ups in flight. The frame budget: a group of new mobs drains a few at a time. */
const MAX_IN_FLIGHT = 2;

/**
 * How long a body may wait to be revealed, ms.
 *
 * Generous on purpose. The measured cost of a program is tens of milliseconds, so this is not a
 * timing knob -- it is the failure valve described above, and it should only ever fire when
 * something is actually wrong.
 */
const REVEAL_DEADLINE_MS = 1500;

/** Issues the compile and resolves once the programs report ready. `renderer.compileAsync`. */
export type ProgramWarmer = (object: THREE.Object3D) => Promise<unknown>;

let warmer: ProgramWarmer | null = null;

/** Called by the render loop. `null` detaches, which the page's unmount does. */
export function setProgramWarmer(next: ProgramWarmer | null): void {
  warmer = next;
  if (next === null) {
    // Detaching must not strand anything half-warmed and invisible.
    queue.forEach((entry) => { entry.object.visible = true; });
    queue.length = 0;
    inFlight = 0;
  }
}

interface Pending {
  object: THREE.Object3D;
  deadline: number;
  started: boolean;
}

const queue: Pending[] = [];
let inFlight = 0;

/** Counters the probe reads through `window.programWarm` to prove this is doing anything. */
export const programWarmStats = {
  queued: 0,
  warmed: 0,
  /** Revealed by the deadline rather than by a ready program -- should stay at zero. */
  timedOut: 0,
  /** The warmer threw or rejected. Also revealed; also should stay at zero. */
  failed: 0,
  /** Total ms spent between enqueue and reveal, so the added latency is reportable. */
  waitMsTotal: 0,
  maxWaitMs: 0,
};

/**
 * Make `object` visible -- once its GLSL programs are ready, or at the deadline, whichever is first.
 *
 * The caller's `object.visible = true` becomes this. It is deliberately the ONLY entry point: a
 * caller that wants the old behaviour just assigns `visible` and is unaffected.
 */
export function revealWhenWarm(object: THREE.Object3D): void {
  if (warmer === null) {
    object.visible = true;
    return;
  }
  object.visible = false;
  queue.push({ object, deadline: performance.now() + REVEAL_DEADLINE_MS, started: false });
  programWarmStats.queued += 1;
}

/**
 * Drain the queue. Called once per frame from the render loop, BEFORE `renderer.render`.
 *
 * Reveals anything past its deadline first, so the failure valve cannot itself be starved by a queue
 * that is always at its concurrency limit.
 */
export function pumpProgramWarm(): void {
  if (queue.length === 0) {
    return;
  }
  const now = performance.now();

  for (let i = queue.length - 1; i >= 0; --i) {
    const entry = queue[i];
    if (now >= entry.deadline) {
      // Past the deadline. Reveal it and forget it -- a warm-up that resolves later finds the entry
      // gone and does nothing, which is why `reveal` below is idempotent through `splice`.
      entry.object.visible = true;
      programWarmStats.timedOut += 1;
      queue.splice(i, 1);
    }
  }

  for (const entry of queue) {
    if (inFlight >= MAX_IN_FLIGHT) {
      break;
    }
    if (entry.started) {
      continue;
    }
    entry.started = true;
    inFlight += 1;
    const startedAt = performance.now();
    const done = (failed: boolean) => {
      inFlight -= 1;
      const at = queue.indexOf(entry);
      if (at === -1) {
        // Already revealed by the deadline sweep. Nothing to do; do not double-count.
        return;
      }
      queue.splice(at, 1);
      entry.object.visible = true;
      const waited = performance.now() - startedAt;
      programWarmStats.waitMsTotal += waited;
      if (waited > programWarmStats.maxWaitMs) {
        programWarmStats.maxWaitMs = waited;
      }
      if (failed) {
        programWarmStats.failed += 1;
      } else {
        programWarmStats.warmed += 1;
      }
    };
    // `try` around the CALL as well as the promise: `compileAsync` reaches into the renderer's
    // material properties and a synchronous throw there must still end in a visible body.
    try {
      warmer(entry.object).then(() => done(false), () => done(true));
    } catch (ex) {
      console.warn('program-warm: the warmer threw; revealing without warming', ex);
      done(true);
    }
  }
}

if (typeof window !== 'undefined') {
  (window as any).programWarm = programWarmStats;
}
