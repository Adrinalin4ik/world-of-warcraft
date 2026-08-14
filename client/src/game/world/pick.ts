/**
 * Which unit is under the cursor -- the click-to-target pick.
 *
 * ## The two phases, and what each one is
 *
 * The reference does this in two phases (`samples/benilla/crates/benilla/src/target/hover.rs:1-6`,
 * `:69-80`): a **broad phase** of the cursor ray against the current animation's bounding SPHERE,
 * then a **narrow phase** of the ray against the unit's **POSED RENDER MESH**, triangle by triangle,
 * with a +1-model-unit halo retry when nothing hits exactly.
 *
 * **Both are ported now. The narrow phase is the DRAWN geometry, posed** -- every visible batch mesh
 * under every visible `Submesh`, through three's own `Mesh#raycast`, which for a `SkinnedMesh` reads
 * each vertex through `getVertexPosition` -> `applyBoneTransform` (`three.core.js:23990-23996`,
 * `:24095`). That skins on the CPU out of `skeleton.bones[i].matrixWorld` and `boneInverses`, which
 * are CPU-side rows the renderer already maintains.
 *
 * **ROUND 20 USED THE M2'S AUTHORED COLLISION HULL HERE AND IT WAS THE WRONG ORACLE**, which is the
 * owner's "если тыкаю на заднюю часть волка, не выделяется, а если на голову, срабатывает". Two
 * independent reasons, and the second is the sharp one:
 *
 *  1. The hull is 12 triangles -- a BOX -- authored in model space and static, so it cannot follow a
 *     posed quadruped whose body extends behind its origin.
 *  2. **The hull and the drawn geometry are built in DIFFERENT VERTEX SPACES.**
 *     `pipeline/m2/index.ts#createSubmeshGeometry` emits the drawn vertices as
 *     `(position[0], position[2], -position[1])` (`:672`) -- the engine-axis swizzle -- while
 *     `#createBoundingMesh` emits `(x, y, -z)` and then applies `makeScale(-1, 1, 1)` and
 *     `rotateX(-PI)` (`:315`, `:327-330`), which composes to `(-x, -y, z)`: a 180-degree turn about
 *     Z with no swizzle at all. Neither `boundingVertices` nor `vertices[].position` is swizzled by
 *     the parser (`wow-data-parser/m2/index.js:83-89`, `:222`, both raw `float32` triples), so the
 *     two really are in different frames and the hull cannot align with the body it belongs to.
 *     `PickReport` carries `hullBox` and `posedBox` per candidate so this is a measurement and not an
 *     argument -- see the round-21 numbers in `task-9-report.md`.
 *
 * **This is also a live suspicion about DOODAD COLLISION and it is NOT touched here**:
 * `collision/doodad-provider.ts` reads the same hull, so if the frames really do disagree then every
 * doodad in the world collides in a rotated volume. That is a separate subsystem with its own
 * verification (walking, the camera boom), and STATE.md already carries an unexplained "collision
 * stall after 30-40 yd of walking". Reported, not changed.
 *
 * A unit whose model has not streamed in, or that draws nothing yet, keeps the SPHERE as its volume
 * rather than becoming unclickable (peers sit at `seq -1` for 9.2-9.5 s), and
 * `PickTraceRow.fallback` reports that per candidate so the generosity is visible instead of assumed.
 *
 * NOT ported, and named: the reference's **pass-2 halo** -- the same posed mesh with every vertex
 * displaced one model unit along its skinned normal, tried only when pass 1 hits nothing anywhere
 * (`hover.rs:69-80`). It needs a per-vertex normal skin and a second full pass; the measured
 * first-miss margin without it is 0.5-0.8 yd off the body, which is already tighter than the
 * complaint. If the owner reports a click ON the animal missing, this is the piece to add.
 *
 * ## Range: the mouse pick is UNBOUNDED, and 41 yd was ours
 *
 * `PICK_RANGE` is `targetNearestDistance`, a **TAB** law (`target/scan.rs:96-98`), and round 20 let it
 * govern the mouse pick too -- so a mob further than 41 yd could not be clicked. That is the owner's
 * "если моб слишком далеко, то не могу выбрать его", and the narrow phase made it worse rather than
 * causing it: the SPHERE's entry point sits up to a radius (7.11 yd measured) nearer than the body,
 * so the old pick effectively reached 41 yd PLUS the radius. The reference's mouse pick has no range
 * at all -- "both object picks below run **unbounded** and post-compare against" the world occlusion
 * (`hover.rs:29-33`). So there is no range test here now. `PICK_RANGE` stays exported for `scan.ts`,
 * which is where it belongs.
 *
 * ## Occlusion
 *
 * `hover.rs#update_pick_occlusion`: ONE ray through the occluder set (terrain, WMO faces, static
 * doodad hulls -- deliberately NOT net entities, "a chest must not occlude itself"), and the object
 * hit is discarded **iff the world hit is strictly nearer** ("`0x480eb4`: tie keeps the object").
 * Ported with that structure: one zero-radius `CollisionLayer.Camera` cast per pick, reaching as far
 * as the FARTHEST surviving candidate, then a distance compare. It is possible at all only because a
 * unit's own hull is not in that set -- `Unit`'s `set model` removes it (`classes/unit.ts:1150-1156`).
 * A contact within `CAMERA_INSIDE_EPS` of the camera is the camera being INSIDE geometry and does not
 * occlude anything (OURS: without it a camera clipped into a hillside makes every unit unclickable).
 *
 * ## The control arms
 *
 * `window.worldPickNarrow = false` restores the sphere-only pick and `window.worldPickOcclude =
 * false` drops the occlusion leg, both in the same build -- the shape `window.uiTextSnap` uses. A
 * before/after claim about a pick has to be measured with the same geometry on screen, and this is
 * the only way to do that: the units move.
 *
 * ## The sphere
 *
 * Centred half a collision height above the unit's feet and sized by the larger of that half-height
 * and the model's authored render radius. `Unit#collisionHeight` is `CreatureModelData.collisionHeight
 * x displayScale` -- the same number the swim depth lines and the mover use -- and `M2#vertexRadius`
 * is the M2 header's own bounding-sphere radius (`pipeline/m2/index.ts:202-204`), which is in MODEL
 * units and so is multiplied by the scale actually applied to the view.
 */
