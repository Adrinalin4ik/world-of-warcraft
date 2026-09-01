/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { CollisionLayer, MOPY_DETAIL, MOPY_NOCAMCOLLIDE } from '../layers';
import { Triangle } from '../types';
import { WmoProvider } from '../wmo-provider';

/**
 * A stand-in BSP with a single leaf owning every triangle. It exercises the provider's face walk
 * and layer filter without depending on real MOBN node geometry, and records the box it was queried
 * with so the model-local transform can be checked.
 */
function fakeBsp(triangleCount: number) {
  const vertices: number[] = [];
  const face: number[] = [];
  const plane: number[] = [];

  for (let t = 0; t < triangleCount; ++t) {
    const base = t * 3;
    // A flat triangle at z = t, inside x,y in [0,1].
    vertices.push(0, 0, t, 1, 0, t, 0, 1, t);
    face.push(base, base + 1, base + 2);
    plane.push(t);
  }

  return {
    nodes: [{
      flags: 0x4, negChild: -1, posChild: -1, nFaces: triangleCount, faceStart: 0, planeDist: 0,
    }],
    indices: { plane, face },
    vertices,
    queriedWith: null as THREE.Box3 | null,
    query(box: THREE.Box3) {
      this.queriedWith = box.clone();
      return box.max.x >= 0 && box.min.x <= 1 && box.max.y >= 0 && box.min.y <= 1 ? [0] : [];
    },
  };
}

function collider(flags: number[], position = new THREE.Vector3(0, 0, 0)) {
  const view = new THREE.Object3D();
  view.position.copy(position);
  view.updateMatrix();
  view.updateMatrixWorld(true);

  return { view, bspTree: fakeBsp(flags.length), triangleFlags: Uint8Array.from(flags) };
}

/**
 * The same shape as `fakeBsp` but VERTICAL: a triangle in the `x = t/10` plane, so its normal is
 * horizontal. `fakeBsp`'s faces are all flat floors, which is why the NOCAMCOLLIDE test below could not
 * tell a floor from a wall -- and that is exactly the distinction the camera rule now turns on.
 */
function fakeBspVertical(triangleCount: number) {
  const vertices: number[] = [];
  const face: number[] = [];
  const plane: number[] = [];

  for (let t = 0; t < triangleCount; ++t) {
    const base = t * 3;
    const x = t / 10;
    vertices.push(x, 0, 0, x, 1, 0, x, 0, 1);
    face.push(base, base + 1, base + 2);
    plane.push(t);
  }

  return {
    nodes: [{
      flags: 0x4, negChild: -1, posChild: -1, nFaces: triangleCount, faceStart: 0, planeDist: 0,
    }],
    indices: { plane, face },
    vertices,
    queriedWith: null as THREE.Box3 | null,
    query(box: THREE.Box3) {
      this.queriedWith = box.clone();
      return [0];
    },
  };
}

/** A collider whose faces are vertical walls rather than floors. */
function wallCollider(flags: number[]) {
  const view = new THREE.Object3D();
  view.updateMatrix();
  view.updateMatrixWorld(true);

  return { view, bspTree: fakeBspVertical(flags.length), triangleFlags: Uint8Array.from(flags) };
}

const bigBox = () => new THREE.Box3(
  new THREE.Vector3(-10, -10, -10),
  new THREE.Vector3(10, 10, 10),
);

