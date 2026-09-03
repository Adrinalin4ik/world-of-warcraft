/**
 * CLICKING A NAMEPLATE SELECTS ITS UNIT -- the geometry half, which is the half that can be wrong.
 *
 * `pickPlate` derives its rect from the SAME constants `place()` draws with: the frame is
 * `ART.frameWidth` x `ART.frameHeight` LOGICAL (768-space) pixels, horizontally centred on the
 * plate's world anchor and lifted `PLATE.lift` logical pixels above it. Those are the numbers under
 * test, and a sign or an aspect error in them is exactly the class of defect this project keeps
 * finding, so both arms are geometric.
 *
 * The `plates` map is populated directly rather than through `update()`. Deliberate: `update()`
 * rasterizes text into canvases and resolves BLP art, none of which is under test here, and a test
 * that dragged the rasterizer in would fail for reasons unrelated to the hit rect. What IS under
 * test is the projection and the depth key.
 */
import * as THREE from 'three';

import { Nameplates } from '../nameplates';

/** A camera looking down -Z from the origin, so a plate at -Z projects to the middle of the screen. */
function cameraAt(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

/** Just enough `Plate` for `pickPlate`: a visible group at a world anchor, and a depth key. */
function plateAt(x: number, y: number, z: number, distanceSq: number) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.visible = true;
  return { group, distanceSq } as never;
}

const platesOf = (n: Nameplates) => (n as unknown as { plates: Map<string, unknown> }).plates;

describe('Nameplates#pickPlate', () => {
  it('hits inside the frame and misses outside it, on both axes', () => {
    const nameplates = new Nameplates(new THREE.Scene());
    const camera = cameraAt(16 / 9);
    platesOf(nameplates).set('0xAAA', plateAt(0, 0, -20, 400));

    // The anchor projects to NDC (0, 0). One logical pixel is 2/768 of the NDC y range and
    // (2/768)/aspect of x. The frame is 128 wide and 17 tall, lifted 6 -- so its vertical band is
    // y in [6, 23] logical px above the anchor, and its half-width is 64 logical px.
    const perY = 2 / 768;
    const perX = perY / (16 / 9);

    // Dead centre of the band, on the anchor's column.
    expect(nameplates.pickPlate({ x: 0, y: 14.5 * perY }, camera)).toBe('0xAAA');
    // Just inside each edge.
    expect(nameplates.pickPlate({ x: 63 * perX, y: 7 * perY }, camera)).toBe('0xAAA');
    // BELOW the lift -- the gap between the unit's head and the frame's bottom edge is not the frame.
    expect(nameplates.pickPlate({ x: 0, y: 3 * perY }, camera)).toBeNull();
    // Above the top edge, and beyond the half-width.
    expect(nameplates.pickPlate({ x: 0, y: 30 * perY }, camera)).toBeNull();
    expect(nameplates.pickPlate({ x: 70 * perX, y: 14.5 * perY }, camera)).toBeNull();
  });

  it('picks the FRONTMOST of two overlapping plates', () => {
    const nameplates = new Nameplates(new THREE.Scene());
    const camera = cameraAt(1);
    // Same anchor, so the rects coincide exactly -- only the depth key can separate them.
    platesOf(nameplates).set('0xFAR', plateAt(0, 0, -40, 1600));
    platesOf(nameplates).set('0xNEAR', plateAt(0, 0, -10, 100));

    expect(nameplates.pickPlate({ x: 0, y: 14.5 * (2 / 768) }, camera)).toBe('0xNEAR');

    // And a hidden plate is not clickable, whatever its depth -- the same rule the eye applies.
    (platesOf(nameplates).get('0xNEAR') as { group: THREE.Group }).group.visible = false;
    expect(nameplates.pickPlate({ x: 0, y: 14.5 * (2 / 768) }, camera)).toBe('0xFAR');
  });
});
