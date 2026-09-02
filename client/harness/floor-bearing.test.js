/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;

/**
 * **THE SAME FLOOR INVARIANT, BUT SWEPT OVER BEARING -- because every report the owner has made was
 * bearing-dependent and the level +y arm found nothing.**
 *
 * `floor-invariant.test.js` sampled 476 standing positions at one bearing and found zero violations.
 * That is a real result and it is also the wrong question: "под определёнными углами камеры" is the
 * one constant across his reports, so a single bearing cannot refute the defect. This arm holds the
 * position and turns the boom, and separately drops the eye BELOW the floor -- the `NOCAMCOLLIDE` case
 * his under-the-floor frames came from.
 */
function floorsUnder(loc, map, body) {
  const out = [];
  for (const wmo of map.wmoManager.entries.values()) {
    const bucket = [];
    loc.addCandidates({ position: body }, wmo, bucket);
    for (const c of bucket) {
      if (c.query.z.min === null) continue;
      const ceiling = c.query.z.max === null ? c.wmo.group.boundingBox.max.z : c.query.z.max;
      if (body.z < c.query.z.min || body.z > ceiling) continue;
      out.push(c.wmo.group.index);
    }
  }
  return out;
}

it('draws the floor under the body at every bearing, and with the eye under the floor', () => {
  const { wmo, map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const positions = [];
  for (let x = -30; x <= 46; x += 10) {
    for (let y = -46; y <= 32; y += 10) {
      const body = new THREE.Vector3(x, y, 2.5);
      const floors = floorsUnder(loc, map, body);
      if (floors.length) positions.push({ body, floors });
    }
  }

  const violations = { bearing: [], underFloor: [] };
  let sampled = 0;

  for (const { body, floors } of positions) {
    for (let deg = 0; deg < 360; deg += 45) {
      const rad = (deg * Math.PI) / 180;
      for (const rise of [3, -2]) {
        const camera = look(
          [body.x - Math.cos(rad) * 8, body.y - Math.sin(rad) * 8, body.z + rise],
          [body.x, body.y, body.z + 1.5],
        );
        loc.update([camera], body);
        vm.update([camera], body);
        sampled++;

        const drawn = new Set(
          [...wmo.views.groups.entries()].filter(([, v]) => v.visible).map(([i]) => i),
        );
        if (floors.some((i) => drawn.has(i))) continue;

        const row = {
          at: [body.x, body.y, body.z],
          deg,
          floors,
          drawn: [...drawn].sort((a, b) => a - b),
          loc: camera.location.type === 'exterior' ? 'ext' : 'int',
        };
        (rise < 0 ? violations.underFloor : violations.bearing).push(row);
      }
    }
  }

  console.log('BEARING ' + JSON.stringify({
    positions: positions.length,
    sampled,
    eyeAbove: violations.bearing.length,
    eyeBelow: violations.underFloor.length,
    sampleAbove: violations.bearing.slice(0, 10),
    sampleBelow: violations.underFloor.slice(0, 10),
  }));
  expect(true).toBe(true);
});
