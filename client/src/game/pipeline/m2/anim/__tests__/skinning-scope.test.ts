/** @jest-environment node */
import * as THREE from 'three';

import { toEngineMatrix } from '../axes';
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { applyLocalPose } from '../pose';
import {
  chainBillboarded,
  needsSkinning,
  submeshBoneSet,
  submeshSkinningScope,
} from '../skinning-scope';
import { buildBoneHierarchy, poseBindSkeleton } from '../../bind-pose';
import Submesh from '../../submesh';

// ---------------------------------------------------------------------------------------------
// Fixtures, shaped like the real parsers.
//
// `wow-data-parser/m2/skin.js` names the vertex lookup `indices` and the face list `triangles`; a
// submesh's drawn vertices are `indices[triangles[i]]` for `i` in the `startTriangle` range, which
// is exactly what `M2#createSubmeshGeometry` dereferences. Bone indices and weights are on the M2's
// OWN vertices -- the skin does not carry them.
// ---------------------------------------------------------------------------------------------

const vertex = (boneIndices: number[], boneWeights: number[]) => ({
  position: [0, 0, 0], normal: [0, 0, 1], textureCoords: [[0, 0], [0, 0]],
  boneIndices, boneWeights,
});

const submeshDef = (over: any = {}) => ({
  partID: 0, level: 0, startVertex: 0, vertexCount: 0,
  startTriangle: 0, triangleCount: 0, rootBone: 0, ...over,
});

/**
 * `0x20` = keyframes inline in this .m2, as wolf Stand/Walk/Run really carry.
 *
 * These tests arm a sequence by hand rather than through `resolve`/`pickVariation`, so they would
 * pass with `flags: 0` too -- but `flags: 0` means EXTERNAL, and `ModelAnim` quarantines it
 * (`hasInlineData`). A fixture on that value describes a model that cannot reach these code paths.
 * `0x20` leaves bit 0 alone, so no clock law moves.
 */
const INLINE = 0x20;

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: INLINE, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const block = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});

const boneDef = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  animated: true, billboarded: false, billboardType: null,
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

describe('needsSkinning', () => {
  /**
   * Kills `boneCount > 0` / `>= 1` -- the off-by-one that would leave every single-bone submesh on
   * the skinning path and make the whole task a no-op.
   */
  it('is false for a submesh riding exactly one bone', () => {
    expect(needsSkinning(1)).toBe(false);
  });

  /** Kills `boneCount >= 0` and a hardcoded `true`. */
  it('is false for a submesh riding no bones at all', () => {
    expect(needsSkinning(0)).toBe(false);
  });

  /**
   * Kills a hardcoded `false` -- the mutation that would send a genuinely multi-bone submesh down
   * the rigid path and tear the model apart.
   */
  it('is true as soon as two bones are involved', () => {
    expect(needsSkinning(2)).toBe(true);
    expect(needsSkinning(40)).toBe(true);
  });
});

