import * as THREE from 'three';

import { Triangle } from './types';

/** One MCVT cell is an eighth of a chunk (yards). */
export const TERRAIN_CELL_SIZE = 33.33333 / 8;

/** Outer vertices per MCVT row, counting the interleaved cell centres. */
const ROW_STRIDE = 17;

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _columnBox = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * Where a triangle's plane sits at a world XY, or `null` when the XY falls outside it.
 *
 * 2D barycentric containment, then the plane solved for Z. Terrain never overhangs, so a triangle
 * whose XY projection contains the point has exactly one height there.
 */
function planeHeightAt(tri: Triangle, x: number, y: number): number | null {
  const { a, b, c } = tri;

  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(d) < 1e-12) {
    return null; // degenerate in projection -- a vertical sliver, no height to report
  }

  const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d;
  const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d;
  const w = 1 - u - v;

  // A hair of tolerance so a point exactly on a shared edge is claimed rather than dropped by both
  // triangles of the pair.
  if (u < -1e-6 || v < -1e-6 || w < -1e-6) {
    return null;
  }

  return u * a.z + v * b.z + w * c.z;
}

/**
 * Terrain collision candidates, straight off the MCVT heightmap.
 *
 * There is no acceleration structure here and there does not need to be one: MCVT is a regular
 * grid, so a query box maps arithmetically onto a range of cells. That is what makes swept-capsule
 * movement affordable without a physics engine -- the expensive part of collision, finding the
 * candidates, is O(1) for the surface the player stands on almost all the time.
 *
 * Chunk-LOCAL layout (see `pipeline/adt/chunk/index.ts`): `localX = -(row * cell)` and
 * `localY = -(col * cell)`, both MIRRORED -- hence the negations below, and hence the low local
 * bound mapping to the HIGH cell index. Each of the 8x8 cells is four triangles fanning from its
 * centre vertex at `9 + row * 17 + col`.
 */
export class TerrainProvider {
  private chunks = new Set<any>();

  /** Scratch list for `heightAt`, so it never has to borrow the caller's candidate array. */
  private column: Triangle[] = [];

  /** Cached world AABBs for the broadphase -- see `boundsOf` for the invalidation key. */
  private bounds = new WeakMap<object, { box: THREE.Box3; tx: number; ty: number; tz: number }>();

  /**
   * **THE A/B SWITCH. `false` restores the all-chunks walk exactly.**
   *
   * The broadphase's win was measured offline at ~8.4 us per untouched chunk, but the owner's five
   * at-rest `ctl.move` samples span 4.1 to 10.2 ms -- a 2.5x spread that a 2.7 ms change cannot be
   * seen inside, and `CLAUDE.md` says exactly that: run-to-run spread has repeatedly covered an
   * entire claimed change here. Two readings at two locations across a page reload cannot settle it.
   *
   * So the comparison has to happen in ONE sitting at ONE spot with the registered chunk set
   * unchanged, and the only difference between the arms is this boolean. `window.moveProfile()`
   * reports both arms' inputs alongside the timing.
   *
   * **Its mere PRESENCE also identifies the build**: `collisionWorld.terrain.broadphase === undefined`
   * means the page is running a bundle from before the fix, which is the trivial explanation to rule
   * out before any number is interpreted.
   */
  broadphase = true;

  /**
   * Gather counters and PER-GATHER timings -- see `window.moveProfile()`.
   *
   * **THE TIMING RING IS THE ARM THAT NEEDS NO SCALING ASSUMPTION.** An offline bench measured
   * ~8.4 us per untouched chunk at 64 chunks on a different machine; at the owner's **441** registered
   * chunks that would extrapolate to ~18.5 ms a frame from this term alone, which his pre-fix
   * `ctl.move` never came close to. So the bench gives the SHAPE and not the SIZE, and the size has
   * to be measured where it matters. `us` here is the median cost of ONE gather on HIS machine at HIS
   * chunk count -- flip `broadphase` and read it twice and the pair answers what the rejection bought,
   * with no extrapolation in it at all.
   *
   * Two clock reads per gather, five gathers on an at-rest frame, so about a microsecond a frame --
   * paid to measure the thing being argued about.
   */
  readonly census = {
    gathers: 0,
    visited: 0,
    rejected: 0,
    /**
     * ACCUMULATED microseconds across every gather since the reset, divided by `gathers` for the
     * mean. **Not a ring and not a median**: the owner's `performance.now()` is quantised to 100 us,
     * so an individual gather reads 0 or 100 and a median of those reports the quantum. See
     * `moveProfile`'s `gatherUs`.
     */
    usTotal: 0,
  };

