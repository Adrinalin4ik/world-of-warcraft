// import * as THREE from "three";
import * as THREE from 'three';
import DebugPanel from '../../pages/game/debug/debug';
import DBC from "../pipeline/dbc";
import M2 from "../pipeline/m2";
import { windowElapsedOrInstant } from "../pipeline/m2/anim/instance-anim";
import type { Sequence } from "../pipeline/m2/anim/model-anim";
import { worldClock } from "../pipeline/m2/anim/world-clock";
import M2Blueprint from "../pipeline/m2/blueprint";
import { failedTexturePaths } from "../pipeline/m2/material";
import { revealWhenWarm } from "../pipeline/program-warm";
import ColliderManager from "../world/collider-manager";
import { CastFn, collisionWorld } from "../collision/collision-world";
import { CollisionLayer } from "../collision/types";
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  DEFAULT_COLLISION_HEIGHT,
  SETTLE_TIMEOUT,
  capsuleHalfSegment,
} from "../movement/constants";
import { snapToGround } from "../movement/mover";
import { shouldPose } from "../pipeline/m2/anim/gating";
import { createPlayerMoveState } from "../movement/player-state";
import { peerTrace } from "../movement/peer-trace";
import { readyAnimation } from "./combat-anim";
import {
  ANY_MOVE,
  DEFAULT_MOVE_SPEEDS,
  MoveFlag,
  MoveSpeeds,
  RUNAWAY_SILENCE_MS,
  REMOTE_SNAP_DISTANCE,
  RemoteJumpInfo,
  RemoteMotion,
  RemoteMove,
  SplineRide,
  advanceRemote,
  applyRemoteMove,
  createRemoteMotion,
  easeDisplayYaw,
  makeSplineRide,
  remoteSilentMs,
  sampleSpline,
  strafeBodyOffset,
  wrapPi,
} from "../movement/net-motion";
import {
  applyCharacterLook,
  attachCharacterItems,
  loadCharacter,
} from "../character/dress";
import { compositeCacheKey } from "../ui/scene/body-composite";
import {
  CharacterIdentity,
  CharacterLook,
  resolveCharacterLook,
} from "../ui/scene/character-look";
import { resolveNpcLook } from "../ui/scene/npc-look";
import Entity from "./entity";
// TYPE-ONLY, and deliberately: `unit-fields.ts` imports `Unit` back for its own signatures, so a
// value import either way round would be a runtime cycle. `import type` is erased entirely.
import type { UnitFieldUpdate } from "../../network/game/object/update-object/unit-fields";

enum SlopeType {
  sliding,
  climbing,
  none
}

/**
 * One-shot / state animation ids, `AnimationData.dbc` ids.
 *
 * EVERY member here is cited. This enum was previously a set of numbers read off a per-model
 * sequence-table listing in a comment block rather than off the DBC, and FIVE of the six were
 * wrong:
 *
 * - `forward = 2`, `backward = 133`, `rotating = 38` -- deleted with `updateMoving`. Row 133 is
 *   `FishingCast`; the backpedal is `WalkBackwards` 13 (`select.rs:431`) and the turn-in-place is
 *   `ShuffleLeft` 11 / `ShuffleRight` 12 (`select.rs:458`).
 * - `jump = 15` -- WRONG, and corrected below. The reference's jump ENTRY clip is `JumpStart` 37
 *   (`select.rs:295`, `select/tests.rs:187`). Nothing in the reference names 15 at all.
 * - `grounding = 16` -- WRONG, and DELETED. Row 16 is `AttackUnarmed`, a bare-hands swing
 *   (`select.rs:621,629`), not a landing. The landing pick is `JumpEnd` 39 when stopped and
 *   `JumpLandRun` 187 when moving (`select.rs:339-340`, `select/tests.rs:193-194`). Its only
 *   reference in this file was already commented out, so nothing replaces it; landing is a
 *   follow-up, because a correct one needs the touchdown movement flags to choose between 39
 *   and 187.
 */
enum Animation {
  /** Stand. DBC name row 0; `Rabbit.m2`'s only sequence, and slot 0 of wolf / kobold / murloc. */
  idle = 0,

  /**
   * `JumpStart` -- the jump bracket's ENTRY one-shot (`select.rs:295`, `select/tests.rs:187`).
   *
   * The reference plays a three-part bracket: JumpStart 37 -> a `Jump` 38 hang loop while airborne
   * -> a landing pick of JumpEnd 39 / JumpLandRun 187 (`select.rs:270`, `:339-340`). Only the entry
   * is wired here, because `jump()` still has no caller -- Controls drives the player's jump
   * through the mover and never touches animation. Wiring the full bracket is a follow-up.
   */
  jump = 37
}

/**
 * `Death`. DBC row 1, confirmed by the task probe (id 1 observed in a parsed sequence table) and
 * by the reference, which gives death its own arm-once-and-hold guard (`driver.rs:351`,
 * `if drv.gait != Some(DEATH)`).
 *
 * Locomotion treats it as TERMINAL: see `updateLocomotion`'s ownership check. A corpse must not
 * stand back up when the one-shot's window elapses.
 */
const DEATH = 1;

// -- Locomotion ----------------------------------------------------------------------------------
// Ported from the reference selector, `samples/benilla/crates/benilla/src/creature_anim/select.rs`
// (`gait_candidates`, lines 395-506). Ids are `AnimationData.dbc` ids, NOT sequence-table slots.

/**
 * The `AnimationData.dbc` ids the gait cascade names. Every one is cited to the reference's own
 * table, which is transcribed from the client's `0x5fd100` / `0x5fd8b0` chain.
 */
/** Stand. DBC name column row 0 = `Stand`; slot 0 of every model parsed for this task. */
const STAND = 0;
/** `ShuffleLeft` / `ShuffleRight` -- the turn-in-place foot shuffle (`select.rs:491-495`). */
const SHUFFLE_LEFT = 11;
const SHUFFLE_RIGHT = 12;
/** `WalkBackwards` -- the backpedal, which OUTRANKS strafe on the ground (`select.rs:463`). */
const WALK_BACKWARDS = 13;
/** Walk. DBC row 4 -- its own fallback column is empty, i.e. Walk falls back to Stand. */
const WALK = 4;
/** Run. DBC name column row 5 = `Run`; wolf and kobold both carry it inline (flags `0x20`). */
const RUN = 5;
/** `Sprint`, taken above `FAST_RUN_SPEED` (`select.rs:481`). */
const SPRINT = 143;
/** The jump bracket and the free fall (`select.rs:307-308`, `:318-319`, `:368-376`). */
const JUMP_START = 37;
const JUMP_HANG = 38;
const JUMP_END = 39;
const FALL = 40;
const JUMP_LAND_RUN = 187;
/** The swim family (`select.rs:439-452`). `SWIM_IDLE` is the tread-water idle, not Stand. */
const SWIM_IDLE = 41;
const SWIM = 42;
const SWIM_LEFT = 43;
const SWIM_RIGHT = 44;
const SWIM_BACKWARDS = 45;

/**
 * Gait candidate lists, most specific first -- the reference picks a LIST, not an id, so a model
 * that lacks the ideal clip steps DOWN one rung rather than snapping straight to Stand
 * (`select.rs:426-537`). This matters here because `ModelAnim#resolve` falls back to sequence 0 and
 * nothing else: asking it for Run on a model that only walks would yield Stand, which is a creature
 * sliding along the ground. Walking it instead is both correct and what the reference does.
 *
 * Module-level and frozen: `gaitCandidates` runs per unit per frame and must not allocate, and
 * `updateLocomotion` memoises against LIST IDENTITY, so a freshly built array would defeat the memo
 * and re-run the resolve scan every frame.
 */
const GAIT_SPRINT: readonly number[] = [SPRINT, RUN, WALK, STAND];
const GAIT_RUN: readonly number[] = [RUN, WALK, STAND];
const GAIT_WALK: readonly number[] = [WALK, STAND];
const GAIT_STAND: readonly number[] = [STAND];
const GAIT_BACKWARD: readonly number[] = [WALK_BACKWARDS, WALK, STAND];
const GAIT_SHUFFLE_LEFT: readonly number[] = [SHUFFLE_LEFT, STAND];
const GAIT_SHUFFLE_RIGHT: readonly number[] = [SHUFFLE_RIGHT, STAND];
const GAIT_SWIM_IDLE: readonly number[] = [SWIM_IDLE, STAND];
const GAIT_SWIM: readonly number[] = [SWIM, SWIM_IDLE, STAND];
const GAIT_SWIM_LEFT: readonly number[] = [SWIM_LEFT, SWIM, SWIM_IDLE, STAND];
const GAIT_SWIM_RIGHT: readonly number[] = [SWIM_RIGHT, SWIM, SWIM_IDLE, STAND];
const GAIT_SWIM_BACK: readonly number[] = [SWIM_BACKWARDS, SWIM_IDLE, STAND];
/**
 * THE ENGAGED STANDING IDLES, one list per weapon bucket -- `gait_candidates`' Ready rung
 * (`select.rs:497-506`). Each falls back through `ReadyUnarmed` 25 before Stand, because a model may
 * own the unarmed guard and not the two-handed one.
 */
const READY_UNARMED = 25;
const GAIT_READY_UNARMED: readonly number[] = [READY_UNARMED, STAND];
const GAIT_READY_1H: readonly number[] = [26, READY_UNARMED, STAND];
const GAIT_READY_2H: readonly number[] = [27, READY_UNARMED, STAND];
const GAIT_READY_2HL: readonly number[] = [28, READY_UNARMED, STAND];

/** Airborne. `Fall` is entered directly, with no entry one-shot (`select.rs:308`). */
const GAIT_FALL: readonly number[] = [FALL, STAND];
const GAIT_JUMP_HANG: readonly number[] = [JUMP_HANG, FALL, STAND];

/**
 * Every id the cascade can select. Membership means "a gait", and a gait request never takes the
 * body away from the gait driver, whoever sent it.
 *
 * Without this, a wire-sent Stand -- which the peer handler does send, and which the server sends
 * constantly -- would latch `externalSeq` onto a LOOPING sequence, and a looping owner never
 * releases: the unit would stand still for the rest of the session no matter how far it walked. The
 * reference draws the same line, between its `Special` / `Mode` states and the gait itself
 * (`select.rs:280+`).
 *
 * `JUMP_START` 37 is deliberately NOT here: the jump ENTRY is a non-preemptible one-shot that must
 * own the body until its window elapses, which is exactly what the latch is for
 * (`select.rs:283-287`, `Mode::Entering`).
 *
 * THE LANDING CLIPS 39 / 187 ARE HERE, and that changed this round. The reference's landing is
 * `Mode::Land` -- "a plain, FREELY-OVERWRITTEN pick" that "re-picks the instant any movement flag
 * changes" (`select.rs:388-397`) -- i.e. a gait-level choice, not a bracket. Latched, JumpEnd's
 * authored second rooted the avatar in his landing crouch while the player was already pressing
 * forward. `updateLocomotion`'s `locoLand` is the pick; membership here is what stops the arm taking
 * ownership away from the gait driver.
 */
const GAIT_IDS = new Set<number>([
  STAND, WALK, RUN, SPRINT, WALK_BACKWARDS, SHUFFLE_LEFT, SHUFFLE_RIGHT,
  SWIM_IDLE, SWIM, SWIM_LEFT, SWIM_RIGHT, SWIM_BACKWARDS, JUMP_HANG, FALL,
  JUMP_END, JUMP_LAND_RUN,
  // The Ready idles are GAITS, not combat one-shots: they are looping states the cascade selects, and
  // a latch on one would never release (`externalSeq`'s "a looping owner never releases").
  READY_UNARMED, 26, 27, 28,
]);

function isGaitId(id: number): boolean {
  return GAIT_IDS.has(id);
}

/**
 * The ids whose playback rate is scaled by ground speed -- the reference's `RATE_SCALED`
 * (`select.rs:965`), which is a WHITELIST and not a property of the clip. Everything else (Stand,
 * Fall, SwimIdle, every emote and every swing) plays at 1x however fast the body is moving.
 */
const RATE_SCALED = new Set<number>([
  WALK, RUN, SHUFFLE_LEFT, SHUFFLE_RIGHT, WALK_BACKWARDS,
  JUMP_START, JUMP_HANG, JUMP_END, SWIM, SWIM_LEFT, SWIM_RIGHT, SWIM_BACKWARDS,
  135 /* Fly */, SPRINT, JUMP_LAND_RUN,
]);

/**
 * Ground speed (yd/s) at or above which the cascade takes `Sprint` -- `select.rs:13`'s
 * `FAST_RUN_SPEED`. Nothing in 3.3.5a reaches it on foot; a speed buff or a mount does.
 */
const FAST_RUN_SPEED = 11.0;

/**
 * Below this ground speed (yd/s) a unit counts as standing still -- `select.rs:19`'s
 * `MOVING_EPSILON`, which guards the near-zero residual a streamed mover leaves behind.
 */
const MOVING_EPSILON = 0.1;

/**
 * The walk speed the run boundary is measured against is now PER UNIT (`Unit#speeds.walk`, seeded
 * from `DEFAULT_MOVE_SPEEDS` and overwritten by `MSG_MOVE_SET_WALK_SPEED`), which is what
 * `select.rs:487`'s `walk_speed` is. The old module-level `DEFAULT_WALK_SPEED` constant is gone
 * rather than kept beside it: two walk speeds, one of them stale, is how a boundary silently stops
 * agreeing with the reference.
 */

/**
 * Displacement speed (yd/s) above which a measured frame is a TELEPORT, not locomotion.
 *
 * A worldport or a spawn snap moves a unit hundreds of yards in one frame. Without this the unit
 * would flash into its run cycle for exactly one frame on arrival. Well above any real gait
 * (vanilla MOVE_RUN is 7) and well below any real relocation.
 */
const TELEPORT_SPEED = 100;

/**
 * The swept cast a PEER's dead-reckoned step is resolved against, and the scratch it needs.
 *
 * One closure for every peer in the world, built on first use: the capsule shape is a constant
 * (`CAPSULE_RADIUS` / `capsuleHalfSegment`, the same pair `Controls` hands the local mover), so a
 * per-unit closure would be a per-unit allocation for identical behaviour. Built lazily rather than
 * at module load because `collisionWorld` is a singleton every movement test would then touch.
 *
 * The `Walk` audience, not `Camera`: this asks where a BODY can stand.
 */
let _remoteCast: CastFn | null = null;
function remoteCast(): CastFn {
  if (_remoteCast === null) {
    _remoteCast = collisionWorld.castFor(
      CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment(),
    );
  }
  return _remoteCast;
}
const _remoteFrom = new THREE.Vector3();

/**
 * Is this unit's Z far enough from the terrain under it to be worth a swept cast?
 *
 * The cheap half of the ground snap. `TerrainProvider#heightAt` is a heightmap interpolation at
 * 0.065 ms; the swept capsule cast that follows is 0.92 ms (both measured directly on loaded
 * Northshire). A unit already standing on the ground -- which is most units, most frames -- answers
 * here and pays nothing more.
 *
 * `null` (no registered chunk) answers TRUE: an unstreamed tile is not evidence that the pose is
 * right, and the cast may still find a WMO floor the heightmap knows nothing about.
 *
 * The threshold is a hair over the cast's own skin: below it, the snap could not move the body
 * meaningfully anyway.
 */
const GROUND_SNAP_EPSILON = 0.03;
function needsGroundSnap(pos: THREE.Vector3): boolean {
  const floor = collisionWorld.terrain.heightAt(pos.x, pos.y);
  return floor === null || Math.abs(pos.z - floor) > GROUND_SNAP_EPSILON;
}

/**
 * Below this separation (yd^2) a mob keeps its heading instead of facing its victim. OURS.
 *
 * A tenth of a yard apart. `atan2(0, 0)` is 0, so a victim standing exactly on the mob would otherwise
 * snap it to face east; and at zero separation there is no bearing to face in any case.
 */
const COMBAT_FACING_MIN_SQ = 0.01;

class Unit extends Entity {
  public guid: string;
  public name: string = "<unknown>";
  public level: number = 0;
  public target: Unit | null = null;
  public health: number = 0;
  public mana: number = 0;

  public isPlayer: boolean = false;

