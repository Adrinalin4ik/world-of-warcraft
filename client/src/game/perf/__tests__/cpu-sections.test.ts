/** @jest-environment node */
import { CpuSections } from '../cpu-sections';

/** A clock that hands out the given readings in order, so timings are exact. */
function fakeClock(readings: number[]) {
  let i = 0;
  return () => readings[i++];
}

describe('CpuSections', () => {
  it('accumulates repeated spans under one name within a frame', () => {
    const sections = new CpuSections(fakeClock([0, 5, 10, 12]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');   // 5 ms
    sections.begin('cull');
    sections.end('cull');   // 2 ms
    expect(sections.totals().get('cull')).toBeCloseTo(7, 10);
  });

  it('keeps separate names separate', () => {
    const sections = new CpuSections(fakeClock([0, 3, 3, 11]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    sections.begin('render');
    sections.end('render');
    expect(sections.totals().get('cull')).toBeCloseTo(3, 10);
    expect(sections.totals().get('render')).toBeCloseTo(8, 10);
  });

  it('clears totals on the next beginFrame', () => {
    const sections = new CpuSections(fakeClock([0, 4, 100, 106]));
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    sections.beginFrame();
    sections.begin('cull');
    sections.end('cull');
    expect(sections.totals().get('cull')).toBeCloseTo(6, 10);
  });

  it('ignores end() for a name that was never begun, without throwing', () => {
    const sections = new CpuSections(fakeClock([0, 1]));
    sections.beginFrame();
    expect(() => sections.end('never-opened')).not.toThrow();
    expect(sections.totals().has('never-opened')).toBe(false);
  });

  it('ignores a duplicate begin() rather than losing the earlier start', () => {
    const sections = new CpuSections(fakeClock([0, 5, 20]));
    sections.beginFrame();
    sections.begin('cull');  // starts at 0
    sections.begin('cull');  // ignored; clock reading 5 is consumed
    sections.end('cull');    // ends at 20 -> 20 ms
    expect(sections.totals().get('cull')).toBeCloseTo(20, 10);
  });
});
