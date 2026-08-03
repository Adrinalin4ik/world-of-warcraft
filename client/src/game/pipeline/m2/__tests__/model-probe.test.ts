/**
 * @jest-environment node
 */
import * as THREE from 'three';

import {
  BatchReport, ModelProbe, SkinReport, inspectModel, skinVerdict, verdictFor,
} from '../model-probe';

/** A batch mesh carrying an M2Material-shaped material. */
function batchMesh(overrides: any = {}, uniforms: any = {}) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.computeBoundingSphere();

  const mesh: any = new THREE.Mesh(geometry, {
    opacity: 1,
    transparent: false,
    colorWrite: true,
    shaderNames: { vertex: 'Diffuse_T1', fragment: 'Combiners_Opaque' },
    defines: { BLENDING_MODE: 0 },
    uniforms: {
      textureCount: { value: 1 },
      textures: { value: [{ image: { width: 64, height: 64 } }] },
      alphaKey: { value: 0 },
      fadeAlpha: { value: 1 },
      animatedTransparency: { value: 1 },
      fogModifier: { value: 1 },
      fogParams: { value: new THREE.Vector4(-0.001, 1.2, 1, 1) },
      fogColor: { value: new THREE.Color(0x334455) },
      ...uniforms,
    },
  } as any);

  Object.assign(mesh, overrides);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** An M2-shaped root: `submeshes`, each a Group of batch meshes. */
function model(meshesPerSubmesh: any[][], rootOverrides: any = {}) {
  const root: any = new THREE.Group();
  root.path = 'CHARACTER\\HUMAN\\MALE\\HUMANMALE.M2';
  root.submeshes = meshesPerSubmesh.map((meshes) => {
    const submesh = new THREE.Group();
    meshes.forEach((m) => submesh.add(m));
    return submesh;
  });
  root.submeshes.forEach((s: any) => root.add(s));
  Object.assign(root, rootOverrides);
  root.updateMatrixWorld(true);
  return root;
}

const drawnAlways = () => true;
const drawnNever = () => false;

/** A camera at +Z looking at the origin, with the matrices `inspectModel` needs already resolved. */
function cameraAtOrigin() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

