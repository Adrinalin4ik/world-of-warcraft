/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { adtLiquidSurface, LiquidRegistry, LiquidSurface, wmoLiquidSurface } from '../liquid-query';

const CELL = 33.33333 / 8;

/**
 * Builds a liquid grid mesh directly, in either the mirrored (ADT) or unmirrored (WMO) layout.
 *
 * The two real layouts disagree on both axes, so the query has to DERIVE the mapping from the
 * geometry rather than assume one. Building both here is what pins that.
 */
function surface(
  rows: number,
  cols: number,
  mirrored: boolean,
  heightAt: (row: number, col: number) => number,
  opts: {
    owner?: object;
    filled?: (row: number, col: number) => boolean;
    origin?: THREE.Vector3;
  } = {},
): LiquidSurface {
  const perRow = cols + 1;
  const positions = new Float32Array(perRow * (rows + 1) * 3);

  for (let row = 0; row <= rows; ++row) {
    for (let col = 0; col <= cols; ++col) {
      const i = row * perRow + col;
      positions[i * 3] = mirrored ? -(row * CELL) : col * CELL;
      positions[i * 3 + 1] = mirrored ? -(col * CELL) : row * CELL;
      positions[i * 3 + 2] = heightAt(row, col);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mesh = new THREE.Mesh(geometry);
  if (opts.origin) {
    mesh.position.copy(opts.origin);
  }
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);

  return {
    mesh,
    perRow,
    rows,
    cols,
    owner: opts.owner ?? null,
    isFilled: opts.filled ?? (() => true),
  };
}

const outdoors = { wmoGroup: null };

describe('LiquidRegistry', () => {
  it('answers a flat ADT sheet height anywhere inside it', () => {
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 25));

    const hit = registry.surfaceAt(-CELL * 1.5, -CELL * 2.5, outdoors);

    expect(hit).not.toBeNull();
    expect(hit!.surfaceZ).toBeCloseTo(25, 5);
  });

  it('answers a WMO sheet despite the opposite axis layout', () => {
    const room = {};
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, false, () => 12, { owner: room }));

    const hit = registry.surfaceAt(CELL * 1.5, CELL * 2.5, { wmoGroup: room });

    expect(hit).not.toBeNull();
    expect(hit!.surfaceZ).toBeCloseTo(12, 5);
    expect(hit!.owner).toBe(room);
  });

  it('interpolates between vertices on a sloped sheet', () => {
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, (_row, col) => col));

    const hit = registry.surfaceAt(-CELL * 0.5, -CELL * 1.5, outdoors);

    expect(hit).not.toBeNull();
    expect(hit!.surfaceZ).toBeCloseTo(1.5, 3);
  });

  it('gives no answer outside the grid', () => {
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 5));

    expect(registry.surfaceAt(500, 500, outdoors)).toBeNull();
    // The mirrored grid occupies negative XY, so positive coords are off the sheet.
    expect(registry.surfaceAt(CELL * 2, CELL * 2, outdoors)).toBeNull();
  });

  it('treats an unfilled tile as a hole in the sheet', () => {
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 5, {
      filled: (row, col) => !(row === 1 && col === 1),
    }));

    expect(registry.surfaceAt(-CELL * 1.5, -CELL * 1.5, outdoors)).toBeNull();
    expect(registry.surfaceAt(-CELL * 2.5, -CELL * 2.5, outdoors)).not.toBeNull();
  });

  it('answers only from the claimed room when indoors', () => {
    // Without the scope key a building's floor liquid answers for someone standing outside it --
    // which is how a player ends up swimming in mid-air.
    const room = {};
    const otherRoom = {};
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, false, () => 40, { owner: room }));

    expect(registry.surfaceAt(CELL, CELL, { wmoGroup: room })!.surfaceZ).toBeCloseTo(40, 5);
    expect(registry.surfaceAt(CELL, CELL, { wmoGroup: otherRoom })).toBeNull();
    expect(registry.surfaceAt(CELL, CELL, outdoors)).toBeNull();
  });

  it('answers only from unowned ADT liquid when outdoors', () => {
    const room = {};
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 8));
    registry.add(surface(4, 4, true, () => 99, { owner: room }));

    expect(registry.surfaceAt(-CELL * 1.5, -CELL * 1.5, outdoors)!.surfaceZ).toBeCloseTo(8, 5);
  });

  it('takes the highest of several overlapping eligible sheets', () => {
    // A swimmer belongs to the surface above them.
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 8));
    registry.add(surface(4, 4, true, () => 14));

    expect(registry.surfaceAt(-CELL, -CELL, outdoors)!.surfaceZ).toBeCloseTo(14, 5);
  });

  it('applies the mesh world transform to the answer', () => {
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 0, { origin: new THREE.Vector3(500, 600, 70) }));

    const hit = registry.surfaceAt(500 - CELL * 1.5, 600 - CELL * 1.5, outdoors);

    expect(hit).not.toBeNull();
    expect(hit!.surfaceZ).toBeCloseTo(70, 5);
  });

  it('stops answering once a sheet is removed', () => {
    const registry = new LiquidRegistry();
    const sheet = surface(4, 4, true, () => 5);
    registry.add(sheet);
    registry.remove(sheet.mesh);

    expect(registry.surfaceAt(-CELL, -CELL, outdoors)).toBeNull();
  });

  it('answers on the far edge of the grid rather than falling off it', () => {
    // A swimmer at the last tile must still get a surface; clamping the cell index wrong here
    // reads one row past the end and returns NaN.
    const registry = new LiquidRegistry();
    registry.add(surface(4, 4, true, () => 3));

    const hit = registry.surfaceAt(-CELL * 4 + 1e-6, -CELL * 4 + 1e-6, outdoors);

    expect(hit).not.toBeNull();
    expect(hit!.surfaceZ).toBeCloseTo(3, 5);
  });
});

