/**
 * The narrow phase, on the one case that is the reported defect: a click BESIDE a unit, inside the
 * broad-phase sphere.
 *
 * The numbers are the live ones. Measured on :3000 as `Sgh` (`scratchpad/t20-target.js`), a Vale Moth
 * at 29.8 yd carried a pick sphere of radius **7.11 yd** -- its M2's own `vertexRadius` -- around a
 * body 2.03 yd tall. So the sphere is what the test builds, and the DRAWN geometry is what it expects
 * to reject with.
 *
 * **The oracle is the drawn, posed mesh and not the authored hull** (round 21): the hull is 12
 * triangles in a DIFFERENT VERTEX SPACE from the drawn geometry, which is why the owner could click a
 * wolf's head and not its rear. See `pick.ts`'s header. That is why this test hangs its geometry off
 * `model.submeshes` -- the draw graph -- rather than off `boundingMesh`.
 */
import * as THREE from 'three';

import { pickUnit } from '../pick';

/**
 * Just enough `Unit` for `pickUnit`: a view position, a collision height, and a model whose
 * `submeshes` carry one drawn box. A plain `THREE.Mesh` rather than a `SkinnedMesh` because what is
 * under test is the pick, not three's skinning -- `Mesh#raycast` is the same call either way, and it
 * is three's own code that swaps in `applyBoneTransform` for a skinned one.
 */
function unitAt(x: number, y: number, half: number, drawnHalf: number | null) {
  const view = new THREE.Object3D();
  view.position.set(x, y, 0);
  const model = new THREE.Object3D() as THREE.Object3D & {
    vertexRadius: number;
    submeshes?: THREE.Object3D[];
    boundingMesh?: THREE.Mesh;
  };
  model.vertexRadius = 7.11;
  if (drawnHalf !== null) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(drawnHalf * 2, drawnHalf * 2, half * 2),
      new THREE.MeshBasicMaterial(),
    );
    mesh.position.set(x, y, half);
    const submesh = new THREE.Group();
    submesh.add(mesh);
    submesh.updateMatrixWorld(true);
    model.submeshes = [submesh];
  }
  return {
    guid: `0x${x}${y}`,
    objectType: 3,
    collisionHeight: half * 2,
    view,
    model,
  } as never;
}

/** Looking down -Y from 20 yd, so a horizontal NDC offset is a horizontal world offset. */
function camera() {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  cam.position.set(0, -20, 1);
  cam.up.set(0, 0, 1);
  cam.lookAt(0, 0, 1);
  cam.updateMatrixWorld(true);
  return cam;
}

test('a click inside the sphere but off the drawn body misses, and the sphere alone would have hit', () => {
  const cam = camera();
  const unit = unitAt(0, 0, 1, 0.5);
  const entities = [unit];

  // Dead centre hits in both arms.
  expect(pickUnit(entities, cam, { x: 0, y: 0 }, null)).toBe(unit);

  // 0.2 in NDC x is ~1.7 yd sideways at 20 yd -- past the 0.5-yd body, well inside the 7.11-yd
  // sphere. The narrow phase rejects it; the sphere-only control arm still takes it, which is what
  // makes this a test of the change and not of the camera.
  const beside = { x: 0.2, y: 0 };
  expect(pickUnit(entities, cam, beside, null)).toBeNull();
  expect(pickUnit(entities, cam, beside, null, { narrow: false })).toBe(unit);
});

test('a unit drawing nothing yet keeps the sphere, and a far unit is still pickable', () => {
  const cam = camera();
  // No submeshes at all -- the state every unit is in for the ~9 s its M2 takes to arm.
  expect(pickUnit([unitAt(0, 0, 1, null)], cam, { x: 0, y: 0 }, null)).not.toBeNull();

  // 60 yd out, well past TAB's 41-yd `PICK_RANGE`, which round 20 wrongly applied to the mouse pick
  // (`hover.rs:29-33`: the reference's object picks run unbounded).
  const far = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  far.position.set(0, -60, 1);
  far.up.set(0, 0, 1);
  far.lookAt(0, 0, 1);
  far.updateMatrixWorld(true);
  expect(pickUnit([unitAt(0, 0, 1, 0.5)], far, { x: 0, y: 0 }, null)).not.toBeNull();
});