describe('WmoProvider', () => {
  it('gathers every plain face for both audiences', () => {
    const provider = new WmoProvider();
    provider.add(collider([0, 0, 0]));

    const walk: Triangle[] = [];
    const camera: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, walk);
    provider.gather(bigBox(), CollisionLayer.Camera, camera);

    expect(walk).toHaveLength(3);
    expect(camera).toHaveLength(3);
  });

  it('drops DETAIL faces from the walk set only', () => {
    const provider = new WmoProvider();
    provider.add(collider([0, MOPY_DETAIL, 0]));

    const walk: Triangle[] = [];
    const camera: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, walk);
    provider.gather(bigBox(), CollisionLayer.Camera, camera);

    expect(walk).toHaveLength(2);
    expect(camera).toHaveLength(3);
  });

  /**
   * **THIS TEST ASSERTED THE RULE WE NOW DEVIATE FROM, and its fixture could not have caught the
   * deviation either way: `fakeBsp` builds only FLAT triangles, so every face in it is a floor.**
   *
   * The rule is now: a NOCAMCOLLIDE face still leaves the camera set UNLESS the body could stand on
   * it. See `wmo-provider.ts` for why -- the abbey floor carries the bit, and a camera under a floor
   * is a broken picture in this renderer specifically, because we draw the terrain beneath a building
   * and do not draw the underside of its floor.
   *
   * So the pair, and it has to be a pair or it asserts nothing: a NOCAMCOLLIDE FLOOR is kept for the
   * camera, a NOCAMCOLLIDE WALL is still dropped. Either assertion alone passes under both the old
   * rule and the new one.
   */
  it('keeps a NOCAMCOLLIDE FLOOR for the camera -- the body can stand on it', () => {
    const provider = new WmoProvider();
    provider.add(collider([MOPY_NOCAMCOLLIDE, 0, 0]));

    const walk: Triangle[] = [];
    const camera: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, walk);
    provider.gather(bigBox(), CollisionLayer.Camera, camera);

    expect(walk).toHaveLength(3);
    expect(camera).toHaveLength(3);
  });

  it('still drops a NOCAMCOLLIDE WALL from the camera set', () => {
    const provider = new WmoProvider();
    provider.add(wallCollider([MOPY_NOCAMCOLLIDE, 0, 0]));

    const walk: Triangle[] = [];
    const camera: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, walk);
    provider.gather(bigBox(), CollisionLayer.Camera, camera);

    expect(walk).toHaveLength(3);
    expect(camera).toHaveLength(2);
  });

  it('queries the BSP in MODEL-LOCAL space and emits in world space', () => {
    const provider = new WmoProvider();
    const placed = collider([0], new THREE.Vector3(100, 200, 300));
    provider.add(placed);

    const out: Triangle[] = [];
    provider.gather(
      new THREE.Box3(new THREE.Vector3(99, 199, 299), new THREE.Vector3(102, 202, 302)),
      CollisionLayer.Walk,
      out,
    );

    // The query box must have been brought back to the model's own frame...
    expect(placed.bspTree.queriedWith).not.toBeNull();
    expect(placed.bspTree.queriedWith!.min.x).toBeCloseTo(-1, 5);
    // ...and the triangles pushed back out to world space.
    expect(out).toHaveLength(1);
    expect(out[0].a.x).toBeCloseTo(100, 5);
    expect(out[0].a.z).toBeCloseTo(300, 5);
  });

  it('gathers nothing for a box that misses the geometry', () => {
    const provider = new WmoProvider();
    provider.add(collider([0, 0]));

    const out: Triangle[] = [];
    provider.gather(
      new THREE.Box3(new THREE.Vector3(500, 500, 500), new THREE.Vector3(501, 501, 501)),
      CollisionLayer.Walk,
      out,
    );

    expect(out).toHaveLength(0);
  });

  it('stops contributing once a placement is removed', () => {
    const provider = new WmoProvider();
    const placed = collider([0, 0]);
    provider.add(placed);
    provider.remove(placed.view);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(0);
  });

  it('emits a face once even when several leaves reference it', () => {
    // MOBR lets two leaves own the same triangle where it straddles a split plane. A doubled face
    // is a doubled contact in the slide.
    const provider = new WmoProvider();
    const placed = collider([0, 0]);
    placed.bspTree.nodes = [
      { flags: 0x4, negChild: -1, posChild: -1, nFaces: 2, faceStart: 0, planeDist: 0 },
      { flags: 0x4, negChild: -1, posChild: -1, nFaces: 2, faceStart: 0, planeDist: 0 },
    ];
    placed.bspTree.query = () => [0, 1];
    provider.add(placed);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(2);
  });

  it('does not carry the dedup set between separate gathers', () => {
    const provider = new WmoProvider();
    provider.add(collider([0, 0]));

    const first: Triangle[] = [];
    const second: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, first);
    provider.gather(bigBox(), CollisionLayer.Walk, second);

    expect(second).toHaveLength(first.length);
  });

  it('dedups per placement, not across them', () => {
    // Two buildings both have a triangle 0. Sharing one seen-set across placements would silently
    // delete the second building's geometry.
    const provider = new WmoProvider();
    provider.add(collider([0, 0]));
    provider.add(collider([0, 0], new THREE.Vector3(0.1, 0, 0)));

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(4);
  });

  it('treats a group with no flags array as all-collidable rather than skipping it', () => {
    // A WMO loaded before the MOPY plumbing, or from a stale cache, must still collide -- otherwise
    // the building silently becomes walk-through.
    const provider = new WmoProvider();
    const placed: any = collider([0, 0]);
    placed.triangleFlags = undefined;
    provider.add(placed);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(2);
  });

  it('keeps genuine ceilings and overhangs pointing down', () => {
    // Unlike terrain, a WMO normal must NOT be forced up: buildings have ceilings, and the
    // steep-wall rule reads a negative normal.z to leave overhangs alone.
    const provider = new WmoProvider();
    const placed = collider([0]);
    // Wind the single triangle so its face normal points down.
    placed.bspTree.vertices = [0, 0, 0, 0, 1, 0, 1, 0, 0];
    provider.add(placed);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(1);
    expect(out[0].normal.z).toBeLessThan(0);
  });
});

