/**
 * `TARGETNEARESTENEMY` -- the TAB pick. Client-side, geometric, and nothing goes on the wire but the
 * selection the winner produces.
 *
 * ## Which law this is, and why it is not the reference's CODE
 *
 * The reference implements TWO and ships the second (`samples/benilla/crates/benilla/src/target/
 * scan.rs:1-46`). The first is the **1.12 byte algorithm**: a *±30° cone about the CHARACTER's
 * facing*, a *cone-first-then-nearest sort*, a *10-yd out-of-cone bubble*, and a snapshot list with a
 * cursor for repeated presses -- byte-verified twice against the client. It then replaced that with a
 * screen-space frustum tiering plus a weighted score, taken from **Legion 7.2 / Classic Era** cvar
 * strings, because the authentic law "skips a close mob that fills your screen".
 *
 * **This client is 3.3.5a, which is six years before that rewrite**, so the cone is what its own
 * engine does and the frustum law would be an anachronism -- the version rule `CLAUDE.md` states
 * ("benilla is authoritative on structure ... not on any version-numbered value") applies to a whole
 * algorithm here, not just to a constant. The owner also asked for the cone in as many words ("в
 * консу"). So the geometry below is the 1.12/3.3.5a law as `scan.rs:4-6` documents it, and the
 * validity filters are the ones the reference kept as byte-law across both designs
 * (`scan.rs:41-46`, `:62-89`).
 *
 * ## What is NOT ported, each with a reason
 *
 *  - **The CreatureType.dbc critter/totem filter** (`scan.rs:332-345`). This client does not read
 *    `CreatureType.dbc` and a unit's creature type only arrives with
 *    `SMSG_CREATURE_QUERY_RESPONSE`, which is fired for the target and nothing else
 *    (`world/index.ts#setTarget`). The reference passes an unresolved type, so a critter being
 *    TAB-able here is the same outcome its own fallback has.
 *  - **`UNIT_FIELD_STAND_STATE == 7`** (`scan.rs:270-274`): that byte is not decoded. `dead` and the
 *    dynamic-flag leg below cover the same units on this server -- measured on this tree, a corpse
 *    reads `dead` true.
 *  - **The snapshot list with a cursor** is a live re-sort per press instead; see `nearestEnemy`.
 */
import Unit from '../classes/unit';
import { REACTION_NEUTRAL, reactionFor } from './faction';
import { PICK_RANGE } from './pick';

/** `ObjectType.Unit` / `ObjectType.Player`, by value -- the same two `pick.ts` admits. */
const OBJECT_TYPE_UNIT = 3;
const OBJECT_TYPE_PLAYER = 4;

/**
 * The cone's HALF-angle about the character's facing, radians (30 degrees).
 * `samples/benilla/crates/benilla/src/target/scan.rs:4` -- "±30° cone about the *character's*
 * facing", byte-verified there against the 1.12 client.
 */
export const CONE_HALF_ANGLE = Math.PI / 6;

/**
 * The out-of-cone bubble (yards): a unit this close is a candidate whatever direction it is in.
 * `scan.rs:5` -- "10-yd out-of-cone bubble".
 */
export const CONE_BUBBLE = 10;

/**
 * The five `UNIT_FIELD_FLAGS` bits `CanAttack 0x606980` disqualifies on -- NON_ATTACKABLE(1),
 * NOT_ATTACKABLE_1(7), NON_ATTACKABLE_2(16), TAXI_FLIGHT(20), NOT_SELECTABLE(25). Bit positions
 * byte-verified by the reference (`scan.rs:62-65`).
 */
const FLAG_DISQUALIFIERS = (1 << 1) | (1 << 7) | (1 << 16) | (1 << 20) | (1 << 25);

/** `UNIT_DYNAMIC_FLAGS` bit 5 -- the reference's own liveness leg (`scan.rs:270-273`). */
const DYNFLAG_DEAD = 1 << 5;

/**
 * `CanAttack 0x606980`: the flag disqualifiers clear AND a reaction that is not friendly.
 *
 * "Not friendly" is `<= neutral` on the client's 1..8 scale, which is the reference's rank `<= 3`
 * (`scan.rs:70-78`: "`UnitReaction(player→target) < 4`", single direction, friendly-only blocked) --
 * the same gate `pages/game/index.tsx#onWorldRightClick` already applies to the attack cursor, so a
 * neutral wolf is TAB-able and simply does not fight back. A reaction that has not resolved yet
 * (`FactionTemplate.dbc` still in flight) is treated as NOT attackable: guessing the other way would
 * make TAB pick friendly NPCs for the first seconds after entry.
 */
export function canAttackUnit(unit: Unit, self: Unit | null): boolean {
  const flags = unit.fields.unitFlags ?? 0;
  if ((flags & FLAG_DISQUALIFIERS) !== 0) {
    return false;
  }
  const reaction = reactionFor(unit, self);
  return reaction !== null && reaction <= REACTION_NEUTRAL;
}

/** Is this unit a legal TAB candidate at all -- liveness plus attackability. */
export function isEnemyCandidate(unit: Unit, self: Unit | null): boolean {
  if (unit === self || !unit.view.visible) {
    return false;
  }
  if (unit.objectType !== OBJECT_TYPE_UNIT && unit.objectType !== OBJECT_TYPE_PLAYER) {
    return false;
  }
  if (unit.dead || ((unit.fields.dynamicFlags ?? 0) & DYNFLAG_DEAD) !== 0) {
    return false;
  }
  return canAttackUnit(unit, self);
}