describe('inspectModel', () => {
  it('reports no model at all rather than throwing', () => {
    const report = inspectModel(null, null, drawnAlways);

    expect(report.hasModel).toBe(false);
    expect(report.batches).toEqual([]);
    expect(report.verdict).toMatch(/no model resolved/i);
  });

  it('walks submeshes and their batch meshes', () => {
    const report = inspectModel(
      model([[batchMesh(), batchMesh()], [batchMesh()]]), null, drawnAlways,
    );

    expect(report.submeshes).toBe(2);
    expect(report.batches).toHaveLength(3);
    expect(report.batches[0].submesh).toBe(0);
    expect(report.batches[2].submesh).toBe(1);
  });

  it('names the nearest invisible ancestor', () => {
    // One flag anywhere up the chain hides the whole body, and a per-mesh readout cannot see it.
    const root = model([[batchMesh()]]);
    const parent = new THREE.Group();
    parent.name = 'UnitView';
    parent.visible = false;
    parent.add(root);

    const report = inspectModel(root, null, drawnAlways);

    expect(report.hiddenAncestor).toBe('UnitView');
    expect(report.verdict).toMatch(/UnitView/);
  });

  it('reads the material uniforms that can zero a pixel', () => {
    const report = inspectModel(model([[batchMesh()]]), null, drawnAlways);
    const b = report.batches[0];

    expect(b.fadeAlpha).toBe(1);
    expect(b.animatedTransparency).toBe(1);
    expect(b.textureCount).toBe(1);
    expect(b.texturesReady).toBe(1);
    expect(b.fogParams).toEqual([-0.001, 1.2, 1, 1]);
    expect(b.fogColor).toBe('#334455');
    expect(b.blendingMode).toBe(0);
    expect(b.vertexShader).toBe('Diffuse_T1');
  });

  it('counts a texture slot with no decoded image as not ready', () => {
    const report = inspectModel(
      model([[batchMesh({}, { textures: { value: [null, { image: undefined }] } })]]),
      null, drawnAlways,
    );

    expect(report.batches[0].texturesReady).toBe(0);
  });

  it('marks a skinned batch as skinned', () => {
    const mesh = batchMesh();
    mesh.isSkinnedMesh = true;

    expect(inspectModel(model([[mesh]]), null, drawnAlways).batches[0].skinned).toBe(true);
  });

  it('tests the frustum with the same call three culls on', () => {
    const camera = cameraAtOrigin();

    const near = inspectModel(model([[batchMesh()]]), camera, drawnAlways);
    expect(near.batches[0].inFrustum).toBe(true);

    const far = batchMesh();
    far.position.set(0, 0, 4000);
    far.updateMatrixWorld(true);
    expect(inspectModel(model([[far]]), camera, drawnAlways).batches[0].inFrustum).toBe(false);
  });

  it('projects the sample vertex to NDC and calls a centred model on screen', () => {
    const report = inspectModel(model([[batchMesh()]]), cameraAtOrigin(), drawnAlways);
    const world = report.batches[0].world!;

    expect(world.onScreen).toBe(true);
    expect(world.behindCamera).toBe(false);
    expect(Math.abs(world.sampleNdc![0])).toBeLessThan(1);
    expect(world.sphereRadius).toBeGreaterThan(0);
  });

  it('flags a vertex behind the eye BEFORE the perspective divide folds it back in', () => {
    // A negative w divides the point back into [-1, 1], so a report that only checked NDC bounds
    // would call a body standing behind the camera "on screen".
    const behind = batchMesh();
    behind.position.set(0, 0, 60);
    behind.updateMatrixWorld(true);

    const world = inspectModel(model([[behind]]), cameraAtOrigin(), drawnAlways).batches[0].world!;

    expect(world.behindCamera).toBe(true);
    expect(world.onScreen).toBe(false);
  });

  it('calls an off-to-the-side vertex off screen even where the sphere passes the frustum', () => {
    const aside = batchMesh();
    aside.position.set(40, 0, 0);
    aside.updateMatrixWorld(true);

    const world = inspectModel(model([[aside]]), cameraAtOrigin(), drawnAlways).batches[0].world!;

    expect(world.onScreen).toBe(false);
    expect(Math.abs(world.sampleNdc![0])).toBeGreaterThan(1);
  });

  it('reports the world matrix translation, not the model-space vertex', () => {
    const placed = batchMesh();
    placed.position.set(3, -4, 5);
    placed.updateMatrixWorld(true);

    const world = inspectModel(model([[placed]]), cameraAtOrigin(), drawnAlways).batches[0].world!;

    expect(world.matrixWorldPosition[0]).toBeCloseTo(3, 5);
    expect(world.matrixWorldPosition[1]).toBeCloseTo(-4, 5);
  });

  it('leaves the world report null with no camera', () => {
    expect(inspectModel(model([[batchMesh()]]), null, drawnAlways).batches[0].world).toBeNull();
  });

  it('carries the drawn predicate through verbatim', () => {
    expect(inspectModel(model([[batchMesh()]]), null, drawnNever).batches[0].drawn).toBe(false);
    expect(inspectModel(model([[batchMesh()]]), null, drawnAlways).batches[0].drawn).toBe(true);
  });

  it('ignores non-mesh children, such as a bone or a helper', () => {
    const root = model([[batchMesh()]]);
    root.submeshes[0].add(new THREE.Bone());

    expect(inspectModel(root, null, drawnAlways).batches).toHaveLength(1);
  });
});

/** A batch report with everything healthy, for the verdict ordering tests to spoil one field of. */
const healthy = (overrides: Partial<BatchReport> = {}): BatchReport => ({
  submesh: 0,
  batch: 0,
  skinned: true,
  visible: true,
  frustumCulled: true,
  inFrustum: true,
  drawn: true,
  vertexShader: 'Diffuse_T1',
  fragmentShader: 'Combiners_Opaque',
  blendingMode: 0,
  textureCount: 1,
  texturesReady: 1,
  alphaKey: 0,
  fadeAlpha: 1,
  animatedTransparency: 1,
  fogParams: [-0.001, 1.2, 1, 1],
  fogColor: '#334455',
  fogModifier: 1,
  opacity: 1,
  transparent: false,
  colorWrite: true,
  skin: null,
  // On screen by default, so the verdict tests exercise the term each one is actually about.
  world: {
    matrixWorldPosition: [10, 20, 30],
    sphereCentre: [10, 20, 31],
    sphereRadius: 2.4,
    sampleWorld: [10.2, 19.8, 31.1],
    sampleNdc: [0.1, -0.2, 0.5],
    behindCamera: false,
    onScreen: true,
  },
  ...overrides,
});

