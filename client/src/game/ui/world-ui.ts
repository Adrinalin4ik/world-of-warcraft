/**
 * THE WORLD'S UI HOST -- the thing whose absence was the whole answer to "I don't see UI".
 *
 * Nothing in `pages/game` imported `game/ui` at all. The glue screens have a host (`GlueApp`,
 * registered from `pages/glue/index.tsx`) and the world simply never got the equivalent, so the
 * widget layer, the Lua VM, the templates, the scripts and the events -- all real and all proven on
 * the glue screens -- had no root, no renderer and no tick in the world. This class is that
 * equivalent, and it is deliberately NOT a second `GlueApp`:
 *
 *  - **It owns no renderer and no canvas.** `GlueApp` constructs a `THREE.WebGLRenderer` because it
 *    IS the page; the world route already has one (`pages/game/index.tsx#componentDidMount`), with
 *    its own `outputColorSpace`, pixel ratio and size. A second renderer would mean a second WebGL
 *    context on the same page, and a second canvas over the world would need its own compositing
 *    decision. So the host is HANDED the renderer and draws into the same buffer.
 *  - **It owns no frame loop.** `GameScreen#animate` is the loop; `render(dt)` below is called from
 *    inside it. Two `requestAnimationFrame` loops would double-advance `worldClock`, which is the
 *    exact hazard `screens.ts:118` warns about in the other direction.
 *  - **It has no screen machine.** There are no in-world `ClientState`s: `FrameXML.toc` builds every
 *    frame at once and which of them is visible is a decision the client's own Lua makes, by
 *    `Show`/`Hide`. That is the same reason `FrameXmlGlueScreen` serves three glue states from one
 *    instance.
 *
 * ## Where it renders relative to the 3D pass
 *
 * AFTER the world render, into the same buffer, with `autoClear = false` -- which `GlueRenderer`
 * sets and restores itself. This is the same arrangement `scene/glue-scene.ts:14-17` records for the
 * glue screens ("We render DIRECTLY into the canvas, first pass, with the widget layer over it"),
 * with the world's own `renderer.render(scene, camera)` standing in for the glue stage. No offscreen
 * target, for the reason that comment gives: a fullscreen render-to-texture would cost a target and
 * a blit, and nothing here shares the result.
 *
 * The ORDER matters and is not interchangeable: the world pass clears (its `autoClear` is on and it
 * sets the clear colour from the map's fog every frame), so a UI pass before it would be erased.
 */
import * as THREE from 'three';

import { GlueArt } from './art';
import { GlueInput } from './input';
import { screenScale } from './layout';
import { GlueRenderer } from './renderer';
import { resolveSprite } from './sprite';
import { FontStringTextures, loadGlueFonts, measureText } from './text';
import { DrawItem, WidgetRoot } from './widget';
import { attachActionBridge } from './action-bridge';
import { attachUnitBridge, seedUnitSnapshots } from './unit-bridge';
import type World from '../world';
import type { WorldRuntime } from './framexml/world-runtime';

/** The offscreen target's clear colour. Fully transparent, so only what the UI draws is composited. */
const TRANSPARENT = new THREE.Color(0, 0, 0);

/**
 * Redraw the target at least this often, whatever the signature says.
 *
 * A SAFETY VALVE, not an optimisation, and it is here because the signature cannot see everything.
 * A texture that arrives after its widget was first drawn (`GlueArt` fetches asynchronously) changes
 * no field the signature reads, and without this the widget would stay blank until something else
 * moved. Twelve frames is a fifth of a second, and it costs one full pass in twelve -- about 0.7 ms
 * per frame amortised at the ~8 ms a full pass measures.
 */
const FULL_DRAW_EVERY = 12;

/**
 * A cheap value fingerprint of the whole draw list.
 *
 * FNV-1a over the fields that decide what a frame LOOKS like: which widget, where, how big, how
 * opaque, which sprite, which sub-rect, which colour, and what text. Numbers are mixed in through
 * their bit patterns rather than stringified, so this allocates nothing -- it runs on every frame and
 * a per-frame string builder for ~350 items would trade one cost for another.
 *
 * A collision means one stale frame until the next change, at roughly 2^-32 per frame. The
 * `FULL_DRAW_EVERY` valve bounds even that to a fifth of a second.
 */
const FLOAT_BITS = new Float64Array(1);
const FLOAT_WORDS = new Uint32Array(FLOAT_BITS.buffer);