describe('WmoProvider placement cache', () => {
  // There is one collider per PLACEMENT now, not one per file, so a city puts hundreds in the registry
  // and every cast walks all of them -- several casts per frame. The cache turns the per-collider cost
  // from "inverse matrix + transformed box + BSP descent" into one world-space box overlap.
  it('rejects a distant placement without ever querying its BSP', () => {
    const provider = new WmoProvider();
    const far = collider([0], new THREE.Vector3(500, 500, 500));
    provider.add(far);

    provider.gather(bigBox(), CollisionLayer.Walk, []);

    expect(far.bspTree.queriedWith).toBeNull();
  });

  it('still queries a placement the box reaches', () => {
    const provider = new WmoProvider();
    const near = collider([0]);
    provider.add(near);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(near.bspTree.queriedWith).not.toBeNull();
    expect(out).toHaveLength(1);
  });

  it('follows a placement that MOVES, rather than freezing at the old spot', () => {
    // The cache is keyed on the matrix itself, not a dirty flag. A stale cache here would leave a
    // building's collision behind where it used to stand.
    const provider = new WmoProvider();
    const c = collider([0]);
    provider.add(c);

    const atOrigin: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, atOrigin);
    expect(atOrigin).toHaveLength(1);

    c.view.position.set(500, 500, 500);
    c.view.updateMatrix();
    c.view.updateMatrixWorld(true);

    const afterMove: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, afterMove);

    expect(afterMove).toHaveLength(0);

    const atNewPlace: Triangle[] = [];
    provider.gather(new THREE.Box3(
      new THREE.Vector3(490, 490, 490), new THREE.Vector3(510, 510, 510),
    ), CollisionLayer.Walk, atNewPlace);

    expect(atNewPlace).toHaveLength(1);
  });

  it('keeps a separate cache per placement of the same building', () => {
    // Two placements share geometry and a BSP; only their transforms differ. One shared cache would
    // give them both whichever box was computed last -- the same class of aliasing that made two
    // placements report byte-identical world bounds and left one building missing.
    const provider = new WmoProvider();
    const near = collider([0]);
    const far = collider([0], new THREE.Vector3(500, 0, 0));
    provider.add(near);
    provider.add(far);

    const out: Triangle[] = [];
    provider.gather(bigBox(), CollisionLayer.Walk, out);

    expect(out).toHaveLength(1);
    expect(far.bspTree.queriedWith).toBeNull();
    expect(near.bspTree.queriedWith).not.toBeNull();
  });

  it('gathers nothing and does not throw for a BSP with no vertices', () => {
    const provider = new WmoProvider();
    const c = collider([0]);
    c.bspTree.vertices = [];
    provider.add(c);

    const out: Triangle[] = [];
    expect(() => provider.gather(bigBox(), CollisionLayer.Walk, out)).not.toThrow();
    expect(out).toHaveLength(0);
  });
});
