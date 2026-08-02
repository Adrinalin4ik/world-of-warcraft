/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { TERRAIN_CELL_SIZE, TerrainProvider } from '../terrain-provider';
import { Triangle } from '../types';

/**
 * A stand-in for an ADT Chunk carrying only what the provider reads: a position attribute in the
 * 17-per-row MCVT layout, a hole mask, and a world matrix.
 *
 * The chunk-LOCAL layout is mirrored on both axes -- `localX = -(row * cell)`,
 * `localY = -(col * cell)` -- which is the trap this provider has to get right.
 */
function fakeChunk(height: number, holes = 0, origin = new THREE.Vector3(0, 0, 0)) {
  const positions = new Float32Array(145 * 3);

  for (let i = 0; i < 145; ++i) {
    let row = Math.floor(i / 17);
    let col = i % 17;
    if (col > 8) {
      row += 0.5;
      col -= 8.5;
    }
    positions[i * 3] = -(row * TERRAIN_CELL_SIZE);
    positions[i * 3 + 1] = -(col * TERRAIN_CELL_SIZE);
    positions[i * 3 + 2] = height;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const chunk: any = new THREE.Mesh(geometry);
  chunk.position.copy(origin);
  chunk.holes = holes;
  chunk.isHole = (row: number, col: number) => {
    const bit = 1 << (Math.floor(row / 2) * 4 + Math.floor(col / 2));
    return (bit & chunk.holes) !== 0;
  };
  chunk.updateMatrix();
  chunk.updateMatrixWorld(true);

  return chunk;
}

/** A tall query box around an XY point, so only the horizontal footprint decides the result. */
function boxAround(x: number, y: number, r: number) {
  return new THREE.Box3(
    new THREE.Vector3(x - r, y - r, -100),
    new THREE.Vector3(x + r, y + r, 100),
  );
}

/** The centre of cell (row, col) in world XY, for a chunk at the origin. */
function cellCentre(row: number, col: number) {
  return {
    x: -((row + 0.5) * TERRAIN_CELL_SIZE),
    y: -((col + 0.5) * TERRAIN_CELL_SIZE),
  };
}

describe('TerrainProvider', () => {
  it('gathers exactly one cell four triangles for a box inside it', () => {
    const provider = new TerrainProvider();
    provider.add(fakeChunk(12));

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(x, y, 0.2), out);

    expect(out).toHaveLength(4);
    for (const t of out) {
      expect(t.a.z).toBeCloseTo(12, 5);
      expect(t.normal.z).toBeCloseTo(1, 5);
    }
  });

  it('gathers sixteen triangles for a box spanning a 2x2 block of cells', () => {
    const provider = new TerrainProvider();
    provider.add(fakeChunk(0));

    const out: Triangle[] = [];
    // Straddle the boundary between cells 0 and 1 on both axes.
    provider.gather(boxAround(-TERRAIN_CELL_SIZE, -TERRAIN_CELL_SIZE, TERRAIN_CELL_SIZE * 0.4), out);

    expect(out).toHaveLength(16);
  });

  it('picks the cell the box is actually over, not a mirrored one', () => {
    // The mirrored axes are the trap: getting the sign wrong still returns four triangles, just
    // from the wrong corner of the chunk. Tag one cell by height and check we get THAT one.
    const provider = new TerrainProvider();
    const chunk = fakeChunk(0);
    const positions = chunk.geometry.getAttribute('position');
    // Raise every vertex of cell (3, 5): its centre and its four corners.
    const centre = 9 + 3 * 17 + 5;
    for (const index of [centre, centre - 9, centre - 8, centre + 8, centre + 9]) {
      positions.setZ(index, 77);
    }
    provider.add(chunk);

    const out: Triangle[] = [];
    const { x, y } = cellCentre(3, 5);
    provider.gather(boxAround(x, y, 0.2), out);

    expect(out).toHaveLength(4);
    for (const t of out) {
      expect(t.a.z).toBeCloseTo(77, 5);
    }
  });

  it('treats a hole as a real gap and contributes nothing', () => {
    const provider = new TerrainProvider();
    provider.add(fakeChunk(0, 1)); // bit 0 covers rows 0-1, cols 0-1

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(x, y, 0.2), out);

    expect(out).toHaveLength(0);
  });

  it('gathers nothing for a box outside the chunk footprint', () => {
    const provider = new TerrainProvider();
    provider.add(fakeChunk(0));

    const out: Triangle[] = [];
    provider.gather(boxAround(500, 500, 1), out);

    expect(out).toHaveLength(0);
  });

  it('applies the chunk world transform to the emitted triangles', () => {
    const origin = new THREE.Vector3(1000, 2000, 30);
    const provider = new TerrainProvider();
    provider.add(fakeChunk(0, 0, origin));

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(origin.x + x, origin.y + y, 0.2), out);

    expect(out).toHaveLength(4);
    expect(out[0].a.z).toBeCloseTo(30, 5);
    expect(out[0].a.x).toBeLessThanOrEqual(1000);
    expect(out[0].a.x).toBeGreaterThan(1000 - 33.4);
  });

  it('stops contributing once a chunk is removed', () => {
    const provider = new TerrainProvider();
    const chunk = fakeChunk(0);
    provider.add(chunk);
    provider.remove(chunk);

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(x, y, 0.2), out);

    expect(out).toHaveLength(0);
  });

  it('points every normal up, because terrain never overhangs', () => {
    const provider = new TerrainProvider();
    const chunk = fakeChunk(0);
    // Drop one cell centre so the fan is genuinely sloped rather than degenerate.
    chunk.geometry.getAttribute('position').setZ(9, -3);
    provider.add(chunk);

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(x, y, 0.2), out);

    expect(out.length).toBeGreaterThan(0);
    for (const t of out) {
      expect(t.normal.z).toBeGreaterThan(0);
      expect(t.normal.length()).toBeCloseTo(1, 5);
    }
  });

  it('reports the chunk as the source of every triangle it emits', () => {
    const provider = new TerrainProvider();
    const chunk = fakeChunk(0);
    provider.add(chunk);

    const out: Triangle[] = [];
    const { x, y } = cellCentre(0, 0);
    provider.gather(boxAround(x, y, 0.2), out);

    for (const t of out) {
      expect(t.source).toBe(chunk);
    }
  });
});
