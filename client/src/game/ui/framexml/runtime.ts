/**
 * Booting the client's OWN glue interface: fetch `Interface\GlueXML\GlueXML.toc`, run its files in
 * order, and hand back a live tree plus the load report.
 *
 * Everything below this line already existed and is unchanged by this file -- `toc.ts` reads the
 * manifest, `xml.ts` parses a document, `templates.ts` merges `inherits=`, `loader.ts` materializes it
 * through the Lua object model, `lua/api/` supplies the engine globals. What was missing was the thing
 * that puts them in a row against real client data, and the four decisions that takes:
 *
 *  1. **Everything is prefetched before anything runs.** `loadDocument`'s resolver is SYNCHRONOUS by
 *     design (it is what lets its tests run whole documents from inline strings), and the asset host is
 *     not. So this walks the manifest first, fetching every file and, recursively, every path an
 *     `<Include>` or `<Script file=>` names, into one text cache -- and only then runs a single
 *     synchronous pass. A file that 404s is left absent, which surfaces as the loader's own
 *     "no provider hit" warning rather than as a rejected promise that takes the screen with it.
 *
 *  2. **One `FrameXmlRuntime` for the whole manifest**, because the template and font registries have
 *     to outlive a document: `AccountLogin.xml` inherits `GlueButtonTemplateBlue` from
 *     `GlueButtons.xml` and `GlueEditBoxFont` from `GlueFontStyles.xml`, and a per-file registry would
 *     drop every such inherit silently -- the frame still builds, just with none of its template.
 *
 *  3. **The screen is shown the way the client shows it**, by calling `SetGlueScreen("login")`
 *     (glueparent.lua:130) rather than by reaching for `AccountLogin:Show()` ourselves. Every glue
 *     screen is authored `hidden="true"`; which one is up is a decision the client's own Lua makes, and
 *     borrowing that decision means the same `SetCurrentScreen`/music/ambience path runs too.
 *
 *  4. **Art is discovered from the finished tree, not declared.** A hand-written screen registers a
 *     sprite TABLE (`screens/login-art.ts`) mapping short keys to paths; a document has no such table
 *     and names its art by path inline. So after the load this walks the widgets and registers each
 *     path it finds under ITSELF as the key -- which is also what makes `SetBackdrop` implementable at
 *     all (`lua/methods/frame.ts`), since `BackdropDef` holds keys and the keys are now the paths.
 *
 * What this file deliberately does NOT do: dispatch `OnUpdate` GENERALLY. The reason it first gave --
 * that a handler body's `elapsed` compiled to a nil global -- no longer holds:
 * `lua/scripts.ts#SCRIPT_PARAMS` now compiles each handler with the engine's own parameter list, so
 * `OnUpdate` receives a real `elapsed`. What is still missing is the rest of what a tick implies (the
 * presence mirror the design's §10 asks for, and a decision about what a 292-frame per-tick dispatch
 * costs), so the general tick stays off.
 *
 * TWO NAMED FRAMES are ticked, each because one specific client system is entirely inside its handler
 * and does not work at all without it: `GlueParent` (the glue fade, and therefore the
 * login -> charselect transition) and `CharacterSelectUI` (drag-to-rotate). Both are argued at their
 * call sites in `update` below, as FOUR and FIVE. Adding a third is a decision, not a pattern to
 * follow: every one of these is a frame whose tick is load-bearing and whose cost is one call.
 */
import Loader from '../../net/loader';
import { GlueArt } from '../art';
import { ProtocolSession } from '../../../network/protocol/session';
import { CharacterRecord } from '../../../network/protocol/types';
import { Viewport } from '../layout';
import { Widget } from '../widget';
import { caretOffset } from '../text';
import { LoadReport, createFrameXmlRuntime, loadDocument } from './loader';
import { parseToc } from './toc';
import { parseXml } from './xml';
import { installCompat } from './lua/compat';
import { fireEvent } from './lua/events';
import { drainScriptErrors, invokeScriptHandler } from './lua/scripts';
import { FocusSink, FrameRegistry, MethodContext, installObjectModel } from './lua/object';
import { syncInteractiveArt } from './lua/methods/kinds';
import { LuaVM } from './lua/vm';
import { installCharactersApi } from './lua/api/characters';
import { installLoginApi } from './lua/api/login';
import { installRealmsApi } from './lua/api/realms';
import { installScreenApi } from './lua/api/screen';
import { installSoundApi } from './lua/api/sound';
import { installStubApi } from './lua/api/stubs';

