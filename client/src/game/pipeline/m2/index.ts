import * as THREE from 'three';
import { BufferGeometry } from 'three';
import { Face3, Geometry } from '../../utils/geometry';
import CacheManager from '../../world/cache-manager';
import { collisionWorld } from '../../collision/collision-world';
import { ObjectsManager } from '../../world/visibility-manager';
import BatchManager from './batch-manager';
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
import M2Material from './material';
import { isParticleTemplate } from './particle/template';
import Submesh from './submesh';

class M2 extends THREE.Group {
  static CacheManager = CacheManager;
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

    this.createSkeleton(data.bones);

    // PER PLACEMENT, outside the `instance` branch below on purpose. These are this placement's own
    // sampled UV / transparency / colour slots, not shared state: an instanced clone took the
    // BATCHES from its source, and the whole point of Task 14 is that the values pushed into those
    // shared materials come from the placement being drawn. Built inside the else-branch, as it was,
    // every clone of an instanceable model kept empty arrays -- and `canInstance` is false only when
    // a BONE is animated, so the models that clone are exactly the UV/transparency-animated ones
    // this task exists for. Their animation would have been dropped on the floor.
    this.createTextureAnimations(data);

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
      : this.computeSubmeshSkinning(data, skinData);

    // Instanced M2s can share geometries and texture units.
    if (instance) {
      this.batches = instance.batches;
      this.geometry = instance.geometry;
      this.submeshGeometries = instance.submeshGeometries;
      this.ownsBatches = false;
    } else {
      this.createBatches();
      this.createGeometry(data.vertices);
      this.ownsBatches = true;
    }

    this.createMesh(this.geometry, this.skeleton, this.rootBones);
    this.createSubmeshes(data, skinData);
    this.geometry.computeBoundingBox();
    this.boundingMesh = this.createBoundingMesh(this.boundingVertices);

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

    mesh.visible = true;

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

  createGeometry(vertices) {
    const geometry = new Geometry();

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

    // Mirror geometry over X and Y axes and rotate
    const matrix = new THREE.Matrix4();
    matrix.makeScale(-1, -1, 1);
    geometry.applyMatrix4(matrix);
    geometry.rotateX(-Math.PI / 2);

    // Preserve the geometry
    this.geometry = geometry.toBufferGeometry();
    // this.geometry.computeBoundsTree();
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

    for (let submeshIndex = 0; submeshIndex < subLen; ++submeshIndex) {
      const submeshDef = submeshes[submeshIndex];

      // Bring up relevant batches and geometry.
      const submeshBatches = this.batches.get(submeshIndex);
      const submeshGeometry = this.submeshGeometries.get(submeshIndex) ||
        this.createSubmeshGeometry(submeshDef, indices, triangles, vertices);

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
      for (let vinIndex = 0, vinLen = vindices.length; vinIndex < vinLen; ++vinIndex) {
        const index = vindices[vinIndex];

        const { textureCoords, normal } = vertices[index];

        uvs[faceIndex].push(new THREE.Vector2(textureCoords[0][0], textureCoords[0][1]));

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

    geometry.faceVertexUvs = [uvs];


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
      matrixAutoUpdate: this.matrixAutoUpdate
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

    const camPos = this.worldToLocal(camera.position.clone());

    const modelForward = new THREE.Vector3(camPos.x, camPos.y, camPos.z);
    modelForward.normalize();

    const modelVmEl = boneRoot.modelViewMatrix.elements;
    const modelRight = new THREE.Vector3(modelVmEl[0], modelVmEl[4], modelVmEl[8]);
    modelRight.multiplyScalar(-1);

    const modelUp = new THREE.Vector3();
    modelUp.crossVectors(modelForward, modelRight);
    modelUp.normalize();

    const rotateMatrix = new THREE.Matrix4();

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

    const camPos = this.worldToLocal(camera.position.clone());

    const modelForward = new THREE.Vector3(camPos.x, camPos.y, camPos.z);
    modelForward.normalize();

    const modelVmEl = boneRoot.modelViewMatrix.elements;
    const modelRight = new THREE.Vector3(modelVmEl[0], modelVmEl[4], modelVmEl[8]);

    const modelUp = new THREE.Vector3(0, 0, 1);

    const rotateMatrix = new THREE.Matrix4();

    rotateMatrix.set(
      modelForward.x,   modelRight.x,   modelUp.x,  0,
      modelForward.y,   modelRight.y,   modelUp.y,  0,
      modelForward.z,   modelRight.z,   modelUp.z,  0,
      0,                0,              0,          1
    );

    bone.rotation.setFromRotationMatrix(rotateMatrix);
  }

  set displayInfo(displayInfo) {
    for (let i = 0; i < this.submeshes.length; i++) {
      this.submeshes[i].displayInfo = displayInfo;
    }
  }

  dispose() {
    collisionWorld.doodads.remove(this.boundingMesh);
    this.boundingMesh.geometry.dispose();
    this.geometry.dispose();
    this.mesh.geometry.dispose();
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
    let instance: any = {};

    if (this.canInstance) {
      instance.geometry = this.geometry;
      instance.submeshGeometries = this.submeshGeometries;
      instance.batches = this.batches;
      // Read-only after construction and derived only from the shared `data`/`skinData`, so it is
      // safe to share. NOT a whole-model triangle walk saved, as this used to claim: reaching here
      // means `canInstance`, which means no animated bone, which means the table is all-static and
      // was built without walking a single triangle. See the constructor.
      instance.submeshSkinning = this.submeshSkinning;
    } else {
      instance = null;
    }
    collisionWorld.doodads.remove(this.boundingMesh);
    // `this.modelAnim` goes to every clone, instanceable or not -- see the constructor's doc for
    // why it must NOT ride along inside `instance`.
    const newM2 = new M2(this.path, this.data, this.skinData, instance, this.modelAnim);
    return newM2 as any;
  }

}

export default M2;
