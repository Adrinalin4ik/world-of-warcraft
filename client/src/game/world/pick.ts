/**
 * Which unit is under the cursor -- the click-to-target pick.
 *
 * ## The two phases, and what each one is
 *
 * The reference does this in two phases (`samples/benilla/crates/benilla/src/target/hover.rs:1-6`,
 * `:69-80`): a **broad phase** of the cursor ray against the current animation's bounding SPHERE,
 * then a **narrow phase** of the ray against the unit's POSED render mesh, triangle by triangle,
 * with a +1-model-unit halo retry when nothing hits exactly.
 *
 * **The broad phase is the sphere below. The narrow phase is the M2's own AUTHORED COLLISION HULL**
 * (`boundingVertices` / `boundingTriangles`, which `pipeline/m2/index.ts#createBoundingMesh` already
 * meshes as `BoundingMesh` and `collision/doodad-provider.ts` already reads triangles off for every
 * doodad in the world). It is a handful of triangles, it is on the CPU, and it needs no skinning --
 * so the narrow phase costs a ray against ~12 triangles per candidate and no readback.
 *
 * **This is NOT the reference's narrow phase and the difference is stated.** The reference tests the
 * posed RENDER mesh; the hull is authored, static in model space, and coarse -- a box for a humanoid.
 * So a click at the tip of a raised sword still misses, and a click inside the hull but beside the
 * animated body still hits. What it does fix is the reported defect: the SPHERE's radius is the
 * model's whole render bounding-sphere radius, which for a quadruped is half its body LENGTH taken
 * as a radius in every direction, so a click a body-length above or beside a wolf was inside it.
 * A unit whose model has not streamed in yet, or whose M2 ships no collision geometry at all (many
 * do not -- see `createBoundingMesh`), keeps the SPHERE as its volume rather than becoming
 * unclickable; `PickTraceRow.fallback` reports that per candidate so the generosity is visible
 * instead of assumed.
 *
 * ## Occlusion
 *
 * The reference's occlusion leg (`hover.rs#update_pick_occlusion` -- discard an object the terrain
 * hides) IS ported: one zero-radius cast from the camera to the accepted hit point through
 * `collisionWorld`, the same terrain + WMO + doodad set the camera boom already sweeps. It is
 * possible here only because a unit's OWN hull is not in that set -- `Unit`'s `set model`
 * deliberately removes it (`classes/unit.ts:1150-1156`), so a cast toward a wolf cannot be occluded
 * by the wolf.
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

/** Nothing beyond this is pickable. The reference keeps 1.12's `targetNearestDistance` 41 yd. */
export const PICK_RANGE = 41;

/** `ObjectType.Unit` / `ObjectType.Player`, by value so this module does not depend on `network/`. */
const OBJECT_TYPE_UNIT = 3;
const OBJECT_TYPE_PLAYER = 4;

/**
 * How much closer than the hit point an occluder has to be to count (yards). OURS, not sourced.
 *
 * The hull's own surface is routinely embedded in the ground -- a creature's authored volume starts
 * at its feet -- so the terrain triangle the unit is standing on sits within float error of the
 * accepted hit point on any downward-looking click. A quarter yard is the smallest clearance that
 * covers that without letting a real wall this close to the target through.
 */
const OCCLUSION_SKIN = 0.25;

/**
 * A cast that reports contact this close to the camera is the camera being INSIDE geometry, not an
 * occluder. OURS, not sourced. Without it, a camera that has clipped into a hillside or a wall makes
 * every unit in the world unclickable, which is worse than the generosity this leg removes.
 */
const CAMERA_INSIDE_EPS = 0.1;

