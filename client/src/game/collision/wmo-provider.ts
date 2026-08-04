import * as THREE from 'three';

import { wmoFaceIsCollidable } from './layers';
import { CollisionLayer, Triangle } from './types';

/** One placed WMO group's collision data. */
export interface WmoCollider {
  /** The placed group view -- its `matrixWorld` is the placement transform. */
  view: THREE.Object3D;
  /** The group's MOBN/MOBR tree (`game/utils/bsp-tree.ts`). */
  bspTree: any;
  /** MOPY flags, one byte per triangle, sharing the BSP's triangle indexing. */
  triangleFlags?: Uint8Array;

  /**
   * Per-collider cache, filled on first gather and refreshed only when the placement transform
   * actually changes.
   *
   * There is now one collider per PLACEMENT rather than one per file, so a city puts hundreds in the
   * registry and every cast walks all of them -- and a frame runs several casts (the slide's four
   * iterations, the ground classify, the election snap, the camera boom). Recomputing an inverse
   * matrix and transforming the query box per collider per cast is what that costs; a world-space
   * box test rejects almost all of them for a fraction of it.
   */
  cache?: {
    matrix: THREE.Matrix4;
    worldBox: THREE.Box3;
    inverse: THREE.Matrix4;
  };
}

const _localBox = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * WMO collision candidates from the MOBN/MOBR BSP tree.
 *
 * This is the structure the reference client itself collides buildings with, shipped in the file
 * and already built per group by `WMOGroup#createBSPTree` -- so there is nothing to construct here
 * and nothing to keep in sync as placements stream in and out.
 *
 * The query runs in MODEL-LOCAL space (one inverse matrix per placement) rather than transforming
 * geometry to world, which is both cheaper and what the reference does.
 *
 * The walk and camera audiences share one tree and differ only in the MOPY filter, because the
 * triangle index MOBR carries is also the index into the group's `triangleFlags`.
 */
export class WmoProvider {
  private colliders = new Map<THREE.Object3D, WmoCollider>();

  /**
   * Reused across placements within one gather. A face straddling a split plane is owned by more
   * than one leaf, and a doubled face is a doubled contact in the slide. Cleared PER PLACEMENT,
   * never shared across them -- two buildings both have a triangle 0.
   */
  private seen = new Set<number>();

  /** Registered group-collider count. Read by the collision debug overlay. */
  get size(): number {
    return this.colliders.size;
  }

  add(collider: WmoCollider): void {
    this.colliders.set(collider.view, collider);
  }

  remove(view: THREE.Object3D): void {
    this.colliders.delete(view);
  }

  clear(): void {
    this.colliders.clear();
  }

  gather(worldBox: THREE.Box3, layer: CollisionLayer, out: Triangle[]): void {
    for (const collider of this.colliders.values()) {
      this.gatherOne(collider, worldBox, layer, out);
    }
  }

  /**
   * The collider's cached inverse and world bounds, refreshed only when the placement moved.
   *
   * Keyed on the matrix itself rather than a dirty flag: WMO placements are static after load, so this
   * compares equal on every frame after the first and the recompute never runs again. `Matrix4.equals`
   * is sixteen float compares -- cheaper than the inverse it guards by a wide margin, and far cheaper
   * than being wrong if a placement ever does move.
   *
   * The world box comes from the BSP's own vertices, not from `group.boundingBox`: MOGP's bounds cover
   * the RENDER geometry, and the collision hull is a different, usually smaller set. Using the render
   * bounds would still be correct (they contain the hull) but would reject less.
   */
  private cacheFor(collider: WmoCollider) {
    const matrixWorld = collider.view.matrixWorld;

    if (collider.cache && collider.cache.matrix.equals(matrixWorld)) {
      return collider.cache;
    }

    const cache = collider.cache ?? {
      matrix: new THREE.Matrix4(),
      worldBox: new THREE.Box3(),
      inverse: new THREE.Matrix4(),
    };

    cache.matrix.copy(matrixWorld);
    cache.inverse.copy(matrixWorld).invert();

    const vertices: ArrayLike<number> | undefined = collider.bspTree?.vertices;
    cache.worldBox.makeEmpty();

    if (vertices) {
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        _a.set(vertices[i], vertices[i + 1], vertices[i + 2]);
        cache.worldBox.expandByPoint(_a);
      }
      cache.worldBox.applyMatrix4(matrixWorld);
    }

    collider.cache = cache;

    return cache;
  }

  private gatherOne(
    collider: WmoCollider, worldBox: THREE.Box3, layer: CollisionLayer, out: Triangle[],
  ): void {
    const { view, bspTree, triangleFlags } = collider;
    if (!bspTree || !bspTree.nodes || bspTree.nodes.length === 0) {
      return;
    }

    // Same staleness guard as the doodad provider: a placement registered before its transform was
    // resolved would query the BSP in the wrong frame, and the scene root does not walk static
    // subtrees to fix it.
    view.updateWorldMatrix(true, false);

    const cache = this.cacheFor(collider);

    // WORLD-space reject first, and this is the whole point of the cache. Almost every collider in a
    // city is nowhere near the query, and this rules it out with one box overlap instead of an inverse
    // matrix, a transformed box and a BSP descent.
    if (!cache.worldBox.intersectsBox(worldBox)) {
      return;
    }

    _localBox.copy(worldBox).applyMatrix4(cache.inverse);

    const leaves: number[] = bspTree.query(_localBox, 0);
    if (!leaves || leaves.length === 0) {
      return;
    }

    const { plane, face } = bspTree.indices;
    const vertices = bspTree.vertices;

    this.seen.clear();

    for (let l = 0; l < leaves.length; ++l) {
      const node = bspTree.nodes[leaves[l]];
      if (!node) {
        continue;
      }

      const begin = node.faceStart;
      const end = node.faceStart + node.nFaces;

      for (let p = begin; p < end; ++p) {
        const triangle = plane[p];
        if (this.seen.has(triangle)) {
          continue;
        }
        this.seen.add(triangle);

        // No flags array means the group predates the MOPY plumbing or came from a stale cache.
        // Collide with everything rather than turning the building into a walk-through.
        if (triangleFlags && !wmoFaceIsCollidable(triangleFlags[triangle], layer)) {
          continue;
        }

        const i0 = face[3 * triangle];
        const i1 = face[3 * triangle + 1];
        const i2 = face[3 * triangle + 2];

        _a.set(vertices[3 * i0], vertices[3 * i0 + 1], vertices[3 * i0 + 2])
          .applyMatrix4(view.matrixWorld);
        _b.set(vertices[3 * i1], vertices[3 * i1 + 1], vertices[3 * i1 + 2])
          .applyMatrix4(view.matrixWorld);
        _c.set(vertices[3 * i2], vertices[3 * i2 + 1], vertices[3 * i2 + 2])
          .applyMatrix4(view.matrixWorld);

        _e1.subVectors(_b, _a);
        _e2.subVectors(_c, _a);
        const normal = new THREE.Vector3().crossVectors(_e1, _e2);
        const length = normal.length();
        if (length < 1e-9) {
          continue;
        }
        normal.divideScalar(length);

        // Unlike terrain, a WMO normal is NOT forced up: a building genuinely has ceilings and
        // overhangs, and the steep-wall rule reads `normal.z < 0` to leave them alone.
        out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: view });
      }
    }
  }
}
