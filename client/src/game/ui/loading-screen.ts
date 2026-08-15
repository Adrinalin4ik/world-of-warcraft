/**
 * THE LOADING SCREEN: the game's own per-map art, drawn over everything while the world and the
 * interface are still coming up.
 *
 * ## Why this is engine code and not a FrameXML document
 *
 * `CLAUDE.md`'s first rule is that every screen is the client's own XML and Lua. This screen is the
 * documented exception, and the evidence is the same shape as the nameplates' (see `STATE.md`):
 * **3.3.5a declares no loading-screen document anywhere.** Measured against the asset host --
 * `interface/framexml/loadingscreen.xml`, `interface/framexml/loadingscreen.lua` and
 * `interface/glues/loadingscreen.xml` all answer 404 (the host's 27,150-byte HTML page),
 * `FrameXML.toc` contains no entry matching /load/i at all, and `GlueXML.toc`'s 37 entries name only
 * `PatchDownload.xml`. What the game DOES ship is the art and the tables that choose it, so the
 * engine's whole part is to pick a file and draw it -- which is what this does.
 *
 * ## It draws through `GlueRenderer`, and that is the whole reason it works
 *
 * The first version built its own `THREE.Scene`, its own orthographic camera and its own
 * `renderer.render` call. **It issued 3 draw calls and 6 triangles to the canvas and changed not one
 * pixel** -- with a plain untextured `0xff0000` material, with `autoClear` both true and false, with
 * near/far at both `-1/1` and `-1000/1000`, while the camera provably projected the quad to exactly
 * NDC [-1, 1]. Frustum culling, scissor/viewport (absent from `game/` entirely), the render target and
 * a second canvas were all ruled out by measurement. That failure is UNEXPLAINED and is recorded in
 * `task-9-report.md`; what closed it was not diagnosing it but deleting the hand-rolled pass and
 * drawing through the widget layer that demonstrably already works on this same renderer.
 *
 * So this file builds `DrawItem`s and hands them to `GlueRenderer`, exactly as `screens.ts` and
 * `world-ui.ts` do. Three things come free with that decision and each was a defect in the hand-rolled
 * version:
 *
 *  - **Orientation.** `TextureLoader` creates every texture with `flipY = false` (three cannot flip a
 *    compressed upload), so image row 0 is `v = 0`; `GlueRenderer`'s camera is Y-DOWN, which puts a
 *    quad's `v = 0` edge at the TOP of the screen, and the two conventions cancel with no flip
 *    anywhere (`material.ts:120`, `renderer.ts:151`). The hand-rolled pass used a Y-UP camera and drew
 *    every screen UPSIDE DOWN. The fix is to adopt the convention, never to negate a V by hand -- a
 *    hand-flipped quad would be the one texture in the client that disagrees with the rule.
 *  - **Units.** `GlueRenderer` sets its camera to LOGICAL UNITS every frame (`renderer.ts:289-294`),
 *    the same units every widget rect is in, so the placement constants below mean the same thing they
 *    would mean in a FrameXML document.
 *  - **Text.** A `fontstring` widget rasterizes through `text.ts#FontStringTextures`, which already
 *    interprets `|c`/`|r` (`ui/markup.ts`) -- which is exactly what `GameTips.dbc` ships.
 *
 * `premultiplied` is FALSE here, matching the glue screens: this draws straight into the canvas over
 * an opaque 3D pass, which is the case `renderer.ts:246-248` states straight alpha is right for.
 *
 * ## Where the art comes from
 *
 * `Map.dbc` carries `loadingScreenID` (this client's own entity already names it,
 * `wow-data-parser/dbc/entities/map.js`), and `LoadingScreens.dbc` maps that id to a BLP path.
 * Measured on the served file: 91 records, 4 fields, 16-byte rows -- id 3 `Kalimdor` ->
 * `Interface\Glues\LoadingScreens\LoadScreenKalimdor.blp`, id 4 `Azeroth` ->
 * `LoadScreenEasternKingdom.blp`. The BLPs are BLP2, compression 2 (DXT), 1024x1024 with mips
 * (`LoadScreenKalimdor.blp` is 700,236 B), so they go through the existing `TextureLoader` -- decoded
 * in a worker, uploaded compressed, no second decode path and no new dependency.
 *
 * ## What survives a blocked main thread, and what does not
 *
 * A blocked main thread paints nothing, so this screen is only worth anything if it is ON SCREEN
 * BEFORE the blocking work starts. It is drawn from the ordinary render loop, and the browser keeps
 * compositing the last presented framebuffer while the thread is busy -- so the PICTURE survives a
 * block and the PROGRESS BAR freezes at whatever fraction it last drew. That is stated rather than
 * hidden: a bar that stops moving during a stall is honest, and the stall it has to cover is now
 * ~2.9 s rather than ~10 s (see `lua/vm.ts#ref`).
 */
