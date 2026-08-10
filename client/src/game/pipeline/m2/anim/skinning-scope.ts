/**
 * Whether a submesh needs GPU skinning, decided PER SUBMESH.
 *
 * `M2#useSkinning` was model-global: one animated bone anywhere forced every submesh of the model
 * onto `THREE.SkinnedMesh`, a skinning shader variant and a bone texture. Most animated doodad
 * submeshes ride exactly one bone -- a flag, a windmill blade, a swinging sign -- and for those the
 * bone's transform simply IS the submesh's transform.
 *
 * WHY THAT SUBSTITUTION IS EXACT, and not an approximation (`W` = the M2's world matrix, `P_i` =
 * bone `i`'s posed model-space matrix, `B_i` = its BIND model-space matrix, `v` = a vertex):
 *
 *   * Skinned. `material/vertex/common-main.glsl` computes
 *     `skinned = bindMatrixInverse . sum_i(w_i . boneMatrix_i . bindMatrix . v)`. The pipeline binds
 *     with an explicit IDENTITY `bindMatrix` (`bind-pose.ts#modelSpaceBindMatrix`), and three's
 *     default `AttachedBindMode` recomputes `bindMatrixInverse = matrixWorld^-1` every frame, so
 *     `modelViewMatrix . skinned` collapses to `viewMatrix . sum_i(w_i . boneMatrix_i) . v`.
 *     `Skeleton#update` writes `boneMatrix_i = bone.matrixWorld . boneInverse_i = W . P_i . B_i^-1`.
 *     With a single bone, `w = 1`, so the drawn position is `viewMatrix . W . P_i . B_i^-1 . v`.
 *   * Unskinned. A plain `THREE.Mesh` under the `Submesh` group draws at
 *     `viewMatrix . W . S . v`, where `S` is the submesh's local matrix (`Submesh` sits directly
 *     under the `M2` group and the batch mesh carries identity).
 *
 * The two agree iff `S = P_i . B_i^-1`, bind-pose inverse included, which `anim/pose.ts` pins as
 * `D . InstanceAnim.palette[i] . D`. So `Submesh#applySoleBone` writes `toEngineMatrix(palette, i)`
 * and nothing else.
 *
 * `P_i . B_i^-1` is NOT `skeleton.boneMatrices[i]`, and an earlier version of this comment said it
 * was. Line for line above: `Skeleton#update` writes `boneMatrix_i = W . P_i . B_i^-1` -- the two
 * differ by the M2's whole world matrix `W`. They coincide only in a test frame where `W = I`, which
 * is exactly the frame the unit tests run in, so nothing here would have caught it. A future reader
 * simplifying `applySoleBone` into a copy out of `skeleton.boneMatrices` would apply `W` twice: once
 * in the matrix and again when the scene graph composes the submesh under the `M2` group, sending
 * the submesh to roughly the square of its world placement. Take the palette, never the skeleton.
 *
 * At rest the palette
 * entry is the identity (`T(p) . I . T(-p)`), which is also `B_i . B_i^-1`, so an unposed submesh
 * sitting at its untouched identity matrix is already correct.
 *
 * The normal agrees too: the skinned branch uses `skinMatrix . n = W . P_i . B_i^-1 . n` and the
 * unskinned branch `modelMatrix . n = W . S . n`.
 *
 * WHERE THE EQUIVALENCE FAILS, and what this module therefore refuses:
 *
 *   1. More than one bone. Not rigid; there is no single `S`. `needsSkinning` keeps those skinned.
 *   2. A BILLBOARDED bone anywhere in the sole bone's ancestor chain. `M2#applyBillboards` writes
 *      `bone.rotation` directly, so the billboard facing reaches `bone.matrixWorld` and therefore
 *      the palette three builds -- but `InstanceAnim.palette` is solved purely from keyframes and
 *      knows nothing about it (`anim/pose.ts` documents the same asymmetry). Driving such a submesh
 *      from the palette would silently drop its facing. `chainBillboarded` rejects them.
 */

/** A submesh riding zero or one bone is rigid; only two or more need the skinning shader. */
export function needsSkinning(boneCount: number): boolean {
  return boneCount > 1;
}

/**
 * The distinct bones a submesh's DRAWN vertices are weighted to.
 *
 * Walks the submesh's TRIANGLE range and dereferences `indices[triangles[i]]`, which is exactly how
 * `M2#createSubmeshGeometry` decides which vertices this submesh draws. The brief specified a
 * `startVertex`/`vertexCount` walk over a `skinData.vertices` / `skinData.m2Vertices` pair; neither
 * field exists -- `wow-data-parser/m2/skin.js` names the vertex lookup `indices`, and the bone
 * indices and weights live on the M2's OWN vertices, which the skin does not carry at all. Hence the
 * third parameter.
 *
 * The all-zero-weight fallback is not defensive padding. `bind-pose.ts#normalizeBoneWeights` maps
 * such a vertex to `[1, 0, 0, 0]` -- fully bound to `boneIndices[0]` -- so the skinned path DOES ride
 * a bone for it. Ignoring it here would let a submesh mixing weighted and unweighted vertices report
 * one bone when the skinned result used two, and the unweighted part would detach.
 *
 * Construction-time only (once per submesh per model load), so the `Set` costs nothing per frame.
 *
 * @param submeshDef one entry of `skinData.submeshes`
 * @param skinData   the parsed .skin -- `indices` and `triangles` are read
 * @param vertices   the M2's own vertices (`data.vertices`), which carry boneIndices/boneWeights
 */
