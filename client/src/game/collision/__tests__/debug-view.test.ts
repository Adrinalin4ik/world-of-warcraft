/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { collisionWorld } from '../collision-world';
import { CollisionDebugView, COLLISION_DEBUG_REBUILD_STEP } from '../debug-view';
import { CollisionLayer } from '../types';

/** A unit-box M2 hull at `position`, exactly as `M2.createBoundingMesh` registers one. */
function hull(position = new THREE.Vector3(0, 0, 0)) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed());
  mesh.name = 'BoundingMesh';
  mesh.position.copy(position);
  mesh.updateMatrixWorld(true);
  return mesh;
}

const drawn = (view: CollisionDebugView) =>
  (view.object.geometry as THREE.BufferGeometry).drawRange.count;

describe('CollisionDebugView', () => {
  afterEach(() => {
    collisionWorld.clear();
  });

  it('draws nothing and gathers nothing while disabled', () => {
    collisionWorld.doodads.add(hull());
    const view = new CollisionDebugView();

    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.object.visible).toBe(false);
    expect(drawn(view)).toBe(0);
    expect(view.counts.total).toBe(0);
  });

  it('gathers and draws three edges per triangle once enabled', () => {
    collisionWorld.doodads.add(hull());
    const view = new CollisionDebugView();
    view.enabled = true;

    view.update(new THREE.Vector3(0, 0, 0));

    // A box hull is 12 triangles; each contributes 3 edges, so 6 line vertices.
    expect(view.counts.doodad).toBe(12);
    expect(view.counts.total).toBe(12);
    expect(drawn(view)).toBe(12 * 6);
    expect(view.object.visible).toBe(true);
  });

  it('counts each provider separately', () => {
    // The doodad count is the one that matters most: it read 0 in a forest for a long time while
    // 2528 doodads were loaded, and only a per-provider split makes that visible at a glance.
    collisionWorld.doodads.add(hull());
    const view = new CollisionDebugView();
    view.enabled = true;

    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.terrain).toBe(0);
    expect(view.counts.wmo).toBe(0);
    expect(view.counts.doodad).toBe(12);
    expect(view.counts.registeredHulls).toBe(1);
  });

  it('reports registered totals even where nothing is gathered', () => {
    // "Registered 400 hulls, gathered 0 here" is a placement bug; "registered 0" is a wiring bug.
    // Collapsing the two would send a diagnosis in the wrong direction.
    collisionWorld.doodads.add(hull(new THREE.Vector3(500, 500, 0)));
    const view = new CollisionDebugView();
    view.enabled = true;

    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.doodad).toBe(0);
    expect(view.counts.registeredHulls).toBe(1);
  });

  it('skips the rebuild until the centre has moved far enough', () => {
    const mesh = hull();
    collisionWorld.doodads.add(mesh);
    const view = new CollisionDebugView();
    view.enabled = true;
    view.update(new THREE.Vector3(0, 0, 0));

    collisionWorld.doodads.remove(mesh);
    view.update(new THREE.Vector3(COLLISION_DEBUG_REBUILD_STEP * 0.5, 0, 0));

    expect(view.counts.doodad).toBe(12); // stale on purpose -- nothing moved far enough
  });

  it('rebuilds once the centre moves past the step', () => {
    const mesh = hull();
    collisionWorld.doodads.add(mesh);
    const view = new CollisionDebugView();
    view.enabled = true;
    view.update(new THREE.Vector3(0, 0, 0));

    collisionWorld.doodads.remove(mesh);
    view.update(new THREE.Vector3(COLLISION_DEBUG_REBUILD_STEP * 2, 0, 0));

    expect(view.counts.doodad).toBe(0);
  });

  it('rebuilds on demand without waiting for movement', () => {
    const mesh = hull();
    collisionWorld.doodads.add(mesh);
    const view = new CollisionDebugView();
    view.enabled = true;
    view.update(new THREE.Vector3(0, 0, 0));

    collisionWorld.doodads.remove(mesh);
    view.invalidate();
    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.doodad).toBe(0);
  });

  it('rebuilds when the radius changes, at the same centre', () => {
    collisionWorld.doodads.add(hull(new THREE.Vector3(40, 0, 0)));
    const view = new CollisionDebugView();
    view.enabled = true;
    view.radius = 10;
    view.update(new THREE.Vector3(0, 0, 0));
    expect(view.counts.doodad).toBe(0);

    view.radius = 50;
    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.doodad).toBe(12);
  });

  it('rebuilds when the layer changes, at the same centre', () => {
    const view = new CollisionDebugView();
    view.enabled = true;
    view.update(new THREE.Vector3(0, 0, 0));

    collisionWorld.doodads.add(hull());
    view.layer = CollisionLayer.Camera;
    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.doodad).toBe(12);
  });

  it('clears the draw range and counts when switched off', () => {
    collisionWorld.doodads.add(hull());
    const view = new CollisionDebugView();
    view.enabled = true;
    view.update(new THREE.Vector3(0, 0, 0));
    expect(drawn(view)).toBeGreaterThan(0);

    view.enabled = false;

    expect(drawn(view)).toBe(0);
    expect(view.counts.total).toBe(0);
    expect(view.object.visible).toBe(false);
  });

  it('grows its buffers rather than truncating a larger gather', () => {
    // 40 hulls is 480 triangles, well past the initial capacity.
    for (let i = 0; i < 40; ++i) {
      collisionWorld.doodads.add(hull(new THREE.Vector3(i * 0.5, 0, 0)));
    }
    const view = new CollisionDebugView();
    view.enabled = true;

    view.update(new THREE.Vector3(0, 0, 0));

    expect(view.counts.doodad).toBe(480);
    expect(drawn(view)).toBe(480 * 6);
    const positions = view.object.geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThanOrEqual(480 * 6);
  });

  it('x-ray drives the material depth test', () => {
    const view = new CollisionDebugView();
    const material = view.object.material as THREE.LineBasicMaterial;

    view.xray = false;
    expect(material.depthTest).toBe(true);

    view.xray = true;
    expect(material.depthTest).toBe(false);
  });
});
