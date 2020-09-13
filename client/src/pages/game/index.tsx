import React from 'react';
// import { THREE } from 'enable3d';
import { THREE } from 'enable3d';
import './index.scss';
import Game from '../../game';
import Controls from './controls/controls';
import DebugPanel from './debug/debug';
import Stats from 'stats-js';
interface IGameProps {}
interface IGameScreenState {
  renderer: THREE.WebGLRenderer | null;
  game: Game | null;
}


class GameScreen extends React.Component {
  private camera: THREE.PerspectiveCamera;
  public debugCamera: THREE.PerspectiveCamera;
  public cameraHelper: THREE.CameraHelper;
  private prevCameraRotation: THREE.Quaternion | null = null;
  private prevCameraPosition: THREE.Vector3 | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private debugRenderer: THREE.WebGLRenderer | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private game: Game = new Game();
  private debug = true;
  //refs
  private controls = React.createRef<Controls>()
  private debugPanel = React.createRef<DebugPanel>()
  private stats: any = new Stats();

  public state: IGameScreenState = {
    renderer: null,
    game: null
  }

  constructor(props: IGameProps) {
    super(props);

    document.body.appendChild(this.stats.dom);
    this.stats.showPanel(0);
    this.camera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 500);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(15, 0, 7);

    this.cameraHelper = new THREE.CameraHelper( this.camera );
    this.game.world.scene.add(this.cameraHelper);
    this.debugCamera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 500);
    this.debugCamera.up.set(0, 0, 1);
    this.debugCamera.position.set(15, 0, 7);
  }
  
  componentDidMount() {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
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
    
    this.callFrame();

    window.addEventListener('resize', this.resize.bind(this));
  }

  callFrame() {
    this.animate();
    this.forceUpdate();
    window.requestAnimationFrame(this.callFrame.bind(this));
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
    this.stats.begin();
    if (!this.renderer) {
      return;
    }

    const delta = this.clock.getDelta();
    if (this.debugPanel.current){
      this.debugPanel.current.forceUpdate();
    }
    
    const cameraMoved: boolean =
    this.prevCameraRotation === null ||
    this.prevCameraPosition === null ||
    !this.prevCameraRotation.equals(this.camera.quaternion) ||
    !this.prevCameraPosition.equals(this.camera.position);
    this.game.world.animate(delta, this.camera, cameraMoved);
    this.renderer.render(this.game.world.scene, this.camera);
      if (this.debugRenderer) {
        this.debugCamera.position.set(this.camera.position.x, 
          this.camera.position.y, 
          this.camera.position.z + 120)
          this.debugRenderer.render(this.game.world.scene, this.debugCamera);
      }
      
      this.prevCameraRotation = this.camera.quaternion.clone();
      this.prevCameraPosition = this.camera.position.clone();
      if (this.controls.current) {
        this.controls.current.update(delta);
      }
      this.stats.end();
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
          <Controls ref={this.controls} player={this.game.world.player} camera={this.camera} />
          <DebugPanel ref="debugPanel" renderer={renderer} game={this.game}></DebugPanel>
      </div>
    );
  }
}

export default GameScreen;
