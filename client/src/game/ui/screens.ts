/**
 * The client lifecycle machine and the glue app loop.
 *
 * `ClientState` mirrors the reference's own (benilla `char_select/mod.rs`): the pre-world glue
 * layer and the world are STATES, not routes -- which is why a screen never navigates, it asks the
 * machine to change state.
 *
 * A screen is a plain module. It knows nothing about React, routing, or the other screens.
 */
import * as THREE from 'three';

import { worldClock } from '../pipeline/m2/anim/world-clock';
import { GameSession } from '../../network/session';
import { ProtocolSession, SessionState } from '../../network/protocol/session';
import { GlueArt } from './art';
import { clientStateForStage } from './screens/login-state';
import { installFramexmlDebug } from './framexml/debug';
import { GlueInput } from './input';
import { GlueRenderer, ResolvedSprite } from './renderer';
import { GlueSceneView } from './scene/glue-scene';
import { GlueScene } from './scene/tokens';
import { GlueStrings } from './strings';
import { FontStringTextures, loadGlueFonts, measureText } from './text';
import { DrawItem, WidgetRoot } from './widget';
import { screenScale } from './layout';

export enum ClientState {
  Login = 'Login',
  RealmList = 'RealmList',
  CharSelect = 'CharSelect',
  CharCreate = 'CharCreate',
  InWorld = 'InWorld',
}

export interface GlueContext {
  root: WidgetRoot;
  art: GlueArt;
  strings: GlueStrings;
  input: GlueInput;
  /** The session facade (§4.7) -- the same `GameSession` every other route is handed. Nothing in
   * this spec consumes it yet; the login screen (spec 3) is the first screen that will. */
  session: GameSession;
  /** The typed pre-world session (spec 2). The login screen (spec 3) is its first consumer. */
  protocol: ProtocolSession;
  /** Show a glue background scene, or null to tear it down. */
  setScene(scene: GlueScene | null): void;
  /** Request a state change; takes effect before the next frame. */
  go(state: ClientState): void;
}

export interface GlueScreen {
  mount(ctx: GlueContext): void;
  update(dt: number): void;
  unmount(): void;
}

