import * as Bowser from "bowser";
import React from 'react';
import { useNavigate } from 'react-router-dom';
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
import { pumpProgramWarm, setProgramWarmer } from '../../game/pipeline/program-warm';
import { WorldUiHost, wantsLuaUi } from '../../game/ui/world-ui';
import './index.scss';

interface IGameProps {
  session: GameSession;
  /**
   * The world connection ended. The host performs the transition, exactly as `GlueApp#onEnterWorld`
   * does in the other direction -- this component owns a canvas, a renderer and a frame loop, not a
   * router.
   */
  onDisconnected?: () => void;
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
  /** The rAF handle, so `componentWillUnmount` can stop a loop that otherwise never ends. */
  private frameHandle = 0;
  private stopped = false;
  /** Held bound, because `removeEventListener` needs the SAME function object `add` was given. */
  private readonly onResize = () => this.resize();
  private readonly onWorldDisconnect = () => {
    // Once, and only forward. The socket emits `disconnect` and `Socket#dropSocket` can silence a
    // replaced one, but a double delivery must not navigate twice.
    if (this.stopped) {
      return;
    }
    console.warn('world: connection lost; leaving the world route');
    this.props.onDisconnected?.();
  };

  private isMobile: boolean = false;

  /**
   * The world's UI host -- the client's own FrameXML, drawn over the 3D pass.
   *
   * Null on plain `/game`, which keeps the world exactly as it was: `?ui=lua` is the same switch
   * `pages/glue/index.tsx` gates the Lua glue screens behind, and the world half of it had no
   * consumer until this round. Gating it matters more here than there -- the manifest is 139 entries
   * against the glue's 17, and every measurement in this repo's perf record was taken without it.
   */
  private ui: WorldUiHost | null = null;

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

    // Hand the asset path a way to warm a new body's GLSL programs without any of it knowing about
    // this renderer. A REGISTRATION, the same shape `perf/anim-section.ts` uses and for the same
    // reason: the renderer is owned by this page and must not become a singleton to be reachable from
    // `game/classes/unit.ts`. Nothing registered -> `revealWhenWarm` is a plain `visible = true`,
    // which is the state in every test and in `/game?offline=1`.
    //
    // `compileAsync(object, camera, scene)`: three treats the first argument as the subtree whose
    // MATERIALS to initialise and the third as the scene to gather LIGHTS from, which is exactly the
    // split needed here -- the body is already parented into the world scene, and its programs must be
    // built against that scene's lights or the warm-up compiles a variant the real render would not
    // use. (`three/build/three.module.js:17374` for `compile`'s two traversals.)
    setProgramWarmer((object) => renderer.compileAsync(object, this.camera, this.game.world.scene));

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

    window.addEventListener('resize', this.onResize);
    // The one thing that can end this route from below. Nothing listened for it, so a dropped world
    // socket left the player looking at a frozen world with no way back to the login screen short of
    // reloading the page -- which is half of "I cannot connect a second time".
    this.game.on('disconnect', this.onWorldDisconnect);

    this.game.world.run();

    // THE UI HOST. Started here rather than in the constructor because it needs the renderer and the
    // canvas, and both exist only from this point. Fire-and-forget: the boot fetches 264 files and
    // runs them, tens of seconds on a cold cache, and `render(dt)` is a no-op until it lands -- so
    // awaiting it would be awaiting it in the frame loop.
    if (wantsLuaUi(window.location.search)) {
      this.ui = new WorldUiHost(
        renderer,
        this.canvas.current as HTMLCanvasElement,
        this.perf.sections,
      );
      void this.ui.start().catch((error) => {
        // A boot that fails outright is the one thing `bootWorldRuntime` does not turn into a report
        // line, so it must not vanish into an unhandled rejection.
        console.error('framexml(world): the runtime failed to boot', error);
      });
    }

