import * as THREE from 'three';

import { LiquidClaim } from './types';

/**
 * One liquid sheet -- an ADT MH2O layer or a WMO MLIQ layer -- described uniformly enough to query.
 *
 * `owner` is the WMO group whose MLIQ this is, or null for outdoor ADT liquid. It is the scope key:
 * indoors only the claimed room's sheet answers, outdoors only unowned sheets do.
 */
export interface LiquidSurface {
  mesh: THREE.Mesh;
  /** Vertices per grid row (columns + 1). */
  perRow: number;
  /** Tile rows and columns. */
  rows: number;
  cols: number;
  owner: object | null;
  isFilled(row: number, col: number): boolean;
}

const _inverse = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _colStep = new THREE.Vector3();
const _rowStep = new THREE.Vector3();
const _world = new THREE.Vector3();

/**
 * The liquid surface query -- how deep the water over a point is, which is all swimming needs.
 *
 * Deliberately NOT a collider: you do not collide with water, you compare its surface against your
 * feet. The lookup is the same O(1) grid walk terrain uses, and for the same reason -- MH2O and
 * MLIQ are both regular grids.
 *
 * It answers for ALL liquids, not just water. You swim in lava and slime too: Blackrock's magma and
 * Undercity's sludge are surfaces you enter, not ones you fall through.
 */
export class LiquidRegistry {
  private surfaces = new Map<THREE.Mesh, LiquidSurface>();

  add(surface: LiquidSurface): void {
    this.surfaces.set(surface.mesh, surface);
  }

  remove(mesh: THREE.Mesh): void {
    this.surfaces.delete(mesh);
  }

  clear(): void {
    this.surfaces.clear();
  }

  /**
   * The liquid surface height (world Z) over `(x, y)`, or null when no eligible sheet covers it.
   * Where several eligible sheets overlap, the highest wins: a swimmer belongs to the surface above
   * them.
   */
  surfaceAt(
    x: number, y: number, claim: LiquidClaim,
  ): { surfaceZ: number; owner: object | null } | null {
    let best: { surfaceZ: number; owner: object | null } | null = null;

    for (const surface of this.surfaces.values()) {
      // The scope key. Indoors only THIS room's sheet answers; outdoors only unowned ADT sheets.
      // Without it a building's floor liquid answers for someone standing outside it, and the
      // ADT's for someone inside -- which is how a player ends up swimming in mid-air.
      if (surface.owner !== claim.wmoGroup) {
        continue;
      }

      const z = this.heightOn(surface, x, y);
      if (z !== null && (best === null || z > best.surfaceZ)) {
        best = { surfaceZ: z, owner: surface.owner };
      }
    }

    return best;
  }

  private heightOn(surface: LiquidSurface, x: number, y: number): number | null {
    const { mesh, perRow, rows, cols } = surface;
    const positions = mesh.geometry
      && (mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
    if (!positions || positions.count < perRow + 2) {
      return null;
    }

    _inverse.copy(mesh.matrixWorld).invert();
    _local.set(x, y, 0).applyMatrix4(_inverse);

    // Derive the grid basis from the mesh's own vertices: index 0 is the origin, index 1 is one
    // column along, index `perRow` is one row along. That handles the ADT's mirrored layout and the
    // WMO's unmirrored one with the same code, and cannot drift if either constructor changes.
    _origin.fromBufferAttribute(positions, 0);
    _colStep.fromBufferAttribute(positions, 1).sub(_origin);
    _rowStep.fromBufferAttribute(positions, perRow).sub(_origin);

    const colLen2 = _colStep.x * _colStep.x + _colStep.y * _colStep.y;
    const rowLen2 = _rowStep.x * _rowStep.x + _rowStep.y * _rowStep.y;
    if (colLen2 < 1e-9 || rowLen2 < 1e-9) {
      return null;
    }

    const dx = _local.x - _origin.x;
    const dy = _local.y - _origin.y;
    const colF = (dx * _colStep.x + dy * _colStep.y) / colLen2;
    const rowF = (dx * _rowStep.x + dy * _rowStep.y) / rowLen2;

    if (colF < 0 || rowF < 0 || colF > cols || rowF > rows) {
      return null;
    }

    // Clamped so a point exactly on the far edge lands in the last tile rather than one past it.
    const col = Math.min(cols - 1, Math.floor(colF));
    const row = Math.min(rows - 1, Math.floor(rowF));
    if (!surface.isFilled(row, col)) {
      return null;
    }

    const fc = colF - col;
    const fr = rowF - row;
    const h00 = positions.getZ(row * perRow + col);
    const h01 = positions.getZ(row * perRow + col + 1);
    const h10 = positions.getZ((row + 1) * perRow + col);
    const h11 = positions.getZ((row + 1) * perRow + col + 1);
    const localZ = (h00 * (1 - fc) + h01 * fc) * (1 - fr) + (h10 * (1 - fc) + h11 * fc) * fr;

    _world.set(_local.x, _local.y, localZ).applyMatrix4(mesh.matrixWorld);

    return _world.z;
  }
}

/**
 * Adapt an ADT MH2O layer (`pipeline/liquid/layer.js`) to a queryable surface.
 *
 * The fill mask is delegated to the layer rather than reimplemented -- both layer types already own
 * theirs, and copying the logic would mean two places to get it wrong.
 */
export function adtLiquidSurface(layer: any): LiquidSurface {
  return {
    mesh: layer,
    perRow: layer.data.width + 1,
    rows: layer.data.height,
    cols: layer.data.width,
    owner: null,
    isFilled: (row: number, col: number) => Boolean(layer.isFilled(row, col)),
  };
}

/** Adapt a WMO MLIQ layer (`pipeline/liquid/wmo-layer.js`), scoped to the group that owns it. */
export function wmoLiquidSurface(layer: any, owner: object): LiquidSurface {
  const { liquidVerts, liquidTiles } = layer.data;

  return {
    mesh: layer,
    perRow: liquidVerts.x,
    rows: liquidTiles.y,
    cols: liquidTiles.x,
    owner,
    isFilled: (row: number, col: number) => Boolean(layer.isFilled(row, col)),
  };
}
