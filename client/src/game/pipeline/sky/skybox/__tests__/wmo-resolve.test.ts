import { resolveActiveWmoSkybox } from '../wmo-resolve';

const SHOW_SKYBOX = 0x40000;
const EXTERIOR = 0x8;

/** A minimal duck-typed WMO instance -- just the three properties `resolveActiveWmoSkybox` and
 * `VisibilityManager` both read (`root.skybox`, `groups`, `views.groups`). `groupSpecs` is
 * `[flags, visible]` per group index. */
function mkWmo(skybox: string | null, groupSpecs: Array<[number, boolean]>) {
  const groups = new Map<number, any>();
  const viewsGroups = new Map<number, any>();
  groupSpecs.forEach(([flags], index) => {
    groups.set(index, { index, header: { flags } });
  });
  groupSpecs.forEach(([, visible], index) => {
    viewsGroups.set(index, { visible });
  });

  return { root: { skybox }, groups, views: { groups: viewsGroups } };
}

function mkManager(wmos: Record<string, any>) {
  return { entries: new Map(Object.entries(wmos)) };
}

describe('resolveActiveWmoSkybox (celestial-sky plan, Task 6 Step 2)', () => {
  it('returns null when there is no WMOManager at all', () => {
    expect(resolveActiveWmoSkybox(null)).toBeNull();
    expect(resolveActiveWmoSkybox(undefined)).toBeNull();
  });

  it('returns null when no WMO in range names a skybox', () => {
    const manager = mkManager({
      a: mkWmo(null, [[SHOW_SKYBOX, true]]),
    });
    expect(resolveActiveWmoSkybox(manager)).toBeNull();
  });

  it('returns null when the root names a skybox but no group carries SHOW_SKYBOX at all', () => {
    // The Sunken Temple / DireMaul-instance-shell shape: a MOSB chunk, but no group ever asks for it.
    const manager = mkManager({
      a: mkWmo('temple.m2', [[EXTERIOR, true], [0, true]]),
    });
    expect(resolveActiveWmoSkybox(manager)).toBeNull();
  });

  it('returns null when a SHOW_SKYBOX group exists but the portal flood never reached it (view.visible === false)', () => {
    const manager = mkManager({
      a: mkWmo('skybox.m2', [[EXTERIOR, true], [SHOW_SKYBOX, false]]),
    });
    expect(resolveActiveWmoSkybox(manager)).toBeNull();
  });

  it("THE Stratholme King's Square shape: the camera's own (EXTERIOR, non-flagged) group is visible, "
    + 'but a DIFFERENT flood-reached group carries SHOW_SKYBOX -- the containing-group test would miss '
    + 'this; the flood-reached test must not', () => {
    const manager = mkManager({
      stratholme_b: mkWmo('StratholmeSkybox.m2', [
        [EXTERIOR, true], // group 39-equivalent: the camera's own group, EXTERIOR, no SHOW_SKYBOX
        [SHOW_SKYBOX, true], // a different group the flood reached, which DOES carry the bit
      ]),
    });
    expect(resolveActiveWmoSkybox(manager)).toBe('StratholmeSkybox.m2');
  });

  it('picks the lexicographically-least path on a tie between two qualifying WMOs, deterministically', () => {
    const manager = mkManager({
      b: mkWmo('zzz.m2', [[SHOW_SKYBOX, true]]),
      a: mkWmo('aaa.m2', [[SHOW_SKYBOX, true]]),
    });
    expect(resolveActiveWmoSkybox(manager)).toBe('aaa.m2');
  });
});
