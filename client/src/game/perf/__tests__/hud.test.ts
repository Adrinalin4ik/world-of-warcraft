import { PerfHud, HUD_REPAINT_MS, PerfPayload } from '../hud';

function payload(overrides: Partial<PerfPayload> = {}): PerfPayload {
  return {
    frame: { last: 12, p50: 11, p99: 20, worst: 33, overBudget: 4, sampleCount: 300 },
    gpuMs: 6.25,
    sections: new Map([['cull', 3.5]]),
    calls: 812, triangles: 450000, programs: 40, geometries: 900, textures: 300,
    visibleChunks: 120, visibleGroups: 8, visibleMapDoodads: 180, loadedMapDoodads: 900, visibleDoodads: 260,
    ...overrides,
  };
}

describe('PerfHud', () => {
  it('mounts a single overlay element into the document', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    expect(document.querySelectorAll('[data-perf-hud]')).toHaveLength(1);
    hud.dispose();
  });

  it('renders the headline worst-frame figure', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    expect(document.body.textContent).toContain('33.0');
    hud.dispose();
  });

  it('shows n/a when GPU timing is unavailable', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload({ gpuMs: null }));
    expect(document.body.textContent).toContain('n/a');
    hud.dispose();
  });

  it('does not repaint before the throttle interval elapses', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.update(HUD_REPAINT_MS - 1, payload({ frame: { ...payload().frame, worst: 99 } }));
    expect(document.body.textContent).not.toContain('99.0');
    hud.dispose();
  });

  it('repaints once the throttle interval elapses', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.update(HUD_REPAINT_MS, payload({ frame: { ...payload().frame, worst: 99 } }));
    expect(document.body.textContent).toContain('99.0');
    hud.dispose();
  });

  /**
   * The animation rows were shipped untested: this fixture omitted every `anim*` field, so the
   * branch that renders them never executed and the whole block could have been deleted with the
   * suite still green.
   *
   * Kills: deleting the rows, and swapping `animPosed`/`animResident` in the `posed` fraction.
   */
  it('renders the animation counters when they are supplied', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload({
      animResident: 940, animPosed: 210, animSkipped: 730,
      animBonesSolved: 5400, animMaterialsEvaluated: 260,
    }));

    expect(document.body.textContent).toContain('anim 210/940 posed  skipped 730');
    expect(document.body.textContent).toContain('bones 5400  materials 260');
    hud.dispose();
  });

  /**
   * Kills keying the gate on `animResident` alone, which is how it shipped. The rows print four
   * other fields, so a caller supplying only some counters got no rows at all -- the measurement was
   * collected and silently dropped.
   */
  it('renders the animation rows when only some counters are supplied', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload({ animPosed: 12, animMaterialsEvaluated: 34 }));

    expect(document.body.textContent).toContain('anim 12/0 posed');
    expect(document.body.textContent).toContain('materials 34');
    hud.dispose();
  });

  /** Kills making the block unconditional -- a caller measuring something else must get no rows. */
  it('omits the animation rows entirely when no counter is supplied', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());

    expect(document.body.textContent).not.toContain('anim ');
    expect(document.body.textContent).not.toContain('bones ');
    hud.dispose();
  });

  it('removes the overlay on dispose', () => {
    const hud = new PerfHud(document);
    hud.update(0, payload());
    hud.dispose();
    expect(document.querySelectorAll('[data-perf-hud]')).toHaveLength(0);
  });
});
