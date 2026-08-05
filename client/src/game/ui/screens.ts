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
import { GlueInput } from './input';
import { GlueRenderer, ResolvedSprite } from './renderer';
import { GlueSceneView } from './scene/glue-scene';
import { GlueScene } from './scene/tokens';
import { GlueStrings } from './strings';
import { FontStringTextures, loadGlueFonts } from './text';
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

  private frame = 0;
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement, session: GameSession) {
    this.canvas = canvas;
    this.session = session;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
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

    // Fonts and strings first: a screen that mounts before them draws unreadable labels.
    await Promise.all([loadGlueFonts(), GlueStrings.load().then((s) => (this.strings = s))]);

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
    this.pending = target;
  };

  private enter(state: ClientState): void {
    const screen = this.screens.get(state);
    if (!screen) {
      console.warn(`no glue screen registered for ${state}`);
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
    this.sceneView.update(dt);
    this.sceneView.render();

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const items = this.current.root.drawList(viewport);
    this.input.setDrawList(items);

    this.ui.render(items, (item) => this.resolveSprite(item, screenScale(viewport.height)));
  };

  /** A widget's texture: a font string rasterizes, everything else comes from the art table. */
  private resolveSprite(item: DrawItem, scale: number): ResolvedSprite | null {
    const widget = item.widget;

    if (widget.kind === 'fontstring') {
      // `displayText`, not `text`: password masking (`Widget#displayText`) lives here, at the one
      // place a fontstring's content actually turns into glyphs.
      return widget.font ? this.fonts.get(widget.displayText, widget.font, scale) : null;
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
