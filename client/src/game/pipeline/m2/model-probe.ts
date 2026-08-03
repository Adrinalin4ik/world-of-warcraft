import * as THREE from 'three';

/**
 * One batch mesh's state -- everything between "the model exists" and "a lit pixel reaches the
 * framebuffer".
 *
 * Every field here is one link in that chain, because the chain is exactly what has been impossible
 * to reason about: this project has diagnosed an invisible character body wrongly five times, and
 * every one of those wrong diagnoses was a plausible story about a link nobody had measured.
 */
/**
 * What the skinning transform actually does to one real vertex.
 *
 * The reason this is worth computing rather than inspecting: a collapsed skin is INVISIBLE TO EVERY
 * OTHER CHECK. `frustumCulled` tests the geometry's own bounding sphere, which is the UNSKINNED
 * bounds, so a mesh whose every vertex is mapped to a single point still passes the frustum test,
 * still issues a draw, and still reports healthy uniforms and textures -- exactly the state a body
 * that draws seven batches a frame and shows nothing is in.
 */
export interface SkinReport {
  bones: number;
  /** Bone matrices whose sixteen elements are all zero -- a skeleton that never got posed. */
  zeroMatrices: number;
  nonFiniteMatrices: number;
  /** Geometry vertex 0, before skinning. */
  samplePosition: [number, number, number] | null;
  /** The same vertex after the shader's own math, run here on the CPU. */
  sampleSkinned: [number, number, number] | null;
  sampleWeightSum: number | null;
}

export interface BatchReport {
  submesh: number;
  batch: number;
  skinned: boolean;
  /** This mesh's own flag; ancestors are reported once, on the model. */
  visible: boolean;
  frustumCulled: boolean;
  /** Its world bounds meet the camera frustum -- the test three itself culls on. */
  inFrustum: boolean;
  /** It issued a draw within the last couple of frames. The one fact no amount of reading gives. */
  drawn: boolean;
  vertexShader: string | null;
  fragmentShader: string | null;
  blendingMode: number | null;
  /** The material's `textureCount` uniform. */
  textureCount: number;
  /** How many of those textures actually have decoded image data. */
  texturesReady: number;
  alphaKey: number | null;
  fadeAlpha: number | null;
  animatedTransparency: number | null;
  /** `(scale, offset, exponent, unused)`. All-zero means nobody has published light uniforms. */
  fogParams: [number, number, number, number] | null;
  fogColor: string | null;
  fogModifier: number | null;
  opacity: number;
  transparent: boolean;
  colorWrite: boolean;
  /** Null for a non-skinned batch. */
  skin: SkinReport | null;
}

export interface ModelReport {
  hasModel: boolean;
  path: string | null;
  /** The nearest ancestor whose `visible` is false, if any -- one flag hides the whole body. */
  hiddenAncestor: string | null;
  submeshes: number;
  batches: BatchReport[];
  /** A one-line reading of the above: what to look at next. */
  verdict: string;
}

/** Fog uniforms nobody has written yet: `fogFactor` comes out 1 and the colour is fully replaced. */
const fogUnset = (fog: [number, number, number, number] | null) =>
  fog !== null && fog[0] === 0 && fog[1] === 0 && fog[2] === 0;

const _bone = new THREE.Matrix4();
const _skinVertex = new THREE.Vector4();
const _accum = new THREE.Vector4();

