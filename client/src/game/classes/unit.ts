import * as THREE from "three";

import DBC from "../pipeline/dbc";
import Entity from "./entity";
import M2Blueprint from "../pipeline/m2/blueprint";
import ColliderManager from "../world/collider-manager";
import M2 from "../pipeline/m2";

enum SlopeType {
  sliding,
  climbing,
  none
}

enum Animation {
  idle = 0,
  forward = 2,
  backward = 133,
  jump = 15,
  rotating = 38,
  grounding = 16
}

class Unit extends Entity {
  public guid: string;
  public name: string = "<unknown>";
  public level: number = 0;
  public target: Unit | null = null;
  public health: number = 0;
  public mana: number = 0;

  private _view: THREE.Group = new THREE.Group();
  private _displayId: number = 0;
  private _model: M2 | null = null;
  private modelData: DBC | null = null;
  private playerGeometry: THREE.BoxGeometry = new THREE.BoxGeometry(0, 0, 0);
  private playerMaterial: THREE.MeshBasicMaterial = new THREE.MeshBasicMaterial(
    {
      wireframe: true,
      opacity: 0
    }
  );
  public collider: THREE.Mesh = new THREE.Mesh(
    this.playerGeometry,
    this.playerMaterial
  );
  public currentAnimationIndex: number = 0;
  private displayInfo: DBC | null = null;

  public rotateSpeed: number = 2;
  public moveSpeed: number = 10; //10
  public flySpeed: number = 15; //10
  public gravity: number = 10; //10;
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

  constructor(guid: string) {
    super();
    this.guid = guid;

    this.collider.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.collider.name = "Collider";

    // this.arrow.setDirection(this.groundDistanceRaycaster.ray.direction);
    this.arrow.setDirection(new THREE.Vector3(1, 0, 0));

    // Animation
    this.currentAnimationIndex = 0;

    // this.view.add(this.collider);
    this.view.add(this.arrow);
  }