const GLUE_DIR = 'Interface\\GlueXML\\';
const TOC = 'GlueXML.toc';

export interface GlueRuntimeOptions {
  /** The widget the document's frames are built under -- the mounted screen's own root. */
  root: Widget;
  /** The app's art table. Every path the document names is registered here and then fetched. */
  art: GlueArt;
  /** The live pre-world session the engine API binds to. */
  protocol: ProtocolSession;
  /**
   * The screen's focus router, which is what makes `EditBox:SetFocus`/`ClearFocus`/`HasFocus` real
   * (`lua/object.ts`'s `FocusSink`). Optional: without it those three report themselves as a gap
   * instead of lying, and everything else still loads.
   */
  input?: FocusSink;
  /** Stop after this manifest entry, inclusive. Everything after it is not run at all. */
  stopAfter?: string;
  /** `QuitGame` -- what leaving the client means to the host. */
  onQuitGame?: () => void;
  /** `SetCurrentScreen(name)`, which the client's Lua calls on every screen change. */
  onSetCurrentScreen?: (name: string) => void;
  /**
   * `SetCharSelectBackground(path)` / `SetCharCustomizeBackground(path)` -- the 3D stage, as a model
   * PATH, exactly as `SetBackgroundModel` (glueparent.lua:378-382) builds it. Without it the two
   * calls report themselves once instead of silently doing nothing.
   */
  onSetBackgroundModel?: (path: string) => void;
  /**
   * `SelectCharacter(id)` -- WHICH roster row the client's Lua just selected, resolved to the record.
   *
   * The sibling of `onSetBackgroundModel`, and it has to be a second hook rather than a reading of
   * the first: `CharacterSelect_SelectCharacter` sets the STAGE from a token
   * (`GetSelectBackgroundModel` answers `"HUMAN"`, or `"DEATHKNIGHT"` for a death knight of any race)
   * and then selects the character, characterselect.lua:430-433. The token carries neither the gender
   * nor the appearance bytes the body needs, so the stage path cannot stand in for this one.
   *
   * Deliberately NOT `SetCharSelectModelFrame`. That call names the FRAME the engine draws the
   * character into and is still a no-op; this milestone puts the character on the one 3D stage the
   * host already owns, which needs no per-widget model state. The two are independent.
   */
  onSelectCharacter?: (character: CharacterRecord | null) => void;
  /**
   * `SetCharacterSelectFacing(degrees)` -- how far the character on the stage has been turned.
   *
   * DEGREES, not radians, and the client's own two constants are the proof:
   * `CHARACTER_ROTATION_CONSTANT = 0.6` (characterselect.lua:4) multiplies a CURSOR PIXEL DELTA into
   * this value, and `CHARACTER_FACING_INCREMENT = 2` (charactercreate.lua:1) is one frame of a held
   * rotate arrow. 0.6 units per pixel is one full turn across 600 authored pixels and 2 units per
   * frame is 120 per second, both of which are sensible in degrees and absurd in radians (600 px
   * would be 57 revolutions).
   */
  onSetCharacterFacing?: (degrees: number) => void;
  viewport?: () => Viewport;
}

/** What one document contributed, kept per file so a report line can be traced to its source. */
export interface FileReport {
  file: string;
  kind: 'lua' | 'xml' | 'missing';
  frames: number;
  warnings: string[];
  errors: string[];
}

export interface GlueRuntime {
  readonly vm: LuaVM;
  readonly ctx: MethodContext;
  readonly registry: FrameRegistry;
  /** The whole manifest's totals, warnings deduped across files. */
  readonly report: LoadReport;
  /** Per file, in load order. */
  readonly files: FileReport[];
  /** Per-frame work the document itself cannot do. Safe to call before/after anything. */
  update(dt: number): void;
  /** THE teardown: `FrameRegistry.reset()` plus every subscription and the VM itself. */
  dispose(): void;
}

/** `Interface\GlueXML\...` paths, as the one key a cached file is looked up by. */
function cacheKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

