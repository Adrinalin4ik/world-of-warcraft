import * as THREE from 'three';

import BSPTree from '../bsp-tree';

/**
 * A BOX ON ONE SIDE OF A SPLIT RETURNS THAT SIDE'S LEAF.
 *
 * This is the assertion that would have caught the defect it now guards: `queryBox` tested the negative
 * half-space and descended `posChild`, on every axis and therefore every internal node, so a query came
 * back with leaves from the mirror-image region of the tree. Northshire Abbey's walls were never in the
 * candidate set and the player walked through them.
 *
 * The existing `wmo-provider` tests could not catch it -- they stub `bspTree.query` to record the box
 * they were asked about, which is the right isolation for that file and leaves the real tree with no
 * coverage at all.
 *
 * BOTH SIDES AND THE STRADDLE, because a swap passes a one-sided test half the time by symmetry: the
 * negative box must return ONLY the negative leaf, the positive box ONLY the positive one, and a box
 * crossing the plane must return both. Only the pair plus the straddle pins the mapping.
 */
describe('the MOBN box query', () => {
  /** Root splits X at 0: leaf 1 owns x < 0, leaf 2 owns x > 0. `flags` 0x4 marks a leaf. */
  const tree = new BSPTree(
    [
      {
        flags: 0, negChild: 1, posChild: 2, nFaces: 0, faceStart: 0, planeDist: 0,
      },
      {
        flags: 0x4, negChild: -1, posChild: -1, nFaces: 1, faceStart: 0, planeDist: 0,
      },
      {
        flags: 0x4, negChild: -1, posChild: -1, nFaces: 1, faceStart: 1, planeDist: 0,
      },
    ] as never,
    [0, 1],
    [0, 1, 2, 3, 4, 5],
    [],
  );

  const boxFrom = (minX: number, maxX: number) => new THREE.Box3(
    new THREE.Vector3(minX, -1, -1),
    new THREE.Vector3(maxX, 1, 1),
  );

  it('answers the NEGATIVE leaf for a box on the negative side', () => {
    expect(tree.query(boxFrom(-5, -1), 0)).toEqual([1]);
  });

  it('answers the POSITIVE leaf for a box on the positive side', () => {
    expect(tree.query(boxFrom(1, 5), 0)).toEqual([2]);
  });

  it('answers both for a box crossing the plane', () => {
    expect(tree.query(boxFrom(-1, 1), 0).sort()).toEqual([1, 2]);
  });
});
