import * as THREE from 'three';

import DBC from '../pipeline/dbc';
import Entity from './entity';
import M2Blueprint from '../pipeline/m2/blueprint';
import ColliderManager from '../world/collider-manager';
import M2 from '../pipeline/m2';

class Unit extends Entity {

  public guid: string;
  public name: string = '<unknown>';
  public level: number = 0;
  public target: Unit | null = null;
  public health: number = 0;
  public mana: number = 0;

  private _view: THREE.Group = new THREE.Group();
  private _displayId: number = 0;
  private _model: M2 | null = null;
  private modelData: DBC | null = null;
  private playerGeometry: THREE.BoxGeometry = new THREE.BoxGeometry(0, 0, 0);
  private playerMaterial: THREE.MeshBasicMaterial = new THREE.MeshBasicMaterial({ wireframe: true, opacity: 0 });
  public collider: THREE.Mesh = new THREE.Mesh(this.playerGeometry, this.playerMaterial);
  private currentAnimationIndex: number = 0;
  private displayInfo: DBC | null = null;

  public rotateSpeed: number = 2;
  public moveSpeed: number = 10;
  public gravity: number = 10; //10;
  public jumpVelocityConst: number = 16;
  public jumpVelocity: number = 0;
  public isFly: boolean = false;
  public isMoving: boolean = false;
  public _isJump: boolean = false;
  public isCollides: boolean = false;
  public groundDistance: number = 0;
  private previousGroundDistance: number = 0;
  private groundZeroConstant: number = 1; // точка с которой будет считаться что мы на земле
  private _groundFollowConstant: number = 1; // точка с которой нужно начинать следовать рельефу
  private groundDistanceRaycaster: THREE.Raycaster = new THREE.Raycaster();
  private prevPosition: THREE.Vector3 = new THREE.Vector3();