import * as THREE from 'three';

import Unit from '../classes/unit';
import type { CastFn } from '../collision/collision-world';

/**
 * TAB's targeting range (yd) -- 1.12's byte-verified `targetNearestDistance` default
 * (`target/scan.rs:96-98`). **It is NOT the mouse pick's range**; see the header. `scan.ts` is the
 * only consumer.
 */
export const PICK_RANGE = 41;

/** `ObjectType.Unit` / `ObjectType.Player`, by value so this module does not depend on `network/`. */
const OBJECT_TYPE_UNIT = 3;
const OBJECT_TYPE_PLAYER = 4;

/**
 * Float slack on the occlusion compare (yards). OURS, and much smaller than round 20's 0.25.
 *
 * The reference's rule is "discard iff the world hit is STRICTLY nearer -- tie keeps the object"
 * (`hover.rs:29-33`), and with the narrow phase on the posed RENDER mesh the hit point is on the drawn
 * surface, so the ground the unit stands on is genuinely BEHIND it and no geometric clearance is
 * needed. What is left is float noise between two different intersection routines, which is what this
 * covers. Round 20 needed 0.25 because it tested the AUTHORED HULL, whose surface is routinely
 * embedded in the ground.
 */
const OCCLUSION_SLACK = 0.02;

/**
 * A cast that reports contact this close to the camera is the camera being INSIDE geometry, not an
 * occluder. OURS, not sourced. Without it, a camera that has clipped into a hillside or a wall makes
 * every unit in the world unclickable, which is worse than the generosity this leg removes.
 */
const CAMERA_INSIDE_EPS = 0.1;

const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const toCentre = new THREE.Vector3();
const _scratchBox = new THREE.Box3();
const _unionBox = new THREE.Box3();