/** All sixteen elements zero -- a bone matrix that was never composed, not merely an identity. */
function matrixIsZero(m: Float32Array | number[], offset: number): boolean {
  for (let i = 0; i < 16; ++i) {
    if (m[offset + i] !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Run the vertex shader's skinning on geometry vertex 0, here, on the CPU.
 *
 * Deliberately the SAME sequence as `vertex/common-main.glsl`:
 *
 *   skinVertex = bindMatrix * position
 *   skinned    = sum over i of boneMatrix[i] * skinVertex * weight[i]
 *   skinned    = bindMatrixInverse * skinned
 *
 * so that a disagreement between what is reported here and what appears on screen means the shader,
 * and an agreement means the data. Reading the matrices without composing them cannot make that
 * distinction: four healthy-looking matrices with weights summing to zero still collapse the mesh.
 */
function readSkin(mesh: any): SkinReport | null {
  const skeleton = mesh.skeleton;
  const geometry = mesh.geometry;

  if (!skeleton || !geometry) {
    return null;
  }

  const matrices: Float32Array | undefined = skeleton.boneMatrices;
  const bones: any[] = skeleton.bones ?? [];

  const report: SkinReport = {
    bones: bones.length,
    zeroMatrices: 0,
    nonFiniteMatrices: 0,
    samplePosition: null,
    sampleSkinned: null,
    sampleWeightSum: null,
  };

  if (matrices) {
    for (let b = 0; b < bones.length; ++b) {
      const offset = b * 16;
      if (matrixIsZero(matrices, offset)) {
        report.zeroMatrices += 1;
      }
      for (let i = 0; i < 16; ++i) {
        if (!Number.isFinite(matrices[offset + i])) {
          report.nonFiniteMatrices += 1;
          break;
        }
      }
    }
  }

  const position = geometry.getAttribute?.('position');
  const skinIndex = geometry.getAttribute?.('skinIndex');
  const skinWeight = geometry.getAttribute?.('skinWeight');

  if (!position || position.count === 0) {
    return report;
  }

  report.samplePosition = [position.getX(0), position.getY(0), position.getZ(0)];

  if (!skinIndex || !skinWeight || !matrices || !mesh.bindMatrix || !mesh.bindMatrixInverse) {
    return report;
  }

  const weights = [skinWeight.getX(0), skinWeight.getY(0), skinWeight.getZ(0), skinWeight.getW(0)];
  const indices = [skinIndex.getX(0), skinIndex.getY(0), skinIndex.getZ(0), skinIndex.getW(0)];
  report.sampleWeightSum = weights.reduce((a, b) => a + b, 0);

  _skinVertex.set(report.samplePosition[0], report.samplePosition[1], report.samplePosition[2], 1)
    .applyMatrix4(mesh.bindMatrix);

  _accum.set(0, 0, 0, 0);

  for (let i = 0; i < 4; ++i) {
    const weight = weights[i];
    if (weight === 0) {
      continue;
    }

    const offset = indices[i] * 16;
    if (offset + 15 >= matrices.length) {
      continue; // index past the end of the palette -- reported through the sample coming out short
    }

    _bone.fromArray(matrices as any, offset);

    const v = _skinVertex.clone().applyMatrix4(_bone).multiplyScalar(weight);
    _accum.add(v);
  }

  _accum.applyMatrix4(mesh.bindMatrixInverse);
  report.sampleSkinned = [_accum.x, _accum.y, _accum.z];

  return report;
}

function readMaterial(material: any, report: BatchReport): void {
  report.opacity = material?.opacity ?? 1;
  report.transparent = !!material?.transparent;
  report.colorWrite = material?.colorWrite !== false;
  report.vertexShader = material?.shaderNames?.vertex ?? null;
  report.fragmentShader = material?.shaderNames?.fragment ?? null;

  const blending = material?.defines?.BLENDING_MODE;
  report.blendingMode = blending === undefined ? null : Number(blending);

  const uniforms = material?.uniforms;
  if (!uniforms) {
    return;
  }

  report.textureCount = uniforms.textureCount?.value ?? 0;
  report.alphaKey = uniforms.alphaKey?.value ?? null;
  report.fadeAlpha = uniforms.fadeAlpha?.value ?? null;
  report.animatedTransparency = uniforms.animatedTransparency?.value ?? null;
  report.fogModifier = uniforms.fogModifier?.value ?? null;

  const textures = uniforms.textures?.value;
  if (Array.isArray(textures)) {
    report.texturesReady = textures.filter(
      (t: any) => t && t.image && (t.image.width === undefined || t.image.width > 0),
    ).length;
  }

  const fog = uniforms.fogParams?.value;
  if (fog) {
    report.fogParams = [fog.x, fog.y, fog.z, fog.w];
  }

  const color = uniforms.fogColor?.value;
  if (color && color.getHexString) {
    report.fogColor = `#${color.getHexString()}`;
  }
}

/**
 * Read the whole draw chain for one model.
 *
 * Pure: the caller supplies the frustum and the "was this drawn" predicate, so the entire thing is
 * testable against plain objects with no renderer, no camera and no loaded world.
 */
export function inspectModel(
  root: any,
  frustum: THREE.Frustum | null,
  wasDrawn: (mesh: any) => boolean,
): ModelReport {
  if (!root) {
    return {
      hasModel: false, path: null, hiddenAncestor: null, submeshes: 0, batches: [],
      verdict: 'no model resolved -- display id never produced an M2',
    };
  }

  // An invisible ancestor hides everything below it and is invisible in a per-mesh readout, so it
  // is checked first and reported separately.
  let hiddenAncestor: string | null = null;
  for (let node = root; node; node = node.parent) {
    if (node.visible === false) {
      hiddenAncestor = node.name || node.type || 'unnamed';
    }
  }

  const submeshes: any[] = Array.isArray(root.submeshes) ? root.submeshes : [];
  const batches: BatchReport[] = [];

  submeshes.forEach((submesh, submeshIndex) => {
    const children: any[] = submesh?.children ?? [];
    children.forEach((mesh, batchIndex) => {
      if (!mesh || mesh.isMesh !== true) {
        return;
      }

      const report: BatchReport = {
        submesh: submeshIndex,
        batch: batchIndex,
        skinned: mesh.isSkinnedMesh === true,
        visible: mesh.visible !== false,
        frustumCulled: mesh.frustumCulled !== false,
        inFrustum: false,
        drawn: wasDrawn(mesh),
        vertexShader: null,
        fragmentShader: null,
        blendingMode: null,
        textureCount: 0,
        texturesReady: 0,
        alphaKey: null,
        fadeAlpha: null,
        animatedTransparency: null,
        fogParams: null,
        fogColor: null,
        fogModifier: null,
        opacity: 1,
        transparent: false,
        colorWrite: true,
        skin: null,
      };

      if (report.skinned) {
        report.skin = readSkin(mesh);
      }

      if (frustum && mesh.geometry) {
        try {
          report.inFrustum = frustum.intersectsObject(mesh);
        } catch {
          report.inFrustum = false;
        }
      }

      readMaterial(mesh.material, report);
      batches.push(report);
    });
  });

  return {
    hasModel: true,
    path: root.path ?? root.name ?? null,
    hiddenAncestor,
    submeshes: submeshes.length,
    batches,
    verdict: verdictFor(hiddenAncestor, submeshes.length, batches),
  };
}

const finite = (v: [number, number, number] | null) =>
  v !== null && v.every((n) => Number.isFinite(n));

const magnitude = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);

/**
 * What the skinning data says is wrong, or null when it looks sound.
 *
 * Only faults that hold for EVERY skinned batch are reported: one collapsed batch among six healthy
 * ones is a submesh problem, not the reason a whole body is missing, and blaming it would send the
 * search off in the wrong direction.
 */
export function skinVerdict(skins: SkinReport[]): string | null {
  if (skins.every((s) => s.bones > 0 && s.zeroMatrices === s.bones)) {
    return 'every bone matrix is all zeros -- the skeleton was never posed, so the shader maps '
      + 'every vertex to nothing';
  }
  if (skins.every((s) => s.nonFiniteMatrices > 0)) {
    return 'bone matrices contain NaN or Infinity -- the skinned position is undefined';
  }
  if (skins.every((s) => s.sampleSkinned !== null && !finite(s.sampleSkinned))) {
    return 'skinning yields a non-finite position for a real vertex';
  }
  if (skins.every((s) => s.sampleWeightSum !== null && s.sampleWeightSum < 1e-4)) {
    return 'skin weights sum to zero -- every vertex is weighted onto no bone at all';
  }
  if (skins.every((s) => (
    finite(s.sampleSkinned) && finite(s.samplePosition)
    && magnitude(s.samplePosition!) > 1e-3
    && magnitude(s.sampleSkinned!) < 1e-4
  ))) {
    return 'skinning collapses every vertex onto the model origin -- the mesh has no extent on '
      + 'screen, which is why it passes the frustum test and draws nothing';
  }

  return null;
}

/**
 * Turn the readout into the next step.
 *
 * Ordered so the EARLIEST broken link wins: reporting "fog uniforms unset" for a body that never
 * issued a draw would send the search to the wrong end of the pipeline, which is the mistake this
 * whole module exists to stop.
 */
export function verdictFor(
  hiddenAncestor: string | null, submeshes: number, batches: BatchReport[],
): string {
  if (hiddenAncestor) {
    return `hidden: \`${hiddenAncestor}\`.visible is false -- nothing below it draws`;
  }
  if (submeshes === 0) {
    return 'model has no submeshes -- createSubmeshes produced nothing';
  }
  if (batches.length === 0) {
    return 'submeshes carry no batch meshes -- applyBatches never ran, or cleared them';
  }

  const visible = batches.filter((b) => b.visible);
  if (visible.length === 0) {
    return 'every batch mesh has visible = false';
  }

  const inFrustum = visible.filter((b) => b.inFrustum);
  if (inFrustum.length === 0) {
    return 'no batch is in the camera frustum -- bounding sphere or world matrix is wrong';
  }

  const drawn = batches.filter((b) => b.drawn);
  if (drawn.length === 0) {
    return 'in frustum, yet no draw was issued -- look at culling and the parent chain';
  }

  if (drawn.every((b) => b.fragmentShader === 'Discard' || b.vertexShader === 'Discard')) {
    return 'drawing the Discard shader -- the batch resolved to no combiner';
  }
  if (drawn.every((b) => b.colorWrite === false)) {
    return 'drawn with colorWrite off';
  }

  // The VERTEX stage before the fragment stage: a collapsed or non-finite skin passes every other
  // check in this function, because the frustum test uses the UNSKINNED bounding sphere.
  const skinned = drawn.filter((b) => b.skin !== null);
  if (skinned.length > 0) {
    const skinFault = skinVerdict(skinned.map((b) => b.skin as SkinReport));
    if (skinFault) {
      return skinFault;
    }
  }
  if (drawn.every((b) => b.textureCount === 0 || b.texturesReady === 0)) {
    return 'drawn, but no texture has image data -- sampling nothing, so alpha may key it away';
  }
  if (drawn.every((b) => b.fadeAlpha === 0)) {
    return 'drawn with fadeAlpha 0 -- output alpha multiplied to zero';
  }
  if (drawn.every((b) => b.animatedTransparency === 0)) {
    return 'drawn with animatedTransparency 0';
  }
  if (drawn.every((b) => b.opacity === 0)) {
    return 'drawn with material opacity 0';
  }
  if (drawn.every((b) => fogUnset(b.fogParams))) {
    return 'drawn, but fog uniforms are unset: fogFactor resolves to 1, so the colour is fully '
      + 'replaced by fogColor -- the material never reached the map light registry';
  }

  return `drawn: ${drawn.length}/${batches.length} batches, textures and uniforms look plausible`;
}

/**
 * Stateful half: stamps each batch mesh as it is drawn.
 *
 * Uses `onAfterRender`, which nothing else in the M2 pipeline sets -- `onBeforeRender` already
 * carries the per-draw fade-alpha push (`submesh.js`) and wrapping it would be one more thing to get
 * wrong.
 */
export class ModelProbe {
  enabled = false;

  /** Bumped once per rendered frame; a stamp within one of this counts as drawn. */
  frame = 0;

  private stamped = new WeakSet<object>();

  private root: any = null;

  tick(root: any): void {
    this.frame += 1;

    if (!this.enabled) {
      return;
    }

    this.root = root;
    const submeshes: any[] = Array.isArray(root?.submeshes) ? root.submeshes : [];

    for (const submesh of submeshes) {
      for (const mesh of submesh?.children ?? []) {
        if (mesh?.isMesh !== true || this.stamped.has(mesh)) {
          continue;
        }
        this.stamped.add(mesh);
        mesh.onAfterRender = () => {
          mesh.userData.probeFrame = this.frame;
        };
      }
    }
  }

  /** Drawn on this frame or the previous one -- the panel repaints far slower than the render loop. */
  wasDrawn = (mesh: any): boolean => {
    const stamp = mesh?.userData?.probeFrame;
    return typeof stamp === 'number' && this.frame - stamp <= 1;
  };

  read(camera: THREE.Camera | null): ModelReport {
    let frustum: THREE.Frustum | null = null;

    if (camera) {
      frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          camera.projectionMatrix, camera.matrixWorldInverse,
        ),
      );
    }

    return inspectModel(this.root, frustum, this.wasDrawn);
  }
}

/** The process-wide probe. `World` ticks it; the debug panel enables and reads it. */
export const modelProbe = new ModelProbe();

if (typeof window !== 'undefined') {
  (window as any).modelProbe = modelProbe;
}
