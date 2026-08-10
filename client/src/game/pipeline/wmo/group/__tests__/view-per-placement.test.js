/**
 * @jest-environment node
 */
import * as THREE from 'three';

import WMOGroup from '../index';
import WMORoot from '../../root/index';
import { collisionWorld } from '../../../../collision/collision-world';

/**
 * A WMOGroup with only what `createView` touches.
 *
 * `Object.create` rather than `new`: the real constructor parses BSP nodes, builds geometry from
 * transferred typed arrays and loads materials off a root -- none of which a view-identity test needs.
 */
function group() {
  const stub = Object.create(WMOGroup.prototype);

  stub.path = 'WORLD\\WMO\\HOUSE.WMO';
  stub.index = 0;
  stub.geometry = new THREE.BufferGeometry();
  stub.materials = [new THREE.MeshBasicMaterial()];
  stub.bspTree = { nodes: [], indices: { plane: [], face: [] }, vertices: [] };
  stub.triangleFlags = new Uint8Array(0);
  stub.liquid = null;

  return stub;
}

describe('WMOGroup#createView', () => {
  afterEach(() => collisionWorld.clear());

  it('returns a DISTINCT view on every call', () => {
    // The bug this replaced: the group held one `this.view` and handed it to every placement. An
    // Object3D has one parent, so re-parenting moved it -- only the last placement existed and every
    // earlier copy of the building was absent from the world.
    const g = group();

    expect(g.createView()).not.toBe(g.createView());
  });

  it('does not take ownership of a view', () => {
    const g = group();
    g.createView();

    expect(g.view).toBeUndefined();
  });

  it('registers one collider per placement, not one per group', () => {
    const g = group();

    g.createView();
    g.createView();
    g.createView();

    expect(collisionWorld.wmo.size).toBe(3);
  });

  it('does not deregister an earlier placement when a later one is made', () => {
    // `createView` used to remove `this.view`'s collider first, so building a second placement
    // silently took collision away from the first.
    const g = group();
    const first = g.createView();
    g.createView();

    collisionWorld.wmo.remove(first);

    expect(collisionWorld.wmo.size).toBe(1);
  });

  it('shares the geometry and materials it was built from', () => {
    // Only the scene node is per placement; the expensive, placement-independent parts stay shared.
    const g = group();
    const a = g.createView();
    const b = g.createView();

    expect(a.geometry).toBe(b.geometry);
    expect(a.geometry).toBe(g.geometry);
    expect(a.material).toBe(b.material);
  });
});

describe('WMORoot#createView', () => {
  function root() {
    const stub = Object.create(WMORoot.prototype);
    stub.path = 'WORLD\\WMO\\HOUSE.WMO';
    return stub;
  }

  it('returns a DISTINCT view on every call', () => {
    const r = root();

    expect(r.createView()).not.toBe(r.createView());
  });

  it('does not take ownership of a view', () => {
    const r = root();
    r.createView();

    expect(r.view).toBeUndefined();
  });

  it('leaves each view free to carry its own placement transform', () => {
    // Two placements of one building must be able to stand in different places. Sharing one node made
    // their world bounding boxes byte-identical, which is how the missing buildings were found.
    const r = root();
    const a = r.createView();
    const b = r.createView();

    a.position.set(1285, 1356, 313);
    b.position.set(1348, 1441, 321);

    expect(a.position.x).toBe(1285);
    expect(b.position.x).toBe(1348);
  });
});