export class GlueApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly ui: GlueRenderer;
  private readonly fonts = new FontStringTextures();
  private readonly art = new GlueArt();
  private readonly input: GlueInput;
  private readonly sceneView: GlueSceneView;
  private readonly session: GameSession;

  private strings: GlueStrings | null = null;
  private screens = new Map<ClientState, GlueScreen>();
  private current: { state: ClientState; screen: GlueScreen; root: WidgetRoot } | null = null;
  private pending: ClientState | null = null;
  /** The session subscription's unsubscribe, held so `stop()` can drop it. */
  private unsubscribeSession: (() => void) | null = null;
  /**
   * Set by `stop()`. `start()` awaits font and string loading, so a route change during that await
   * runs `stop()` first and `start()` resumes afterwards into a torn-down app -- subscribing a
   * listener nothing will ever drop and arming a frame loop nothing will ever cancel.
   */
  private stopped = false;

  private frame = 0;
  private lastTime = 0;
  /** The last stage-render failure reported, so a per-frame throw is one console line and not a flood. */
  private lastSceneError: string | null = null;

  constructor(canvas: HTMLCanvasElement, session: GameSession) {
    this.canvas = canvas;
    this.session = session;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    // The gamma-passthrough lane this whole client runs on, the same line `pages/game/index.tsx`
    // sets for the world renderer. BLP texels and the client's shaders are already sRGB-encoded, and
    // r152 changed the default to `SRGBColorSpace`, which converts linear->sRGB on output and so
    // brightens every already-encoded texel: the glue scene washed out to milky cyan, `-Blue` button
    // art that is dark navy in the sheet drew pale, and the font rasters lost their contrast (which
    // reads as blur). Nothing here is authored in linear space, so there is nothing to convert.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.ui = new GlueRenderer(this.renderer);
    this.input = new GlueInput(canvas);
    this.sceneView = new GlueSceneView(this.renderer);
  }

  register(state: ClientState, screen: GlueScreen): void {
    this.screens.set(state, screen);
  }

  async start(initial: ClientState): Promise<void> {
    this.resize();
    window.addEventListener('resize', this.resize);
    this.input.attach();

    // The FrameXML document layer has no callers until the Lua runtime lands, so this console hook is
    // the only way to run it against the client's real files rather than against test fixtures.
    // Same idea as `skyDebug`, and the same place to remove it from when the loader makes it moot.
    installFramexmlDebug();

    // Fonts and strings first: a screen that mounts before them draws unreadable labels.
    await Promise.all([loadGlueFonts(), GlueStrings.load().then((s) => (this.strings = s))]);

    if (this.stopped) {
      return;
    }

    this.enter(initial);

    // THE path past the login screen. Nothing else advances this machine: the session is the only
    // thing that knows a login succeeded, a realm was joined or the roster arrived, so without this
    // subscription a correct login would sit on the login screen forever. Subscribed AFTER the initial
    // `enter`, so the first emission compares against a real current state rather than against
    // nothing and immediately re-entering the screen just mounted.
    this.unsubscribeSession = this.session.protocol.on(this.onSessionState);

    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resize);
    this.input.detach();
    // One leaked listener per mounted app is a real leak, and a listener left on a live session would
    // go on asking a torn-down app to change screens.
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.current?.screen.unmount();
    this.current = null;
    // Cancels any pending 3 s login retry and stops the machine reacting further -- otherwise a
    // timer scheduled by a login attempt in flight when this app is torn down fires into a dead
    // object.
    this.session.protocol.stop();
    this.sceneView.dispose();
    this.ui.dispose();
    this.fonts.dispose();
    this.art.dispose();
    this.solidTexture?.dispose();
    this.solidTexture = null;
    this.renderer.dispose();
  }

  private resize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  /**
   * The session moved: mount whatever state that stage means.
   *
   * Only when it DIFFERS from what is already up or already queued. The session emits on every stage
   * change, and several land in one turn (`Connecting` then `Authenticating`); re-requesting the state
   * already showing would rebuild that screen under the player -- losing focus, typed text and the
   * dialog -- on every emission.
   */
  private onSessionState = (state: SessionState): void => {
    const target = clientStateForStage(state.stage);
    if (target === (this.pending ?? this.current?.state)) {
      return;
    }
    // A state with no screen registered has nowhere to go, and `enter` leaves `current` where it was.
    // Queueing it anyway would re-queue on every later emission and warn once per emission, since the
    // guard above would never see it as current.
    if (!this.screens.has(target)) {
      return;
    }
    this.pending = target;
  };

  private enter(state: ClientState): void {
    const screen = this.screens.get(state);
    if (!screen) {
      console.warn(`no glue screen registered for ${state}`);
      return;
    }

    // ONE screen instance may be registered for SEVERAL states, and then a transition between them is
    // not a remount.
    //
    // This is the glue layer's own shape, not a convenience. In the client there is one screen hosting
    // every glue frame and `GlueParent` shows or hides `AccountLogin`, `RealmList`, `CharacterSelect` in
    // turn -- `RealmList` is not even a `GlueScreenInfo` entry (glueparent.lua:11-19): it is a
    // `frameStrata="DIALOG"` frame that `RealmList_OnEvent` shows over the login screen when
    // `OPEN_REALM_LIST` arrives. A screen that serves both states therefore has nothing to rebuild, and
    // rebuilding it would be actively wrong: the FrameXML screen's whole Lua VM would be torn down and
    // rebooted, every `OnLoad` would re-run, and the saved account name and every Lua-side field
    // (`RealmList.selectedCategory`, `RealmList.offset`) would be lost for a transition the client does
    // with two `Show`/`Hide` calls.
    //
    // Identity, not equality of state: the hand-written screens register a DIFFERENT instance per state,
    // so `/` takes the unmount-and-remount path below exactly as it always has.
    if (this.current !== null && this.current.screen === screen) {
      this.current.state = state;
      return;
    }

    this.current?.screen.unmount();
    this.input.reset();

    const root = new WidgetRoot();
    const ctx: GlueContext = {
      root,
      art: this.art,
      strings: this.strings!,
      input: this.input,
      session: this.session,
      protocol: this.session.protocol,
      setScene: (scene) => this.sceneView.setScene(scene),
      go: (next) => {
        this.pending = next;
      },
    };

    // A screen that wants no scene gets none, and a screen that wants one asks on mount.
    this.sceneView.setScene(null);
    screen.mount(ctx);
    this.current = { state, screen, root };
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);

    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // `world-clock.ts` documents `World#animate` as the clock's one advance site, but the glue app
    // is a SEPARATE frame loop that never runs concurrently with the world -- they are different
    // routes, and the glue app is torn down before the game screen mounts. This is the glue side's
    // own advance site: the scene view arms instances against `worldClock.ms` and would otherwise
    // sample a permanently frozen clock, since `World#animate` never runs while a glue screen is up.
    // NOTE for whoever wires the `InWorld` transition: that non-concurrency is true today but
    // UNENFORCED -- nothing stops both loops running at once. Do not start `World#animate` before
    // this loop has stopped (`GlueApp#stop`), or the clock will be double-advanced.
    worldClock.advance(dt);

    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.enter(next);
    }

    if (!this.current) {
      return;
    }

    this.current.screen.update(dt);

    this.renderer.clear();
    // THE 3D STAGE MAY NOT TAKE THE UI DOWN WITH IT.
    //
    // The UI pass runs after the stage pass in the same callback, so an exception here used to abort
    // the rest of the tick -- and the whole 2D interface vanished while the partly-drawn stage stayed
    // on screen, with nothing on it to say why. That was not hypothetical: `UI_Human`, the character
    // screen's own stage, has two batches (the GROUNDSHADOW decals on submeshes 1 and 2) that resolve
    // to the `Diffuse_T2` vertex shader, which had no entry in `M2Material.VERTEX_SHADERS`. Their
    // material reached three.js with `vertexShader === undefined` and `WebGLProgram` threw on every
    // frame, so `/?ui=lua` reached character select with a correct 368-frame widget tree, correct
    // rects and not one pixel of UI drawn.
    //
    // That specific gap is closed (`m2/material/vertex/diffuse-t2.glsl`), and a measured sweep of all
    // eleven `UI_*` glue stages says none of them names any other missing shader. This guard stays
    // anyway: it is not about `Diffuse_T2`, it is about the stage pass and the UI pass sharing one
    // callback, and the next stage the client asks for may not be one of those eleven.
    //
    // Warned ONCE by message, because a per-frame throw is a per-frame console line otherwise, and the
    // one line that matters is drowned by its own repetition. The underlying M2 gap is a
    // pipeline-layer fix and is deliberately NOT made here; this only stops one layer's failure from
    // being reported as the other layer's.
    try {
      this.sceneView.update(dt);
      this.sceneView.render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.lastSceneError !== message) {
        this.lastSceneError = message;
        console.error(`glue: the background stage failed to render; the UI still draws. ${message}`);
      }
    }

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // `measureText` is what fills in an unsized FONT STRING's rect (`widget.ts#deriveSize`) -- the
    // same measurement `resolveSprite` below rasterizes at, so what is anchored to a label and what
    // is painted for it cannot disagree.
    const items = this.current.root.drawList(viewport, measureText);
    this.input.setDrawList(items);

    this.ui.render(items, (item) => this.resolveSprite(item, screenScale(viewport.height)));
  };

  /**
   * A 1x1 white texel, for a `solid` widget (the edit-box caret). Lazy, shared, and disposed with
   * the app -- it is not `GlueArt`'s because it is not client art: it is the minimum a
   * `MeshBasicMaterial` needs in order to draw a flat `vertexColor` quad.
   */
  private solidTexture: THREE.DataTexture | null = null;

  private solid(): THREE.DataTexture {
    if (!this.solidTexture) {
      this.solidTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.solidTexture.needsUpdate = true;
    }
    return this.solidTexture;
  }

  /** A widget's texture: a font string rasterizes, everything else comes from the art table. */
  private resolveSprite(item: DrawItem, scale: number): ResolvedSprite | null {
    const widget = item.widget;

    if (widget.kind === 'fontstring') {
      // `displayText`, not `text`: password masking (`Widget#displayText`) lives here, at the one
      // place a fontstring's content actually turns into glyphs.
      return widget.font ? this.fonts.get(widget.displayText, widget.font, scale) : null;
    }

    // A flat colour quad -- the caret. `vertexColor` does the colouring; the texel is just a carrier.
    if (widget.solid) {
      return { texture: this.solid() };
    }

    // A `Backdrop` carries two sheets and is drawn as nine pieces by the renderer, so it resolves
    // both rather than one `sprite`.
    //
    // Keyed off the DEF, never off `kind`. In FrameXML a `Backdrop` is a PROPERTY of a frame, and a
    // frame of any type may carry one -- the login screen's are on three `EditBox`es and one `Frame`.
    // Gating this on `kind === 'backdrop'` meant all three edit boxes (kind `editbox`, carrying a
    // Backdrop) fell through to the sprite path, where their `sprite` is null, so this returned null
    // and the renderer skipped the widget: no border on screen and no warning anywhere, because
    // nothing had failed to load. The `backdrop` WidgetKind is only "a frame that is nothing BUT its
    // Backdrop" (the dialog); it is not what selects this path.
    if (widget.backdrop) {
      const def = widget.backdrop;
      const background = def.bgSprite ? this.art.texture(def.bgSprite) : null;
      const edge = def.edgeSprite ? this.art.texture(def.edgeSprite) : null;
      if (!background && !edge) {
        return null;
      }
      return { backdrop: { background, edge } };
    }

    const texture = widget.sprite ? this.art.texture(widget.sprite) : null;
    if (!texture) {
      return null;
    }

    // The sub-rect travels with the SPRITE, not the widget: `GlueButtonTemplateBlue` names one
    // region of `Glue-Panel-Button-Up-Blue` for every button that inherits it, so the art table is
    // where it belongs. Without this the whole 256x64 sheet stretched into the widget's rect and
    // every glue button drew as a thin bar of blue with two thirds of the quad empty.
    return { texture, texCoords: this.art.def(widget.sprite as string)?.texCoords ?? null };
  }
}