function drawListSignature(items: DrawItem[]): number {
  let hash = 0x811c9dc5;
  const mix = (value: number): void => {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  };
  const mixNumber = (value: number): void => {
    FLOAT_BITS[0] = value;
    mix(FLOAT_WORDS[0]);
    mix(FLOAT_WORDS[1]);
  };
  const mixText = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      mix(text.charCodeAt(i));
    }
  };

  mixNumber(items.length);
  for (const item of items) {
    mixText(item.widget.id);
    mixNumber(item.rect.left);
    mixNumber(item.rect.top);
    mixNumber(item.rect.width);
    mixNumber(item.rect.height);
    mixNumber(item.alpha);
    mixText(item.widget.vertexColor);
    if (item.widget.sprite) {
      mixText(item.widget.sprite);
    }
    if (item.widget.kind === 'fontstring') {
      mixText(item.widget.displayText);
    }
    const tc = item.texCoords ?? item.widget.texCoords ?? null;
    if (tc) {
      mixNumber(tc.u0);
      mixNumber(tc.v0);
      mixNumber(tc.u1);
      mixNumber(tc.v1);
    }
  }
  return hash;
}

/** `?ui=lua` -- the same switch `pages/glue/index.tsx` reads, and for the same reason. */
export function wantsLuaUi(search: string): boolean {
  return new URLSearchParams(search).get('ui') === 'lua';
}

/**
 * Just enough of `perf/cpu-sections.ts` for this host to report its own breakdown, as an interface
 * so `game/ui` does not depend on `game/perf`. `GameScreen` passes its real `CpuSections`; the tests
 * and `/game?offline=1` pass nothing.
 *
 * Sub-spans exist because "the UI pass costs N ms" is not actionable and the first measurement of it
 * was 12.2 ms against a 16.7 ms budget. `ui.layout`, `ui.tick` and `ui.draw` are the three halves of
 * that number and they behave completely differently: layout is a walk of 4211 widgets, tick is the
 * button art poll, draw is the three.js pass.
 */
export interface UiSections {
  begin(name: string): void;
  end(name: string): void;
}

export class WorldUiHost {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly ui: GlueRenderer;
  private readonly input: GlueInput;
  private readonly art = new GlueArt();
  private readonly fonts = new FontStringTextures();
  private readonly root = new WidgetRoot();

  private runtime: WorldRuntime | null = null;
  /**
   * Set by `dispose()`. `start()` awaits fonts and then a 20-second manifest load, so a route change
   * during either resumes into a torn-down host -- the same hazard `GlueApp#stopped` guards, and here
   * the await is two orders of magnitude longer.
   */
  private stopped = false;

  /** A 1x1 white texel for a `solid` widget. Lazy, shared, disposed with the host. */
  private solidTexture: THREE.DataTexture | null = null;

  private readonly sections: UiSections;

  /**
   * The world whose units feed the unit frames, or null.
   *
   * OPTIONAL because two callers have no world to give: the jest suites, and any future host that
   * wants the tree without a session. A null world simply means no token is ever occupied, which is
   * the same state `TargetFrame` is correctly hidden in today.
   */
  private readonly world: World | null;

  /** `attachActionBridge`'s teardown, held so `dispose` can run it. */
  private detachActions: (() => void) | null = null;