import * as THREE from 'three';

import DBC from '../pipeline/dbc';
import TextureLoader from '../pipeline/texture-loader';
import { GlueArt } from './art';
import { viewportUnits } from './layout';
import { GlueRenderer } from './renderer';
import { resolveSprite } from './sprite';
import { FontStringTextures, loadGlueFonts } from './text';
import { DrawItem, Widget } from './widget';

/** One `LoadingScreens.dbc` row: the art path and whether a `<file>Wide.blp` companion exists. */
interface ScreenArt {
  file: string;
  wide: boolean;
}

/** Rows of `LoadingScreens.dbc`, by id. Loaded once per session; the file is 8,054 B. */
let screensById: Map<number, ScreenArt> | null = null;
/** `Map.dbc`'s `loadingScreenID` column, by map id. 43,226 B. */
let screenIdByMap: Map<number, number> | null = null;

/**
 * Resolves a map id to its loading-screen BLP, or null when the data does not name one.
 *
 * Null is a real answer, not a failure: `LoadingScreens.dbc` has 91 rows against `Map.dbc`'s several
 * hundred, so a map with no screen of its own is ordinary. The caller shows nothing rather than
 * inventing a substitute.
 */
export async function loadingScreenFor(mapId: number): Promise<string | null> {
  if (screensById === null || screenIdByMap === null) {
    // `DBC.load` is memoized per name and already used this way by `race-class-data.ts`, so asking
    // for `Map` here costs nothing if the world has already asked for it.
    const [screens, maps] = await Promise.all([
      (DBC as any).load('LoadingScreens'),
      (DBC as any).load('Map'),
    ]);
    screensById = new Map<number, ScreenArt>();
    for (const row of ((screens as any).records ?? []) as
      { id: number; file?: string; hasWideScreen?: number }[]) {
      if (row.file) {
        screensById.set(row.id, { file: row.file, wide: (row.hasWideScreen ?? 0) !== 0 });
      }
    }
    screenIdByMap = new Map<number, number>();
    for (const row of ((maps as any).records ?? []) as
      { id: number; loadingScreenID: number }[]) {
      screenIdByMap.set(row.id, row.loadingScreenID);
    }
  }
  const screenId = screenIdByMap.get(mapId);
  if (screenId === undefined) {
    return null;
  }
  const art = screensById.get(screenId);
  if (!art) {
    return null;
  }
  /**
   * THE WIDESCREEN COMPANION, when the row declares one and the viewport is wider than 4:3.
   *
   * `hasWideScreen` is `LoadingScreens.dbc`'s 4th column (see `entities/loading-screens.js` for the
   * measurement); the file is the same path with `Wide` appended, verified served and byte-different.
   * The 4:3 threshold is the client's own rule for a widescreen layout, not a new one of ours --
   * `UpdateMenuBarTop` uses exactly it (`uiparent.lua:1171-1174`, cited in `framexml/world-runtime.ts`).
   */
  const aspect = typeof window !== 'undefined' && window.innerHeight > 0
    ? window.innerWidth / window.innerHeight
    : 4 / 3;
  if (art.wide && aspect > 4 / 3) {
    return `${art.file.replace(/\.blp$/i, '')}Wide.blp`;
  }
  return art.file;
}

/**
 * One of `GameTips.dbc`'s 142 tips, at random, with the client's own markup left intact for
 * `text.ts` to interpret. Null when the table has no usable row.
 *
 * Measured on the served file: 142 records, 18 fields, 72-byte rows, field 1 the enUS string of a
 * `LocalizedStringRef` -- `entities/game-tips.js` already declares `id` + `tip`. They arrive carrying
 * markup, e.g. `"|cffffd100Tip:|r Nearby questgivers ... a question mark on your mini-map."`.
 *
 * **WHICH tip is OURS.** The engine picks; nothing in this build's data states how, so this takes one
 * at random and says so rather than implying a rule it cannot support.
 */
export async function randomGameTip(): Promise<string | null> {
  const tips = await (DBC as any).load('GameTips');
  const rows = (((tips as any).records ?? []) as { tip?: string }[])
    .map((row) => (row.tip ?? '').trim())
    .filter((text) => text.length > 0);
  if (rows.length === 0) {
    return null;
  }
  return rows[Math.floor(Math.random() * rows.length)];
}