    // Offline debug entry: nothing will ever send us a login-verify, so place the character now.
    if (this.props.session.offline) {
      const spot = offlineSpot();
      this.game.world.player.worldport(spot.zoneId, spot.coords);
      this.setState({ currentLocation: spot.id });
    }
  }

  /**
   * Everything this component put somewhere that outlives it.
   *
   * There was no unmount at all, and until this round nothing ever unmounted the world route, so
   * that cost nothing. It does now: a disconnect navigates away, and a second world entry remounts.
   * Without this the page would carry a second `requestAnimationFrame` loop rendering the same
   * scene (both of which advance `worldClock` -- the exact double-advance `game/ui/screens.ts:118`
   * warns about), a second stats panel and camera helper, and a stale program warmer holding a
   * renderer that has been disposed.
   */
  componentWillUnmount() {
    this.stopped = true;
    window.cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.onResize);
    this.game.removeListener('disconnect', this.onWorldDisconnect);
    // Reveals anything still queued for a GLSL warm-up before the renderer it would compile against
    // goes away. `program-warm.ts` documents this as the reason a null warmer flushes the queue;
    // this is the caller it was written for.
    setProgramWarmer(null);
    // Before the renderer goes: the host holds pooled meshes, geometries and materials made against
    // it, and its own `dispose` deliberately does NOT free the renderer it was merely lent.
    this.ui?.dispose();
    this.ui = null;
    this.game.world.scene.remove(this.cameraHelper);
    this.stats.dom.parentNode?.removeChild(this.stats.dom);
    this.renderer?.dispose();
    this.debugRenderer?.dispose();
    this.renderer = null;
  }

  // No forceUpdate here. This component's state (renderer, composer, currentLocation) changes at
  // mount and on explicit user action; re-rendering the subtree at 60 Hz cost a full React
  // reconciliation per frame for nothing. Per-frame numbers go to the perf HUD, which writes DOM
  // directly at 4 Hz (see game/perf/hud.ts).
  callFrame() {
    // The guard is not belt and braces: a frame already scheduled when `componentWillUnmount` ran
    // has been cancelled, but one that is mid-callback has not, and it would schedule the next.
    if (this.stopped) {
      return;
    }
    this.animate();
    this.frameHandle = window.requestAnimationFrame(this.callFrame.bind(this));
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
      // Spanned because it is the one thing in this loop that runs a full React reconciliation, and
      // because a span that is open on 1 frame in 7 and closed on the rest reports its cost AVERAGED
      // over nothing -- the HUD samples whichever frame it lands on, so this row reads either ~0 or
      // the whole reconciliation. Both readings are informative and neither is an average.
      this.perf.sections.begin('ui.panel');
      this.debugPanel.current.forceUpdate();
      this.perf.sections.end('ui.panel');
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

    // Issue GLSL compiles for bodies that have just been built, and reveal the ones whose programs
    // are ready. BEFORE `render`, so a body revealed this frame is drawn this frame and nothing waits
    // an extra one. Spanned because a compile issued here is real main-thread work -- it is moved off
    // the driver's blocking link, not conjured away -- and the span is how anyone checks that.
    // Measured cost and the whole argument: `game/pipeline/program-warm.ts`.
    this.perf.sections.begin('warm');
    pumpProgramWarm();
    this.perf.sections.end('warm');

    this.perf.sections.begin('render');
    this.perf.gpuBegin();
    this.renderer.render(this.game.world.scene, this.camera);
    this.perf.gpuEnd();
    this.perf.sections.end('render');

    // THE UI PASS, over the world and into the same buffer. See `game/ui/world-ui.ts` for why it is
    // after the world render and not before: the world pass clears (it sets the clear colour from
    // the map's fog every frame above), so a UI pass in front of it would be erased.
    //
    // Spanned as its own row because a per-frame pass over 4211 frames is exactly the shape of thing
    // that eats a 16.7 ms budget, and the only honest way to say what the interface costs is to
    // measure it separately from `render`. NOT inside the `gpuBegin`/`gpuEnd` pair: that query wraps
    // the world draw, and reopening it would attribute one span's GPU time to the other. So this row
    // is CPU only -- the quads it issues show up in `render.calls`, not here.
    this.perf.sections.begin('ui.framexml');
    this.ui?.render(delta);
    this.perf.sections.end('ui.framexml');

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
        // The mover: input, gravity, the collision casts. Inside the measured frame and, until this
        // span, inside NONE of its named parts -- `world.animate` and `render` together accounted
        // for well under half of p50, and this was one of the places the rest was hiding.
        this.perf.sections.begin('controls');
        this.controls.current.update(delta);
        this.perf.sections.end('controls');
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

/**
 * The route element: `GameScreen` plus the one thing it needs the router for.
 *
 * The mirror image of `GlueRoute` (`pages/glue/index.tsx:99-107`), and a ROUTER navigation for the
 * same reason it is one there: the `GameSession` is created once in `App` and handed to both routes,
 * so a document navigation would drop the session, its handlers and the world it holds. Keeping the
 * session is the whole point here -- it is what makes a reconnect possible without reloading.
 */
const GameRoute: React.FC<{ session: GameSession }> = ({ session }) => {
  const navigate = useNavigate();
  // WITH the query string. `?ui=lua` selects the FrameXML glue screens and `?realmlist=` names the
  // server to dial (`network/session.ts:33`, `network/gateway.ts:38`); dropping them would land the
  // player back on a differently-configured login screen -- a plain `navigate('/')` silently swaps
  // the Lua UI for the transcription and forgets which realmlist this session was started against.
  const disconnected = React.useCallback(
    () => navigate({ pathname: '/', search: window.location.search }),
    [navigate],
  );

  return <GameScreen session={session} onDisconnected={disconnected} />;
};

export { GameScreen };
export default GameRoute;