const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const toCentre = new THREE.Vector3();
const _inverse = new THREE.Matrix4();
const _localRay = new THREE.Ray();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _point = new THREE.Vector3();

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
  /** How many triangles the M2's authored hull has. 0 means there is none to test. */
  hullTriangles: number;
  /** The hull's nearest hit along the ray, or null when the ray misses every triangle. */
  hullEntry: number | null;
  /** True when the sphere stood in for a missing hull (no model yet, or an M2 with no hull). */
  fallback: boolean;
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
 * The ray's nearest hit against a unit's authored collision hull, or null.
 *
 * The test runs in the hull's LOCAL space -- one inverse matrix per candidate instead of
 * transforming every vertex, which is `doodad-provider.ts#gatherOne`'s own argument. The returned
 * POINT is then taken back to world space and projected on the world ray, so the distance is a world
 * distance even under a non-uniform model scale (three's `Ray#applyMatrix4` normalises the direction
 * it transforms, so the local parameter `t` is not a world one -- the point is).
 */
function hullEntry(unit: Unit): { entry: number | null; triangles: number } {
  const mesh = unit.model?.boundingMesh;
  const geometry = mesh?.geometry as THREE.BufferGeometry | undefined;
  const positions = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
  const index = geometry?.getIndex() ?? null;
  const count = index ? index.count : (positions?.count ?? 0);
  if (!mesh || !positions || count < 3) {
    return { entry: null, triangles: 0 };
  }

  // The same refresh `doodad-provider.ts` documents: a hull is a child built at M2 construction with
  // `matrixAutoUpdate` copied from its model, and the scene root does not walk static subtrees.
  mesh.updateWorldMatrix(true, false);
  _inverse.copy(mesh.matrixWorld).invert();
  _localRay.origin.copy(rayOrigin);
  _localRay.direction.copy(rayDirection);
  _localRay.applyMatrix4(_inverse);

  let nearest: number | null = null;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    _a.fromBufferAttribute(positions, i0);
    _b.fromBufferAttribute(positions, i1);
    _c.fromBufferAttribute(positions, i2);
    // BACKFACES COUNT. WoW's collision hulls carry no guaranteed outward winding (the same reason
    // `capsule-cast.ts` derives its side from geometry), and a camera sitting inside a hull sees only
    // its far faces.
    if (_localRay.intersectTriangle(_a, _b, _c, false, _point) === null) {
      continue;
    }
    _point.applyMatrix4(mesh.matrixWorld).sub(rayOrigin);
    const along = _point.dot(rayDirection);
    if (along < 0) {
      continue;
    }
    if (nearest === null || along < nearest) {
      nearest = along;
    }
  }
  return { entry: nearest, triangles: Math.floor(count / 3) };
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
      hullTriangles: 0,
      hullEntry: null,
      fallback: false,
      occludedAt: null,
      entry: null,
    };
    if (trace) {
      trace.push(row);
    }
    if (sphereEntry < 0 || sphereEntry >= PICK_RANGE) {
      continue;
    }

    let entry = sphereEntry;
    if (narrow) {
      const hull = hullEntry(unit);
      row.hullTriangles = hull.triangles;
      row.hullEntry = hull.entry;
      if (hull.triangles === 0) {
        // No authored hull to be precise with -- see the header. The sphere stands in, and the row
        // says so.
        row.fallback = true;
      } else if (hull.entry === null) {
        // A hull the ray missed is a MISS. This is the whole of the reported defect.
        continue;
      } else {
        entry = hull.entry;
      }
    }
    survivors.push({ unit, entry, row });
  }

  survivors.sort((x, y) => x.entry - y.entry);
  for (const candidate of survivors) {
    // `PICK_RANGE`, not a shrinking best-so-far: the list is already sorted, so the first survivor
    // inside the range and not occluded IS the answer. A first draft carried a `bestDistance` that it
    // wrote and then immediately broke out of the loop -- a dead assignment that read like a running
    // minimum, which is worse than none.
    if (candidate.entry >= PICK_RANGE) {
      break;
    }
    if (occlude && options.cast) {
      const reach = candidate.entry - OCCLUSION_SKIN;
      const hit = reach > 0 ? options.cast(rayOrigin, rayDirection, reach) : null;
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