/**
 * Fetches the manifest and every file it (transitively) names, up to and including `stopAfter`.
 *
 * Returns the load order and a text cache. A file that cannot be fetched is simply absent from the
 * cache: the loader reports the miss itself, per reference, and one missing include costs an include
 * rather than the screen.
 */
async function prefetch(
  stopAfter: string,
): Promise<{ order: string[]; texts: Map<string, string>; tocMissing: boolean }> {
  const texts = new Map<string, string>();
  const missing = new Set<string>();

  const fetchText = async (path: string): Promise<string | null> => {
    const key = cacheKey(path);
    const cached = texts.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (missing.has(key)) {
      return null;
    }
    try {
      const bytes = await new Loader().load(GLUE_DIR + path);
      const text = new TextDecoder('utf-8').decode(bytes);
      texts.set(key, text);
      return text;
    } catch {
      missing.add(key);
      return null;
    }
  };

  const tocText = await fetchText(TOC);
  if (tocText === null) {
    return { order: [], texts, tocMissing: true };
  }

  const all = parseToc(tocText).files;
  const stop = all.findIndex((file) => cacheKey(file) === cacheKey(stopAfter));
  const order = stop === -1 ? all : all.slice(0, stop + 1);

  // The referenced-file closure. Depth-first over `<Include>`, since an included document may include
  // another, and `<Script file=>` targets are leaves.
  const seen = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    const key = cacheKey(path);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const text = await fetchText(path);
    if (text === null || !/\.xml$/i.test(path)) {
      return;
    }
    for (const item of parseXml(text).items) {
      if (item.kind === 'include' || item.kind === 'script') {
        await walk(item.path);
      }
    }
  };
  for (const file of order) {
    await walk(file);
  }

  return { order, texts, tocMissing: false };
}

/**
 * Boots the client's glue interface onto `options.root` and returns the live runtime.
 *
 * Never rejects for a data problem: a missing file, a Lua error, an unmodelled method are all report
 * lines, because that is what the client does with them and because the report is the point.
 */
