import * as THREE from 'three';

import { Triangle } from './types';

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _triBox = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * One hull's cached world bounds, and the exact inputs they were derived from. See
 * `DoodadProvider#worldBoundsOf` for why all three are compared rather than just the matrix.
 */
interface HullBounds {
  /** A COPY of the 16 elements, not the live array -- the live one mutates under us. */
  matrix: Float64Array;
  /** Identity-compared, not value-compared: a geometry swap replaces the object. */
  geometry: THREE.BufferGeometry;
  boundingBox: THREE.Box3;
  box: THREE.Box3;
}

/** 16 floats, compared exactly. No epsilon: the question is "is this the same matrix", not "is it
 * close" -- a near-equal matrix is a doodad that moved slightly, and its collision must move with
 * it. */
function matrixEquals(cached: Float64Array, elements: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; ++i) {
    if (cached[i] !== elements[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Doodad collision candidates from each M2's own low-poly hull -- `boundingVertices` /
 * `boundingTriangles`, which `pipeline/m2/index.ts` already meshes as `BoundingMesh`.
 *
 * This is the model's AUTHORED collision volume, not its render geometry: a tree that draws tens of
 * thousands of triangles collides as a handful. So no acceleration structure is needed here either
 * -- a whole-mesh bounds rejection followed by a per-triangle AABB test beats building and
 * maintaining a tree per placement, and there are a great many placements.
 *
 * World bounds ARE cached, against the matrix they were derived from. See `worldBoundsOf` -- the
 * earlier note here said they were recomputed per gather "because only a doodad's matrix changes
 * when it moves, so a cached world box would leave its collision behind at the old position". The
 * premise is right and the conclusion did not follow: a cache keyed ON the matrix cannot go stale,
 * because a moved doodad has a different matrix and misses it. Measured, that recompute was the
 * single largest cost in the frame -- see `worldBoundsOf`.
 */
export class DoodadProvider {
  /**
   * The registered hulls, each carrying its own cached world bounds.
   *
   * A `Map` from mesh to cache entry rather than a `Set` plus a side `WeakMap`, because `gather`
   * needs BOTH for every hull it visits and a Map iteration hands them over together. With a side
   * table it was one hash lookup per hull per cast -- 4965 lookups x ~2.9 casts a frame, which
   * measured as the largest remaining item once the bounds transform itself was cached. The entry
   * is created lazily (`null` until the first gather) so `add` stays a plain insert; a doodad may
   * be registered and never come near the player.
   *
   * Lifetime is `remove()` / `clear()`, exactly as the Set's was -- the entry cannot outlive its
   * mesh's registration, so this reintroduces no retention a `Set<Mesh>` did not already have.
   */
  private hulls = new Map<THREE.Mesh, HullBounds | null>();

  /** Registered hull count. Read by the collision debug overlay. */
  get size(): number {
    return this.hulls.size;
  }

  add(mesh: THREE.Mesh): void {
    if (!this.hulls.has(mesh)) {
      this.hulls.set(mesh, null);
    }
  }

  remove(mesh: THREE.Mesh): void {
    this.hulls.delete(mesh);
  }

  clear(): void {
    this.hulls.clear();
  }

  /**
   * The hull's bounds in world space, recomputed ONLY when the matrix or the geometry that produced
   * them changed.
   *
   * WHY THIS IS THE HOT PATH, measured rather than assumed. `gather` runs once per cast, and
   * `movementFrame` plus `seatCamera` issue about 2.9 casts per frame between them. Every one of
   * those walked all 4965 registered hulls at Northshire. Timed in the page over the real
   * registered set, one full walk cost:
   *
   *     mesh.updateWorldMatrix(true, false)          0.865 ms
   *     boundingBox.copy(...).applyMatrix4(matrix)   3.00  ms   <-- this
   *     worldBounds.intersectsBox(queryBox)          0.225 ms
   *
   * -- and the whole doodad `gather` accounted for 2532 ms of a 5030 ms window (49% of ALL wall
   * time; terrain gather was 200 ms and WMO 102 ms over the same window). `Box3#applyMatrix4`
   * transforms all eight corners and re-unions them, so it is ~50 multiplies per hull per cast for
   * a static prop that has not moved since the ADT placed it. In the same window, the number of
   * those 4965 hulls whose bounds actually intersected the query box was ZERO.
   *
   * THE SKIP IS EXACT, in the sense this project uses the word -- it is not a throttle and not a
   * distance heuristic. The cached box is a pure function of (`geometry.boundingBox`,
   * `matrixWorld`), and both are compared before it is reused: a doodad that moves by any amount
   * gets a different matrix, misses the cache, and is recomputed the same frame. Nothing is
   * deferred to a later frame and no cast sees geometry in the wrong place.
   *
   * `updateWorldMatrix(true, false)` is deliberately still called unconditionally, above. It is the
   * cheap fifth of this cost, and it is what makes the matrix comparison meaningful in the first
   * place -- a hull registers at M2 CONSTRUCTION, before its doodad is placed, and the scene root
   * does not walk static subtrees, so nothing else ever refreshes it. Skipping it to save 0.865 ms
   * would reintroduce the "2528 map doodads loaded, zero triangles gathered" defect this file's
   * `gatherOne` already documents.
   */
  private worldBoundsOf(
    mesh: THREE.Mesh, geometry: THREE.BufferGeometry, cached: HullBounds | null,
  ): HullBounds | null {
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    const boundingBox = geometry.boundingBox;
    if (!boundingBox) {
      return null;
    }

    const elements = mesh.matrixWorld.elements;

    if (cached !== null
      && cached.geometry === geometry
      && cached.boundingBox === boundingBox
      && matrixEquals(cached.matrix, elements)) {
      return cached;
    }

    const entry = cached ?? {
      matrix: new Float64Array(16),
      geometry,
      boundingBox,
      box: new THREE.Box3(),
    };

    entry.matrix.set(elements);
    entry.geometry = geometry;
    entry.boundingBox = boundingBox;
    entry.box.copy(boundingBox).applyMatrix4(mesh.matrixWorld);

    this.hulls.set(mesh, entry);
    return entry;
  }

  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    this.hulls.forEach((cached, mesh) => {
      this.gatherOne(mesh, cached, worldBox, out);
    });
  }

  private gatherOne(
    mesh: THREE.Mesh, cached: HullBounds | null, worldBox: THREE.Box3, out: Triangle[],
  ): void {
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

    const bounds = this.worldBoundsOf(mesh, geometry, cached);
    if (bounds === null || !bounds.box.intersectsBox(worldBox)) {
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
