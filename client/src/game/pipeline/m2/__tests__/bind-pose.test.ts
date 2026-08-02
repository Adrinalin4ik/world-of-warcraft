/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { modelSpaceBindMatrix, poseBindSkeleton } from '../bind-pose';

/**
 * A two-bone chain with real pivots, built exactly the way `M2#createSkeleton` builds one: local
 * positions assigned, child parented to root, and nothing updated.
 */
function chain() {
  const root = new THREE.Bone();
  root.position.set(0, 0, 1.2);

  const child = new THREE.Bone();
  child.position.set(0, 0, 0.8);
  root.add(child);

  return { rootBones: [root], bones: [root, child] };
}

describe('poseBindSkeleton', () => {
  it('derives real bone inverses instead of identities', () => {
    const { rootBones, bones } = chain();
    const skeleton = poseBindSkeleton(rootBones, bones);

    const identity = new THREE.Matrix4();
    for (const inverse of skeleton.boneInverses) {
      expect(inverse.equals(identity)).toBe(false);
    }
  });

  it('takes the inverses in MODEL space, so they undo the bind pose', () => {
    const { rootBones, bones } = chain();
    const skeleton = poseBindSkeleton(rootBones, bones);

    // inverse * bindPose == identity, for every bone.
    for (let i = 0; i < bones.length; ++i) {
      const product = new THREE.Matrix4()
        .multiplyMatrices(skeleton.boneInverses[i], bones[i].matrixWorld);
      expect(product.equals(new THREE.Matrix4())).toBe(true);
    }
  });

  it('accumulates a child bone bind pose through its parent', () => {
    const { rootBones, bones } = chain();
    poseBindSkeleton(rootBones, bones);

    const childWorld = new THREE.Vector3().setFromMatrixPosition(bones[1].matrixWorld);
    expect(childWorld.z).toBeCloseTo(2.0, 6); // 1.2 + 0.8
  });

  it('leaves the palette a delta from bind pose, NOT the bone world matrix', () => {
    // This is the property whose absence made the body invisible: with identity inverses the
    // palette carries the full world transform, the skinned bounding sphere is computed around the
    // world position while being treated as a local bound, and the frustum test doubles it.
    const { rootBones, bones } = chain();
    const skeleton = poseBindSkeleton(rootBones, bones);

    // Move the whole rig out into the world, as the scene graph does every frame.
    const holder = new THREE.Object3D();
    holder.position.set(-10353, 340, 62);
    holder.add(rootBones[0]);
    holder.updateMatrixWorld(true);

    skeleton.update();

    // At rest -- posed exactly as bound -- every palette entry is the pure world offset of the rig,
    // never the world position compounded with the bind pose.
    const entry = new THREE.Matrix4().fromArray(skeleton.boneMatrices, 0);
    const offset = new THREE.Vector3().setFromMatrixPosition(entry);
    expect(offset.x).toBeCloseTo(-10353, 3);
    expect(offset.y).toBeCloseTo(340, 3);
  });

  it('keeps a skinned bounding sphere near the model, not out at twice the world position', () => {
    // The cull, reproduced end to end. With identity inverses this sphere lands ~2x the world
    // position away and three drops the mesh before it can draw.
    const { rootBones, bones } = chain();
    const skeleton = poseBindSkeleton(rootBones, bones);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1.2, 0.2, 0, 1.6, -0.2, 0, 2.0,
    ]), 3));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array([
      0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]), 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ]), 4));

    const mesh = new THREE.SkinnedMesh(geometry);
    rootBones.forEach((bone) => mesh.add(bone));
    mesh.bind(skeleton, modelSpaceBindMatrix());

    const holder = new THREE.Object3D();
    holder.position.set(-10353, 340, 62);
    holder.add(mesh);
    holder.updateMatrixWorld(true);
    skeleton.update();

    mesh.computeBoundingSphere();

    // The sphere is a LOCAL bound, so it must stay near the model origin. The frustum test adds
    // matrixWorld itself.
    expect(mesh.boundingSphere!.center.length()).toBeLessThan(10);
  });
});

describe('modelSpaceBindMatrix', () => {
  it('is identity, because geometry and bind pose share model space', () => {
    expect(modelSpaceBindMatrix().equals(new THREE.Matrix4())).toBe(true);
  });

  it('stops bind() from recomputing the inverses it was given', () => {
    // `bind(skeleton)` with no matrix re-runs calculateInverses() as a side effect. The M2 pipeline
    // rebinds on every applyBatches -- which runs again when display-info textures resolve -- so
    // without an explicit matrix the bind pose is recomputed long after it is gone.
    const { rootBones, bones } = chain();
    const skeleton = poseBindSkeleton(rootBones, bones);
    const before = skeleton.boneInverses.map((m) => m.clone());

    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
    const holder = new THREE.Object3D();
    holder.position.set(-10353, 340, 62);
    holder.add(mesh);
    rootBones.forEach((bone) => mesh.add(bone));
    holder.updateMatrixWorld(true);

    mesh.bind(skeleton, modelSpaceBindMatrix());

    skeleton.boneInverses.forEach((inverse, i) => {
      expect(inverse.equals(before[i])).toBe(true);
    });
  });
});