  /** `attachUnitBridge`'s teardown, held so `dispose` can run it. */
  private detachUnits: (() => void) | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    canvas: HTMLCanvasElement,
    sections?: UiSections,
    world?: World | null,
  ) {
    this.world = world ?? null;
    this.renderer = renderer;
    // PREMULTIPLIED, because this pass draws into a transparent offscreen target -- see
    // `renderer.ts#GlueRenderer.premultiplied` and `composite` below.
    this.ui = new GlueRenderer(renderer, true);
    this.input = new GlueInput(canvas);
    this.sections = sections ?? { begin: () => undefined, end: () => undefined };
  }

  /** The live runtime, or null while it is still booting. For the console handle and the report. */
  get loaded(): WorldRuntime | null {
    return this.runtime;
  }

  /**
   * The widget under the pointer, or null when the pointer is over the world.
   *
   * The world's click-to-target path asks this before picking a unit; see `GlueInput#pointerWidget`
   * for why the router's own hit is the right source rather than a second test.
   */
  get pointerWidget(): unknown {
    return this.input.pointerWidget;
  }

  /**
   * Load the fonts and boot the client's own `FrameXML.toc` onto this host's root.
   *
   * The dynamic `import()` is `framexml-screen.ts`'s decision repeated for the same reason: the
   * runtime pulls in fengari, a whole Lua VM, and a value import would put it in the world route's
   * main bundle for every visitor -- including the default `/game`, which does not use it.
   */
  async start(): Promise<void> {
    this.input.attach();
    await loadGlueFonts();
    if (this.stopped) {
      return;
    }

    const { bootWorldRuntime } = await import('./framexml/world-runtime');
    if (this.stopped) {
      return;
    }
    const runtime = await bootWorldRuntime({
      root: this.root.root,
      art: this.art,
      input: this.input,
      // The player's snapshot BEFORE the manifest runs, because several documents read unit state in
      // their `OnLoad` and one of them (`MainMenuExpBar`) hides itself for good on a zero. See
      // `unit-bridge.ts#seedUnitSnapshots`. Snapshots only -- the events still come from the bridges
      // below, which need the tree to exist.
      seed: this.world ? (vm) => seedUnitSnapshots(vm, this.world as World) : undefined,
    });
    if (this.stopped) {
      // Superseded by a teardown that ran while the manifest was loading. This boot's runtime is
      // nobody's and this is the only reference to it.
      runtime.dispose();
      return;
    }
    this.runtime = runtime;
    // THE UNIT FEED, attached the instant the tree exists and not before: `attachUnitBridge` fires
    // `PLAYER_ENTERING_WORLD` on the way in, and a frame that has not been built yet cannot have
    // registered for it. The world is optional so `/game?offline=1&ui=lua` -- which has units but no
    // server, and is where every UI measurement is taken -- still boots.
    if (this.world) {
      this.detachUnits = attachUnitBridge(runtime.vm, this.world);
      // THE ACTION FEED. Gated on a real session as well as a world: `/game?offline=1&ui=lua` has units
      // but no protocol, and `session.offline` short-circuits ahead of the `protocol` getter -- reading
      // `game.objectHandler` there would construct transports the offline route contracts never to
      // touch. An offline world therefore keeps its 12 buttons hidden, which is honest: there is no
      // server to have sent an action bar.
      if (!this.world.session.offline) {
        this.detachActions = attachActionBridge(runtime.vm, this.world, this.art);
      }
    }
    reportLoad(runtime);
    // The console handle, exactly as the glue side has one. `worldRuntime.vm.run('...')` against the
    // tree that is on screen is the only way to interrogate a frame a screenshot cannot answer for.
    (window as never as Record<string, unknown>).worldRuntime = runtime;
    // THE ART TABLE, as a second handle, because "the icon is not on screen" has three distinct causes
    // that no screenshot separates: the Lua never set a sprite, the sprite was set but never registered
    // (see `manifest.ts#registerTreeArt` -- registration runs once, after the load), or it was
    // registered and the BLP failed to fetch. `worldUiArt.def(path)` and `worldUiArt.texture(path)`
    // answer the second and third directly. This is how the empty action bar was found.
    (window as never as Record<string, unknown>).worldUiArt = this.art;
  }

  /**
   * One frame of UI: the runtime's own per-frame work, the layout/draw list, and the pass.
   *
   * Called from `GameScreen#animate` AFTER `renderer.render(scene, camera)`. Returns immediately
   * while the manifest is still loading, which is most of the first 20 seconds in the world.
   */
  render(dt: number): void {
    if (this.runtime === null) {
      return;
    }
    this.sections.begin('ui.tick');
    this.runtime.update(dt);
    this.sections.end('ui.tick');

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // `measureText` is what fills in an unsized FONT STRING's rect (`widget.ts#deriveSize`) -- the
    // same measurement `resolveSprite` rasterizes at, so what is anchored to a label and what is
    // painted for it cannot disagree.
    this.sections.begin('ui.layout');
    const items = this.root.drawList(viewport, measureText);
    this.sections.end('ui.layout');
    this.input.setDrawList(items);
    // THE LAST DRAW LIST, as a console handle. The router hit-tests this exact array, so it is the only
    // authoritative answer to "is that widget on screen, and where" -- a screenshot cannot say whether a
    // quad is missing or merely transparent, and `registry.widget(id)` has no rect (the layout pass
    // computes rects, it does not store them). It is what let a probe put a REAL pointer click on
    // `BonusActionButton2` instead of calling its handler directly. One reference assignment per frame.
    (window as never as Record<string, unknown>).worldUiDrawList = items;
    const scale = screenScale(viewport.height);

    this.sections.begin('ui.draw');
    // Re-render the OFFSCREEN target only when the interface actually changed; composite it every
    // frame with one quad. See `signature` and `target` for the measurement that forced this.
    const signature = drawListSignature(items);
    const target = this.target();
    if (
      target !== null &&
      (signature !== this.lastSignature || this.framesSinceFullDraw >= FULL_DRAW_EVERY)
    ) {
      this.lastSignature = signature;
      this.framesSinceFullDraw = 0;
      const previousTarget = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(target);
      // The target starts EMPTY every time. `GlueRenderer` deliberately draws with `autoClear =
      // false` (it is a layer over something else on the glue screens), so nothing else would.
      this.renderer.setClearColor(TRANSPARENT, 0);
      this.renderer.clear(true, false, false);
      this.ui.render(items, (item) =>
        resolveSprite(item, scale, { art: this.art, fonts: this.fonts, solid: () => this.solid() }),
      );
      this.renderer.setRenderTarget(previousTarget);
      // The world pass sets its own clear colour from the map's fog at the top of every frame
      // (`pages/game/index.tsx#animate`), so nothing has to be restored here -- but leaving a
      // transparent clear colour behind would be a trap for anything that clears between the two.
      this.renderer.setClearColor(this.savedClearColor, this.savedClearAlpha);
    } else {
      this.framesSinceFullDraw += 1;
    }
    this.composite();
    this.sections.end('ui.draw');
  }

  // -----------------------------------------------------------------------------------------------
  // The offscreen target, and why the UI is not drawn straight into the canvas the way the glue
  // screens draw theirs.
  //
  // MEASURED, on the owner's machine (RTX 4070 laptop, Chrome/ANGLE/D3D11) at 1382x911:
  //
  //   * `ui.draw` was 11.9 ms of a 12.2 ms UI pass, and `ui.tick` + `ui.layout` together were 1.1 ms.
  //     The pass is its draw calls and nothing else.
  //   * Hiding every UI mesh took the same scene from 18.3 ms to 0.1 ms, and hiding half took it to
  //     8.9 ms -- exactly linear in the number of drawn quads (`W5.json`).
  //   * Shrinking every quad to one pixel changed nothing (18.5 ms, `W6.json`), so it is not fill
  //     rate. Sharing one material and one geometry across all of them changed nothing either
  //     (15.7 ms, `W7.json`), so it is not material or program switching.
  //
  // That leaves the draw call itself, at roughly 35 us each, and the only thing that helps is
  // issuing fewer of them. Order-preserving batching by texture was measured too and is NOT enough:
  // 460 quads collapse into 219 consecutive same-texture runs (`W8.json`), a 2.1x ceiling.
  //
  // So the interface is rendered into a target and composited with ONE quad, and the target is only
  // re-rendered when the draw list changes. The default world UI is static -- no `OnUpdate` is
  // dispatched (see `world-runtime.ts`) and nothing moves between events -- so in the steady state
  // this is one draw call instead of ~230.
  //
  // `scene/glue-scene.ts:14-17` explains why the GLUE path does the opposite ("a fullscreen
  // render-to-texture would cost a target and a blit for nothing"). That reasoning is still right
  // there: the glue draw list is ~100 items, so the blit would cost more than it saved. It is the
  // item count that flips the answer, not a change of mind.
  //
  // ONE FIDELITY COST, stated rather than hidden: a widget authored `alphaMode="ADD"` is now
  // additive against the rest of the INTERFACE inside the target, and the target as a whole is
  // composited over the world with normal blending. Drawn straight into the canvas it would have
  // been additive against the world too. Nothing in the default in-world UI has been shown to
  // depend on that; `GameTooltip`'s and the action buttons' glows are additive over other UI art,
  // which is preserved exactly.
  // -----------------------------------------------------------------------------------------------

  /** How often the target is re-rendered even when the signature says nothing changed. */
  private framesSinceFullDraw = 0;
  private lastSignature = -1;
  private renderTarget: THREE.WebGLRenderTarget | null = null;
  private compositeScene: THREE.Scene | null = null;
  private compositeCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1);
  private compositeMesh: THREE.Mesh | null = null;
  private savedClearColor = new THREE.Color();
  private savedClearAlpha = 1;

  /** The target at the drawing buffer's current size, rebuilt when the window resizes. */
  private target(): THREE.WebGLRenderTarget | null {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x < 1 || size.y < 1) {
      return null;
    }
    if (this.renderTarget === null) {
      this.renderTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        // Nothing in the UI pass depths-tests (`material.ts` turns it off), so neither buffer is
        // needed and both would cost memory at full screen size.
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.renderTarget.texture.generateMipmaps = false;
    } else if (this.renderTarget.width !== size.x || this.renderTarget.height !== size.y) {
      this.renderTarget.setSize(size.x, size.y);
      // A resized target holds nothing; the next frame must redraw whatever the signature says.
      this.lastSignature = -1;
    }
    this.renderer.getClearColor(this.savedClearColor);
    this.savedClearAlpha = this.renderer.getClearAlpha();
    return this.renderTarget;
  }

  /** One fullscreen quad of the target, over the world, premultiplied. */
  private composite(): void {
    if (this.renderTarget === null) {
      return;
    }
    if (this.compositeScene === null) {
      const material = new THREE.MeshBasicMaterial({
        map: this.renderTarget.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // The target holds PREMULTIPLIED rgba (`GlueRenderer.premultiplied`), so the composite must
        // blend `(ONE, ONE_MINUS_SRC_ALPHA)` -- which is what three selects for `NormalBlending`
        // when the material declares this. Straight alpha here would darken every blended edge by a
        // second multiply.
        premultipliedAlpha: true,
        // The same winding argument `material.ts` makes: this camera is not Y-flipped, but a render
        // target's texture is bottom-up, so the quad is built to match and culling buys nothing.
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.name = 'WorldUiComposite';
      scene.add(mesh);
      this.compositeScene = scene;
      this.compositeMesh = mesh;
    }
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.compositeScene, this.compositeCamera);
    this.renderer.autoClear = previousAutoClear;
  }

  private solid(): THREE.DataTexture {
    if (!this.solidTexture) {
      this.solidTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.solidTexture.needsUpdate = true;
    }
    return this.solidTexture;
  }

  /**
   * Everything this host put somewhere that outlives it.
   *
   * The renderer is NOT disposed here: it belongs to `GameScreen`, which disposes it itself. Freeing
   * a renderer this host was merely lent would take the world's own pass down with it.
   */
  dispose(): void {
    this.stopped = true;
    this.detachUnits?.();
    this.detachUnits = null;
    this.detachActions?.();
    this.detachActions = null;
    this.input.detach();
    this.runtime?.dispose();
    this.runtime = null;
    this.ui.dispose();
    this.renderTarget?.dispose();
    this.renderTarget = null;
    if (this.compositeMesh) {
      this.compositeMesh.geometry.dispose();
      (this.compositeMesh.material as THREE.Material).dispose();
    }
    this.compositeScene = null;
    this.compositeMesh = null;
    this.fonts.dispose();
    this.art.dispose();
    this.solidTexture?.dispose();
    this.solidTexture = null;
    delete (window as never as Record<string, unknown>).worldRuntime;
    delete (window as never as Record<string, unknown>).worldUiArt;
    delete (window as never as Record<string, unknown>).worldUiDrawList;
  }
}