/** Reused across picks. three's raycast contract is a `Raycaster` carrying the ray plus near/far. */
const raycaster = new THREE.Raycaster();
const meshHits: THREE.Intersection[] = [];

/** The pick sphere's centre (written into `out`) and radius for one unit. */
function pickSphere(unit: Unit, out: THREE.Vector3): number {
  const half = Math.max(unit.collisionHeight, 0.1) * 0.5;
  out.copy(unit.view.position);
  out.z += half;
  const model = unit.model;
  const scale = model ? Math.abs(model.scale.x) || 1 : 1;
  const authored = model ? model.vertexRadius * scale : 0;
  return Math.max(half, authored, 0.5);
}

/** One candidate's verdict, for `window.worldPick`. Distances are yards along the cursor ray. */
export interface PickTraceRow {
  guid: string;
  sphereRadius: number;
  sphereEntry: number;
  /** How many triangles of DRAWN, posed geometry the narrow phase tested. */
  meshTriangles: number;
  /** How many visible batch meshes it walked. 0 means there is nothing drawn to test yet. */
  meshes: number;
  /** The posed render mesh's nearest hit along the ray, or null when the ray misses it. */
  meshEntry: number | null;
  /** True when the sphere stood in because nothing was drawn yet. */
  fallback: boolean;
  /**
   * The DRAWN geometry's world box and the AUTHORED HULL's world box, `[minx,miny,minz,maxx,maxy,maxz]`.
   *
   * Reported, and the hull one is used by NOTHING. Comparing them is what convicts the hull as the
   * wrong oracle -- "measure the RENDERED geometry, not a model-space proxy", which is the whole reason
   * these two fields exist rather than a claim in a comment.
   */
  drawnBox: number[] | null;
  hullBox: number[] | null;
  /** How far the occluder was, when one rejected this candidate. */
  occludedAt: number | null;
  /** What the pick used for this candidate, or null when it was rejected. */
  entry: number | null;
}

export interface PickReport {
  guid: string | null;
  rows: PickTraceRow[];
  /** Wall time for the whole pick, milliseconds. */
  ms: number;
  narrow: boolean;
  occlude: boolean;
}

export interface PickOptions {
  /**
   * The collision cast the occlusion leg uses. `pages/game/index.tsx` supplies
   * `collisionWorld.castFor(CollisionLayer.Camera, 0, 0)`; omit it and the leg is skipped, which is
   * what every unit test and the offline route get.
   */
  cast?: CastFn | null;
  /** Off restores the sphere-only pick -- the control arm. Defaults on. */
  narrow?: boolean;
  /** Off drops the occlusion leg -- the second control arm. Defaults on. */
  occlude?: boolean;
  /** Filled with one row per broad-phase candidate when supplied. */
  trace?: PickTraceRow[];
}

/**
 * Which phases are on, in ONE place.
 *
 * Both defaults are "on unless explicitly false", and the occlusion leg additionally needs a cast --
 * a decision `pickUnitReport` has to report and `pickUnit` has to act on. Written twice in a first
 * draft, which is exactly the duplicated expression round 19's self-review caught elsewhere: the two
 * copies can disagree and nothing would say so.
 */
function resolveOptions(options: PickOptions): { narrow: boolean; occlude: boolean } {
  return {
    narrow: options.narrow !== false,
    occlude: options.occlude !== false && !!options.cast,
  };
}

