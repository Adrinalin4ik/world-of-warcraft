/**
 * @jest-environment node
 */
const { buildAbbey } = require('./build');

it('builds the real abbey from served bytes', () => {
  const { root, groups } = buildAbbey();
  const rows = [...groups.values()].map((g) => ({
    i: g.index,
    flags: '0x' + (g.header.flags >>> 0).toString(16),
    interior: g.interior,
    portals: g.portals.length,
    bsp: !!g.bspTree,
  }));
  console.log(JSON.stringify({ groupCount: root.groupCount, portals: root.portals.size ?? root.portals.length, rows }, null, 1));
  expect(groups.size).toBe(root.groupCount);
});
