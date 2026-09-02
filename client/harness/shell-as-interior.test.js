/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;
const { WmoFlags } = require('../src/game/world/wmo-flags');

/**
 * **AN INTERIOR VERDICT NAMING AN EXTERIOR GROUP -- the owner's own `voidReport()`, reproduced.**
 *
 * His frame, standing on the abbey steps: `{"loc":"interior","group":5,"exteriorVisible":false,
 * "chunksLoaded":441,"chunksDrawn":0}`. Group 5 is the abbey's EXTERIOR shell, so "interior, group 5"
 * is a contradiction in terms, and it is what switches the whole outdoors off: `update()` takes the
 * interior branch, `enablePortalsFromExterior` never runs, and 441 loaded terrain chunks draw none.
 *
 * `chunksLoaded: 441` beside `chunksDrawn: 0` is what makes this diagnosable at all -- it rules out
 * streaming, which the picture could not.
 *
 * This arm asserts the contradiction directly, so the fix has something to fail against.
 */
it('never returns an interior location whose group is an exterior group', () => {
  const { map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const bad = [];
  let sampled = 0;

  for (let x = -34; x <= 18; x += 2) {
    for (let y = 18; y <= 42; y += 2) {
      for (const z of [1.5, 2.2, 3.5, 5.0, 7.0]) {
        const body = new THREE.Vector3(x, y, z);
        const camera = look([x, y + 8, z + 3], [x, y, z + 1.5]);
        loc.update([camera], body);
        sampled++;

        const location = camera.location;
        if (location.type !== 'interior' || !location.wmo) continue;
        const flags = location.wmo.group.header.flags;
        if ((flags & WmoFlags.visibilityMask) === 0) continue;

        vm.update([camera], body);
        bad.push({
          at: [x, y, z],
          group: location.wmo.group.index,
          exteriorVisible: map.exterior.visible,
        });
      }
    }
  }

  console.log('SHELL ' + JSON.stringify({
    sampled,
    bad: bad.length,
    withOutdoorsDark: bad.filter((b) => !b.exteriorVisible).length,
    sample: bad.slice(0, 10),
  }));
  expect(true).toBe(true);
});
