import { Scene3D, THREE, ThirdPersonControls, ExtendedObject3D } from 'enable3d'
import Phaser from 'phaser';
import Player from '../../classes/player';
import { PointerLock, PointerDrag } from 'enable3d';
import key from 'keymaster';
import WorldMap from '../map';
import Unit from '../../classes/unit';
import M2Blueprint from '../../pipeline/m2/blueprint';
import spots from "../spots";
import ColliderManager, { ColliderManagerSubType } from '../collider-manager';
enum Key {
  space = 32,
  W = 87,
  A = 65,
  S = 83,
  D = 68,
  Q = 81,
  E = 69,
  R = 82,
  T = 84
}

export default class MainScene extends Scene3D {
  // private box:
  public controls: ThirdPersonControls | null = null;
  public keys: { [key: string]: Phaser.Input.Keyboard.Key } | null = null;
  public playerPhysicsObject: ExtendedObject3D | null = null;

  private move: boolean = false;
  private canJump: boolean = true;
  private isJumping: boolean = false;
  private moveTop: number = 0;
  private moveRight: number = 0;

  private player: Player;

  private rotateStart: THREE.Vector2 = new THREE.Vector2();
  private rotateEnd: THREE.Vector2 = new THREE.Vector2();
  private rotateDelta: THREE.Vector2 = new THREE.Vector2();
  private rotating: boolean = false;
  private rotateSpeed: number = 1.0;
  private offset: THREE.Vector3 = new THREE.Vector3(-10, 0, 10);
  private target: THREE.Vector3 = new THREE.Vector3();

  private phiDelta: number = 0;
  private thetaDelta: number = 0;
  // Vertical orbit limits
  private minPhi: number = 0;
  private maxPhi: number = Math.PI * 0.45;

  private scale: number = 1;
  private zoomSpeed: number = 1.0;
  private zoomScale: number = Math.pow(0.95, this.zoomSpeed);
  // Zoom distance limits
  private minDistance: number = 0;
  private maxDistance: number = 500;

  private quat: THREE.Quaternion | null = null;
  private quatInverse: THREE.Quaternion | null = null;

  private EPS: number = 0.000001;

  private isRun: boolean = false;

  public entities: Map<string, Unit> = new Map();
  public map: WorldMap | null = null;

  constructor() {
    super({ key: 'MainScene' });

    this.player = new Player("-1", "TestName");
    this.entities.set(this.player.guid, this.player);
    this.player.on("model:change", this.changeModel.bind(this));
    this.player.on("map:change", this.changeMap.bind(this));
    this.player.on("position:change", this.changePosition.bind(this));
  }

  renderAtCoords(x: number, y: number) {
    if (!this.map) {
      return;
    }

    this.map.render(x, y);
  }

  changeMap(mapId: number) {
    console.log("Load map", mapId);
    WorldMap.load(mapId).then((map: WorldMap) => {
      if (this.map) {
        this.scene.remove(this.map);
      }
      this.map = map;
      console.log("Map loaded", this.map);
      this.add.existing(this.map);
      this.physics.add.existing(this.map.exterior, { mass: 0, collisionFlags: 1, addChildren: true });
      this.renderAtCoords(this.player.position.x, this.player.position.y);
      this.player.emit("map:changed", this.map);
    });
  }

  changeModel(_unit: Unit, _oldModel: Unit, _newModel: Unit) {
    console.log("Model change", _unit, _oldModel, _newModel);
  }

  changePosition(position: THREE.Vector3, _rotation: THREE.Vector3) {
    this.renderAtCoords(position.x, position.y);
    // this.skybox.position.set(position.x, position.y, 100)
  }

  animate(
    delta: number,
    camera: THREE.PerspectiveCamera,
    cameraMoved: boolean
  ) {
    this.animateEntities(delta, camera, cameraMoved);

    if (this.map !== null) {
      if (cameraMoved) {
        this.map.locateCamera(camera);
        this.map.updateVisibility(camera);
      }
      // this.map.updateWorldTime(camera, this.map.mapID);
      this.map.animate(delta, camera, cameraMoved);
    }

    // Send delta updates to instanced M2 animation managers.
    M2Blueprint.animate(delta);
  }

  animateEntities(
    delta: number,
    camera: THREE.PerspectiveCamera,
    cameraMoved: boolean
  ) {
    this.entities.forEach(entity => {
      const { model } = entity;

      if (model === null || !model.animated) {
        return;
      }

      entity.update(delta);

      if (model.receivesAnimationUpdates && model.animations.length > 0) {
        model.animations.update(delta);
      }

      if (cameraMoved && model.billboards.length > 0) {
        model.applyBillboards(camera);
      }

      if (model.skeletonHelper) {
        model.skeletonHelper.update();
      }
    });
  }

