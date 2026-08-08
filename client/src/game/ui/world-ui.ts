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
import { WidgetRoot } from './widget';
import type { WorldRuntime } from './framexml/world-runtime';

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

  constructor(
    renderer: THREE.WebGLRenderer,
    canvas: HTMLCanvasElement,
    sections?: UiSections,
  ) {
    this.renderer = renderer;
    this.ui = new GlueRenderer(renderer);
    this.input = new GlueInput(canvas);
    this.sections = sections ?? { begin: () => undefined, end: () => undefined };
  }

  /** The live runtime, or null while it is still booting. For the console handle and the report. */
  get loaded(): WorldRuntime | null {
    return this.runtime;
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
    });
    if (this.stopped) {
      // Superseded by a teardown that ran while the manifest was loading. This boot's runtime is
      // nobody's and this is the only reference to it.
      runtime.dispose();
      return;
    }
    this.runtime = runtime;
    reportLoad(runtime);
    // The console handle, exactly as the glue side has one. `worldRuntime.vm.run('...')` against the
    // tree that is on screen is the only way to interrogate a frame a screenshot cannot answer for.
    (window as never as Record<string, unknown>).worldRuntime = runtime;
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
    const scale = screenScale(viewport.height);
    this.sections.begin('ui.draw');
    this.ui.render(items, (item) =>
      resolveSprite(item, scale, { art: this.art, fonts: this.fonts, solid: () => this.solid() }),
    );
    this.sections.end('ui.draw');
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
    this.input.detach();
    this.runtime?.dispose();
    this.runtime = null;
    this.ui.dispose();
    this.fonts.dispose();
    this.art.dispose();
    this.solidTexture?.dispose();
    this.solidTexture = null;
    delete (window as never as Record<string, unknown>).worldRuntime;
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