/**
 * The load report, on the console, flat -- `screens/framexml-screen.ts#reportLoad`'s twin.
 *
 * Flat lines and a table, not `console.log('report', object)`: a collapsed object row is invisible
 * until expanded and copies as nothing, which would make the most useful output of this whole
 * exercise the one part that cannot be pasted into a bug report.
 *
 * The per-file table is `console.table`d as on the glue side, but the ERROR lines are capped: 1151
 * of them at one `console.error` each is a console nobody can read and, measured, several seconds of
 * main thread. The full arrays are on `window.worldRuntime.report`.
 */
const REPORTED_ERRORS = 40;

function reportLoad(runtime: WorldRuntime): void {
  const { report, files, loadMs } = runtime;
  console.log(
    `framexml(world): ${report.frames} frames from ${files.length} files, ` +
      `${report.warnings.length} warnings, ${report.errors.length} errors, ` +
      `${loadMs.toFixed(0)} ms`,
  );
  console.table(
    files.map((file) => ({
      file: file.file,
      kind: file.kind,
      frames: file.frames,
      warnings: file.warnings.length,
      errors: file.errors.length,
    })),
  );
  report.warnings.forEach((warning, index) =>
    console.warn(`framexml(world) warning ${index + 1}: ${warning}`),
  );
  report.errors.slice(0, REPORTED_ERRORS).forEach((error, index) => {
    console.error(`framexml(world) error ${index + 1}: ${error}`);
  });
  if (report.errors.length > REPORTED_ERRORS) {
    console.error(
      `framexml(world): ${report.errors.length - REPORTED_ERRORS} further errors not printed -- ` +
        'the whole list is on `window.worldRuntime.report.errors`',
    );
  }
}
