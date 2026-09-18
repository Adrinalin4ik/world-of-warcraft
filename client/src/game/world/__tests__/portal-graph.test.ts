/**
 * @jest-environment node
 */
import VisibilityManager from '../visibility-manager';

/**
 * **NORTHSHIRE ABBEY'S REAL PORTAL GRAPH, decoded from the game's own files.**
 *
 * This test exists because a whole round of work was spent reading screenshots. Four frames came back
 * as "то же самое" and were four different pictures; two fixes were landed on those readings and both
 * had to be reverted. The graph below is not an idea of the abbey -- it is
 * `world/wmo/azeroth/buildings/nsabbey/nsabbey.wmo`, pulled from the asset host and parsed chunk by
 * chunk:
 *
 *   MOHD: 14 groups, 14 portals.
 *   MOGI: groups 4, 5 and 6 carry EXTERIOR (0x8); every other group carries only 0x2000.
 *         NOT ONE carries EXTERIOR_LIT (0x40), which is worth recording -- the visibility mask this
 *         project shipped as `0x48` could never have mattered here, and `0x08` is right.
 *   MOPR: 28 entries, each portal appearing exactly twice, once per side.
 *
 * Every portal's two MOPR entries name the pair of groups it joins, which is where this adjacency
 * comes from. The interesting shape of it, and the reason the exterior was so hard to reach: groups 4
 * and 6 have NO portals at all -- only the exterior pass can enable them -- and the sole interior
 * route to daylight runs through group 5, four portals deep from the hall (0-1-3-5 or 0-2-7-10-5).
 *
 * WHAT THIS ASSERTS is the graph traversal alone: with every portal passing its side and rect gates,
 * the flood from the hall must reach every group the file says is connected. It deliberately does NOT
 * assert what a real camera sees -- that is the rect's business and depends on where the eye looks.
 * A future change that breaks reachability fails here instead of in a screenshot.
 */
const ADJACENCY: Record<number, number[]> = {
  0: [1, 2, 9, 11, 13],
  1: [0, 3],
  2: [0, 7, 13],
  3: [1, 5],
  5: [3, 10],
  7: [2, 10],
  8: [9],
  9: [0, 8, 12],
  10: [5, 7],
  11: [0],
  12: [9],
  13: [0, 2],
};

/** Every group the file connects to the hall, by transitive closure of the table above. */
const REACHABLE_FROM_HALL = [0, 1, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13];

const RECT = {
  minX: -1, minY: -1, maxX: 1, maxY: 1,
};

/**
 * A WMO whose portals all pass: the side test sees the viewer inside, and the projection hands back
 * the rect it was given. That isolates the traversal from the screen entirely.
 */
function abbey() {
  const views = { groups: new Map<number, any>(), portals: new Map<number, any>(), root: {} };
  const groups = new Map<number, any>();

  const portalView = {
    legacyGeometry: { vertices: [0, 1, 2, 3] },
    projectToRect: (_vp: unknown, incoming: unknown) => incoming,
  };

  for (const key of Object.keys(ADJACENCY)) {
    const index = Number(key);
    const neighbours = ADJACENCY[index];

    views.groups.set(index, { visibleFrame: -1, visible: false });
    groups.set(index, {
      index,
      header: { flags: 0x2000 },
      // One portal per neighbour. `side` 1 with a plane reporting +1 puts the viewer inside.
      portals: neighbours.map(() => ({ plane: { distanceToPoint: () => 1 } })),
      portalRefs: neighbours.map((to, i) => ({ groupIndex: to, portalIndex: index * 100 + i, side: 1 })),
    });
  }

  for (const group of groups.values()) {
    for (const ref of group.portalRefs) {
      views.portals.set(ref.portalIndex, portalView);
    }
  }

  return {
    groups,
    views,
    doodadsForGroup: () => [],
  };
}

describe("the abbey's real portal graph", () => {
  it('floods from the hall to every group the file connects', () => {
    const wmo = abbey();
    const manager = new (VisibilityManager as any)({
      chunks: new Map(),
      doodadManager: { doodads: new Map() },
      wmoManager: { entries: new Map([[0, wmo]]) },
      exterior: { visible: false },
    });
    manager.frame = 7;

    const camera = { position: { clone: () => ({ x: 0, y: 0, z: 0 }) } };
    (wmo.views as any).groups.get(0).worldToLocal = (v: unknown) => v;
    for (const view of wmo.views.groups.values()) {
      (view as any).worldToLocal = (v: unknown) => v;
    }

    manager.seedInterior(
      { handler: wmo, group: wmo.groups.get(0), views: { group: wmo.views.groups.get(0) } },
      RECT,
      camera,
    );

    const reached = [...wmo.views.groups.entries()]
      .filter(([, view]) => (view as any).visibleFrame === 7)
      .map(([index]) => index)
      .sort((a, b) => a - b);

    expect(reached).toEqual(REACHABLE_FROM_HALL);
  });
});
