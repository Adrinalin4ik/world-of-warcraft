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
import { screenScale, viewportUnits } from './layout';
import { GlueRenderer } from './renderer';
import { resolveSprite } from './sprite';
import { FontStringTextures, layoutScale, loadGlueFonts, measureText, wrapLines } from './text';
import { DrawItem, WidgetRoot, effectiveFont } from './widget';
import { attachActionBridge } from './action-bridge';
import { attachSpellbookBridge } from './spellbook-bridge';
import { attachContainerBridge } from './container-bridge';
import { attachPaperDollStats } from './paperdoll-stats';
import { attachSkillsBridge } from './skills-bridge';
import { attachReputationBridge } from './reputation-bridge';
import { attachLootBridge } from './loot-bridge';
import { attachGossipBridge } from './gossip-bridge';
import { attachInteractionWatch } from './interaction-watch';
import { attachMerchantBridge } from './merchant-bridge';
import { attachGroupBridge } from './group-bridge';
import { publishRects, clearRects } from './rects';
import { ModelBooth } from './scene/model-booth';
import { publishArtSink, clearArtSink } from './runtime-art';
import { attachUnitBridge, seedUnitSnapshots } from './unit-bridge';
import { attachTargetBridge } from './target-bridge';
import { dispatchBinding } from './framexml/lua/api/bindings';
import { cancelCursor, dropCursorOnWorld, getCursor } from './framexml/lua/api/cursor';
import { cvarBool } from './framexml/lua/api/screen';
import { gameTime } from './framexml/lua/compat';
import type World from '../world';
import type { WorldRuntime } from './framexml/world-runtime';
import type { BoothSubject } from './scene/model-booth';

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
 * The dragged ability's icon, in LOGICAL UNITS square.
 *
 * 36 is `ActionButtonTemplate`'s own authored size -- `Interface\FrameXML\ActionButtonTemplate.xml:4-6`,
 * `<Size><AbsDimension x="36" y="36"/></Size>` -- so a picked-up ability is exactly the size of the slot
 * it is heading for, which is what the real client shows. Not a guess and not a tuned value.
 *
 * The spellbook end differs slightly and is deliberately not matched: `SpellButtonTemplate` is 37x37
 * (`spellbookframe.xml:80-82`). The icon is sized to the DESTINATION rather than the source because every
 * drop target in this client is an action button, and a one-unit change mid-drag would be visible.
 */
