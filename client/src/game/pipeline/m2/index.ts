import * as THREE from 'three';
import { BufferGeometry } from 'three';
import { Face3, Geometry } from '../../utils/geometry';
import { collisionWorld } from '../../collision/collision-world';
import { ObjectsManager } from '../../world/visibility-manager';
import BatchManager from './batch-manager';
import { attachmentLocalOffset } from './anim/axes';
import { animCounters } from './anim/counters';
import { InstanceAnim } from './anim/instance-anim';
import {
  evaluateMaterialChannels,
  MaterialChannelDefs,
  MaterialChannelValues,
  UVAnimationValue,
  VertexColorValue,
} from './anim/material-channels';
import { ModelAnim } from './anim/model-anim';
import { applyLocalPose } from './anim/pose';
import { SubmeshSkinningScope, submeshSkinningScope } from './anim/skinning-scope';
import { buildBoneHierarchy, modelSpaceBindMatrix, normalizeBoneWeights, poseBindSkeleton } from './bind-pose';
import M2Material, { collectTextureLoads, TextureLoad } from './material';
import { isParticleTemplate } from './particle/template';
import Submesh from './submesh';
import { frameTrace, traceStage } from '../../perf/frame-trace';

// Module-level scratch for `applySphericalBillboard` / `applyCylindricalZBillboard`.
//
// These ran `camera.position.clone()`, three `new THREE.Vector3` and a `new THREE.Matrix4` PER
// BILLBOARDED BONE PER FRAME, gated only on `cameraMoved` -- which is true on essentially every
// frame a player is moving or turning. That was survivable while only terrain doodads paid it;
// `WMO#animate` was an empty method before this branch, so the whole interior population of every
// loaded building now pays it too, and a city is exactly where the worst-frame metric is read.
//
// Safe to share because the two methods are strictly sequential, allocate nothing that outlives the
// call, and write their only durable output through `bone.rotation.setFromRotationMatrix` before
// returning. Nothing here is retained across a call boundary.
const billboardCamPos = new THREE.Vector3();
const billboardForward = new THREE.Vector3();
const billboardRight = new THREE.Vector3();
const billboardUp = new THREE.Vector3();
const billboardMatrix = new THREE.Matrix4();

/**
 * The GROUND SELECTION RING's model-local radius -- `sqrt(0.5 * sqrt(dx^2 + dy^2))` over the **Stand**
 * sequence's own bounding box, horizontal extents only.
 *
 * SOURCE. The reference states this byte-traced and Unicorn-emulated, reproducing the real client's
 * measured ring radii to ~1 mm: draw `0x608e00`, sizer `0x60aee0`
 * (`benilla-formats/src/models/bounds.rs:60-116` and the pinning test
 * `benilla-formats/tests/selection_ring_radius.rs`, which holds Chicken 0.572 / HumanFemale 0.731 /
 * HumanMale 0.841 / Horse 1.295 at scale 1). The world radius is this x `OBJECT_FIELD_SCALE_X`, which
 * is `Unit#renderScale`.
 *
 * IT IS **NOT** THE BOUNDING SPHERE, and the reference says why: `0.5 * renderSphere` is the CORPSE
 * decal's input (`0x5d6fe0`), and it over-sizes a tall human and under-sizes a squat chicken because a
 * sphere folds height in. The nested sqrt compresses the range instead. That test asserts the two do
 * not coincide, so a regression to the sphere cannot slip through unnoticed.
 *
 * WHICH TWO COMPONENTS ARE HORIZONTAL, established here rather than assumed. The M2 file's own frame
 * is Z UP: `createSubmeshGeometry` composes `(p0, p2, -p1)` then `makeScale(-1, -1, 1)` then
 * `rotateX(-PI/2)`, which is `(-p0, -p1, p2)` -- exactly what `createGeometry` spells out by hand at
 * its own doc comment -- into a world whose up axis is Z (`pages/game/index.tsx:133`). So components 0
 * and 1 are the horizontal pair and component 2 is height, and the extents feed the formula unswizzled,
 * the same two the reference reads.
 *
 * THE FALLBACK IS THE **VERTEX** BOX, not the collision box. The reference falls back to its
 * `bounding_box_min/max`, and our parser's names for those two boxes are SWAPPED relative to benilla's
 * (see the `vertexRadius` comment in the constructor): `minVertexBox`/`maxVertexBox` is the authored
 * RENDER box, `minBoundingBox`/`maxBoundingBox` is the collision hull's. Reading the collision box here
 * would silently size the ring off a 0.76-yd post -- round 21's finding about the pick's narrow phase.
 *
 * Returns 0 when nothing can be read; the ring then falls back to its own radius, exactly as the
 * reference does for a model-less unit.
 */
function ringFootprintOf(data: any, modelAnim: ModelAnim): number {
  const footprint = (dx: number, dy: number) => Math.sqrt(0.5 * Math.sqrt(dx * dx + dy * dy));

  // Stand is animation id 0. `resolve(0, false)` refuses to console a missing id with the first
  // playable sequence, which is what we want -- a model with no Stand must reach the header box below
  // rather than take some other clip's footprint.
  const stand = modelAnim.resolve(0, false);
  const record = stand === null ? null : (data.animations || [])[stand.index];
  if (record && record.minBoundingBox && record.maxBoundingBox) {
    const dx = record.maxBoundingBox.x - record.minBoundingBox.x;
    const dy = record.maxBoundingBox.y - record.minBoundingBox.y;
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      return footprint(dx, dy);
    }
  }

  const min = data.minVertexBox;
  const max = data.maxVertexBox;
  if (min && max) {
    const dx = max.x - min.x;
    const dy = max.y - min.y;
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      return footprint(dx, dy);
    }
  }

  return 0;
}

class M2 extends THREE.Group {
  static cache = {};

