/**
 * The ring's ONE load-bearing claim, on the one case a flat quad gets wrong: the decal FOLLOWS A SLOPE.
 *
 * Two tests, happy path only. The first is the geometry -- the projector emits vertices that lie ON the
 * receiving triangles' own planes, over a 45-degree ramp where a flat quad would be metres out. The
 * second is the colour selector's one branch order that a duplicated palette got wrong in the reference
 * (a player never grays).
 *
 * The projector reads `collisionWorld` directly, so the test registers a synthetic terrain chunk with it
 * -- the same door `terrain-manager` uses -- rather than mocking the module. That keeps the gather under
 * test too: a projector that clipped correctly but gathered nothing would still pass a mocked version.
 */
import * as THREE from 'three';

import { collisionWorld } from '../../collision/collision-world';
import { decalMesh, projectDecal, rectUv, DecalFrame } from '../decal';
import { selectionColor, SELECTION_NEUTRAL, SELECTION_PLAYER } from '../selection-color';

/**
 * A 3x3-vertex terrain patch in the shape `TerrainProvider#gatherChunk` reads: a 145-position buffer
 * laid out as the MCNK 9x9 + 8x8 interleave, plus a `matrixWorld`.
 *
 * `gatherChunk` maps the query box onto cells through the chunk's INVERSE matrix with mirrored axes
 * (local -x is the row index), so the chunk here is placed with the identity-mirroring transform the
 * real ADT chunks carry: local (-row*4.1667, -col*4.1667) is world (+x, +y).
 */
const CELL = 33.3333 / 8;
const ROW_STRIDE = 17;

