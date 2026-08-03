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

/**
 * Where the batch actually lands, in world space and then on screen.
 *
 * `inFrustum` alone cannot answer this. It tests the geometry's bounding SPHERE, so a mesh carrying
 * an oversized or mis-centred sphere passes from anywhere in the zone while its triangles sit
 * somewhere else entirely -- a false positive that looks exactly like a healthy report. Projecting a
 * real vertex all the way to NDC is the only reading that cannot lie about it.
 */
export interface WorldReport {
  /** Translation of the batch's `matrixWorld`. Should be the player's feet, not the world origin. */
  matrixWorldPosition: [number, number, number];
  /** The geometry's bounding sphere, taken into world space -- radius included, since a huge one is
   * itself the explanation for a frustum false positive. */
  sphereCentre: [number, number, number] | null;
  sphereRadius: number | null;
  /** The skinned sample vertex in world space. */
  sampleWorld: [number, number, number] | null;
  /** ...and projected. `w <= 0` means behind the eye, which no clamp to [-1, 1] would reveal. */
  sampleNdc: [number, number, number] | null;
  behindCamera: boolean;
  onScreen: boolean;
}

/**
 * The two factors the combiner multiplies the sampled texel by, neither of which any earlier reading
 * covered.
 *
 * Both `Combiners_Opaque` and `Combiners_Mod` compute
 *
 *   rgb = texel.rgb * vertexColor.rgb * 2.0
 *
 * and the vertex stage builds `vertexColor.rgb = animatedVertexColorRGB * 0.5`, so the surviving
 * albedo scale is exactly `animatedVertexColorRGB`. `applyDiffuseLighting` then multiplies by the
 * clamped sun lobe. Either one at zero yields a BLACK body -- which on a night scene is
 * indistinguishable from an absent one, while every other field in this report reads healthy.
 */
export interface ShadingReport {
  /** The `USE_LIGHTING` define; 0 substitutes white light and cannot darken anything. */
  useLighting: number | null;
  vertexColorRGB: [number, number, number] | null;
  vertexColorAlpha: number | null;
  sunParams: [number, number, number, number] | null;
  sunDiffuse: string | null;
  sunAmbient: string | null;
  sunIntensity: number | null;
  /** `materialParams.y` is the lighting mix: 0 lights nothing, 1 takes the sun in full. */
  materialParams: [number, number, number, number] | null;
  interiorProbe: number | null;
}

/**
 * One bound texture, named and MEASURED.
 *
 * `texturesReady` only ever established that a slot had decoded image data. It cannot distinguish a
 * correct skin from a black one, and `Combiners_Opaque` writes rgb at blending mode 0 regardless of
 * alpha -- so a black texel is a black body, fully drawn and fully opaque, which on a dark scene is
 * indistinguishable from an absent one. The mean is what separates those.
 */
export interface TextureReport {
  /** `TextureLoader` stamps the BLP path onto `name`/`sourceFile`, so this names the actual file. */
  name: string | null;
  width: number | null;
  height: number | null;
  /** DXT and friends: no flat pixel array to average, so `mean` stays null. */
  compressed: boolean;
  format: number | null;
  /** Mean RGBA over a strided sample, 0..255. Null for a compressed or dataless texture. */
  mean: [number, number, number, number] | null;
  /** Sampled pixel count, so a mean of zero over zero pixels cannot be mistaken for black. */
  sampled: number;
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
  textures: TextureReport[];
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
  /** Null when no camera was supplied. */
  world: WorldReport | null;
  shading: ShadingReport | null;
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

const _clip = new THREE.Vector4();
const _sphere = new THREE.Sphere();
const _worldPos = new THREE.Vector3();

/** Geometry vertex 0 in model space, or null when the mesh carries no positions. */
function localVertexZero(mesh: any): [number, number, number] | null {
  const position = mesh.geometry?.getAttribute?.('position');
  if (!position || position.count === 0) {
    return null;
  }
  return [position.getX(0), position.getY(0), position.getZ(0)];
}

/**
 * Take the skinned sample vertex through the rest of the pipeline: world, then clip, then NDC.
 *
 * The same three matrices the GPU uses, in the same order, so a vertex the probe places off screen
 * is off screen. That is the difference between "the body is not being drawn" and "the body is being
 * drawn somewhere you are not looking", and nothing measured so far can tell those apart.
 */
function readWorld(mesh: any, skin: SkinReport | null, camera: THREE.Camera): WorldReport {
  const matrixWorld: THREE.Matrix4 = mesh.matrixWorld;

  _worldPos.setFromMatrixPosition(matrixWorld);

  const report: WorldReport = {
    matrixWorldPosition: [_worldPos.x, _worldPos.y, _worldPos.z],
    sphereCentre: null,
    sphereRadius: null,
    sampleWorld: null,
    sampleNdc: null,
    behindCamera: false,
    onScreen: false,
  };

  // A SkinnedMesh carries its OWN bounding sphere (three computes it over the posed skeleton) and
  // leaves the geometry's null, so reading only the geometry reported "n/a" for every skinned batch.
  const sphere = mesh.boundingSphere ?? mesh.geometry?.boundingSphere;
  if (sphere) {
    _sphere.copy(sphere).applyMatrix4(matrixWorld);
    report.sphereCentre = [_sphere.center.x, _sphere.center.y, _sphere.center.z];
    report.sphereRadius = _sphere.radius;
  }

  // The skinned sample where there is one; otherwise geometry vertex 0 read here. A static batch
  // still wants locating on screen, and reading the sample only inside `readSkin` left every
  // non-skinned M2 with no world position at all.
  const local = skin?.sampleSkinned ?? skin?.samplePosition ?? localVertexZero(mesh);
  if (!local) {
    return report;
  }

  _clip.set(local[0], local[1], local[2], 1).applyMatrix4(matrixWorld);
  report.sampleWorld = [_clip.x, _clip.y, _clip.z];

  _clip.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);