const CURSOR_ICON_UNITS = 36;

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

  /**
   * THE MODEL BOOTH -- what draws a `<PlayerModel>` pane's figure. See `scene/model-booth.ts` for how
   * a model reaches a texture and for the redraw policy; the host's whole part is the call in `render`
   * and the boolean it answers.
   */
  private readonly booth: ModelBooth;
  private readonly fonts = new FontStringTextures();
  private readonly root = new WidgetRoot();
  /**
   * The last draw list, for `textExtent` -- the same array published as `window.worldUiDrawList`.
   * A reference, not a copy: it is replaced whole every frame.
   */
  private lastItems: DrawItem[] = [];

  private runtime: WorldRuntime | null = null;

  /**
   * Where the manifest load's progress goes, as a 0..1 fraction. Set by the host's owner; the loading
   * screen is the only caller. A slot rather than a constructor argument because the screen is the
   * page's, not this host's.
   */
  onLoadProgress: ((fraction: number) => void) | null = null;
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

  /** `attachTargetBridge`'s teardown, held so `dispose` can run it. */
  private detachTargets: (() => void) | null = null;


  /** `attachSpellbookBridge`'s teardown, held so `dispose` can run it. */
  private detachSpellbook: (() => void) | null = null;

  /** `attachContainerBridge`'s teardown, held so `dispose` can run it. */
  private detachContainers: (() => void) | null = null;

  /** `attachPaperDollStats`' teardown, held so `dispose` can run it. */
  private detachStats: (() => void) | null = null;

  /** `attachSkillsBridge`'s teardown, held so `dispose` can run it. */
  private detachSkills: (() => void) | null = null;

  /** `attachReputationBridge`'s teardown, held so `dispose` can run it. */
  private detachReputation: (() => void) | null = null;

  /** `attachLootBridge`'s teardown, held so `dispose` can run it. */
  private detachLoot: (() => void) | null = null;

  /** `attachGossipBridge`'s teardown, held so `dispose` can run it. */
  private detachGossip: (() => void) | null = null;

  /** `attachMerchantBridge`'s teardown, held so `dispose` can run it. */
  private detachMerchant: (() => void) | null = null;

  /**
   * THE OPEN-INTERACTION WATCH -- what closes the vendor and the corpse when the player walks off.
   *
   * Held as a pair rather than a teardown alone because it is the only bridge with a POLL: nothing
   * else in the interface has to notice the world moving. See `ui/interaction-watch.ts` on why the
   * engine owns this (neither the server nor the documents do) and why 250 ms.
   */
  private interactionWatch: { poll: (nowMs: number) => void; dispose: () => void } | null = null;

  /** `attachGroupBridge`'s teardown, held so `dispose` can run it. */
  private detachGroup: (() => void) | null = null;

  /**
   * THE DRAW INSTRUMENT, on `window.uiDrawStats`.
   *
   * `STATE.md` recorded the fingerprint's own cost as the oldest unmeasured claim in the action-bar area
   * -- two rounds asserted it and neither measured it. These are the four numbers that settle it:
   *
   *  - `items` / `signatureMs`: what `drawListSignature` walks and what walking it costs.
   *  - `dirtyFrames` vs `frames`: how often the interface is re-rendered at all. With no cooldown running
   *    this should sit at the `FULL_DRAW_EVERY` floor (one frame in twelve, plus real changes); if
   *    drawing a sweep dirtied the fingerprint it would climb to `frames`, and that is exactly the
   *    hypothesis the sweep pass is built to refute.
   *  - `fullDrawMs`: the last full interface re-render.
   *  - `sweeps` / `sweepMs`: how many wedges the sweep pass drew and what it cost.
   *
   * Cumulative counters are raw, not ratios -- a ratio hides a step change in either term. Reset with
   * `uiDrawStats.reset()`, which is what an A/B needs.
   */
  private readonly drawStats = {
    frames: 0,
    dirtyFrames: 0,
    items: 0,
    signatureMs: 0,
    signatureMsTotal: 0,
    fullDrawMs: 0,
    sweeps: 0,
    sweepMs: 0,
    /** `paneBakes` vs `dirtyFrames`: what the model panes cost, and whether they cost a dirty frame. */
    paneBakes: 0,
    paneMs: 0,
    paneMsTotal: 0,
    reset(): void {
      this.frames = 0;
      this.dirtyFrames = 0;
      this.signatureMsTotal = 0;
      this.paneBakes = 0;
      this.paneMsTotal = 0;
    },
  };

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
    this.booth = new ModelBooth(renderer);
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
   * Is the mouse cursor CARRYING something -- an ability picked up off the bar or out of the book.
   *
   * The world cursor's first precedence rung: while a drag is live, `drawCursorIcon` below is already
   * drawing that ability's icon at the pointer, so the OS cursor must stay the plain arrow rather than
   * turn into a sword over whatever the drag happens to pass across. One reader
   * (`pages/game/index.tsx#updateHoverCursor`), which is why this is a boolean and not the cursor.
   */
  get heldCursorItem(): boolean {
    return this.runtime !== null && getCursor(this.runtime.vm) !== null;
  }

  /**
   * The NAME of the widget that consumed the live press, or null when the press went to the world.
   *
   * `pages/game/controls` reads this on its own `mousedown` and refuses the button when it is non-null,
   * which is what stops the camera orbiting while an ability is being dragged. See
   * `GlueInput#capturedPress` for why one press has one owner and why the UI is in front.
   *
   * A NAME rather than the widget, for two reasons: the caller is a React component that has no business
   * holding a `Widget`, and the name is what makes the capture decision READABLE in an instrument -- the
   * gate on this round is "a press on a spell button was claimed by the UI and `controls` never saw it",
   * and "SpellButton3" says that where an object identity does not. An unnamed frame falls back to its
   * registry id (`lua:3256`), so a non-null answer always means "claimed" and never "unnamed".
   */
  get capturedPress(): string | null {
    const widget = this.input.capturedPress;
    if (widget === null) {
      return null;
    }
    const registry = this.runtime?.registry ?? null;
    const id = registry === null ? null : registry.idOfWidget(widget);
    return (id === null ? null : registry?.nameOf(id) ?? null) ?? widget.id;
  }

  /**
   * DOES THIS STRING FIT ITS FRAME -- the whole question, answered by the draw pass's own arithmetic.
   *
   * Built because the last round nearly reported a tooltip clipping defect off a tight CROP that the
   * numbers refuted (221.08 of text in a 241.08 frame), and because the reverse mistake is just as easy:
   * a paragraph can overrun its panel by 60 units and still look plausible in a screenshot. A crop
   * cannot separate "the text is too wide" from "the frame is drawn narrow".
   *
   * Every value comes from the SAME calls `resolveSprite` rasterizes through -- `effectiveFont(widget,
   * rect.width)` and `measureText` -- so this cannot agree with itself while disagreeing with the
   * screen. That is deliberate: an instrument with its own copy of the wrap rule would confirm whatever
   * the rule already believed. `rect` is the resolved layout rect, straight out of the last draw list.
   *
   * `overflowX` is the number that matters: the widest rendered line minus the rect's width. Positive
   * means ink outside the rect.
   */
  textExtent(name: string): unknown {
    const registry = this.runtime?.registry ?? null;
    const id = registry === null ? null : registry.byName(name);
    const widget = id === null ? null : registry?.widget(id) ?? null;
    if (!widget) {
      return { name, found: false };
    }
    const item = this.lastItems.find((entry) => entry.widget === widget) ?? null;
    const rect = item?.rect ?? null;
    const spec = effectiveFont(widget, rect?.width);
    // THE LIVE SCALE, not 1, and the first version of this used 1 -- which reported a DIFFERENT set of
    // lines from the ones on screen (the Eviscerate body broke after "per" here and after "combo" in the
    // raster). `resolveSprite` rasterizes at `screenScale(viewport.height)` and `wrapLines` measures in
    // DEVICE pixels, so scale 1 asks a different question. `linesAtScale1` is kept beside it on purpose:
    // the two differing is the measurement of how scale-invariant the breaking actually is, which round
    // 17 claimed and nothing had checked at a non-unit scale.
    // `layoutScale()`, not a second `screenScale(window.innerHeight)` -- self-review caught the
    // duplicate. Two expressions for one scale is the same class of defect as two notions of a label's
    // size, and this is an instrument: if it ever disagreed with the pass it measures, it would lie.
    const scale = layoutScale();
    const lines = spec === null ? [] : wrapLines(widget.displayText, spec, scale);
    const linesAtScale1 = spec === null ? [] : wrapLines(widget.displayText, spec, 1);
    const size = spec === null ? null : measureText(widget.displayText, spec, scale);
    return {
      name,
      found: true,
      drawn: item !== null,
      shown: widget.shown,
      text: widget.displayText,
      authored: { width: widget.width, height: widget.height },
      rect,
      font: spec === null
        ? null
        : {
          size: spec.size,
          wrapWidth: spec.wrapWidth ?? null,
          maxLines: spec.maxLines ?? null,
          nonSpaceWrap: spec.nonSpaceWrap ?? null,
          align: spec.align,
        },
      scale,
      lines,
      /** Same breaking asked at scale 1 -- equal to `lines` iff the breaking really is scale-invariant. */
      linesAtScale1,
      scaleInvariant: JSON.stringify(lines) === JSON.stringify(linesAtScale1),
      measured: size,
      overflowX: rect === null || size === null ? null : size.width - rect.width,
      overflowY: rect === null || size === null ? null : size.height - rect.height,
    };
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
      // THE LOADING SCREEN'S BAR. A real fraction of the manifest, not a timer: see
      // `ui/loading-screen.ts` and `world-runtime.ts`'s yield for why it is only called at a yield.
      onProgress: (done, total) => this.onLoadProgress?.(done / total),
    });
    if (this.stopped) {
      // Superseded by a teardown that ran while the manifest was loading. This boot's runtime is
      // nobody's and this is the only reference to it.
      runtime.dispose();
      return;
    }
    this.runtime = runtime;
    // THE KEYBOARD, into the client's own Lua. The router owns no knowledge of bindings and this VM owns
    // no knowledge of the DOM; this line is the whole seam. See `lua/api/bindings.ts#dispatchBinding` for
    // what a bound key actually runs (a `Bindings.xml` command, not a call into TypeScript).
    this.input.keyBinding = (token, down) => dispatchBinding(runtime.vm, token, down);
    // THE TWO WAYS A CARRIED ABILITY IS PUT DOWN, neither of which has any Lua to run: `WorldFrame`
    // declares no `OnReceiveDrag` (`worldframe.xml:23-77`) and nothing in the 264 manifest files touches
    // the cursor on Escape. See `api/cursor.ts#dropCursorOnWorld` / `#cancelCursor`.
    this.input.dropOnWorld = () => { dropCursorOnWorld(runtime.vm); };
    this.input.cancelCursor = () => cancelCursor(runtime.vm);
    // THE UNIT FEED, attached the instant the tree exists and not before: `attachUnitBridge` fires
    // `PLAYER_ENTERING_WORLD` on the way in, and a frame that has not been built yet cannot have
    // registered for it. The world is optional so `/game?offline=1&ui=lua` -- which has units but no
    // server, and is where every UI measurement is taken -- still boots.
    if (this.world) {
      this.detachUnits = attachUnitBridge(runtime.vm, this.world);
      // THE SELECTION GLOBALS -- `TargetNearestEnemy` (TAB), `ClearTarget` and `SpellStopCasting`
      // (Escape's own legs). Beside the unit bridge and NOT gated on a live session: an offline world
      // has units to tab between and a target to clear, and `SpellStopCasting` reaches the wire only
      // when a cast snapshot exists, which offline it never does.
      this.detachTargets = attachTargetBridge(runtime.vm, this.world);
      // THE NAMEPLATE SWITCH. The `V` key is entirely the client's own Lua -- `Bindings.xml:544-553`'s
      // `NAMEPLATES` binding reads and writes two CVars and does nothing else -- so the engine's whole
      // part is to read them, which is what this closure is. Registered here because this is the one
      // place that holds both the world and the VM; `World` keeps a function slot rather than a
      // dependency on the runtime (the shape `setProgramWarmer` uses).
      this.world.nameplateConfig = () => ({
        showEnemies: cvarBool(runtime.vm, 'nameplateShowEnemies'),
        showFriends: cvarBool(runtime.vm, 'nameplateShowFriends'),
        // THE LEVEL NUMBER'S COLOUR, answered by the CLIENT'S OWN `GetQuestDifficultyColor` -- the same
        // call `targetframe.lua:246-251` uses to colour a unit's level. Asked for as THREE FORMATTED
        // NUMBERS rather than as a Lua table: a table would have to cross the VM boundary as a live
        // handle, which is exactly what `SetAttribute` stored and had freed under it (see `STATE.md`),
        // and a `string.format` answer cannot be misread. Memoized on the caller's side per
        // level-vs-player-level pair, so this is a handful of calls per session, not one per plate per
        // frame.
        levelColor: (level: number) => {
          const answer = runtime.vm.runExpr(
            `local c = GetQuestDifficultyColor(${Math.floor(level)}) `
            + 'return string.format("%.4f %.4f %.4f", c.r, c.g, c.b)',
            'nameplate-level.lua',
          );
          const parts = String((answer as { value?: unknown } | null)?.value ?? '').split(' ');
          if (parts.length !== 3) {
            return null;
          }
          const rgb = parts.map((part) => Number(part));
          return rgb.some((n) => !Number.isFinite(n)) ? null : [rgb[0], rgb[1], rgb[2]];
        },
      });

      /**
       * THE OUTCOME WORDS for the floating combat text, out of the CLIENT'S OWN TABLE.
       *
       * `CombatFeedbackText` (`combatfeedback.lua:15-26`) maps `"MISS"`/`"DODGE"`/`"PARRY"`/... to the
       * localized `GlobalStrings.lua` values, and it is the same table the client's own
       * `CombatFeedback_OnCombatEvent` reads for the portrait indicator. Asking it means the floating
       * word and the unit-frame word are literally the same string and there is ONE copy of the word
       * list in this client -- the argument the level colour is reached through
       * `GetQuestDifficultyColor` for. The reference hardcodes the shipped enUS words only because it
       * has no FrameXML to ask (`combat_text/law.rs:93-100`).
       *
       * A STRING is asked for, never a table handle: a handle crossing the boundary is what
       * `SetAttribute` stored and had freed under it (see `STATE.md`). The key is checked against a
       * literal set here rather than interpolated blind, because it lands inside a Lua chunk.
       * `World` memoizes on the caller's side -- see `combatWord` -- so this is at most nine calls a
       * session.
       */
      this.world.combatWord = (key: string) => {
        if (!/^[A-Z]+$/.test(key)) {
          return null;
        }
        const answer = runtime.vm.runExpr(
          `return tostring(CombatFeedbackText and CombatFeedbackText["${key}"] or "")`,
          'combat-word.lua',
        );
        const word = String((answer as { value?: unknown } | null)?.value ?? '');
        return word === '' || word === 'nil' ? null : word;
      };
      // THE ACTION FEED. Gated on a real session as well as a world: `/game?offline=1&ui=lua` has units
      // but no protocol, and `session.offline` short-circuits ahead of the `protocol` getter -- reading
      // `game.objectHandler` there would construct transports the offline route contracts never to
      // touch. An offline world therefore keeps its 12 buttons hidden, which is honest: there is no
      // server to have sent an action bar.
      if (!this.world.session.offline) {
        this.detachActions = attachActionBridge(runtime.vm, this.world, this.art);
        // THE SPELLBOOK AND THE CURSOR. After the action bridge, because both read `spellData` and the
        // action bridge is the one that OWNS the 49 MB `Spell.dbc` fetch (see its header on why that call
        // must not be made from the packet handler); `ensureLoaded` is idempotent, so this rides the same
        // promise rather than starting a second one. Gated on a real session for the same reason: there is
        // no spell book without `SMSG_INITIAL_SPELLS`.
        this.detachSpellbook = attachSpellbookBridge(runtime.vm, this.world, this.art);
        // THE BAGS. Gated on a real session for the same reason the two above are: an item's name and
        // quality come from `SMSG_ITEM_QUERY_SINGLE_RESPONSE`, so an offline world has no bag to draw
        // and `world.game.objectHandler` must not be touched on that route at all.
        this.detachContainers = attachContainerBridge(runtime.vm, this.world, this.art);
        // THE LOOT WINDOW. After the container bridge, because a taken item lands in a bag and both
        // read the same `ItemHandler` template cache -- `attachContainerBridge` is the one that first
        // asks `itemData` to load, and `ensureLoaded` is idempotent so this rides that promise.
        this.detachLoot = attachLootBridge(runtime.vm, this.world, this.art);
        // TALKING TO AN NPC, then BUYING AND SELLING. Gated on a real session for the reason the item
        // bridges are: a vendor's stock and a gossip menu are both packets, so an offline world has
        // neither and `world.game.objectHandler` must not be touched on that route.
        //
        // **THE MERCHANT BRIDGE MUST BE LAST OF THE THREE ITEM BRIDGES, and the order is load-bearing
        // rather than tidy.** All three install `setItemTooltipSource`, and each CHAINS onto what it
        // replaces: the container bridge owns `bag`/`inventory`/`link`, the loot bridge adds `loot`,
        // and this one adds `merchant`/`buyback`. Attaching it earlier would put it under the loot
        // bridge's install and every merchant tooltip would fall through to a source that does not
        // know the kind.
        this.detachGossip = attachGossipBridge(runtime.vm, this.world, this.art);
        this.detachMerchant = attachMerchantBridge(runtime.vm, this.world, this.art);
        // WALK AWAY AND THE WINDOW SHUTS -- the vendor's and the corpse's, one mechanism. Attached
        // after both bridges because it drives their handlers, and gated on a real session like they
        // are: an offline world has neither a vendor nor a corpse to walk away from.
        this.interactionWatch = attachInteractionWatch(this.world);
        // THE CHARACTER SHEET'S STAT PANES. Gated on a real session like the three above: every number
        // it answers is a descriptor word off our own character, and an offline world has no descriptor.
        // AFTER them for no reason but readability -- it subscribes to `world.on('unit:fields')` and
        // shares nothing with the item bridges.
        this.detachStats = attachPaperDollStats(runtime.vm, this.world);
        // THE SKILLS TAB. Gated on a real session for the same reason: every row comes off our own
        // character's descriptor, and an offline world has none. Its DBC join is `skillData`, which the
        // spellbook already asks for, so this adds no fetch.
        this.detachSkills = attachSkillsBridge(runtime.vm, this.world);
        // THE REPUTATION TAB. Gated on a real session for the same reason as the skills tab: every
        // standing comes from `SMSG_INITIALIZE_FACTIONS`, and an offline world receives none -- with no
        // packet the pane shows an empty list, which is what it showed before this existed. Its DBC
        // join (`faction-data.ts`) is kicked by the bridge itself and is a table nothing else fetches.
        this.detachReputation = attachReputationBridge(runtime.vm, this.world);
        // THE UNIT RIGHT-CLICK MENUS -- groups, duels, dungeon difficulty, instance reset. Gated on a
        // real session like the rest: every answer is a packet, and an offline world has no roster, no
        // duel and no instance to reset. AFTER the spellbook bridge, because `StartDuel` finds the duel
        // spell in the player's own book by its `Effect[0]` and that bridge is the one that OWNS the
        // `Spell.dbc` fetch -- `ensureLoaded` is idempotent, so this rides the same promise rather than
        // starting a second one.
        this.detachGroup = attachGroupBridge(runtime.vm, this.world);
      }
    }
    // THE RUNTIME ART SINK, before the load report and before anything can script a texture. See
    // `ui/runtime-art.ts`: a `SetTexture` naming a path the XML never mentioned was silently never
    // fetched, which is what left the backpack with no backdrop.
    publishArtSink(this.art);
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
    // THE MODEL BOOTH, as a handle, for exactly the reason `worldUiArt` is one: "the figure in the pane
    // is wrong" has several indistinguishable causes and the pane's scene is not the world scene, so
    // nothing else a probe can traverse reaches the model it is drawing. `worldUiBooth.debug()`.
    (window as never as Record<string, unknown>).worldUiBooth = this.booth;
    // The draw instrument -- see `drawStats` for what each number answers.
    (window as never as Record<string, unknown>).uiDrawStats = this.drawStats;
    /**
     * THE INPUT ROUTER, as a handle -- new with the drag work, and it was needed within one round.
     *
     * `worldUiDrawList` says where a widget IS and the registry says what it is called, but neither answers
     * "which widget does the router believe the pointer is over", and that is the question a drag fails on:
     * a probe that converts a rect to device pixels with its own arithmetic is asking a DIFFERENT question
     * from the one `input.ts#toUnits` answers, and the two disagreeing is invisible. `pointerWidget` and
     * `pointerPosition` are the router's own answers, so a probe can compare them against the widget it
     * meant to hit instead of trusting a coordinate conversion it duplicated.
     */
    (window as never as Record<string, unknown>).worldUiInput = this.input;
    /**
     * THE OVERFLOW INSTRUMENT -- `uiTextExtent('VideoOptionsResolutionPanelSubText')`. See `textExtent`
     * for why a crop cannot answer this and why it borrows the draw pass's own calls rather than
     * re-deriving them.
     */
    (window as never as Record<string, unknown>).uiTextExtent = (name: string) =>
      this.textExtent(name);
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
    // THE OPEN-INTERACTION POLL, inside the tick section it belongs to. Self-throttled to 250 ms and
    // a pair of null checks when nothing is open, so on the overwhelming majority of frames this is
    // one comparison against a deadline. `performance.now()` rather than accumulating `dt`: a poll
    // measured in frames would fire eight times as often on a fast machine.
    this.interactionWatch?.poll(performance.now());
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
    this.lastItems = items;
    // THE RECTS, for `Region:GetLeft/GetRight/GetTop/GetBottom/GetCenter`. Published from the same
    // array the router hit-tests, so a rect a script reads and a rect a click lands in cannot
    // disagree. One reference assignment; the id map is built lazily on first lookup. See
    // `ui/rects.ts` for why nothing else in this client could answer where a widget ended up.
    // The third argument is the ON-DEMAND resolver, for a script that measures a frame in the same tick
    // it shows it -- `ToggleDropDownMenu`'s `Show()` then `GetCenter()`. A closure, not a precomputed
    // map: it runs only if `rectOf` misses, which for every existing caller is never.
    publishRects(items, viewportUnits(viewport).height,
      () => this.root.layoutRects(viewport, measureText));
    const scale = screenScale(viewport.height);

    this.sections.begin('ui.draw');
    // THE MODEL PANES, BEFORE the fingerprint and before the full draw.
    //
    // Before the fingerprint because this is where a pane's `sprite` is set, and the fingerprint has to
    // see it -- a pane appearing changes the interface exactly once, which is a change the signature
    // SHOULD catch. Before the full draw because the pane's texture is drawn INTO the interface target,
    // so a bake that happened after it would not be composited until the next dirty frame.
    //
    // NO VALVE IS HANDED DOWN. This used to pass `framesSinceFullDraw >= FULL_DRAW_EVERY` so a pane
    // re-baked on the frames the interface was being fully re-rendered anyway -- free in dirty frames,
    // but it made every portrait a one-frame-in-twelve animation of the Stand loop. The booth now bakes
    // only on a real change; see `ModelBooth#render`. `boothBaked` still forces the full draw, because
    // a bake changes pixels the fingerprint cannot see.
    const paneStarted = performance.now();
    const boothBaked = this.booth.render(items, this.art, (unit) => this.subjectForUnit(unit), {
      scale,
      pixelRatio: this.renderer.getPixelRatio(),
    });
    const paneMs = performance.now() - paneStarted;
    // Re-render the OFFSCREEN target only when the interface actually changed; composite it every
    // frame with one quad. See `signature` and `target` for the measurement that forced this.
    const signatureStarted = performance.now();
    const signature = drawListSignature(items);
    const signatureMs = performance.now() - signatureStarted;
    const target = this.target();
    const dirty =
      target !== null &&
      (signature !== this.lastSignature || boothBaked || this.framesSinceFullDraw >= FULL_DRAW_EVERY);
    // THE INSTRUMENT, built before the sweep was drawn and deliberately not blinded by it: it counts the
    // full re-renders SEPARATELY from the sweep pass, so "the sweep dirties the fingerprint" is a
    // question this can answer rather than one the code has to be trusted about. `STATE.md` recorded the
    // fingerprint's own cost as the oldest unmeasured claim in this area; `window.uiDrawStats` is it.
    // A number confirming a hypothesis deserves the more scepticism, so `dirtyFrames` is reported raw
    // and not as a ratio.
    const stats = this.drawStats;
    stats.frames += 1;
    stats.items = items.length;
    stats.signatureMs = signatureMs;
    stats.signatureMsTotal += signatureMs;
    stats.paneMs = paneMs;
    stats.paneMsTotal += paneMs;
    if (boothBaked) {
      stats.paneBakes += 1;
    }
    if (dirty) {
      stats.dirtyFrames += 1;
    }
    if (dirty) {
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
      stats.fullDrawMs = performance.now() - signatureStarted - signatureMs;
    } else {
      this.framesSinceFullDraw += 1;
    }
    this.composite();
    // THE COOLDOWN SWEEPS, after the composite and straight into the canvas -- which is the whole reason
    // a running cooldown costs no re-render. See `drawSweeps`.
    const sweepStarted = performance.now();
    stats.sweeps = this.drawSweeps(items, viewport);
    stats.sweepMs = performance.now() - sweepStarted;
    // THE DRAGGED ABILITY'S ICON, in the same after-the-composite pass and for exactly the same reason.
    this.drawCursorIcon(viewport);
    this.sections.end('ui.draw');
  }

  /**
   * A `SetUnit`/`SetPortraitTexture` token to the BODY the booth should build, or null.
   *
   * The whole of the host's part in the model booth, and deliberately the narrowest thing that could
   * work: the booth knows nothing about units and this knows nothing about rendering.
   *
   * Only `"player"` and `"target"` resolve, and that is not a shortcut -- those are the only two units
   * this client tracks at all (`unit-bridge.ts:31`: "`pet`, `focus`, `targettarget` and the party/raid
   * tokens are NOT"). The paper doll passes `"player"` (`paperdollframe.lua:159`) and so do the
   * dress-up and tabard panes; `UnitFrame_Update` passes whichever unit its frame is bound to, so a
   * party or pet portrait asks for a token nothing here can answer and the booth reports it once.
   *
   * A unit answers exactly one of the two supplies -- see `BoothSubject` -- and the KEY is what the
   * booth compares. For a character it is the look object itself, because `resolveCharacterLook` builds
   * a fresh one per redress and identity therefore means "this unit's gear changed". For a creature it
   * is the display id, because `creatureDisplay` builds its descriptor on every read and comparing
   * THAT by identity would re-bake the portrait on every frame.
   */
  private subjectForUnit(unit: string): BoothSubject | null {
    const world = this.world;
    if (world === null) {
      return null;
    }
    const target = unit === 'player' ? world.player : unit === 'target' ? world.target : null;
    if (!target) {
      return null;
    }
    const look = target.characterLook;
    if (look !== null) {
      return { key: look, look, creature: null };
    }
    const creature = target.creatureDisplay;
    if (creature !== null) {
      return { key: target.displayId, look: null, creature };
    }
    return null;
  }

  /**
   * THE ICON ATTACHED TO THE CURSOR while an ability is being dragged.
   *
   * **Drawn here, after the composite, and NOT as a widget in the tree** -- the same decision
   * `drawSweeps` documents, and here the argument is even sharper. `drawList` is a pure flatten of the
   * widget tree, so the only way to get a quad into it is to put a real `Widget` in the tree; and
   * `drawListSignature` mixes every item's `rect.left/top/width/height`. A widget that follows the mouse
   * would therefore change the fingerprint on EVERY frame the pointer moves, forcing a full ~4-12 ms
   * re-render of the whole interface for the entire length of the drag -- which is precisely the
   * "anything that dirties the fingerprint every frame gives the whole saving back" trap. Drawn straight
   * to the canvas it costs **one draw call while a drag is live and nothing at all otherwise**, and the
   * fingerprint never sees it.
   *
   * The pointer comes from the ROUTER (`GlueInput#pointerPosition`), not from `api/screen.ts`'s
   * `GetCursorPosition` tracker, and the two are not interchangeable: the router works in logical units
   * with Y DOWN from the top -- the same space `drawList` rects and `hitTest` use -- while the Lua global
   * deliberately reports CSS pixels with Y measured UP from the bottom. Reading the wrong one puts the
   * icon mirrored vertically and at the wrong scale.
   *
   * Returns nothing: the cursor is either carrying something drawable or it is not, and there is no count
   * worth instrumenting the way the sweeps' was.
   */
  private drawCursorIcon(viewport: { width: number; height: number }): void {
    const runtime = this.runtime;
    const held = runtime === null ? null : getCursor(runtime.vm);
    const pointer = this.input.pointerPosition;
    const texture = held?.texture ?? null;
    const map = texture === null ? null : this.art.texture(texture);
    // Four distinct nothing-to-draw cases, all of them ordinary: no drag, a spell whose icon path is not
    // resolved (the 49 MB `Spell.dbc` has not landed), a BLP still in flight, and no pointer move yet.
    if (held === null || pointer === null || map === null) {
      if (this.cursorQuad !== null) {
        this.cursorQuad.visible = false;
      }
      return;
    }

    const units = viewportUnits(viewport);
    const quad = this.cursorQuadOf();
    const material = quad.material as THREE.MeshBasicMaterial;
    // ONLY on a real change. Self-review caught this assigning `map` and setting `needsUpdate = true` every
    // frame of the drag: `needsUpdate` on a material forces three to re-evaluate its program, so a held
    // ability would have paid a shader recompile check per frame for a texture that never changes.
    if (material.map !== map) {
      material.map = map;
      material.needsUpdate = true;
    }
    // Centred on the pointer, which is where the real client holds a picked-up icon. NDC on the composite
    // camera, the same two lines `drawSweeps` uses.
    quad.position.set(pointer.x / units.width - 0.5, 0.5 - pointer.y / units.height, 0);
    quad.scale.set(CURSOR_ICON_UNITS / units.width, CURSOR_ICON_UNITS / units.height, 1);
    // BY HAND -- `matrixAutoUpdate` is false, so the two writes above are otherwise inert.
    quad.updateMatrix();
    quad.visible = true;

    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.cursorSceneOf(), this.compositeCamera);
    this.renderer.autoClear = previousAutoClear;
  }

  private cursorScene: THREE.Scene | null = null;

  private cursorQuad: THREE.Mesh | null = null;

  /** One quad, built on first use. Same recipe as `sweepQuad`. */
  private cursorQuadOf(): THREE.Mesh {
    if (this.cursorQuad === null) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // The composite is premultiplied and this quad is drawn into the same canvas after it, so the
        // icon's own alpha must be premultiplied too or a soft edge reads as a bright halo.
        premultipliedAlpha: true,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      quad.frustumCulled = false;
      quad.matrixAutoUpdate = false;
      quad.visible = false;
      this.cursorQuad = quad;
      this.cursorSceneOf().add(quad);
    }
    return this.cursorQuad;
  }

  private cursorSceneOf(): THREE.Scene {
    if (this.cursorScene === null) {
      this.cursorScene = new THREE.Scene();
      this.cursorScene.name = 'WorldUiCursorIcon';
    }
    return this.cursorScene;
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

  // -----------------------------------------------------------------------------------------------
  // THE COOLDOWN SWEEP PASS.
  //
  // A `<Cooldown>` frame is a plain `frame` widget (`lua/object.ts:110`, `COOLDOWN: 'frame'`) with no
  // sprite, so the interface pass draws nothing for it and the fingerprint sees only its rect, alpha and
  // colour -- none of which move while it counts down. That is what makes this affordable: the sweeps are
  // drawn HERE, after the composite, direct to the canvas, and the offscreen target is never touched.
  // A cooldown running for 30 seconds costs zero re-renders of the interface.
  //
  // The wedge is a fragment test on one axis-aligned quad, not geometry -- `sweepMaterial` computes each
  // pixel's angle about the quad's centre and keeps it only if the sweep has not yet passed it. So the
  // "no mesh for a radial wedge" objection in `methods/cooldown.ts` never needed a mesh.
  //
  // Cost: one draw call per ACTIVE cooldown. At the ~35 us per UI draw call measured above, 12 buttons
  // sharing a global cooldown are ~0.4 ms, against ~12 ms for a full interface re-render.

  private sweepScene: THREE.Scene | null = null;
  /**
   * Pooled quads, grown to the high-water mark of simultaneous cooldowns and never shrunk.
   *
   * Reused rather than rebuilt per frame for the reason `renderer.ts` gives about its own pool: a new
   * `Mesh` per cooldown per frame would allocate through a GCD and hand three's own bookkeeping a
   * different object graph every frame.
   */
  private sweepQuads: THREE.Mesh[] = [];

  /**
   * The radial wedge, as a fragment shader on a unit quad.
   *
   * `uElapsed` is how much of the cooldown has PASSED, 0 at the start and 1 at the end. The dark wedge
   * covers everything the sweep has not reached yet, so its leading edge travels clockwise from twelve
   * o'clock and the icon is uncovered behind it -- the client's own direction.
   *
   * The colour is the real client's cooldown shade: `Interface\Cooldown\` art is a black wedge at
   * roughly 55% alpha over the icon. That value is NOT read from a file -- it is chosen to match the
   * screenshot and is unexplained beyond that, which is worth stating rather than dressing up. What IS
   * from the client is the shape and the direction.
   */
  private sweepMaterialCache: THREE.ShaderMaterial | null = null;

  private sweepMaterial(): THREE.ShaderMaterial {
    if (this.sweepMaterialCache === null) {
      // NOTE for anyone editing the GLSL below: no BACKTICKS in the shader comments. They terminate the
      // template literal, and the failure is a wall of TS1005 parse errors 20 lines further down that
      // says nothing about a shader.
      this.sweepMaterialCache = new THREE.ShaderMaterial({
        uniforms: { uElapsed: { value: 0 } },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          precision mediump float;
          varying vec2 vUv;
          uniform float uElapsed;
          void main() {
            // Centre the quad's UV so the angle is measured about its middle. A button is square in
            // screen space, so no aspect correction is needed.
            vec2 p = vUv - 0.5;
            // atan(x, y), NOT atan(y, x). With three's plane UVs (v up), this returns 0 straight up,
            // +PI/2 to the right, +/-PI down and -PI/2 to the left -- which is angle measured CLOCKWISE
            // FROM TWELVE O'CLOCK, exactly where the client's sweep starts and the way it turns. fract
            // folds the negative left half up into 0.75..1, giving up=0, right=0.25, down=0.5, left=0.75.
            float a = fract(atan(p.x, p.y) / 6.2831853);
            // Darken only what the sweep has NOT yet uncovered. uElapsed grows 0 -> 1, so the leading
            // edge travels clockwise from twelve o'clock and the icon is revealed behind it -- which is
            // the client's direction. Discarding on the other side of this test would shrink the wedge
            // back towards twelve instead, and look like a cooldown running backwards.
            if (a <= uElapsed) {
              discard;
            }
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.55);
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }
    return this.sweepMaterialCache;
  }

  /**
   * Draw a wedge over every shown `<Cooldown>` frame with time left. Returns how many were drawn.
   *
   * `gameTime()` is `GetTime()`, THE clock `SetCooldown`'s `start` was recorded against
   * (`lua/compat.ts`). Reading `performance.now()` or `Date.now()` here instead would be a different
   * epoch and would put every sweep at a wrong fraction without erroring -- both are plausible-looking
   * seconds. The epoch was made module-level in `compat.ts` precisely so this pass could share it.
   *
   * A cooldown that has RUN OUT clears itself here. That is not the client's job: `CooldownFrame_SetTimer`
   * only ever gets called again on an event, and nothing fires when a cooldown merely expires, so a
   * finished sweep would otherwise sit at a full wedge for ever.
   */
  private drawSweeps(items: DrawItem[], viewport: { width: number; height: number }): number {
    const now = gameTime();
    // Screen units -> device pixels for this frame's canvas, the same conversion the composite camera's
    // NDC needs. `drawList` rects are in logical units against `viewportUnits`.
    const units = viewportUnits(viewport);

    let drawn = 0;
    for (const item of items) {
      const cd = item.widget.cooldown;
      if (cd === null) {
        continue;
      }
      const remaining = cd.start + cd.duration - now;
      if (remaining <= 0) {
        // Expired. Cleared so the wedge stops being drawn; the FRAME is left shown, because hiding it is
        // `CooldownFrame_SetTimer`'s decision and taking it here would fight the client's own Lua.
        item.widget.cooldown = null;
        continue;
      }
      if (remaining > cd.duration) {
        // `start` in the future -- a server cooldown stamped ahead of our clock. Nothing to draw yet.
        continue;
      }

      const quad = this.sweepQuad(drawn);
      // NDC, on the same orthographic camera the composite uses (-0.5..0.5 both axes, y up).
      const cx = (item.rect.left + item.rect.width / 2) / units.width - 0.5;
      const cy = 0.5 - (item.rect.top + item.rect.height / 2) / units.height;
      quad.position.set(cx, cy, 0);
      quad.scale.set(item.rect.width / units.width, item.rect.height / units.height, 1);
      // `updateMatrix()` BY HAND, because `matrixAutoUpdate` is false on these -- `position`/`scale`
      // writes are inert without it. That is a trap this codebase has already been bitten by once
      // (`CLAUDE.md`: "`model.scale.setScalar()` is inert under `matrixAutoUpdate = false`").
      quad.updateMatrix();
      quad.visible = true;
      // Each pooled quad carries its OWN cloned material, so the fraction can be set per quad and the
      // whole set drawn in one `renderer.render` below. Sharing one material would upload the LAST
      // fraction for every quad -- three uploads uniforms at draw time.
      (quad.material as THREE.ShaderMaterial).uniforms.uElapsed.value = 1 - remaining / cd.duration;
      drawn += 1;
    }

    // Hide the tail of the pool: last frame may have had more cooldowns than this one.
    for (let i = drawn; i < this.sweepQuads.length; i += 1) {
      this.sweepQuads[i].visible = false;
    }
    if (drawn === 0) {
      return 0;
    }

    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.render(this.sweepSceneOf(), this.compositeCamera);
    this.renderer.autoClear = previousAutoClear;
    return drawn;
  }

  /** The pooled quad at `index`, built on first use. Each carries its OWN material -- see `drawSweeps`. */
  private sweepQuad(index: number): THREE.Mesh {
    let quad = this.sweepQuads[index];
    if (quad === undefined) {
      quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sweepMaterial().clone());
      quad.frustumCulled = false;
      quad.matrixAutoUpdate = false;
      quad.visible = false;
      this.sweepQuads[index] = quad;
      this.sweepSceneOf().add(quad);
    }
    return quad;
  }

  /** The scene every pooled quad is added to, once. */
  private sweepSceneOf(): THREE.Scene {
    if (this.sweepScene === null) {
      this.sweepScene = new THREE.Scene();
      this.sweepScene.name = 'WorldUiCooldownSweep';
    }
    return this.sweepScene;
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
    this.detachTargets?.();
    this.detachTargets = null;
    this.detachActions?.();
    this.detachActions = null;
    this.detachSpellbook?.();
    this.detachSpellbook = null;
    // LIFO, AND THE ORDER IS LOAD-BEARING HERE RATHER THAN TIDINESS. The loot bridge CHAINS its
    // `GameTooltip` item source onto whatever the container bridge installed, capturing it at attach
    // and restoring it on teardown. Tearing the container bridge down FIRST set the source to null and
    // then let the loot bridge restore the container's closure over the top -- leaving a dead source
    // installed after dispose, reading a bridge whose listeners are gone. Unwinding in the reverse of
    // the attach order is what makes the chain's restore land on something live.
    this.detachLoot?.();
    this.detachLoot = null;
    this.detachMerchant?.();
    this.detachMerchant = null;
    this.interactionWatch?.dispose();
    this.interactionWatch = null;
    this.detachGossip?.();
    this.detachGossip = null;
    this.detachGroup?.();
    this.detachGroup = null;
    this.detachContainers?.();
    this.detachContainers = null;
    this.detachStats?.();
    this.detachStats = null;
    this.detachSkills?.();
    this.detachSkills = null;
    this.detachReputation?.();
    this.detachReputation = null;
    // The rect publication is module-level, so it OUTLIVES this host unless it is cleared -- exactly
    // the hazard `pages/game/index.tsx#componentWillUnmount` records for its own window handles. A
    // stale draw list would have a remounted world's scripts reading the previous world's layout.
    clearRects();
    clearArtSink();
    this.input.detach();
    this.runtime?.dispose();
    this.runtime = null;
    this.ui.dispose();
    this.booth.dispose();
    this.renderTarget?.dispose();
    this.renderTarget = null;
    if (this.compositeMesh) {
      this.compositeMesh.geometry.dispose();
      (this.compositeMesh.material as THREE.Material).dispose();
    }
    this.compositeScene = null;
    this.compositeMesh = null;
    // The cooldown sweep pool. Each quad owns its OWN geometry and a CLONED material (see `sweepQuad`),
    // so both have to be freed per quad -- caught in this round's own diff review, which is exactly the
    // leak the composite mesh above is freed to avoid.
    for (const quad of this.sweepQuads) {
      quad.geometry.dispose();
      (quad.material as THREE.Material).dispose();
    }
    this.sweepQuads = [];
    this.sweepMaterialCache?.dispose();
    this.sweepMaterialCache = null;
    this.sweepScene = null;
    this.fonts.dispose();
    this.art.dispose();
    this.solidTexture?.dispose();
    this.solidTexture = null;
    delete (window as never as Record<string, unknown>).worldRuntime;
    delete (window as never as Record<string, unknown>).worldUiArt;
    delete (window as never as Record<string, unknown>).worldUiDrawList;
    delete (window as never as Record<string, unknown>).uiDrawStats;
    delete (window as never as Record<string, unknown>).worldUiBooth;
    delete (window as never as Record<string, unknown>).uiTextExtent;
    this.lastItems = [];
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
  const { report, files, loadMs, longestBlockMs } = runtime;
  console.log(
    `framexml(world): ${report.frames} frames from ${files.length} files, ` +
      `${report.warnings.length} warnings, ${report.errors.length} errors, ` +
      `${loadMs.toFixed(0)} ms (longest block ${longestBlockMs.toFixed(0)} ms)`,
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