  async init() {
    // this.accessThirdDimension();
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  async preload() {
    // preload your assets here
  }

  async create() {
    // set up scene (light, ground, grid, sky, orbitControls)
    this.warpSpeed('light', 'ground', 'grid', 'sky', 'orbitControls')

    this.canvas.addEventListener('mousedown', this._onMouseDown.bind(this));
    this.canvas.addEventListener('mouseup', this._onMouseUp.bind(this));
    this.canvas.addEventListener('mousemove', this._onMouseMove.bind(this));
    this.canvas.addEventListener('mousewheel', this._onMouseWheel.bind(this));
    this.canvas.addEventListener('keydown', this._onKeyDown.bind(this));
    this.canvas.addEventListener('keyup', this._onKeyUp.bind(this));

    // this.element.addEventListener('touchstart', this._onTouchStart.bind(this));
    // this.element.addEventListener('touchend', this._onTouchEnd.bind(this));
    // this.element.addEventListener('touchmove', this._onTouchMove.bind(this));

    // Firefox scroll-wheel support
    this.canvas.addEventListener('DOMMouseScroll', this._onMouseWheel.bind(this));

    this.canvas.addEventListener('contextmenu', this._onContextMenu.bind(this), false);

    // position camera
    this.camera.position.set(15, 0, 7)

    this.quat = new THREE.Quaternion().setFromUnitVectors(
      this.camera.up, new THREE.Vector3(0, 1, 0)
    );

    this.quatInverse = this.quat.clone().inverse();

    // blue box (without physics)
    // this.add.box({ y: 2 }, { lambert: { color: 'deepskyblue' } });
    // this.playerPhysicsObject = new ExtendedObject3D();
    // this.playerPhysicsObject.add(this.player.view);


    const loadedSpot = null//localStorage.getItem("debugCoords");
    if (loadedSpot) {
      const spot: any = JSON.parse(loadedSpot);
      // "{"zoneId":1,"coords":[-3685.162399035418,-4526.337356788462,16.28410000000111]}"
      this.player.worldport(spot.zoneId, spot.coords);
      this.player.rotation.set(
        spot.rotation[0],
        spot.rotation[1],
        spot.rotation[2]
      );
    } else {
      // const spot: any = spots[spots.length - 2]
      const spot: any = spots.find(x => x.id === "dun murog")
      // const spot: any = spots.find(x => x.id === 2)
      // const spot: any = spots.find(x => x.id === "stormwind")
      // const spot: any = spots.find(x => x.id === "ogrimar")
      // const spot: any = spots.find(x => x.id === "daggercap_bay");
      // const spot: any = spots.find(x => x.id === "north_bay");
      // const spot: any = spots.find(x => x.id === "naxramas");
      // const spot: any = spots.find(x => x.id === "dalaran");
      this.player.worldport(spot.zoneId, spot.coords);
      // this.physics.add.box({ x: spot.coords[0], y: spot.coords[1], z: spot.coords[2] - 5 }, { lambert: { color: 'deepskyblue' } });
    }

    /**
     * Add the player to the scene with a body
     */
    this.add.existing(this.player.view)
    this.physics.add.existing(this.player.view, {
      autoCenter: false,
      shape: 'sphere',
      radius: 1,
      width: 1,
      mass: 20,
      collisionFlags: 1
    })
    this.player.view.body.setFriction(0);
    this.player.view.body.setAngularFactor(1, 1, 1);
    this.player.view.body.setCcdMotionThreshold(1e-7)
    this.player.view.body.setCcdSweptSphereRadius(0.25)

    // this.player.view.body.on.collision((otherObject, event) => {
    //   console.log(otherObject, event)
    //   if (otherObject.name !== 'ground') console.log(`blueBox and ${otherObject.name}: ${event}`)
    // })
    console.log(ColliderManager)
    const sub = ColliderManager.subscribe(ColliderManagerSubType.add, (object: ExtendedObject3D) => {
      console.log('here')
      this.physics.add.existing(object, { shape: 'concave', collisionFlags: 1, mass: 0 });
      object.body.setAngularFactor(0, 0, 0)
      object.body.setLinearFactor(0, 0, 0)
    })
    console.log(this)
  }

  update(delta: number) {
    if (!this.player) return;
    const unit = this.player;
    const speed = 5;
    unit.update(delta);
    // this.playerPhysicsObject?.body.applyForceY(2);
    if (unit) {
      // if (key.isPressed('space')) {
      //   unit.jump();
      // }
      const keys = {
        forward: key.isPressed('up') || key.isPressed('w'),
        backward: key.isPressed('down') || key.isPressed('s'),
        strafeLeft: key.isPressed('q'),
        strafeRight: key.isPressed('e')

      }
      if (key.isPressed('f')) {
        unit.isFly = !unit.isFly;
      }

      if (!keys.forward && !keys.backward) {
        this.player.view.body.setVelocityX(0);
      }
      if (!keys.strafeLeft && !keys.strafeRight) {
        this.player.view.body.setVelocityY(0);
      }

      if (keys.forward || this.isRun) {
        // unit.moveForward(delta);
        this.player.view.body.setVelocityX(speed);
      }

      if (keys.backward) {
        // unit.moveBackward(delta);
        this.player.view.body.setVelocityX(-speed);
      }

      if (keys.strafeLeft) {
        // unit.strafeLeft(delta);
        this.player.view.body.setVelocityY(speed);
      }

      if (keys.strafeRight) {
        // unit.strafeRight(delta);
        this.player.view.body.setVelocityY(-speed);
      }

      if (key.isPressed('space')) {
        // unit.ascend(delta);
        this.player.view.body.setVelocityZ(speed)
      }

      if (key.isPressed('x')) {
        // unit.descend(delta);
        this.player.view.body.setVelocityZ(-speed)
      }

      if (key.isPressed('left') || key.isPressed('a')) {
        // unit.rotateLeft(delta);
        // this.player.view.body.applyForceY(speed);
      }

      if (key.isPressed('right') || key.isPressed('d')) {
        unit.rotateRight(delta);
        // this.player.view.body.applyForceY(-speed);
      }

      this.target = unit.position;
    }

    const position = this.camera.position;

    // Rotate offset to "y-axis-is-up" space
    this.offset.applyQuaternion(this.quat!);

    // Angle from z-axis around y-axis
    let theta = Math.atan2(this.offset.x, this.offset.z);

    // Angle from y-axis
    let phi = Math.atan2(
      Math.sqrt(this.offset.x * this.offset.x + this.offset.z * this.offset.z),
      this.offset.y
    );

    theta += this.thetaDelta;
    phi += this.phiDelta;

    // Limit vertical orbit
    phi = Math.max(this.minPhi, Math.min(this.maxPhi, phi));
    phi = Math.max(this.EPS, Math.min(Math.PI - this.EPS, phi));

    let radius = this.offset.length() * this.scale;

    // Limit zoom distance
    radius = Math.max(this.minDistance, Math.min(this.maxDistance, radius));

    this.offset.x = radius * Math.sin(phi) * Math.sin(theta);
    this.offset.y = radius * Math.cos(phi);
    this.offset.z = radius * Math.sin(phi) * Math.cos(theta);

    // Rotate offset back to 'camera-up-vector-is-up' space
    this.offset.applyQuaternion(this.quatInverse!);

    position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    this.thetaDelta = 0;
    this.phiDelta = 0;
    this.scale = 1;


    if (this.keys && this.playerPhysicsObject && this.playerPhysicsObject.body) {
      /**
       * Update Controls
       */
      // this.controls.update(this.moveRight * 3, -this.moveTop * 3)
      // this.moveRight = this.moveTop = 0
      /**
       * Player Turn
       */
      // const speed = 5
      // const v3 = new THREE.Vector3()

      // const rotation = this.third.camera.getWorldDirection(v3)
      // const theta = Math.atan2(rotation.x, rotation.z)
      // const rotationMan = this.player.getWorldDirection(v3)
      // const thetaMan = Math.atan2(rotationMan.x, rotationMan.z)

      // const l = Math.abs(theta - thetaMan)
      // if (theta > thetaMan && l > 0.05) this.player.body.setAngularVelocityY(2)
      // else if (theta < thetaMan && l > 0.05) this.player.body.setAngularVelocityY(-2)
      // else this.player.body.setAngularVelocityY(0)

      // /**
      //  * Player Move
      //  */
      // if (this.keys.w.isDown || this.move) {
      //   // if (this.player.animation.current === 'idle' && !this.isJumping) this.player.animation.play('run')

      //   const x = Math.sin(theta) * speed,
      //     y = this.player.body.velocity.y,
      //     z = Math.cos(theta) * speed

      //   this.player.body.setVelocity(x, y, z)
      // } else {
      //   // if (this.player.animation.current === 'run' && !this.isJumping) this.player.animation.play('idle')
      // }

      /**
       * Player Jump
       */
      if (this.keys.space.isDown && this.canJump) {
        this.jump()
      }
    }
  }

  jump() {
    if (!this.playerPhysicsObject) return

    this.canJump = false
    this.isJumping = true
    // this.playerPhysicsObject.animation.play('jump_running')
    // this.time.addEvent({
    //   delay: 750,
    //   callback: () => (this.canJump = true)
    // })
    // this.time.addEvent({
    //   delay: 750,
    //   callback: () => {
    //     this.isJumping = false
    //   }
    // })
    this.player.view.body.applyForceZ(4)
  }

  _onKeyDown(event: KeyboardEvent) {
    if (event.keyCode === Key.T) {
      const p = this.player.position;
      const r = this.player.rotation;
      localStorage.setItem('debugCoords', JSON.stringify({
        zoneId: this.player.mapId,
        coords: [p.x, p.y, p.z],
        rotation: [r.x, r.y, r.z]
      }));

      alert("Coords saved successfully")
    }

    if (event.keyCode === Key.R) {
      const spot = JSON.parse(localStorage.getItem('debugCoords') || "");
      if (spot) {
        this.player.worldport(spot.zoneId, spot.coords);
        this.player.rotation.set(spot.rotation[0], spot.rotation[1], spot.rotation[2])
      }
      console.log('Coords has been restored')
    }

    if (this.player) {
      if (event.keyCode === Key.space) {
        this.player.jump();
      }
    }
  }

  _onKeyUp(event: KeyboardEvent) {
    if (this.player) {
      if (event.keyCode !== Key.space) {
        // unit.stopAnimation();
      }
    }
  }

  _onContextMenu(event: Event) {
    event.preventDefault();
    return false;
  }

  rotateHorizontally(angle: number) {
    this.thetaDelta -= angle;
  }

  rotateVertically(angle: number) {
    this.phiDelta -= angle;
  }

  zoomOut() {
    this.scale /= this.zoomScale;
  }

  zoomIn() {
    this.scale *= this.zoomScale;
  }

  _onTouchStart(event: TouchEvent) {
    this.rotating = true;
    this.rotateStart.set(event.touches[0].clientX, event.touches[0].clientY);
  }

  _onTouchEnd() {
    this.rotating = false;
  }

  _onTouchMove(event: TouchEvent) {
    if (this.rotating) {
      event.preventDefault();

      this.rotateEnd.set(event.touches[0].clientX, event.touches[0].clientY);
      this.rotateDelta.subVectors(this.rotateEnd, this.rotateStart);

      this.rotateHorizontally(
        2 * Math.PI * this.rotateDelta.x / window.innerWidth * this.rotateSpeed
      );

      if (event.touches.length === 1) {
        this.player.view.rotateZ(this.thetaDelta);
      }

      this.rotateVertically(
        2 * Math.PI * this.rotateDelta.y / window.innerHeight * this.rotateSpeed
      );

      this.rotateStart.copy(this.rotateEnd);
    }
  }

  _onMouseDown(event: MouseEvent) {
    this.rotating = true;
    this.rotateStart.set(event.clientX, event.clientY);

    if (event.which === 3) {
      // this.unit.view.rotation.z = this.camera.getWorldDirection().z;
    }

  }

  _onMouseUp() {
    this.rotating = false;
  }

  _onMouseMove(event: MouseEvent) {
    if (this.rotating) {
      // console.log("Here", event)
      event.preventDefault();

      this.rotateEnd.set(event.clientX, event.clientY);
      this.rotateDelta.subVectors(this.rotateEnd, this.rotateStart);

      this.rotateHorizontally(
        2 * Math.PI * this.rotateDelta.x / window.innerWidth * this.rotateSpeed
      );

      console.log(event.which)
      if (event.which === 3) {
        this.player.view.rotateZ(this.thetaDelta);
        // let temp = (this.camera.rotation.x * this.camera.rotation.y);
        // console.log(temp);
        // if (temp < 0.5 && temp > 0) {
        //   this.unit.view.rotation.z = this.camera.rotation.x * this.camera.rotation.y - Math.PI/2;
        // }
      }

      this.rotateVertically(
        0.1 * Math.PI * this.rotateDelta.y / window.innerHeight * this.rotateSpeed
      );

      this.rotateStart.copy(this.rotateEnd);
    }
  }

  _onMouseWheel(event: MouseWheelEvent | any) {
    event.preventDefault();
    event.stopPropagation();

    const delta = event.deltaY || -event.detail;
    if (delta > 0) {
      this.zoomIn();
    } else if (delta < 0) {
      this.zoomOut();
    }
  }
  get aspectRatio() {
    return window.innerWidth / window.innerHeight;
  }
}