  // Behind the eye. Dividing through by a non-positive w folds the point back into the visible
  // range, so this has to be read before the divide, not after.
  if (_clip.w <= 0) {
    report.behindCamera = true;
    return report;
  }

  const ndc: [number, number, number] = [
    _clip.x / _clip.w, _clip.y / _clip.w, _clip.z / _clip.w,
  ];
  report.sampleNdc = ndc;
  report.onScreen = ndc.every((n) => Number.isFinite(n))
    && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1 && ndc[2] >= -1 && ndc[2] <= 1;

  return report;
}

const vec3Of = (v: any): [number, number, number] | null =>
  (v && typeof v.x === 'number' ? [v.x, v.y, v.z] : null);

/**
 * A vec4 uniform, whether it is a `THREE.Vector4` or a plain array.
 *
 * `M2Material` declares `materialParams` as `[1, 1, 1, 1]` -- a bare array, unlike every other vec4
 * on the material. Reading only `.x` reported it as absent, which read as "the shader's lighting mix
 * is unset" when it is in fact set to 1.
 */
const vec4Of = (v: any): [number, number, number, number] | null => {
  if (v && typeof v.x === 'number') {
    return [v.x, v.y, v.z, v.w];
  }
  if (Array.isArray(v) && v.length >= 4) {
    return [v[0], v[1], v[2], v[3]];
  }
  return null;
};

const hexOf = (c: any): string | null => (c && c.getHexString ? `#${c.getHexString()}` : null);

/** How many pixels the mean is taken over. Enough to be representative, cheap enough for 4 Hz. */
const TEXTURE_SAMPLE_LIMIT = 1024;

/**
 * Name and measure one bound texture.
 *
 * The mean is taken over a STRIDED sample rather than the whole surface: a character skin is a
 * megabyte or two, the panel repaints four times a second, and a thousand pixels spread across the
 * image answers "is this black" exactly as well as all of them.
 */
export function readTexture(texture: any): TextureReport {
  const image = texture?.image;

  const report: TextureReport = {
    name: texture?.name ?? texture?.sourceFile ?? null,
    width: image?.width ?? null,
    height: image?.height ?? null,
    compressed: texture?.isCompressedTexture === true,
    format: texture?.format ?? null,
    mean: null,
    sampled: 0,
  };

  const data: ArrayLike<number> | undefined = image?.data;
  if (report.compressed || !data || data.length === 0) {
    return report;
  }

  const pixels = (report.width ?? 0) * (report.height ?? 0);
  if (pixels <= 0) {
    return report;
  }

  // Derived, not assumed: an RGB BLP gives 3 and an RGBA one gives 4, and guessing 4 for a 3-channel
  // surface would slide the sample across channels and report a colour nothing on screen has.
  const components = Math.max(1, Math.round(data.length / pixels));
  const stride = Math.max(1, Math.floor(pixels / TEXTURE_SAMPLE_LIMIT));

  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;

  for (let p = 0; p < pixels; p += stride) {
    const i = p * components;
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    a += components >= 4 ? (data[i + 3] ?? 0) : 255;
    n += 1;
  }

  if (n > 0) {
    report.mean = [r / n, g / n, b / n, a / n];
    report.sampled = n;
  }

  return report;
}