  path: string;
  data: any;
  skinData: any;
  batchManager: BatchManager;
  canInstance: boolean;
  animated: boolean;
  billboards: THREE.Bone[];
  boundingVertices: [];
  boundingNormals: [];
  boundingTriangles: [];
  vertexRadius: number;
  /**
   * MODEL-LOCAL (pre-scale) radius of the ground SELECTION RING -- `sqrt(0.5 * sqrt(dx^2 + dy^2))`
   * over the **Stand** sequence's own bounding box, horizontal extents only. Computed in
   * `ringFootprintOf`; see that function for the source and for why it is not the bounding sphere.
   */
  ringFootprint: number;
  /**
   * MODEL-GLOBAL: does this model have any animated bone at all?
   *
   * Still the right question for three places -- `createMesh` (which parents the root bones, needed
   * for billboarding via `bone.skin`), `DoodadManager#animate`'s bone-mesh gate, and `applyPose`.
   * It is NO LONGER the question asked of an individual submesh: see `submeshSkinning` below.
   */
  useSkinning: boolean;
  /**
   * PER SUBMESH INDEX (parallel to `skinData.submeshes`): draw skinned, or ride one bone?
   *
   * One animated bone anywhere used to force every submesh of the model onto `THREE.SkinnedMesh`, a
   * skinning shader variant and a bone texture. Most animated doodad submeshes ride exactly one bone,
   * and for those the bone's transform relative to bind pose simply IS the submesh's local matrix.
   * The equivalence derivation, and the two cases where it fails, live in `anim/skinning-scope.ts`.
   */
  submeshSkinning: SubmeshSkinningScope[];
  /**
   * The subset of `submeshes` with a sole bone, so the per-frame pose path does not re-scan.
   *
   * Almost always empty or very short. `applyPose` walks this rather than `this.submeshes`, so a
   * model with no single-bone submesh pays one length check per posed frame.
   */
  soleBoneSubmeshes: Submesh[];
  mesh: THREE.Mesh;
  submeshes: Submesh[];
  parts: Map<string, any>;
  geometry: BufferGeometry;
  submeshGeometries: Map<number, BufferGeometry>;
  skeleton: any;
  skeletonHelper: any;
  bones: THREE.Bone[];
  rootBones: THREE.Bone[];
  // Each bone's BIND offset from its parent, engine axes, 3 floats per bone. `applyPose` adds this
  // frame's sampled translation onto it; keeping it here means the bind pose survives being posed,
  // which reading it back off `bone.position` would not.
  boneBindPositions: Float32Array;
  batches: Map<number, any>;
  // Batches belonging to submeshes suppressed by isTemplateSubmesh(). createBatches() already
  // constructed their M2Materials (and, transitively, loaded their textures) before
  // createSubmeshes() decided to skip them, so nothing else references these materials. Without
  // this, dispose() -- which only walks this.submeshes -- would never release them, leaking a
  // material and a texture reference per emitter-only doodad on every load/unload cycle.
  suppressedBatches: any[];
  // Parsed M2Particle definitions, retained so the particle system can register emitters for this
  // model. Previously only the array's length was read, for the template-suppression check, and the
  // definitions themselves were dropped on the floor.
  particleEmitters: any[];
  // The model's texture table, retained so the particle system can resolve each emitter's
  // textureId to a filename. Previously dropped on the floor like particleEmitters was, which left
  // every particle material loading an empty placeholder path.
  textures: any[];
  // True only for the M2 instance that actually called createBatches() and therefore owns
  // this.batches. Instanced/cloned M2s share the source's this.batches (see the constructor's
  // `instance` branch and clone()) and must not dispose materials they merely borrowed.
  ownsBatches: boolean;
  /**
   * True only for the M2 that actually built `this.geometry` and `this.submeshGeometries`.
   *
   * Geometry is a PURE FUNCTION of `data` and `skinData` -- nothing in this tree writes to a
   * submesh's buffers per placement -- so every placement of a model path shares one set, whether or
   * not `canInstance` is true. `canInstance` answers a different question (it is false the moment any
   * bone is animated, `wow-data-parser/m2/index.js:169-179`), and gating geometry on it made every
   * character and creature rebuild buffers identical to the ones already in memory.
   *
   * The flag is what makes that safe. `M2Blueprint.unload` calls `dispose()` on every
   * non-instanceable M2 the moment its placement goes away, so without an ownership test the first
   * character to walk out of range would free the buffers every other character is drawing from.
   */
  ownsGeometry: boolean;
  boundingMesh: THREE.Mesh;
  /**
   * Dense per-instance phase slot for `shouldPose`'s decimation stagger, or -1 while unregistered.
   *
   * Declared here rather than stamped on as an ad-hoc property because all THREE animated
   * populations now need one -- terrain doodads (`DoodadManager#enableDoodadAnimations`), WMO
   * interior doodads (`WMO#enableDoodadAnimations`) and units (`World#animateEntities`) -- and an
   * UNDEFINED slot is silently fatal: `(frameIndex + undefined) % period` is NaN, which is never
   * `=== 0`, so the instance is simply never posed and nothing reports it. A registration site that
   * forgets to assign now falls back to a shared phase, which is merely a worse worst frame.
   */
  poseSlot: number = -1;
  /**
   * Last frame index on which this instance's bones were actually written.
   *
   * Read by `World#updateDynamicMatrices` to skip the O(bones) scene walk for everything the gates
   * rejected. `-1` means "never posed", which no real frame index equals.
   */
  poseFrame: number = -1;
  // Per-model keyframe data, shared by every placement of this model path. Immutable.
  modelAnim: ModelAnim;
  // Per-placement clock plus bone solver. Null for a model that animates nothing at all.
  instanceAnim: InstanceAnim | null;
  // The three non-bone animated channels, PER PLACEMENT. Read per draw by
  // `applyAnimatedUniformsBeforeRender` (m2/submesh.js), never pushed at a material from here: the
  // materials are cached and shared across every placement of a model.
  uvAnimationValues: UVAnimationValue[] = [];
  transparencyAnimationValues: number[] = [];
  vertexColorAnimationValues: VertexColorValue[] = [];
  // The parsed blocks the three arrays above are sampled from, plus a holder aliasing the arrays.
  // Both are built once, in `createTextureAnimations`, so the per-frame evaluator allocates nothing.
  materialChannelDefs: MaterialChannelDefs = { uv: [], transparency: [], vertexColor: [] };
  materialChannelValues: MaterialChannelValues = { uv: [], transparency: [], vertexColor: [] };

