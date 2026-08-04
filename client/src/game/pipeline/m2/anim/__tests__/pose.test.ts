/** @jest-environment node */
import * as THREE from 'three';
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { applyLocalPose } from '../pose';
import { poseBindSkeleton } from '../../bind-pose';

/**
 * The mirror the M2 pipeline bakes into geometry and bone pivots -- 180 degrees about Z, not a
 * reflection. See `axes.ts`.
 */
const D = new THREE.Matrix4().makeScale(-1, -1, 1);

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const block = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});

const boneDef = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0], billboardType: null,
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

/**
 * Build the bone hierarchy and bind offsets exactly as `M2#createSkeleton` does.
 *
 * Reproduced rather than called: `M2`'s constructor pulls in `collisionWorld` and `ObjectsManager`
 * and cannot be instantiated under jest. Only the parts under test are duplicated -- the pivot
 * mirror `(-p0, -p1, p2)`, the telescoping parent subtraction, and the billboard flag -- so a change
 * to any of those in `createSkeleton` would make this fixture diverge, which is the intended
 * tripwire.
 */
function buildSkeleton(boneDefs: any[]) {
  const bones: THREE.Bone[] = [];
  const rootBones: THREE.Bone[] = [];

  for (let i = 0; i < boneDefs.length; ++i) {
    const def = boneDefs[i];
    const bone = new THREE.Bone();
    bones.push(bone);

    const p = def.pivotPoint;
    bone.position.set(-p[0], -p[1], p[2]);

    if (def.parentID > -1) {
      bones[def.parentID].add(bone);
      let up: any = bone;
      while ((up = up.parent)) {
        bone.position.sub(up.position);
      }
    } else {
      rootBones.push(bone);
    }

    if (def.billboardType !== null) {
      bone.userData.billboarded = true;
      bone.userData.billboardType = def.billboardType;
    }
  }

  const bind = new Float32Array(bones.length * 3);
  for (let i = 0; i < bones.length; ++i) {
    bind[i * 3] = bones[i].position.x;
    bind[i * 3 + 1] = bones[i].position.y;
    bind[i * 3 + 2] = bones[i].position.z;
  }

  const skeleton = poseBindSkeleton(rootBones, bones);

  return { bones, rootBones, bind, skeleton };
}

/**
 * Do exactly what a real frame does, in order: solve, apply, walk the graph, let three build the
 * palette. Returns three's palette entry for `index`.
 */
function renderedPalette(boneDefs: any[], worldClockMs: number, index: number): THREE.Matrix4 {
  const model = new ModelAnim({ animations: [animation()], sequences: [], bones: boneDefs });
  const inst = new InstanceAnim(model);
  inst.arm(model.sequences[0], 0);
  inst.solveBones(worldClockMs);

  const { bones, rootBones, bind, skeleton } = buildSkeleton(boneDefs);
  applyLocalPose(bones, bind, inst.localTRS);

  // `World#updateDynamicMatrices` forces this walk; `WebGLObjects.update` then calls update().
  rootBones.forEach((b) => b.updateMatrixWorld(true));
  skeleton.update();

  return new THREE.Matrix4().fromArray(skeleton.boneMatrices, index * 16);
}

/** `D . palette_i . D` -- what three's palette must equal if the conjugation is right. */
function expectedPalette(boneDefs: any[], worldClockMs: number, index: number): THREE.Matrix4 {
  const model = new ModelAnim({ animations: [animation()], sequences: [], bones: boneDefs });
  const inst = new InstanceAnim(model);
  inst.arm(model.sequences[0], 0);
  inst.solveBones(worldClockMs);

  const raw = new THREE.Matrix4().fromArray(inst.palette, index * 16);
  return new THREE.Matrix4().multiplyMatrices(D, raw).multiply(D);
}

function expectMatricesClose(actual: THREE.Matrix4, expected: THREE.Matrix4) {
  for (let i = 0; i < 16; ++i) {
    expect(actual.elements[i]).toBeCloseTo(expected.elements[i], 6);
  }
}

/**
 * THE load-bearing invariant of Task 13.
 *
 * `applyLocalPose` writes per-bone LOCAL transforms and lets the scene graph accumulate them, on the
 * argument that the M2 bone law `parent . T(p) . TRS . T(-p)` reduces per bone to
 * `T(p_i - p_parent) . TRS`. If that reduction is wrong, or the pivot pair fails to cancel, or the
 * `D` conjugation has a sign out of place, the model still animates -- plausibly -- in the wrong
 * direction. That is precisely the failure a human can barely see, so it is pinned here against
 * three's own palette rather than against restated arithmetic.
 */
