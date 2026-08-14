/**
 * The narrow phase, on the one case that is the reported defect: a click BESIDE a unit, inside the
 * broad-phase sphere.
 *
 * The numbers here are the live ones. Measured on :3000 as `Sgh` (`scratchpad/t20-target.js`), a Vale
 * Moth at 29.8 yd carried a pick sphere of radius **7.11 yd** -- its M2's own `vertexRadius` -- around a
 * body 2.03 yd tall, and a real click 3.25 yd off its centre selected it. Its authored collision hull is
 * **12 triangles**. So the sphere is what the test builds and the hull is what it expects to reject.
 */
import * as THREE from 'three';

import { pickUnit } from '../pick';

/** Just enough `Unit` for `pickUnit`: a view position, a collision height, and a model with a hull. */
function unitAt(x: number, y: number, half: number, hullHalf: number | null) {
  const view = new THREE.Object3D();
  view.position.set(x, y, 0);
  let model: THREE.Object3D & { vertexRadius: number; boundingMesh?: THREE.Mesh } | null = null;
  if (hullHalf !== null) {
    // A BOX, which is what a real creature hull is: `HumanMale.m2`'s is 8 vertices / 12 triangles
    // (`pipeline/m2/index.ts#createBoundingMesh`'s own measurement).
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hullHalf * 2, hullHalf * 2, half * 2));
    mesh.position.set(x, y, half);
    mesh.updateMatrixWorld(true);
    model = Object.assign(new THREE.Object3D(), { vertexRadius: 7.11, boundingMesh: mesh });
  }
  return {
    guid: `0x${x}${y}`,
    objectType: 3,
    collisionHeight: half * 2,
    view,
    model,
  } as never;
}

test('a click inside the sphere but outside the hull misses, and the sphere alone would have hit', () => {
  // Looking down -Y from 20 yd away at a unit standing at the origin, so a horizontal NDC offset is a
  // horizontal world offset.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(0, -20, 1);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);

  const unit = unitAt(0, 0, 1, 0.5);
  const entities = [unit];

  // Dead centre hits in both arms.
  expect(pickUnit(entities, camera, { x: 0, y: 0 }, null)).toBe(unit);

  // 0.2 in NDC x at this camera is ~1.7 yd sideways at 20 yd -- past the 0.5-yd hull, well inside the
  // 7.11-yd sphere. The narrow phase rejects it; the sphere-only control arm still takes it, which is
  // what makes this a test of the change and not of the camera.
  const beside = { x: 0.2, y: 0 };
  expect(pickUnit(entities, camera, beside, null)).toBeNull();
  expect(pickUnit(entities, camera, beside, null, { narrow: false })).toBe(unit);
});

test('a unit whose M2 ships no hull keeps the sphere, so it stays clickable', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(0, -20, 1);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);

  // No model at all -- the state every unit is in for the ~9 s its M2 takes to arm.
  const unit = unitAt(0, 0, 1, null);
  expect(pickUnit([unit], camera, { x: 0, y: 0 }, null)).toBe(unit);
});