/** Signed angle difference folded into (-pi, pi]. */
function wrapAngle(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** One scored candidate, and everything the instrument needs to explain the order. */
export interface ScanRow {
  guid: string;
  /** Yards, player to unit, in the XY plane -- the cone is a heading test, not a solid angle. */
  distance: number;
  /** Degrees off the character's facing, signed (positive is to the unit's left of the facing). */
  offAngle: number;
  inCone: boolean;
  inBubble: boolean;
  admitted: boolean;
}

/**
 * What the scan reads. Structural rather than `World` so `__tests__` can drive it with a hand-built
 * pair of units and so this module does not close a cycle back through `world/index.ts`.
 */
export interface ScanWorld {
  entities: { forEach(fn: (unit: Unit) => void): void };
  player: Unit | null;
  target: Unit | null;
}

export interface ScanReport {
  /** The player's own facing at the press, degrees. */
  facing: number;
  rows: ScanRow[];
  /** The admitted list in pick order, best first. */
  order: string[];
  picked: string | null;
  ms: number;
}

/**
 * The candidate list in PICK ORDER: everything in the cone by ascending distance, then everything in
 * the bubble by ascending distance.
 *
 * That two-tier read is `scan.rs:4-5`'s "cone-first-then-nearest sort" plus its "10-yd out-of-cone
 * bubble": the cone decides the TIER and the distance orders within it, and a unit that is neither in
 * the cone nor in the bubble is not a candidate at all. `PICK_RANGE` (41 yd,
 * `targetNearestDistance`) bounds the whole thing.
 */
function ordered(world: ScanWorld, rows: ScanRow[]): Unit[] {
  const self = world.player;
  if (!self) {
    return [];
  }
  // `Unit#facing` is `rotation.z`, the RENDERED body yaw, not `move.faceYaw`, the wire one. The two
  // diverge only while strafing and by at most the stationary chase rate otherwise
  // (`movement/player-state.ts:33-40`), and the rendered yaw is the one the player can see -- which is
  // what "the cone in front of me" means to him. It is also the only accessor a PEER has, so one
  // expression serves any unit.
  const facing = self.facing;
  const cone: { unit: Unit; distance: number }[] = [];
  const bubble: { unit: Unit; distance: number }[] = [];
  world.entities.forEach((unit: Unit) => {
    if (!isEnemyCandidate(unit, self)) {
      return;
    }
    const dx = unit.view.position.x - self.view.position.x;
    const dy = unit.view.position.y - self.view.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const off = wrapAngle(Math.atan2(dy, dx) - facing);
    const inCone = Math.abs(off) <= CONE_HALF_ANGLE;
    const inBubble = distance <= CONE_BUBBLE;
    const admitted = distance <= PICK_RANGE && (inCone || inBubble);
    rows.push({
      guid: unit.guid,
      distance,
      offAngle: (off * 180) / Math.PI,
      inCone,
      inBubble,
      admitted,
    });
    if (!admitted) {
      return;
    }
    (inCone ? cone : bubble).push({ unit, distance });
  });
  cone.sort((a, b) => a.distance - b.distance);
  bubble.sort((a, b) => a.distance - b.distance);
  return [...cone, ...bubble].map((c) => c.unit);
}

/**
 * The press: the next candidate after the current selection, wrapping.
 *
 * **A LIVE RE-SORT PER PRESS, not the 1.12 snapshot + cursor.** Stated as a deviation: the reference
 * describes a list captured on the first press and walked by an index, and its own replacement
 * abandoned that too ("every press re-scores the live world", `scan.rs:27-29`) because a snapshot
 * goes stale -- a unit that dies or walks off mid-cycle is still in it. Cycling here is by POSITION
 * OF THE CURRENT SELECTION in the freshly sorted list, so repeated presses still walk down it; what
 * differs from a snapshot is that a unit which moves between presses can change places.
 *
 * `reverse` is `TARGETPREVIOUSENEMY` -- `Bindings.xml:459-461` passes `1`, its own comment saying
 * "1 (or "true") means reverse!".
 */
export function nearestEnemy(
  world: ScanWorld,
  reverse = false,
  report?: ScanReport,
): Unit | null {
  const rows: ScanRow[] = report ? report.rows : [];
  const started = performance.now();
  const list = ordered(world, rows);
  if (report) {
    report.facing = world.player ? (world.player.facing * 180) / Math.PI : 0;
    report.order = list.map((u) => u.guid);
  }
  let picked: Unit | null = null;
  if (list.length > 0) {
    const current = world.target === null ? -1 : list.indexOf(world.target);
    if (current < 0) {
      picked = reverse ? list[list.length - 1] : list[0];
    } else {
      const step = reverse ? -1 : 1;
      picked = list[(current + step + list.length) % list.length];
    }
  }
  if (report) {
    report.picked = picked ? picked.guid : null;
    report.ms = performance.now() - started;
  }
  return picked;
}

/** A fresh, empty report for `nearestEnemy` to fill -- what `window.worldScan` hands back. */
export function emptyScanReport(): ScanReport {
  return { facing: 0, rows: [], order: [], picked: null, ms: 0 };
}
