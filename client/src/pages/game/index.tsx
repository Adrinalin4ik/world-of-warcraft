import * as Bowser from "bowser";
import React from 'react';
import Stats from 'stats-js';
// import * as THREE from 'three';
import { DepthPass, EffectComposer } from 'postprocessing';
import * as THREE from 'three';
import spots from '../../game/world/spots';
import { GameHandler } from '../../network/game/handler';
import { offlineSpot } from '../../network/offline-session';
import { GameSession } from '../../network/session';
import Controls from './controls/controls';
import DebugPanel from './debug/debug';
import { HUD_REPAINT_MS, PerfMonitor } from '../../game/perf';
import { animCounters } from '../../game/pipeline/m2/anim/counters';
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
  private prevCameraRotation: THREE.Quaternion = new THREE.Quaternion();
  private prevCameraPosition: THREE.Vector3 = new THREE.Vector3();
  private hasPrevCamera = false;
  private renderer: THREE.WebGLRenderer | null = null;
  private debugRenderer: THREE.WebGLRenderer | null = null;
  private clock: THREE.Clock = new THREE.Clock();
  private game: GameHandler;
  private debug = false;
  private debugCameraRange = 300;
  //refs
  private controls = React.createRef<Controls>()
  private debugPanel = React.createRef<DebugPanel>()
  // React 19 removed string refs, so the two canvases and the debug panel now use createRef like the
  // controls above. The debug panel is worth noting: it already had this createRef, but its element was
  // written as ref="debugPanel", so `debugPanel.current` was always null and the guarded
  // `forceUpdate()` in the render loop has silently never fired. Wiring it up actually connects it.
  private canvas = React.createRef<HTMLCanvasElement>()
  private debugCanvas = React.createRef<HTMLCanvasElement>()
  private stats: any = new Stats();
  private perf: PerfMonitor = new PerfMonitor();
  private lastDebugPanelPaint = 0;

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
      // OPAQUE drawing buffer. With `alpha: true` the canvas is composited over the page, and because
      // WebGL also defaults to `premultipliedAlpha: true` the compositor treats our non-premultiplied
      // output as premultiplied and adds `(1 - a)` of whatever is behind the canvas -- which is
      // nothing here, so the browser's white base. Every partial-alpha fragment therefore gained a
      // bright halo.
      //
      // That went unseen for as long as `assignShaders` forced `Combiners_Opaque` onto every M2,
      // because it writes `result.a = vertexColor.a` (effectively 1). The authored combiners write
      // real texture alpha -- `Combiners_Mod` is `sampled0.a * vertexColor.a * animatedTransparency`
      // -- and under blend mode 1 (alpha key: `blendSrcAlpha` One, `blendDstAlpha` Zero) that lands
      // in the framebuffer verbatim. Alpha-tested foliage keeps every edge texel in [0.5, 1], so all
      // of Elwynn's trees and bushes picked up a white fringe.
      //
      // The reference renders to an opaque backbuffer; its framebuffer alpha means nothing. Turning
      // compositing off is that, and it fixes the whole class at once rather than foliage alone --
      // genuinely blended modes (2, 4, 6: waterfalls, spell effects) leave sub-1 alpha behind too.
      // Nothing sits behind the main canvas to show through: it is the bottom layer, and the scene
      // draws a full sky dome.
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
      canvas: this.canvas.current as HTMLCanvasElement,
    });

    // r150's default. From r152 the default became SRGBColorSpace, which would apply a linear-to-sRGB
    // conversion on output that none of this client's shaders or textures were tuned for. See the
    // ColorManagement note in src/index.tsx.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    
    const composer = new EffectComposer(renderer);

    console.log('Renderer', renderer);

    this.perf.attach(renderer.getContext() as WebGL2RenderingContext);

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
        canvas: this.debugCanvas.current as HTMLCanvasElement
      });
      this.debugRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    }
    console.log("componentDidMount", this)
    this.forceUpdate();
    this.resize();
    
    this.callFrame();

    window.addEventListener('resize', this.resize.bind(this));

    this.game.world.run();

    // Offline debug entry: nothing will ever send us a login-verify, so place the character now.
    if (this.props.session.offline) {
      const spot = offlineSpot();
      this.game.world.player.worldport(spot.zoneId, spot.coords);
      this.setState({ currentLocation: spot.id });
    }
  }

  // No forceUpdate here. This component's state (renderer, composer, currentLocation) changes at
  // mount and on explicit user action; re-rendering the subtree at 60 Hz cost a full React
  // reconciliation per frame for nothing. Per-frame numbers go to the perf HUD, which writes DOM
  // directly at 4 Hz (see game/perf/hud.ts).
  callFrame() {
    this.animate();
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

    this.perf.beginFrame();
    animCounters.reset();

    const delta = this.clock.getDelta();

    // The debug panel is a full React subtree. It reads slow-moving values (position, zone, light
    // state) that no one can perceive at 60 Hz, so it repaints on the HUD's 4 Hz cadence.
    const nowMs = performance.now();
    if (this.debugPanel.current && nowMs - this.lastDebugPanelPaint >= HUD_REPAINT_MS) {
      this.lastDebugPanelPaint = nowMs;
      this.debugPanel.current.forceUpdate();
    }

    // Task 4 Step 3: converge the backdrop on the row-7 fog colour, so nothing shows through where the
    // fully-fogged far plane meets the void behind the sky dome. `mapLight.fogColor` already holds raw,
    // unconverted values (every write to it goes through THREE.Color#copy, never `setStyle`/`setHex`,
    // which is what keeps the whole lighting pipeline on the gamma-passthrough lane -- see
    // `renderer.outputColorSpace = LinearSRGBColorSpace` above). `WebGLRenderer#setClearColor` reads
    // the colour back out via `Color#getRGB(target, renderer.outputColorSpace)`, which is a Linear ->
    // Linear identity conversion given that same `outputColorSpace` -- so this stays raw end to end,
    // not merely "close enough".
    const mapLight = this.game.world.mapLight;
    if (mapLight) {
      this.renderer.setClearColor(mapLight.fogColor, 1);
    }

    const cameraMoved: boolean =
      !this.hasPrevCamera ||
      !this.prevCameraRotation.equals(this.camera.quaternion) ||
      !this.prevCameraPosition.equals(this.camera.position);
    
    this.perf.sections.begin('world.animate');
    this.game.world.animate(delta, this.camera, cameraMoved);
    this.perf.sections.end('world.animate');

    this.perf.sections.begin('render');
    this.perf.gpuBegin();
    this.renderer.render(this.game.world.scene, this.camera);
    this.perf.gpuEnd();
    this.perf.sections.end('render');

      if (this.debugRenderer) {
        this.debugCamera.position.set(this.camera.position.x,
          this.camera.position.y,
          this.camera.position.z + this.debugCameraRange)
          this.debugRenderer.render(this.game.world.scene, this.debugCamera);
      }

      this.prevCameraRotation.copy(this.camera.quaternion);
      this.prevCameraPosition.copy(this.camera.position);
      this.hasPrevCamera = true;
      if (this.controls.current) {
        this.controls.current.update(delta);
      }

      const info = this.renderer.info;
      const visibility = this.game.world.map?.visibilityManager;
      this.perf.endFrame({
        calls: info.render.calls,
        triangles: info.render.triangles,
        programs: info.programs?.length ?? 0,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        visibleChunks: visibility?.stats.map?.visibleChunks ?? 0,
        visibleGroups: visibility?.stats.wmo?.visibleGroups ?? 0,
        visibleMapDoodads: visibility?.stats.map?.visibleDoodads ?? 0,
        loadedMapDoodads: this.game.world.map?.doodadManager?.doodads.size ?? 0,
        visibleDoodads: visibility?.stats.wmo?.visibleDoodads ?? 0,
        animResident: animCounters.resident,
        animPosed: animCounters.posed,
        animSkipped: animCounters.skipped,
        animBonesSolved: animCounters.bonesSolved,
        animPosesApplied: animCounters.posesApplied,
        animMaterialsEvaluated: animCounters.materialsEvaluated,
      });

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
      <canvas ref={this.debugCanvas}
      className="canvas debug_canvas" 
      style={{position: this.debug ? "relative" : "absolute"}}></canvas> : null
    const { renderer } = this.state;

    return (
      <div className="game_screen">
          <canvas ref={this.canvas} 
                  className="canvas main_canvas" 
                  style={{position: this.debug ? "relative" : "absolute"}}></canvas>
          {debugCanvas}
          <Controls ref={this.controls} player={this.game.world.player} camera={this.camera} />
          { !this.isMobile && <DebugPanel ref={this.debugPanel} renderer={renderer} game={this.game}></DebugPanel>}
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