  /**
   * THE UNIT DESCRIPTOR FIELDS the wire actually sent, as sent.
   *
   * A bag rather than a widening of the four scalars above, for two reasons. Partial updates are the
   * normal case -- a values-only packet carries only what changed -- so "absent" and "zero" must stay
   * distinguishable, and `undefined` is the only honest spelling of absent. And a unit frame needs
   * seven of these together; a caller holding one object cannot read a half-written set.
   *
   * Written ONLY by `network/game/object/update-object/unit-fields.ts#applyUnitFields`, which is also
   * where every offset is cited. The four scalars above are mirrored from it for the callers that
   * predate it.
   */
  public fields: UnitFieldUpdate = {};

  /**
   * `ObjectType` from the create block (3 Unit, 4 Player, ...).
   *
   * Kept because a VALUES-ONLY update carries no type of its own, and an update mask index means a
   * different field for each type (`enums.ts#getUpdateFieldName`). Without remembering it, every
   * post-create field would have to be decoded against a guess.
   */
  public objectType: number = 3;

  /**
   * `SMSG_CREATURE_QUERY_RESPONSE.rank`, mapped by `lua/api/units.ts#classificationWord`.
   *
   * NOT a descriptor field -- there is no `UNIT_FIELD_CLASSIFICATION`. It arrives only in the
   * creature query reply, which is why a freshly-seen creature is `normal` until the reply lands.
   */
  public classification: string = 'normal';

  /**
   * The client's 1..8 reaction scale toward the local player, or null while unknown.
   *
   * Derived from `unit_field_factiontemplate` through `FactionTemplate.dbc`
   * (`game/world/faction.ts`), which is an async DBC load -- hence nullable rather than defaulted to
   * neutral, so "not resolved yet" and "genuinely neutral" stay different.
   */
  public reaction: number | null = null;

  /**
   * In melee auto-attack, from the `SMSG_ATTACKSTART` .. `SMSG_ATTACKSTOP` bracket
   * (`network/game/object/combat.ts`). NOT a descriptor field -- the attack edges are packets.
   */
  public inCombat: boolean = false;

  /** Who this unit is swinging at, as a guid, while `inCombat`. */
  public combatTarget: string | null = null;

  /**
   * WHERE THIS UNIT SHOULD BE LOOKING because it is fighting whatever stands there, or null.
   *
   * The OWNER'S OWN SPECIFICATION of the rule, verbatim: "Это интерполяция. Моб всегда должен
   * смотреть на цель, которую атакует. Пакеты движения будут лишь корректировать направление когда
   * будет приходить пакет." So a mob in combat faces its victim CONTINUOUSLY, client-side, and a
   * movement packet is a CORRECTION rather than the mechanism -- which is why this is a client rule
   * and not a wire field to decode.
   *
   * A world-space point rather than a guid, and filled by `World#animateEntities` each frame, because
   * a `Unit` cannot resolve a guid: it holds no registry. That is the same division `movement/`
   * already uses when it takes a `CastFn` instead of the collision world.
   */
  public combatFacingPoint: THREE.Vector3 | null = null;

  /**
   * WHO IS SWINGING AT THIS UNIT -- the other end of the same `SMSG_ATTACKSTART` .. `SMSG_ATTACKSTOP`
   * bracket, keyed by attacker guid.
   *
   * THE OWNER'S REPORT, and it is the local character as much as a peer: "a mob is biting him and he
   * stands in the out-of-combat idle". MEASURED (`scratchpad/pj-fight.js`, account 2, `Gdsh` beside a
   * Diseased Timber Wolf at 0.9 yd): after we send `CMSG_ATTACKSTOP`, our `inCombat` goes false and our
   * armed sequence drops to **Stand 0 for 55 samples / 8.2 s** while the wolf holds `AttackUnarmed 16`,
   * its own `inCombat` true and its `combatTarget` our guid, and our health falls 51 -> 41. So the
   * victim is in a fight the animation layer cannot see.
   *
   * AND THE FLAGS ARE NOT THE ROUTE -- now measured rather than assumed. `UNIT_FIELD_FLAGS` read
   * `0x8` (PVP_ATTACKABLE) identically in all three phases: standing idle, swinging, and being bitten
   * without swinging; `UNIT_DYNAMIC_FLAGS` stayed `0x0` throughout (`FL1-report.json`). Whatever this
   * server re-sends on entering combat, it is not either flag word, so `UNIT_FLAG_IN_COMBAT` cannot be
   * the source and the opcode bracket is the only one there is.
   *
   * A STATED DEVIATION FROM THE REFERENCE. benilla marks `Engaged` on the ATTACKER only
   * (`benilla/src/net/apply/combat.rs:22-28`: `if let Some(&e) = index.0.get(&attacker) { ... insert(
   * Engaged) }`, with the note that the client's arm "gates on the auto-attack-target GUID being set"),
   * so a victim who has not swung is not engaged there either. That is 1.12 and it is the mechanism for
   * an ATTACKER; nothing in it argues that a mauled player should stand relaxed, and the real client
   * does not. Both ends of the bracket are therefore marked here, from the same two packets, with no
   * new wire surface.
   *
   * A SET rather than a boolean because three wolves are three brackets: the guard drops when the LAST
   * of them stops. KNOWN LIMIT, stated: an attacker that despawns without an `SMSG_ATTACKSTOP` leaves
   * its guid here, and the victim then holds the Ready idle until something else clears it. `died()`
   * clears the victim's own set; a stale attacker is not pruned and would show as a unit guarding
   * nothing.
   */
  public attackedBy: Set<string> = new Set();

  /**
   * Is this unit in a fight -- swinging, or being swung at? The one engagement test, so the gait
   * cascade and any later reader cannot disagree about it. See `attackedBy`.
   *
   * Both halves are written as explicit tests rather than as truthiness because every locomotion unit
   * test drives `updateLocomotion` with `.call()` on a hand-built double, where a missing field is
   * `undefined` rather than `false` and a missing Set is `undefined` rather than empty.
   */
  public get engaged(): boolean {
    return this.inCombat === true || (this.attackedBy ? this.attackedBy.size > 0 : false);
  }

  /**
   * The equipped weapon ENTRY ids the swing clip is picked from -- see `combat-anim.ts` for the two
   * different descriptor fields these come out of and why a creature's and a player's differ.
   */
  public equippedMainhand: number = 0;
  public equippedOffhand: number = 0;

  /**
   * `GetSpellBonusDamage(school)` for the seven spell schools -- `$SP`'s source. Empty until a values
   * block carries the block; see `update-object/unit-fields.ts#SPELL_SCHOOL_COUNT` for why it sits here
   * beside the weapons rather than inside `fields`.
   */
  public spellDamage: number[] = [];

  /** Whether the death one-shot is armed. Written only by `setDead`, which is edge-triggered. */
  public dead: boolean = false;

  /**
   * This unit's animation comes off the wire, so LOCOMOTION MUST NOT RUN FOR IT.
   *
   * Set by the peer handler (`network/entity/entity.ts`) on the first message of either kind. Those
   * units are not merely also-driven, they are UNMEASURABLE: a peer's `view.position` is written
   * only on the frames a `movement` message lands, while locomotion differences that position every
   * render frame. On a quiet frame the displacement is zero and reads as Stand; on the frame a
   * coalesced batch arrives, the whole accumulated displacement is divided by ONE frame's delta and
   * lands above `TELEPORT_SPEED`, which also reads as Stand. In between it reads as a gait. So the
   * measurement alternates at message cadence and re-arms on every flip, pinning the cursor near
   * zero -- the same freeze the re-arm guards exist to prevent, arriving through the other door.
   *
   * Nothing is lost by skipping them: the wire already carries their gait, chosen by the very same
   * `updateLocomotion` running on the peer's own machine.
   *
   * NOT LATCHED FOR EVER -- `setMovingData` clears it. Spline-driven creatures are the opposite
   * case: this client integrates their path itself, frame by frame, so their displacement is a real
   * measurement and locomotion must run. A creature that took one snapped position update and then
   * received a spline would otherwise be locomotion-silent for the rest of its life. Whichever kind
   * of motion arrived most recently is the one that decides.
   */
  public wireDriven: boolean = false;

  private _view: THREE.Group = new THREE.Group();
  private _displayId: number = 0;
  private _model: M2 | null = null;
  private modelData: DBC | null = null;
  private playerGeometry: THREE.BoxGeometry = new THREE.BoxGeometry(5, 5, 5);
  private playerMaterial: THREE.MeshBasicMaterial = new THREE.MeshBasicMaterial(
    {
      // A NUMBER, not the string '0xff0000'. THREE.Color parses a string as a CSS colour, where
      // "0xff0000" is not a name and not a #hex, so it logged `THREE.Color: Unknown color 0xff0000`
      // and left the material white. The debug collider box is meant to be red.
      color: 0xff0000,
      // wireframe: true,
      // opacity: 1
    }
  );
  public collider: THREE.Mesh = new THREE.Mesh(
    this.playerGeometry,
    this.playerMaterial
  );
  /**
   * The `AnimationData.dbc` ID this unit is asking to play -- NOT an index into the model's sequence
   * table.
   *
   * The distinction is the whole point of routing through `ModelAnim#resolve`: the ids in the
   * `Animation` enum below (2 = forward, 133 = backward, 38 = rotating) are DBC ids, and a model's
   * sequence table is a sparse, per-model selection of them in file order. Indexing the table with
   * one of these ids plays whatever unrelated sequence happens to sit at that slot, or nothing at
   * all for the many models with fewer than 134 sequences. It was named `currentAnimationIndex`
   * while nothing read it.
   */
  public currentAnimationId: number = 0;
  private displayInfo: DBC | null = null;

  /**
   * The kinematic mover's state -- feet position, velocities, facing, swim latch.
   *
   * This is the authority on where the unit is. `syncViewFromMove()` pushes it onto the scene
   * graph; nothing should write `view.position` directly.
   */
  public move = createPlayerMoveState();

  /**
   * The unit's own collision height (yd) -- `CreatureModelData.collisionHeight x displayScale`.
   * Every swim depth line is a fraction of it. NOT the movement capsule, which is a constant.
   */
  public collisionHeight: number = DEFAULT_COLLISION_HEIGHT;

  public rotateSpeed: number = 2;

  /**
   * This unit's wire speed set, yd/s -- what the peer dead-reckon integrates with and what the gait
   * selector's walk/run boundary is measured against.
   *
   * Per unit, not shared: `DEFAULT_MOVE_SPEEDS` is spread, not aliased, or one `MSG_MOVE_SET_RUN_SPEED`
   * would re-speed every unit in the world.
   */
  public speeds: MoveSpeeds = { ...DEFAULT_MOVE_SPEEDS };

  private _moveSpeed: number = 100; //10

  /**
   * TWO DIFFERENT THINGS SHARE THIS NAME, which is why it is an accessor rather than a field.
   *
   * The 100 is a legacy debug scalar for `updatePlayer` -- a yd/s figure no character has ever
   * moved at, from the pre-mover movement code whose only call site is commented out
   * (`update()`: `// this.updatePlayer(delta)`). But the packet layer ALSO writes this field with
   * the real wire run speed (`network/game/object/player/movement.ts:303,336`, from
   * `MSG_MOVE_SET_RUN_SPEED` and `SMSG_FORCE_RUN_SPEED_CHANGE`).
   *
   * So a dead-reckon that read `moveSpeed` as "the run speed" would extrapolate a peer at 100 yd/s
   * until his first speed packet arrived -- fourteen times too fast. `speeds.run` starts at the real
   * 7.0 and this setter forwards the wire value into it, which keeps the packet layer's existing
   * write correct without changing it (that file is owned by another agent this round).
   */
  public get moveSpeed(): number {
    return this._moveSpeed;
  }

  public set moveSpeed(value: number) {
    this._moveSpeed = value;
    // VALIDATED, because this value now integrates a body rather than just being reported.
    //
    // MEASURED, live, two accounts in Elwynn: the walking peer's run speed arrived as
    // -3.689e19 (-2^65, the shape of a misaligned float read), and the dead reckoning duly carried
    // him 3.7e19 yd in one frame. Interpolating between wire positions -- what this replaced --
    // could not be hurt by a wrong speed, so the wire has never been checked here.
    //
    // The ceiling is `TELEPORT_SPEED`, the same 100 yd/s that already means "this is not locomotion"
    // for the measured leg. Vanilla's fastest is the 32 yd/s flight speed, so no real speed comes
    // near it. A rejected value leaves `speeds.run` alone -- the previous good speed, or the 7.0
    // default -- rather than substituting a guess, and says so once.
    if (Number.isFinite(value) && value > 0 && value <= TELEPORT_SPEED) {
      this.speeds.run = value;
      return;
    }
    if (this.rejectedSpeed !== value) {
      this.rejectedSpeed = value;
      console.warn(
        `movement: ignoring an impossible run speed ${value} for ${this.guid} --`
        + ` keeping ${this.speeds.run} yd/s. A speed this far outside 0..${TELEPORT_SPEED} is a`
        + ' misread float on the wire, not a buff.',
      );
    }
  }

  /** The last speed value rejected above, so the warning fires once per distinct bad value. */
  private rejectedSpeed: number | null = null;

