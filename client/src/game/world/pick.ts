/**
 * Which unit is under the cursor -- the click-to-target pick.
 *
 * ## What is ported, and what is declared missing
 *
 * The reference does this in two phases (`samples/benilla/crates/benilla/src/target/hover.rs:1-6`,
 * `:69-80`): a **broad phase** of the cursor ray against the current animation's bounding SPHERE,
 * then a **narrow phase** of the ray against the unit's POSED render mesh, triangle by triangle,
 * with a +1-model-unit halo retry when nothing hits exactly.
 *
 * **Only the broad phase is ported here, and that is a stated gap, not an oversight.** The narrow
 * phase needs every drawn vertex skinned through the live joint pose on the CPU, once per candidate
 * per click; this client's poses live in GPU-side bone matrices (`pipeline/m2/anim`) and there is no
 * CPU skinning path to read them back through. The visible consequence is that the pick is
 * *generous*: a click just beside a wolf, inside its bounding sphere, selects it. The reference's
 * own pass-2 halo retry exists to be generous too, so this errs in the direction the reference
 * already chose -- it simply cannot be un-generous where the reference is precise.
 *
 * The occlusion leg (`hover.rs#update_pick_occlusion` -- discard an object hit the terrain occludes)
 * is also NOT ported. `collisionWorld` could answer it, and a wolf behind a wall is therefore
 * clickable. Named here rather than left to be discovered.
 *
 * ## The sphere
 *
 * Centred half a collision height above the unit's feet and sized by the larger of that half-height
 * and the model's authored render radius. `Unit#collisionHeight` is `CreatureModelData.collisionHeight
 * x displayScale` -- the same number the swim depth lines and the mover use -- and `M2#vertexRadius`
 * is the M2 header's own bounding-sphere radius (`pipeline/m2/index.ts:202-204`), which is in MODEL
 * units and so is multiplied by the scale actually applied to the view. A unit whose model has not
 * streamed in yet still has a collision height, so it is still clickable, which is what makes
 * clicking a creature the instant it appears work.
 */
import * as THREE from 'three';

import Unit from '../classes/unit';

/** Nothing beyond this is pickable. The reference keeps 1.12's `targetNearestDistance` 41 yd. */
export const PICK_RANGE = 41;

/** `ObjectType.Unit` / `ObjectType.Player`, by value so this module does not depend on `network/`. */
const OBJECT_TYPE_UNIT = 3;
const OBJECT_TYPE_PLAYER = 4;

const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const toCentre = new THREE.Vector3();

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

/**
 * The nearest unit whose pick sphere the ray from `ndc` through the camera enters, or null.
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
): Unit | null {
  rayOrigin.setFromMatrixPosition(camera.matrixWorld);
  rayDirection.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(rayOrigin).normalize();

  let best: Unit | null = null;
  let bestDistance = PICK_RANGE;

  const centre = new THREE.Vector3();
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
    const entry = along - halfChord >= 0 ? along - halfChord : along + halfChord;
    if (entry < 0 || entry >= bestDistance) {
      continue;
    }
    bestDistance = entry;
    best = unit;
  }
  return best;
}
