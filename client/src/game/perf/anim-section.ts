import { CpuSections } from './cpu-sections';

/**
 * The `'anim'` CPU span, reachable from the animation loops without threading `PerfMonitor` through
 * them.
 *
 * WHY A MODULE-LEVEL SHIM. `PerfMonitor` is constructed by the React page (`pages/game/index.tsx`)
 * and held as `this.perf`; it is not a singleton, and it must not become a second one. The three
 * loops that make up the animation frame -- `World#animateEntities`, `DoodadManager#animate` and
 * `WMOManager#animate` -- live two and three levels down from that page, across `World`,
 * `WorldMap`, `DoodadManager`, `WMOManager` and `WMO`, none of which know anything about perf. The
 * alternatives were to plumb a `CpuSections` reference through all five constructors, or to hoist
 * the span into `World` and lose the doodad and WMO loops (they are called from `WorldMap#animate`,
 * not from `World#animate`). This is the same shape `anim/counters.ts` already uses for exactly the
 * same reason, and it keeps ownership of the instance where it was: the render loop's `PerfMonitor`
 * REGISTERS its own `CpuSections` here, nothing here creates one.
 *
 * Nothing registered -> every call is one null check. That is the state in every test and in any
 * embedding that does not build a HUD.
 *
 * Spans SUM within a frame (`CpuSections`), so the three call sites accumulate into one `anim`
 * total, and `WMOManager` may wrap its whole `entries` walk or each building individually without
 * changing the number.
 */
export const ANIM_SECTION = 'anim';

let sink: CpuSections | null = null;

/** Called by `PerfMonitor`. Passing `null` detaches, which `PerfMonitor#dispose` does. */
export function setAnimSectionSink(sections: CpuSections | null): void {
  sink = sections;
}

export function beginAnimSection(): void {
  if (sink !== null) {
    sink.begin(ANIM_SECTION);
  }
}

export function endAnimSection(): void {
  if (sink !== null) {
    sink.end(ANIM_SECTION);
  }
}

/**
 * The same sink, opened under an arbitrary name.
 *
 * WHY THIS EXISTS. `world.animate` was one number holding the entity loop, terrain visibility,
 * `WorldMap#animate` (MapLight, the portal flood, the doodad and WMO animation loops), the sky
 * system, the debug overlays and `updateDynamicMatrices`. Task 9's movement round asked directly
 * whether a `world.animate` "rise from 9.1 to 13.5-17.6 ms" was a regression and could not answer,
 * because five samples of ONE unchanged build read 7.3, 8.7, 9.1, 12.3 and 15.5 -- a spread wider
 * than the claimed rise. The conclusion recorded there was that no amount of staring at the one
 * number would separate its parts, and that the breakdown was a measurement to build. This is it.
 *
 * `World` reaches the sink the same way the three animation loops already do, and for the same
 * reason: `PerfMonitor` is owned by the React page two levels up and must not become a singleton.
 * See this module's header.
 *
 * Cost: two `performance.now()` calls and two `Map` operations per span per frame. `World#animate`
 * opens five, so ~10 timestamps a frame against a budget of 16.7 ms. Measured below the noise floor
 * of every metric it reports on (see the round's report), and it is left in permanently -- an
 * instrument that is only compiled in when someone remembers to add it is an instrument that reads
 * zero when it matters, which this project has already shipped twice.
 */
export function beginSection(name: string): void {
  if (sink !== null) {
    sink.begin(name);
  }
}

export function endSection(name: string): void {
  if (sink !== null) {
    sink.end(name);
  }
}
