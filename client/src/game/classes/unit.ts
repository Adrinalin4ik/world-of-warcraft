// import * as THREE from "three";
import * as THREE from 'three';
import { Vector3 } from 'three';
import DebugPanel from '../../pages/game/debug/debug';
import DBC from "../pipeline/dbc";
import M2 from "../pipeline/m2";
import type { Sequence } from "../pipeline/m2/anim/model-anim";
import { worldClock } from "../pipeline/m2/anim/world-clock";
import M2Blueprint from "../pipeline/m2/blueprint";
import ColliderManager from "../world/collider-manager";
import { collisionWorld } from "../collision/collision-world";
import { DEFAULT_COLLISION_HEIGHT, SETTLE_TIMEOUT } from "../movement/constants";
import { createPlayerMoveState } from "../movement/player-state";
import Entity from "./entity";

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

/** Stand. DBC name column row 0 = `Stand`; slot 0 of every model parsed for this task. */
const STAND = 0;
/** Walk. DBC row 4 -- its own fallback column is empty, i.e. Walk falls back to Stand. */
const WALK = 4;
/** Run. DBC name column row 5 = `Run`; wolf and kobold both carry it inline (flags `0x20`). */
const RUN = 5;

/**
 * Gait candidate lists, most specific first -- the reference picks a LIST, not an id, so a model
 * that lacks the ideal clip steps DOWN one rung rather than snapping straight to Stand
 * (`select.rs:450-455`). This matters here because `ModelAnim#resolve` falls back to sequence 0 and
 * nothing else: asking it for Run on a model that only walks would yield Stand, which is a creature
 * sliding along the ground. Walking it instead is both correct and what the reference does.
 *
 * Module-level and frozen: `updateLocomotion` runs per unit per frame and must not allocate.
 */
const GAIT_RUN: readonly number[] = [RUN, WALK, STAND];
const GAIT_WALK: readonly number[] = [WALK, STAND];
const GAIT_STAND: readonly number[] = [STAND];

/**
 * Is this id a GAIT rather than a state?
 *
 * A gait request never takes the body away from the gait driver, whoever sent it. Without this, a
 * wire-sent Stand -- which the peer handler does send, and which the server sends constantly --
 * would latch `externalSeq` onto a LOOPING sequence, and a looping owner never releases: the
 * unit would stand still for the rest of the session no matter how far it walked. The reference
 * draws the same line, between its `Special` / `Mode` states and the gait itself
 * (`select.rs:280+`).
 */
function isGaitId(id: number): boolean {
  return id === STAND || id === WALK || id === RUN;
}

/**
 * Below this ground speed (yd/s) a unit counts as standing still -- `select.rs:19`'s
 * `MOVING_EPSILON`, which guards the near-zero residual a streamed mover leaves behind.
 */
const MOVING_EPSILON = 0.1;

/**
 * Fallback walk speed (yd/s) -- `select.rs:12`'s `DEFAULT_WALK_SPEED`, vanilla's default creature
 * walk. The run boundary is STRICTLY above 2x this (`RecomputeBaseAnim`, so 5.0 yd/s is still a
 * walk and 5.1 runs). Per-unit walk speeds arrive on the `LIVING` movement block; until the wire
 * carries them, every unit shares this one. See the report's follow-ups.
 */
const DEFAULT_WALK_SPEED = 2.5;

/**
 * Displacement speed (yd/s) above which a measured frame is a TELEPORT, not locomotion.
 *
 * A worldport or a spawn snap moves a unit hundreds of yards in one frame. Without this the unit
 * would flash into its run cycle for exactly one frame on arrival. Well above any real gait
 * (vanilla MOVE_RUN is 7) and well below any real relocation.
 */
const TELEPORT_SPEED = 100;

class Unit extends Entity {
  public guid: string;
  public name: string = "<unknown>";
  public level: number = 0;
  public target: Unit | null = null;
  public health: number = 0;
  public mana: number = 0;

  public isPlayer: boolean = false;

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
      color: '0xff0000',
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
  public moveSpeed: number = 100; //10
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
  private spline: THREE.CatmullRomCurve3 | null = null;
  
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

    DBC.load("CreatureDisplayInfo", displayId).then((displayInfo: DBC) => {
      this._displayId = displayId;
      this.displayInfo = displayInfo;
      const modelID = displayInfo.modelID;
      return DBC.load("CreatureModelData", modelID).then((modelData: DBC) => {
        this.modelData = modelData;
        this.modelData.path = this.modelData.file.match(/^(.+?)(?:[^\\]+)$/)[1];
        this.displayInfo!.modelData = this.modelData;
        // The unit's OWN collision height -- what every swim depth line is a fraction of, which is
        // why a gnome floats with her head out and a night elf sits deeper. NOT the movement
        // capsule height, which is a constant feel knob. Falls back to the client's own
        // empty-world default when the row carries no usable value, because at zero every depth
        // line collapses and the avatar swims on dry land.
        const rawHeight = (modelData as any).collisionHeight;
        const displayScale = (displayInfo as any).scale || (modelData as any).scale || 1;
        this.collisionHeight = rawHeight > 0
          ? rawHeight * displayScale
          : DEFAULT_COLLISION_HEIGHT;
        this.move.collisionHeight = this.collisionHeight;

        return M2Blueprint.load(this.modelData.file).then((m2: M2) => {
          this.model = m2;
          this.model.displayInfo = this.displayInfo;
          this.model.visible = true;

          // Assigning displayInfo above kicks off texture loads, which are deliberately
          // fire-and-forget: each one fills its slot in the material's texture array when it
          // resolves and handles its own errors. Bluebird cannot tell that apart from a forgotten
          // return and warns about it, so say explicitly that nothing is being chained.
          return null;
        });
      });
    }).catch(console.error);
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

