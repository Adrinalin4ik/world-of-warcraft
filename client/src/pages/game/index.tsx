import React from 'react';
import * as THREE from 'three';

import './index.scss';
import Game from '../../game';
import Controls from './controls/controls';
interface IGameProps {

}

interface IUpdate {
  update(): void;
}

class GameScreen extends React.Component {
  private camera: THREE.PerspectiveCamera;
  public debugCamera: THREE.PerspectiveCamera;
  private prevCameraRotation: THREE.Quaternion | null = null;
  private prevCameraPosition: THREE.Vector3 | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private game: Game = new Game();

  //refs
  private controls = React.createRef<Controls>()

  constructor(props: IGameProps) {
    super(props);

    this.camera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(15, 0, 7);

    this.debugCamera = new THREE.PerspectiveCamera(60, 100, 2, 1000);
    this.debugCamera.up.set(0, 0, 1);
    this.debugCamera.position.set(15, 0, 7);
  }
  
  componentDidMount() {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      canvas: this.refs.canvas as HTMLCanvasElement
    });
    console.log(this)
    this.forceUpdate();
    this.resize();

    setInterval(() => {
      this.animate();
    }, 1000/30);

    window.addEventListener('resize', this.resize.bind(this));
  }

  get aspectRatio() {
    return window.innerWidth / window.innerHeight;
  }

  resize() {
    if (this.renderer) {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = this.aspectRatio;
      this.camera.updateProjectionMatrix();
    }
  }

  animate() {
    if (!this.renderer) {
      return;
    }

    this.controls.current!.update();
    
    const cameraMoved: boolean =
      this.prevCameraRotation === null ||
      this.prevCameraPosition === null ||
      !this.prevCameraRotation.equals(this.camera.quaternion) ||
      !this.prevCameraPosition.equals(this.camera.position);
    this.game.world.animate(this.clock.getDelta(), this.camera, cameraMoved);

    this.renderer.render(this.game.world.scene, this.camera);
    // this.renderer.render(this.game.world.debugScene, this.debugCamera);

    this.prevCameraRotation = this.camera.quaternion.clone();
    this.prevCameraPosition = this.camera.position.clone();
  }

  render() {
    return (
      <div className="game_screen">
          <canvas ref="canvas"></canvas>
          <Controls ref={this.controls} player={ this.game.world.player } camera={ this.camera } clock={this.clock} />
      </div>
    );
  }
}

export default GameScreen;