export function submeshBoneSet(submeshDef: any, skinData: any, vertices: any): Set<number> {
  const bones = new Set<number>();

  if (!submeshDef || !skinData || !vertices) {
    return bones;
  }

  const { indices, triangles } = skinData;
  if (!indices || !triangles) {
    return bones;
  }

  const start = submeshDef.startTriangle;
  const end = start + submeshDef.triangleCount;

  for (let i = start; i < end; ++i) {
    const vertex = vertices[indices[triangles[i]]];
    if (!vertex) {
      continue;
    }

    const boneIndices = vertex.boneIndices;
    if (!boneIndices) {
      continue;
    }

    const boneWeights = vertex.boneWeights;
    let weighted = false;

    for (let b = 0; b < 4; ++b) {
      if (boneWeights && boneWeights[b] > 0) {
        bones.add(boneIndices[b]);
        weighted = true;
      }
    }

    if (!weighted) {
      // Matches `normalizeBoneWeights`' `[1, 0, 0, 0]` fallback -- see the doc above.
      bones.add(boneIndices[0]);
    }
  }

  return bones;
}

/**
 * Is `index`, or any of its ancestors, a billboarded bone?
 *
 * Billboarding is applied to bones by `M2#applyBillboards` and propagates down the hierarchy through
 * the scene graph, so an ancestor's facing is just as invisible to `InstanceAnim.palette` as the
 * bone's own. The walk is bounded by the bone count: a malformed parent cycle in shipped data must
 * degrade to "keep it skinned", not hang.
 */
export function chainBillboarded(boneDefs: any, index: number): boolean {
  if (!boneDefs) {
    return false;
  }

  const limit = boneDefs.length;
  let i = index;

  for (let steps = 0; steps <= limit; ++steps) {
    if (!(i >= 0 && i < limit)) {
      return false;
    }

    const def = boneDefs[i];
    if (!def) {
      return false;
    }
    if (def.billboarded) {
      return true;
    }

    i = def.parentID;
  }

  // Ran out of steps -- a cycle. Report billboarded so the caller keeps the safe skinned path.
  return true;
}

/** What `submeshSkinningScope` decides for one submesh. */
export interface SubmeshSkinningScope {
  /** Draw this submesh as a `THREE.SkinnedMesh`. */
  skinned: boolean;
  /** The one bone whose transform IS this submesh's, or -1 for none. */
  soleBone: number;
}

// FROZEN, because both are returned BY REFERENCE and the same object therefore ends up in the
// `submeshSkinning` table of every submesh of every model that reaches this verdict -- including the
// tables instanced clones share with their source (`M2#clone`). One stray `scope.skinned = true`
// anywhere would silently retune half the world's draw path, and the failure would present as an
// unrelated model going skinned. Freezing turns that into a throw in strict mode (every ES module is
// strict) at the write, instead of a rendering mystery a hundred objects away.

/** Kept skinned, riding the model's skeleton. */
const SCOPE_SKINNED: SubmeshSkinningScope = Object.freeze({ skinned: true, soleBone: -1 });
/** Static: no animated bone reaches this submesh at all. */
const SCOPE_STATIC: SubmeshSkinningScope = Object.freeze({ skinned: false, soleBone: -1 });

/**
 * Decide how one submesh is drawn.
 *
 * `modelUsesSkinning` is `M2#useSkinning`, the old model-global answer. When it is false nothing
 * changes -- the model was already drawn unskinned and has no palette to read -- so this narrows the
 * population strictly, never widens it.
 */
export function submeshSkinningScope(
  submeshDef: any,
  skinData: any,
  vertices: any,
  boneDefs: any,
  modelUsesSkinning: boolean,
): SubmeshSkinningScope {
  if (!modelUsesSkinning) {
    return SCOPE_STATIC;
  }

  const boneSet = submeshBoneSet(submeshDef, skinData, vertices);

  if (needsSkinning(boneSet.size)) {
    return SCOPE_SKINNED;
  }

  if (boneSet.size === 0) {
    return SCOPE_STATIC;
  }

  const soleBone = boneSet.values().next().value as number;

  // The submesh's DECLARED root bone matters as well as the sole weighted one: `Submesh` reads
  // `rootBone.userData.billboarded` to turn on shader billboarding for the batch materials, and
  // `applyBatches` publishes `rootBone.skin`, which `M2#applySphericalBillboard` needs. Dropping to
  // the unskinned path would take both away.
  if (
    chainBillboarded(boneDefs, soleBone) ||
    chainBillboarded(boneDefs, submeshDef ? submeshDef.rootBone : -1)
  ) {
    return SCOPE_SKINNED;
  }

  return { skinned: false, soleBone };
}