/** A skin report describing a healthy, posed skeleton. */
const healthySkin = (overrides: Partial<SkinReport> = {}): SkinReport => ({
  bones: 60,
  zeroMatrices: 0,
  nonFiniteMatrices: 0,
  samplePosition: [0.2, 0.4, 1.1],
  sampleSkinned: [0.21, 0.39, 1.12],
  sampleWeightSum: 1,
  ...overrides,
});

describe('verdictFor', () => {
  it('is content when everything is healthy', () => {
    expect(verdictFor(null, 1, [healthy()])).toMatch(/plausible/);
  });

  it('reports no submeshes', () => {
    expect(verdictFor(null, 0, [])).toMatch(/no submeshes/);
  });

  it('reports submeshes with no batches', () => {
    expect(verdictFor(null, 3, [])).toMatch(/no batch meshes/);
  });

  it('reports every batch hidden', () => {
    expect(verdictFor(null, 1, [healthy({ visible: false })])).toMatch(/visible = false/);
  });

  it('reports nothing in the frustum', () => {
    expect(verdictFor(null, 1, [healthy({ inFrustum: false })])).toMatch(/frustum/);
  });

  it('reports in-frustum-but-never-drawn', () => {
    expect(verdictFor(null, 1, [healthy({ drawn: false })])).toMatch(/no draw was issued/);
  });

  it('reports the Discard shader', () => {
    expect(verdictFor(null, 1, [healthy({ fragmentShader: 'Discard' })])).toMatch(/Discard/);
  });

  it('reports missing texture data', () => {
    expect(verdictFor(null, 1, [healthy({ texturesReady: 0 })])).toMatch(/no texture has image/);
  });

  it('reports a zeroed fade alpha', () => {
    expect(verdictFor(null, 1, [healthy({ fadeAlpha: 0 })])).toMatch(/fadeAlpha 0/);
  });

  it('reports unset fog uniforms, and says what that resolves to', () => {
    // fogParams (0,0,0,*) makes f4 zero, so fogFactor is 1 and the colour is fully replaced by
    // fogColor. Nothing about that reads as "invisible" from the code alone.
    const verdict = verdictFor(null, 1, [healthy({ fogParams: [0, 0, 0, 0] })]);

    expect(verdict).toMatch(/fog uniforms are unset/);
    expect(verdict).toMatch(/replaced by fogColor/);
  });

  it('prefers the EARLIEST broken link over a later one', () => {
    // A body that never drew has nothing to say about its fog uniforms, and reporting those would
    // send the search to the wrong end of the pipeline.
    const verdict = verdictFor(null, 1, [healthy({ drawn: false, fogParams: [0, 0, 0, 0] })]);

    expect(verdict).toMatch(/no draw was issued/);
  });

  it('reports a collapsed skin, which every other check passes', () => {
    // The state a body that draws seven batches a frame and shows nothing is in: healthy uniforms,
    // healthy textures, in frustum -- because the frustum test uses the UNSKINNED bounding sphere.
    const collapsed = healthySkin({ sampleSkinned: [0, 0, 0] });
    const verdict = verdictFor(null, 1, [healthy({ skin: collapsed })]);

    expect(verdict).toMatch(/collapses every vertex onto the model origin/);
  });

  it('puts the vertex-stage fault ahead of any fragment-stage one', () => {
    const verdict = verdictFor(null, 1, [healthy({
      skin: healthySkin({ sampleSkinned: [0, 0, 0] }),
      texturesReady: 0,
      fogParams: [0, 0, 0, 0],
    })]);

    expect(verdict).toMatch(/collapses every vertex/);
  });

  it('says nothing about skinning when the skin is sound', () => {
    expect(verdictFor(null, 1, [healthy({ skin: healthySkin() })])).toMatch(/plausible/);
  });

  it('reports a body drawn behind the eye', () => {
    const verdict = verdictFor(null, 1, [healthy({
      world: { ...healthy().world!, behindCamera: true, sampleNdc: null, onScreen: false },
    })]);

    expect(verdict).toMatch(/BEHIND the eye/);
  });

  it('reports a body drawn outside the viewport, and blames the bounding sphere', () => {
    // The false clean bill of health: `inFrustum` passed on an oversized sphere while the triangles
    // are elsewhere, so every other field reads healthy.
    const verdict = verdictFor(null, 1, [healthy({
      world: { ...healthy().world!, sampleNdc: [4.2, -0.3, 0.5], onScreen: false },
    })]);

    expect(verdict).toMatch(/outside the viewport/);
    expect(verdict).toMatch(/oversized bounding sphere/);
  });

  it('puts being off screen ahead of any fragment-stage term', () => {
    const verdict = verdictFor(null, 1, [healthy({
      world: { ...healthy().world!, sampleNdc: [4.2, 0, 0.5], onScreen: false },
      texturesReady: 0,
    })]);

    expect(verdict).toMatch(/outside the viewport/);
  });

  it('stays quiet when only ONE batch is off screen', () => {
    const verdict = verdictFor(null, 1, [
      healthy(),
      healthy({ batch: 1, world: { ...healthy().world!, onScreen: false, sampleNdc: [3, 0, 0] } }),
    ]);

    expect(verdict).toMatch(/plausible/);
  });

  it('does not blame a term only SOME batches zero', () => {
    // A model whose one transparent batch has faded out is normal; the body is still visible.
    const verdict = verdictFor(null, 1, [healthy(), healthy({ batch: 1, fadeAlpha: 0 })]);

    expect(verdict).toMatch(/plausible/);
  });
});

