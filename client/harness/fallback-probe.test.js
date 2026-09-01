/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;

/**
 * **WHICH SEED DECIDED THE FRAME: the body, or the boom?**
 *
 * `locateCamera` tries the body, then falls back to the eye when the body returns null. `selectCandidate`
 * returns null for TWO different reasons -- "no candidate could place this point" and "the point resolved
 * into the exterior shell, so you are outdoors". This arm separates them by calling `locateAt` on each
 * seed directly and reporting which one the verdict came from.
 */
const BODIES = {
  'outside on the road': [-27.72, 45, 2.0],
  'porch, one pace out': [-27.72, 33.5, 2.16],
  'side room (group 1)': [-10, 12, 3],
};

it('names the seed that decided each frame', () => {
  const { map } = stage();
  const loc = new LocationManager(map);

  const rootBox = [...map.wmoManager.entries.values()][0].root.boundingBox;
  console.log('ROOTBOX ' + JSON.stringify({
    x: [rootBox.min.x, rootBox.max.x], y: [rootBox.min.y, rootBox.max.y], z: [rootBox.min.z, rootBox.max.z],
  }));

  for (const [label, xyz] of Object.entries(BODIES)) {
    const body = new THREE.Vector3(xyz[0], xyz[1], xyz[2]);
    const bodyLoc = loc.locateAt(body);
    const bodyInRootBox = rootBox.containsPoint(body.clone());
    const rows = [];

    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const camera = look(
        [body.x - Math.cos(rad) * 8, body.y - Math.sin(rad) * 8, body.z + 3],
        [body.x, body.y, body.z + 1.5],
      );
      const eyeLoc = loc.locateAt(camera.position);
      rows.push({
        deg,
        eye: eyeLoc ? 'g' + eyeLoc.wmo.group.index : 'null',
        decidedBy: bodyLoc ? 'body' : (eyeLoc ? 'EYE' : 'neither'),
      });
    }

    console.log('SEED ' + JSON.stringify({
      body: label,
      bodyInRootBox,
      bodyResolved: bodyLoc ? 'g' + bodyLoc.wmo.group.index : 'null',
      rows,
    }));
  }
  expect(true).toBe(true);
});