function rampChunk(heightAt: (x: number, y: number) => number, offset = 0) {
  const positions = new Float32Array(145 * 3);
  const put = (i: number, lx: number, ly: number) => {
    positions[i * 3] = lx;
    positions[i * 3 + 1] = ly;
    positions[i * 3 + 2] = heightAt(-lx, -ly);
  };
  for (let row = 0; row <= 8; ++row) {
    for (let col = 0; col <= 8; ++col) {
      put(row * ROW_STRIDE + col, -row * CELL, -col * CELL);
    }
    if (row < 8) {
      for (let col = 0; col < 8; ++col) {
        put(9 + row * ROW_STRIDE + col, -(row + 0.5) * CELL, -(col + 0.5) * CELL);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return {
    geometry,
    // THE MIRROR IS LOAD-BEARING, and an identity matrix here made the first version of this test gather
    // NOTHING -- which looked exactly like a broken projector. `gatherChunk` maps the query box into chunk
    // LOCAL space and indexes cells off `-local.x / CELL`, so a chunk's own vertices run 0 -> -33.33 and its
    // placement matrix flips them back into increasing world coordinates. This is that flip.
    // `offset` TRANSLATES the chunk into real Azeroth magnitudes, which the float32 test below needs:
    // the mirror alone leaves this chunk at world 0..33, where the precision defect cannot appear at
    // all. Composed as `T * S` so the mirror still runs first and the gather's local indexing is
    // unchanged; with `heightAt = x`, the resulting world plane is `z = x - offset`.
    matrixWorld: new THREE.Matrix4()
      .makeTranslation(offset, offset, 0)
      .multiply(new THREE.Matrix4().makeScale(-1, -1, 1)),
    isHole: () => false,
  };
}

function frameAt(centre: THREE.Vector3, radius: number): DecalFrame {
  return {
    centre,
    sin: 0,
    cos: 1,
    minX: -radius,
    maxX: radius,
    minY: -radius,
    maxY: radius,
    minZ: -2 * radius,
    maxZ: 2 * radius,
  };
}

describe('the ground selection ring', () => {
  afterEach(() => collisionWorld.clear());

  /**
   * **THE FLICKER FIX: the emit is measured from an ORIGIN, and that is what makes it precise enough
   * to be coplanar at WoW-scale coordinates.**
   *
   * The owner: "Круг есть, но декаль при неровной земле мерцает."
   *
   * The decal was already an exact sub-piece of the drawn triangle, so the flicker was never fitting
   * and never a missing bias (the ring has carried `polygonOffset` since it was written). It was the
   * reference's decision 0781: absolute world coordinates in a `Float32Array` reach the terrain's
   * plane through different arithmetic than the terrain's own chunk-local vertices plus a
   * CPU-composed matrix, and "misses by more than the bias at WoW-scale coordinates".
   *
   * Two things are asserted and the SECOND is the one that matters. That the world positions are
   * recovered exactly is correctness. That the STORED numbers are small is the fix: a float32 holding
   * a real WoW coordinate resolves to about a millimetre, and holding a few yards resolves to
   * fractions of a micron -- which is finer than the terrain's own rounding, so the residual the
   * `polygonOffset` must settle is now the receiver's rather than ours.
   *
   * The coordinates here are deliberately a REAL Azeroth magnitude rather than the tidy 6 the ramp
   * test uses, because at 6 the defect does not exist: float32 holds small numbers precisely and the
   * bug only appears once the exponent grows.
   */
  it('measures the emit from an origin, so stored coordinates stay small at WoW-scale', () => {
    // A real Azeroth magnitude: the chunk is translated out to 8900, so every coordinate the
    // projector handles has the exponent a live world coordinate has. At the origin-adjacent 6 the
    // other test uses, float32 holds the numbers precisely and the defect cannot appear.
    const OFFSET = 8900;
    collisionWorld.terrain.add(rampChunk((x) => x, OFFSET));

    const radius = 1.5;
    // On the ramp's own world plane, `z = x - OFFSET` -- so the receiver is a genuine slope, which is
    // the only case that flickers.
    const centre = new THREE.Vector3(OFFSET + 6, OFFSET + 6, 6);
    const frame = frameAt(centre, radius);
    const mesh = decalMesh(4096);
    const origin = centre.clone();

    expect(projectDecal(mesh, frame, () => 1, (x, y) => rectUv(frame, x, y), origin)).toBe(true);
    expect(mesh.count).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < mesh.count; ++i) {
      // THE FIX: every stored component is a small offset, never a world coordinate. `radius` bounds
      // x and y; z is bounded by the frame's vertical slab.
      expect(Math.abs(mesh.positions[i * 3])).toBeLessThanOrEqual(radius + 1e-3);
      expect(Math.abs(mesh.positions[i * 3 + 1])).toBeLessThanOrEqual(radius + 1e-3);
      expect(Math.abs(mesh.positions[i * 3 + 2])).toBeLessThanOrEqual(frame.maxZ + 1e-3);

      // And adding the origin back reproduces a point on the ramp -- so the mesh, drawn at
      // `position = origin`, lands exactly where the absolute emit used to.
      const x = mesh.positions[i * 3] + origin.x;
      const z = mesh.positions[i * 3 + 2] + origin.z;
      expect(Math.abs(z - (x - OFFSET))).toBeLessThan(0.05);
    }
  });

  /**
   * A 45-degree ramp (`z = x`, so a 1-yd step across is a 1-yd rise). Over a 1.5-yd ring that is a 3-yd
   * height range: a flat quad at the feet would be up to 1.5 yd inside the hill on one side and 1.5 yd in
   * the air on the other, which is exactly the defect that stopped round 20 from shipping one.
   *
   * The assertion is per vertex against the ramp's own plane, so it tests the whole chain -- gather, clip,
   * interpolation -- and not just the total spread.
   */
  it('emits vertices on the ground plane over a 45-degree ramp, spanning its whole height range', () => {
    collisionWorld.terrain.add(rampChunk((x) => x));

    const radius = 1.5;
    const centre = new THREE.Vector3(6, 6, 6);
    const frame = frameAt(centre, radius);
    const mesh = decalMesh(4096);
    const projected = projectDecal(
      mesh,
      frame,
      () => 1,
      (x, y) => rectUv(frame, x, y),
    );

    expect(projected).toBe(true);
    expect(mesh.count).toBeGreaterThanOrEqual(3);

    let lo = Infinity;
    let hi = -Infinity;
    let worstResidual = 0;
    for (let i = 0; i < mesh.count; ++i) {
      const x = mesh.positions[i * 3];
      const z = mesh.positions[i * 3 + 2];
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
      worstResidual = Math.max(worstResidual, Math.abs(z - x));
      // Never outside the ring's own texture square, or the texture would wrap a ghost copy in.
      expect(Math.abs(x - centre.x)).toBeLessThanOrEqual(radius + 1e-4);
    }
    // The plane is exact: the clip interpolates full 3D positions along a cut edge.
    expect(worstResidual).toBeLessThan(1e-3);
    // And the ring really did drape the slope rather than sit at one height.
    expect(hi - lo).toBeGreaterThan(2 * radius * 0.95);
  });

  /**
   * The selector's branch ORDER, which is the half a duplicated palette gets wrong: a player is decided
   * before the health check, so a dead friendly player keeps its blue and never grays, while a neutral
   * NPC is the yellow the owner's reference crop shows.
   */
  it('colours a neutral NPC yellow and never grays a dead player', () => {
    expect(selectionColor(4, false, false)).toBe(SELECTION_NEUTRAL);
    expect(selectionColor(5, true, true)).toBe(SELECTION_PLAYER);
  });
});