  /**
   * `sharedModelAnim` is a SEPARATE parameter from `instance` on purpose.
   *
   * `instance` carries the geometry/batch sharing, and `clone()` sets it to null unless
   * `data.canInstance` -- which the parser makes false the moment ANY bone is animated or
   * billboarded (`wow-data-parser/m2/index.js:169-179`). Hanging `modelAnim` off `instance` would
   * therefore have shared it for exactly the models that need it least, and rebuilt a sequence
   * table plus a whole-model `classify()` walk per placement for every bone-animated model -- the
   * opposite of the point. Geometry sharing and animation-data sharing are answers to different
   * questions and are now passed separately.
   */
  constructor(path, data, skinData, instance = null, sharedModelAnim: ModelAnim | null = null) {
    super();

    this.visible = false;

    this.matrixAutoUpdate = false;

    this.name = path.split('\\').slice(-1).pop();
    this.path = path;
    this.data = data;
    this.skinData = skinData;

    // Instanceable M2s share geometry, texture units, and animations.
    this.canInstance = data.canInstance;

    // `this.animated` is assigned below, from `ModelAnim.classify(data)` rather than the parser's
    // own `data.animated` getter. They are NOT the same predicate, in two directions:
    //   * `data.animated` also returns true for a purely BILLBOARDED bone. `classify()` asks only
    //     "is there anything to sample?", which is the right question for posing -- billboarding is
    //     handled by `applyBillboards`, off a separate `this.billboards` list. Callers that build a
    //     per-frame set must therefore test BOTH; see `doodad-manager.js#loadDoodad`.
    //   * `classify()` rejects a lone identity-valued transparency/colour key, which the parser's
    //     rule also does for transparency; see `blockAnimatedBeyondIdentity` in model-anim.ts.

    this.billboards = [];
    // The AUTHORED render bounding-sphere radius (M2 header, immediately after the vertex box).
    // This is benilla's `bounding_sphere_radius`, the one the doodad fade law buckets on -- NOT
    // `data.boundingRadius`, which is the COLLISION sphere. The two names are swapped relative to
    // benilla's parser (benilla-m2/src/lib.rs:162 reads the field our parser calls `vertexRadius`);
    // see pipeline/m2/fade/laws.ts.
    this.vertexRadius = data.vertexRadius ?? 0;

    this.boundingVertices = data.boundingVertices;
    this.boundingNormals = data.boundingNormals;
    this.boundingTriangles = data.boundingTriangles;

    this.batchManager = new BatchManager(data, skinData);

    // Keep track of whether or not to use skinning. If the M2 has bone animations, useSkinning is
    // set to true, and all meshes and materials used in the M2 will be skinning enabled. Otherwise,
    // skinning will not be enabled. Skinning has a very significant impact on the render loop in
    // three.js.
    this.useSkinning = false;

    this.mesh = null;
    this.submeshes = [];
    this.submeshSkinning = [];
    this.soleBoneSubmeshes = [];
    this.suppressedBatches = [];
    this.particleEmitters = data.particleEmitters || [];
    this.textures = data.textures || [];
    this.parts = new Map();

    this.geometry = null;
    this.submeshGeometries = new Map();

    this.skeleton = null;
    this.skeletonHelper = null;
    this.bones = [];
    this.rootBones = [];

    // Per-model animation data is shared across EVERY placement -- built once for the source M2 and
    // handed to each clone, never rebuilt. The old AnimationManager was shared the same way, but
    // createSkeleton() below then registered THIS clone's bone tracks into it, so every placement
    // appended its own copy of every track to the shared clips. That is the bug that got the whole
    // animation system commented out; ModelAnim holds keyframes and nothing placement-specific.
    this.modelAnim = sharedModelAnim || new ModelAnim(data);

    this.animated = this.modelAnim.animated;
    this.instanceAnim = this.animated ? new InstanceAnim(this.modelAnim) : null;

    // After `modelAnim`, because the Stand sequence is resolved through it.
    this.ringFootprint = ringFootprintOf(data, this.modelAnim);

    traceStage('m2.skeleton', path, () => this.createSkeleton(data.bones));

    // PER PLACEMENT, outside the `instance` branch below on purpose. These are this placement's own
    // sampled UV / transparency / colour slots, not shared state: an instanced clone took the
    // BATCHES from its source, and the whole point of Task 14 is that the values pushed into those
    // shared materials come from the placement being drawn. Built inside the else-branch, as it was,
    // every clone of an instanceable model kept empty arrays -- and `canInstance` is false only when
    // a BONE is animated, so the models that clone are exactly the UV/transparency-animated ones
    // this task exists for. Their animation would have been dropped on the floor.
    traceStage('m2.texAnim', path, () => this.createTextureAnimations(data));

    // BEFORE createBatches, which needs the per-submesh answer to set each batch material's skinning
    // flag, and before createSubmeshes, which needs it to pick the mesh class.
    //
    // The clone-sharing below saves LESS than it looks, and the comment that claimed otherwise has
    // been corrected rather than the code: `canInstance` is false the moment any bone is animated,
    // and `useSkinning` is set from exactly that (`bind-pose.ts`: `boneDef.animated`). So
    // `canInstance` implies `!useSkinning`, `submeshSkinningScope` short-circuits to `SCOPE_STATIC`
    // before it ever calls `submeshBoneSet`, and the table an instanceable clone inherits is always
    // ALL-STATIC -- there is no triangle walk to save on that path. What sharing actually saves is
    // one array of short-circuiting calls per clone; the O(indices) walk only ever runs for
    // NON-instanceable models, which recompute here regardless. It runs beside
    // `createSubmeshGeometry`, already O(vertices) per submesh on the same path, so it is cheap
    // where it does run. The sharing is kept because it is free and correct, not because it is the
    // optimization it was documented as.
    this.submeshSkinning = (instance && instance.submeshSkinning)
      ? instance.submeshSkinning
      : traceStage('m2.skinScope', path, () => this.computeSubmeshSkinning(data, skinData));

    // Geometry and batches are now TWO independent sharing decisions, because they answer two
    // different questions. Buffers are the same for every placement of a path and are never written
    // per placement, so they are always shared. MATERIALS are not: a character's batch materials
    // carry THAT character's composited skin, hair and cape (`Submesh#setCharacterTextures`), so
    // they may only be shared for an instanceable model, which is what `instance.batches` means.
    if (instance && instance.batches) {
      this.batches = instance.batches;
      this.ownsBatches = false;
    } else {
      traceStage('m2.batches', path, () => this.createBatches());
      this.ownsBatches = true;
    }

    if (instance && instance.geometry) {
      this.geometry = instance.geometry;
      this.submeshGeometries = instance.submeshGeometries;
      this.ownsGeometry = false;
    } else {
      traceStage('m2.geometry', path, () => this.createGeometry(data.vertices));
      this.ownsGeometry = true;
    }

    this.createMesh(this.geometry, this.skeleton, this.rootBones);
    traceStage('m2.submeshes', path, () => this.createSubmeshes(data, skinData));
    this.geometry.computeBoundingBox();
    this.boundingMesh = traceStage('m2.hull', path,
      () => this.createBoundingMesh(this.boundingVertices));

    ObjectsManager.push(this);
  }

  createBoundingMesh(vertices) {

    let mesh;
    
    const material = new THREE.MeshBasicMaterial({ wireframe: false, transparent: true, opacity: 0 });
    const geometry = new Geometry();
    // make geometry
    for (let vertexIndex = 0, len = vertices.length; vertexIndex < len; ++vertexIndex) {
      const vertex = vertices[vertexIndex];
      geometry.vertices.push(
        new THREE.Vector3(vertex.x, vertex.y, -vertex.z)
      );
    }

    // Make faces
    for (let i = 0; i < this.boundingTriangles.length; i += 3) {
      geometry.faces.push(new Face3(this.boundingTriangles[i],
                                          this.boundingTriangles[i + 1],
                                          this.boundingTriangles[i + 2]));
    }

    // Rotate
    const matrix = new THREE.Matrix4();
    matrix.makeScale(-1, 1, 1);
    geometry.applyMatrix4(matrix);
    geometry.rotateX(-Math.PI);

    // Build mesh
    const bufferGeometry = geometry.toBufferGeometry();
    // bufferGeometry.computeBoundsTree();
    mesh = new THREE.Mesh(bufferGeometry, material);
    mesh.name = 'BoundingMesh';
    mesh.matrixAutoUpdate = this.matrixAutoUpdate;

    // NEVER DRAWN. This is the model's authored COLLISION hull (`boundingVertices` /
    // `boundingTriangles`); `collision/doodad-provider.ts` reads its triangles straight off the
    // geometry and never through the renderer, so submitting it as a draw buys nothing and costs
    // correctness.
    //
    // It used to be `visible = true`, and the material's `opacity: 0` made that look free. It was
    // not. The material is `transparent: true`, so the draw lands in three's TRANSPARENT pass, and
    // its `depthWrite` was left at three's default `true` -- so an invisible box wrote depth over
    // its own silhouette. What that occludes depends on draw order, and the order is not fixed:
    // three sorts the transparent list by each geometry's BOUNDING-SPHERE CENTRE in view space
    // (`three.cjs:77863-77880`, then `reversePainterSortStable` at `:68120`), so as a model turns,
    // the hull's centre crosses other batches' centres and the hull moves from last in the list to
    // first.
    //
    // Measured on the glue character (`HumanMale.m2`, hull = 8 vertices / 12 triangles, i.e. a box):
    // at facing 0 the draw order is `hair:12` then `HULL`, and the hair renders; at facing 300 it is
    // `HULL` then `hair:12`, and the hair vanishes entirely. Setting the hull's `colorWrite = false`
    // changed nothing and `depthWrite = false` restored the hair, which is what pins the mechanism to
    // depth rather than colour -- the material contributes no colour at all (three's NormalBlending
    // for a non-premultiplied material multiplies RGB by a source alpha of 0). The same depth write
    // is what put a pale rectangle on the road around the character's feet: it cut the stage's own
    // transparent ground layer inside the hull's footprint.
    //
    // This is a PIPELINE-WIDE defect, not a glue one -- every doodad, WMO doodad and unit in the
    // world has been drawing one of these.
    mesh.visible = false;

    // Collision geometry is OPTIONAL in M2: plenty of models ship none at all (a rope coil, a
    // decal, most effects), and for those this mesh is empty -- its bounding box comes out inverted
    // infinite, which no query can ever intersect. Registering it anyway costs every cast in the
    // game one wasted whole-hull rejection, forever, and inflates the registered-hull readout past
    // any use. Measured: 2519 hulls registered against 936 live doodads.
    if (this.boundingTriangles.length > 0 && vertices.length > 0) {
      collisionWorld.doodads.add(mesh);
    }


    this.add(mesh);

    return mesh;
  }