/**
 * Placement, in LOGICAL UNITS off the bottom of the screen, and the bar's colours.
 *
 * **ALL OF THESE ARE OURS AND UNEXPLAINED.** No authored progress-bar art is served by this build at
 * any of 35+ probed paths (the full list is in `task-9-report.md`), `PatchDownload.xml` -- GlueXML's
 * only progress-bearing document -- declares no `<StatusBar>` at all, and `FileData.dbc` is not an
 * enumerator (10 records, all `INTERFACE\CINEMATICS\*.AVI`), so the directory cannot be listed and
 * probing is the only method available. Probing is sound in the negative (a real file answers 200:
 * that is how the `Wide` variant was found) but cannot prove absence. So these are values of ours,
 * NOT the client's, and if someone produces the real art this becomes an `art.register` call.
 */
const BAR_WIDTH_UNITS = 420;
const BAR_HEIGHT_UNITS = 10;
const BAR_BOTTOM_GAP_UNITS = 70;
const BAR_TRACK_COLOR = '#141414';
const BAR_FILL_COLOR = '#c8aa64';
/** The tip sits above the bar; its wrap budget and size are ours for the same reason. */
const TIP_GAP_UNITS = 26;
const TIP_WRAP_UNITS = 620;
const TIP_SIZE_UNITS = 13;

/** The art table key the loading BLP is registered under -- its own path, as `registerTreeArt` does. */
type Built = {
  art: Widget;
  track: Widget;
  fill: Widget;
  tip: Widget;
};

/**
 * One loading screen: the art, a progress bar and a game tip, drawn through `GlueRenderer`.
 *
 * Everything is lazily built and `render` is a no-op until the art has decoded -- a screen that
 * cannot draw must not blank the frame it was meant to improve.
 */
export class LoadingScreen {
  private readonly ui: GlueRenderer;

  private readonly art = new GlueArt();

  private readonly fonts = new FontStringTextures();

  private widgets: Built | null = null;

  private artPath: string | null = null;

  private tipText: string | null = null;

  private progress = 0;

  private disposed = false;