describe('submeshBoneSet', () => {
  /**
   * Kills a walk that ignores `startTriangle`/`triangleCount` and scans every vertex in the model:
   * bone 9 belongs to a triangle OUTSIDE this submesh's range and must not appear.
   *
   * Also kills dereferencing `triangles[i]` without the `indices` hop -- with this fixture that
   * lands on the wrong vertices and yields {3, 4} rather than {4}.
   */
  it('only counts the vertices the submesh actually draws', () => {
    const vertices = [
      vertex([9, 0, 0, 0], [255, 0, 0, 0]),
      vertex([9, 0, 0, 0], [255, 0, 0, 0]),
      vertex([9, 0, 0, 0], [255, 0, 0, 0]),
      vertex([4, 0, 0, 0], [255, 0, 0, 0]),
      vertex([4, 0, 0, 0], [255, 0, 0, 0]),
      vertex([4, 0, 0, 0], [255, 0, 0, 0]),
    ];
    // indices[j] -> m2 vertex; deliberately NOT the identity, so a missing hop is visible.
    const indices = [3, 4, 5, 0, 1, 2];
    const triangles = [0, 1, 2, 3, 4, 5];

    const bones = submeshBoneSet(
      submeshDef({ startTriangle: 0, triangleCount: 3 }),
      { indices, triangles },
      vertices,
    );

    expect(Array.from(bones).sort()).toEqual([4]);
  });

  /** Kills dropping the `boneWeights[b] > 0` test -- slots 1..3 are padding, not bones. */
  it('ignores bone slots with zero weight', () => {
    const vertices = [
      vertex([7, 11, 12, 13], [255, 0, 0, 0]),
      vertex([7, 11, 12, 13], [255, 0, 0, 0]),
      vertex([7, 11, 12, 13], [255, 0, 0, 0]),
    ];

    const bones = submeshBoneSet(
      submeshDef({ startTriangle: 0, triangleCount: 3 }),
      { indices: [0, 1, 2], triangles: [0, 1, 2] },
      vertices,
    );

    expect(Array.from(bones)).toEqual([7]);
  });

  /**
   * Kills deleting the all-zero-weight fallback.
   *
   * `bind-pose.ts#normalizeBoneWeights` maps such a vertex to `[1, 0, 0, 0]`, so the SKINNED path
   * rides bone 2 for it. Without the fallback this set would be {5}, the submesh would be declared
   * rigid under bone 5, and the unweighted triangle would detach and follow the wrong bone.
   */
  it('counts an all-zero-weight vertex against its first bone slot, as normalizeBoneWeights does', () => {
    const vertices = [
      vertex([2, 0, 0, 0], [0, 0, 0, 0]),
      vertex([2, 0, 0, 0], [0, 0, 0, 0]),
      vertex([2, 0, 0, 0], [0, 0, 0, 0]),
      vertex([5, 0, 0, 0], [255, 0, 0, 0]),
      vertex([5, 0, 0, 0], [255, 0, 0, 0]),
      vertex([5, 0, 0, 0], [255, 0, 0, 0]),
    ];

    const bones = submeshBoneSet(
      submeshDef({ startTriangle: 0, triangleCount: 6 }),
      { indices: [0, 1, 2, 3, 4, 5], triangles: [0, 1, 2, 3, 4, 5] },
      vertices,
    );

    expect(Array.from(bones).sort()).toEqual([2, 5]);
  });

  /** Kills a partial-weight walk that stops at slot 0. */
  it('collects every partially weighted bone', () => {
    const vertices = [
      vertex([1, 6, 0, 0], [128, 127, 0, 0]),
      vertex([1, 6, 0, 0], [128, 127, 0, 0]),
      vertex([1, 6, 0, 0], [128, 127, 0, 0]),
    ];

    const bones = submeshBoneSet(
      submeshDef({ startTriangle: 0, triangleCount: 3 }),
      { indices: [0, 1, 2], triangles: [0, 1, 2] },
      vertices,
    );

    expect(Array.from(bones).sort()).toEqual([1, 6]);
  });
});

describe('chainBillboarded', () => {
  const defs = [
    boneDef({ parentID: -1, billboarded: true, billboardType: 0 }),
    boneDef({ parentID: 0 }),
    boneDef({ parentID: -1 }),
  ];

  it('reports a bone that is itself billboarded', () => {
    expect(chainBillboarded(defs, 0)).toBe(true);
  });

  /**
   * Kills reducing the check to `boneDefs[index].billboarded`. Billboard rotation is written onto
   * the ANCESTOR and reaches this bone through the scene graph, while `InstanceAnim.palette` --
   * which is what `applySoleBone` reads -- knows nothing about it either way.
   */
  it('reports a bone whose ancestor is billboarded', () => {
    expect(chainBillboarded(defs, 1)).toBe(true);
  });

  it('is false for a chain with no billboard in it', () => {
    expect(chainBillboarded(defs, 2)).toBe(false);
  });

  /** Kills removing the step bound: malformed data must degrade, not hang. */
  it('terminates on a parent cycle and stays on the safe side', () => {
    const cyclic = [boneDef({ parentID: 1 }), boneDef({ parentID: 0 })];
    expect(chainBillboarded(cyclic, 0)).toBe(true);
  });
});

describe('submeshSkinningScope', () => {
  const skinData = { indices: [0, 1, 2], triangles: [0, 1, 2] };
  const def = submeshDef({ startTriangle: 0, triangleCount: 3, rootBone: 0 });
  const oneBone = [
    vertex([0, 0, 0, 0], [255, 0, 0, 0]),
    vertex([0, 0, 0, 0], [255, 0, 0, 0]),
    vertex([0, 0, 0, 0], [255, 0, 0, 0]),
  ];
  const twoBones = [
    vertex([0, 1, 0, 0], [128, 127, 0, 0]),
    vertex([0, 1, 0, 0], [128, 127, 0, 0]),
    vertex([0, 1, 0, 0], [128, 127, 0, 0]),
  ];
  const bones = [boneDef(), boneDef({ parentID: 0 })];

  it('takes the sole-bone path for a rigid single-bone submesh', () => {
    expect(submeshSkinningScope(def, skinData, oneBone, bones, true))
      .toEqual({ skinned: false, soleBone: 0 });
  });

  it('keeps skinning for a submesh spanning two bones', () => {
    expect(submeshSkinningScope(def, skinData, twoBones, bones, true))
      .toEqual({ skinned: true, soleBone: -1 });
  });

  /**
   * Kills dropping the billboard guard. `M2#applyBillboards` writes `bone.rotation` and the palette
   * never sees it, so a sole-bone submesh under a billboarded bone would silently lose its facing --
   * and the doodads with the most billboards are exactly the ones this optimisation targets.
   */
  it('keeps skinning when the sole bone is billboarded', () => {
    const billboarded = [boneDef({ billboarded: true, billboardType: 0 })];
    expect(submeshSkinningScope(def, skinData, oneBone, billboarded, true))
      .toEqual({ skinned: true, soleBone: -1 });
  });

  /**
   * Kills dropping the `modelUsesSkinning` guard, which is what keeps this change from WIDENING the
   * affected population: a model with no animated bone has no palette to read from, so handing its
   * submeshes a sole-bone index would freeze them at whatever `applySoleBone` last wrote (nothing).
   */
  it('leaves an unanimated model entirely alone', () => {
    expect(submeshSkinningScope(def, skinData, oneBone, bones, false))
      .toEqual({ skinned: false, soleBone: -1 });
  });

  /** A submesh that draws nothing rides nothing; it must not claim bone 0. */
  it('claims no sole bone for an empty submesh', () => {
    expect(submeshSkinningScope(
      submeshDef({ startTriangle: 0, triangleCount: 0 }), skinData, oneBone, bones, true,
    )).toEqual({ skinned: false, soleBone: -1 });
  });
});