describe('the layer adapters', () => {
  it('describes an ADT layer from its own fields', () => {
    const layer: any = new THREE.Mesh(new THREE.BufferGeometry());
    layer.data = { width: 6, height: 5 };
    layer.isFilled = (row: number, col: number) => row + col > 0;

    const adapted = adtLiquidSurface(layer);

    expect(adapted.cols).toBe(6);
    expect(adapted.rows).toBe(5);
    expect(adapted.perRow).toBe(7);
    expect(adapted.owner).toBeNull();
    expect(adapted.isFilled(0, 0)).toBe(false);
    expect(adapted.isFilled(1, 0)).toBe(true);
  });

  it('describes a WMO layer from its own fields, scoped to its group', () => {
    const room = {};
    const layer: any = new THREE.Mesh(new THREE.BufferGeometry());
    layer.data = { liquidVerts: { x: 9, y: 9 }, liquidTiles: { x: 8, y: 7 } };
    layer.isFilled = () => true;

    const adapted = wmoLiquidSurface(layer, room);

    expect(adapted.cols).toBe(8);
    expect(adapted.rows).toBe(7);
    expect(adapted.perRow).toBe(9);
    expect(adapted.owner).toBe(room);
  });

  it('delegates the fill mask to the layer rather than reimplementing it', () => {
    // Both layer types already own their mask, and the WMO one had an inversion bug once. Copying
    // that logic here would mean two places to get it wrong.
    const layer: any = new THREE.Mesh(new THREE.BufferGeometry());
    layer.data = { liquidVerts: { x: 3 }, liquidTiles: { x: 2, y: 2 } };
    const seen: Array<[number, number]> = [];
    layer.isFilled = (row: number, col: number) => {
      seen.push([row, col]);
      return true;
    };

    wmoLiquidSurface(layer, {}).isFilled(1, 0);

    expect(seen).toEqual([[1, 0]]);
  });
});