export async function bootGlueRuntime(options: GlueRuntimeOptions): Promise<GlueRuntime> {
  const stopAfter = options.stopAfter ?? 'CharacterSelect.xml';
  const { order, texts, tocMissing } = await prefetch(stopAfter);

  const vm = new LuaVM();
  // The queue is module-level (see `scripts.ts`), so anything a PREVIOUS runtime's last cascade left
  // behind would otherwise be attributed to this boot's report. Discarded, not reported: it was already
  // logged to the console when it happened, under the screen that caused it.
  drainScriptErrors();
  installCompat(vm);
  const registry = new FrameRegistry(options.root);
  const ctx = installObjectModel(vm, registry, options.input ?? null);

  installScreenApi(vm, {
    viewport: options.viewport,
    onQuitGame: options.onQuitGame,
    onSetCurrentScreen: options.onSetCurrentScreen,
  });
  installSoundApi(vm);
  installStubApi(vm);
  const unsubscribeLogin = installLoginApi(vm, options.protocol);
  const unsubscribeRealms = installRealmsApi(vm, options.protocol);
  const unsubscribeCharacters = installCharactersApi(
    vm,
    options.protocol,
    options.onSetBackgroundModel,
    options.onSelectCharacter,
    options.onSetCharacterFacing,
  );

  const runtime = createFrameXmlRuntime(vm, ctx);
  const resolve = (path: string): string | null => texts.get(cacheKey(path)) ?? null;

  const files: FileReport[] = [];
  const report: LoadReport = { warnings: [], errors: [], frames: 0 };
  if (tocMissing) {
    report.errors.push(`${GLUE_DIR}${TOC}: could not be fetched; nothing was loaded`);
  }

  for (const file of order) {
    const text = resolve(file);
    if (text === null) {
      files.push({ file, kind: 'missing', frames: 0, warnings: [], errors: [`${file}: not found`] });
      continue;
    }
    if (/\.lua$/i.test(file)) {
      const error = vm.run(text, file);
      files.push({
        file,
        kind: 'lua',
        frames: 0,
        warnings: [],
        errors: error === null ? [] : [`${file}: ${error.message}`],
      });
      continue;
    }
    const fileReport = loadDocument(runtime, parseXml(text), resolve, file);
    files.push({ file, kind: 'xml', ...fileReport });
  }

  for (const entry of files) {
    report.frames += entry.frames;
    for (const warning of entry.warnings) {
      // Deduped across files as well as within one: `warnOnce` is per-document, so a method this
      // runtime does not model is one line per file that uses it without this.
      if (!report.warnings.includes(warning)) {
        report.warnings.push(warning);
      }
    }
    report.errors.push(...entry.errors);
  }

  // The client's own post-load sequence: FRAMES_LOADED (GlueParent localizes), then the screen.
  fireEvent(vm, 'FRAMES_LOADED');
  const screenError = vm.run('SetGlueScreen("login")', 'runtime.ts:SetGlueScreen');
  if (screenError !== null) {
    report.errors.push(`SetGlueScreen("login"): ${screenError.message}`);
  }
  // Showing the screen is what fires every newly-visible frame's `OnShow` (`methods/region.ts`), and
  // one of those raising must not abort the screen change -- so those failures are queued rather than
  // thrown, and this is where they join the report. Drained AFTER `SetGlueScreen`, since that call is
  // the one that triggers the whole cascade.
  report.errors.push(...drainScriptErrors());

  await registerTreeArt(options.art, options.root);

  const editBoxes = collectEditBoxes(registry, options.root);
  const glueParentId = registry.byName('GlueParent');
  /**
   * `CharacterSelectUI` (characterselect.xml:155) -- the frame whose `<Scripts>` block IS the client's
   * drag-to-rotate, and it is NOT `CharacterSelect`.
   *
   * That distinction cost an afternoon, so it is written down: the three handlers live at
   * characterselect.xml:825-835 on `<Frame name="CharacterSelectUI" setAllPoints="true"
   * enableMouse="true">`, the fullscreen child, not on the `<ModelFFX name="CharacterSelect">` that
   * contains it. `CharacterSelect` has an `<OnUpdate>` of its own (`:921`,
   * `CharacterSelect_OnUpdate(elapsed)`) which is the realm-split panel and nothing to do with
   * rotation -- so dispatching the outer frame runs the wrong handler and looks exactly like a
   * rotation that does not work. `OnMouseDown` latches `CHARACTER_SELECT_ROTATION_START_X`,
   * `OnUpdate` integrates the cursor delta into `SetCharacterSelectFacing`, `OnMouseUp` clears the
   * latch (characterselect.lua:478-497).
   *
   * Nothing has to be mouse-enabled by hand for this: `CharacterSelectUI` carries
   * `enableMouse="true"` itself, which is one of the six the object model's comment counts, and the
   * loader turns that into a real `EnableMouse(true)`.
   */
  const characterSelectUiId = registry.byName('CharacterSelectUI');
  const input = options.input ?? null;
  /** Seconds since the boot, for the caret blink. */
  let caretClock = 0;

  return {
    vm,
    ctx,
    registry,
    report,
    files,
    update: (dt: number) => {
      // The three things the document cannot do for itself.
      //
      // ONE: an `editbox` widget draws no glyphs (only a `fontstring` does), so the box's live value is
      // mirrored into the FontString the loader adopted as its text region. `displayText`, not `text`,
      // because that is where password masking lives.
      //
      // TWO: the caret, which is OURS -- see `placeCaret`.
      //
      // THREE: every button's state art, which follows from three fields the INPUT ROUTER writes
      // directly (`state`, `hovered`, `checked`) and no method sees. `methods/kinds.ts#syncInteractiveArt`
      // is the recompute; this is the tick that drives it, and it is the difference between a button
      // that lights and presses and one that is a painted picture of a button.
      caretClock += dt;
      const litCaret = caretClock % (CARET_BLINK_SECONDS * 2) < CARET_BLINK_SECONDS;
      for (const { box, caret } of editBoxes) {
        if (box.textRegion !== null) {
          box.textRegion.text = box.displayText;
        }
        placeCaret(box, caret, input, litCaret);
      }
      for (const id of collectButtons(registry, options.root)) {
        syncInteractiveArt(ctx, id);
      }
      // FOUR: `GlueParent`'s own `<OnUpdate>`, and ONLY that one frame's.
      //
      // This is not the general `OnUpdate` tick the header above declines to fire; it is one named
      // frame whose entire handler body is `GlueFrameFadeUpdate(elapsed)` (glueparent.xml:14-16), which
      // is the client's whole glue fade system. Without it `GlueFrameFade*` queues frames into
      // `FADEFRAMES` and nothing ever drains the list, and that is not cosmetic: `GlueScreenExit`
      // ("login" -> "charselect") hands `GoToPendingGlueScreen` to `GlueFrameFadeOut` as its FINISHED
      // callback (glueparent.lua:249-252), so the login-to-character-select transition never completes
      // at all. Firing it here rather than driving the fade to completion by hand keeps the alpha ramp
      // and the completion callback the client's, in the order the client puts them.
      if (glueParentId !== null) {
        invokeScriptHandler(ctx, glueParentId, 'OnUpdate', [dt]);
      }
      // FIVE: `CharacterSelectUI`'s own `<OnUpdate>`, and ONLY that one frame's.
      //
      // The same named-frame exception as FOUR, for the same kind of reason: this handler body is
      // `CharacterSelectFrame_OnUpdate()`, which is the ENTIRETY of drag-to-rotate on this screen --
      // it reads `GetCursorPosition()`, multiplies the delta by `CHARACTER_ROTATION_CONSTANT` and
      // writes `SetCharacterSelectFacing` (characterselect.lua:490-497). Firing it here means the
      // rotation law, its constant and its per-frame integration all stay the client's; the host
      // supplies only the cursor (`lua/api/screen.ts`) and the resulting yaw.
      //
      // It is a no-op until the drag starts: the handler's whole body is guarded on
      // `CHARACTER_SELECT_ROTATION_START_X`, which only `OnMouseDown` sets.
      //
      // The ROTATE ARROWS are deliberately not dispatched alongside it, and that is a real gap rather
      // than a choice: `CharacterSelectRotateLeft/Right_OnUpdate` add `CHARACTER_FACING_INCREMENT`,
      // which is defined in `charactercreate.lua:1` -- a file this runtime's `stopAfter` never loads.
      // Ticking them would evaluate `GetCharacterSelectFacing() - nil` once per frame per button.
      if (characterSelectUiId !== null) {
        invokeScriptHandler(ctx, characterSelectUiId, 'OnUpdate', [dt]);
      }
    },
    dispose: () => {
      // Subscriptions first: a session event arriving after the VM is closed would fire into a dead
      // Lua state, and `reset()` needs a live one to hand its handles back to.
      unsubscribeLogin();
      unsubscribeRealms();
      unsubscribeCharacters();
      registry.reset();
      vm.dispose();
    },
  };
}

