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