  /** Registered chunk count. Read by the collision debug overlay. */
  get size(): number {
    return this.chunks.size;
  }

  add(chunk: any): void {
    this.chunks.add(chunk);
  }

  remove(chunk: any): void {
    this.chunks.delete(chunk);
  }

  clear(): void {
    this.chunks.clear();
  }

  /**
   * **THE BROADPHASE, and it is a rejection test rather than a spatial index.**
   *
   * This used to call `gatherChunk` for EVERY registered chunk, and `gatherChunk`'s first act is a
   * 4x4 matrix inversion plus a `Box3` transform -- paid in full for a chunk a hundred yards away
   * before its cell clamps reject it. MEASURED (`__bench__/gather.test.ts`), returning an identical
   * 4 candidates either way: **10.6 us with one chunk registered against 539.6 us with 64**, i.e.
   * about **8.4 us per registered chunk the query does not touch**. An at-rest movement frame runs
   * FOUR gathers inside `ctl.move` -- the ground classify, the election snap, one more cast and the
   * frame-start push-out (`rescueFromVoid`'s `heightAt` is a fifth, but outside the span).   *
   * **AND IT DID NOT SHOW. The owner's controlled A/B refutes the saving this note used to claim.**
   * Same spot, same 441 registered chunks, the only difference this boolean: `ctl.move` **5.1 ms with
   * the rejection and 4.6 ms without**, rejecting 440 of 441 chunks either way. `gatherUs` was ~100 us
   * in BOTH arms, which at 4 gathers a frame is **0.4 ms of a 4.6 ms section** -- so the gather was
   * never the cost and no rejection of it could have mattered. The extrapolation that predicted ~2.7 ms
   * was mine and it was unsound: it took a per-chunk constant measured at 64 chunks on another machine
   * and multiplied it by his 441.
   *
   * KEPT ANYWAY, and the reason is not the timing: 440 matrix inversions and box transforms per gather
   * are replaced by 440 cheaper tests, which is strictly less work, and
   * `__tests__/terrain-broadphase.test.ts` proves the output is unchanged. It is not defended as a
   * performance fix and must not be cited as one.
   *
   * A LIKELY REASON IT IS A WASH, stated as a suspicion rather than a measurement: `boundsOf` is a
   * `WeakMap` lookup per chunk, and a hashed lookup 1764 times a frame is not obviously cheaper than
   * the inversion it replaced. Storing the box ON the chunk would make it a property read -- but the
   * gather is 0.4 ms of 4.6, so there is nothing there worth winning and it is not worth the churn.
   *
   * The cached world AABB replaces that with four float compares on X and Y. **STRICTLY
   * CONSERVATIVE: the box CONTAINS the chunk and the test uses only the two axes `gatherChunk`
   * itself filters on, so a rejected chunk could not have contributed a single triangle.** Nothing about which triangles are returned changes -- `__tests__/terrain-broadphase.test.ts`
   * asserts the output is IDENTICAL to the all-chunks walk over a spread of boxes, which is the only
   * gate worth having here: this project's record is that five of six fixes in this area taken from
   * interpreting a symptom had to be reverted, and the one that stuck came from an offline
   * reproduction. This has one.
   *
   * **NOT a spatial index, deliberately.** A grid would beat this asymptotically, but it would also
   * have to be invalidated as chunks stream in and out, and the rejection test removes the term that
   * actually dominates: `gather` still visits every chunk, it just stops paying a matrix inversion to
   * do it. One cheap correct change beats one clever change that has to be got right twice.
   */
  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    this.census.gathers += 1;
    const t0 = performance.now();
    for (const chunk of this.chunks) {
      // Computed before the switch is consulted, so BOTH arms pay the same `boundsOf` call and the
      // A/B measures the rejection alone rather than the caching with it. `boundsOf` is a WeakMap hit
      // and three compares after the first call, so this costs the off-arm almost nothing -- and
      // leaving it out would have made the off-arm falsely cheap.
      const bounds = this.boundsOf(chunk);
      // A chunk with no resolvable bounds is NOT skipped -- it falls through to the old path, which
      // is the honest degrade: a geometry without a bounding box is a chunk we cannot reject, not a
      // chunk we may drop.
      //
      // **X AND Y ONLY, AND THE Z OMISSION IS THE LOAD-BEARING PART.** `gatherChunk` picks cells from
      // the local box's X and Y and returns every triangle in them REGARDLESS OF Z -- it has never
      // filtered on height, and the sweep downstream is what rejects a triangle that is out of
      // vertical reach. So an AABB test that included Z would be STRICTER than the walk it replaces
      // and would drop candidates the old path returned.
      //
      // That is not a hypothetical: the first version of this tested the full box and
      // `__tests__/terrain-broadphase.test.ts` failed on the four-corner join, where a query at
      // Z 0..8 must still gather the neighbouring chunks sitting at Z -3 and Z 12. The gate caught it
      // before it could become a fall-through-the-world report, which is exactly the reason it was
      // written first. Testing the same two axes the walk itself filters on makes the rejection a
      // strict superset of the cell clamps, so the output cannot change.
      this.census.visited += 1;
      if (this.broadphase
        && bounds !== null
        && (bounds.max.x < worldBox.min.x || bounds.min.x > worldBox.max.x
          || bounds.max.y < worldBox.min.y || bounds.min.y > worldBox.max.y)) {
        this.census.rejected += 1;
        continue;
      }
      this.gatherChunk(chunk, worldBox, out);
    }
    this.census.usTotal += (performance.now() - t0) * 1000;
  }

  /**
   * This chunk's WORLD-space AABB, cached, or `null` when it cannot be computed.
   *
   * **THE CACHE IS KEYED ON THE PLACEMENT, not merely on the chunk.** Terrain chunks are static once
   * placed (`pipeline/adt/chunk/index.ts` writes `position` in its constructor and never moves it),
   * but `gather` has always re-read `chunk.matrixWorld` every call, so caching without an
   * invalidation would quietly change that contract. The translation is stored alongside the box and
   * a chunk that moves recomputes -- three compares, and it keeps the old behaviour exactly for a
   * caller that does move one.
   *
   * `WeakMap`, so a chunk removed from the world takes its entry with it and this cannot become the
   * leak the geometry counts were checked for.
   */
  private boundsOf(chunk: any): THREE.Box3 | null {
    const geometry = chunk.geometry;
    if (!geometry) {
      return null;
    }
    if (geometry.boundingBox === null || geometry.boundingBox === undefined) {
      if (typeof geometry.computeBoundingBox !== 'function') {
        return null;
      }
      geometry.computeBoundingBox();
      if (!geometry.boundingBox) {
        return null;
      }
    }
    const m = chunk.matrixWorld;
    if (!m) {
      return null;
    }
    const tx = m.elements[12];
    const ty = m.elements[13];
    const tz = m.elements[14];
    const cached = this.bounds.get(chunk);
    if (cached !== undefined && cached.tx === tx && cached.ty === ty && cached.tz === tz) {
      return cached.box;
    }
    const box = geometry.boundingBox.clone().applyMatrix4(m);
    this.bounds.set(chunk, { box, tx, ty, tz });
    return box;
  }

  /**
   * The terrain surface height at a world XY, or `null` when no REGISTERED chunk covers it.
   *
   * Two callers, and they want opposite halves of the same answer:
   *
   *  - the post-teleport settle hold asks "has the ground under the destination arrived yet?", for
   *    which `null` is the whole point -- it is the difference between "streaming has not got here"
   *    and "this really is a hole";
   *  - the void rescue asks "how far under the world am I?", which needs an absolute height rather
   *    than a cast from the body, because a body 5000 yd down has no reach that finds anything.
   *
   * A cast cannot answer either one. `castFor` sweeps from a position, so it is bounded by where the
   * body already is, and a sweep long enough to reach the surface from far below gathers a column
   * through every provider. This is the heightmap read instead: `gather` maps the query box onto
   * cells arithmetically, so a hair-wide column costs one matrix inverse per registered chunk and at
   * most four triangles from the one chunk that covers the point.
   *
   * A hole (MCNK `holes`) reads as `null` here, because `gatherChunk` skips holed cells -- correct
   * for both callers: there genuinely is no terrain surface over a hole.
   */
  heightAt(x: number, y: number): number | null {
    // Hair-wide in XY, unbounded in Z: the cell lookup is a pure XY mapping, and the Z extent only
    // has to be wide enough not to reject the cell it lands in.
    _columnBox.min.set(x - 1e-3, y - 1e-3, -1e6);
    _columnBox.max.set(x + 1e-3, y + 1e-3, 1e6);

    const tris = this.column;
    tris.length = 0;
    this.gather(_columnBox, tris);

    let best: number | null = null;
    for (let i = 0, len = tris.length; i < len; ++i) {
      const z = planeHeightAt(tris[i], x, y);
      if (z !== null && (best === null || z > best)) {
        // The HIGHEST surface, for the one case two chunks can both answer: the query sits exactly on
        // a chunk seam and both neighbours' edge cells contain it.
        best = z;
      }
    }

    return best;
  }

  private gatherChunk(chunk: any, worldBox: THREE.Box3, out: Triangle[]): void {
    const positions = chunk.geometry && chunk.geometry.getAttribute('position');
    if (!positions) {
      return;
    }

    // Query in chunk-local space: one inverse matrix per chunk beats transforming 256 triangles.
    _inverse.copy(chunk.matrixWorld).invert();
    _localBox.copy(worldBox).applyMatrix4(_inverse);

    // Mirrored axes: local -33.33 is cell 8 and local 0 is cell 0, so the low local bound gives the
    // HIGH index and vice versa.
    const rowLo = Math.floor(-_localBox.max.x / TERRAIN_CELL_SIZE);
    const rowHi = Math.floor(-_localBox.min.x / TERRAIN_CELL_SIZE);
    const colLo = Math.floor(-_localBox.max.y / TERRAIN_CELL_SIZE);
    const colHi = Math.floor(-_localBox.min.y / TERRAIN_CELL_SIZE);

    for (let row = Math.max(0, rowLo); row <= Math.min(7, rowHi); ++row) {
      for (let col = Math.max(0, colLo); col <= Math.min(7, colHi); ++col) {
        if (chunk.isHole && chunk.isHole(row, col)) {
          continue;
        }

        const centre = 9 + row * ROW_STRIDE + col;
        const topLeft = centre - 9;
        const topRight = centre - 8;
        const bottomRight = centre + 9;
        const bottomLeft = centre + 8;

        this.emit(chunk, positions, centre, topLeft, topRight, out);
        this.emit(chunk, positions, centre, topRight, bottomRight, out);
        this.emit(chunk, positions, centre, bottomRight, bottomLeft, out);
        this.emit(chunk, positions, centre, bottomLeft, topLeft, out);
      }
    }
  }

  private emit(
    chunk: any,
    positions: THREE.BufferAttribute,
    i0: number,
    i1: number,
    i2: number,
    out: Triangle[],
  ): void {
    _a.fromBufferAttribute(positions, i0).applyMatrix4(chunk.matrixWorld);
    _b.fromBufferAttribute(positions, i1).applyMatrix4(chunk.matrixWorld);
    _c.fromBufferAttribute(positions, i2).applyMatrix4(chunk.matrixWorld);

    _e1.subVectors(_b, _a);
    _e2.subVectors(_c, _a);
    const normal = new THREE.Vector3().crossVectors(_e1, _e2);
    const length = normal.length();
    if (length < 1e-9) {
      return; // degenerate face -- nothing to collide with
    }
    normal.divideScalar(length);

    // Terrain never overhangs, so a downward normal is a winding artifact of the mirrored layout
    // rather than real geometry. Force it up: every movement rule keys off `normal.z`, and a
    // flipped normal reads a walkable floor as a ceiling.
    if (normal.z < 0) {
      normal.negate();
    }

    out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: chunk });
  }
}