  createSkeleton(boneDefs) {
    // The hierarchy build lives in bind-pose.ts so that `anim/__tests__/pose.test.ts` exercises the
    // same code production does, instead of a hand-mirrored copy that would drift silently.
    const { bones, rootBones, billboards, bindPositions, useSkinning } =
      buildBoneHierarchy(boneDefs);

    // Preserve the bones
    this.bones = bones;
    this.rootBones = rootBones;
    this.billboards = billboards;
    this.boneBindPositions = bindPositions;

    // OR rather than assign: `useSkinning` is initialised in the constructor and nothing else sets
    // it before this point, but a future caller that did must not have its answer discarded.
    this.useSkinning = this.useSkinning || useSkinning;

    // Assemble the skeleton from the MODEL-SPACE bind pose. `new THREE.Skeleton(bones)` on its own
    // takes its bone inverses from bones that have never been through updateMatrixWorld, so every
    // inverse comes out identity -- which makes each palette entry the bone's full world matrix and
    // sends the skinned bounding sphere to roughly twice the model's world position. three then
    // culls the mesh and the body draws nothing. See bind-pose.ts.
    this.skeleton = poseBindSkeleton(rootBones, bones);

    this.skeleton.matrixAutoUpdate = this.matrixAutoUpdate;
  }

  /**
   * Decide, per submesh index, whether it needs the skinning path.
   *
   * Parallel to `skinData.submeshes` -- indexed by submesh INDEX, not by position in
   * `this.submeshes`, which skips suppressed particle templates.
   */
  computeSubmeshSkinning(data, skinData): SubmeshSkinningScope[] {
    const defs = (skinData && skinData.submeshes) || [];
    const scopes: SubmeshSkinningScope[] = [];

    for (let i = 0, len = defs.length; i < len; ++i) {
      scopes.push(submeshSkinningScope(
        defs[i],
        skinData,
        data.vertices,
        data.bones,
        this.useSkinning,
      ));
    }

    return scopes;
  }

  /** The skinning decision for one submesh index, falling back to the old model-global answer. */
  skinningScopeFor(submeshIndex: number): SubmeshSkinningScope {
    return this.submeshSkinning[submeshIndex] || { skinned: this.useSkinning, soleBone: -1 };
  }

  // Returns a map of M2Materials indexed by submesh. Each material represents a batch,
  // to be rendered in the order of appearance in the map's entry for the submesh index.
  createBatches() {
    const batches = new Map();

    const batchDefs = this.batchManager.createDefs();

    const batchLen = batchDefs.length;
    for (let batchIndex = 0; batchIndex < batchLen; ++batchIndex) {
      const batchDef = batchDefs[batchIndex];

      const { submeshIndex } = batchDef;

      if (!batches.has(submeshIndex)) {
        batches.set(submeshIndex, []);
      }

      // Array that will contain materials matching each batch.
      const submeshBatches = batches.get(submeshIndex);

      // PER SUBMESH now, not the model-global flag -- each batch belongs to exactly one submesh
      // index, so its material is only ever used by that submesh's mesh. Note that `M2Material`
      // itself currently ignores this field (`material/index.ts` has the `skinning: true` super()
      // call commented out); the real program split comes from three, whose program cache key
      // includes `object.isSkinnedMesh`. A material drawn only by a plain `THREE.Mesh` therefore
      // compiles one variant instead of the skinning one, which is where `programs` drops.
      batchDef.useSkinning = this.skinningScopeFor(submeshIndex).skinned;
      const batchMaterial = new M2Material(this, batchDef);

      submeshBatches.unshift(batchMaterial);
    }

    this.batches = batches;
  }

