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

import { GlueArt } from './art';
import { GlueInput } from './input';
import { GlueRenderer } from './renderer';
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

  private strings: GlueStrings | null = null;
  private screens = new Map<ClientState, GlueScreen>();
  private current: { state: ClientState; screen: GlueScreen; root: WidgetRoot } | null = null;
  private pending: ClientState | null = null;

  private frame = 0;
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.ui = new GlueRenderer(this.renderer);
    this.input = new GlueInput(canvas);
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
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.resize);
    this.input.detach();
    this.current?.screen.unmount();
    this.current = null;
    this.ui.dispose();
    this.fonts.dispose();
    this.art.dispose();
    this.renderer.dispose();
  }

  private resize = (): void => {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
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
      go: (next) => {
        this.pending = next;
      },
    };

    screen.mount(ctx);
    this.current = { state, screen, root };
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);

    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      this.enter(next);
    }

    if (!this.current) {
      return;
    }

    this.current.screen.update(dt);

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const items = this.current.root.drawList(viewport);
    this.input.setDrawList(items);

    this.renderer.clear();
    this.ui.render(items, (item) => this.resolveSprite(item, screenScale(viewport.height)));
  };

  /** A widget's texture: a font string rasterizes, everything else comes from the art table. */
  private resolveSprite(item: DrawItem, scale: number): THREE.Texture | null {
    const widget = item.widget;

    if (widget.kind === 'fontstring') {
      return widget.font ? this.fonts.get(widget.text, widget.font, scale) : null;
    }

    return widget.sprite ? this.art.texture(widget.sprite) : null;
  }
}