/**
 * THE correctness question at the centre of this task.
 *
 * A single-bone submesh gets its bone's transform as its own local matrix instead of being skinned.
 * That is equivalent iff that matrix equals `P_i . B_i^-1` -- the posed model-space matrix times the
 * BIND-pose inverse, which `poseBindSkeleton` derives and which is emphatically not identity. That
 * quantity is exactly what three writes into `skeleton.boneMatrices[i]`.
 *
 * So this pins `Submesh#applySoleBone`'s output against three's OWN palette, produced by the real
 * production path (`buildBoneHierarchy` -> `poseBindSkeleton` -> `applyLocalPose` ->
 * `updateMatrixWorld` -> `Skeleton#update`), rather than against restated arithmetic. It kills, in
 * one assertion: dropping the `D` conjugation, using the wrong bone offset, reading `localTRS`
 * instead of `palette`, and any drift between the two paths' handling of the bind inverse.
 */
describe('applySoleBone reproduces three\'s own palette entry', () => {
  function paletteAndBoneMatrices(defs: any[], worldClockMs: number) {
    const model = new ModelAnim({ animations: [animation()], sequences: [], bones: defs });
    const inst = new InstanceAnim(model);
    inst.arm(model.sequences[0], 0);
    inst.solveBones(worldClockMs);

    const { bones, rootBones, bindPositions } = buildBoneHierarchy(defs);
    const skeleton = poseBindSkeleton(rootBones, bones);
    applyLocalPose(bones, bindPositions, inst.localTRS);
    rootBones.forEach((b) => b.updateMatrixWorld(true));
    skeleton.update();

    return { palette: inst.palette, boneMatrices: skeleton.boneMatrices };
  }

  function expectSoleBoneMatchesPalette(defs: any[], worldClockMs: number, index: number) {
    const { palette, boneMatrices } = paletteAndBoneMatrices(defs, worldClockMs);

    const submesh: any = new Submesh({
      matrixAutoUpdate: false,
      useSkinning: false,
      soleBoneIndex: index,
      geometry: new THREE.BufferGeometry(),
    });
    submesh.applySoleBone(palette);

    for (let k = 0; k < 16; ++k) {
      expect(submesh.matrix.elements[k]).toBeCloseTo(boneMatrices[index * 16 + k], 6);
    }
  }

  /**
   * A non-zero pivot with no animation. The bind inverse and the pivot pair must cancel to EXACTLY
   * identity -- if `applySoleBone` were to leave the bind offset in, this submesh would jump to the
   * bone's pivot on the first posed frame.
   */
  it('is identity at rest, however far the bone sits from the origin', () => {
    expectSoleBoneMatchesPalette([boneDef({ pivotPoint: [3, -4, 5] })], 0, 0);
  });

  /**
   * Sampled at 500, NOT at 1000. the fixture loops (bit 0 clear) -> WRAP, and `cursorMs(WRAP, 1000, 1000)` is 0 --
   * sampling at the period would silently take the FIRST key and re-assert the at-rest case above.
   */
  it('matches for a translated bone with a non-zero pivot', () => {
    expectSoleBoneMatchesPalette([boneDef({
      pivotPoint: [3, -4, 5],
      translation: block([[0, 0, 0], [10, 20, 30]]),
    })], 500, 0);
  });

  /**
   * Deliberately OFF-AXIS. A rotation purely about Z is invariant under `D` (which IS a Z rotation),
   * so a `[0, 0, s, c]` fixture passes whether or not the conjugation happens at all -- verified in
   * `pose.test.ts` by mutation. This one does not.
   */
  it('matches for an off-axis rotation, which is where a missing conjugation shows', () => {
    const key = [0.4, -0.2, 0.5, Math.sqrt(0.55)];
    expectSoleBoneMatchesPalette([boneDef({
      pivotPoint: [2, 7, -1],
      rotation: block([key, key]),
    })], 250, 0);
  });

  /**
   * The discriminating case: a child bone under a rotated parent. This is the real shape of a
   * single-bone submesh on a doodad -- a sign panel hanging off a swinging arm -- and it is where a
   * wrong bone offset, a wrong parent composition or a wrong conjugation each produce a different
   * matrix while every single-bone fixture above stays green.
   */
  it('matches for a child bone under a rotated parent', () => {
    const q = new THREE.Quaternion(0.3, 0.1, Math.SQRT1_2, Math.SQRT1_2).normalize();
    const key = [q.x, q.y, q.z, q.w];
    const defs = [
      boneDef({ pivotPoint: [1, 2, 3], rotation: block([key, key]) }),
      boneDef({ parentID: 0, pivotPoint: [-4, 6, 2], translation: block([[1, 2, 3], [5, -6, 7]]) }),
    ];

    expectSoleBoneMatchesPalette(defs, 400, 1);
    expectSoleBoneMatchesPalette(defs, 400, 0);
  });

  /**
   * Asymmetric scale (2, 1.5, 2.5 at t=500), so a swap of any two components fails rather than
   * cancelling -- and so the decompose in `applySoleBone` cannot quietly drop it.
   */
  it('matches for a non-uniformly scaled bone about a non-zero pivot', () => {
    expectSoleBoneMatchesPalette([boneDef({
      pivotPoint: [5, -5, 2],
      scaling: block([[1, 1, 1], [3, 2, 4]]),
    })], 500, 0);
  });

  /** Kills a guard inverted to `soleBoneIndex >= 0`, which would corrupt every static submesh. */
  it('does nothing at all when there is no sole bone', () => {
    const submesh: any = new Submesh({
      matrixAutoUpdate: false,
      useSkinning: false,
      soleBoneIndex: -1,
      geometry: new THREE.BufferGeometry(),
    });
    const before = submesh.matrix.clone();

    submesh.applySoleBone(new Float32Array(16));

    expect(submesh.matrix.equals(before)).toBe(true);
  });

  /** Defaults to "no sole bone" so every existing construction site is unaffected. */
  it('defaults soleBoneIndex to -1', () => {
    const submesh: any = new Submesh({
      matrixAutoUpdate: false, useSkinning: false, geometry: new THREE.BufferGeometry(),
    });
    expect(submesh.soleBoneIndex).toBe(-1);
  });
});

