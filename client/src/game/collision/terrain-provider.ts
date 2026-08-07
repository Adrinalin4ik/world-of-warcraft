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

export class TerrainProvider {
  private chunks = new Set<any>();

  /** Scratch list for `heightAt`, kept off the `gather` scratch so a cast in flight is untouched. */
  private column: Triangle[] = [];

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

  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    for (const chunk of this.chunks) {
      this.gatherChunk(chunk, worldBox, out);
    }
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