describe('skinVerdict', () => {
  it('passes a posed skeleton', () => {
    expect(skinVerdict([healthySkin()])).toBeNull();
  });

  it('reports an entirely unposed skeleton', () => {
    expect(skinVerdict([healthySkin({ bones: 60, zeroMatrices: 60 })]))
      .toMatch(/every bone matrix is all zeros/);
  });

  it('reports NaN in the bone palette', () => {
    expect(skinVerdict([healthySkin({ nonFiniteMatrices: 3 })])).toMatch(/NaN or Infinity/);
  });

  it('reports a non-finite skinned vertex', () => {
    expect(skinVerdict([healthySkin({ sampleSkinned: [NaN, NaN, NaN] })]))
      .toMatch(/non-finite position/);
  });

  it('reports weights that sum to zero', () => {
    expect(skinVerdict([healthySkin({ sampleWeightSum: 0 })])).toMatch(/sum to zero/);
  });

  it('reports the collapse to the origin', () => {
    expect(skinVerdict([healthySkin({ sampleSkinned: [0, 0, 0] })]))
      .toMatch(/collapses every vertex/);
  });

  it('does not call a vertex authored AT the origin a collapse', () => {
    // A vertex that starts at the model origin ends there legitimately. Reporting that as a collapse
    // would fire on healthy models.
    expect(skinVerdict([healthySkin({ samplePosition: [0, 0, 0], sampleSkinned: [0, 0, 0] })]))
      .toBeNull();
  });

  it('stays quiet when only ONE batch is collapsed', () => {
    const verdict = skinVerdict([
      healthySkin(),
      healthySkin({ sampleSkinned: [0, 0, 0] }),
    ]);

    expect(verdict).toBeNull();
  });
});