describe('toEngineMatrix', () => {
  /**
   * Kills a verbatim copy. `D M D` flips the sign of the two off-diagonal blocks, and the X/Y
   * translation (elements 12 and 13) is in one of them -- which is the whole visible symptom: a
   * mirrored swing.
   */
  it('conjugates by D = diag(-1, -1, 1)', () => {
    const source = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 2, 3),
      new THREE.Quaternion(0.4, -0.2, 0.5, Math.sqrt(0.55)),
      new THREE.Vector3(1, 1, 1),
    );

    const D = new THREE.Matrix4().makeScale(-1, -1, 1);
    const expected = new THREE.Matrix4().multiplyMatrices(D, source).multiply(D);

    const packed = new Float32Array(32);
    source.toArray(packed, 16);

    const out = toEngineMatrix(new THREE.Matrix4(), packed, 16);

    for (let k = 0; k < 16; ++k) {
      expect(out.elements[k]).toBeCloseTo(expected.elements[k], 6);
    }
    // The signature the symptom hides behind: X/Y translation mirrored, Z untouched.
    expect(out.elements[12]).toBeCloseTo(-1, 6);
    expect(out.elements[13]).toBeCloseTo(-2, 6);
    expect(out.elements[14]).toBeCloseTo(3, 6);
  });

  /** Kills ignoring `offset` -- the `boneIndex * 16` hop into a shared palette buffer. */
  it('reads the entry at the given offset', () => {
    const packed = new Float32Array(32);
    new THREE.Matrix4().identity().toArray(packed, 0);
    new THREE.Matrix4().makeTranslation(4, 5, 6).toArray(packed, 16);

    const out = toEngineMatrix(new THREE.Matrix4(), packed, 16);

    expect(out.elements[12]).toBeCloseTo(-4, 6);
    expect(out.elements[13]).toBeCloseTo(-5, 6);
    expect(out.elements[14]).toBeCloseTo(6, 6);
  });

  /** Allocation-free: writes through the destination's existing element array. */
  it('writes through the destination rather than replacing its elements', () => {
    const out = new THREE.Matrix4();
    const elements = out.elements;

    toEngineMatrix(out, new Float32Array(16), 0);

    expect(out.elements).toBe(elements);
  });
});