  /**
   * The ROOT mesh's geometry: every vertex of the model, no faces.
   *
   * BUILT STRAIGHT INTO TYPED ARRAYS, and that is the whole point of this method. It used to go
   * through the legacy `Geometry` (`utils/geometry.ts`) and `toBufferGeometry()`, and a face-less
   * geometry takes a path in there that nobody meant to be on:
   *
   *     // DirectGeometry#fromGeometry, utils/geometry.ts:1886-1896
   *     if ( vertices.length > 0 && faces.length === 0 ) {
   *       const triangles = THREE.ShapeUtils.triangulateShape ( vertices, holes );
   *
   * -- so every vertex of the model was handed to an EAR-CLIPPING POLYGON TRIANGULATOR as if the
   * vertex list were the outline of a 2D shape. `triangulateShape` is quadratic in the contour
   * length, and a character model's contour is 4-6 thousand points. MEASURED, walking, ANGLE
   * backend: `m2.geometry` took 712.5 / 610.3 / 598.7 / 423.7 / 367.9 ms on the five character-model
   * constructions in one 43 s walk -- 88 to 92 % of a whole `m2.clone`, which is where the 813 ms
   * per character came from. The triangles it produced were meaningless (an arbitrary 3D point set
   * is not a polygon) and were never drawn: `createMesh` sets `mesh.visible = false`, the SUBMESHES
   * carry everything that reaches the screen, and this geometry exists only to host the skeleton
   * bind and to supply `boundingBox` to `visibility-manager.js#refreshWorldBoundingBox`.
   *
   * One O(vertices) pass, no intermediate objects, no faces, no triangulation.
   *
   * The transform is the SAME one the old two-step applied, composed by hand. Source order is
   * (X, Z, -Y), then `makeScale(-1, -1, 1)`, then `rotateX(-PI/2)` which maps (x, y, z) to
   * (x, z, -y); composing the three gives (-position[0], -position[1], position[2]). It must stay
   * identical to `createSubmeshGeometry`, which still goes the legacy route because it has real
   * faces and real UVs to carry.
   *
   * The bounding box that comes out is now the box of EVERY vertex. The old one was the box of
   * whatever subset the triangulator's output happened to reference, which is a subset -- so a
   * model's world bounds can only have grown, never shrunk, and can only cull less eagerly.
   */
  createGeometry(vertices) {
    const count = vertices.length;
    const positions = new Float32Array(count * 3);
    const skinIndices = new Float32Array(count * 4);
    const skinWeights = new Float32Array(count * 4);

    for (let i = 0; i < count; ++i) {
      const vertex = vertices[i];
      const { position, boneIndices } = vertex;

      positions[i * 3] = -position[0];
      positions[i * 3 + 1] = -position[1];
      positions[i * 3 + 2] = position[2];

      // M2 stores bone weights as four bytes summing to 255; three's skinning expects them to sum
      // to 1. Handing over the raw bytes scales every vertex by ~255.
      const weights = normalizeBoneWeights(vertex.boneWeights);

      for (let j = 0; j < 4; ++j) {
        skinIndices[i * 4 + j] = boneIndices[j];
        skinWeights[i * 4 + j] = weights[j];
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

    this.geometry = geometry;
  }

  createMesh(bufferGeometry: THREE.BufferGeometry, skeleton, rootBones) {
    let mesh;

    if (this.useSkinning) {
      // console.log(geometry)
      // console.log(bufferGeometry)
      mesh = new THREE.SkinnedMesh(bufferGeometry);
      // console.log("mesh", mesh)
      // Assign root bones to mesh

      rootBones.forEach((bone) => {
        mesh.add(bone);
        bone.skin = mesh;
      });

      // Bind with an EXPLICIT matrix: `bind(skeleton)` alone re-runs calculateInverses() as a side
      // effect, throwing away the bind pose computed above.
      mesh.bind(skeleton, modelSpaceBindMatrix());
    } else {
      mesh = new THREE.Mesh(bufferGeometry);
    }

    mesh.matrixAutoUpdate = this.matrixAutoUpdate;

    // Never display the mesh
    // TODO: We shouldn't really even have this mesh in the first place, should we?
    mesh.visible = false;

    // Add mesh to the group
    this.add(mesh);

    // Assign as root mesh
    this.mesh = mesh;
  }

  createSubmeshes(data, skinData) {
    const { vertices } = data;
    const { submeshes, indices, triangles } = skinData;

    const emitterCount = this.particleEmitters.length;
    const submeshCount = submeshes.length;

    const subLen = submeshes.length;

    // Per-submesh geometry-build timings, gathered ONLY while the trace is on, and reported as one
    // mark at the end. This is the instrument that separates the two candidate explanations for the
    // 800 ms character clone: real O(submeshes x vertices) work spreads the total evenly across
    // `built` builds, while a garbage collection landing inside the clone concentrates it in one.
    // Per-build marks would have been 61 rows per character and would have flushed the ring.
    const geomTimes: number[] | null = frameTrace.enabled ? [] : null;

    for (let submeshIndex = 0; submeshIndex < subLen; ++submeshIndex) {
      const submeshDef = submeshes[submeshIndex];

      // Bring up relevant batches and geometry.
      const submeshBatches = this.batches.get(submeshIndex);
      let submeshGeometry = this.submeshGeometries.get(submeshIndex);

      if (!submeshGeometry) {
        const t0 = geomTimes ? performance.now() : 0;
        submeshGeometry = this.createSubmeshGeometry(submeshDef, indices, triangles, vertices);
        if (geomTimes) {
          geomTimes.push(performance.now() - t0);
        }
      }

      if (this.isTemplateSubmesh(submeshGeometry, emitterCount, submeshCount)) {
        if (submeshBatches) {
          this.suppressedBatches.push(...submeshBatches);
        }

        continue;
      }

      const submesh = this.createSubmesh(submeshDef, submeshGeometry, submeshBatches, submeshIndex);

      this.parts.set(submesh.userData.partID, submesh);
      this.submeshes.push(submesh);

      // Built here rather than derived per frame -- see the field's doc.
      if (submesh.soleBoneIndex >= 0) {
        this.soleBoneSubmeshes.push(submesh);
      }

      this.submeshGeometries.set(submeshIndex, submeshGeometry);

      this.add(submesh);
    }

    if (geomTimes && geomTimes.length > 0) {
      let total = 0;
      let max = 0;
      for (let i = 0; i < geomTimes.length; ++i) {
        total += geomTimes[i];
        max = Math.max(max, geomTimes[i]);
      }
      frameTrace.mark(
        'm2.submeshGeom',
        total,
        `${this.path} built=${geomTimes.length}/${subLen} verts=${vertices.length} max=${max.toFixed(1)}`,
      );
    }
  }

  /**
   * A particle emitter's template quad, which the particle system draws rather than the scene graph.
   */
  isTemplateSubmesh(geometry, emitterCount, submeshCount) {
    if (emitterCount === 0 || submeshCount !== 1) {
      return false;
    }

    const position = geometry && geometry.getAttribute && geometry.getAttribute('position');

    if (!position) {
      return false;
    }

    const vertexCount = position.count;
    const triangleCount = geometry.index ? geometry.index.count / 3 : vertexCount / 3;

    return isParticleTemplate({ emitterCount, submeshCount, vertexCount, triangleCount });
  }

  createSubmeshGeometry(submeshDef, indices, triangles, vertices) {
    const geometry = new Geometry();
    
    // TODO: Figure out why this isn't cloned by the line above
    // geometry.skinIndices = Array.from(this.geometry.skinIndices);
    // geometry.skinWeights = Array.from(this.geometry.skinWeights);

    for (let vertexIndex = 0, len = vertices.length; vertexIndex < len; ++vertexIndex) {
      const vertex = vertices[vertexIndex];

      const { position } = vertex;

      geometry.vertices.push(
        // Provided as (X, Z, -Y)
        new THREE.Vector3(position[0], position[2], -position[1])
      );

      geometry.skinIndices.push(
        new THREE.Vector4(...vertex.boneIndices)
      );

      // M2 stores bone weights as four bytes summing to 255; three's skinning expects them to sum
      // to 1. Handing over the raw bytes scales every vertex by ~255.
      geometry.skinWeights.push(
        new THREE.Vector4(...normalizeBoneWeights(vertex.boneWeights))
      );
    }

    const uvs = [];
    // The SECOND texcoord set. An M2 vertex carries two (`wow-data-parser/m2/index.js`'s `Vertex`:
    // `textureCoords: Array(float32array2, 2)`), and only the first was ever pushed -- so the `uv2`
    // attribute that `vertex/common-header.glsl` declares did not exist on any geometry, and GL fed
    // the shader the default (0, 0) for it. Both variants that read `uv2` were therefore sampling one
    // texel of their layer: `Diffuse_T1_T2` (real, non-zero second coords measured on
    // `UI_MainMenu_Northrend` -- the LOGIN screen -- 2467 of 11728 vertices, and on `UI_DeathKnight`,
    // 964 of 7232) and now `Diffuse_T2`.
    //
    // Uploaded only when the set carries something, tracked by `anyUvs2` below. The overwhelming
    // majority of models leave it entirely zero -- measured: 9 of the 11 `UI_*` glue models, all zero
    // -- and every doodad, WMO doodad and creature in the world goes through this same builder. An
    // unconditional second attribute would cost 8 bytes per emitted vertex across all of them for data
    // GL already supplies for free: an attribute a shader declares but the geometry lacks reads as
    // (0, 0), which is exactly what an all-zero set would have said.
    const uvs2 = [];
    let anyUvs2 = false;

    const { startTriangle: start, triangleCount: count } = submeshDef;
    for (let i = start, faceIndex = 0; i < start + count; i += 3, ++faceIndex) {
      const vindices = [
        indices[triangles[i]],
        indices[triangles[i + 1]],
        indices[triangles[i + 2]]
      ];

      const face = new Face3(vindices[0], vindices[1], vindices[2]);

      geometry.faces.push(face);

      uvs[faceIndex] = [];
      uvs2[faceIndex] = [];
      for (let vinIndex = 0, vinLen = vindices.length; vinIndex < vinLen; ++vinIndex) {
        const index = vindices[vinIndex];

        const { textureCoords, normal } = vertices[index];

        uvs[faceIndex].push(new THREE.Vector2(textureCoords[0][0], textureCoords[0][1]));
        uvs2[faceIndex].push(new THREE.Vector2(textureCoords[1][0], textureCoords[1][1]));
        anyUvs2 = anyUvs2 || textureCoords[1][0] !== 0 || textureCoords[1][1] !== 0;

        // Same (X, Z, -Y) swizzle the positions get above. Pushed raw, the normals stayed in the
        // model's own axes while the positions moved into engine axes, so lighting arrived from the
        // wrong direction -- canopies were lit from underneath.
        face.vertexNormals.push(new THREE.Vector3(normal[0], normal[2], -normal[1]));
      }
    }

    // Mirror geometry over X and Y axes and rotate.
    // Deliberately after the faces exist: applyMatrix4 transforms face normals as well as vertices,
    // and running it before the normals were pushed left them untransformed.
    const matrix = new THREE.Matrix4();
    matrix.makeScale(-1, -1, 1);
    geometry.applyMatrix4(matrix);
    geometry.rotateX(-Math.PI / 2);

    // Slot 1 goes through the same legacy-Geometry door slot 0 does: `DirectGeometry#fromGeometry`
    // (`utils/geometry.ts:1829`) reads `faceVertexUvs[1]` into `uvs2`, and `toBufferGeometry` turns
    // that into the `uv2` BufferAttribute. Deliberately NOT swizzled -- the `makeScale(-1, -1, 1)`
    // mirror and the `rotateX` above are geometry-space operations and `applyMatrix4` never touches
    // `faceVertexUvs`; see `anim/material-channels.ts:13-18` for why texture space must stay exactly
    // as the file authored it.
    geometry.faceVertexUvs = anyUvs2 ? [uvs, uvs2] : [uvs];


    const bufferGeometry =  geometry.toBufferGeometry();
    // bufferGeometry.computeBoundsTree();
    return bufferGeometry;
  }

  createSubmesh(submeshDef, geometry, batches, submeshIndex = -1) {
    const rootBone = this.bones[submeshDef.rootBone];
    const scope = this.skinningScopeFor(submeshIndex);

    const opts = {
      skeleton: this.skeleton,
      geometry,
      rootBone,
      useSkinning: scope.skinned,
      soleBoneIndex: scope.soleBone,
      matrixAutoUpdate: this.matrixAutoUpdate,
      ownsGeometry: this.ownsGeometry,
    };

    const submesh = new Submesh(opts);

    submesh.applyBatches(batches);

    submesh.userData.partID = submeshDef.partID;

    return submesh;
  }

  createTextureAnimations(data) {
    // `this.textureAnimations = new THREE.Object3D()` used to live here. Nothing ever read it -- and
    // now that this method runs per PLACEMENT rather than per model path, it would have been one
    // pointless Object3D per doodad in the world.
    this.uvAnimationValues = [];
    this.transparencyAnimationValues = [];
    this.vertexColorAnimationValues = [];

    const { uvAnimations, transparencyAnimations, vertexColorAnimations } = data;

    this.createUVAnimations(uvAnimations);
    this.createTransparencyAnimations(transparencyAnimations);
    this.createVertexColorAnimations(vertexColorAnimations);

    // The defs are kept alongside the value slots so `evaluateMaterialChannels` can pair them
    // without reaching back into `this.data` (which an entity model may not carry) and without
    // building a holder object per frame.
    this.materialChannelDefs = {
      uv: uvAnimations || [],
      transparency: transparencyAnimations || [],
      vertexColor: vertexColorAnimations || [],
    };

    // Aliases, not copies -- `submesh.js` reads the three named arrays directly.
    this.materialChannelValues = {
      uv: this.uvAnimationValues,
      transparency: this.transparencyAnimationValues,
      vertexColor: this.vertexColorAnimationValues,
    };
  }

  createUVAnimations(uvAnimationDefs) {
    if (uvAnimationDefs.length === 0) {
      return;
    }

    uvAnimationDefs.forEach((uvAnimationDef, index) => {
      // Identity defaults: no scroll, no spin, unit scale. `translation` used to default to
      // (1, 1, 1), which is a full-texture offset rather than "none" -- harmless while nothing read
      // it, wrong now that it is a real sample slot.
      this.uvAnimationValues[index] = {
        translation: [0.0, 0.0, 0.0],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scaling: [1.0, 1.0, 1.0],
        matrix: new THREE.Matrix4()
      };
    });
  }

  createTransparencyAnimations(transparencyAnimationDefs) {
    if (transparencyAnimationDefs.length === 0) {
      return;
    }

    transparencyAnimationDefs.forEach((transparencyAnimationDef, index) => {
      this.transparencyAnimationValues[index] = 1.0;
    });
  }

  createVertexColorAnimations(vertexColorAnimationDefs) {
    if (vertexColorAnimationDefs.length === 0) {
      return;
    }

    vertexColorAnimationDefs.forEach((vertexColorAnimationDef, index) => {
      this.vertexColorAnimationValues[index] = {
        color: [1.0, 1.0, 1.0],
        alpha: 1.0
      };
    });
  }

  /**
   * Adopt a static -> ANIMATED flip caused by an external `.anim` merge.
   *
   * `this.animated` and `this.instanceAnim` are decided at construction, but `modelAnim.animated`
   * is recomputed whenever a sibling `.anim` lands -- and for a model whose only real authoring is
   * external, that recompute is the first time the answer is yes. Nothing else would ever notice:
   * a static placement holds no instance, is not in any per-frame set, and would stand in bind pose
   * for ever with correct keys sitting in the table beside it.
   *
   * There is nothing to rebuild on the RENDER side, which is what makes this a two-field flip
   * rather than a reload. `useSkinning`, the skeleton and the `SkinnedMesh` choice all come from the
   * parser's own `boneDef.animated`, which is slot-blind -- it sees the quarantined tracks as keys
   * and is already true for an external-only bone. Only `ModelAnim.classify` is slot-aware, and
   * only it was wrong.
   *
   * Idempotent, allocation-free once it has flipped, and one field compare when it has not, so it
   * is safe to call from a per-frame loop. It only ever flips ONE way: a merge can add playable
   * data and never removes any.
   *
   * @returns whether this call flipped it.
   */
  syncMergedAnimation(): boolean {
    if (this.animated || !this.modelAnim || !this.modelAnim.animated) {
      return false;
    }
    this.animated = true;
    if (!this.instanceAnim) {
      this.instanceAnim = new InstanceAnim(this.modelAnim);
    }
    return true;
  }

  /**
   * Sample THIS placement's UV, transparency and vertex-colour channels into its own value slots.
   *
   * The sampling itself lives in `anim/material-channels.ts` -- `M2` is untestable directly (its
   * constructor reaches for `collisionWorld` and `ObjectsManager`), and the coordinate-space
   * reasoning for these channels is documented there.
   *
   * Deliberately NOT gated on `useSkinning`, and deliberately not folded into the pose path: a
   * waterfall that scrolls or a glow that pulses may have no animated bone at all, and a doodad the
   * distance/bone-budget gates denied still has to keep scrolling.
   */
  evaluateMaterialChannels(worldClockMs: number) {
    evaluateMaterialChannels(
      this.modelAnim,
      this.instanceAnim,
      this.materialChannelDefs,
      this.materialChannelValues,
      worldClockMs,
    );
  }

  /**
   * Push this frame's solved pose into the three.js bone hierarchy.
   *
   * The mechanism, and why it is bone TRS rather than a palette write, lives on `applyLocalPose` in
   * `anim/pose.ts` -- along with the invariant its tests pin. This method is the `M2`-shaped wrapper
   * around it.
   *
   * Only called for instances actually posed this frame, so a gated doodad costs nothing here.
   */
  applyPose() {
    const inst = this.instanceAnim;
    if (!inst) {
      return;
    }

    // An unarmed instance has not allocated its buffers yet -- see InstanceAnim's lazy allocation.
    if (inst.localTRS.length === 0) {
      return;
    }

    applyLocalPose(this.bones, this.boneBindPositions, inst.localTRS);

    // Single-bone submeshes are NOT on the skeleton -- they carry the bone's transform as their own
    // local matrix instead, which is why they need no skinning shader and no bone texture. The
    // palette they read was filled by `solveBones` immediately before this call (see
    // `DoodadManager#poseDoodad`), and the same `poseFrame` stamp that gets the bones re-accumulated
    // gets these matrices composed into `matrixWorld`.
    //
    // NOT `uploadPalette`, which the brief named and which does not exist: writing into
    // `skeleton.boneMatrices` is impossible here (`anim/pose.ts` reason 1).
    const sole = this.soleBoneSubmeshes;
    for (let i = 0, len = sole.length; i < len; ++i) {
      sole[i].applySoleBone(inst.palette);
    }

    animCounters.posesApplied++;
  }

  applyBillboards(camera) {
    for (let i = 0, len = this.billboards.length; i < len; ++i) {
      const bone = this.billboards[i];

      switch (bone.userData.billboardType) {
        case 0:
          this.applySphericalBillboard(camera, bone);
          break;
        case 3:
          this.applyCylindricalZBillboard(camera, bone);
          break;
        default:
          break;
      }
    }
  }

  applySphericalBillboard(camera, bone) {
    const boneRoot = bone.skin;

    if (!boneRoot) {
      return;
    }

    // `copy` then `worldToLocal`, NOT `worldToLocal(clone())`: same result, no allocation.
    const camPos = this.worldToLocal(billboardCamPos.copy(camera.position));

    const modelForward = billboardForward.set(camPos.x, camPos.y, camPos.z);
    modelForward.normalize();

    const modelVmEl = boneRoot.modelViewMatrix.elements;
    const modelRight = billboardRight.set(modelVmEl[0], modelVmEl[4], modelVmEl[8]);
    modelRight.multiplyScalar(-1);

    const modelUp = billboardUp.set(0, 0, 0);
    modelUp.crossVectors(modelForward, modelRight);
    modelUp.normalize();

    const rotateMatrix = billboardMatrix;

    rotateMatrix.set(
      modelForward.x,   modelRight.x,   modelUp.x,  0,
      modelForward.y,   modelRight.y,   modelUp.y,  0,
      modelForward.z,   modelRight.z,   modelUp.z,  0,
      0,                0,              0,          1
    );

    bone.rotation.setFromRotationMatrix(rotateMatrix);
  }

  applyCylindricalZBillboard(camera, bone) {
    const boneRoot = bone.skin;

    if (!boneRoot) {
      return;
    }

    const camPos = this.worldToLocal(billboardCamPos.copy(camera.position));

    const modelForward = billboardForward.set(camPos.x, camPos.y, camPos.z);
    modelForward.normalize();

    const modelVmEl = boneRoot.modelViewMatrix.elements;
    const modelRight = billboardRight.set(modelVmEl[0], modelVmEl[4], modelVmEl[8]);

    const modelUp = billboardUp.set(0, 0, 1);

    const rotateMatrix = billboardMatrix;

    rotateMatrix.set(
      modelForward.x,   modelRight.x,   modelUp.x,  0,
      modelForward.y,   modelRight.y,   modelUp.y,  0,
      modelForward.z,   modelRight.z,   modelUp.z,  0,
      0,                0,              0,          1
    );

    bone.rotation.setFromRotationMatrix(rotateMatrix);
  }

  /**
   * Point every submesh's materials at a `CreatureDisplayInfo` row's skins, and answer when those
   * textures have settled and which of them failed.
   *
   * A METHOD, where this was `set displayInfo`. The setter could not answer anything -- see
   * `Submesh#setDisplayInfo` for the defect that cost, and `M2Material#loadTextures` for why the
   * answer is a list of failures rather than a rejection. The caller (`classes/unit.ts`) is the only
   * thing that knows WHICH unit and which display id these textures belonged to, so it is the only
   * thing that can say so on the console.
   */
  setDisplayInfo(displayInfo): TextureLoad {
    const loads: TextureLoad[] = [];
    for (let i = 0; i < this.submeshes.length; i++) {
      loads.push(this.submeshes[i].setDisplayInfo(displayInfo));
    }
    return collectTextureLoads(loads);
  }

  /**
   * Show only the submeshes whose geoset id is in `ids`; `null` shows every submesh again.
   *
   * WHY THIS EXISTS: a character `.m2` carries every customization option at once. Measured on
   * `character/human/male/humanmale00.skin` (61 submeshes, 54 distinct `partID`s): geoset group 0
   * holds ids 0..18 -- the bald head plus eighteen hairstyles -- group 4 holds 401..404 (bare hand
   * plus three glove shapes), group 5 holds 501..505, group 15 holds 1501..1506. Drawing the file as
   * parsed puts all of them on the body simultaneously. Only a caller that knows the character's
   * appearance can choose, so the choice is the caller's and this is the switch it throws.
   *
   * WALKS `submeshes`, NOT `parts`. `this.parts` is a `Map` keyed by `partID`, so it holds ONE
   * submesh per id -- and ids repeat: the same measured skin has two submeshes each for partIDs
   * 0, 4, 5, 9, 10, 16 and 18 (the second entry for partID 0 is an 8-vertex patch at z 1.88, the
   * scalp cap that sits on the 563-vertex body). Selecting through the map would leave the duplicate
   * at whatever visibility it happened to have.
   *
   * `visible = false` on the `Submesh` group takes its batch meshes with it -- they are its children
   * (`submesh.js#applyBatches`) and three.js skips a hidden subtree in `projectObject`. It does not
   * disturb posing: `applyPose` walks `soleBoneSubmeshes` and writes matrices whether or not a
   * submesh draws, so a hidden geoset shown later is already in the right pose.
   */
  setVisibleGeosets(ids: Set<number> | null): void {
    for (let i = 0, len = this.submeshes.length; i < len; ++i) {
      const submesh = this.submeshes[i];
      submesh.visible = ids === null || ids.has(submesh.userData.partID);
    }
  }

  /**
   * The runtime-supplied CHARACTER texture slots: type 1 (the body skin), type 6 (the hair sheet) and
   * type 2 (the cloak sheet).
   *
   * One entry point for all three, matching `updateSkinTextures`' three-at-once shape, because
   * each supply costs a full `loadTextures()` walk -- see `material/index.ts#updateCharacterTextures`. The
   * `skins.hair` comment there records which geosets read which type, measured off the real skin.
   *
   * `body` is a `THREE.Texture` for the normal case -- the CPU-baked composite, which has no path to
   * name -- or a path string for the fallback when the bake could not happen. `hair` and `cape` are
   * always paths: they go to the GPU whole, so `TextureLoader` owns them.
   */
  setCharacterTextures(paths: {
    body: string | THREE.Texture | null;
    hair: string | null;
    cape: string | null;
  }): TextureLoad {
    const loads: TextureLoad[] = [];
    for (let i = 0; i < this.submeshes.length; i++) {
      loads.push(this.submeshes[i].setCharacterTextures(paths));
    }
    return collectTextureLoads(loads);
  }

  /**
   * An ATTACHED item model's own skin -- its texture type 2, which is the only runtime slot any
   * `Item\ObjectComponents\` model declares.
   *
   * Separate from `characterTextures` because the two apply to disjoint models; see
   * `material/index.ts#updateObjectTexture`.
   */
  setObjectTexture(path: string | null): TextureLoad {
    const loads: TextureLoad[] = [];
    for (let i = 0; i < this.submeshes.length; i++) {
      loads.push(this.submeshes[i].setObjectTexture(path));
    }
    return collectTextureLoads(loads);
  }

  /**
   * Parent `child` to the bone this model's attachment `id` names, so it rides that bone through every
   * animation. Answers false when the model has no such attachment point.
   *
   * THE PLACEMENT LAW, and it is the whole of it. An M2 attachment record carries a bone index and a
   * position **in raw model space** -- not a bone-local offset, which is the easy misreading and the one
   * that would put a weapon at twice the hand's height. The bone-local offset is therefore
   * `position - bones[bone].pivotPoint`, and both go through the engine mirror `D = diag(-1, -1, 1)`
   * that `createGeometry` and `createSkeleton` already apply (`anim/axes.ts`) --
   * `D(position) - D(pivot) = D(position - pivot)`, one subtraction and one sign flip.
   *
   * The reference computes exactly this (`benilla-assets/src/model.rs:429-435`:
   * `offset = wow_to_bevy(position) - pivot_bevy(bone)`), and on 3.3.5a's
   * `Character\Human\Male\HumanMale.m2` the difference is **identically zero for all 39 attachment
   * records** (measured, max |difference| 0.000000) -- the attach bones are leaves sitting on their
   * attach point. It is still subtracted rather than assumed away: it is the general law, and an item
   * or creature model need not have it zero.
   *
   * THERE IS NO ROTATION TO CHOOSE, which is the other half of why this is short. The child gets the
   * identity, and the bone's animated frame supplies the orientation: the item model's origin IS the
   * grip (`benilla/crates/benilla/src/entities/equipment/mod.rs:14-18`). That this is exactly right and
   * not an approximation follows from `D` being an involution -- the real client computes
   * `bone_raw * v_raw` and mirrors the result, and
   * `D (bone_raw v_raw) = (D bone_raw D)(D v_raw) = bone_engine * v_engine`, i.e. the engine-space bone
   * matrix applied to the child's own already-mirrored vertices. A weapon through the hand, floating
   * beside it or pointing at the sky are all symptoms of adding a rotation here, not of omitting one.
   *
   * `updateMatrix()` and not a reliance on `matrixAutoUpdate`: `M2` sets that false on itself (line
   * 163) and an M2 child would therefore keep an identity `matrix` no matter what its `position`
   * says. The position never changes after this call, so once is enough and per-frame auto-update
   * would be waste.
   *
   * ONE PRECONDITION, stated because it is invisible when it fails: the bone has to be IN the scene
   * graph, and it is only there when `useSkinning` is true -- `createMesh` parents the root bones to
   * the `SkinnedMesh`, and the unskinned branch leaves them orphaned. Every character model is skinned
   * (`humanmale.m2` has 138 bones, all animated), and an unskinned model has no animation for a rider
   * to follow anyway, so this is a real constraint rather than a case to handle: attaching to an
   * unskinned host would draw nothing at all, silently.
   *
   * AND THE ROOT MESH HAS TO STOP BEING `visible = false`, which is the whole of `unhideBoneSubtree`
   * below. That is not a preference; it is what the first attempt at this got wrong, and it took a
   * draw-path instrument to see: the sword was parented to the right bone, at the right offset, with
   * both shaders resolved, its texture bound, its world sphere measured INSIDE the frustum -- and
   * `onBeforeRender` fired zero times in 1.2 s of frames.
   */
  attachTo(id: number, child: THREE.Object3D): boolean {
    const record = (this.data?.attachments ?? []).find((entry: any) => entry.id === id);
    if (!record) {
      return false;
    }
    const bone = this.bones?.[record.bone];
    if (!bone) {
      return false;
    }
    this.unhideBoneSubtree();
    const pivot = this.data.bones?.[record.bone]?.pivotPoint ?? [0, 0, 0];
    // Through `attachmentLocalOffset` and not inline, because this class is untestable (the
    // constructor reaches for `collisionWorld` and `ObjectsManager`) and that number is the one thing
    // here that fails silently. See its own doc for the derivation.
    child.position.set(...attachmentLocalOffset(record.position, pivot));
    bone.add(child);
    child.updateMatrix();
    return true;
  }

  /**
   * Let the bones' subtree be DRAWN, without drawing the root mesh that owns it.
   *
   * `createMesh` hides that mesh with `visible = false` and says why ("Never display the mesh") -- the
   * full-model geometry is only there to carry the skeleton binding, and the geosets draw as their own
   * `Submesh` children of this group. Correct, and harmless until now, because nothing in this client
   * had ever parented anything to a bone (the research says so in as many words, §1.4: "Nothing parents
   * an `Object3D` to another model's bone anywhere").
   *
   * It is not harmless the moment something is, and three's own renderer says exactly why
   * (`three.cjs:77803-77807`, verified in the installed 0.185.1):
   *
   *     function projectObject( object, camera, groupOrder, sortObjects ) {
   *       if ( object.visible === false ) return;               // <- returns BEFORE the child walk
   *       const visible = object.layers.test( camera.layers );
   *       if ( visible ) { ...push this object's render item... }
   *       const children = object.children;                     // <- only reached if visible
   *       for (...) projectObject( children[i], ... );
   *     }
   *
   * So `visible = false` hides the mesh AND everything under it, while a failed `layers.test` hides
   * only the mesh itself and still walks its children. That is the difference between an attached
   * weapon that draws and one that is perfect in every inspectable respect and submits no draw call:
   * measured on the claymore, `visible: true`, `inFrustum: true`, both shaders resolved, its texture
   * bound, `draws: 0`.
   *
   * Applied HERE and not in `createMesh`, so the pipeline-wide default is untouched: this runs only for
   * a model something is actually attached to, which today is the glue character and nothing else. For
   * every other population the root mesh keeps `visible = false` exactly as before. Idempotent, because
   * a character with a weapon in each hand plus a helm calls it three times.
   *
   * `layers.disableAll()` and not a layer number: a mask of 0 fails `test` against every camera in this
   * client, so the mesh is out of every pass rather than out of one that somebody could later enable.
   */
  private unhideBoneSubtree(): void {
    if (!this.mesh || this.mesh.visible) {
      return;
    }
    this.mesh.visible = true;
    this.mesh.layers.disableAll();
  }

  dispose() {
    collisionWorld.doodads.remove(this.boundingMesh);
    // The hull is built per placement (see `createBoundingMesh`), so it is always ours to free.
    this.boundingMesh.geometry.dispose();

    // `this.mesh.geometry` IS `this.geometry` -- `createMesh` is handed the same object -- so the
    // second call was always a double dispose. Now it is one call, and only from the M2 that built
    // the buffers; see `ownsGeometry`.
    if (this.ownsGeometry) {
      this.geometry.dispose();
    }

    this.submeshes.forEach((submesh) => {
      submesh.dispose();
    });

    // Only the M2 that owns this.batches may dispose the materials backing suppressed (template)
    // submeshes -- an instanced/cloned M2 shares batches with its source and would otherwise
    // double-dispose (or prematurely dispose) materials still in use elsewhere.
    if (this.ownsBatches) {
      this.suppressedBatches.forEach((batchMaterial) => {
        batchMaterial.dispose();
      });
    }
  }

  clone() {
    // ALWAYS shared, whatever `canInstance` says: buffers and the skinning table are pure functions
    // of `data`/`skinData` and are read-only after construction. See `ownsGeometry`.
    const instance: any = {
      geometry: this.geometry,
      submeshGeometries: this.submeshGeometries,
      submeshSkinning: this.submeshSkinning,
    };

    // Materials only when the model is instanceable. See the constructor's split.
    if (this.canInstance) {
      instance.batches = this.batches;
    }
    collisionWorld.doodads.remove(this.boundingMesh);
    // `this.modelAnim` goes to every clone, instanceable or not -- see the constructor's doc for
    // why it must NOT ride along inside `instance`.
    const newM2 = new M2(this.path, this.data, this.skinData, instance, this.modelAnim);
    return newM2 as any;
  }

}

export default M2;
