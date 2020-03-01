import React from 'react';
import * as THREE from 'three';
import key from 'keymaster';
import Player from '../../../game/classes/player';


// const joyOptions = {
//   mode: 'semi',
//   catchDistance: 150,
//   color: 'white'
// };

// const containerStyle = {
//   position: 'fixed',
//   height: '50%',
//   width: '20%',
//   bottom: 0,
//   left: 0,
//   zIndex: 10,
//   background: 'transparent'
// };

enum Key {
  space = 32,
  W = 87,
  A = 65,
  D = 68,
  S = 83,
  Q = 81,
  E = 69,
  R = 82,
  T = 84
}

interface IProp {
  camera: THREE.PerspectiveCamera,
  player: Player
}

interface IUpdate {
  update(): void;
}

class Controls extends React.Component<IProp, IUpdate> {

  private element: HTMLElement = document.body;
  private unit: Player;
  private camera: THREE.PerspectiveCamera;

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

  private quat: THREE.Quaternion
  private quatInverse: THREE.Quaternion

  private EPS: number = 0.000001;

  private isRun: boolean = false;

  constructor(props: IProp) {
    super(props);

    this.unit = props.player;
    this.camera = props.camera;
    console.log('Camera', this.camera);
    // Based on THREE's OrbitControls
    // See: http://threejs.org/examples/js/controls/OrbitControls.js

    this.quat = new THREE.Quaternion().setFromUnitVectors(
      this.camera.up, new THREE.Vector3(0, 1, 0)
    );

    this.quatInverse = this.quat.clone().inverse();

    this.element.addEventListener('mousedown', this._onMouseDown.bind(this));
    this.element.addEventListener('mouseup', this._onMouseUp.bind(this));
    this.element.addEventListener('mousemove', this._onMouseMove.bind(this));
    this.element.addEventListener('mousewheel', this._onMouseWheel.bind(this));
    document.addEventListener('keydown', this._onKeyDown.bind(this));
    document.addEventListener('keyup', this._onKeyUp.bind(this));
    
    // this.element.addEventListener('touchstart', this._onTouchStart.bind(this));
    // this.element.addEventListener('touchend', this._onTouchEnd.bind(this));
    // this.element.addEventListener('touchmove', this._onTouchMove.bind(this));

    // Firefox scroll-wheel support
    this.element.addEventListener('DOMMouseScroll', this._onMouseWheel.bind(this));
    
    this.element.addEventListener('contextmenu', this._onContextMenu.bind(this), false);
    
  }
  
  componentWillUnmount() {
    this.element.removeEventListener('mousedown', this._onMouseDown.bind(this));
    this.element.removeEventListener('mouseup', this._onMouseUp.bind(this));
    this.element.removeEventListener('mousemove', this._onMouseMove.bind(this));
    this.element.removeEventListener('mousewheel', this._onMouseWheel.bind(this));
    this.element.removeEventListener('DOMMouseScroll', this._onMouseWheel.bind(this));
    document.removeEventListener('keydown', this._onKeyDown.bind(this));
    document.removeEventListener('keyup', this._onKeyUp.bind(this));
    
    // this.element.removeEventListener('touchstart', this._onTouchDown.bind(this));
    // this.element.removeEventListener('touchend', this._onTouchEnd.bind(this));
    // this.element.removeEventListener('touchmove', this._onTouchMove.bind(this));

    this.element.removeEventListener('contextmenu', this._onContextMenu.bind(this));

    this.isRun = false;
  }

  _onKeyDown(event: KeyboardEvent) {
    if (event.keyCode === Key.T) {
      const p = this.unit.position;
      localStorage.setItem('debugCoords', JSON.stringify({
        zoneId: this.unit.mapId,
        coords: [p.x, p.y, p.z]
      }));

      alert("Coords saved successfully")
    }

    if (event.keyCode === Key.R) {
      const spot = JSON.parse(localStorage.getItem('debugCoords') || "");
      if (spot) {
        this.unit.worldport(spot.zoneId, spot.coords);
      }
      console.log('Coords has been restored')
    }

    const unit = this.unit;
    if (unit) {
      if (event.keyCode === Key.space) {
        unit.jump();
      }
    }
  }

  _onKeyUp(event: KeyboardEvent) {
    const unit = this.unit;
    if (unit && unit) {
      if (event.keyCode !== Key.space) {
        unit.stopAnimation();
      }
    }
  }

  _onContextMenu(event: Event) {
    event.preventDefault();
    return false;
  }

  // managerListener(manager) {
  //   manager.on('move', (e, stick) => {
  //     // console.log('I moved!')
  //     this.isRun = true;
  //   })
  //   manager.on('end', () => {
  //     // console.log('I ended!')
  //     this.isRun = false;
  //   })
  // }

  public update(delta: number) {
    const unit = this.unit;

    if (this.unit) {
      // if (key.isPressed('space')) {
      //   unit.jump();
      // }

      if (key.isPressed('up') || key.isPressed('w') || this.isRun) {
        unit.moveForward(delta);
      }

      if (key.isPressed('down') || key.isPressed('s')) {
        unit.moveBackward(delta);
      }

      if (key.isPressed('q')) {
        unit.strafeLeft(delta);
      }

      if (key.isPressed('e')) {
        unit.strafeRight(delta);
      }

      if (key.isPressed('space')) {
        unit.ascend(delta);
      }

      if (key.isPressed('x')) {
        unit.descend(delta);
      }

      if (key.isPressed('left') || key.isPressed('a')) {
        unit.rotateLeft(delta);
      }

      if (key.isPressed('right') || key.isPressed('d')) {
        unit.rotateRight(delta);
      }
      
      this.target = this.unit.position;
    }

    const position = this.camera.position;

    // Rotate offset to "y-axis-is-up" space
    this.offset.applyQuaternion(this.quat);

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
    this.offset.applyQuaternion(this.quatInverse);

    position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);

    this.thetaDelta = 0;
    this.phiDelta = 0;
    this.scale = 1;
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
        2 * Math.PI * this.rotateDelta.x / this.element.clientWidth * this.rotateSpeed
      );
      
      if (event.touches.length === 1) {
        this.unit.view.rotateZ(this.thetaDelta);
      }

      this.rotateVertically(
        2 * Math.PI * this.rotateDelta.y / this.element.clientHeight * this.rotateSpeed
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
        2 * Math.PI * this.rotateDelta.x / this.element.clientWidth * this.rotateSpeed
      );
      
      if (event.which === 3) {
        this.unit.view.rotateZ(this.thetaDelta);
        // let temp = (this.camera.rotation.x * this.camera.rotation.y);
        // console.log(temp);
        // if (temp < 0.5 && temp > 0) {
        //   this.unit.view.rotation.z = this.camera.rotation.x * this.camera.rotation.y - Math.PI/2;
        // }
      }

      this.rotateVertically(
        0.1 * Math.PI * this.rotateDelta.y / this.element.clientHeight * this.rotateSpeed
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

  render() {
    return (
      <div className="controls">
        {/* <JoyStick joyOptions={joyOptions} containerStyle={containerStyle} managerListener={this.managerListener} /> */}
      </div>
    );
  }

}

export default Controls;
