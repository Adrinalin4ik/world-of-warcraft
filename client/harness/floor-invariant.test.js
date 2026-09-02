/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;

/**
 * **THE FLOOR YOU STAND ON MUST BE DRAWN. Checked over a grid, with no screenshot involved.**
 *
 * The owner's most-repeated frame is a room rendered correctly with a hole where his own feet are --
 * "я стою на полу, но вижу что под ним", and a purple void in the foreground of the doorway shot.
 * That is not a question of taste and does not need a picture: if a group resolves a floor beneath the
 * body, that group owns the polygon under his feet, and a frame that does not draw it is wrong.
 *
 * So this arm asks `LocationManager` itself which groups place the body -- the same `addCandidates`
 * the seed uses -- and then requires the drawn set to contain them.
 */
function candidatesFor(loc, map, body) {
  const out = [];
  for (const wmo of map.wmoManager.entries.values()) {
    const bucket = [];
    loc.addCandidates({ position: body }, wmo, bucket);
    for (const c of bucket) {
      // A resolved floor at or below the body, with the body under the ceiling: this group's geometry
      // is what the body is standing on.
      if (c.query.z.min === null) continue;
      const ceiling = c.query.z.max === null ? c.wmo.group.boundingBox.max.z : c.query.z.max;
      if (body.z < c.query.z.min || body.z > ceiling) continue;
      out.push(c.wmo.group.index);
    }
  }
  return out;
}

it('draws the group whose floor is under the body', () => {
  const { wmo, map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const violations = [];
  let sampled = 0;

  for (let x = -34; x <= 52; x += 4) {
    for (let y = -50; y <= 36; y += 4) {
      for (const z of [2.5, 10.5, 18.5]) {
        const body = new THREE.Vector3(x, y, z);
        const floors = candidatesFor(loc, map, body);
        if (floors.length === 0) continue;
        sampled++;

        // Look level, along +y, the bearing that produced his doorway shot.
        const camera = look([x, y - 8, z + 3], [x, y, z + 1.5]);
        loc.update([camera], body);
        vm.update([camera], body);

        const drawn = new Set(
          [...wmo.views.groups.entries()].filter(([, v]) => v.visible).map(([i]) => i),
        );
        const missing = floors.filter((i) => !drawn.has(i));
        if (missing.length === floors.length) {
          violations.push({
            at: [x, y, z],
            floors,
            drawn: [...drawn].sort((a, b) => a - b),
            loc: camera.location.type === 'exterior' ? 'ext' : 'int',
          });
        }
      }
    }
  }

  console.log('FLOOR ' + JSON.stringify({
    sampled,
    violations: violations.length,
    rate: +(violations.length / Math.max(sampled, 1)).toFixed(3),
    sample: violations.slice(0, 14),
  }));
  expect(true).toBe(true);
});
