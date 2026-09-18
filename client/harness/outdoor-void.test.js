/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;
const { WmoFlags } = require('../src/game/world/wmo-flags');

/**
 * **STANDING OUTDOORS WITH THE WORLD SWITCHED OFF.**
 *
 * The owner's frame: on the abbey's front steps, facade and the room through the door both drawn, and
 * NO terrain, no trees, no distant buildings -- the whole exterior node dark. `update()` sets
 * `map.exterior.visible = false` every frame and only `enablePortalsFromExterior` puts it back, so
 * that picture says the flood never reached the outdoors, which means the verdict was INTERIOR while
 * he stood outside.
 *
 * The oracle needs no screenshot: if an EXTERIOR-flagged group resolves the floor under the body, the
 * body is standing on the shell -- outdoors by the file's own classification -- so a frame that leaves
 * `exterior.visible` false is wrong. This finds every such position instead of waiting for a
 * coordinate.
 */
function floorOwners(loc, map, body) {
  const owners = [];
  for (const wmo of map.wmoManager.entries.values()) {
    const bucket = [];
    loc.addCandidates({ position: body }, wmo, bucket);
    for (const c of bucket) {
      if (c.query.z.min === null) continue;
      const group = c.wmo.group;
      const ceiling = c.query.z.max === null ? group.boundingBox.max.z : c.query.z.max;
      if (body.z < c.query.z.min || body.z > ceiling) continue;
      owners.push({
        index: group.index,
        exterior: (group.header.flags & WmoFlags.visibilityMask) !== 0,
        zmin: +c.query.z.min.toFixed(2),
      });
    }
  }
  return owners;
}

it('finds positions standing on an exterior floor with the outdoors dark', () => {
  const { map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const bad = [];
  let onShell = 0;

  for (let x = -34; x <= 18; x += 3) {
    for (let y = 20; y <= 40; y += 2) {
      for (const z of [2.2, 3.5, 5.0]) {
        const body = new THREE.Vector3(x, y, z);
        const owners = floorOwners(loc, map, body);
        if (!owners.some((o) => o.exterior)) continue;
        onShell++;

        const camera = look([x, y + 8, z + 3], [x, y, z + 1.5]);
        loc.update([camera], body);
        vm.update([camera], body);

        if (map.exterior.visible) continue;
        bad.push({
          at: [x, y, z],
          owners: owners.map((o) => (o.exterior ? 'E' : 'i') + o.index + '@' + o.zmin),
          verdict: camera.location.type === 'exterior'
            ? 'ext'
            : 'int' + (camera.location.wmo ? camera.location.wmo.group.index : '?'),
        });
      }
    }
  }

  console.log('VOID ' + JSON.stringify({
    onShell,
    bad: bad.length,
    rate: +(bad.length / Math.max(onShell, 1)).toFixed(3),
    sample: bad.slice(0, 16),
  }));
  expect(true).toBe(true);
});
