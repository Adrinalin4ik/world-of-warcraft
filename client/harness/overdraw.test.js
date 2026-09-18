/**
 * @jest-environment node
 */
const THREE = require('three');
const { stage, look } = require('./stage');
const LocationManager = require('../src/game/world/location-manager').default;
const VisibilityManager = require('../src/game/world/visibility-manager').default;

/**
 * **OVER-DRAW: a group that is drawn while its whole bounding box is outside the view.**
 *
 * The floor invariant is clean at every bearing, so the remaining half of the owner's complaint has to
 * be the opposite failure -- too MUCH enabled, which is what "просвечивает сквозь стены" looks like.
 * A portal flood's entire purpose is to enable less than the frustum would; enabling a group the
 * frustum does not even touch means the rect gate let something through that should have closed.
 *
 * The box test is the weak direction on purpose: a WMO group box is crude and overlaps its
 * neighbours, so a group whose box MISSES the frustum entirely cannot be defended by any rect. Every
 * violation here is real over-draw; the converse is not claimed.
 */
it('counts groups drawn whose bounding box misses the frustum', () => {
  const { wmo, map } = stage();
  const loc = new LocationManager(map);
  const vm = new VisibilityManager(map);

  const worldBoxes = new Map();
  for (const [index, group] of wmo.groups) {
    worldBoxes.set(index, group.boundingBox.clone());
  }

  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const rows = [];
  let sampled = 0;
  let drawnTotal = 0;
  let outsideTotal = 0;

  for (let x = -30; x <= 46; x += 10) {
    for (let y = -46; y <= 32; y += 10) {
      const body = new THREE.Vector3(x, y, 2.5);
      const bucket = [];
      for (const entry of map.wmoManager.entries.values()) {
        loc.addCandidates({ position: body }, entry, bucket);
      }
      if (!bucket.some((c) => c.query.z.min !== null)) continue;

      for (let deg = 0; deg < 360; deg += 45) {
        const rad = (deg * Math.PI) / 180;
        const camera = look(
          [body.x - Math.cos(rad) * 8, body.y - Math.sin(rad) * 8, body.z + 3],
          [body.x, body.y, body.z + 1.5],
        );
        loc.update([camera], body);
        vm.update([camera], body);
        sampled++;

        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(viewProjection);

        const drawn = [...wmo.views.groups.entries()]
          .filter(([, v]) => v.visible)
          .map(([i]) => i);
        const outside = drawn.filter((i) => !frustum.intersectsBox(worldBoxes.get(i)));

        drawnTotal += drawn.length;
        outsideTotal += outside.length;
        if (outside.length) {
          rows.push({ at: [x, y], deg, drawn: drawn.sort((a, b) => a - b), outside });
        }
      }
    }
  }

  console.log('OVERDRAW ' + JSON.stringify({
    sampled,
    drawnTotal,
    outsideTotal,
    share: +(outsideTotal / Math.max(drawnTotal, 1)).toFixed(3),
    framesWithOverdraw: rows.length,
    sample: rows.slice(0, 12),
  }));
  expect(true).toBe(true);
});
