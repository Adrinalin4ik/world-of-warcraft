/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { DoodadProvider } from '../doodad-provider';
import { Triangle } from '../types';

/** A unit-box hull, 12 triangles, optionally placed and scaled. */
function hull(position = new THREE.Vector3(0, 0, 0), scale = 1) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed());
  mesh.name = 'BoundingMesh';
  mesh.position.copy(position);
  mesh.scale.setScalar(scale);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);

  return mesh;
}

const boxAt = (x: number, y: number, z: number, r: number) => new THREE.Box3(
  new THREE.Vector3(x - r, y - r, z - r),
  new THREE.Vector3(x + r, y + r, z + r),
);

describe('DoodadProvider', () => {
  it('gathers the hull triangles for an overlapping box', () => {
    const provider = new DoodadProvider();
    provider.add(hull());

    const out: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), out);

    expect(out).toHaveLength(12);
    for (const t of out) {
      expect(t.normal.length()).toBeCloseTo(1, 5);
    }
  });

  it('gathers nothing for a box far from the hull', () => {
    const provider = new DoodadProvider();
    provider.add(hull());

    const out: Triangle[] = [];
    provider.gather(boxAt(100, 100, 100, 1), out);

    expect(out).toHaveLength(0);
  });

  it('gathers only the triangles the box actually overlaps', () => {
    const provider = new DoodadProvider();
    provider.add(hull());

    const out: Triangle[] = [];
    // A thin slab around the +Z face only.
    provider.gather(new THREE.Box3(
      new THREE.Vector3(-1, -1, 0.45),
      new THREE.Vector3(1, 1, 0.55),
    ), out);

    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(12);
  });

  it('applies the placement transform and scale', () => {
    const provider = new DoodadProvider();
    provider.add(hull(new THREE.Vector3(50, 60, 70), 4));

    const out: Triangle[] = [];
    provider.gather(boxAt(50, 60, 70, 5), out);

    expect(out).toHaveLength(12);
    const xs = out.flatMap((t) => [t.a.x, t.b.x, t.c.x]);
    expect(Math.max(...xs)).toBeCloseTo(52, 4);
    expect(Math.min(...xs)).toBeCloseTo(48, 4);
  });

  it('stops contributing once a hull is removed', () => {
    const provider = new DoodadProvider();
    const mesh = hull();
    provider.add(mesh);
    provider.remove(mesh);

    const out: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), out);

    expect(out).toHaveLength(0);
  });

  it('handles an indexed hull geometry as well as a non-indexed one', () => {
    const provider = new DoodadProvider();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.updateMatrixWorld(true);
    provider.add(mesh);

    const out: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), out);

    expect(out).toHaveLength(12);
  });

  it('reports the hull mesh as the source of every triangle', () => {
    const provider = new DoodadProvider();
    const mesh = hull();
    provider.add(mesh);

    const out: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), out);

    for (const t of out) {
      expect(t.source).toBe(mesh);
    }
  });

  it('re-derives world bounds after a hull moves', () => {
    // An animated or re-placed doodad keeps its cached geometry bounds; only its matrix changes.
    // Caching the WORLD bounds would leave collision behind at the old position.
    const provider = new DoodadProvider();
    const mesh = hull();
    provider.add(mesh);

    mesh.position.set(40, 0, 0);
    mesh.updateMatrixWorld(true);

    const atOldPlace: Triangle[] = [];
    const atNewPlace: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), atOldPlace);
    provider.gather(boxAt(40, 0, 0, 2), atNewPlace);

    expect(atOldPlace).toHaveLength(0);
    expect(atNewPlace).toHaveLength(12);
  });

  it('finds a hull whose world matrix was never updated after placement', () => {
    // Hulls are registered when the M2 is CONSTRUCTED, before the doodad is placed, and the scene
    // root does not walk static subtrees -- so nothing updates the matrix afterwards. Rejecting on
    // a stale (identity) matrix puts the bounds at the world origin, where no query reaches, and
    // the doodad never collides. Measured in game: 2528 doodads loaded, zero triangles gathered.
    const provider = new DoodadProvider();
    const mesh = hull();
    provider.add(mesh);

    // Placed under a parent, exactly as a streamed doodad is -- and deliberately NOT updated.
    const placement = new THREE.Object3D();
    placement.position.set(120, -40, 15);
    placement.add(mesh);
    placement.updateMatrix();

    const out: Triangle[] = [];
    provider.gather(boxAt(120, -40, 15, 2), out);

    expect(out).toHaveLength(12);
    expect(out[0].a.x).toBeGreaterThan(119);
  });

  it('picks up a placement that moves without an explicit matrix update', () => {
    const provider = new DoodadProvider();
    const mesh = hull();
    const placement = new THREE.Object3D();
    placement.add(mesh);
    provider.add(mesh);

    placement.position.set(300, 0, 0);
    placement.updateMatrix();

    const atOld: Triangle[] = [];
    const atNew: Triangle[] = [];
    provider.gather(boxAt(0, 0, 0, 2), atOld);
    provider.gather(boxAt(300, 0, 0, 2), atNew);

    expect(atOld).toHaveLength(0);
    expect(atNew).toHaveLength(12);
  });

  it('ignores a mesh with no position attribute rather than throwing', () => {
    const provider = new DoodadProvider();
    provider.add(new THREE.Mesh(new THREE.BufferGeometry()));

    const out: Triangle[] = [];
    expect(() => provider.gather(boxAt(0, 0, 0, 2), out)).not.toThrow();
    expect(out).toHaveLength(0);
  });
});
