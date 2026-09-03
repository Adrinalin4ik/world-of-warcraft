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
  /**
   * The collision epoch this mesh's world matrix was last refreshed in. See `beginCollisionFrame`.
   *
   * `0` means never, which is also the value every entry starts at, so an unrefreshed hull always
   * refreshes.
   */
  refreshedIn: number;
  /** Identity-compared, not value-compared: a geometry swap replaces the object. */
  geometry: THREE.BufferGeometry;
  boundingBox: THREE.Box3;
  box: THREE.Box3;
}

/**
 * **THE COLLISION EPOCH: one world-matrix refresh per doodad per FRAME, not per cast.**
 *
 * MEASURED, and this is the whole of `ctl.move`. The owner's phase split standing still, 2060
 * frames: `depenetrate` 1698 us, `classify` 1586 us, `groundedStep` 1055 us -- 4.34 ms across three
 * collision phases -- against **36 candidates per frame**. The terrain gather is 44.5 us and
 * `castCapsuleAgainstTriangles` benches at ~2.7 us per triangle, so a dozen candidates is ~32 us.
 * Gather plus solve is under 80 us of a 1586 us phase; the other **~1.5 ms per cast is this
 * provider**, and it does not depend on the candidate count at all -- which is why three successive
 * candidate-count hypotheses all came back refuted.
 *
 * `gather` walks EVERY registered hull and `gatherOne` opened with
 * `mesh.updateWorldMatrix(true, false)`. The `true` makes it recurse UP the parent chain, so each
 * call re-composes every ancestor's `matrixWorld` on the way to the doodad. At the owner's
 * **1509 loaded map doodads** and three casts a frame that is ~4500 ancestor-chain walks per frame,
 * and it is being paid to reject a doodad that returns 3 candidates in total.
 *
 * It is also undoing a saving this project already banked: `scene.matrixWorldAutoUpdate = false`
 * took the render section from 8.1 ms to 1.9 ms precisely by not walking static nodes every frame
 * (`CLAUDE.md`), and this walks them from the collision path instead.
 *
 * **THE REFRESH CANNOT SIMPLY GO** -- its comment records why, with a measurement: a hull is
 * registered when its M2 is CONSTRUCTED, before the doodad is placed, and nothing else ever updates
 * a static subtree, so a stale identity matrix puts the bounds at the world origin and the doodad
 * silently never collides. "Measured: 2528 map doodads loaded, zero triangles gathered."
 *
 * So it is kept and made ONCE PER FRAME. Every cast in a frame sees the same scene -- the mover's
 * three casts and the camera's boom all run inside one `requestAnimationFrame` and nothing moves a
 * doodad between them -- so the second, third and fourth refresh of a frame can only recompute the
 * identical matrix.
 *
 * **DEFAULTS TO THE OLD BEHAVIOUR when no frame has been begun.** `epoch` starts at 0 and
 * `refreshedIn` starts at 0, so a caller that never calls `beginCollisionFrame` -- every collision
 * unit test -- refreshes on every gather exactly as before. The optimisation is opt-in by the app,
 * which keeps the risk on the side that has an owner to check it.
 */
let epoch = 0;

/**
 * Open a new collision frame: every doodad hull will refresh its world matrix once more.
 *
 * Called from `Controls#update` before any cast is issued. Bumping it more often than once a frame
 * is safe (it only costs the refreshes back); bumping it LESS often is not, and is why this is not
 * driven off the movement census, which is stamped after the mover has already cast.
 */
export function beginCollisionFrame(): void {
  epoch += 1;
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
      // A FRESH entry is created by the very gather that just refreshed this mesh's matrix, so it is
      // already current for this epoch. Leaving it at 0 would refresh a second time on the next
      // gather of the same frame -- correct, but it would give back a quarter of the saving on every
      // newly streamed doodad.
      refreshedIn: epoch,
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

    // Refresh the world matrix from the parent chain before using it -- ONCE PER FRAME, not once per
    // cast. See `beginCollisionFrame` for the measurement that made this the whole of `ctl.move`,
    // and for why the refresh itself cannot simply be removed.
    //
    // A hull is registered when its M2 is CONSTRUCTED, which happens before the doodad is placed --
    // and the scene root deliberately does not walk static subtrees, so nothing else ever updates
    // it. A stale matrix is the identity, which puts the bounds at the world origin where no query
    // reaches, and the doodad silently never collides at all. Measured: 2528 map doodads loaded,
    // zero triangles gathered.
    // `epoch === 0` means NO FRAME HAS EVER BEEN BEGUN, and then the skip is disabled outright.
    // **That guard is load-bearing and its absence was a real bug**: a fresh entry is stamped with
    // the current epoch, so at epoch 0 it compared equal and the refresh was skipped for ever --
    // which `__tests__/doodad-provider.test.ts`'s "re-gathers a placement that moves after its
    // bounds were already cached" caught immediately, gathering 12 triangles at a position the
    // doodad had left. Every collision unit test runs at epoch 0 and therefore keeps the exact
    // pre-change behaviour; only the app, which calls `beginCollisionFrame`, takes the saving.
    if (cached === null || epoch === 0 || cached.refreshedIn !== epoch) {
      mesh.updateWorldMatrix(true, false);
      if (cached !== null) {
        cached.refreshedIn = epoch;
      }
    }

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
