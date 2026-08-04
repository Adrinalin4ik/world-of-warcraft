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
 * `idle` is Stand, confirmed against the DBC name column (`Stand` at row 0) and against every model
 * parsed for this task -- `Rabbit.m2`'s single sequence is id 0, and wolf / kobold / murloc all
 * carry it as slot 0.
 *
 * The members this enum USED to carry (`forward = 2`, `backward = 133`, `rotating = 38`) were read
 * off a per-model sequence-table listing, not the DBC, and were wrong as DBC ids: row 133 is
 * `FishingCast`, not a backpedal. They were only ever read by `updateMoving`, which never had a
 * caller; locomotion now goes through the verified gait ids below.
 */
enum Animation {
  idle = 0,
  jump = 15,
  grounding = 16
}

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
  public isMoving: boolean = false;
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
    idle: true,
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

  updateIsMovingFlag(newCoords: THREE.Vector3) {
    const coords = this.view.position;
    if (
      newCoords.x !== coords.x ||
      newCoords.y !== coords.y ||
      newCoords.z !== coords.z
    ) {
      this.isMoving = true;
    } else {
      this.isMoving = false;
    }
  }

  beforePositionChange(newCoords: THREE.Vector3) {
    this.prevPosition = this.position.clone();
    // this.updateGroundDistance(newCoords);

    this.updateIsMovingFlag(newCoords);
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
    this.emit("position:change", this.position, this.view.rotation);
  }

  applyTranslatePosition() {
    if (this.tmpVector.x !== 0 ||
        this.tmpVector.y !== 0 ||
        this.tmpVector.z !== 0 ) {

      this.view.translateX(this.tmpVector.x);
      this.view.translateY(this.tmpVector.y);
      this.view.translateZ(this.tmpVector.z);
      this.tmpVector.set(0, 0, 0);
      
      this.emit("position:change", this.position, this.view.rotation);
    }

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
   * This frame's horizontal ground speed (yd/s) -- the gait threshold's only input.
   *
   * TWO LEGS, exactly as the reference's `select::unify` (`select.rs:931-965`) has three:
   *
   * - The PLAYER is driven from Controls, which runs `movementFrame` and leaves the applied
   *   horizontal velocity on `move.horizVel`. That is an INTENDED velocity, not a displacement,
   *   which is deliberate and matches `benilla/src/player.rs:1209-1213`: running into a wall keeps
   *   the run cycle playing, which is the WoW look. Swimming substitutes the stroke speed, same as
   *   the reference's `if swimming { swim_stroke_speed }`.
   *
   * - EVERY OTHER unit is moved by writing `view.position` outright -- the spline follower for
   *   server creatures (`updateSplineFollowing`), and the peer handler at
   *   `network/entity/entity.ts` for remote players. Neither maintains a velocity, so the speed has
   *   to be measured. This is the reference's creature leg, whose `Spline::speed()` is likewise a
   *   path length over a duration rather than a state field.
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
   * creature holds the first keyframe of its run cycle for ever. `setAnimation` already refuses to
   * re-arm a running loop, and this method must not go behind its back -- so the arm is gated on the
   * resolved SEQUENCE differing from the one already playing, which is the reference's own shape
   * (`driver.rs:1017`, `if drv.gait == Some(target)` -> re-sync only, no re-arm).
   */
  updateLocomotion(delta: number) {
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

    // A one-shot still inside its play window OWNS the body: a jump, a landing, an attack swing.
    // Locomotion runs every frame and would otherwise stomp it on the very next one, so nothing
    // one-shot would ever be visible. The reference holds the same way and releases on the clip
    // finishing (`driver.rs:868-884`, `Mode::Swing`). Loops are not held -- that is the gait itself.
    const playing = inst.current;
    if (playing !== null && !playing.loops && !inst.windowElapsed(worldClock.ms)) {
      return;
    }

    const candidates = this.gaitFor(speed);

    // Step down the list, taking the first id the model actually OWNS. `resolve` handing back a
    // sequence whose id is not the one asked for means it fell back, so this rung is absent.
    let target = candidates[candidates.length - 1];
    let seq: Sequence | null = null;
    for (let i = 0; i < candidates.length; ++i) {
      const candidate = candidates[i];
      const resolved = modelAnim.resolve(candidate);
      if (resolved !== null && resolved.id === candidate) {
        target = candidate;
        seq = resolved;
        break;
      }
    }

    if (seq === null) {
      // Nothing on the list is owned. Take whatever `resolve` falls back to for the last rung --
      // sequence 0 -- rather than freezing in bind pose. Null only for a model with nothing
      // playable at all (empty table, or every sequence quarantined as external).
      seq = modelAnim.resolve(target);
      if (seq === null) {
        return;
      }
    }

    if (inst.current === seq) {
      return;
    }

    this.setAnimation(target);
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