/** The albedo and lighting factors, straight off the uniforms the combiners actually read. */
function readShading(material: any): ShadingReport | null {
  const uniforms = material?.uniforms;
  if (!uniforms) {
    return null;
  }

  const define = material?.defines?.USE_LIGHTING;

  return {
    useLighting: define === undefined ? null : Number(define),
    vertexColorRGB: vec3Of(uniforms.animatedVertexColorRGB?.value),
    vertexColorAlpha: uniforms.animatedVertexColorAlpha?.value ?? null,
    sunParams: vec4Of(uniforms.sunParams?.value),
    sunDiffuse: hexOf(uniforms.sunDiffuseColor?.value),
    sunAmbient: hexOf(uniforms.sunAmbientColor?.value),
    sunIntensity: uniforms.sunIntensity?.value ?? null,
    materialParams: vec4Of(uniforms.materialParams?.value),
    interiorProbe: uniforms.interiorProbe?.value ?? null,
  };
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
    report.textures = textures.filter(Boolean).map(readTexture);
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
 * Takes the camera rather than a prebuilt frustum: the frustum is derived from it, and the same
 * camera then projects the sample vertex to NDC -- the two readings have to come from one camera or
 * they can disagree. Still pure, and a bare `PerspectiveCamera` is all a test needs; there is no
 * renderer and no loaded world in the way.
 */
export function inspectModel(
  root: any,
  camera: THREE.Camera | null,
  wasDrawn: (mesh: any) => boolean,
  /**
   * Which material to READ. Defaults to the one currently assigned, but the flat-colour bisection
   * swaps that for a `MeshBasicMaterial` -- and reading it turned the whole readout into `tex 0/0`,
   * `fade ?`, `fog unset`, hiding exactly the uniforms the bisection had just narrowed the search
   * down to. The probe passes the stashed original instead.
   */
  materialOf: (mesh: any) => any = (mesh) => mesh.material,
): ModelReport {
  const frustum = camera
    ? new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    )
    : null;

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
        textures: [],
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
        world: null,
        shading: null,
      };

      if (report.skinned) {
        report.skin = readSkin(mesh);
      }

      if (camera) {
        report.world = readWorld(mesh, report.skin, camera);
      }

      if (frustum && mesh.geometry) {
        try {
          report.inFrustum = frustum.intersectsObject(mesh);
        } catch {
          report.inFrustum = false;
        }
      }

      const material = materialOf(mesh);
      readMaterial(material, report);
      report.shading = readShading(material);
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

/** A colour string that is exactly black -- the only value that can zero a product. */
const isBlack = (hex: string | null) => hex === '#000000';

/**
 * What the two albedo factors say is wrong, or null when they cannot be blamed.
 *
 * Same rule as the others: only a fault holding for EVERY drawn batch is reported. A single dark
 * batch on a model is ordinary.
 */