/**
 * The ray's nearest hit against a unit's DRAWN, POSED geometry -- the reference's narrow phase.
 *
 * Walks the model's `Submesh` groups and their batch meshes, skipping anything not `visible`, so a
 * hidden geoset (a character's unworn hair, a suppressed particle template) is not clickable -- which
 * is the reason to walk the DRAW graph rather than the merged `M2#geometry`. That merged geometry also
 * carries NO index buffer (`pipeline/m2/index.ts:527-531` sets position, skinIndex and skinWeight and
 * nothing else), so raycasting it would read the vertex list as a triangle soup and hit surfaces the
 * model does not have.
 *
 * `mesh.raycast` is three's own, and for a `SkinnedMesh` it poses every vertex it tests
 * (`three.core.js:23990-23996` -> `applyBoneTransform` at `:24095`, which reads
 * `skeleton.bones[i].matrixWorld` and `boneInverses` -- CPU-side rows the renderer already maintains,
 * so "there is no CPU skinning path to read the pose back through" was wrong).
 * Two consequences worth naming:
 *
 *  - its early reject is the geometry's BIND-POSE bounding sphere transformed by `matrixWorld`
 *    (`three.core.js:23527-23540`), so a pose that throws a limb outside the bind sphere could reject
 *    a legitimate hit. Not observed, and our own broad phase is far larger; named because it is the
 *    one place this narrow phase could still be too tight.
 *  - `matrixWorld` has to be current. Every mesh here is built with `matrixAutoUpdate = false`
 *    (`m2/index.ts:337`, `submesh.js:186`) and the scene root does not walk static subtrees, so this
 *    refreshes the subtree first -- the same argument `doodad-provider.ts#gatherOne` makes for a hull
 *    left at the origin. `updateWorldMatrix` only recomputes `matrixWorld` from parents; it cannot
 *    disturb the animation's own local matrices.
 *
 * Geometries are de-duplicated because a submesh with two batches draws the same geometry twice under
 * the same transform (`submesh.js#applyBatches`), and a second identical raycast buys nothing.
 */
function posedMeshEntry(unit: Unit): {
  entry: number | null; triangles: number; meshes: number; box: number[] | null;
} {
  const model = unit.model;
  const submeshes = model
    ? (model as unknown as { submeshes?: THREE.Object3D[] }).submeshes
    : undefined;
  if (!model || !submeshes || submeshes.length === 0) {
    return { entry: null, triangles: 0, meshes: 0, box: null };
  }

  model.updateWorldMatrix(true, true);
  raycaster.set(rayOrigin, rayDirection);
  raycaster.near = 0;
  raycaster.far = Infinity;

  let nearest: number | null = null;
  let triangles = 0;
  let meshes = 0;
  const seen = new Set<THREE.BufferGeometry>();
  _unionBox.makeEmpty();

  for (const submesh of submeshes) {
    if (!submesh.visible) {
      continue;
    }
    for (const child of submesh.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.visible || (mesh as { isMesh?: boolean }).isMesh !== true) {
        continue;
      }
      const geometry = mesh.geometry as THREE.BufferGeometry;
      if (!geometry || seen.has(geometry)) {
        continue;
      }
      seen.add(geometry);
      meshes += 1;
      const index = geometry.getIndex();
      const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      triangles += Math.floor((index ? index.count : (position ? position.count : 0)) / 3);
      // The DRAWN world box, for the instrument only.
      if (geometry.boundingBox === null) {
        geometry.computeBoundingBox();
      }
      if (geometry.boundingBox) {
        _unionBox.union(_scratchBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
      }

      meshHits.length = 0;
      mesh.raycast(raycaster, meshHits);
      for (const hit of meshHits) {
        if (hit.distance >= 0 && (nearest === null || hit.distance < nearest)) {
          nearest = hit.distance;
        }
      }
    }
  }
  meshHits.length = 0;
  return {
    entry: nearest,
    triangles,
    meshes,
    box: _unionBox.isEmpty() ? null : boxArray(_unionBox),
  };
}

/** `Box3` -> the six numbers a probe can compare. */
function boxArray(box: THREE.Box3): number[] {
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
}

/**
 * The DRAWN geometry's world box for one unit, or null while it draws nothing.
 *
 * Exported for the instrument. `worldUnits()` aimed its probe clicks at the unit's MIDRIFF -- feet plus
 * half a collision height, the point `pickSphere` centres on -- and for a FLYING creature that is below
 * the body it draws: measured on a Vale Moth, a click at the midriff missed while the same click 20-40
 * px higher hit. An instrument that aims at a model-space proxy cannot judge a pick against the rendered
 * geometry, which is the whole lesson of the earlier text rounds.
 */
