import React from 'react';
import * as THREE from 'three';

import './index.scss';
import Game from '../../game';
import Controls from './controls/controls';
import DebugPanel from './debug/debug';

interface IGameProps {}
interface IGameScreenState {
  renderer: THREE.WebGLRenderer | null;
  game: Game | null;
}


class GameScreen extends React.Component {
  private camera: THREE.PerspectiveCamera;
  public debugCamera: THREE.PerspectiveCamera;
  private prevCameraRotation: THREE.Quaternion | null = null;
  private prevCameraPosition: THREE.Vector3 | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private debugRenderer: THREE.WebGLRenderer | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private game: Game = new Game();

  private debug = false;
  //refs
  private controls = React.createRef<Controls>()
  private debugPanel = React.createRef<DebugPanel>()

  public state: IGameScreenState = {
    renderer: null,
    game: null
  }

  constructor(props: IGameProps) {
    super(props);

    this.camera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 1000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(15, 0, 7);

    this.debugCamera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 1000);
    this.debugCamera.up.set(0, 0, 1);
    this.debugCamera.position.set(15, 0, 7);
  }
  
  componentDidMount() {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      canvas: this.refs.canvas as HTMLCanvasElement
    });

    this.setState({renderer: this.renderer})
    
    if (this.debug) {
      this.debugRenderer = new THREE.WebGLRenderer({
        alpha: true,
        canvas: this.refs.debugCanvas as HTMLCanvasElement
      });
    }
    console.log("componentDidMount", this)
    this.forceUpdate();
    this.resize();
    
    setInterval(() => {
      this.animate();
      this.forceUpdate();
    }, 1000/30);

    window.addEventListener('resize', this.resize.bind(this));
  }

  get aspectRatio() {
    return window.innerWidth / window.innerHeight;
  }

  resize() {
    if (this.renderer) {
      const scale = this.debug ? 2 : 1;
      this.renderer.setSize(window.innerWidth/scale, window.innerHeight/scale);
      if (this.debugRenderer) {
        this.debugRenderer.setSize(window.innerWidth/scale, window.innerHeight/scale);
      }
      this.camera.aspect = this.aspectRatio;
      this.camera.updateProjectionMatrix();
    }
  }

  animate() {
    if (!this.renderer) {
      return;
    }

    this.controls.current!.update();
    if (this.debugPanel.current){
      this.debugPanel.current.forceUpdate();
    }

    const cameraMoved: boolean =
      this.prevCameraRotation === null ||
      this.prevCameraPosition === null ||
      !this.prevCameraRotation.equals(this.camera.quaternion) ||
      !this.prevCameraPosition.equals(this.camera.position);
    this.game.world.animate(this.clock.getDelta(), this.camera, cameraMoved);

    this.renderer.render(this.game.world.scene, this.camera);
    if (this.debugRenderer) {

      this.debugCamera.position.set(this.camera.position.x + 20, 
                                    this.camera.position.y + 20, 
                                    this.camera.position.z + 100)
                                    
      this.debugRenderer.render(this.game.world.scene, this.debugCamera);
    }

    this.prevCameraRotation = this.camera.quaternion.clone();
    this.prevCameraPosition = this.camera.position.clone();
  }

  render() {
    const debugCanvas = this.debug ? 
        <canvas ref="debugCanvas" 
                className="canvas debug_canvas" 
                style={{position: this.debug ? "relative" : "absolute"}}></canvas> : null
    const { renderer } = this.state;

    return (
      <div className="game_screen">
          <canvas ref="canvas" 
                  className="canvas main_canvas" 
                  style={{position: this.debug ? "relative" : "absolute"}}></canvas>
          {debugCanvas}
          <Controls ref={this.controls} player={this.game.world.player} camera={this.camera} clock={this.clock} />
          <DebugPanel ref="debugPanel" renderer={renderer} game={this.game}></DebugPanel>
      </div>
    );
  }
}

export default GameScreen;