describe('inspectModel skin reading', () => {
  /** A skinned batch whose skeleton palette and bind matrices the test controls outright. */
  function skinnedBatch(boneMatrices: Float32Array, bones: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.computeBoundingSphere();
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(
      new Array(geometry.getAttribute('position').count * 4).fill(0), 4,
    ));
    const weights = new Float32Array(geometry.getAttribute('position').count * 4);
    for (let i = 0; i < weights.length; i += 4) {
      weights[i] = 1;
    }
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));

    const mesh: any = new THREE.Mesh(geometry, { uniforms: {} } as any);
    mesh.isSkinnedMesh = true;
    mesh.bindMatrix = new THREE.Matrix4();
    mesh.bindMatrixInverse = new THREE.Matrix4();
    mesh.skeleton = { bones: new Array(bones).fill(null), boneMatrices };
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  it('runs the shader math and reproduces an identity pose verbatim', () => {
    const palette = new Float32Array(16);
    new THREE.Matrix4().toArray(palette, 0);

    const report = inspectModel(model([[skinnedBatch(palette, 1)]]), null, drawnAlways);
    const skin = report.batches[0].skin!;

    expect(skin.sampleWeightSum).toBeCloseTo(1, 6);
    expect(skin.sampleSkinned![0]).toBeCloseTo(skin.samplePosition![0], 5);
    expect(skin.sampleSkinned![2]).toBeCloseTo(skin.samplePosition![2], 5);
    expect(skin.zeroMatrices).toBe(0);
  });

  it('sees the collapse an all-zero palette produces', () => {
    // A real camera containing the mesh, so the verdict reaches the skin checks instead of stopping
    // at "not in frustum" -- which is the whole point: a collapsed skin IS in frustum.
    const report = inspectModel(
      model([[skinnedBatch(new Float32Array(16), 1)]]), cameraAtOrigin(), drawnAlways,
    );
    const skin = report.batches[0].skin!;

    expect(skin.zeroMatrices).toBe(1);
    expect(skin.sampleSkinned).toEqual([0, 0, 0]);
    expect(report.verdict).toMatch(/every bone matrix is all zeros/);
  });

  it('leaves a non-skinned batch with no skin report', () => {
    expect(inspectModel(model([[batchMesh()]]), null, drawnAlways).batches[0].skin).toBeNull();
  });
});

describe('ModelProbe', () => {
  it('stamps nothing while disabled', () => {
    const probe = new ModelProbe();
    const mesh = batchMesh();
    probe.tick(model([[mesh]]));

    // `Object3D` ships a no-op `onAfterRender` on its prototype, so the test is whether the probe
    // installed one of its OWN -- and, behaviourally, that a draw leaves no stamp behind.
    expect(Object.prototype.hasOwnProperty.call(mesh, 'onAfterRender')).toBe(false);
    mesh.onAfterRender();
    expect(probe.wasDrawn(mesh)).toBe(false);
  });

  it('installs a stamp on each batch mesh once enabled', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    probe.tick(model([[mesh]]));

    expect(typeof mesh.onAfterRender).toBe('function');
  });

  it('leaves onBeforeRender alone -- the fade-alpha push lives there', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    const fade = () => undefined;
    mesh.onBeforeRender = fade;

    probe.tick(model([[mesh]]));

    expect(mesh.onBeforeRender).toBe(fade);
  });

  it('counts a mesh as drawn on the frame it was stamped', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);

    probe.tick(root);
    mesh.onAfterRender();

    expect(probe.wasDrawn(mesh)).toBe(true);
  });

  it('still counts it one frame later, since the panel repaints far slower than the render loop', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);

    probe.tick(root);
    mesh.onAfterRender();
    probe.tick(root);

    expect(probe.wasDrawn(mesh)).toBe(true);
  });

  it('stops counting it once the stamp goes stale', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);

    probe.tick(root);
    mesh.onAfterRender();
    probe.tick(root);
    probe.tick(root);
    probe.tick(root);

    expect(probe.wasDrawn(mesh)).toBe(false);
  });

  it('never drew means never drawn, not drawn-on-frame-zero', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    probe.tick(model([[mesh]]));

    expect(probe.wasDrawn(mesh)).toBe(false);
  });

  it('advances its frame counter even while disabled', () => {
    // The counter is what "drawn" is measured against; a frozen one would make every stale stamp
    // read as fresh the moment the probe was switched on.
    const probe = new ModelProbe();
    probe.tick(null);
    probe.tick(null);

    expect(probe.frame).toBe(2);
  });

  it('survives a tick with no model resolved yet', () => {
    const probe = new ModelProbe();
    probe.enabled = true;

    expect(() => probe.tick(null)).not.toThrow();
    expect(probe.read(null).hasModel).toBe(false);
  });
});
