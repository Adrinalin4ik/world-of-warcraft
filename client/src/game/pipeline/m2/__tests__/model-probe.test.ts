/**
 * @jest-environment node
 */
import * as THREE from 'three';

import {
  BatchReport, ModelProbe, ShadingReport, SkinReport, batchMeshes, inspectModel, readTexture,
  shadingVerdict, skinVerdict, verdictFor,
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
      animatedVertexColorRGB: { value: new THREE.Vector3(1, 1, 1) },
      animatedVertexColorAlpha: { value: 1 },
      // A bare array, exactly as `M2Material` declares it -- see `vec4Of`.
      materialParams: { value: [1, 1, 1, 1] },
      sunParams: { value: new THREE.Vector4(0.3, 0.4, -0.8, 0) },
      sunDiffuseColor: { value: new THREE.Color(0.8, 0.8, 0.7) },
      sunAmbientColor: { value: new THREE.Color(0.3, 0.3, 0.4) },
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
  textures: [{
    name: 'CREATURE\\ARTHAS\\ARTHAS.BLP',
    width: 256,
    height: 256,
    compressed: false,
    format: 1023,
    mean: [120, 110, 95, 255],
    sampled: 1024,
  }],
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
  shading: healthyShading(),
  ...overrides,
});

/** Shading uniforms that cannot darken anything. */
const healthyShading = (overrides: Partial<ShadingReport> = {}): ShadingReport => ({
  useLighting: 1,
  vertexColorRGB: [1, 1, 1],
  vertexColorAlpha: 1,
  sunParams: [0.3, 0.4, -0.8, 0],
  sunDiffuse: '#cccbb2',
  sunAmbient: '#4d4d66',
  sunIntensity: 1,
  materialParams: [1, 1, 0, 0],
  interiorProbe: 0,
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

describe('readTexture', () => {
  /** A DataTexture-shaped object with a flat RGBA pixel array. */
  const dataTexture = (fill: number[], width = 4, height = 4, name = 'SKIN.BLP') => {
    const data = new Uint8Array(width * height * fill.length);
    for (let i = 0; i < data.length; i += fill.length) {
      fill.forEach((v, k) => { data[i + k] = v; });
    }
    return { name, format: 1023, image: { data, width, height } };
  };

  it('names the texture from the loader-stamped path', () => {
    expect(readTexture(dataTexture([10, 20, 30, 255])).name).toBe('SKIN.BLP');
  });

  it('averages a flat RGBA surface exactly', () => {
    const report = readTexture(dataTexture([10, 20, 30, 255]));

    expect(report.mean).toEqual([10, 20, 30, 255]);
    expect(report.sampled).toBeGreaterThan(0);
  });

  it('measures a black surface as black', () => {
    // The reading that separates a correct skin from one that decoded to nothing -- which
    // `texturesReady` cannot do, since both have image data.
    expect(readTexture(dataTexture([0, 0, 0, 255])).mean).toEqual([0, 0, 0, 255]);
  });

  it('derives the component count rather than assuming four', () => {
    // A 3-channel surface read as 4-channel slides the sample across channels and reports a colour
    // nothing on screen has.
    expect(readTexture(dataTexture([60, 70, 80])).mean).toEqual([60, 70, 80, 255]);
  });

  it('reports a compressed texture without inventing a mean', () => {
    const report = readTexture({
      name: 'DXT.BLP', isCompressedTexture: true, image: { width: 128, height: 128 },
    });

    expect(report.compressed).toBe(true);
    expect(report.mean).toBeNull();
    expect(report.width).toBe(128);
  });

  it('reports no mean for a texture with no pixel data', () => {
    const report = readTexture({ name: 'placeholder', image: null });

    expect(report.mean).toBeNull();
    expect(report.sampled).toBe(0);
  });

  it('strides a large surface rather than walking every pixel', () => {
    const report = readTexture(dataTexture([5, 5, 5, 255], 512, 512));

    expect(report.sampled).toBeLessThanOrEqual(1100);
    expect(report.mean).toEqual([5, 5, 5, 255]);
  });
});

describe('verdictFor texture measurement', () => {
  const blackTex = () => [{
    name: 'ARTHAS.BLP',
    width: 256,
    height: 256,
    compressed: false,
    format: 1023,
    mean: [0, 0, 0, 255] as [number, number, number, number],
    sampled: 1024,
  }];

  it('reports a measured-black skin, and names the file', () => {
    const verdict = verdictFor(null, 1, [healthy({ textures: blackTex() })]);

    expect(verdict).toMatch(/every sampled texel is black/);
    expect(verdict).toMatch(/ARTHAS\.BLP/);
  });

  it('puts the black texel ahead of the shading factors', () => {
    const verdict = verdictFor(null, 1, [healthy({
      textures: blackTex(),
      shading: healthyShading({ vertexColorRGB: [0, 0, 0] }),
    })]);

    expect(verdict).toMatch(/every sampled texel is black/);
  });

  it('says nothing when the skin measures bright', () => {
    expect(verdictFor(null, 1, [healthy()])).toMatch(/plausible/);
  });

  it('does not call an unmeasurable compressed texture black', () => {
    const verdict = verdictFor(null, 1, [healthy({
      textures: [{
        name: 'DXT.BLP', width: 256, height: 256, compressed: true, format: 33779,
        mean: null, sampled: 0,
      }],
    })]);

    expect(verdict).toMatch(/plausible/);
  });

  it('does not blame a black texel on only ONE batch', () => {
    const verdict = verdictFor(null, 1, [
      healthy(),
      healthy({ batch: 1, textures: blackTex() }),
    ]);

    expect(verdict).toMatch(/plausible/);
  });
});

describe('shadingVerdict', () => {
  it('passes healthy albedo and lighting', () => {
    expect(shadingVerdict([healthyShading()])).toBeNull();
  });

  it('reports a black animated vertex colour, and says what multiplies what', () => {
    // Both combiners compute `texel.rgb * vertexColor.rgb * 2.0`, and the vertex stage builds
    // vertexColor.rgb from animatedVertexColorRGB * 0.5 -- so this factor IS the albedo scale.
    const verdict = shadingVerdict([healthyShading({ vertexColorRGB: [0, 0, 0] })]);

    expect(verdict).toMatch(/animated vertex colour is black/);
    expect(verdict).toMatch(/multiplied to zero/);
  });

  it('reports a zeroed vertex-colour alpha', () => {
    expect(shadingVerdict([healthyShading({ vertexColorAlpha: 0 })]))
      .toMatch(/animatedVertexColorAlpha is zero/);
  });

  it('reports both sun colours black while lighting is on', () => {
    const verdict = shadingVerdict([healthyShading({
      sunDiffuse: '#000000', sunAmbient: '#000000',
    })]);

    expect(verdict).toMatch(/both sun colours are pure black/);
  });

  it('does not blame black sun colours when lighting is compiled out', () => {
    expect(shadingVerdict([healthyShading({
      useLighting: 0, sunDiffuse: '#000000', sunAmbient: '#000000',
    })])).toBeNull();
  });

  it('does not blame them when the material mixes back toward white', () => {
    // materialParams.y below 1 mixes the light term toward white -- what unlit geometry relies on.
    expect(shadingVerdict([healthyShading({
      materialParams: [1, 0, 0, 0], sunDiffuse: '#000000', sunAmbient: '#000000',
    })])).toBeNull();
  });

  it('does not blame them for an interior prop, whose probe is its light', () => {
    expect(shadingVerdict([healthyShading({
      interiorProbe: 1, sunDiffuse: '#000000', sunAmbient: '#000000',
    })])).toBeNull();
  });

  it('does not blame a factor only ONE batch zeroes', () => {
    expect(shadingVerdict([
      healthyShading(),
      healthyShading({ vertexColorRGB: [0, 0, 0] }),
    ])).toBeNull();
  });
});

describe('inspectModel shading reading', () => {
  it('reads a bare-array vec4 uniform as well as a Vector4', () => {
    // `M2Material` declares materialParams as [1,1,1,1]. Reading only `.x` reported it absent, which
    // read as "the lighting mix is unset" when it is in fact 1.
    const shading = inspectModel(model([[batchMesh()]]), null, drawnAlways).batches[0].shading!;

    expect(shading.materialParams).toEqual([1, 1, 1, 1]);
  });

  it('reads the albedo and sun uniforms off the material', () => {
    const shading = inspectModel(model([[batchMesh()]]), null, drawnAlways).batches[0].shading!;

    expect(shading.vertexColorRGB).toEqual([1, 1, 1]);
    expect(shading.vertexColorAlpha).toBe(1);
    expect(shading.sunParams).toEqual([0.3, 0.4, -0.8, 0]);
    expect(shading.sunDiffuse).toMatch(/^#/);
  });

  it('reads a black vertex colour as black and reaches the verdict', () => {
    const report = inspectModel(
      model([[batchMesh({}, { animatedVertexColorRGB: { value: new THREE.Vector3(0, 0, 0) } })]]),
      cameraAtOrigin(), drawnAlways,
    );

    expect(report.batches[0].shading!.vertexColorRGB).toEqual([0, 0, 0]);
    expect(report.verdict).toMatch(/animated vertex colour is black/);
  });

  it('leaves shading null for a material with no uniforms', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    expect(inspectModel(model([[mesh]]), null, drawnAlways).batches[0].shading).toBeNull();
  });

  it('reads the material the resolver names, not the one currently assigned', () => {
    // What the flat-colour bisection needs: magenta on screen, real uniforms in the readout.
    const mesh = batchMesh();
    const real = mesh.material;
    mesh.material = new THREE.MeshBasicMaterial();

    const report = inspectModel(model([[mesh]]), null, drawnAlways, () => real);

    expect(report.batches[0].shading).not.toBeNull();
    expect(report.batches[0].texturesReady).toBe(1);
  });
});

describe('ModelProbe flat-colour bisection', () => {
  it('still reports the real material while the override is installed', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    probe.tick(model([[mesh]]));

    const report = probe.read(cameraAtOrigin());

    expect(report.batches[0].texturesReady).toBe(1);
    expect(report.batches[0].shading!.vertexColorRGB).toEqual([1, 1, 1]);
  });

  it('swaps every batch material while enabled', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    const original = mesh.material;

    probe.tick(model([[mesh]]));

    expect(mesh.material).not.toBe(original);
    expect((mesh.material as any).isMeshBasicMaterial).toBe(true);
  });

  it('ignores depth so an occluder cannot be mistaken for a missing body', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    probe.tick(model([[mesh]]));

    expect((mesh.material as any).depthTest).toBe(false);
    expect((mesh.material as any).depthWrite).toBe(false);
  });

  it('restores the original material when switched off', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);
    const original = mesh.material;

    probe.tick(root);
    probe.flatColor = false;
    probe.tick(root);

    expect(mesh.material).toBe(original);
  });

  it('restores it when the whole probe is switched off, not just the override', () => {
    // Otherwise collapsing the panel section leaves the character permanently magenta.
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);
    const original = mesh.material;

    probe.tick(root);
    probe.enabled = false;
    probe.tick(root);

    expect(mesh.material).toBe(original);
    expect(probe.flatColor).toBe(false);
  });

  it('does not stack overrides across frames', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    probe.flatColor = true;
    const mesh = batchMesh();
    const root = model([[mesh]]);
    const original = mesh.material;

    probe.tick(root);
    probe.tick(root);
    probe.tick(root);
    probe.flatColor = false;
    probe.tick(root);

    expect(mesh.material).toBe(original);
  });

  it('leaves materials alone while the override is off', () => {
    const probe = new ModelProbe();
    probe.enabled = true;
    const mesh = batchMesh();
    const original = mesh.material;

    probe.tick(model([[mesh]]));

    expect(mesh.material).toBe(original);
  });
});

describe('batchMeshes', () => {
  it('collects batch meshes in submesh order', () => {
    const a = batchMesh();
    const b = batchMesh();
    const c = batchMesh();

    expect(batchMeshes(model([[a, b], [c]]))).toEqual([a, b, c]);
  });

  it('ignores non-batch children, such as the bounding hull or a bone', () => {
    const a = batchMesh();
    const root = model([[a]]);
    root.submeshes[0].add(new THREE.Bone());

    expect(batchMeshes(root)).toEqual([a]);
  });

  it('returns nothing for a model that has not resolved', () => {
    expect(batchMeshes(null)).toEqual([]);
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