export function drawnWorldBox(unit: Unit): number[] | null {
  const model = unit.model;
  const submeshes = model
    ? (model as unknown as { submeshes?: THREE.Object3D[] }).submeshes
    : undefined;
  if (!model || !submeshes || submeshes.length === 0) {
    return null;
  }
  model.updateWorldMatrix(true, true);
  _unionBox.makeEmpty();
  for (const submesh of submeshes) {
    if (!submesh.visible) {
      continue;
    }
    for (const child of submesh.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.visible || (mesh as { isMesh?: boolean }).isMesh !== true) {
        continue;
      }
      const geometry = mesh.geometry as THREE.BufferGeometry;
      if (!geometry) {
        continue;
      }
      if (geometry.boundingBox === null) {
        geometry.computeBoundingBox();
      }
      if (geometry.boundingBox) {
        _unionBox.union(_scratchBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
      }
    }
  }
  return _unionBox.isEmpty() ? null : boxArray(_unionBox);
}

/**
 * The world box of the M2's AUTHORED COLLISION HULL -- reported by the instrument, used by NOTHING.
 *
 * This is the measurement that convicts the hull: against `posedMeshEntry`'s box, a hull in the same
 * frame as the drawn body overlaps it and a hull in a different frame does not. See the header.
 */
function hullBoxOf(unit: Unit): number[] | null {
  const mesh = unit.model ? unit.model.boundingMesh : null;
  const geometry = mesh ? (mesh.geometry as THREE.BufferGeometry) : null;
  if (!mesh || !geometry) {
    return null;
  }
  mesh.updateWorldMatrix(true, false);
  if (geometry.boundingBox === null) {
    geometry.computeBoundingBox();
  }
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) {
    return null;
  }
  return boxArray(_scratchBox.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
}

/**
 * The nearest unit the ray from `ndc` through the camera hits, or null.
 *
 * `ndc` is normalised device coordinates -- x and y in [-1, 1], y UP, which is the opposite sign
 * from a DOM `clientY`; the caller converts. Everything the local player is (`self`) is excluded:
 * the reference's own scan filters `SelfPlayer`, and clicking your own back to target yourself is
 * not a gesture the client has.
 *
 * NEAREST ALONG THE RAY, by the entry distance rather than by the centre distance. A big creature
 * standing behind a small one has the nearer centre surprisingly often, and picking by centre makes
 * a click on the small one select the large one behind it.
 */
