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
import { LoadingScreen } from '../../game/ui/loading-screen';
import { WorldCursorDriver } from '../../game/ui/world-cursor';
import { CURSOR_POINT, classifyUnitCursor, cursorStem } from '../../game/world/cursor-mode';
import { pickUnit, pickUnitReport, drawnWorldBox } from '../../game/world/pick';
import { collisionWorld } from '../../game/collision/collision-world';
import { CollisionLayer } from '../../game/collision/types';
import { wantsDebugPanels } from '../debug-flags';
import { REACTION_NEUTRAL, primeFactionTemplates, reactionFor } from '../../game/world/faction';
import type World from '../../game/world';
import type Unit from '../../game/classes/unit';

import './index.scss';

/**
 * `UNIT_DYNFLAG_LOOTABLE` -- bit 0x1 of `UNIT_DYNAMIC_FLAGS`, set on a corpse this player may loot.
 *
 * A SERVER-side definition, like the `HitInfo` bits and the NPC service flags: nothing in the game's
 * own data names it. The reference cites `SharedDefines.h:1153` for the same value
 * (`benilla-protocol/src/bin/benilla-world/probes/loot.rs:72-73`), which is corroboration from a second
 * server implementation rather than an independent source.
 */
const UNIT_DYNFLAG_LOOTABLE = 0x1;

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
  /**
   * `?debug=true`. Read ONCE, at construction, so every overlay decision in this component agrees --
   * a per-call read would let a route change part-way through a frame leave the stats panel up and
   * the perf HUD down.
   *
   * What it gates: the stats-js FPS meter (top-left), the perf HUD (top-right), the red accordion
   * `DebugPanel` (down the left) and the teleport `<select>`. All four are development surfaces, and
   * all four were on unconditionally -- which is why a screenshot of this client has never been a
   * screenshot of the game. See `pages/debug-flags.ts`; the measurement behind the HUD is NOT gated.
   */
  private readonly showDebug = wantsDebugPanels(window.location.search);
  /** Null when `?debug=true` is absent -- nothing constructs it and nothing appends its DOM. */
  private stats: any = null;
  private perf: PerfMonitor;
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

  /** Up from mount until the interface's first draw; null afterwards. See `componentDidMount`. */
  private loadingScreen: LoadingScreen | null = null;

  /**
   * Held so `dismissLoadingScreen` can take it off the PLAYER's emitter. The player outlives this
   * component (it belongs to the world, which belongs to the session, and this client relogs without a
   * page reload), so a listener left behind would accumulate one dead closure per mount -- each one
   * pinning a disposed `GameScreen`. Same rule `action-bridge.ts` follows with `removeListener`.
   */
  private onMapChange: ((mapId: number) => void) | null = null;

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

    // The perf monitor exists either way -- it owns the frame ring and the CPU spans, which every
    // capture in this repo's performance record is taken from. Only its HUD is gated.
    this.perf = new PerfMonitor(document, this.showDebug);

    if (this.showDebug) {
      this.stats = new Stats();
      document.body.appendChild(this.stats.dom);
      this.stats.showPanel(0);
    }

    this.camera = new THREE.PerspectiveCamera(45, this.aspectRatio, 2, 500);
    this.camera.name = 'MainCamera';
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(15, 0, 7);
    this.game.camera = this.camera;

    // NO `THREE.CameraHelper` HERE. It used to be built for `this.camera` and added to the world
    // scene unconditionally, and it was the faint one-pixel full-height line down the exact horizontal
    // centre of the screen that the owner has been looking at. Rendered THROUGH the very camera it
    // describes, a frustum wireframe degenerates: the eye-to-target and up-vector segments project
    // onto the centre column and the near/far rectangles land on the clip boundary, so all that
    // survives is a vertical hairline at width/2, in the world pass (hence under the interface) and in
    // no UI draw list.
    //
    // MEASURED rather than argued: it was the only visible line primitive in the world scene
    // (`CollisionDebugView` is hidden), and setting `visible = false` on it live removed the line from
    // a centre-column screenshot crop (`MB9-before.png` / `MB9-after.png`, round 31).
    //
    // It was also dead: the field was assigned, added and removed and read nowhere, and `update()` was
    // never called after construction, so it did not even describe the camera's current frustum. The
    // debug-camera pair below is still used by the visibility work; only the helper is gone.
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
    this.installPickInstrument();

    // THE HOVER CURSOR. On `document.body` because `cursor` is an inherited property and the world
    // canvas, the UI canvas and the debug panel are all its descendants -- one write covers the route.
    this.cursorDriver = new WorldCursorDriver(document.body);
    document.body.addEventListener('pointermove', this.onCursorPointerMove);
    (window as unknown as Record<string, unknown>).worldCursorArt = () =>
      this.cursorDriver?.cursorArtReport() ?? null;
    (window as unknown as Record<string, unknown>).worldCursorStats = () => this.cursorStats;

    console.log("componentDidMount", this)
    this.forceUpdate();
    this.resize();
    
    this.callFrame();

    window.addEventListener('resize', this.onResize);
    // The one thing that can end this route from below. Nothing listened for it, so a dropped world
    // socket left the player looking at a frozen world with no way back to the login screen short of
    // reloading the page -- which is half of "I cannot connect a second time".
    this.game.on('disconnect', this.onWorldDisconnect);

    /**
     * THE LOADING SCREEN IS ARMED BEFORE `world.run()`, AND THE ORDER IS THE WHOLE BUG IT FIXES.
     *
     * `map:change` is an EDGE with no replay (`classes/player.ts:26`), and `World#run` worldports a
     * real character SYNCHRONOUSLY on the online path -- `const entered = session.offline ? null :
     * session.protocol.enteredCharacter` and then `player.worldport(entered.mapId, entered.position)`
     * with nothing awaited in between (`world/index.ts:380,449`). So on a real login the event had
     * ALREADY fired by the time this component subscribed, the art was never asked for, and the screen
     * never drew: the owner's "Экран загрузки не видно". The offline route hid it completely, because
     * there `entered` is null and the worldport happens further down this method -- which is the only
     * ordering the gate ever exercised.
     *
     * Reproduced credential-free before fixing, by moving the offline worldport above the old
     * subscription point: the screen object existed and NEVER acquired art. Note the first attempt at
     * that simulation did not reproduce, because DUPLICATING the worldport re-emits -- `worldport`'s
     * guard is `if (!this.mapId || ...)` and map 0 is falsy, so map 0 always emits twice.
     *
     * Subscribing first removes the race outright rather than racing it better, which is the same
     * shape as `ProtocolSession#state`'s reconcile (`STATE.md`, round 27): an edge subscription with
     * no replay must be attached before the thing that fires it. `renderer` already exists here.
     */
    if (wantsLuaUi(window.location.search)) {
      this.loadingScreen = new LoadingScreen(renderer);
      // The instrument: "no picture" has three distinct causes no screenshot separates -- the map id
      // never arrived, the DBCs named no screen for it, or the BLP never decoded. `ready` answers the
      // first two, which is what told "never drew" apart from "drew and was not seen".
      (window as never as Record<string, unknown>).loadingScreen = this.loadingScreen;
      /**
       * THE EVENT IS THE ONLY SOURCE, and reading `player.mapId` up front would be WRONG rather than
       * merely redundant: it is initialised to **0** (`classes/player.ts:4`), which is a real map id
       * (Eastern Kingdoms), so an eager read on a character who has not been placed yet fetches the
       * wrong 700 KB screen and then replaces it. With the subscription now ahead of every worldport,
       * no eager read is needed on either route.
       */
      this.onMapChange = (mapId: number) => {
        void this.loadingScreen
          ?.load(mapId)
          .catch((error) => console.warn('loading screen: art unavailable', error));
      };
      this.game.world.player.on('map:change', this.onMapChange);
    }

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
        this.game.world,
      );
      // The manifest's own file count drives the bar. Nothing invented: see `world-runtime.ts`.
      this.ui.onLoadProgress = (fraction) => this.loadingScreen?.setProgress(fraction);
      void this.ui.start().then(() => {
        // AFTER the boot resolves, not on a timer: `start()` resolves once the tree is built, the art
        // is registered and the bridges are attached, which is exactly when the interface can draw.
        this.dismissLoadingScreen();
      }).catch((error) => {
        // A boot that fails outright is the one thing `bootWorldRuntime` does not turn into a report
        // line, so it must not vanish into an unhandled rejection. The screen comes down either way --
        // leaving it up would hide a world that is otherwise fine.
        this.dismissLoadingScreen();
        console.error('framexml(world): the runtime failed to boot', error);
      });
    }

    // The reaction table, primed as soon as we are in the world: every unit that streams in wants a
    // reaction, and resolving one needs `FactionTemplate.dbc`. Fire-and-forget -- a unit whose
    // reaction is not resolvable yet answers null, and the bridge re-resolves on the next update.
    void primeFactionTemplates();

    // Offline debug entry: nothing will ever send us a login-verify, so place the character now.
    if (this.props.session.offline) {
      const spot = offlineSpot();
      this.game.world.player.worldport(spot.zoneId, spot.coords);
      this.setState({ currentLocation: spot.id });
    }
  }

  /**
   * A clean left click on the world: pick a unit and make it the target, or clear the target.
   *
   * DEFERS TO THE UI. `pointerWidget` is the Lua router's own current hit, so a click that landed on
   * an action button or a unit frame does not also reach through it into the world -- and the answer
   * comes from the router that handled the click rather than from a second hit test that could
   * disagree. Plain `/game` has no host at all, so `this.ui` null means the world owns every click.
   *
   * A click on nothing CLEARS the target, which is the reference's behaviour
   * (`benilla/src/target/click.rs`: "clicked nothing targetable -> deselect").
   */
  /**
   * Which of the client's own frames took the live press, or null when the press is the world's.
   *
   * The PRESS half of the gate `onWorldClick` below already applies to the CLICK, and it had been
   * missing: `pointerWidget` stopped a click on an action button from also selecting a unit, but nothing
   * stopped the same press from latching `Controls#buttons` and orbiting the camera. That is the owner's
   * "камера тоже двигается и не получается в итоге передвинуть способность" -- and it also broke the drag
   * outright, because the orbit takes a POINTER LOCK and a lock freezes `clientX/clientY`.
   *
   * Plain `/game` has no host, so `this.ui` null means the world owns every press -- the same fallback the
   * click gate takes.
   */
  private uiCapturedPress = (): string | null => this.ui?.capturedPress ?? null;

  /**
   * The pick's options, built per click.
   *
   * The cast is a ZERO-RADIUS camera-layer cast -- the occlusion leg's whole geometry, and the same
   * terrain + WMO + doodad set the camera boom already sweeps (`collision-world.ts#castFor`). Built
   * here rather than inside `pick.ts` because that module is deliberately world-agnostic: every unit
   * test of the pick drives it against synthetic geometry with nothing registered, which is the rule
   * `collision-world.ts` states for `CastFn` in the first place.
   *
   * The two `window` switches are the SAME-BUILD CONTROL ARMS. A pick claim cannot be checked across
   * two builds because the units move between them; these let one run measure both arms over the same
   * geometry. `window.uiTextSnap` is the shape.
   */
  private pickOptions() {
    const flags = window as unknown as Record<string, unknown>;
    return {
      cast: collisionWorld.castFor(CollisionLayer.Camera, 0, 0),
      narrow: flags.worldPickNarrow !== false,
      occlude: flags.worldPickOcclude !== false,
    };
  }

  /**
   * `window.worldPick(clientX, clientY)` and `window.worldUnits()` -- THE PICK INSTRUMENT.
   *
   * A pick cannot be judged from a screenshot: "the click selected the wolf" and "the click selected
   * the wolf from three yards off its flank" look identical, and the second is the whole bug. This
   * reports, per broad-phase candidate, the sphere the old pick used, the hull the new one uses, and
   * which of the two rejected it -- through `pickUnitReport`, which calls the SAME `pickUnit`
   * production does rather than a second copy of the rule.
   *
   * `document.body.getBoundingClientRect()` is not a convenience: it is the exact element
   * `controls/controls.tsx` measures its own NDC against (`this.element = document.body`, `:106`), so
   * this instrument and a real click cannot disagree about where the pointer is. That is the trap
   * `STATE.md` records against a probe doing its own coordinate arithmetic.
   *
   * `worldUnits()` reports every unit's SCREEN position in CSS pixels, which is what lets a probe put
   * a real `page.mouse.click` a stated number of pixels off a mob instead of guessing at one.
   */
  /** Takes the loading screen down and releases its art. Safe to call twice. */
  private dismissLoadingScreen(): void {
    if (this.onMapChange) {
      this.game.world.player.removeListener('map:change', this.onMapChange);
      this.onMapChange = null;
    }
    this.loadingScreen?.dispose();
    this.loadingScreen = null;
    delete (window as never as Record<string, unknown>).loadingScreen;
  }

  /** The `window` keys `installPickInstrument` writes, so `componentWillUnmount` can take them back. */
  private static readonly PICK_INSTRUMENT_KEYS = ['worldPick', 'worldUnits', 'worldCamera'];

  private installPickInstrument(): void {
    const flags = window as unknown as Record<string, unknown>;
    const toNdc = (clientX: number, clientY: number) => {
      const bounds = document.body.getBoundingClientRect();
      return {
        x: ((clientX - bounds.left) / bounds.width) * 2 - 1,
        y: -(((clientY - bounds.top) / bounds.height) * 2 - 1),
      };
    };
    flags.worldPick = (clientX: number, clientY: number) => {
      const world = this.game.world;
      const ndc = toNdc(clientX, clientY);
      const report = pickUnitReport(
        world.entities.values(), this.camera, ndc, world.player, this.pickOptions(),
      );
      return { ndc, ...report };
    };
    // The camera's own numbers, so a probe can turn a PIXEL margin into a YARD margin at a stated
    // depth instead of asserting one. `2 * d * tan(fov/2) / heightPx` yards per pixel.
    flags.worldCamera = () => ({
      fov: this.camera.fov,
      aspect: this.camera.aspect,
      position: this.camera.position.toArray(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    flags.worldUnits = () => {
      const world = this.game.world;
      const bounds = document.body.getBoundingClientRect();
      const point = new THREE.Vector3();
      const body = new THREE.Vector3();
      const out: unknown[] = [];
      world.entities.forEach((unit) => {
        if (unit === world.player) {
          return;
        }
        // The unit's MIDRIFF, half a collision height up -- the same point `pick.ts#pickSphere`
        // centres its sphere on, so a click aimed here is a click at the centre of the old volume.
        point.copy(unit.view.position);
        point.z += Math.max(unit.collisionHeight, 0.1) * 0.5;
        const model = unit.model;
        const distance = point.distanceTo(this.camera.position);
        point.project(this.camera);
        out.push({
          guid: unit.guid,
          name: unit.name ?? null,
          objectType: unit.objectType,
          dead: unit.dead,
          distance,
          collisionHeight: unit.collisionHeight,
          vertexRadius: model ? model.vertexRadius : null,
          modelScale: model ? model.scale.x : null,
          hullTriangles: this.hullTriangleCount(unit),
          visible: unit.view.visible,
          screen: {
            x: bounds.left + ((point.x + 1) / 2) * bounds.width,
            y: bounds.top + ((1 - point.y) / 2) * bounds.height,
            behind: point.z > 1,
          },
          // THE RENDERED BODY'S CENTRE, which is where a probe must aim. The midriff above is a
          // model-space proxy (feet + half a collision height) and for a FLYING creature it sits
          // BELOW the drawn body -- measured on a Vale Moth, a click there missed while the same
          // click 20-40 px higher hit. `screen` is kept because it is what `pickSphere` uses.
          screenBody: (() => {
            const box = drawnWorldBox(unit);
            if (box === null) {
              return null;
            }
            body.set((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
            const bodyDistance = body.distanceTo(this.camera.position);
            body.project(this.camera);
            return {
              x: bounds.left + ((body.x + 1) / 2) * bounds.width,
              y: bounds.top + ((1 - body.y) / 2) * bounds.height,
              behind: body.z > 1,
              distance: bodyDistance,
              size: [box[3] - box[0], box[4] - box[1], box[5] - box[2]],
            };
          })(),
        });
      });
      return out;
    };
  }

  /** How many triangles a unit's authored collision hull has -- 0 when its M2 ships none. */
  private hullTriangleCount(unit: { model?: { boundingMesh?: THREE.Mesh } }): number {
    const geometry = unit.model?.boundingMesh?.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) {
      return 0;
    }
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const count = index ? index.count : (position?.count ?? 0);
    return Math.floor(count / 3);
  }

  // -- The hover cursor -----------------------------------------------------------------------------

  private cursorDriver: WorldCursorDriver | null = null;

  /**
   * The last pointer position in CLIENT pixels, or null before the pointer has moved.
   *
   * Its own listener rather than the router's `pointerPosition`, and that is deliberate: the router
   * works in logical 768-space with Y down, so reading it here would mean converting back -- and
   * `STATE.md` records a probe that did its own coordinate arithmetic and asked a different question
   * from the one the router answers, invisibly. `clientX`/`clientY` is the space `pickUnit`'s callers
   * and `controls.tsx` both already work in.
   */
  private cursorPointer: { x: number; y: number } | null = null;

  /**
   * The shift key as of the last pointer move -- the loot leg's Pickup/LootAll split.
   *
   * The EVENT'S OWN `shiftKey` flag and not a `keydown` of `'Shift'`, which is the trap
   * `api/screen.ts`'s key trackers record: a modifier held across another key never fires its own
   * keydown again and a key-name tracker loses it.
   */
  private cursorShift = false;

  private onCursorPointerMove = (event: PointerEvent) => {
    this.cursorPointer = { x: event.clientX, y: event.clientY };
    this.cursorShift = event.shiftKey;
  };

  /**
   * THE CADENCE, and it is a budget decision with a number behind it rather than a default.
   *
   * The classifier needs to know which unit is under the pointer, and that is the full pick --
   * measured at **1.0-2.4 ms per call** in round 21 (926-1645 posed triangles plus the occlusion
   * cast). Run every frame at 60 Hz that is 60-144 ms of every second, i.e. 6-14% of the frame
   * budget, and it would hand back more than the whole 4-7.5 ms saving the offscreen UI target exists
   * for. So it is thrown at a fixed cadence.
   *
   * **100 ms.** Two things bound the choice from opposite sides. The cheap side: 10 picks/s is
   * 10-24 ms/s, under 2.4% of a second, which is inside the +-1 ms per-frame spread once amortised
   * and is reported raw by `worldCursorStats` so it need not be taken on trust. The expensive side:
   * what the classifier's OUTPUT can do in 100 ms. Its boundaries are the range gates -- 5.5556 yd
   * for a service and 10.45 yd for attack -- and a unit closing at a run (7 yd/s) crosses one in
   * ~14 ms of travel either side, so 100 ms is the smallest interval at which a gate flip could be
   * mistimed, by at most 0.7 yd of the other party's movement. Against that, the pointer moving from
   * one unit to another is the common case and 100 ms is at the edge of perceptible.
   *
   * `TOOLTIP_UPDATE_TIME` (200 ms), which `IsActionInRange` already uses in this tree, was the other
   * candidate and is rejected on the second bound only: it halves the cost again but doubles the lag
   * on the change a user actually sees. `window.worldCursorCadenceMs` makes both arms measurable in
   * one build, and `window.worldCursorEnabled = false` is the off arm.
   */
  private static readonly CURSOR_CADENCE_MS = 100;

  private lastCursorAt = 0;

  /** `window.worldCursorStats` -- the cadence's own cost, reported raw. */
  private cursorStats = {
    picks: 0,
    pickMs: 0,
    pickMsTotal: 0,
    /** Frames the cadence declined to pick on -- the denominator that makes `picks` mean anything. */
    skipped: 0,
    stem: 'Point',
    /**
     * Why the last tick resolved as it did: `held` (a dragged ability), `widget` (a frame under the
     * pointer), `nopointer` (nothing has moved yet), `nopick` (the pick found no unit), or the EMPTY
     * STRING when a unit answered -- so an empty `reason` beside a `Point` stem means a real unit
     * classified as Point, which is a different fact from the pick having missed. The gate's arms turn
     * on that distinction.
     */
    reason: '',
  };

  /**
   * One cadence tick of the world cursor.
   *
   * PRECEDENCE IS THE PRESS'S OWN ORDER, which is what keeps the cursor honest about what a click
   * would do: a held cursor item first (a drag is already drawing its own icon at the pointer, and
   * `world-ui.ts#drawCursorIcon` owns that), then `pointerWidget` -- the router's own current hit, so
   * a widget over a wolf reads as the widget exactly as a CLICK on it would (`onWorldClick`'s gate) --
   * then the world pick, then Point.
   */
  private updateHoverCursor(): void {
    const driver = this.cursorDriver;
    if (driver === null) {
      return;
    }
    const flags = window as unknown as Record<string, unknown>;
    if (flags.worldCursorEnabled === false) {
      // THE OFF ARM MUST ACTUALLY BE OFF, and self-review caught this returning with whatever stem was
      // last written still on the element -- a control arm that leaves a sword stuck under the pointer
      // is measuring the ON state and calling it OFF, which is precisely the class of instrument defect
      // `CLAUDE.md` says to distrust. `revert` puts the element's own cursor back, once.
      driver.revert();
      return;
    }
    const now = performance.now();
    const cadence = typeof flags.worldCursorCadenceMs === 'number'
      ? (flags.worldCursorCadenceMs as number)
      : GameScreen.CURSOR_CADENCE_MS;
    if (now - this.lastCursorAt < cadence) {
      this.cursorStats.skipped += 1;
      return;
    }
    this.lastCursorAt = now;

    const stats = this.cursorStats;
    const pointer = this.cursorPointer;
    // A held ability, or a widget under the pointer: neither is a question about the world, and
    // neither costs a pick.
    if (this.ui?.heldCursorItem) {
      stats.reason = 'held';
      stats.stem = 'Point';
      driver.reset();
      // Nothing is hovered while an ability or an item is on the cursor, so nothing stays lit. Beside
      // `driver.reset()` because it answers the same question the cursor just answered.
      this.game.world.setHovered(null);
      return;
    }
    if (pointer === null || this.ui?.pointerWidget) {
      stats.reason = pointer === null ? 'nopointer' : 'widget';
      stats.stem = 'Point';
      driver.reset();
      // The pointer left the world (onto a frame, or off the window): the unit under it stops being
      // hovered, so the brighten drops. Without this a unit would stay lit behind an open panel.
      this.game.world.setHovered(null);
      return;
    }

    const world = this.game.world;
    const bounds = document.body.getBoundingClientRect();
    const ndc = {
      x: ((pointer.x - bounds.left) / bounds.width) * 2 - 1,
      y: -(((pointer.y - bounds.top) / bounds.height) * 2 - 1),
    };
    const started = performance.now();
    const hit = pickUnit(world.entities.values(), this.camera, ndc, world.player, this.pickOptions());
    const pickMs = performance.now() - started;
    stats.picks += 1;
    stats.pickMs = pickMs;
    stats.pickMsTotal += pickMs;

    let mode = CURSOR_POINT;
    if (hit !== null && world.player) {
      const distanceSq = hit.position.distanceToSquared(world.player.position);
      mode = classifyUnitCursor(hit, world.player, {
        distanceSq,
        // Shift alone, which the reference says IS the whole 1.12 mechanism -- there is no auto-loot
        // CVar here because there is no loot code for one to configure.
        autoLoot: this.cursorShift,
        // DECLARED FALSE: nothing in this client decodes a learned profession, so the question "has
        // this character learned Skinning" has no answer. The reference's own rule is that a
        // non-skinner gets NO knife, so false is the arm that shows nothing rather than the arm that
        // shows a knife a click cannot honour.
        knowsSkinning: false,
      }) ?? CURSOR_POINT;
    }
    // THE MOUSEOVER MODEL BRIGHTEN, off the pick this method already made -- a second consumer of one
    // pick rather than a second pick. `World#setHovered` is idempotent, so a cadence tick that lands
    // on the same unit costs one reference compare. See `world/hover-highlight.ts`.
    this.game.world.setHovered(hit);
    stats.reason = hit === null ? 'nopick' : '';
    stats.stem = cursorStem(mode);
    driver.apply(mode);
  }

  private onWorldClick = (ndc: { x: number; y: number }) => {
    if (this.ui?.pointerWidget) {
      return;
    }
    const world = this.game.world;
    const hit = pickUnit(world.entities.values(), this.camera, ndc, world.player, this.pickOptions());
    world.setTarget(hit);
  };

  /**
   * A clean right click on the world: the context action. Attack, when the unit under the cursor is
   * one we can attack.
   *
   * SELECTS FIRST. The reference's own law is stop -> select -> re-swing (`target/scan.rs#commit`,
   * "the one SetSelection law"), and the server refuses `CMSG_ATTACKSWING` on a unit that is not our
   * selection on some cores -- so the two must go out in that order.
   *
   * The reaction gate is `UnitCanAttack`'s and it INCLUDES NEUTRAL -- `benilla/src/target/click.rs:98`
   * gives the Attack cursor as "alive + reaction <= neutral". A critter or an unaggressive beast is
   * attackable and simply does not fight back; only a FRIENDLY unit is not.
   *
   * A FRIENDLY NPC'S RIGHT CLICK IS AN INTERACT, and this method used to end by saying that "this
   * client has no wire path for at all". It has one now -- see `interactCommand` -- so the sentence is
   * replaced rather than left standing over working code.
   */
  private onWorldRightClick = (ndc: { x: number; y: number }) => {
    if (this.ui?.pointerWidget) {
      return;
    }
    const world = this.game.world;
    const hit = pickUnit(world.entities.values(), this.camera, ndc, world.player, this.pickOptions());
    if (!hit) {
      return;
    }
    world.setTarget(hit);
    // A DEAD UNIT'S CONTEXT ACTION IS **LOOT**, not attack, and this is the leg that opens the window.
    //
    // The gate is `UNIT_DYNFLAG_LOOTABLE`, bit **0x1** of `UNIT_DYNAMIC_FLAGS` -- the flag the server
    // sets on a corpse this player is allowed to loot and clears when it is empty. It is already
    // decoded (`unit-fields.ts` keeps `dynamicFlags`), so this needs no new field. Asking the flag
    // rather than merely `hit.dead` is what stops a right click on someone else's kill, or on a corpse
    // already looted, sending a `CMSG_LOOT` the server will only answer with an error.
    //
    // (The bit's value is a SERVER-side definition -- `benilla-protocol/.../probes/loot.rs:72-73`
    // cites `SharedDefines.h` for it -- and is labelled as such, like the `HitInfo` bits.)
    if (hit.dead) {
      if (((hit.fields.dynamicFlags ?? 0) & UNIT_DYNFLAG_LOOTABLE) !== 0) {
        this.game.objectHandler.lootHandler.loot(hit.guid);
      }
      return;
    }
    const reaction = reactionFor(hit, world.player);
    if (reaction !== null && reaction <= REACTION_NEUTRAL) {
      this.game.objectHandler.combatHandler.startAttack(hit.guid);
      return;
    }
    this.interactWith(hit, world);
  };

  /**
   * A FRIENDLY SERVICE NPC'S RIGHT CLICK -- the interact, and the door the merchant window comes
   * through.
   *
   * **The dispatch is the CURSOR's own classification, not a second reading of the flags.** The
   * reference does exactly this: `interact_command(kind, guid, npc_flags)` switches on the already
   * resolved `CursorKind` (`benilla/src/target/click.rs:628-647`), so the picture under the pointer and
   * the packet the click sends can never disagree. `classifyUnitCursor` is the same call the hover path
   * two methods up already makes, with the same options.
   *
   * Two branches, and the reference states the rule
   * (`click.rs:124-139`): a **vendor-only** NPC -- which the ladder classifies `Pickup`, the pouch --
   * opens the stock list directly with `CMSG_LIST_INVENTORY`; every other service kind opens the
   * universal `CMSG_GOSSIP_HELLO` and the client's own `GossipFrame` shows whatever menu comes back.
   *
   * **AND THE DIRECT BRANCH IS LOAD-BEARING ON 3.3.5a, WHERE THE REFERENCE SAYS IT NEED NOT BE.**
   * `click.rs:622-624` justifies routing anything through the hello with "`CMSG_GOSSIP_HELLO` works on
   * any interactable creature (verified: the server passes `UNIT_NPC_FLAG_NONE`)". That is vmangos.
   * TrinityCore 3.3.5's `HandleGossipHelloOpcode` passes **`UNIT_NPC_FLAG_GOSSIP`**
   * (`Handlers/NPCHandler.cpp:150`) and returns silently for a creature without bit 0x1 -- so on this
   * build a hello at a pure vendor is answered with nothing at all, and taking the reference's stated
   * reason at face value would have left the plainest vendors unopenable with no error anywhere.
   *
   * THE RANGE GATE IS THE CURSOR'S. `classifyUnitCursor` marks a service beyond 5.5556 yd `unable`,
   * and nothing is sent then -- there is no auto-approach in this client, so a send would be refused by
   * the server and look like a broken click. The selection still lands, which is the reference's
   * behaviour too (`click.rs:141-143`). A `Point` is not a service and sends nothing.
   */
  private interactWith(hit: Unit, world: World) {
    const distanceSq = hit.position.distanceToSquared(world.player.position);
    const mode = classifyUnitCursor(hit, world.player, {
      distanceSq,
      autoLoot: this.cursorShift,
      // DECLARED FALSE, as on the hover path: nothing decodes a learned profession. It only affects
      // the Skin leg, which is not a service and sends nothing here either way.
      knowsSkinning: false,
    });
    if (mode === null || mode.unable) {
      return;
    }
    const handlers = this.game.objectHandler;
    switch (mode.kind) {
      case 'Pickup':
        // A VENDOR-ONLY NPC. `Pickup` is also the lootable-corpse mode, but a corpse never reaches
        // here -- the dead branch above returns first, which is the same ordering the reference notes.
        handlers.merchantHandler.listInventory(hit.guid);
        break;
      case 'Speak':
      case 'Interact':
      case 'Buy':
      case 'Trainer':
        // Gossip, questgiver, innkeeper, banker, auctioneer, trainer. The banker's and trainer's own
        // windows are separate arcs; the generic hello is faithful and shows whatever menu the server
        // has, which for most vendors in the game includes "Let me browse your goods".
        handlers.gossipHandler.hello(hit.guid);
        break;
      case 'Taxi':
        // The flight master. `CMSG_TAXIQUERYAVAILABLENODES` and the taxi map are their own arc, and the
        // gossip taxi option reaches the same place server-side -- so the hello is the honest send
        // here rather than nothing.
        handlers.gossipHandler.hello(hit.guid);
        break;
      default:
        // `Point`, `Attack`, `Skin`, `LootAll` -- not services. Attack was handled above.
        break;
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
    // The loading screen holds a texture reference and a `window` handle, so it goes with the
    // component for the same reason the pick instrument below does -- a screen that outlived its
    // renderer would draw through a disposed one.
    this.dismissLoadingScreen();
    // THE INSTRUMENT GOES WITH THE COMPONENT. Each closure captures `this` -- this camera, this world --
    // so a handle left on `window` after a remount answers about a disposed renderer's camera and reads
    // as a live measurement. That is this file's own rule two lines down ("Everything this component put
    // somewhere that outlives it"), and the first version of the instrument broke it.
    const flags = window as unknown as Record<string, unknown>;
    for (const key of GameScreen.PICK_INSTRUMENT_KEYS) {
      delete flags[key];
    }
    // THE CURSOR GOES BACK. Left alone, an inline `cursor: url(...)` on `document.body` would outlive
    // this route and follow the user onto the login screen -- and the two instrument handles here
    // capture `this` exactly as the pick's do, so they answer about a dead driver after a remount.
    document.body.removeEventListener('pointermove', this.onCursorPointerMove);
    this.cursorDriver?.dispose();
    this.cursorDriver = null;
    delete flags.worldCursorArt;
    delete flags.worldCursorStats;
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
    this.stats?.dom.parentNode?.removeChild(this.stats.dom);
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
    this.stats?.begin();
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

    // The WORLD pass's counters, read here and not at the bottom of the frame.
    //
    // `renderer.info.render` is reset by every `render()` call, so once a UI pass exists the numbers
    // read at the end of `animate` are the UI's, not the world's -- and the HUD's `calls`/`tris` rows
    // have always meant the world's. Mounting the host silently changed what that row measured
    // (920 -> 372), and the offscreen target changed it again (372 -> 2, the composite quad). This is
    // the instrument being fixed, not the numbers.
    const worldRender = {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };

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

    // THE LOADING SCREEN, over the world AND the interface, and last for that reason. Null once the
    // boot has resolved, so this costs one property read per frame for the rest of the session.
    this.loadingScreen?.render(this.renderer);

    // THE HOVER CURSOR, after the UI pass because it asks the router which widget the pointer is over
    // and that answer is set by the pass that just ran. Cadence-gated -- see `updateHoverCursor`, which
    // does nothing at all on ~5 frames in 6.
    this.perf.sections.begin('ui.cursor');
    this.updateHoverCursor();
    this.perf.sections.end('ui.cursor');

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
        calls: worldRender.calls,
        triangles: worldRender.triangles,
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

      this.stats?.end();
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
          <Controls
            ref={this.controls}
            player={this.game.world.player}
            camera={this.camera}
            onWorldClick={this.onWorldClick}
            onWorldRightClick={this.onWorldRightClick}
            uiCapturedPress={this.uiCapturedPress}
          />
          { this.showDebug && !this.isMobile && <DebugPanel ref={this.debugPanel} renderer={renderer} game={this.game}></DebugPanel>}
          { this.showDebug &&
            // The teleport list. A development control, not a game one -- it worldports the player to
            // a hard-coded spot from `game/world/spots.ts` -- so it belongs behind the same switch as
            // the panels. It is also the loose `<select>` in the corner of every screenshot this
            // project has produced.
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
          }
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