  private solidTexture: THREE.DataTexture | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    // `premultiplied: false` -- the glue case. See the file header.
    this.ui = new GlueRenderer(renderer, false);
  }

  /**
   * Starts fetching the art for `mapId`. Fire-and-forget: `render` draws nothing until it lands, and
   * a map with no screen in the DBCs simply never draws.
   */
  async load(mapId: number): Promise<void> {
    const path = await loadingScreenFor(mapId);
    if (path === null || this.disposed) {
      return;
    }
    // Registered under its own path and fetched through the ordinary art table, so the loading art
    // takes exactly the route every other UI texture takes -- `TextureLoader`, one decode, one
    // reference count. `GlueArt#load` swallows a missing BLP and leaves `texture()` null, which
    // `resolveSprite` turns into a skipped widget rather than a broken screen.
    this.art.register(path, { path });
    await this.art.load();
    if (this.disposed) {
      return;
    }
    this.artPath = path;

    // THE TIP, after the art rather than in parallel: it needs the client fonts registered, and a
    // screen with no tip is far better than a screen with no picture. Non-fatal for the same reason
    // `GlueArt#load` is.
    try {
      await loadGlueFonts();
      const tip = await randomGameTip();
      if (!this.disposed && tip) {
        this.tipText = tip;
      }
    } catch (error) {
      console.warn('loading screen: GameTips.dbc unavailable', error);
    }
  }

  /** 0..1. Clamped, because a progress source that overruns must not draw outside the track. */
  setProgress(value: number): void {
    this.progress = Math.max(0, Math.min(1, value));
  }

  /** Whether there is anything to draw. False while the art is still decoding. */
  get ready(): boolean {
    return this.artPath !== null && !this.disposed;
  }

  /** The live bar fraction, for the gate probe -- a screenshot cannot report a number. */
  get progressFraction(): number {
    return this.progress;
  }

  /** The tip actually chosen, so "no tip on screen" can be told from "no tip loaded". */
  get tipLine(): string | null {
    return this.tipText;
  }

  /** The path actually drawn, for a probe that has to tell "no art" from "wrong art". */
  get path(): string | null {
    return this.artPath;
  }

  /**
   * Draws over whatever is already in the buffer. `GlueRenderer#render` owns the `autoClear` dance
   * and the camera, so there is no renderer state handled here at all -- which is the point.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.ready) {
      return;
    }
    const size = renderer.getSize(new THREE.Vector2());
    const units = viewportUnits({ width: size.x, height: size.y });
    const built = this.widgets ?? this.build();

    // Every rect is rebuilt per frame from the live viewport, so a window resize needs no invalidation.
    const items: DrawItem[] = [];
    items.push({
      widget: built.art,
      rect: { left: 0, top: 0, width: units.width, height: units.height },
      alpha: 1,
    });

    const barLeft = (units.width - BAR_WIDTH_UNITS) / 2;
    const barTop = units.height - BAR_BOTTOM_GAP_UNITS - BAR_HEIGHT_UNITS;
    items.push({
      widget: built.track,
      rect: { left: barLeft, top: barTop, width: BAR_WIDTH_UNITS, height: BAR_HEIGHT_UNITS },
      alpha: 1,
    });
    // The FILL is a rect that grows from the left edge, not a scaled quad: a flat colour has no
    // texture to stretch, so the width IS the progress.
    if (this.progress > 0) {
      items.push({
        widget: built.fill,
        rect: {
          left: barLeft,
          top: barTop,
          width: BAR_WIDTH_UNITS * this.progress,
          height: BAR_HEIGHT_UNITS,
        },
        alpha: 1,
      });
    }

    if (this.tipText !== null) {
      // WRITTEN PER FRAME, not at build time. `build()` runs on the first frame the ART is ready, and
      // the tip resolves AFTER it (`load` awaits the fonts and `GameTips.dbc` only once the picture is
      // in hand) -- so a widget built with `text: ''` would keep it, `FontStringTextures#get` returns
      // null for empty text, and the tip silently never drew. That was the defect.
      built.tip.text = this.tipText;
      // `rect.width` is the wrap budget `sprite.ts#effectiveFont` reads for a string whose own font
      // declares none, which is why the tip wraps without a `wrapWidth` being set on the font.
      items.push({
        widget: built.tip,
        rect: {
          left: (units.width - TIP_WRAP_UNITS) / 2,
          top: barTop - TIP_GAP_UNITS - TIP_SIZE_UNITS * 3,
          width: TIP_WRAP_UNITS,
          height: TIP_SIZE_UNITS * 3,
        },
        alpha: 1,
      });
    }

    this.ui.render(items, (item) =>
      resolveSprite(item, units.scale, {
        art: this.art,
        fonts: this.fonts,
        solid: () => this.solid(),
      }),
    );
  }

  /**
   * The four synthetic widgets. Synthetic is correct HERE and nowhere else in this client: these are
   * not frames the game declares, they are the engine's own chrome, and no addon can or should hook
   * them. Everything the game DOES declare still comes from its own XML and Lua.
   */
  private build(): Built {
    const art = new Widget('texture', 'LoadingScreenArt');
    art.sprite = this.artPath;

    const track = new Widget('texture', 'LoadingScreenBarTrack');
    track.solid = true;
    track.vertexColor = BAR_TRACK_COLOR;

    const fill = new Widget('texture', 'LoadingScreenBarFill');
    fill.solid = true;
    fill.vertexColor = BAR_FILL_COLOR;

    const tip = new Widget('fontstring', 'LoadingScreenTip');
    // Filled in `render`, not here -- see the note at its draw item.
    tip.text = '';
    // `FRIZQT` is the client's body face. The size, the shadow and the placement are ours -- nothing
    // in this build's data states a loading-screen tip style.
    tip.font = {
      family: 'FRIZQT',
      size: TIP_SIZE_UNITS,
      color: '#ffffff',
      outline: false,
      align: 'CENTER',
      // EXPLICIT, not left to `effectiveFont`: that derives a budget from the widget's own width or
      // from two opposing anchors (`widget.ts:614-644`), and a synthetic widget has neither -- so
      // without this the tip rasterizes as ONE line some 2,000 units wide and never appears on screen.
      wrapWidth: TIP_WRAP_UNITS,
      // FrameXML's convention: logical units, `+y` UP, so the authored -1 is one unit DOWN the
      // screen. `text.ts` is the one place that flips it.
      shadowOffset: { x: 1, y: -1 },
      shadowColor: '#000000',
      shadowAlpha: 1,
    };

    this.widgets = { art, track, fill, tip };
    return this.widgets;
  }

  /** A 1x1 white texel for the two `solid` bar widgets, exactly as `world-ui.ts#solid` makes one. */
  private solid(): THREE.DataTexture {
    if (!this.solidTexture) {
      this.solidTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.solidTexture.needsUpdate = true;
    }
    return this.solidTexture;
  }

  /**
   * Releases the art through the art table's own reference-counted `dispose` -- never
   * `texture.dispose()`, per `ui/art.ts#dispose`: another holder of the same BLP must not have it
   * blanked out from under it.
   */
  dispose(): void {
    this.disposed = true;
    this.art.dispose();
    this.ui.dispose();
    this.solidTexture?.dispose();
    this.solidTexture = null;
    this.widgets = null;
  }
}