  public moving = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false
  }

  public jumpMoving = {
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false
  }

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
    this.collider.name = 'Collider';

    this.groundDistanceRaycaster.set(this.position, this.view.position);

    this.arrow.setDirection(this.groundDistanceRaycaster.ray.direction);

    // Animation
    this.currentAnimationIndex = 0;
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
      this.setAnimation(15, true, 0);
    } else {
      this.setAnimation(16, true, 0);
    }
  }
  get position(): THREE.Vector3 {
    return this._view.position;
  }

  get displayId(): number {
    return this._displayId;
  }

  set displayId(displayId) {
    if (!displayId) {
      return;
    }

    DBC.load('CreatureDisplayInfo', displayId).then((displayInfo: DBC) => {
      this._displayId = displayId;
      this.displayInfo = displayInfo;
      const modelID = displayInfo.modelID;
      DBC.load('CreatureModelData', modelID).then((modelData: DBC) => {
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

  updatePlayerColliderBox() {
    const { max, min } = this.model!.geometry.boundingBox;
    this.collider.position.set(
      this.position.x,
      this.position.y,
      this.position.z + (max.z - min.z) / 2
    );
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

    this.emit('model:change', this, this._model, m2);
    this._model = m2;
  }

  setAnimation(index: number, inrerrupt: boolean = false, repetitions: number = Infinity) {
    if (!this.model.animations.currentAnimation.isRunning()
      || inrerrupt
      || this.currentAnimationIndex !== index) {
      this.model.animations.stopAnimation(this.currentAnimationIndex);
      this.currentAnimationIndex = index;
      return this.model.animations.playAnimation(index, repetitions);
    }
  }

  stopAnimation(index?: number) {
    this.model.animations.stopAnimation(index || this.currentAnimationIndex);
  }

  jump() {
    if (this.isOnGround && !this.isJump) {
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
      this.translatePosition({ z: this.moveSpeed * this.gravity * delta });
    }
  }

  descend(delta: number) {
    if (this.isFly) {
      this.translatePosition({ z: -this.moveSpeed * this.gravity * delta });
    }
  }

  moveForward(delta: number) {
    if (this.isJump) return;
    if (this.isOnGround) {
      this.setAnimation(2);
    }
    this.moving.forward = true;
    this.translatePosition({ x: this.moveSpeed * delta });
  }

  moveBackward(delta: number) {
    if (this.isJump) return;
    this.moving.backward = true;
    this.setAnimation(133);
    this.translatePosition({ x: -this.moveSpeed * delta / 2 });
  }


  rotateLeft(delta: number) {
    if (!this.isMoving) {
      this.setAnimation(38);
    }
    this.view.rotateZ(this.rotateSpeed * delta);
  }

  rotateRight(delta: number) {
    if (!this.isMoving) {
      this.setAnimation(38);
    }
    this.view.rotateZ(-this.rotateSpeed * delta);
  }

  strafeLeft(delta: number) {
    if (this.isJump) return;
    this.moving.strafeLeft = true;
    this.translatePosition({ y: this.moveSpeed * delta });
  }

  strafeRight(delta: number) {
    if (this.isJump) return;
    this.moving.strafeRight = true;
    this.translatePosition({ y: -this.moveSpeed * delta });
  }

  strafeUp(delta: number) {
    if (!this.isJump) {
      this.translatePosition({ z: this.gravity * delta });
    }
  }

  strafeDown(delta: number) {
    this.translatePosition({ z: -this.gravity * delta });
  }

  translatePosition(vector: { x?: number, y?: number, z?: number }) {
    this.changePosition(vector, true);
  }

  updateIsMovingFlag(newCoords: THREE.Vector3) {
    const coords = this.view.position;
    if (newCoords.x !== coords.x || newCoords.y !== coords.y || newCoords.z !== coords.z) {
      this.isMoving = true;
    } else {
      this.isMoving = false;
    }
  }

  beforePositionChange(newCoords: THREE.Vector3) {
    this.prevPosition = this.position.clone();
    this.updateGroundDistance(newCoords);

    this.updateIsMovingFlag(newCoords);
    this.updatePlayerColliderBox();
  }

  afterPositionChange() {

  }

  changePosition(vector: { x?: number, y?: number, z?: number }, translate: boolean) {
    // Считаем то,как изменится позиция после проведения операции
    let newCoords: THREE.Vector3 = new THREE.Vector3();
    if (translate) {
      // eslint-disable-next-line no-param-reassign
      newCoords.set(
        vector.x ? vector.x + this.view.position.x : this.view.position.x,
        vector.y ? vector.y + this.view.position.y : this.view.position.y,
        vector.z ? vector.z + this.view.position.z : this.view.position.z
      );
    } else {
      newCoords.set(
        vector.x ? vector.x : this.view.position.x,
        vector.y ? vector.y : this.view.position.y,
        vector.z ? vector.z : this.view.position.z
      );
    }

    this.beforePositionChange(newCoords);

    if (vector) {

      if (translate) {
        if (vector.x && newCoords.x !== this.view.position.x) this.view.translateX(vector.x);
        if (vector.y && newCoords.y !== this.view.position.y) this.view.translateY(vector.y);
        if (vector.z && newCoords.z !== this.view.position.z) this.view.translateZ(vector.z);
      } else {
        const builtVector = {
          x: vector.x ? vector.x : this.view.position.x,
          y: vector.y ? vector.y : this.view.position.y,
          z: vector.z ? vector.z : this.view.position.z
        };
        this.view.position.set(builtVector.x, builtVector.y, builtVector.z);
      }
    }


    this.afterPositionChange();

    if (!this.prevPosition.equals(this.position)) {
      this.emit('position:change', this.position);
    }
  }

  updateGroundDistance(newPosition: THREE.Vector3) {
    this.previousGroundDistance = this.groundDistance;
    const newZ = newPosition.z + this._groundFollowConstant - 0.1;
    this.groundDistanceRaycaster.set(
      new THREE.Vector3(newPosition.x, newPosition.y, newZ),
      new THREE.Vector3(0, 0, -1)
    );
    this.arrow.setDirection(this.groundDistanceRaycaster.ray.direction);
    this.arrow.position.set(newPosition.x, newPosition.y, newZ);

    // intersect with all scene meshes.
    const intersects = this.groundDistanceRaycaster.intersectObjects(Array.from(ColliderManager.collidableMeshList.values()) as THREE.Object3D[]);
    if (intersects.length > 0) {
      this.groundDistance = intersects[0].distance;
    }
  }

  clear() {
    this.moving.forward = false;
    this.moving.backward = false;
    this.moving.strafeLeft = false;
    this.moving.strafeRight = false;

    if (!this.isJump) {
      this.jumpMoving.forward = false;
      this.jumpMoving.backward = false;
      this.jumpMoving.strafeLeft = false;
      this.jumpMoving.strafeRight = false;
    }
  }

  update(delta: number) {
    // this.isMoving = false;
    // this.setAnimation(0);
    this.updateGravity(delta);
    this.clear();
  }

  // isCollide() {
  //   const meshList = Array.from(ColliderManager.collidableMeshList.values()) as THREE.Object3D[];
  //   const colligerGeometry = this.collider.geometry as THREE.Geometry;
  //   let isCollide = false;
  //   this.isCollides = false;
  //   if (this.model) {
  //     const originPoint = this.collider.position.clone();
  //     colligerGeometry.vertices.forEach((vertex) => {
  //       const localVertex = vertex.clone();
  //       const globalVertex = localVertex.applyMatrix4(this.collider.matrix);
  //       const directionVector = globalVertex.sub(this.collider.position);

  //       const ray = new THREE.Raycaster(originPoint, directionVector.clone().normalize());
  //       const collisionResults = ray.intersectObjects(meshList);
  //       if (collisionResults.length > 0 &&
  //         collisionResults[0].distance < directionVector.length()
  //       ) {
  //         isCollide = true;
  //         this.isCollides = true;
  //       }
  //     });
  //   }

  //   return isCollide;
  // }

  // updateCollider(meshList) {
  //   this.isCollide(meshList);
  // }

  // Обеспецивает хождение по земле
  updateGroundFollow(delta: number) {
    const diff = this._groundFollowConstant - this.groundDistance;
    this.translatePosition({ z: diff - 0.1 });
  }

  updateGravity(delta: number) {
    if (this.isFly) return;

    const animationSpeed = 1.6;
    if (this.isJump) {
      let x = 0;
      let y = 0;
      if (this.jumpMoving.forward) x = this.moveSpeed * delta;
      if (this.jumpMoving.backward) x = -this.moveSpeed * delta;
      if (this.jumpMoving.strafeLeft) y = this.moveSpeed * delta;
      if (this.jumpMoving.strafeRight) y = -this.moveSpeed * delta;
      this.translatePosition({
        x,
        y,
        z: (this.jumpVelocity - this.gravity) * delta * animationSpeed
      });

      if (this.isOnGround) {
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
