/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;

/**
 * **A THIRD-PERSON BOOM SWEPT AROUND ONE FIXED BODY.**
 *
 * The owner's report is "порталы не работают под определёнными углами камеры... мерцание". Flicker is
 * not a look; it is a SET THAT CHANGES when it should not. The body does not move here, so the room he
 * is standing in does not change, and the interior the flood must draw cannot legitimately depend on
 * which way he is facing -- only on what the rect crops. What CAN legitimately change with yaw is how
 * much of the outdoors is enabled.
 *
 * So this arm prints, per yaw, the resolved location and the drawn set. A location that changes with
 * yaw at a fixed body is a defect by construction: `locateCamera` is documented to seed from the BODY.
 */
const BODIES = {
  'nave (group 0 interior)': [-8, 10, 3],
  'side room (group 1)': [-10, 12, 3],
  'doorway (owner probe)': [-27.72, 30.38, 2.16],
  'porch, one pace out': [-27.72, 33.5, 2.16],
  'outside on the road': [-27.72, 45, 2.0],
};

const BOOM = 8;
const EYE_RISE = 3;

it('sweeps the boom around fixed bodies', () => {
  const { wmo, map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  for (const [label, xyz] of Object.entries(BODIES)) {
    const body = new THREE.Vector3(xyz[0], xyz[1], xyz[2]);
    const rows = [];

    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const eye = [
        body.x - Math.cos(rad) * BOOM,
        body.y - Math.sin(rad) * BOOM,
        body.z + EYE_RISE,
      ];
      const camera = look(eye, [body.x, body.y, body.z + 1.5]);

      loc.update([camera], body);
      vm.update([camera], body);

      const drawn = [...wmo.views.groups.entries()]
        .filter(([, v]) => v.visible)
        .map(([i]) => i)
        .sort((a, b) => a - b);

      rows.push({
        deg,
        loc: camera.location.type === 'exterior'
          ? 'ext'
          : 'g' + (camera.location.group ? camera.location.group.index : '?' + Object.keys(camera.location).join('|')),
        drawn: drawn.join(','),
        ext: map.exterior.visible ? 1 : 0,
      });
    }

    const locs = new Set(rows.map((r) => r.loc));
    const sets = new Set(rows.map((r) => r.drawn));
    console.log('SWEEP ' + JSON.stringify({
      body: label,
      distinctLocations: [...locs],
      distinctDrawnSets: sets.size,
      rows,
    }));
  }

  expect(true).toBe(true);
});