describe('applyLocalPose drives three to D . palette . D', () => {
  it('holds bind pose for an unanimated bone', () => {
    const defs = [boneDef({ pivotPoint: [3, -4, 5] })];
    expectMatricesClose(renderedPalette(defs, 0, 0), new THREE.Matrix4());
  });

  it('matches for a translated bone with a non-zero pivot', () => {
    const defs = [boneDef({
      pivotPoint: [3, -4, 5],
      translation: block([[0, 0, 0], [10, 20, 30]]),
    })];
    expectMatricesClose(renderedPalette(defs, 500, 0), expectedPalette(defs, 500, 0));
  });

  /**
   * The rotation here is deliberately OFF-AXIS. A rotation purely about Z is invariant under the
   * conjugation -- `D` IS a Z rotation, so it commutes with one -- and a fixture using one passes
   * whether or not `toEngineQuaternion` flips anything at all. Verified by mutation: dropping the
   * sign flips leaves a `[0, 0, s, c]` fixture green.
   */
  it('matches for a rotated bone with a non-zero pivot', () => {
    const defs = [boneDef({
      pivotPoint: [2, 7, -1],
      rotation: block([[0.4, -0.2, 0.5, Math.sqrt(0.55)], [0.4, -0.2, 0.5, Math.sqrt(0.55)]]),
    })];
    expectMatricesClose(renderedPalette(defs, 250, 0), expectedPalette(defs, 250, 0));
  });

  /**
   * The case that discriminates. A parent/child chain with distinct non-zero pivots and a rotation
   * on the parent: a wrong conjugation, a wrong pivot cancellation and a wrong parent order all
   * produce a different matrix here, and none of them do on a single translated bone.
   */
  it('matches for a rotated parent with a pivoted child', () => {
    const half = Math.SQRT1_2;
    const defs = [
      boneDef({
        pivotPoint: [1, 2, 3],
        rotation: block([[0.3, 0.1, half, half], [0.3, 0.1, half, half]]),
      }),
      boneDef({
        parentID: 0,
        pivotPoint: [-4, 6, 2],
        translation: block([[1, 2, 3], [5, -6, 7]]),
      }),
    ];

    expectMatricesClose(renderedPalette(defs, 400, 0), expectedPalette(defs, 400, 0));
    expectMatricesClose(renderedPalette(defs, 400, 1), expectedPalette(defs, 400, 1));
  });

  it('matches for a scaled bone about a non-zero pivot', () => {
    const defs = [boneDef({
      pivotPoint: [5, -5, 2],
      scaling: block([[1, 1, 1], [3, 2, 4]]),
    })];
    expectMatricesClose(renderedPalette(defs, 1000, 0), expectedPalette(defs, 1000, 0));
  });

  it('matches through a three-deep chain', () => {
    const defs = [
      boneDef({ pivotPoint: [1, 0, 0], translation: block([[0, 0, 0], [2, 0, 1]]) }),
      boneDef({ parentID: 0, pivotPoint: [1, 3, 0], rotation: block([[0, 0.5, 0, Math.sqrt(0.75)], [0, 0.5, 0, Math.sqrt(0.75)]]) }),
      boneDef({ parentID: 1, pivotPoint: [1, 3, 4], translation: block([[0, 0, 0], [0, -3, 0]]) }),
    ];
    for (let i = 0; i < 3; ++i) {
      expectMatricesClose(renderedPalette(defs, 750, i), expectedPalette(defs, 750, i));
    }
  });
});

describe('applyLocalPose and billboarded bones', () => {
  it('leaves a billboarded bone\'s rotation to applyBillboards', () => {
    const defs = [boneDef({
      billboardType: 0,
      pivotPoint: [1, 1, 1],
      rotation: block([[0, 0, Math.SQRT1_2, Math.SQRT1_2], [0, 0, Math.SQRT1_2, Math.SQRT1_2]]),
    })];

    const model = new ModelAnim({ animations: [animation()], sequences: [], bones: defs });
    const inst = new InstanceAnim(model);
    inst.arm(model.sequences[0], 0);
    inst.solveBones(500);

    const { bones, bind } = buildSkeleton(defs);
    // Stand in for applyBillboards having faced this bone at the camera.
    const facing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.234));
    bones[0].quaternion.copy(facing);

    applyLocalPose(bones, bind, inst.localTRS);

    expect(bones[0].quaternion.equals(facing)).toBe(true);
  });

  it('still applies translation and scale to a billboarded bone', () => {
    const defs = [boneDef({
      billboardType: 0,
      translation: block([[8, 0, 0], [8, 0, 0]]),
      scaling: block([[2, 2, 2], [2, 2, 2]]),
    })];

    const model = new ModelAnim({ animations: [animation()], sequences: [], bones: defs });
    const inst = new InstanceAnim(model);
    inst.arm(model.sequences[0], 0);
    inst.solveBones(0);

    const { bones, bind } = buildSkeleton(defs);
    applyLocalPose(bones, bind, inst.localTRS);

    expect(bones[0].position.x).toBeCloseTo(-8, 6);
    expect(bones[0].scale.x).toBeCloseTo(2, 6);
  });
});

describe('applyLocalPose allocation', () => {
  it('writes through the bones existing vectors rather than replacing them', () => {
    const defs = [boneDef({ translation: block([[0, 0, 0], [1, 2, 3]]) })];

    const model = new ModelAnim({ animations: [animation()], sequences: [], bones: defs });
    const inst = new InstanceAnim(model);
    inst.arm(model.sequences[0], 0);
    inst.solveBones(500);

    const { bones, bind } = buildSkeleton(defs);
    const position = bones[0].position;
    const quaternion = bones[0].quaternion;
    const scale = bones[0].scale;

    applyLocalPose(bones, bind, inst.localTRS);

    expect(bones[0].position).toBe(position);
    expect(bones[0].quaternion).toBe(quaternion);
    expect(bones[0].scale).toBe(scale);
  });
});