export function pickUnit(
  entities: Iterable<Unit>,
  camera: THREE.Camera,
  ndc: { x: number; y: number },
  self: Unit | null,
  options: PickOptions = {},
): Unit | null {
  const { narrow, occlude } = resolveOptions(options);
  const trace = options.trace;

  rayOrigin.setFromMatrixPosition(camera.matrixWorld);
  rayDirection.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(rayOrigin).normalize();

  let best: Unit | null = null;

  const centre = new THREE.Vector3();
  // TWO PASSES, because the occlusion cast is the expensive half and must not run for a candidate
  // that has already lost: gather and narrow-test everything first, then walk the survivors in
  // distance order and cast only until one is accepted.
  const survivors: { unit: Unit; entry: number; row: PickTraceRow }[] = [];
  for (const unit of entities) {
    // UNITS AND PLAYERS ONLY. `World#entities` is the guid registry for EVERY object the update
    // stream creates, game objects included -- `applyUpdates` builds a `Unit` for a signpost as
    // readily as for a wolf. Measured on a live entry as `Gesf`: 72 entities, 43 with unit fields.
    // Without this filter the first click selected `0x1fc0000000000007`, a game object with no
    // fields at all and a default collision height, whose pick sphere sat in front of the wolf.
    if (unit === self || !unit.view.visible) {
      continue;
    }
    if (unit.objectType !== OBJECT_TYPE_UNIT && unit.objectType !== OBJECT_TYPE_PLAYER) {
      continue;
    }
    const radius = pickSphere(unit, centre);
    toCentre.copy(centre).sub(rayOrigin);
    // Distance along the ray to the point closest to the centre. A NEGATIVE projection means the
    // sphere is behind the camera; it is still tested, because a sphere the camera sits INSIDE has a
    // negative projection and a real forward entry point.
    const along = toCentre.dot(rayDirection);
    const perpendicularSq = toCentre.lengthSq() - along * along;
    const radiusSq = radius * radius;
    if (perpendicularSq > radiusSq) {
      continue;
    }
    const halfChord = Math.sqrt(radiusSq - perpendicularSq);
    // The nearer of the two intersections, or the far one when the camera is inside the sphere.
    const sphereEntry = along - halfChord >= 0 ? along - halfChord : along + halfChord;

    const row: PickTraceRow = {
      guid: unit.guid,
      sphereRadius: radius,
      sphereEntry,
      meshTriangles: 0,
      meshes: 0,
      meshEntry: null,
      fallback: false,
      occludedAt: null,
      entry: null,
      drawnBox: null,
      hullBox: trace ? hullBoxOf(unit) : null,
    };
    if (trace) {
      trace.push(row);
    }
    // NO RANGE TEST. `PICK_RANGE` is TAB's law and the reference's mouse pick is unbounded; see the
    // header. A sphere entirely behind the camera is still out, which is what this keeps.
    if (sphereEntry < 0) {
      continue;
    }

    let entry = sphereEntry;
    if (narrow) {
      const posed = posedMeshEntry(unit);
      row.meshTriangles = posed.triangles;
      row.meshes = posed.meshes;
      row.meshEntry = posed.entry;
      row.drawnBox = posed.box;
      if (posed.meshes === 0) {
        // Nothing drawn yet -- the sphere stands in, and the row says so.
        row.fallback = true;
      } else if (posed.entry === null) {
        // The ray missed every drawn triangle. This is the whole of the reported defect.
        continue;
      } else {
        entry = posed.entry;
      }
    }
    survivors.push({ unit, entry, row });
  }

  survivors.sort((x, y) => x.entry - y.entry);

  for (const candidate of survivors) {
    // OCCLUSION, LAZILY AND ONLY AS FAR AS THIS CANDIDATE. The reference casts once per FRAME to
    // `f32::MAX` because it re-hovers every frame (`hover.rs#update_pick_occlusion`); a click can do
    // better, and the semantics are identical -- a world hit BEYOND the candidate cannot occlude it,
    // so bounding the cast at the candidate's own distance answers the same question. That matters
    // here because the cast's reach sizes the broadphase box that gathers terrain triangles: a cast
    // to the farthest survivor (100 yd on a real screen) gathers the county, and measured it took the
    // whole pick from 0.5 ms to 3.6 ms. The loop breaks on the first candidate it accepts, so the
    // common case is one short cast.
    if (occlude && options.cast) {
      const hit = candidate.entry > 0
        ? options.cast(rayOrigin, rayDirection, candidate.entry - OCCLUSION_SLACK)
        : null;
      // "Discard iff the world hit is STRICTLY nearer -- tie keeps the object" (`hover.rs:29-33`),
      // with `OCCLUSION_SLACK` the float margin and `CAMERA_INSIDE_EPS` the camera-in-geometry case.
      if (hit !== null && hit.distance > CAMERA_INSIDE_EPS) {
        candidate.row.occludedAt = hit.distance;
        continue;
      }
    }
    candidate.row.entry = candidate.entry;
    best = candidate.unit;
    break;
  }
  return best;
}

/**
 * The pick, with its whole verdict -- the instrument behind `window.worldPick`.
 *
 * A pick cannot be checked from a screenshot: "the click selected the wolf" and "the click selected
 * the wolf for the wrong reason" look identical. This reports, per candidate, the sphere it would
 * have used, the hull it did use, and what rejected it -- and it takes the SAME code path production
 * does rather than a second copy of the rule, which is the only reason its answer means anything.
 */
export function pickUnitReport(
  entities: Iterable<Unit>,
  camera: THREE.Camera,
  ndc: { x: number; y: number },
  self: Unit | null,
  options: PickOptions = {},
): PickReport {
  const rows: PickTraceRow[] = [];
  const started = performance.now();
  const unit = pickUnit(entities, camera, ndc, self, { ...options, trace: rows });
  return {
    guid: unit ? unit.guid : null,
    rows,
    ms: performance.now() - started,
    ...resolveOptions(options),
  };
}
