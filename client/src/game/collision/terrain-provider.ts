import * as THREE from 'three';

import { Triangle } from './types';

/** One MCVT cell is an eighth of a chunk (yards). */
export const TERRAIN_CELL_SIZE = 33.33333 / 8;

/** Outer vertices per MCVT row, counting the interleaved cell centres. */
const ROW_STRIDE = 17;

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
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
export class TerrainProvider {
  private chunks = new Set<any>();

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
