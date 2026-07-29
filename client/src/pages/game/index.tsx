import * as Bowser from "bowser";
import React from 'react';
import Stats from 'stats-js';
// import * as THREE from 'three';
import { DepthPass, EffectComposer } from 'postprocessing';
import * as THREE from 'three';
import spots from '../../game/world/spots';
import { GameHandler } from '../../network/game/handler';
import { GameSession } from '../../network/session';
import Controls from './controls/controls';
import DebugPanel from './debug/debug';
import './index.scss';

interface IGameProps {
  session: GameSession;
}
interface IGameScreenState {
  renderer: THREE.WebGLRenderer | null;
  composer: EffectComposer,
  currentLocation: string | number
}


class GameScreen extends React.Component<IGameProps, IGameScreenState> {
  private camera: THREE.PerspectiveCamera;
  public debugCamera: THREE.PerspectiveCamera;
  public cameraHelper: THREE.CameraHelper;
  private prevCameraRotation: THREE.Quaternion | null = null;
  private prevCameraPosition: THREE.Vector3 | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private debugRenderer: THREE.WebGLRenderer | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private game: GameHandler;
  private debug = false;
  private debugCameraRange = 300;
  //refs
  private controls = React.createRef<Controls>()
  private debugPanel = React.createRef<DebugPanel>()
  private stats: any = new Stats();

  private isMobile: boolean = false;

  public depthPass: DepthPass;

  public state: IGameScreenState = {
    renderer: null,
    composer: null,
    currentLocation: ''
  }

  constructor(props: IGameProps) {
    super(props);
    
    window['GameScreen'] = this;
    this.game = this.props.session.game;
    const browser = Bowser.getParser(window.navigator.userAgent);
    this.isMobile = browser.getPlatform().type === 'mobile';

    document.body.appendChild(this.stats.dom);
    this.stats.showPanel(0);
    
    this.camera = new THREE.PerspectiveCamera(45, this.aspectRatio, 2, 500);
    this.camera.name = 'MainCamera';
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(15, 0, 7);
    this.game.camera = this.camera;

    this.cameraHelper = new THREE.CameraHelper( this.camera );
    this.game.world.scene.add(this.cameraHelper);
    this.debugCamera = new THREE.PerspectiveCamera(60, this.aspectRatio, 2, 500);
    this.debugCamera.name = 'DebugCamera';
    this.debugCamera.up.set(0, 0, 1);
    this.debugCamera.position.set(15, 0, 7);
  }
  
  componentDidMount() {
    const renderer = this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
      canvas: this.refs.canvas as HTMLCanvasElement,
    });
    
    const composer = new EffectComposer(renderer);

    console.log('Renderer', renderer);

    // window['depthPass'] = this.depthPass = new DepthPass(this.game.world.scene, this.camera);
    // this.depthPass.renderToScreen = false;

    // const depthTexture = this.depthPass.texture;
    // depthTexture.wrapS = THREE.RepeatWrapping;
    // depthTexture.wrapT = THREE.RepeatWrapping;
    // depthTexture.generateMipmaps = false;
    // depthTexture.magFilter = THREE.NearestFilter;
    // depthTexture.minFilter = THREE.NearestFilter;

    this.setState({
      renderer,
      composer
    })
    
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

    this.game.world.run();
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
          this.camera.position.z + this.debugCameraRange)
          this.debugRenderer.render(this.game.world.scene, this.debugCamera);
      }
      
      this.prevCameraRotation = this.camera.quaternion.clone();
      this.prevCameraPosition = this.camera.position.clone();
      if (this.controls.current) {
        this.controls.current.update(delta);
      }
      this.stats.end();
    }
    
    setLocation(locationId: string | number) {
      const spot = spots.find(x => x.id === locationId);
      if (spot) {
        this.game.world.player.worldport(spot.zoneId, spot.coords);
      }
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
          { !this.isMobile && <DebugPanel ref="debugPanel" renderer={renderer} game={this.game}></DebugPanel>}
          <select className="location_select" onChange={(e) => this.setLocation(e.target.value)}>
            {
              spots.map(x => {
                return (
                  <option 
                    key={x.id}
                    value={x.id}>
                      {x.title}
                  </option>
                )
              })
            }
          </select>
      </div>
    );
  }
}

export default GameScreen;