export function shadingVerdict(shadings: ShadingReport[]): string | null {
  if (shadings.every((s) => {
    const v = s.vertexColorRGB;
    return v !== null && Math.max(v[0], v[1], v[2]) < 1e-6;
  })) {
    return 'the animated vertex colour is black -- both combiners compute '
      + '`texel * vertexColor * 2`, so the albedo is multiplied to zero and the body draws black';
  }

  if (shadings.every((s) => s.vertexColorAlpha === 0)) {
    return 'animatedVertexColorAlpha is zero -- Combiners_Mod writes it straight to output alpha';
  }

  // Lighting can only darken where the define enables it AND the material takes it in full;
  // `materialParams.y` below 1 mixes back toward white, which is what unlit geometry relies on.
  const lit = shadings.filter((s) => s.useLighting === 1
    && (s.materialParams === null || s.materialParams[1] > 0.999));

  if (lit.length === shadings.length && lit.length > 0
    && lit.every((s) => s.interiorProbe !== 1 && isBlack(s.sunDiffuse) && isBlack(s.sunAmbient))) {
    return 'both sun colours are pure black while lighting is enabled -- every lit pixel resolves '
      + 'to black, so the body is drawn and then shaded away';
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

  // Ahead of the draw check on purpose. A batch can be drawn AND off screen: `inFrustum` tests the
  // bounding sphere, so an oversized or mis-centred one passes from anywhere while the triangles are
  // elsewhere. Reporting "drawn, uniforms plausible" for that is the false clean bill of health this
  // check exists to remove.
  const located = visible.filter((b) => b.world?.sampleNdc || b.world?.behindCamera);
  if (located.length > 0) {
    if (located.every((b) => b.world!.behindCamera)) {
      return 'drawn, but the sampled vertex is BEHIND the eye -- the body is on the wrong side of '
        + 'the camera, not missing';
    }
    if (located.every((b) => !b.world!.onScreen)) {
      const ndc = located[0].world!.sampleNdc;
      const where = ndc ? `ndc (${ndc.map((n) => n.toFixed(2)).join(', ')})` : 'off screen';
      return `drawn, but the sampled vertex projects outside the viewport -- ${where}. The frustum `
        + 'test passed on an oversized bounding sphere';
    }
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

  // A measured-black texel, ahead of the shading factors: `Combiners_Opaque` writes rgb at blending
  // mode 0 whatever the alpha, so a black skin is a black body, and `texturesReady` cannot see it.
  const measured = drawn.filter((b) => b.textures.some((t) => t.mean !== null));
  if (measured.length === drawn.length && measured.length > 0 && measured.every(
    (b) => b.textures.every((t) => t.mean === null || Math.max(t.mean[0], t.mean[1], t.mean[2]) < 2),
  )) {
    const name = measured[0].textures.find((t) => t.mean !== null)?.name ?? 'the bound texture';
    return `drawn, but every sampled texel is black -- \`${name}\` decoded to a black surface`;
  }

  if (measured.length === drawn.length && measured.length > 0 && measured.every(
    (b) => b.textures.every((t) => t.mean === null || t.mean[3] < 2),
  ) && drawn.every((b) => b.blendingMode !== 0)) {
    return 'drawn, but every sampled texel has zero alpha, and no batch writes at blending mode 0';
  }

  // The albedo product, ahead of the alpha terms: a body multiplied to black is fully opaque and
  // fully drawn, and on a night scene it is indistinguishable from one that was never there.
  const shaded = drawn.filter((b) => b.shading !== null);
  if (shaded.length > 0) {
    const shadingFault = shadingVerdict(shaded.map((b) => b.shading as ShadingReport));
    if (shadingFault) {
      return shadingFault;
    }
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
 * Every batch mesh under an M2 root, in submesh order.
 *
 * Walks `root.submeshes` rather than `traverse`, so the bounding hull, the skeleton helper and any
 * other non-batch mesh hanging off the model cannot be mistaken for drawable geometry.
 */
export function batchMeshes(root: any): any[] {
  const submeshes: any[] = Array.isArray(root?.submeshes) ? root.submeshes : [];
  const out: any[] = [];

  for (const submesh of submeshes) {
    for (const mesh of submesh?.children ?? []) {
      if (mesh?.isMesh === true) {
        out.push(mesh);
      }
    }
  }

  return out;
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

  /**
   * Swap every batch's material for a flat unlit colour that ignores depth.
   *
   * A BISECTION, not a hypothesis. Every reading so far says the body is drawn, skinned correctly,
   * and projected to the centre of the screen -- so the pixels are either produced and then lost, or
   * the M2 fragment shader is emitting nothing usable. This separates those two: geometry, skinning,
   * placement, draw order and the render target are all shared with the real material, and only the
   * shading is replaced.
   *
   * Magenta appears  -> everything up to shading is sound; the fault is in the M2 combiner output.
   * Nothing appears  -> the draw is lost outside the material entirely (viewport, scissor, stencil,
   *                     or a render target that never reaches the canvas).
   */
  flatColor = false;

  /**
   * Whether the flat override also ignores depth. SEPARATE from `flatColor` on purpose.
   *
   * The first run of this bisection changed both at once -- flat colour AND no depth test -- so when
   * magenta appeared it could not distinguish "the combiner emits nothing" from "the body is drawn
   * and then occluded". Two variables, one observation, no conclusion. Flat colour WITH the depth
   * test is the experiment that separates them:
   *
   *   magenta with depth on  -> the draw survives depth; the fault is the combiner's own output
   *   magenta only with it off -> the pixels lose the depth test to something drawn nearer
   */
  ignoreDepth = false;

  /**
   * The SECOND bisection step, and the one that needs no numbers read back.
   *
   * Swap each batch for a `MeshBasicMaterial` carrying that batch's own first bound texture. Same
   * geometry, same UV attribute, same texture object, same skinning -- but three's own shader instead
   * of the M2 combiner, so nothing of ours is in the path.
   *
   *   appears textured -> the texture, its UVs and the skinned draw are all sound, and the fault is
   *                       in the combiner or the lighting it multiplies through
   *   appears black    -> the BLP decoded to a black surface
   *   still invisible  -> the sampled alpha is zero, or the UVs land somewhere empty
   *
   * Takes precedence over `flatColor`, since it is strictly more informative.
   */
  texturedBasic = false;

  private overridden = new Map<any, any>();

  private flatMaterial: THREE.MeshBasicMaterial | null = null;

  /** One basic material per bound texture, so a shared skin is not re-wrapped per batch. */
  private texturedMaterials = new Map<any, THREE.MeshBasicMaterial>();

  private material(): THREE.MeshBasicMaterial {
    if (!this.flatMaterial) {
      this.flatMaterial = new THREE.MeshBasicMaterial({
        color: 0xff00ff,
        fog: false,
        side: THREE.DoubleSide,
      });
    }

    // Kept in sync every frame rather than at construction, so the toggle takes effect live.
    this.flatMaterial.depthTest = !this.ignoreDepth;
    this.flatMaterial.depthWrite = !this.ignoreDepth;

    return this.flatMaterial;
  }

  /**
   * The basic material carrying `mesh`'s own first bound texture, or null when it has none to carry.
   *
   * The texture is taken from the ORIGINAL material, not the currently assigned one, so switching
   * between the two override modes cannot end up wrapping a previous override.
   */
  private texturedMaterial(mesh: any): THREE.MeshBasicMaterial | null {
    const original = this.originalMaterial(mesh);
    const bound = original?.uniforms?.textures?.value;
    const texture = Array.isArray(bound) ? bound.find((t: any) => t && t.image) : null;

    if (!texture) {
      return null;
    }

    let material = this.texturedMaterials.get(texture);
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        map: texture,
        fog: false,
        side: THREE.DoubleSide,
      });
      this.texturedMaterials.set(texture, material);
    }

    material.depthTest = !this.ignoreDepth;
    material.depthWrite = !this.ignoreDepth;

    return material;
  }

  /** Install or lift whichever override is selected. Idempotent. */
  private syncOverride(root: any): void {
    if (this.texturedBasic || this.flatColor) {
      const flat = this.material();

      for (const mesh of batchMeshes(root)) {
        if (!this.overridden.has(mesh)) {
          this.overridden.set(mesh, mesh.material);
        }

        // Falls back to flat where a batch has no usable texture, rather than silently leaving that
        // batch on the real material -- a mixed override would make the screen unreadable.
        mesh.material = this.texturedBasic
          ? (this.texturedMaterial(mesh) ?? flat)
          : flat;
      }
      return;
    }

    for (const [mesh, original] of this.overridden) {
      mesh.material = original;
    }
    this.overridden.clear();
  }

  tick(root: any): void {
    this.frame += 1;

    if (!this.enabled) {
      // Still lift a live override, or unchecking the section would leave the body overridden.
      if (this.overridden.size > 0) {
        this.flatColor = false;
        this.texturedBasic = false;
        this.syncOverride(root);
      }
      return;
    }

    this.root = root;
    this.syncOverride(root);

    for (const mesh of batchMeshes(root)) {
      if (this.stamped.has(mesh)) {
        continue;
      }
      this.stamped.add(mesh);
      mesh.onAfterRender = () => {
        mesh.userData.probeFrame = this.frame;
      };
    }
  }

  /** Drawn on this frame or the previous one -- the panel repaints far slower than the render loop. */
  wasDrawn = (mesh: any): boolean => {
    const stamp = mesh?.userData?.probeFrame;
    return typeof stamp === 'number' && this.frame - stamp <= 1;
  };

  read(camera: THREE.Camera | null): ModelReport {
    return inspectModel(this.root, camera, this.wasDrawn, this.originalMaterial);
  }

  /** The real M2 material, even while the flat-colour override is installed over it. */
  private originalMaterial = (mesh: any) =>
    (this.overridden.has(mesh) ? this.overridden.get(mesh) : mesh.material);
}

/** The process-wide probe. `World` ticks it; the debug panel enables and reads it. */
export const modelProbe = new ModelProbe();

if (typeof window !== 'undefined') {
  (window as any).modelProbe = modelProbe;
}
