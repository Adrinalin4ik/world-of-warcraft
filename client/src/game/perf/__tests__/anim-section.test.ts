/** @jest-environment node */
import { ANIM_SECTION, beginAnimSection, endAnimSection, setAnimSectionSink } from '../anim-section';
import { CpuSections } from '../cpu-sections';

/** A clock that hands out the given readings in order, so timings are exact. */
function fakeClock(readings: number[]) {
  let i = 0;
  return () => readings[i++];
}

describe('the shared anim CPU span', () => {
  afterEach(() => {
    setAnimSectionSink(null);
  });

  /**
   * MUTATION KILLED: `ANIM_SECTION = 'anim'` -> any other literal.
   *
   * The plan's acceptance gate is stated against a section NAMED `anim`. A span accumulated under
   * some other name reads identically in the HUD to a human and is invisible to any check that
   * looks the name up, which is precisely how the counters landed on this branch while the span did
   * not.
   */
  it('accumulates under the name the acceptance gate is stated against', () => {
    const sections = new CpuSections(fakeClock([0, 3]));
    setAnimSectionSink(sections);
    sections.beginFrame();
    beginAnimSection();
    endAnimSection();
    expect(ANIM_SECTION).toBe('anim');
    expect(sections.totals().get('anim')).toBeCloseTo(3, 10);
  });

  /**
   * MUTATION KILLED: opening the span in only ONE of the three animation loops -- i.e. any change
   * that stops the span from SUMMING across call sites. The three loops (`World#animateEntities`,
   * `DoodadManager#animate`, `WMOManager#animate`) are separate begin/end pairs within one frame,
   * and the gate is their total, not the largest of them.
   *
   * Also kills a "keep the maximum" or "keep the last" reimplementation of `CpuSections#end`.
   */
  it('sums three separate call sites in one frame into one total', () => {
    const sections = new CpuSections(fakeClock([0, 1, 10, 14, 100, 102]));
    setAnimSectionSink(sections);
    sections.beginFrame();
    beginAnimSection();
    endAnimSection();   // 1 ms  -- units
    beginAnimSection();
    endAnimSection();   // 4 ms  -- terrain doodads
    beginAnimSection();
    endAnimSection();   // 2 ms  -- WMO interiors
    expect(sections.totals().get('anim')).toBeCloseTo(7, 10);
  });

  /**
   * MUTATION KILLED: dropping the null guard in `beginAnimSection` / `endAnimSection`, or having
   * the module construct its own `CpuSections` instead of receiving one.
   *
   * Every unit test in the suite drives these loops with no `PerfMonitor` alive. If the shim threw
   * or self-instantiated, either the whole animation suite breaks or a second, permanently-growing
   * accumulator exists that nothing ever calls `beginFrame` on.
   */
  it('is a no-op with nothing registered', () => {
    expect(() => {
      beginAnimSection();
      endAnimSection();
    }).not.toThrow();
  });

  /**
   * MUTATION KILLED: `PerfMonitor#dispose` not detaching, i.e. `setAnimSectionSink(null)` removed.
   *
   * A disposed monitor's `CpuSections` is never `beginFrame`d again, so a retained reference turns
   * the span into an unbounded accumulator feeding a HUD that no longer exists.
   */
  it('detaches, so a disposed sink stops receiving spans', () => {
    const sections = new CpuSections(fakeClock([0, 5]));
    setAnimSectionSink(sections);
    sections.beginFrame();
    setAnimSectionSink(null);
    beginAnimSection();
    endAnimSection();
    expect(sections.totals().has('anim')).toBe(false);
  });
});