    // The gait memo is keyed on nothing but the candidate list, so a new model would otherwise be
    // posed with the OLD one's resolved sequence -- an object belonging to a different sequence
    // table. This is the only event that can change what an id resolves to.
    this.locoCandidates = null;
    this.locoSeq = null;

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
      if (!interrupt && !inst.windowElapsed(worldClock.ms)) {
        return;
      }
    }

    this.startAnimation(id, repetitions);
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
   * model that can least afford it. Invalidated in `set model`, the only thing that can change what
   * an id resolves to.
   */
  private locoCandidates: readonly number[] | null = null;
  private locoTarget: number = STAND;
  private locoSeq: Sequence | null = null;

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

    // The FIRST measured frame has no previous position to difference against -- the unit spawned
    // wherever it spawned, and `0 -> spawn point` is a teleport-sized delta.
    if (first || delta <= 0) {
      return 0;
    }

    const speed = Math.sqrt(dx * dx + dy * dy) / delta;
    return speed > TELEPORT_SPEED ? 0 : speed;
  }

  /**
   * The gait candidate list for a speed. See `GAIT_*` above for why this returns a list.
   *
   * Standing is a SPEED test here, not the flag test the reference uses for a player with wire
   * flags (`select.rs:447`), because this client has no movement flags on the unit -- Controls
   * computes them locally and does not publish them. The reference does exactly this same
   * substitution on the one leg that also lacks flags, its spline creatures (`select.rs:958-962`).
   */
  gaitFor(speed: number): readonly number[] {
    if (speed <= MOVING_EPSILON) {
      return GAIT_STAND;
    }
    return speed > 2 * DEFAULT_WALK_SPEED ? GAIT_RUN : GAIT_WALK;
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

    const model = this.model;
    if (!model) {
      return;
    }

    const inst = model.instanceAnim;
    const modelAnim = model.modelAnim;
    if (!inst || !modelAnim) {
      return;
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
      } else if (owner.lengthMs > 0 && !inst.windowElapsed(worldClock.ms)) {
        return;
      } else {
        this.externalSeq = null;
      }
    }

    const candidates = this.gaitFor(speed);

    // Step down the list, taking the first rung the model actually OWNS -- `resolve(id, false)`
    // withholds the Stand consolation precisely so "absent" is distinguishable from "present".
    if (candidates !== this.locoCandidates) {
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
    }

    if (this.locoSeq === null) {
      return;
    }

    if (this.locoSeq.loops && inst.current === this.locoSeq) {
      return;
    }

    // `startAnimation` clears the ownership latch for us: the target is always a gait id.
    this.setAnimation(this.locoTarget);
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

  update(delta: number) {
    // The player's frame is driven from Controls, which owns the input and the camera heading and
    // calls `movementFrame` + `syncViewFromMove` itself. Only non-player units integrate here.
    if (this.isPlayer) {
      return;
    }

    {
      this.updateSplineFollowing(delta);
    }
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

  updateSplineFollowing(delta: number) {
    if (!this.spline) return;
    // console.log('spline', this.spline)
    const currentTime = (this.currentMovingTime + delta / this.totalMovingTime);
    if (currentTime >= 1) {
      this.currentMovingTime = 0;
      return;
    }
    const pos = this.spline?.getPoint(currentTime);
    // this.view.lookAt(new THREE.Vector3(pos.x, pos.y, pos.z));
    // this.view.rotateX(this.view.rotation.x +  180 * Math.PI / 180); // to radians
    // this.view.rotateY(this.view.rotation.y -  Math.PI / 2); // to radians
    // this.view.rotateZ(this.view.rotation.z +  180 * Math.PI / 180); // to radians
    this.position.set(
      pos?.x,
      pos?.y,
      pos?.z
    )
    

    this.currentMovingTime += (delta / this.moveSpeed / 4);
  }

  setMovingData(currentMovingTime: number, points: Vector3[], totalMovingTime?: number) {
    // A spline is per-frame motion this client integrates itself, so displacement becomes a real
    // measurement again and locomotion must resume. Without this, a creature that took one snapped
    // `MSG_MOVE_*` position before its spline arrived would stay locomotion-silent for life. See
    // `wireDriven`: the most recent kind of motion decides.
    this.wireDriven = false;

    this.currentMovingTime = currentMovingTime;
    if (totalMovingTime) {
      this.totalMovingTime = totalMovingTime;
    }

    if (!points.length) {
      return;
    }

    this.spline = new THREE.CatmullRomCurve3(points, true, 'chordal');
    // console.log('splines', this.spline);
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