/**
 * The caret, OURS.
 *
 * The client's edit-box caret is drawn by its engine with no XML behind it, so there is nothing in the
 * document to materialize and nothing here is cited: a one-unit bar, lit for half a second and dark for
 * half a second. `screens/login.ts` draws the same thing by hand for the transcription, with the same
 * two constants -- and this lives in the runtime rather than per screen precisely because every
 * `<EditBox>` on every glue screen needs it and none of them declares it.
 */
const CARET_WIDTH = 1;
const CARET_BLINK_SECONDS = 0.5;

/** An edit box and the caret bar built for it. */
interface CaretBox {
  box: Widget;
  /** Null for a box with no adopted text region -- there is no font to size a caret from. */
  caret: Widget | null;
}

/**
 * Every `editbox` widget in the tree, each with a caret region built under it. Collected once; the tree
 * is not rebuilt.
 *
 * The caret is created THROUGH THE REGISTRY (`create('Texture', ...)`), not as a loose `Widget`, so it
 * is torn down by the same `reset()` as everything else and cannot outlive the screen. It is anchored to
 * the box's TEXT REGION rather than to the box, which is what makes the authored `<TextInsets>` apply
 * for free -- `kinds.ts#anchorTextRegion` has already inset that region, so the caret starts where the
 * first character does without repeating the arithmetic.
 */
function collectEditBoxes(registry: FrameRegistry, root: Widget): CaretBox[] {
  const boxes: CaretBox[] = [];
  const walk = (widget: Widget): void => {
    if (widget.kind === 'editbox') {
      boxes.push({ box: widget, caret: buildCaret(registry, widget) });
    }
    // A copy: `buildCaret` adds a child to the box, and walking the live array would then descend into
    // the caret it just made.
    [...widget.children].forEach(walk);
  };
  walk(root);
  return boxes;
}

