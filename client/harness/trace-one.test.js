/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;
const { portalTrace } = require('../src/game/world/visibility-manager');

/** One over-drawing frame, traced portal by portal. Position and bearing come from `overdraw`'s worst row. */
it('traces the worst over-drawing frame', () => {
  const { wmo, map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const body = new THREE.Vector3(-10, -26, 2.5);
  const rad = (315 * Math.PI) / 180;
  const camera = look(
    [body.x - Math.cos(rad) * 8, body.y - Math.sin(rad) * 8, body.z + 3],
    [body.x, body.y, body.z + 1.5],
  );

  portalTrace.rows = [];
  portalTrace.enabled = true;
  loc.update([camera], body);
  vm.update([camera], body);

  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );

  const drawn = [...wmo.views.groups.entries()].filter(([, v]) => v.visible).map(([i]) => i);
  const inFrustum = drawn.filter((i) => frustum.intersectsBox(wmo.groups.get(i).boundingBox));

  console.log('EYE ' + JSON.stringify({
    eye: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],
    seedType: camera.location.type,
    drawn: drawn.sort((a, b) => a - b),
    inFrustum: inFrustum.sort((a, b) => a - b),
  }));
  for (const row of portalTrace.rows) {
    console.log('ROW ' + JSON.stringify(row));
  }
  expect(true).toBe(true);
});
