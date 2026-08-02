import * as THREE from 'three';

import { Triangle } from './types';

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _worldBounds = new THREE.Box3();
const _triBox = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * Doodad collision candidates from each M2's own low-poly hull -- `boundingVertices` /
 * `boundingTriangles`, which `pipeline/m2/index.ts` already meshes as `BoundingMesh`.
 *
 * This is the model's AUTHORED collision volume, not its render geometry: a tree that draws tens of
 * thousands of triangles collides as a handful. So no acceleration structure is needed here either
 * -- a whole-mesh bounds rejection followed by a per-triangle AABB test beats building and
 * maintaining a tree per placement, and there are a great many placements.
 *
 * World bounds are recomputed per gather rather than cached: only a doodad's matrix changes when it
 * moves, so a cached world box would leave its collision behind at the old position.
 */
export class DoodadProvider {
  private hulls = new Set<THREE.Mesh>();

  /** Registered hull count. Read by the collision debug overlay. */
  get size(): number {
    return this.hulls.size;
  }

  add(mesh: THREE.Mesh): void {
    this.hulls.add(mesh);
  }

  remove(mesh: THREE.Mesh): void {
    this.hulls.delete(mesh);
  }

  clear(): void {
    this.hulls.clear();
  }

  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    for (const mesh of this.hulls) {
      this.gatherOne(mesh, worldBox, out);
    }
  }

  private gatherOne(mesh: THREE.Mesh, worldBox: THREE.Box3, out: Triangle[]): void {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positions = geometry && (geometry.getAttribute('position') as THREE.BufferAttribute);
    if (!positions || positions.count === 0) {
      return;
    }

    // Refresh the world matrix from the parent chain before using it.
    //
    // A hull is registered when its M2 is CONSTRUCTED, which happens before the doodad is placed --
    // and the scene root deliberately does not walk static subtrees, so nothing else ever updates
    // it. A stale matrix is the identity, which puts the bounds at the world origin where no query
    // reaches, and the doodad silently never collides at all. Measured: 2528 map doodads loaded,
    // zero triangles gathered.
    mesh.updateWorldMatrix(true, false);

    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    _worldBounds.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (!_worldBounds.intersectsBox(worldBox)) {
      return;
    }

    // Per-triangle rejection happens in LOCAL space: one inverse matrix beats transforming every
    // vertex of a hull we are mostly going to reject.
    _inverse.copy(mesh.matrixWorld).invert();
    _localBox.copy(worldBox).applyMatrix4(_inverse);

    const index = geometry.getIndex();
    const count = index ? index.count : positions.count;

    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;

      _a.fromBufferAttribute(positions, i0);
      _b.fromBufferAttribute(positions, i1);
      _c.fromBufferAttribute(positions, i2);

      _triBox.makeEmpty().expandByPoint(_a).expandByPoint(_b).expandByPoint(_c);
      if (!_triBox.intersectsBox(_localBox)) {
        continue;
      }

      _a.applyMatrix4(mesh.matrixWorld);
      _b.applyMatrix4(mesh.matrixWorld);
      _c.applyMatrix4(mesh.matrixWorld);

      _e1.subVectors(_b, _a);
      _e2.subVectors(_c, _a);
      const normal = new THREE.Vector3().crossVectors(_e1, _e2);
      const length = normal.length();
      if (length < 1e-9) {
        continue;
      }
      normal.divideScalar(length);

      out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: mesh });
    }
  }
}