function buildCaret(registry: FrameRegistry, box: Widget): Widget | null {
  const region = box.textRegion;
  const boxId = registry.idOfWidget(box);
  if (region === null || boxId === null) {
    return null;
  }
  const caret = registry.widget(registry.create('Texture', null, boxId));
  if (caret === null) {
    return null;
  }
  caret.layer = 'OVERLAY';
  caret.solid = true;
  caret.vertexColor = region.font?.color ?? '#ffffff';
  caret.setSize(CARET_WIDTH, region.font?.size ?? 12).setAnchors({
    point: 'LEFT',
    relativeTo: region.id,
    relativePoint: 'LEFT',
    x: 0,
    y: 0,
  });
  caret.shown = false;
  return caret;
}

/**
 * Put the caret where the next character will land, and blink it, for the focused box only.
 *
 * Measured against `displayText`, so a password box positions against the MASKED string: measuring the
 * real one would put the caret at the real characters' widths and leak them on screen -- the same rule
 * `screens/login.ts#placeCaret` states. Measured at scale 1 because `caretOffset` returns logical units,
 * which the layout scale divides back out anyway.
 *
 * `shown` is assigned rather than `show()`/`hide()` called: a blink is twice a second, and `show()`
 * re-stamps the draw order.
 */
function placeCaret(box: Widget, caret: Widget | null, input: FocusSink | null, lit: boolean): void {
  if (caret === null) {
    return;
  }
  if (!lit || input === null || input.focused !== box) {
    caret.shown = false;
    return;
  }
  const spec = box.textRegion?.font ?? null;
  if (spec === null) {
    caret.shown = false;
    return;
  }
  caret.anchors[0].x = caretOffset(box.displayText, spec, 1, box.caret);
  caret.shown = true;
}

/**
 * Every BUTTON/CHECKBUTTON frame id in the tree, for the per-frame art poll.
 *
 * WALKED PER TICK, not collected once at boot -- and it used to be the latter, on the grounds that a
 * frame created from Lua after the load got none of its template's regions and so had no state textures
 * to repaint. `CreateFrame`'s template argument is real now (`loader.ts#applyTemplate`), so that ground
 * is gone: `GlueDropDownMenu_AddButton` and `RealmList_UpdateTabs` build real templated BUTTONs with
 * real `<NormalTexture>`/`<HighlightTexture>` regions, long after the load, and a boot-time snapshot
 * would leave every one of them a painted picture that never lights or presses.
 *
 * The cost is one array walk of the widget tree per frame, beside the one `drawList` already does.
 */
function collectButtons(registry: FrameRegistry, root: Widget): number[] {
  const ids: number[] = [];
  const walk = (widget: Widget): void => {
    if (widget.kind === 'button' || widget.kind === 'checkbutton') {
      const id = registry.idOfWidget(widget);
      if (id !== null) {
        ids.push(id);
      }
    }
    widget.children.forEach(walk);
  };
  walk(root);
  return ids;
}

/**
 * Registers every art path the finished tree names, keyed by the path itself, and fetches them.
 *
 * A `Backdrop`'s `bgFile` is registered as TILED, because that is the only thing a backdrop background
 * is ever used for (`backdropPieces` repeats it at `tileSize`) -- and the seam-bleed hazard that makes
 * REPEAT opt-in for ordinary sprites does not apply, since a background samples its whole sheet.
 */
async function registerTreeArt(art: GlueArt, root: Widget): Promise<void> {
  const walk = (widget: Widget): void => {
    if (widget.sprite) {
      art.register(widget.sprite, { path: widget.sprite });
    }
    const backdrop = widget.backdrop;
    if (backdrop) {
      if (backdrop.bgSprite) {
        art.register(backdrop.bgSprite, { path: backdrop.bgSprite, tile: true });
      }
      if (backdrop.edgeSprite) {
        art.register(backdrop.edgeSprite, { path: backdrop.edgeSprite });
      }
    }
    widget.children.forEach(walk);
  };
  walk(root);
  await art.load();
}