  public flySpeed: number = 100; //10
  public gravity: number = -30; //10;
  public jumpVelocityConst: number = 16;
  public jumpVelocity: number = 0;
  public isFly: boolean = true;
  public _isJump: boolean = false;
  public isCollides: boolean = false;
  public groundDistance: number = 0;
  private previousGroundDistance: number = 0;
  private minGroundDistance: number = 0.1;
  private groundZeroConstant: number = 1.5; // точка с которой будет считаться что мы на земле
  private _groundFollowConstant: number = 1; // точка с которой нужно начинать следовать рельефу
  private groundDistanceRaycaster: THREE.Raycaster = new THREE.Raycaster(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1)
  );
  private prevPosition: THREE.Vector3 = new THREE.Vector3();
  public useGravity: boolean = true;
  private slopeLimit = 45; //максимальный угол между землей и юнитом до падения (грудусы)
  public slopeAng: number = 0;
  public slopeType: SlopeType = SlopeType.none;

  public moving = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false,
    strafeUp: false,
    strafeDown: false,
    rotateRight: false,
    rotateLeft: false
  };

  public jumpMoving = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false
  };

  //helpers
  public arrow: THREE.ArrowHelper = new THREE.ArrowHelper(
    this.groundDistanceRaycaster.ray.direction,
    this.groundDistanceRaycaster.ray.origin,
    100,
    0x8888ff
  );
  

  public currentMovingTime: number = 0;
  public totalMovingTime: number = 0;

  /**
   * The server-dictated path this unit is walking (`SMSG_MONSTER_MOVE`, or a create block's
   * MOVEMENTFLAG_SPLINE_ENABLED tail), or null when it is not path-walking.
   *
   * Replaces a `THREE.CatmullRomCurve3` built with `closed = true` and stepped by
   * `delta / moveSpeed / 4`. Three things were wrong with that and each one alone was fatal:
   *  - `closed` joins the destination back to the start, so every patrol was a LOOP through a
   *    segment the server never sent;
   *  - a Catmull-Rom through a ground path is not what the client does -- ground creature follow is
   *    a straight segment lerp (benilla `net/motion/spline.rs:99-107`, byte-verified there);
   *  - the parameter advanced by `delta / moveSpeed / 4` with `moveSpeed` defaulting to 100, i.e.
   *    at a rate with no relation to the DURATION the packet states. The packet's duration is the
   *    entire timing statement and it was discarded.
   */
  public splineRide: SplineRide | null = null;

  /**
   * A peer's `MSG_MOVE_*` stream, interpolated. Non-null only for units the wire positions
   * message-by-message (other players); a spline-walking creature uses `splineRide` instead.
   */
  public remoteMotion: RemoteMotion | null = null;


  private raycaster = new THREE.Raycaster();

  constructor(guid: string) {
    super();
    (window as any).collider = ColliderManager;
    this.guid = guid;

    this.collider.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.collider.name = "Collider";

    // The collider is a physics volume, not something to look at. It was being drawn as an opaque
    // white box standing over the character in every frame -- the "white cube" that appeared in every
    // screenshot of this client. Its geometry and matrix are still used for the capsule shapecast in
    // checkCollisions(), which reads matrixWorld and boundsTree directly and does not care whether the
    // mesh is rendered. Set `visible = true` here if you need to see the collision volume.
    this.collider.visible = false;

    // this.arrow.setDirection(this.groundDistanceRaycaster.ray.direction);
    this.arrow.setDirection(new THREE.Vector3(1, 0, 0));

    // Animation
    this.currentAnimationId = Animation.idle;

    this.view.add(this.collider);
    // this.view.add(this.arrow);
  }

  get facing() {
    return this.rotation.z
  }
  
  // get isOnGround() {
  //   return this.groundDistance <= this.groundZeroConstant;
  // }
  isOnGround = false;

  get isFall() {
    return !this.isOnGround;
  }

  get isJump() {
    return this._isJump;
  }

  set isJump(value) {
    this._isJump = value;
    if (value) {
      this.setAnimation(Animation.jump, true, 0);
    } else {
      // this.setAnimation(Animation.grounding, true, 0);
    }
  }
  get position(): THREE.Vector3 {
    return this._view.position;
  }

  get rotation(): THREE.Euler {
    return this._view.rotation;
  }

  get displayId(): number {
    return this._displayId;
  }

  set displayId(displayId) {
    if (!displayId) {
      return;
    }
    this.resolveDisplay(displayId).catch(console.error);
  }

  /**
   * Which `resolveDisplay` call owns the body, and which display id it finished drawing.
   *
   * The token is the same law `characterLookToken` is: the resolve is four awaits deep and the server
   * re-sends a create-object for the same unit every time it re-enters our grid, so without it two
   * in-flight resolves could land in either order. `appliedDisplayId` is the DEDUPE -- a repeat of the
   * id already on the body costs nothing at all, which matters because a zone of npcs now means an
   * `.m2` clone, a DBC chain and a texture fetch per repeat rather than just the first two.
   */
  private displayToken = 0;
  private appliedDisplayId = 0;

  /**
   * `OBJECT_FIELD_SCALE_X` as the server sent it, or null while it has not been decoded.
   *
   * **THIS IS THE UNIT'S RENDER SCALE, AND IT IS THE WHOLE OF IT.** The reference states the law and
   * says where it verified it (`benilla/crates/benilla/src/entities/attach/mod.rs:711-717`): "Final
   * size = the server's per-object scale (`OBJECT_FIELD_SCALE_X`) alone. The server already folds the
   * unit's DBC scale (`CreatureModelData.modelScale x CreatureDisplayInfo.scale`, or an explicit
   * per-spawn override) into this field, and the real client renders units at the field alone
   * (verified: wow-re `world_model_scale` `0x613ef0`, vmangos `Unit::GetScaleForDisplayId`).
   * Multiplying our own DBC scale on top double-applies it -- `native^2`, worst for the sub-1.0
   * starting-zone scales."
   *
   * MEASURED ON THE LIVE SERVER, because that quotation alone would not settle what THIS realm sends.
   * A Northshire entry with the update-values handler wrapped: every unit in the grid -- the player,
   * the guards, the rabbits, the deer and both wolf displays -- arrives with
   * `OBJECT_FIELD_SCALE_X = 1.0` exactly. The realm folds nothing in. So the reference client draws
   * these wolves at 1.0 and this client was drawing them at `CreatureDisplayInfo.scale`, which is
   * **0.40** for display 31049 and **0.55** for 31048 (read out of the live `CreatureDisplayInfo.dbc`;
   * `CreatureModelData.modelScale` for `Creature\Wolf\Wolf.mdx` (model 43) is **1.0**, so the product
   * the brief expected to be the missing factor is the same number). Measured world-space heights on
   * that entry: player 2.128, wolf at 0.40 -> **0.748**, wolf at 0.55 -> 1.028. 0.748 against a 2.128
   * human is knee-and-boot height, which is exactly what the owner reported; at 1.0 the same wolf is
   * 1.87, whose back and shoulder sit at waist height.
   *
   * `null` and not `1` so that a unit whose create-object has not been parsed yet keeps the old
   * behaviour instead of being forced to 1.0 by a value nobody sent.
   *
   * DELIBERATELY NOT WIRED INTO THE DRESSED PATH (`wearLook` -> `applyCharacterLook`), which keeps
   * using `CharacterLook.scale`. Two reasons, and neither is that the law differs: the glue stage
   * shares that path and has no wire value at all, so it would need the DBC scale anyway; and the
   * only playable race whose column is not 1.0 is Gnome at 1.15, which nothing in this round can
   * verify against the reference client. Left as a stated inconsistency rather than an unverified
   * change to how every peer is sized.
   */
  objectScale: number | null = null;

  /**
   * The scale the body should be drawn at: the server's field when we have it, the DBC scale when we
   * do not.
   *
   * The fallback is not a hedge, it is the pre-existing behaviour kept for the one case that cannot
   * reach the wire value -- a model resolved from a display id assigned locally rather than from a
   * create-object (`Player`'s constructor arms the placeholder `displayId = 21976`).
   */
  private renderScale(displayInfo: any): number {
    return this.objectScale ?? ((displayInfo as any)?.scale || 1);
  }

  /**
   * Re-apply the render scale to a body that is already on screen.
   *
   * Needed because the two inputs do not arrive in a fixed order: `OBJECT_FIELD_SCALE_X` and
   * `UNIT_FIELD_DISPLAYID` come out of the same values block, but the model behind the display id is
   * four awaits away, and a later values-only update can carry a new scale for a body that is already
   * drawn (a growth aura, a mount transition).
   *
   * `updateMatrix()` IS THE LOAD-BEARING LINE. `M2` sets `matrixAutoUpdate = false` on itself
   * (`pipeline/m2/index.ts`), so `scale.setScalar` alone writes a field nothing reads -- the trap that
   * kept gnomes at human size and wolves at 1.0 through several rounds.
   */
  applyRenderScale(): void {
    const model = this._model;
    if (!model) {
      return;
    }
    model.scale.setScalar(this.renderScale(this.displayInfo));
    model.updateMatrix();
  }

  /**
   * Resolve a `CreatureDisplayInfo` id onto this unit -- TWO PATHS, and which one is taken is the
   * row's own `extraInfoID`.
   *
   * Measured on the live 3.3.5a table: 8 811 of 24 262 rows have `extraInfoID = 0` and take their skin
   * from the row's texture-variation columns (the wolves and rabbits, which already worked); 15 451
   * have a non-zero one, are CHARACTER models, and need the runtime texture slots and geoset selection
   * that only the character path supplies. `ui/scene/npc-look.ts` documents the split and its evidence.
   *
   * The npc path is a strict improvement rather than a gamble: if the extra row cannot be resolved it
   * falls through to the display-id path below, which is exactly what it would have done before.
   */
  private async resolveDisplay(displayId: number): Promise<void> {
    if (displayId === this.appliedDisplayId) {
      return;
    }
    const token = ++this.displayToken;

    const displayInfo: DBC = await DBC.load('CreatureDisplayInfo', displayId);
    this._displayId = displayId;
    this.displayInfo = displayInfo;

    const modelData: DBC = await DBC.load('CreatureModelData', displayInfo.modelID);
    this.modelData = modelData;
    this.modelData.path = this.modelData.file.match(/^(.+?)(?:[^\\]+)$/)[1];
    this.displayInfo!.modelData = this.modelData;
    // The unit's OWN collision height -- what every swim depth line is a fraction of, which is
    // why a gnome floats with her head out and a night elf sits deeper. NOT the movement
    // capsule height, which is a constant feel knob. Falls back to the client's own
    // empty-world default when the row carries no usable value, because at zero every depth
    // line collapses and the avatar swims on dry land.
    //
    // THROUGH `renderScale`, so the collision box is the size of the body that is drawn. It used to
    // read `displayInfo.scale || modelData.scale || 1`, an OR of two columns that are a PRODUCT in
    // every source that states the law (`benilla-formats/src/creatures.rs:7`), and neither of them is
    // what a unit is rendered at -- see `objectScale`.
    const rawHeight = (modelData as any).collisionHeight;
    const displayScale = this.renderScale(displayInfo);
    this.collisionHeight = rawHeight > 0 ? rawHeight * displayScale : DEFAULT_COLLISION_HEIGHT;
    this.move.collisionHeight = this.collisionHeight;

    // A CHARACTER LOOK OUTRANKS A DISPLAY ID, whichever lands last. `Player`'s constructor kicks
    // off the placeholder `displayId = 21976` at session construction, and the server's
    // create-object assigns `unit_field_displayid` too; either could resolve after a look has
    // dressed the body, and either would then draw an undressed race model over it. The handler
    // already declines to ASSIGN a display id to a dressed unit; this is the same rule for an
    // assignment that was already in flight.
    if (this.hasCharacterLook || this.displayToken !== token) {
      return;
    }

    if ((displayInfo as any).extraInfoID) {
      const look = await resolveNpcLook(displayInfo as any, modelData as any);
      if (this.displayToken !== token) {
        return;
      }
      // DELIBERATELY NOT `characterLookApplied`. That flag means "this body is a PLAYER's character
      // look and a display id must not stomp it"; here the display id IS the source, so setting it
      // would make the unit deaf to a server-side morph. `appliedDisplayId` is the dedupe instead, and
      // it is written through `onApplied` -- in the same tick as the model swap -- for the same reason
      // `setCharacterLook`'s pair is.
      const dressed =
        look !== null &&
        (await this.wearLook(look, ++this.characterLookToken, () => {
          this.appliedDisplayId = displayId;
        }));
      if (dressed) {
        return;
      }
      // Fell through on purpose: an unresolvable extra row draws the plain display-id body below,
      // which is what this unit would have drawn anyway.
    }

    const m2: M2 = await M2Blueprint.load(this.modelData.file);
    if (this.hasCharacterLook || this.displayToken !== token) {
      M2Blueprint.unload(m2);
      return;
    }
    this.model = m2;
    // THROUGH THE METHOD, so the creature's skin fetches can be waited for and their failures seen.
    // `this.model.displayInfo = ...` was a setter and could answer neither. Started HERE and awaited
    // at the bottom of this method: the scale, the matrix and the visibility below must not wait for
    // a texture -- a creature draws with its authored skin until its variation lands, exactly as
    // before.
    const textures = this.model.setDisplayInfo(this.displayInfo);
    // AFTER the setter, which writes `rotation.z` and bakes `matrix` itself: `M2` sets
    // `matrixAutoUpdate = false` on itself (`pipeline/m2/index.ts`), so `scale.setScalar` is INERT
    // without the `updateMatrix()` that follows it. That is `applyRenderScale`'s whole body and the
    // reason it is a method: the scale also has to be re-applied when the wire value arrives after
    // the model does, and a second copy of these two lines would have lost the `updateMatrix()` the
    // way every earlier round did.
    //
    // A PREVIOUS ROUND PUT `CreatureDisplayInfo.scale` HERE AND THAT WAS THE REGRESSION the owner is
    // looking at: it took Northshire's wolves to 0.40/0.55 when the server is telling us 1.0 for
    // every unit in the grid. See `objectScale` for the reference's law and for the measurement.
    this.applyRenderScale();
    // Not a plain `visible = true`: the first render of a model kind this session has to compile its
    // GLSL programs, MEASURED at 37.8 ms mean against 12.7 ms on a frame that compiles nothing, and
    // it is what the owner sees as a hitch when a group of unfamiliar mobs comes into view. This
    // issues the compile off the render frame and reveals the body when it is ready -- with a hard
    // deadline, so a creature is never left invisible. See `pipeline/program-warm.ts`.
    revealWhenWarm(this.model);
    this.appliedDisplayId = displayId;

    // The texture loads `setDisplayInfo` started, now that everything that must NOT wait for them has
    // happened. Awaited rather than dropped so this method's promise covers the whole of what it
    // started -- `set displayId` is its only caller and does not wait on it, so nothing downstream is
    // delayed by this. Each slot still fills itself in as it resolves; what is new is that a failure
    // can be named against the unit it disfigured instead of only against the file.
    const failures = failedTexturePaths(await textures);
    if (failures.length > 0) {
      console.warn(
        `unit: display ${displayId} (${this.modelData.file}) is drawn but ` +
          `${failures.length} of its texture files did not load: ${failures.join(', ')}`,
      );
    }
  }

  /**
   * Is this unit drawn from a CHARACTER look rather than from a `CreatureDisplayInfo` display id?
   *
   * Read by the update-object handler, which otherwise assigns `unit.displayId` on every create-object
   * it sees -- and for a player that field holds the RACE's display id (49 for a Human male), which
   * resolves to the same `.m2` but with every geoset visible, no composite and no equipment. So a
   * dressed character would be replaced by an undressed one the moment the server re-sent it.
   */
  get hasCharacterLook(): boolean {
    return this.characterLookApplied;
  }

  /**
   * Set ONLY once a look has actually been applied to a model -- never merely because one was asked
   * for.
   *
   * This is separate from `characterLookToken` and the separation is load-bearing. The first version
   * derived `hasCharacterLook` from `characterLookToken > 0`, and the token is bumped BEFORE the async
   * DBC resolve. So a character whose race the client's own DBCs do not describe -- the one case
   * `resolveCharacterLook` is written to report rather than throw on -- would leave the flag true with
   * no model, and `displayId`'s own arm would then decline for ever on the grounds that a look already
   * owned the body. The result would be an INVISIBLE unit, produced by the very branch that exists to
   * fall back gracefully. Found in self-review, not by a test.
   */
  private characterLookApplied = false;

  /** Which `setCharacterLook` call the in-flight load belongs to. Monotonic, like the glue scene's. */
  private characterLookToken = 0;
  /**
   * The item `.m2`s hanging off this unit's bones -- weapons, a shield, the shoulder pair, the helm.
   *
   * Tracked separately from the body even though they are its scene-graph descendants, for the same
   * reason `GlueSceneView` tracks its own: `M2Blueprint.unload` is a reference-counted release against
   * a path, and the graph cannot be walked for it. Without this list a redress would leak one reference
   * per item, for ever, per character.
   */
  private attachedItems: any[] = [];
  /**
   * The appearance+equipment key the currently-drawn look was built from, or null.
   *
   * A DEDUPE, and it is load-bearing rather than an optimisation. The server re-sends a create-object
   * for the same player whenever it re-enters our grid, and each one would otherwise cost a fresh `.m2`
   * clone, a fresh 512x512 bake and up to five item fetches -- measured at 6.9 ms of main thread for
   * the bake alone, per repeat, per player. `compositeCacheKey` is reused rather than a key of our own
   * because it already folds exactly the inputs a look depends on (race, gender, the five dials and
   * every worn display id), so a GEAR CHANGE still redresses and nothing else does.
   */
  private characterLookKey: string | null = null;

  /**
   * Draw this unit as an actual CHARACTER: its race and gender model, its geosets, its composited body
   * texture and its equipment, instead of a bare `CreatureDisplayInfo` display id.
   *
   * THIS IS THE WORLD END OF THE SEAM. Everything it does is `game/character/dress.ts`' -- the same
   * functions the character-select stage calls, in the same order -- and the only thing that is this
   * file's own is what a unit in the world disagrees with a glue stage about:
   *
   *  - the model goes through `this.model =`, so `Unit`'s own setter still runs: the 180-degree body
   *    yaw, the removal of the body's hull from the collision world (a unit that collides with itself
   *    collapses the camera boom into first person), the `model:change` emit the visibility manager and
   *    the world's dynamic-matrix pass listen for, and the initial `startAnimation`;
   *  - `updateMatrix()` is called AFTER that setter, because the setter writes `rotation.z` and calls
   *    `updateMatrix()` itself -- and `applyCharacterLook`'s scale write would otherwise be composed
   *    into a matrix that had already been baked. `model.scale.setScalar()` is inert under
   *    `matrixAutoUpdate = false`, which `M2` sets on itself, so the ORDER of these two calls is the
   *    whole of whether a gnome is gnome-sized;
   *  - no `armStand`: the setter above already armed `currentAnimationId`, and from the next frame the
   *    gait driver (`updateLocomotion`) owns the body. Arming a third time would say two things own one
   *    clock.
   *
   * Answers whether a look could be resolved at all. A null look is a DATA problem -- a race the
   * client's own DBCs do not describe -- which `resolveCharacterLook` has already named on the console;
   * the caller's fallback is the display-id path it would have taken anyway, which is why this reports
   * rather than throws.
   */
  async setCharacterLook(identity: CharacterIdentity): Promise<boolean> {
    const key = compositeCacheKey(
      identity.race,
      identity.gender,
      identity.appearance,
      identity.equipment,
    );
    if (key === this.characterLookKey) {
      return true; // already wearing exactly this; see `characterLookKey`
    }
    const token = ++this.characterLookToken;

    const look = await resolveCharacterLook(identity);
    if (!look) {
      // The key is NOT recorded on this path, so a later attempt for the same identity retries rather
      // than short-circuiting on a look that was never built.
      return false;
    }
    if (this.characterLookToken !== token) {
      return false;
    }

    // The unit's OWN collision height, which every swim depth line is a fraction of. Same two DBC rows
    // the `displayId` path reads it from, resolved once inside `resolveCharacterLook` rather than
    // fetched again here. Zero means the row carried nothing usable, in which case the client's own
    // empty-world default stands -- at zero every depth line collapses and the avatar swims on dry
    // land.
    if (look.collisionHeight > 0) {
      this.collisionHeight = look.collisionHeight;
      this.move.collisionHeight = this.collisionHeight;
    }

    // BOTH only when the look is on the model, and only together: it is then true that this unit is
    // drawn from one, and true that re-asking for the same key would be redundant.
    //
    // Through `onApplied` and NOT after the await, because the two are not the same instant. `wearLook`
    // returns a promise, so anything after `await` runs a microtask later -- and a `resolveDisplay`
    // already parked past its own awaits would see `hasCharacterLook` false in that gap and take the
    // body. The callback fires in the same tick as the model swap, which is where this write has
    // always been.
    return this.wearLook(look, token, () => {
      this.characterLookApplied = true;
      this.characterLookKey = key;
    });
  }

  /**
   * Put a resolved look on the body: load, swap the model, apply, attach. The whole of what a player
   * look and a humanoid-npc look have in common, which is everything except who is allowed to stomp it.
   *
   * SHARED RATHER THAN COPIED, and that is the point of the extraction: `setCharacterLook` and
   * `resolveDisplay`'s npc branch differ only in where the look came from and in which flags they set
   * afterwards. A second copy of these twenty lines would have drifted at the first bug fixed in one
   * of them -- the same argument `character/dress.ts` was created under.
   *
   * `token` is the caller's `characterLookToken` value; it is re-checked after every await and passed
   * into `attachCharacterItems`' `stillWanted`, so a look superseded mid-flight releases what it
   * loaded instead of hanging it on the next look's skeleton.
   *
   * `onApplied` runs SYNCHRONOUSLY between the model swap and the attachment loads -- see
   * `setCharacterLook` for why that instant and not "after the await" is the one that matters.
   */
  private async wearLook(
    look: CharacterLook,
    token: number,
    onApplied?: () => void,
  ): Promise<boolean> {
    const loaded = await loadCharacter(look);
    if (this.characterLookToken !== token) {
      M2Blueprint.unload(loaded.model);
      return false;
    }

    this.dropAttachedItems();

    // RELEASE the model we are replacing. `set model` only removes it from the view -- it does not
    // release the blueprint reference, because its other caller (the `displayId` path) has always
    // leaked one and fixing that there would change every unit's lifetime under a gate that cannot see
    // it. Here the leak is not theoretical and not one-off: the player is constructed with the
    // placeholder `displayId = 21976`, so every world entry replaces exactly one model, and a peer
    // redressed on a gear change replaces one more each time.
    const previous = this._model;

    this.model = loaded.model;
    // DELIBERATELY NOT AWAITED, and this is the one place in the pattern where that is the right
    // answer. `wearLook`'s result is awaited by `update-object/handler.ts`, which places a PEER's
    // body from the same packet immediately afterwards -- waiting here for a composite and a cloak
    // sheet would leave every other player standing at the origin until their textures landed.
    // `applyCharacterLook` already reports its own failures (see `character/dress.ts`), so nothing is
    // swallowed by letting it run on; and its promise cannot reject, so there is no unhandled
    // rejection to leave behind.
    void applyCharacterLook(loaded.model, look, loaded);
    // AFTER the setter and AFTER `applyCharacterLook`, because both write into `matrix` and the last
    // writer wins under `matrixAutoUpdate = false`. See the doc above.
    loaded.model.updateMatrix();
    // Same warm-then-reveal as the display-id path above, and for the same measured reason. This is
    // the arm that dresses PLAYERS and humanoid NPCs, whose character materials are the ones with the
    // most program variants in this client.
    revealWhenWarm(loaded.model);

    if (previous && previous !== loaded.model) {
      M2Blueprint.unload(previous);
    }

    onApplied?.();

    attachCharacterItems(
      loaded.model,
      look,
      () => this.characterLookToken === token && this._model === loaded.model,
      (item) => {
        this.attachedItems.push(item);
        // ANNOUNCED, not just remembered. An attached item model reaches the scene as a child of one
        // of this body's bones, long after `model:change` fired -- so the world's light + fog
        // registry has already walked the body without it, and a material with no fog uniforms
        // renders as a flat white silhouette. See `world/index.ts#adoptAttachedModel` for the
        // measurement. The glue stage needs no equivalent: `GlueSceneView#render` traverses its
        // whole scene each frame and reaches a bone child on the way.
        this.emit("model:attach", this, item);
      },
    );

    return true;
  }

  /**
   * Give up everything this unit loaded. Called by `World#remove` as the unit leaves the world.
   *
   * Removal used to free nothing at all, which cost nothing while nothing was ever removed. Units
   * now stream out and back in as the player walks (`update-object/handler.ts`, the `FarObjects`
   * block), so a release that only unparented the model would leak one `M2Blueprint` reference per
   * unit per stream-out -- and a blueprint holds the geometry, the skeleton and every texture.
   *
   * `M2Blueprint.unload` is a refcount decrement, so this is safe for a model path other units are
   * still drawing from: only the last holder tears anything down.
   */
  release(): void {
    this.dropAttachedItems();
    const model = this._model;
    if (model) {
      this._view.remove(model);
      this._model = null;
      M2Blueprint.unload(model);
    }
  }

  /** Release every attached item model, off its BONE and off the blueprint's reference count. */
  private dropAttachedItems(): void {
    for (const item of this.attachedItems) {
      // Before the unparent, so the listener can still walk the subtree it is releasing -- the
      // mirror of the `model:attach` emit in `wearLook`.
      this.emit("model:detach", this, item);
      item.parent?.remove(item);
      M2Blueprint.unload(item);
    }
    this.attachedItems = [];
  }

  get view() {
    return this._view;
  }

  get model() {
    return this._model!;
  }

  set model(m2: M2) {
    // TODO: Should this support multiple models? Mounts?
    if (this._model) {
      this.view.remove(this._model);
    }

    // TODO: Figure out whether this 180 degree rotation is correct
    m2.rotation.z = Math.PI;
    m2.updateMatrix();

    // A unit's own body is NOT world collision. `M2.createBoundingMesh` registers every model's
    // hull as a static doodad collider, which for a unit means the player collides with itself:
    // the camera boom swept from the head hits the avatar's own hull at zero distance and collapses
    // into first person looking at nothing, and the body's own casts fight its own volume.
    if (m2.boundingMesh) {
      collisionWorld.doodads.remove(m2.boundingMesh);
    }

    this.view.add(m2);

    /*
        penguin
        0 - fly 1
        1 - fly 2
        2 - jump
        3 - knockout
        4 - idle 1
        5 - idle 2
        6 - idle 3
        7 - run (slow)
        8 - die 1
        9 - die 2
        10 - dead
        11 - run
        12 - get hit
        13 - fly 3 (pretty)
        14 - fly 4 (pretty)
        15 - attack
        16 - idle 4
      */

    /*
     arthas
     0 - idle
     1 - run slow
     2 - run straight
     15 - jump
     16 - grounding
     31 - fall
     38 - rotate
     133 - backward
    */

    this.emit("model:change", this, this._model, m2);
    this._model = m2;

    // A new model would otherwise be posed with the OLD one's resolved sequence -- an object
    // belonging to a different sequence table. `locoMergeVersion` is reset alongside because
    // versions are per model: the new model's counter starts at 0 and could match the memo's.
    this.locoCandidates = null;
    this.locoSeq = null;
    this.locoMergeVersion = -1;

    // Arm the unit's standing sequence immediately. Deliberately NOT gated on
    // `m2.animated && m2.modelAnim.sequences.length > 0`: `instanceAnim` is null for exactly
    // `!animated`, and `resolve()` returns null for a sequence table with nothing playable in it
    // (empty, or every entry quarantined as external), so both halves of that
    // old gate are already inside `startAnimation`. Reconstructing it here would also have invited
    // the conflation Task 12 warned about -- the mixer's `m2.animations.length` was a CLIP count
    // (sequences plus global sequences), while `modelAnim.sequences` is the sequence table alone.
    //
    // Without this, a unit nobody sends an animation packet for -- every idle NPC, and the player
    // until the first key press -- would stand in bind pose for ever.
    this.startAnimation(this.currentAnimationId, -1);
  }

  /**
   * Request an animation by `AnimationData.dbc` id.
   *
   * WHO CALLS THIS: `updateLocomotion` below, once per unit per frame, on every gait CHANGE; the
   * peer handler at `network/entity/entity.ts:52`; and the model setter's one-time Stand. `jump()`
   * fires the one-shot, and still has no caller (Controls drives the player's jump through the
   * mover directly and never touches animation).
   *
   * The re-entry guard below is now LOAD-BEARING, not latent: `InstanceAnim` is clock-indexed off
   * `armedAtMs`, so a per-frame re-arm pins the cursor at zero and freezes the model on the first
   * keyframe of its run cycle -- an animation system that looks exactly like a broken one.
   * `updateLocomotion` gates on the resolved sequence changing for the same reason; the two guards
   * are belt and braces and neither is redundant, since the peer handler reaches this entry point
   * without passing through the other.
   *
   * `repetitions` is carried for the network caller's signature (`network/entity/entity.ts`) and is
   * not honoured yet: `InstanceAnim` holds one sequence and its loop flag, with no repeat count.
   */
  setAnimation(
    id: number,
    interrupt: boolean = false,
    repetitions: number = -1
  ) {
    // BEFORE the model check, so a request that beats the model home is not dropped. Spawn and
    // animation packets routinely arrive ahead of an async M2 load, and the model setter replays
    // `currentAnimationId` when the load lands -- so recording it here is what turns "arrived too
    // early" into "arrives late" instead of into silence. Returning without this left the unit on
    // Stand with nothing to say why.
    this.currentAnimationId = id;

    // NOTE: ownership is NOT latched here. It is latched in `startAnimation`, which is the only
    // place that knows what was actually armed. See `externalSeq`.

    if (!this.model) return;

    const inst = this.model.instanceAnim;
    const seq = this.model.modelAnim ? this.model.modelAnim.resolve(id) : null;

    if (!inst || !seq) {
      return;
    }

    if (inst.current === seq) {
      // A LOOP that is already running is never re-armed, `interrupt` or not -- see above. A
      // one-shot still inside its play window is left alone unless the caller says to interrupt it;
      // once the window has elapsed, the request restarts it.
      if (seq.loops) {
        return;
      }
      // `windowElapsedOrInstant`, not `windowElapsed`: a ZERO-LENGTH one-shot has no window that can
      // ever elapse, so the bare form swallowed every re-request for it after the first, for ever.
      // Same helper, same reason, as the ownership release in `updateLocomotion`.
      if (!interrupt && !windowElapsedOrInstant(inst, seq, worldClock.ms)) {
        return;
      }
    }

    this.startAnimation(id, repetitions);
  }

  /**
   * The unit died, or stopped being dead.
   *
   * DEATH IS A DESCRIPTOR STATE, NOT A PACKET. It arrives as `UNIT_FIELD_HEALTH` reaching zero with
   * a real max (`update-object/unit-fields.ts#isDead`, benilla `fields/unit.rs:73-75`), so this is
   * called from the values path and from nowhere else. There is no `SMSG_UNIT_DIED`.
   *
   * EDGE-TRIGGERED, and that is load-bearing: a corpse keeps sending values updates, and re-arming
   * `DEATH` on each of them would restart the fall from the top for as long as the body lay there.
   *
   * The arm is `setAnimation(DEATH, interrupt, 0)` -- a one-shot -- and `startAnimation`'s ownership
   * latch then holds the body for good, because `updateLocomotion`'s release explicitly never fires
   * for `DEATH` ("a corpse doesn't transition", `driver.rs:351`). That is what stops the corpse
   * standing back up when the clip's window elapses, and it already existed: this method is the
   * caller it never had.
   *
   * REVIVING clears the latch by hand. Nothing else can: the latch's own release refuses to drop a
   * `DEATH` owner, so leaving it would freeze a resurrected unit in its death pose for ever.
   */
  setDead(dead: boolean): void {
    if (dead === this.dead) {
      return;
    }
    this.dead = dead;
    // A CORPSE IS IN NO FIGHT, at either end. The server does send `SMSG_ATTACKSTOP` when its victim
    // dies (that is the `u32` dead flag the packet carries), but a death that arrives first would
    // otherwise leave a corpse marked as guarding -- and `engaged` is read on every locomotion frame,
    // including a revived unit's first.
    this.inCombat = false;
    this.combatTarget = null;
    this.attackedBy.clear();
    if (dead) {
      this.setAnimation(DEATH, true, 0);
      return;
    }
    this.externalSeq = null;
    // Nothing is armed in its place -- the next `updateLocomotion` frame picks a gait, which for a
    // unit standing still is Stand. Arming Stand here would be the same thing one frame earlier and
    // would take ownership of a loop, which is the permanent freeze `externalSeq` documents.
    this.locoCandidates = null;
  }

  /** Arm unconditionally. `setAnimation` is the guarded entry point; this is the raw one. */
  startAnimation(id: number, repetitions: number) {
    if (!this.model) return;

    const inst = this.model.instanceAnim;
    if (!inst) {
      return;
    }

    // Through `resolve`, never a raw index: a unit asked for an animation its model lacks should
    // fall back to Stand, not freeze in bind pose. See the KNOWN GAP in this task's report --
    // `resolve` follows the alias chain and then falls back to the first INLINE sequence, but does
    // NOT follow `nextAnimationID`, so an absent animation yields Stand rather than the authored
    // successor. It can also return null now: a model whose every sequence lives in a sibling
    // `.anim` file has nothing safe to play until Task 20 merges that data in.
    const seq = this.model.modelAnim.resolve(id);
    if (!seq) {
      return;
    }

    inst.arm(seq, worldClock.ms);
    this.currentAnimationId = id;

    // LATCH OWNERSHIP HERE, not at the request, and only when the arm LANDED ON THE REQUESTED
    // STATE. `resolve` falls back to the first inline sequence -- normally Stand, a LOOP -- for any
    // id the model does not own, and most models own few state ids. Latching on the request would
    // therefore hand ownership of a looping Stand to a state that never arrived, and a looping
    // owner never releases: the unit would stand still for the rest of the session. `seq.id === id`
    // is exactly the "did we get what we asked for" test, and it needs no caller knowledge --
    // locomotion's target is always a gait id, so it clears the latch rather than setting it.
    this.externalSeq = (!isGaitId(id) && seq.id === id) ? seq : null;

    this.emit("animation:play", id, repetitions);
  }

  /**
   * Give the body back to locomotion -- but ONLY if `animId` is still the state that owns it.
   *
   * THE ONE CASE THE LATCH CANNOT HANDLE ITSELF. `externalSeq`'s release is checked at the top of
   * `updateLocomotion` and, by design, "a LOOP never releases" -- which is what makes a looping emote or
   * a held cast pose hold. A looping owner therefore has no window that can elapse, so an owner armed for
   * something that may be CANCELLED needs an explicit way out or the unit stands in that pose for the
   * rest of the session.
   *
   * **THE `animId` GUARD IS THE WHOLE SAFETY OF THIS METHOD, and it is not belt-and-braces.** The first
   * version took no argument and released unconditionally, and self-review found two live ways to break a
   * unit with it:
   *
   *  - **A corpse would stand back up.** `setDead(true)` arms `DEATH` and re-latches `externalSeq` onto it,
   *    and that latch is the ONLY thing holding the body down -- `updateLocomotion`'s release explicitly
   *    never fires for `DEATH` ("a corpse doesn't transition", `driver.rs:351`). Dying mid-cast, or pressing
   *    a spell while dead, reached the unconditional release and dropped it.
   *  - **A live cast pose was dropped mid-cast.** Any second spell pressed during a 1.5 s cast is refused
   *    with `SMSG_CAST_FAILED`, and that refusal released the pose the FIRST cast was still holding --
   *    reintroducing the exact symptom this whole change exists to fix.
   *
   * Comparing the id makes the release an assertion about what is actually latched rather than a guess from
   * the caller's side, and the caller pairs it with its own identity check (see
   * `network/game/object/spells.ts#releaseCastPose`, which also requires the failing spell to be the one
   * whose pose is in flight -- two spells can share a pose clip, so the id alone is not sufficient).
   *
   * Nothing is armed in its place, for the same reason `setDead(false)` arms nothing: the next
   * `updateLocomotion` frame picks a gait, which for a unit standing still is Stand. Arming Stand here
   * would be that one frame earlier AND would take ownership of a loop -- the permanent freeze again.
   *
   * Returns whether it released, so a caller can tell "handed back" from "somebody else owns it now".
   */
  releaseAnimationLatch(animId: number): boolean {
    if (this.externalSeq === null || this.externalSeq.id !== animId) {
      return false;
    }
    this.externalSeq = null;
    this.locoCandidates = null;
    return true;
  }

  /** Whether an externally-armed state currently owns this unit's body, for a caller that must not stomp it. */
  get animationLatchId(): number | null {
    return this.externalSeq?.id ?? null;
  }

  stopAnimation(id?: number) {
    const animationId = id === undefined ? this.currentAnimationId : id;
    this.emit("animation:stop", animationId);
    // No disarm: `InstanceAnim` has no stopped state, and clearing `current` would drop the model
    // back to bind pose rather than holding its last frame. Callers that want a different pose ask
    // for one.
  }

  jump() {
    if (this.isOnGround && !this.isJump && !this.isFly) {
      this.isJump = true;
      this.jumpMoving.forward = this.moving.forward;
      this.jumpMoving.backward = this.moving.backward;
      this.jumpMoving.strafeLeft = this.moving.strafeLeft;
      this.jumpMoving.strafeRight = this.moving.strafeRight;
      this.jumpVelocity = this.jumpVelocityConst;
    }
  }

  ascend(delta: number) {
    if (this.isFly) {
      this.translatePosition({ z: this.flySpeed * delta });
    }
  }

  descend(delta: number) {
    if (this.isFly) {
      this.translatePosition({ z: -this.flySpeed * delta });
    }
  }

  moveForward(delta: number) {
    if (this.isJump) return;
    this.moving.forward = true;
    this.emit('moveForward');
    // this.translatePosition({ x: this.moveSpeed * delta });
  }

  moveBackward(delta: number) {
    if (this.isJump) return;
    this.moving.backward = true;
    this.emit('moveBackward');
    // this.setAnimation(133, false, 0);
    // this.translatePosition({ x: -this.moveSpeed * delta / 2 });
  }

  rotateLeft(delta: number) {
    this.moving.rotateLeft = true;
    // this.view.rotateZ(this.rotateSpeed * delta);
    // this.changeRotation();
  }

  rotateRight(delta: number) {
    this.moving.rotateRight = true;
  }

  strafeLeft(delta: number) {
    if (this.isJump) return;
    this.moving.strafeLeft = true;
    this.emit('strafeLeft');
    // this.translatePosition({ y: this.moveSpeed * delta });
  }

  strafeRight(delta: number) {
    if (this.isJump) return;
    this.moving.strafeRight = true;
    this.emit('strafeRight');
    // this.translatePosition({ y: -this.moveSpeed * delta });
  }

  strafeUp(delta: number) {
    if (!this.isJump) {
      this.translatePosition({ z: this.gravity * delta });
    }
  }

  strafeDown(delta: number) {
    this.translatePosition({ z: -this.gravity * delta });
  }

  translatePosition(vector: { x?: number; y?: number; z?: number }) {
    this.changePosition(vector, true);
  }

  beforePositionChange(_newCoords: THREE.Vector3) {
    this.prevPosition = this.position.clone();
    // this.updateGroundDistance(newCoords);
  }

  afterPositionChange() { }

  changeRotation() {
    this.emit("position:change", this.position, this.view.rotation);
  }

  tmpVector = new THREE.Vector3(
    this.position.x,
    this.position.y,
    this.position.z
  );
  changePosition(
    vector: { x?: number; y?: number; z?: number },
    translate: boolean = false
  ) {
    // Считаем то,как изменится позиция после проведения операции
    let newCoords: THREE.Vector3 = new THREE.Vector3();
    if (translate) {
      // eslint-disable-next-line no-param-reassign
      newCoords.set(
        vector.x ? vector.x + this.position.x : this.position.x,
        vector.y ? vector.y + this.position.y : this.position.y,
        vector.z ? vector.z + this.position.z : this.position.z
      );
    } else {
      newCoords.set(
        vector.x ? vector.x : this.position.x,
        vector.y ? vector.y : this.position.y,
        vector.z ? vector.z : this.position.z
      );
    }

    this.beforePositionChange(newCoords);

    if (vector) {
      if (translate) {
        if (vector.x && newCoords.x !== this.position.x)
          this.tmpVector.setX(vector.x); //this.view.translateX(vector.x);
        if (vector.y && newCoords.y !== this.position.y)
          this.tmpVector.setY(vector.y); //this.view.translateY(vector.y);
        if (vector.z && newCoords.z !== this.position.z)
          this.tmpVector.setZ(vector.z); //this.view.translateZ(vector.z);
      } else {
        const builtVector = {
          x: vector.x ? vector.x : this.position.x,
          y: vector.y ? vector.y : this.position.y,
          z: vector.z ? vector.z : this.position.z
        };
        this.position.set(builtVector.x, builtVector.y, builtVector.z);
      }
    }

    // The mover owns position: `syncViewFromMove()` copies `move.pos` onto the view every frame.
    // So anything that sets the view directly -- worldport, a spawn, a debug jump -- has to tell
    // the mover too, or the next frame silently drags the unit back to wherever the mover thought
    // it was. That is what made worldport look like it did nothing.
    this.move.pos.copy(this.position);

    this.afterPositionChange();
  }

  /**
   * Relocate the unit outright: mover, view, and the velocities that would otherwise carry over.
   *
   * `settling` freezes the body with gravity off until the destination's collision has streamed in.
   * Without it the avatar falls through a city that has not loaded yet -- the ground under a
   * teleport simply is not there for the first few frames.
   */
  teleportTo(x: number, y: number, z: number) {
    this.move.pos.set(x, y, z);
    this.move.velZ = 0;
    this.move.horizVel.set(0, 0, 0);
    this.move.airborneSince = null;
    this.move.fallFar = false;
    this.move.wedged = false;
    this.move.settling = true;
    this.move.settleDeadline = performance.now() / 1000 + SETTLE_TIMEOUT;

    this.view.position.set(x, y, z);

    // Drop the displacement baseline. `TELEPORT_SPEED` only catches a relocation big enough to
    // exceed it -- a short hop (a worldport within a zone, a spawn correction, a step out of a
    // vehicle) lands under it and would be measured as a perfectly plausible gait for exactly one
    // frame. Here we KNOW it was not locomotion, so say so rather than inferring it from magnitude.
    this.locoTracking = false;

    this.emit("position:change", this.position, this.view.rotation);
  }

  updateGroundDistance() {
    this.previousGroundDistance = this.groundDistance;
    this.groundDistance = 0;
    const newZ = this.position.z + this._groundFollowConstant;
    this.groundDistanceRaycaster.set(
      new THREE.Vector3(this.position.x, this.position.y, newZ),
      new THREE.Vector3(0, 0, -1)
    );
    // this.arrow.setDirection(this.groundDistanceRaycaster.ray.direction);
    const meshList: THREE.Object3D[] = Array.from(ColliderManager.collidableMeshList.values())
    // intersect with all scene meshes.
    const intersects = this.groundDistanceRaycaster.intersectObjects(meshList);
    if (intersects.length > 0) {
      this.groundDistance = intersects[0].distance;
      this.slopeAng =
        (new THREE.Vector3(0, 1, 0).angleTo(intersects[0].face!.normal) * 180) /
        Math.PI;
      this.slopeType =
        this.slopeAng < this.slopeLimit
          ? SlopeType.sliding
          : SlopeType.climbing;
    }
  }

  // -- Locomotion ---------------------------------------------------------------------------------
  //
  // REPLACES `updateMoving`, deleted here. It had no caller anywhere in the client and could not
  // safely acquire one: it INTEGRATED position (`translatePosition` per held key) alongside choosing
  // an animation, and position is now owned by the kinematic mover -- calling it would have dragged
  // the avatar off `move.pos` every frame. Its animation half also used the wrong ids (see the
  // `Animation` enum's note). Two pieces of its intent are worth keeping and are NOT ported here:
  // a distinct backpedal clip (reference: WalkBackwards, id 13) and a turn-in-place shuffle
  // (reference: 11/12, not the `38` it used). Both need a movement-direction signal this client
  // does not surface yet. See the report's follow-ups.

  /** Last frame's horizontal position, for the measured-displacement leg. Plain numbers: no alloc. */
  private locoPrevX = 0;
  private locoPrevY = 0;
  private locoTracking = false;

  /**
   * The externally-armed STATE sequence that owns this unit's body; the gait pick must stand off.
   *
   * A SEQUENCE, not a boolean. Holding the object is what lets the release check ask "is my owner
   * still the thing that is playing?" -- so anything re-arming underneath the latch (the wire, a
   * replay from the `model` setter, a future SMSG state) drops it automatically, with no bookkeeping
   * at the other end.
   *
   * Latched in `startAnimation` and ONLY when the arm landed on the requested state
   * (`!isGaitId(id) && seq.id === id`). Both halves matter:
   * - `seq.id === id` -- `resolve` falls back to the first inline sequence, normally Stand, for any
   *   id the model does not own, and most models own few state ids. Latching on the REQUEST would
   *   hand ownership of a looping Stand to a state that never arrived, and a looping owner never
   *   releases: the unit would stand for the rest of the session.
   * - `!isGaitId(id)` -- Stand is a loop, so a wire-sent Stand would latch the same permanent
   *   freeze. A gait request is a gait request whoever sends it. This is also what releases
   *   locomotion's own arm, since its target is by construction a gait id.
   *
   * This is the thin version of the reference's `Special` / `Mode` states, which likewise outrank
   * the gait (`select.rs:280+`). Without it, ANYTHING armed from outside is stomped by the next
   * frame's gait pick: the wire handler at `network/entity/entity.ts`, `jump()`, and every future
   * SMSG animation. Death is the case that makes it non-negotiable -- Death is a ONE-SHOT, so it
   * would play through, its window would elapse, and the corpse would stand up.
   *
   * Release, checked at the top of `updateLocomotion`:
   * - something else is armed now -> release, the latch is stale;
   * - a LOOP -> never releases. A looping emote holds until something else is requested, which is
   *   what "sit until told otherwise" means.
   * - `DEATH` -> never releases, one-shot or not. `driver.rs:351`: "Death overrides every state
   *   (a corpse doesn't transition)."
   * - any other one-shot -> holds for its window, then releases. An attack swing or a jump gives
   *   the body back when it finishes. A NON-POSITIVE length counts as already elapsed:
   *   `InstanceAnim#windowElapsed` returns false for `periodMs <= 0`, so a zero-length state would
   *   otherwise never release -- the same permanent freeze by a different route.
   */
  private externalSeq: Sequence | null = null;

  /**
   * Memo for the candidate walk: the list picked last frame and what it resolved to.
   *
   * `resolve` is a linear scan of the sequence table per candidate, and the gait bucket is the same
   * on the overwhelming majority of frames -- a unit runs for seconds at a time. The lists are
   * module constants, so the hit test is one reference comparison.
   *
   * A MISS is memoised too, as `locoCandidates` set with `locoSeq` null: a model with nothing
   * playable at all would otherwise pay the full scan every frame for ever, which is precisely the
   * model that can least afford it.
   *
   * TWO things invalidate it, and `set model` is only one of them. The other is an external `.anim`
   * MERGE, which is the whole point of `mergeExternal`: `resolve` returns different answers before
   * and after one. A creature whose Run is external and Stand inline self-heals at the next gait
   * change, but a creature with NO inline sequence memoises `locoSeq = null` on its first Stand
   * frame and, being stationary, never re-resolves -- standing in bind pose for ever with correct
   * merged keys in the table beside it. That is the same bug `InstanceAnim#armable` already killed
   * by storing a VERSION instead of a boolean, and the same signal closes it here.
   */
  private locoCandidates: readonly number[] | null = null;
  private locoTarget: number = STAND;
  private locoSeq: Sequence | null = null;
  /** `modelAnim.mergeVersion` the memo above was resolved at. -1 matches no real version. */
  private locoMergeVersion = -1;

  /**
   * The previous frame's movement flags, for the jump bracket's two EDGES.
   *
   * Stored even on the frames locomotion bails early (no model yet, no instance): a unit whose model
   * streams in while it is already airborne must not then play a JumpStart for a take-off that
   * happened before we could draw it.
   */
  private locoPrevFlags = 0;

  /**
   * The landing clip this unit is playing, and the movement flags it was PICKED from.
   *
   * The reference's `Mode::Land { id, flags }` (`select.rs:388-397`): a landing is not a bracket and
   * must not own the body -- it is a gait-level pick that survives only while the input that chose it
   * holds. Cleared by a flag change, by the clip's window elapsing, and by leaving the ground again.
   */
  private locoLand: { id: number; flags: number } | null = null;

  /**
   * Did this airborne phase LAUNCH (a jump), or is the unit merely falling off something?
   *
   * `FALLING` is set for both, so nothing in the flag word answers this -- and the reference needs the
   * answer twice: only a launched arc plays JumpStart 37 (`select.rs:288-292`), and the two
   * `FALLINGFAR` legs are exclusive on the same value (`constants.ts#FALL_FAR_DROP`).
   *
   * Each leg reads the launch snapshot its own motion source keeps: the mover's `jumpZSpeed`
   * (`JUMP_SPEED` for a jump, EXACTLY 0 for a step-off) for us, and the wire's jump tail for a peer
   * (`RemoteMotion#jumped`, seeded from a negative `zspeed`). A spline creature never jumps.
   */
  airborneFromJump(): boolean {
    if (this.isPlayer) {
      return this.move.jumpZSpeed !== 0;
    }
    return this.remoteMotion !== null && this.remoteMotion.jumped;
  }

  /**
   * This frame's horizontal ground speed (yd/s) -- the gait threshold's only input.
   *
   * TWO LEGS, mirroring the reference's `select::unify` (`select.rs:931-965`):
   *
   * - The PLAYER is driven from Controls, which runs `movementFrame` and leaves the applied
   *   horizontal velocity on `move.horizVel`. That is an INTENDED velocity, not a displacement,
   *   which is deliberate and matches `benilla/src/player.rs:1209-1213`: running into a wall keeps
   *   the run cycle playing, which is the WoW look. Swimming substitutes the stroke speed, same as
   *   the reference's `if swimming { swim_stroke_speed }` -- `swim.ts:256-258` does leave a real
   *   `horizVel` behind, but it is only the horizontal component of a 3D stroke and understates the
   *   gait whenever the swimmer is pitched.
   *
   * - Server creatures are moved by writing `view.position` outright (`updateSplineFollowing`,
   *   integrated here every frame) and maintain no velocity, so their speed is MEASURED. This is
   *   the reference's creature leg, whose `Spline::speed()` is likewise a length over a duration.
   *   Wire-driven peers are excluded from locomotion entirely before this is ever called -- see
   *   `wireDriven` for why their displacement is not a measurement at all.
   */
  locomotionSpeed(delta: number): number {
    const x = this.view.position.x;
    const y = this.view.position.y;
    const dx = x - this.locoPrevX;
    const dy = y - this.locoPrevY;
    const first = !this.locoTracking;

    this.locoTracking = true;
    this.locoPrevX = x;
    this.locoPrevY = y;

    if (this.isPlayer) {
      return this.move.swimming ? this.move.swimStrokeSpeed : this.move.horizVel.length();
    }

    // A PEER's speed is not measured either: it is the speed his own flags picked, which is what the
    // dead-reckon is applying to him this frame (`net-motion.ts#advanceRemote` writes it). This is
    // the reference's remote leg of `unify` -- `RemoteMotion::speed`, read by the selector exactly
    // as a spline's speed is read for a creature (`select.rs:1069-1103`).
    //
    // Measuring a peer's displacement instead is what made the gait flicker at packet cadence, and
    // it would still be wrong now that the motion is continuous: a peer held against a wall by his
    // own client keeps reporting FORWARD with an unchanged position, and his run cycle should keep
    // playing, exactly as it does for the player (`move.horizVel` is the INTENDED velocity above).
    if (this.remoteMotion) {
      return this.remoteMotion.speed;
    }

    // The FIRST measured frame has no previous position to difference against -- the unit spawned
    // wherever it spawned, and `0 -> spawn point` is a teleport-sized delta.
    if (first || delta <= 0) {
      return 0;
    }

    const speed = Math.sqrt(dx * dx + dy * dy) / delta;
    return speed > TELEPORT_SPEED ? 0 : speed;
  }

  /**
   * This unit's live movement flags -- the reference's `select::unify` (`select.rs:1069-1103`), whose
   * precedence is self > remote > spline > stationary.
   *
   * Each leg is a different KIND of knowledge and they are not interchangeable:
   *
   *  - the PLAYER's flags are the ones the mover computed and the wire carries this frame
   *    (`movement/outbound.ts#movementFlagsFor` stores them on `state.moveFlags`);
   *  - a PEER's are his own, relayed verbatim -- the direction he last reported pressing;
   *  - a SPLINE creature has none, ever. The server sends it a path, not a keypress. The reference
   *    SYNTHESISES `FORWARD` for exactly this leg (`select.rs:958-962`) so the cascade's flag tests
   *    have something true to read, and the speed tail then does the real work. Note this correctly
   *    denies a walking creature the backpedal and shuffle branches, which it can never be in.
   */
  locomotionFlags(): number {
    if (this.isPlayer) {
      return this.move.moveFlags;
    }
    if (this.remoteMotion) {
      return this.remoteMotion.flags;
    }
    if (this.splineRide) {
      return MoveFlag.FORWARD;
    }
    return 0;
  }

  /**
   * The gait candidate list. A port of the reference's `gait_candidates`
   * (`select.rs:426-537`), in its order, which is the order of the client's own `0x5fd100` chain.
   *
   * The order is the content. Swimming outranks everything, because a swimmer pressing forward is
   * swimming and not running; the backpedal outranks strafe, because there IS no ground strafe gait
   * (the reference expresses strafing as a body-yaw offset instead, `select.rs:228-243` -- not
   * ported, and named in the report); and the turn-in-place shuffle is reachable only when nothing
   * is translating, which is why it sits BELOW the speed tail rather than beside it.
   *
   * The airborne branch is the reference's `Special` (`select.rs:885-899`) folded in at the top of
   * the ground half: `FALLING_FAR` is a real fall, a plain `FALLING` is the jump hang. The bracket's
   * ENTRY and EXIT one-shots are not here -- they are edges, not states, and `updateLocomotion`
   * arms them through the ownership latch.
   *
   * See `GAIT_*` for why this returns a list rather than an id, and why the lists are frozen.
   */
  gaitCandidates(flags: number, speed: number, ready: number = 0): readonly number[] {
    if ((flags & MoveFlag.SWIMMING) !== 0) {
      if ((flags & (MoveFlag.TURN_LEFT | MoveFlag.TURN_RIGHT)) !== 0) return GAIT_SWIM_IDLE;
      if ((flags & MoveFlag.STRAFE_LEFT) !== 0) return GAIT_SWIM_LEFT;
      if ((flags & MoveFlag.STRAFE_RIGHT) !== 0) return GAIT_SWIM_RIGHT;
      if ((flags & MoveFlag.BACKWARD) !== 0) return GAIT_SWIM_BACK;
      if ((flags & MoveFlag.FORWARD) !== 0) return GAIT_SWIM;
      return GAIT_SWIM_IDLE;
    }

    if ((flags & MoveFlag.FALLING) !== 0) {
      return (flags & MoveFlag.FALLING_FAR) !== 0 ? GAIT_FALL : GAIT_JUMP_HANG;
    }

    if ((flags & MoveFlag.BACKWARD) !== 0) {
      return GAIT_BACKWARD;
    }

    if ((flags & ANY_MOVE) !== 0 || speed > MOVING_EPSILON) {
      if (speed >= FAST_RUN_SPEED) return GAIT_SPRINT;
      // STRICTLY above twice the walk speed, so 5.0 yd/s still walks and 5.1 runs. That boundary is
      // the reference's, pinned by its own test (`select/tests.rs:47`).
      return speed > 2 * this.speeds.walk ? GAIT_RUN : GAIT_WALK;
    }

    if ((flags & MoveFlag.TURN_LEFT) !== 0) return GAIT_SHUFFLE_LEFT;
    if ((flags & MoveFlag.TURN_RIGHT) !== 0) return GAIT_SHUFFLE_RIGHT;

    // STANDING AND ENGAGED: the weapon-class Ready guard instead of Stand (`select.rs:497-506`).
    //
    // BELOW the turn-in-place shuffles and ABOVE Stand, which is the reference's order exactly -- a
    // fighter who pivots still shuffles his feet -- and reachable only here, so "not moving" needs no
    // test of its own: every translating branch has already returned.
    //
    // This is the owner's report "после каждого удара он проигрывает анимацию как будто он стоит вне
    // боя". The swing is a one-shot; when its window elapsed the cascade had nothing between it and
    // Stand, so every strike ended in the relaxed idle.
    //
    // AND IT IS A PEER'S REPORT, which is what decides where engagement comes from -- and the answer
    // is that it was already there. `Unit#inCombat` is set by `SMSG_ATTACKSTART` and cleared by
    // `SMSG_ATTACKSTOP` (`network/game/object/combat.ts:247,259`), which the server relays for every
    // unit we can see, keyed by the attacker's guid, so it is true of another player exactly as it is
    // of us. Those are the same two opcodes the reference derives `Engaged` from
    // (`net/apply/combat.rs:26,40`; `creature_anim.rs:113-117`: "the client's `0x5fd360` arm gates on
    // the auto-attack-target GUID being set, i.e. engagement, **not** sheath state"). No unit FIELD and
    // no new bit was needed -- `inCombat` has had a writer since the combat round and NOTHING READ IT.
    // The weapon bucket comes from `equippedMainhand`, which the values path already fills from
    // `PLAYER_VISIBLE_ITEM_16_ENTRYID` for a player.
    if (ready === 26) return GAIT_READY_1H;
    if (ready === 27) return GAIT_READY_2H;
    if (ready === 28) return GAIT_READY_2HL;
    if (ready !== 0) return GAIT_READY_UNARMED;

    return GAIT_STAND;
  }

  /**
   * The playback rate for a chosen gait -- the reference's `scaled_rate` (`select.rs:1053-1056`).
   *
   * This is what stops the feet skating. A walk cycle is AUTHORED for a particular ground speed
   * (`Sequence.moveSpeed`), so playing it at 1x while the body moves at some other speed slides the
   * contact point along the ground; dividing the two makes the cycle keep up.
   *
   * Two guards, both load-bearing and both the reference's:
   *
   *  - `moveSpeed > 0` STRICTLY, never `Math.abs`. A backwards gait is authored NEGATIVE, and the
   *    reference documents this with a real model (`RidingKodo.m2` WalkBackwards, `-2.5`). So an
   *    authored backpedal plays at a flat 1x, while a model that has no backpedal and falls back to
   *    forward Walk (`+2.5`) IS scaled -- which is the behaviour that looks right in both cases.
   *  - the `RATE_SCALED` whitelist. Rate is a property of the ID, not of the clip: Stand, Fall and
   *    every emote play at 1x however fast the body is moving.
   *
   * NOT ported: the reference multiplies the divisor by the rendered model scale, so a bigger
   * creature cycles its legs slower for the same ground speed (decision 0903, `driver.rs:475-478`).
   * Creature scaling is another change's ground this round and a wrong scale here would be a wrong
   * rate on every creature, so this uses 1 and says so.
   */
  locomotionRate(seq: Sequence, speed: number): number {
    if (!RATE_SCALED.has(seq.id) || !(seq.moveSpeed > 0)) {
      return 1;
    }
    return speed / seq.moveSpeed;
  }

  /**
   * Pick this frame's gait and arm it -- once per unit per frame, from `World#animateEntities`.
   *
   * THE GUARD, and the whole reason this is not just `setAnimation(gait)` every frame: `InstanceAnim`
   * is clock-indexed off `armedAtMs`, so re-arming a running loop pins its cursor at zero and the
   * creature holds the first keyframe of its run cycle for ever.
   *
   * The gate is `seq.loops && inst.current === seq`, and the `loops` half is load-bearing. A gate on
   * sequence identity ALONE would go behind `setAnimation`'s back for a NON-looping gait:
   * `setAnimation` deliberately restarts a one-shot once its window has elapsed, and swallowing that
   * would leave the clip frozen on its clamped end pose for as long as the unit kept moving. That is
   * reachable, not theoretical -- real wolf sequences carry `0x21` / `0x23` / `0x61`, all of which
   * set bit 0, and `sequenceLoops` is itself still unverified for 3.3.5 (`model-anim.ts:57-58`). For
   * a LOOP the gate and `setAnimation`'s own `if (seq.loops) return;` agree, and this one runs first
   * only to skip the redundant `resolve`. Shape follows the reference (`driver.rs:1017`,
   * `if drv.gait == Some(target)` -> re-sync only, no re-arm).
   */
  updateLocomotion(delta: number) {
    // Wire-driven peers never reach the measurement: their displacement is an artefact of message
    // cadence, not of movement. See `wireDriven`.
    if (this.wireDriven) {
      return;
    }

    const speed = this.locomotionSpeed(delta);
    const flags = this.locomotionFlags();

    const model = this.model;
    if (!model) {
      // Still record the flags: the jump bracket below keys on the EDGE, and a model that streamed
      // in mid-air must not then play a JumpStart it never took off for.
      this.locoPrevFlags = flags;
      return;
    }

    const inst = model.instanceAnim;
    const modelAnim = model.modelAnim;
    if (!inst || !modelAnim) {
      this.locoPrevFlags = flags;
      return;
    }

    // THE JUMP BRACKET. The reference plays JumpStart 37 -> the Jump 38 hang loop -> JumpEnd 39 /
    // JumpLandRun 187 (`select.rs:307`, `:318`, `:365-376`), and its two ends are NOT the same kind
    // of thing -- which is what this round corrected.
    //
    // THE ENTRY is a non-preemptible one-shot: `Mode::Entering(Jump)` settles into the hang loop when
    // 37's own 833 ms window elapses, and nothing overrides it (`select.rs:283-287`). The ownership
    // latch is exactly that, so it stays.
    //
    // ONLY A LAUNCHED ARC ENTERS IT. "A step-off fall never enters here -- its gait freezes until
    // FALLINGFAR latches" (`select.rs:288-292`). Both arrive carrying `FALLING`, so the flags alone
    // cannot tell them apart and this used to play JumpStart for every kerb the avatar walked off.
    // `airborneFromJump` is the launch test, and it reads the mover's own take-off snapshot for us
    // and the wire's jump tail for a peer.
    //
    // THE LANDING IS NOT A BRACKET -- and treating it as one is the defect behind "his own jump is
    // wrong". The reference's `Mode::Land` is "a plain, FREELY-OVERWRITTEN pick ... re-picks the
    // instant any movement flag changes, so land-then-press runs immediately, land-then-release
    // stands immediately" (`select.rs:388-397`). Armed through the ownership latch instead, JumpEnd
    // held the body for its full authored second: land, press forward, and the avatar stood rooted in
    // the landing crouch for a second before the run started. So the landing clip now lives in
    // `locoLand` -- a gait-level pick this cascade consults and drops the moment the flags move.
    const wasAirborne = (this.locoPrevFlags & MoveFlag.FALLING) !== 0;
    const airborne = (flags & MoveFlag.FALLING) !== 0;
    const swimming = (flags & MoveFlag.SWIMMING) !== 0;
    this.locoPrevFlags = flags;
    if (airborne) {
      // Any airborne frame invalidates a landing pick: the body is off the ground again.
      this.locoLand = null;
      if (!wasAirborne && !swimming && this.airborneFromJump()) {
        this.setAnimation(JUMP_START, true, 0);
      }
    } else if (wasAirborne && !swimming) {
      // `jump_land_pick` (`select.rs:365-376`) verbatim: no clip while swimming, JumpEnd when the
      // touchdown is stationary, JumpLandRun when it is still running forward, and NOTHING for a
      // backpedal or a walk -- those drop straight into their gait, because 187 is a forward-run
      // footplant and playing it backward is the "forward run flash after jump-then-hold-S" bug.
      if ((flags & ANY_MOVE) === 0) {
        this.locoLand = { id: JUMP_END, flags };
      } else if ((flags & (MoveFlag.BACKWARD | MoveFlag.WALK_MODE)) === 0) {
        this.locoLand = { id: JUMP_LAND_RUN, flags };
      } else {
        this.locoLand = null;
      }
      // TRUTHY, not `!== null`: every locomotion unit test drives this method with `.call()` on a
      // hand-built double, where an unset field is `undefined` rather than `null`. Same degradation
      // `InstanceAnim#armable` documents for the same reason.
    } else if (this.locoLand && this.locoLand.flags !== flags) {
      // The input moved. Re-pick means, for every case a landing clip can reach, "stop playing it":
      // the pick is made from the flags AT TOUCHDOWN, and any change is the player asking for the
      // gait instead.
      this.locoLand = null;
    }

    // An externally-armed STATE owns the body until it gives it back. See `externalSeq` for the
    // release rules, and for why Death and a zero-length clip each need a case of their own.
    const owner = this.externalSeq;
    if (owner !== null) {
      if (inst.current !== owner) {
        // Something re-armed underneath the latch. Whatever is playing now is not ours to hold.
        this.externalSeq = null;
      } else if (owner.loops || owner.id === DEATH) {
        return;
      } else if (!windowElapsedOrInstant(inst, owner, worldClock.ms)) {
        return;
      } else {
        this.externalSeq = null;
      }
    }

    // THE LANDING PICK, ahead of the cascade and below the ownership latch: it outranks the gait
    // while it lasts, and it lasts until the flags move (above) or the clip finishes (here). Nothing
    // else may hold it -- `windowElapsedOrInstant` is the same helper the latch's own release uses, so
    // a zero-length landing clip is treated as already finished rather than as a permanent freeze.
    if (this.locoLand) {
      const landSeq = modelAnim.resolve(this.locoLand.id, false);
      if (landSeq === null) {
        // The model has no landing clip. Nothing to play; the gait takes the frame.
        this.locoLand = null;
      } else if (inst.current === landSeq
        && windowElapsedOrInstant(inst, landSeq, worldClock.ms)) {
        this.locoLand = null;
      } else {
        this.setAnimation(this.locoLand.id);
        // The memo is invalidated: the next gait frame must re-resolve rather than believe the
        // candidate list it had before the landing interrupted it.
        this.locoCandidates = null;
        return;
      }
    }

    // ENGAGEMENT for the Ready rung -- `engaged`, which is "swinging OR being swung at" and not
    // `inCombat` alone. A GETTER, deliberately, and safe for the same reason the inline read was: every
    // locomotion unit test drives this with `.call()` on a hand-built double, and a getter that is not
    // on the double reads `undefined`, which is exactly "not engaged". A METHOD would have been a
    // `TypeError` there; that is the distinction, and it is why this is a property and not `isEngaged()`.
    //
    // The one-sided version of this test is the owner's report: `inCombat` is written from
    // `SMSG_ATTACKSTART` keyed by the ATTACKER, so a player being mauled who had not swung was never
    // marked and stood in the relaxed idle for the whole fight. See `Unit#attackedBy` for the capture.
    const ready = this.engaged ? readyAnimation(this) : 0;
    const candidates = this.gaitCandidates(flags, speed, ready);

    // Step down the list, taking the first rung the model actually OWNS -- `resolve(id, false)`
    // withholds the Stand consolation precisely so "absent" is distinguishable from "present".
    //
    // Re-resolved on a MERGE as well as on a gait change: see `locoCandidates`. A version compare,
    // not a listener -- one integer per unit per frame, and nothing to forget to unsubscribe.
    const mergeVersion = modelAnim.mergeVersion;
    if (candidates !== this.locoCandidates || mergeVersion !== this.locoMergeVersion) {
      let target = candidates[candidates.length - 1];
      let seq: Sequence | null = null;
      for (let i = 0; i < candidates.length; ++i) {
        const candidate = candidates[i];
        const resolved = modelAnim.resolve(candidate, false);
        if (resolved !== null) {
          target = candidate;
          seq = resolved;
          break;
        }
      }

      if (seq === null) {
        // Nothing on the list is owned. Take whatever `resolve` falls back to for the last rung --
        // the first inline sequence -- rather than freezing in bind pose. Null only for a model with
        // nothing playable at all (empty table, or every sequence quarantined as external).
        seq = modelAnim.resolve(target);
      }

      // Stored whether or not it resolved: a MISS is memoised too, so a model with nothing playable
      // stops paying for the scan. `set model` is what re-opens the question.
      this.locoCandidates = candidates;
      this.locoTarget = target;
      this.locoSeq = seq;
      this.locoMergeVersion = mergeVersion;
    }

    if (this.locoSeq === null) {
      return;
    }

    // The rate is re-synced EVERY frame, including the frame the gait does not change -- a unit
    // accelerating out of a walk changes speed continuously and its cycle has to follow. That is the
    // reference's `sync_base_rate`, which likewise runs over whatever the base slot holds rather
    // than only over a fresh arm (`play.rs:206-231`, called from `driver.rs:1098`). `setRate`
    // re-anchors the clock so this does not jump the pose; see its docs.
    const rate = this.locomotionRate(this.locoSeq, speed);

    if (this.locoSeq.loops && inst.current === this.locoSeq) {
      inst.setRate(rate, worldClock.ms);
      return;
    }

    // `startAnimation` clears the ownership latch for us: the target is always a gait id.
    this.setAnimation(this.locoTarget);
    if (inst.current === this.locoSeq) {
      inst.setRate(rate, worldClock.ms);
    }
  }

  clear() {
    this.moving.forward = false;
    this.moving.backward = false;
    this.moving.strafeLeft = false;
    this.moving.strafeRight = false;
    this.moving.rotateRight = false;
    this.moving.rotateLeft = false;

    if (!this.isJump) {
      this.jumpMoving.forward = false;
      this.jumpMoving.backward = false;
      this.jumpMoving.strafeLeft = false;
      this.jumpMoving.strafeRight = false;
    }
  }

  /**
   * Push the mover's state onto the scene graph.
   *
   * `move.pos` is the authority on position; `move.modelYaw` is the RENDERED body heading, which is
   * deliberately not `move.faceYaw` -- the two diverge while strafing, and the aim is what the wire
   * will carry.
   */
  syncViewFromMove() {
    this.view.position.copy(this.move.pos);
    this.view.rotation.z = this.move.modelYaw;
    this.emit("position:change", this.position, this.view.rotation);
  }

  update(delta: number, viewerPos?: THREE.Vector3) {
    // The player's frame is driven from Controls, which owns the input and the camera heading and
    // calls `movementFrame` + `syncViewFromMove` itself. Only non-player units integrate here.
    if (this.isPlayer) {
      return;
    }

    // The two network motion legs, mutually exclusive by construction (`setSplinePath` and
    // `applyRemoteState` each clear the other), so at most one writes `view.position` per frame.
    this.updateSplineFollowing(delta);
    this.updateRemoteMotion(delta, viewerPos);
    // AFTER both motion legs, which is what makes the packet a CORRECTION rather than a competitor:
    // whatever a spline's `facing` or a remote state's orientation just wrote is this frame's starting
    // heading, and the ease then carries it on toward the victim. See `updateCombatFacing`.
    this.updateCombatFacing(delta);
    // this.updatePlayer(delta);
    this.clear();
    // const m = ObjectsManager;

    // for (const obj of m) {
    //   var direction = new THREE.Vector3(); // create a new vector
    //   direction.subVectors(obj.position, this.position); // set the direction to point at the object
    //   this.raycaster.set(this.position, direction.normalize());
    //   this.raycaster.firstHitOnly = true;
    //   var intersects = this.raycaster.intersectObject(obj);
    //   if (intersects) {
    //     obj.visible = true
    //   } else {
    //     obj.visible = false
    //   }
    //   console.log(intersects);
    // }
  }

  velocity = new THREE.Vector3();
  capsuleInfo = {
		radius: 0.5,
		segment: new THREE.Line3( new THREE.Vector3(), new THREE.Vector3( 0, - 1.0, 0.0 ) )
	};
  tempBox = new THREE.Box3();
  tempMat = new THREE.Matrix4();
  tempSegment = new THREE.Line3();
  tempVector2 = new THREE.Vector3();
  tempVector = new THREE.Vector3();
  upVector = new THREE.Vector3( 0, 1, 0 );
  theta: number;
  phi: number;
  camera: THREE.PerspectiveCamera;

  updatePlayer( delta ) {
    if (!ColliderManager.collidableMesh.geometry.boundsTree) return;
    
    this.velocity.z += this.isOnGround ? 0 : delta * this.gravity;
    this.position.addScaledVector( this.velocity, delta );
  
    // move the player
    // const angle = controls.getAzimuthalAngle();
    // const direction = this.camera.getWorldDirection(this.position);
    const angle = this.theta//= direction.angleTo(this.position)

    if ( this.moving.forward ) {
  
      this.tempVector.set( 0, 0, - 1 ).applyAxisAngle( this.upVector, angle );
      this.position.addScaledVector( this.tempVector, this.moveSpeed * delta );
  
    }
  
    if ( this.moving.backward ) {
  
      this.tempVector.set( 0, 0, 1 ).applyAxisAngle( this.upVector, angle );
      this.position.addScaledVector( this.tempVector, this.moveSpeed * delta );
  
    }
  
    if ( this.moving.strafeLeft ) {
  
      this.tempVector.set( - 1, 0, 0 ).applyAxisAngle( this.upVector, angle );
      this.position.addScaledVector( this.tempVector, this.moveSpeed * delta );
  
    }
  
    if ( this.moving.strafeRight ) {
  
      this.tempVector.set( 1, 0, 0 ).applyAxisAngle( this.upVector, angle );
      this.position.addScaledVector( this.tempVector, this.moveSpeed * delta );
  
    }
  
    this.view.updateMatrixWorld();
  
    // adjust player position based on collisions
    const capsuleInfo = this.capsuleInfo;
    this.tempBox.makeEmpty();
    this.tempMat.copy( ColliderManager.collidableMesh.matrixWorld ).invert();
    this.tempSegment.copy( capsuleInfo.segment );
  
    // get the position of the capsule in the local space of the collider
    this.tempSegment.start.applyMatrix4( this.view.matrixWorld ).applyMatrix4( this.tempMat );
    this.tempSegment.end.applyMatrix4( this.view.matrixWorld ).applyMatrix4( this.tempMat );
  
    // get the axis aligned bounding box of the capsule
    this.tempBox.expandByPoint( this.tempSegment.start );
    this.tempBox.expandByPoint( this.tempSegment.end );
  
    this.tempBox.min.addScalar( - capsuleInfo.radius );
    this.tempBox.max.addScalar( capsuleInfo.radius );
  
    ColliderManager.collidableMesh.geometry.boundsTree.shapecast( {
  
      intersectsBounds: box => box.intersectsBox( this.tempBox ),
  
      intersectsTriangle: tri => {
  
        // check if the triangle is intersecting the capsule and adjust the
        // capsule position if it is.
        const triPoint = this.tempVector;
        const capsulePoint = this.tempVector2;
  
        const distance = tri.closestPointToSegment( this.tempSegment, triPoint, capsulePoint );
        
        if ( distance < capsuleInfo.radius ) {
          
          const depth = capsuleInfo.radius - distance;
          const direction = capsulePoint.sub( triPoint ).normalize();
  
          this.tempSegment.start.addScaledVector( direction, depth );
          this.tempSegment.end.addScaledVector( direction, depth );
  
        }
  
      }
  
    } );
  
    // get the adjusted position of the capsule collider in world space after checking
    // triangle collisions and moving it. capsuleInfo.segment.start is assumed to be
    // the origin of the player model.
    const newPosition = this.tempVector;
    newPosition.copy( this.tempSegment.start ).applyMatrix4( ColliderManager.collidableMesh.matrixWorld );
  
    // check how much the collider was moved
    const deltaVector = this.tempVector2;
    deltaVector.subVectors( newPosition, this.position );
  
    // if the player was primarily adjusted vertically we assume it's on something we should consider ground
    this.isOnGround = deltaVector.z > Math.abs( delta * this.velocity.z * 0.25 );
    DebugPanel.test2 = deltaVector.z.toFixed();
    const offset = Math.max( 0.0, deltaVector.length() - 1e-5 );
    deltaVector.normalize().multiplyScalar( offset );
  
    // adjust the player model
    this.position.add( deltaVector );
  
    if ( ! this.isOnGround ) {
  
      deltaVector.normalize();
      this.velocity.addScaledVector( deltaVector,  deltaVector.dot( this.velocity ) );
  
    } else {
  
      this.velocity.set( 0, 0, 0 );
  
    }
  
    // adjust the camera
  
    // if the player has fallen too far below the level reset their position to the start
    if ( this.position.y < - 25 ) {
  
      // reset();
  
    }
  
  }

  // Обеспецивает хождение по земле
  updateGroundFollow(delta: number) {
    const diff = this._groundFollowConstant - this.groundDistance;
    this.translatePosition({ z: diff + this.minGroundDistance });
  }

  updateGravity(delta: number) {
    if (this.isFly) return;

    const animationSpeed = 1.6;
    if (this.isJump) {
      let x = 0;
      let y = 0;
      if (this.jumpMoving.forward) x = this.moveSpeed * delta;
      if (this.jumpMoving.backward) x = (-this.moveSpeed / 2) * delta;
      if (this.jumpMoving.strafeLeft) y = this.moveSpeed * delta;
      if (this.jumpMoving.strafeRight) y = -this.moveSpeed * delta;

      let z = (this.jumpVelocity - this.gravity) * delta * animationSpeed;
      const fallDown = z < 0;
      if (this.isOnGround && fallDown) {
        const diff = this._groundFollowConstant - this.groundDistance;
        if (z > diff) z = diff;
      }
      this.translatePosition({ x, y, z });

      if (this.isOnGround && fallDown) {
        this.isJump = false;
        this.jumpVelocity = 0;
      }
      if (this.jumpVelocity >= 0) {
        this.jumpVelocity -= this.gravity * delta * animationSpeed;
      }
    } else {
      this.updateGroundFollow(delta);
    }
  }

  /**
   * Walk this frame's fraction of the server's path. One of the two network motion legs; see
   * `movement/net-motion.ts` for why each leg interpolates the way it does.
   *
   * `performance.now()` and not the accumulated `delta`, because the ride's clock is the SERVER's
   * -- a create-block spline is back-dated to where the server already is, and a dropped frame must
   * not slow the walk down. The clock has to be absolute for either to hold.
   */
  updateSplineFollowing(_delta: number) {
    const ride = this.splineRide;
    if (!ride) {
      return;
    }

    const sample = sampleSpline(ride, performance.now(), this.position);
    if (sample.facing !== null) {
      this.rotation.z = sample.facing;
    }

    if (sample.done) {
      // The final pose is already written -- the sampler clamps to the last point, so the unit ends
      // exactly at the server's destination rather than near it. Dropping the ride is what makes
      // `splineRide != null` mean "actively walking": kept, a finished path would read as walking
      // for ever and the gait would never return to Stand.
      if (ride.finalFacing !== null) {
        this.rotation.z = ride.finalFacing;
      }
      this.splineRide = null;
    }
  }

  /**
   * A MOB IN COMBAT TURNS TO FACE WHAT IT IS FIGHTING, interpolated -- the owner's own rule; see
   * `combatFacingPoint`.
   *
   * **This is what was missing, and the diagnosis is in the two lines above it.** A creature moves by
   * `SMSG_MONSTER_MOVE` splines, and `updateSplineFollowing` writes `rotation.z` only from
   * `sample.facing` -- so when the path ENDS it drops the ride and nothing writes the heading again.
   * A wolf that has arrived and is standing there biting keeps whatever yaw its last path ended with,
   * for ever, however far around it the player runs. That is "моб не поворачивается".
   *
   * `easeDisplayYaw` is the client's own display-facing chase, the same law a strafing peer's body and
   * the local avatar's take (`net-motion.ts:391-401`) -- reused rather than re-invented so a mob's turn
   * and a peer's turn cannot look different. Offset **0**: `strafeBodyOffset` exists to render a peer
   * whose AIM and travel disagree, and a mob turning to its victim has no such disagreement.
   *
   * Bailing when the two are on top of each other is not cosmetic: `atan2(0, 0)` is 0, so a victim at
   * the mob's own feet would snap it to face east.
   */
  private updateCombatFacing(delta: number): void {
    const point = this.combatFacingPoint;
    if (point === null) {
      return;
    }
    const dx = point.x - this.position.x;
    const dy = point.y - this.position.y;
    if (dx * dx + dy * dy < COMBAT_FACING_MIN_SQ) {
      return;
    }
    this.rotation.z = easeDisplayYaw(this.rotation.z, Math.atan2(dy, dx), 0, delta);
  }

  /**
   * Take a server-dictated path. `timePassedMs > 0` joins a walk already in progress, which is what
   * a create block's spline tail carries.
   *
   * A spline is per-frame motion this client integrates itself, so displacement becomes a real
   * measurement again and locomotion must resume -- see `wireDriven`, and note that a unit driven
   * by a spline is no longer driven by `remoteMotion`: whichever kind of motion arrived most
   * recently owns the body, and having both write `view.position` in one frame is the one thing
   * that must not happen.
   */
  setSplinePath(
    points: { x: number; y: number; z: number }[],
    durationMs: number,
    flying: boolean,
    options: { timePassedMs?: number; id?: number; finalFacing?: number | null } = {},
  ) {
    // Cleared FIRST, and unconditionally: the server has just told us this unit's motion is
    // spline-driven, which is true of a stop as much as of a walk. A degenerate path that returned
    // early before clearing would leave a creature latched `wireDriven` for the rest of its life --
    // the exact failure `wireDriven`'s own docs describe.
    this.wireDriven = false;
    this.remoteMotion = null;

    const ride = makeSplineRide(points, durationMs, flying, performance.now(), options);
    if (!ride) {
      // Not a walk: a stop, a zero duration, or a degenerate path. Clearing rather than ignoring is
      // deliberate -- a `Stop` is the server telling us this unit has stopped where it is.
      this.splineRide = null;
      return;
    }
    this.splineRide = ride;
    // Kept in sync so the debug panel and anything else reading the old pair still says something
    // true; nothing in the motion path reads them any more.
    this.totalMovingTime = durationMs / 1000;
    this.currentMovingTime = (options.timePassedMs ?? 0) / 1000;
  }

  /** The server says this unit has stopped where it is: end the walk, hold the pose. */
  clearSplinePath() {
    this.splineRide = null;
  }

  /**
   * Take one `MSG_MOVE_*` message for a peer: snap the pose and re-seed the dead-reckon.
   *
   * `wireDriven` is CLEARED here, unlike the snapped write this replaces. That flag exists because a
   * peer whose `view.position` was written only on the frames a message landed was unmeasurable.
   * Dead reckoning removes the premise twice over: the position advances every single frame, AND
   * the gait no longer comes from a measurement at all -- `locomotionFlags` reads the peer's own
   * wire flags and `locomotionSpeed` reads the speed the extrapolation is applying, which is the
   * reference's remote leg of `select::unify` (`select.rs:1069-1103`).
   */
  applyRemoteState(
    to: { x: number; y: number; z: number },
    facing: number,
    flags: number,
    tail: { pitch?: number; fallTime?: number; jump?: RemoteJumpInfo | null } = {},
  ) {
    if (!this.remoteMotion) {
      this.remoteMotion = createRemoteMotion();
    }
    // A peer who sends his own movement is no longer riding a spline; the two must never both own
    // the body. (The reverse case is handled in `setSplinePath`.)
    this.splineRide = null;
    this.wireDriven = false;

    const move: RemoteMove = {
      x: to.x, y: to.y, z: to.z, facing, flags,
      pitch: tail.pitch,
      fallTime: tail.fallTime,
      jump: tail.jump ?? null,
    };
    const nowMs = performance.now();
    const wasFresh = this.remoteMotion.fresh;
    const sinceMs = this.remoteMotion.fresh ? 0 : nowMs - this.remoteMotion.lastApplyMs;
    // Read BEFORE the apply overwrites them: the snap is measured from where we had him drawn.
    const snapFromX = this.remoteMotion.pos.x;
    const snapFromY = this.remoteMotion.pos.y;
    const snapFromZ = this.remoteMotion.pos.z;
    const snapFromFacing = this.remoteMotion.orientation;
    const gap = applyRemoteMove(this.remoteMotion, move, nowMs);
    this.position.copy(this.remoteMotion.pos);
    // NOT the rendered yaw any more, except on FIRST SIGHT. `motion.orientation` is authoritative and
    // snaps here; the BODY yaw eases onto it in `updateRemoteMotion` (the client's display-facing
    // blend). Snapping the render too put a visible yaw step on every arriving packet, which for a
    // mouse-turning peer is every ~33 ms of his turn. First sight has nothing to ease from -- yaw 0
    // is not a heading he ever held -- so it snaps.
    if (wasFresh) {
      this.rotation.z = this.remoteMotion.orientation;
    }

    peerTrace.record({
      at: nowMs,
      kind: 'packet',
      guid: this.guid,
      flags,
      x: to.x,
      y: to.y,
      z: to.z,
      facing,
      sinceMs,
      stepYd: gap,
      // DECOMPOSED, and this is the split the previous round's aggregate hid: `snapXY` is the dead
      // reckoning's real tracking error and `snapZ` was, before the ground resolve, the whole height
      // staircase arriving in one step.
      dxy: wasFresh ? 0 : Math.hypot(to.x - snapFromX, to.y - snapFromY),
      dz: wasFresh ? 0 : to.z - snapFromZ,
      dyaw: wasFresh ? 0 : wrapPi(facing - snapFromFacing),
      speed: 0,
      gaitSpeed: this.remoteMotion.speed,
      // RAW, uninterpreted: the sign convention is the thing in dispute. See `PeerTraceRow#zSpeed`.
      zSpeed: tail.jump ? tail.jump.zSpeed : 0,
      fallTime: tail.fallTime ?? 0,
    });

    // Reported, not acted on: a packet always snaps, so there is no interpolation to suppress. A
    // routine correction is centimetres -- that it stays small is the evidence the dead-reckon is
    // tracking him. Anything past `REMOTE_SNAP_DISTANCE` is a worldport or a re-entry into our grid.
    if (gap > REMOTE_SNAP_DISTANCE) {
      this.remoteRelocations += 1;
    }
  }

  /** How many times a peer's packet moved him further than travel could explain. Diagnostic only. */
  public remoteRelocations = 0;

  /** Whole seconds of runaway already reported for this peer, so the warning is once a second. */
  private runawayWarnedS = -1;

  /**
   * Advance a peer one frame of dead reckoning.
   *
   * `delta` is the frame's own seconds, not a wall-clock difference: this is an INTEGRATION, and it
   * has to advance by exactly the time the rest of the frame advanced by or the peer's position and
   * everything else in the scene disagree about what "now" means.
   */
  updateRemoteMotion(delta: number, viewerPos?: THREE.Vector3) {
    const motion = this.remoteMotion;
    if (!motion) {
      return;
    }
    const beforeX = motion.pos.x;
    const beforeY = motion.pos.y;
    const beforeZ = motion.pos.z;
    const beforeYaw = this.rotation.z;
    const orientation = advanceRemote(motion, this.speeds, delta, this.position);

    // THE INVENTED STEP MEETS THE WORLD -- the reference's decision 0626
    // (`net/motion/remote.rs:461-524`, `extrapolate_remote_units`), and the answer to the defect the
    // previous round's "numerically perfect" measurement could not see.
    //
    // `advanceRemote` NEVER MOVES A GROUNDED PEER'S Z (`net-motion.ts#advanceRemote`: `dz` is zero
    // unless he is swimming), so his height changed only where a PACKET put it. A peer running
    // straight sends nothing but his 500 ms heartbeat -- `MSG_MOVE_SET_FACING` only goes out while he
    // turns -- so a straight run drew a continuous XY glide under a 2 Hz HEIGHT STAIRCASE. On ground
    // that rises under him that sinks him into the hillside; on ground that falls away it floats him.
    // The reference names both symptoms in exactly those words (`remote.rs:389-399`), and they are
    // the owner's "прыгает на новую координату" and "немного утопает в земле".
    //
    // THE PREVIOUS MEASUREMENT MISSED IT because it recorded one scalar per frame --
    // `hypot(dx, dy, dz)` over the integration -- and the integration's dz is identically zero. The
    // staircase lives entirely in the PACKET rows, where it was reported as a 0.019-0.58 yd
    // "residual" and read as evidence the dead reckoning was tracking well. Decomposed, most of that
    // residual was Z. `peerTrace` now records the axes separately for that reason.
    //
    // The resolve is the LOCAL controller's own election snap, under the same reach law and the same
    // walkable filter, so height comes off the surface every frame instead of standing frozen at the
    // last packet's Z. Excluded:
    //  - a SWIMMER: his wire Z is a depth in a water volume, not a surface to stand on;
    //  - an AIRBORNE peer: the ballistic arc owns its Z, which is the whole point of a jump.
    //
    // WHAT A PEER DOES NOT GET, and why: the step-up and the swept slide. The reference runs a remote's
    // step through its whole controller (decision 0626) and the first version of this did too; measured
    // on one live session with 83 entities and ONE peer, interleaved A/B, that cost `anim` p50
    // 1.5 -> 7.2 ms and `world.animate` p50 4.9 -> 10.8 ms. `snapToGround`'s own doc has the whole
    // measurement and the reason (six to eight casts versus one, on a collision world with no
    // persistent BVH). So an invented step is NOT stopped by our walls -- the remaining half of the
    // reference's `WOW_REMOTE_FLAT` -- and that is a knowing trade against a frame budget, not an
    // oversight.
    //
    // AND IT IS DECIMATED BY DISTANCE, on the same law the pose gate uses (`anim/gating.ts#shouldPose`
    // -- every frame inside 40 yd, every second to 120, every fourth beyond, staggered per unit so the
    // periods do not pile onto one frame). One cast is not cheap here: MEASURED directly, on loaded
    // Northshire terrain with 441 chunks, 301 WMO groups and 4600 doodad hulls, one downward capsule
    // cast costs 0.92 ms, because `DoodadProvider#gather` walks every registered hull per cast (its own
    // doc measures the same thing from the other side). At 40+ yd a fifth of a yard of height error is
    // invisible and a 66 ms correction period is not worth 0.9 ms a frame.
    //
    // WHAT IS STILL LINEAR, stated rather than hidden: nearby peers. Ten players inside 40 yd is ten
    // casts, ~9 ms, and this gate does nothing about it. The real fix is a broadphase for the doodad
    // hulls -- which would also give the LOCAL mover back most of its ~2.7 ms, since it issues about
    // 2.9 of these casts every frame -- and that is a collision-layer change, not a movement one.
    const airborne = (motion.flags & MoveFlag.FALLING) !== 0;
    const swimming = (motion.flags & MoveFlag.SWIMMING) !== 0;
    const due = viewerPos === undefined
      || shouldPose(worldClock.frameIndex, this.model?.poseSlot ?? 0, viewerPos.distanceTo(motion.pos));
    //
    // A STATIONARY PEER IS SNAPPED TOO, and the round that skipped him was wrong -- this is the
    // regression that made every standing peer and every standing creature HOVER. The reasoning behind
    // the skip ("he has invented nothing, so his own reported Z is the authority") is true about the
    // WIRE and false about the SCREEN: the server's Z and the height our terrain actually draws
    // disagree by up to a yard and a half, and what the eye judges is the grass under his feet. The
    // snap only ever LOWERS a body onto the floor it is standing above, so withholding it from a unit
    // that is not moving is exactly "leave him wherever the disagreement puts him". The reference has
    // no such exemption: `extrapolate_remote_units` resolves every remote every frame regardless of
    // motion.
    //
    // Cost is handled by a PRE-GATE rather than by an exemption: a heightmap lookup is 0.065 ms against
    // the cast's 0.92 (both measured), so ask the cheap question first -- is this unit's Z even in
    // disagreement with the ground? -- and pay for the cast only when it is. A unit already standing on
    // the terrain costs the lookup and nothing else, which is the case the exemption was trying to buy
    // and gets it without the hover.
    const travel = Math.hypot(motion.pos.x - beforeX, motion.pos.y - beforeY);

    // THE AIRBORNE FLOOR CLAMP. A descending arc gets no resolve at all above -- a jump owns its Z --
    // and nothing ends it until `MSG_MOVE_FALL_LAND` arrives, which is up to a packet interval after
    // the body has actually touched down. MEASURED on the ground-relative capture (`PK7`), that tail
    // put a peer 2.118 yd UNDER the grass at the end of one arc in eight, descending smoothly through
    // the surface: the owner's "buried" symptom in miniature, and the last of it.
    //
    // A CLAMP, not a resolve, and from the HEIGHTMAP rather than a cast: it only ever refuses to let an
    // invented arc pass through the floor, it costs 0.065 ms against a cast's 0.92 (both measured), and
    // it runs only while airborne AND descending, which is a few frames per jump. The reference stops
    // the arc with its own swept `airborne_step` (decision 0627, so a jump into a building is stopped
    // by the wall too); that is the six-cast version this client cannot afford per peer per frame, and
    // the difference -- walls, not floors -- is stated at `snapToGround`.
    //
    // Deliberately NOT applied while rising: the heightmap is not the only thing a jump can leave from
    // (a WMO floor, a bridge), and clamping upward would shove a peer who jumped off a balcony up onto
    // the terrain far below him.
    if (!this.isPlayer && airborne && motion.verticalVelocity < 0 && !peerTrace.flatExtrapolation) {
      const floor = collisionWorld.terrain.heightAt(motion.pos.x, motion.pos.y);
      if (floor !== null && motion.pos.z < floor) {
        motion.pos.z = floor;
        this.position.z = floor;
        // The arc is over as far as our drawing is concerned. Zeroing the vertical stops it burrowing
        // further on every later frame of the same silence; the peer's own FALL_LAND still decides when
        // he is grounded, because the flags are his to send and not ours to invent.
        motion.verticalVelocity = 0;
      }
    }
    if (!this.isPlayer && !swimming && !airborne && due && !peerTrace.flatExtrapolation
      && needsGroundSnap(motion.pos)) {
      const half = CAPSULE_HEIGHT * 0.5;
      _remoteFrom.set(motion.pos.x, motion.pos.y, motion.pos.z + half);
      // Skin ZERO: a peer sits exactly on the surface, so the height tracks every frame instead of
      // living in a 0.02 yd dead band. See `snapToGround`'s `skin` note for the measurement.
      const drop = snapToGround(remoteCast(), _remoteFrom, travel, 0);
      if (drop !== null) {
        // Written back onto the ANCHOR, not just onto the render: the next frame extrapolates from the
        // resolved pose, so the correction is not re-derived from a stale base every frame. The
        // reference does the same (`remote.rs:578`, `rm.wow_pos = pos`). A MISS leaves him where the
        // packet put him, which is right: no floor within reach means the terrain under him has not
        // streamed yet, or he really is over a drop his own client is falling down.
        // `drop` is how far the CAPSULE CENTRE may descend before contact, so the feet fall by exactly
        // the same amount -- `groundedStep` lowers its own centre by `hit.distance` and derives the
        // feet from it identically. An earlier version wrote `+= half - drop`, which added the
        // half-height on top and made the peer bounce: measured, |dz| p50 0.71 yd PER FRAME against
        // 0.005 for the correct form.
        motion.pos.z -= drop;
        this.position.z = motion.pos.z;
      }
    }

    // THE RENDERED BODY YAW, eased -- the client's display-facing blend, the same law the strafing
    // avatar's body takes (`net-motion.ts#easeDisplayYaw`). Two things it buys:
    //  - a strafing peer renders his body 45/90 degrees off his aim, which is how WoW shows a strafe
    //    (there is no strafe gait: `remote.rs:592-609`);
    //  - the per-packet yaw SNAP is absorbed. `motion.orientation` is authoritative and still snaps
    //    at arrival; what the eye sees is this chase converging on it inside ~40 ms.
    //
    // DEVIATION, stated: the reference smooths a remote's facing with a pre-fire lerp toward the NEXT
    // queued packet's facing (`remote.rs:536-549`), which needs the replay schedule this client does
    // not have -- we apply at arrival, the reference's own `WOW_REMOTE_SNAP=1` mode. With no future
    // target to converge on, the display blend is what is left, and its rate is the client's own.
    const offset = swimming ? 0 : strafeBodyOffset(motion.flags);
    this.rotation.z = easeDisplayYaw(this.rotation.z, orientation, offset, delta);

    if (peerTrace.enabled) {
      const dxy = Math.hypot(motion.pos.x - beforeX, motion.pos.y - beforeY);
      const dz = motion.pos.z - beforeZ;
      const stepYd = Math.hypot(dxy, dz);
      peerTrace.record({
        at: performance.now(),
        kind: 'frame',
        guid: this.guid,
        flags: motion.flags,
        x: motion.pos.x,
        y: motion.pos.y,
        z: motion.pos.z,
        facing: motion.orientation,
        sinceMs: delta * 1000,
        stepYd,
        dxy,
        dz,
        dyaw: wrapPi(this.rotation.z - beforeYaw),
        speed: delta > 0 ? stepYd / delta : 0,
        gaitSpeed: motion.speed,
      });
    }

    // The runaway watch, the reference's `trace_runaway` (`remote.rs:158-178`). A moving peer is fed
    // at worst every 500 ms by his own heartbeat, so seconds of silence with a direction flag still
    // set means we are inventing motion the server never described -- a lost STOP, or a socket that
    // died with nobody noticing. REPORTING ONLY: the reference does not correct the pose here either,
    // and a peer frozen by a guard would be a different wrong answer, not a right one.
    if ((motion.flags & ANY_MOVE) === 0) {
      this.runawayWarnedS = -1;
      return;
    }
    const silent = remoteSilentMs(motion, performance.now());
    if (silent <= RUNAWAY_SILENCE_MS) {
      this.runawayWarnedS = -1;
      return;
    }
    const silentS = Math.floor(silent / 1000);
    if (silentS !== this.runawayWarnedS) {
      this.runawayWarnedS = silentS;
      const drift = Math.hypot(
        motion.pos.x - motion.lastApplyPos.x,
        motion.pos.y - motion.lastApplyPos.y,
      );
      console.warn(
        `movement: peer ${this.guid} RUNAWAY -- flags 0x${motion.flags.toString(16)}, silent`
        + ` ${silentS}s, ${drift.toFixed(1)} yd carried on dead reckoning alone since the last`
        + ' packet. Either his STOP never arrived or the world socket is dead.',
      );
    }
  }

  // public calculateOrientation() {
  //   let orientation;
  //   if (this.rotation.x == 0)
  //   {
  //       if (this.rotation.y > 0)
  //           orientation = Math.PI / 2;
  //       else
  //           orientation = 3 * Math.PI / 2;
  //   }
  //   else if (this.rotation.z == 0)
  //   {
  //       if (this.rotation.x > 0)
  //           orientation = 0;
  //       else
  //           orientation = Math.PI;
  //   }
  //   else
  //   {
  //       orientation = Math.atan2(this.rotation.y, this.rotation.x);
  //       if (orientation < 0)
  //           orientation += 2 * Math.PI;
  //   }

  //   return orientation;
  // }
}

export default Unit;