  get isOnGround() {
    return this.groundDistance <= this.groundZeroConstant;
  }

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
      DBC.load("CreatureModelData", modelID).then((modelData: DBC) => {
        this.modelData = modelData;
        this.modelData.path = this.modelData.file.match(/^(.+?)(?:[^\\]+)$/)[1];
        this.displayInfo!.modelData = this.modelData;

        M2Blueprint.load(this.modelData.file).then((m2: M2) => {
          this.model = m2;
          this.model.displayInfo = this.displayInfo;

          const { max, min } = m2.geometry.boundingBox;
          this.collider.geometry = new THREE.BoxGeometry(
            max.x - min.x,
            max.y - min.y,
            max.z - min.z
          );
        });
      });
    });
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

    this.view.add(m2);

    // Auto-play animation index 0 in unit model, if present
    // TODO: Properly manage unit animations
    if (m2.animated && m2.animations.length > 0) {
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
      m2.animations.playAnimation(this.currentAnimationIndex);
      m2.animations.playAllSequences();
    }

    this.emit("model:change", this, this._model, m2);
    this._model = m2;
  }

  setAnimation(
    index: number,
    interrupt: boolean = false,
    repetitions: number = -1
  ) {
    if (!this.model) return;
    const isRunning = this.model.animations.currentAnimation.isRunning();
    if (isRunning) {
      if (
        this.model.animations.currentAnimation.repetitions === Infinity &&
        this.currentAnimationIndex !== index
      ) {
        this.startAnimation(index, repetitions);
      }
    } else {
      this.startAnimation(index, repetitions);
    }
  }

  startAnimation(index: number, repetitions: number) {
    this.stopAnimation();
    this.model.animations.playAnimation(
      index,
      repetitions === -1 ? Infinity : repetitions
    );
    this.currentAnimationIndex = index;
    this.emit("animation:play", index, repetitions);
  }

  stopAnimation(index?: number) {
    if (!this.model) return;
    const animationIndex = index || this.currentAnimationIndex;
    this.emit("animation:stop", animationIndex);
    this.model.animations.stopAnimation(animationIndex);
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
    // this.translatePosition({ x: this.moveSpeed * delta });
  }

  moveBackward(delta: number) {
    if (this.isJump) return;
    this.moving.backward = true;
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
    // this.translatePosition({ y: this.moveSpeed * delta });
  }

  strafeRight(delta: number) {
    if (this.isJump) return;
    this.moving.strafeRight = true;
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

    this.afterPositionChange();
  }

  applyTranslatePosition() {
    this.view.translateX(this.tmpVector.x);
    this.view.translateY(this.tmpVector.y);
    this.view.translateZ(this.tmpVector.z);
    this.tmpVector.set(0, 0, 0);

    if (
      this.prevPosition.x !== this.position.x ||
      this.prevPosition.y !== this.position.y ||
      this.prevPosition.z !== this.position.z
    ) {
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

    // intersect with all scene meshes.
    const intersects = this.groundDistanceRaycaster.intersectObjects(
      Array.from(
        ColliderManager.collidableMeshList.values()
      ) as THREE.Object3D[]
    );
    if (intersects.length > 0) {
      this.groundDistance = intersects[0].distance;
      const intersectedObject = intersects[0].object;
      const slopeRay = new THREE.Ray(this.position, this.rotation.toVector3())
      const slopeRayGround = new THREE.Ray(intersectedObject.position, this.rotation.toVector3())

      // const slopeIntersects = slopeRay.intersectObject(slopeRayGround)
      const slopeIntersects = slopeRay.direction.dot(slopeRayGround.direction)
      // console.log(slopeRayGround.direction)
      // const reverseAngle = slopeIntersects.length ? -90 : 90;
      this.slopeAng =
        (this.position.angleTo(intersects[0].face!.normal) * 180) / Math.PI - 90;
      this.slopeAng = (slopeIntersects ? -1 : 1) * THREE.Math.degToRad(this.slopeAng);
      // new THREE.Vector3(0, 1, 0).angleTo(intersects[0].face!.normal)
      this.slopeType =
        this.slopeAng < this.slopeLimit
          ? SlopeType.sliding
          : SlopeType.climbing;

      // this.rotation.set(0, this.slopeAng, 0); 
      // this.arrow.lookAt(new THREE.Vector3(1, 0, this.slopeAng))
      // this.arrow.setDirection(new THREE.Vector3(1, 0, this.slopeAng))
      this.arrow.setDirection(slopeRayGround.direction)
    }
  }

  updateMoving(delta: number) {
    this.moving.idle =
      !this.moving.backward &&
      !this.moving.forward &&
      !this.moving.strafeLeft &&
      !this.moving.strafeRight &&
      !this.moving.rotateRight &&
      !this.moving.rotateLeft &&
      !this.isJump &&
      !this.isMoving;

    if (true) {
      if (this.moving.forward) {
        this.translatePosition({ x: this.moveSpeed * delta });
        this.setAnimation(Animation.forward, true);
      }
      if (this.moving.backward) {
        this.translatePosition({ x: (-this.moveSpeed * delta) / 2 });
        this.setAnimation(Animation.backward);
      }
      if (this.moving.strafeRight) {
        this.translatePosition({ y: -this.moveSpeed * delta });
      }
      if (this.moving.strafeLeft) {
        this.translatePosition({ y: this.moveSpeed * delta });
      }
      if (this.moving.rotateRight) {
        if (!this.isMoving) {
          this.setAnimation(Animation.rotating);
        }
        this.view.rotateZ(-this.rotateSpeed * delta);
        this.changeRotation();
      }
      if (this.moving.rotateLeft) {
        if (!this.isMoving) {
          this.setAnimation(Animation.rotating);
        }
        this.view.rotateZ(this.rotateSpeed * delta);
        this.changeRotation();
      }

      if (this.moving.idle) {
        this.setAnimation(Animation.idle);
      }
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

  update(delta: number) {
    this.updateGroundDistance();
    this.updateMoving(delta);
    if (this.useGravity) {
      this.updateGravity(delta);
    }
    this.applyTranslatePosition();
    this.clear();
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
}

export default Unit;
