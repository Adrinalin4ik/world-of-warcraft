/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { BatchReport, ModelProbe, inspectModel, verdictFor } from '../model-probe';

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
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );

    const near = inspectModel(model([[batchMesh()]]), frustum, drawnAlways);
    expect(near.batches[0].inFrustum).toBe(true);

    const far = batchMesh();
    far.position.set(0, 0, 4000);
    far.updateMatrixWorld(true);
    expect(inspectModel(model([[far]]), frustum, drawnAlways).batches[0].inFrustum).toBe(false);
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

  it('does not blame a term only SOME batches zero', () => {
    // A model whose one transparent batch has faded out is normal; the body is still visible.
    const verdict = verdictFor(null, 1, [healthy(), healthy({ batch: 1, fadeAlpha: 0 })]);

    expect(verdict).toMatch(/plausible/);
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
