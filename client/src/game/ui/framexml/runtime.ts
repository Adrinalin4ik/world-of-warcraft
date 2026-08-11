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
import { GlueArt } from '../art';
import { ProtocolSession } from '../../../network/protocol/session';
import { CharacterRecord } from '../../../network/protocol/types';
import { Viewport } from '../layout';
import { Widget } from '../widget';
import { LoadReport, createFrameXmlRuntime, loadDocument } from './loader';
import { cacheKey, prefetchManifest, registerTreeArt } from './manifest';
import { CARET_BLINK_SECONDS, collectButtons, collectEditBoxes, placeCaret, placeSelection } from './tick';
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
   * Still a second hook and not a reading of `SetCharSelectModelFrame`: that call names WHERE the
   * character draws, this one names WHO. The two are independent and both are honoured -- see
   * `onCharacterModelFrame` below.
   */
  onSelectCharacter?: (character: CharacterRecord | null) => void;
  /**
   * `SetCharSelectModelFrame(name)` (characterselect.lua:33) and `SetCharCustomizeFrame(name)`
   * (charactercreate.lua:75) -- the frame the ENGINE draws the character model into.
   *
   * TWO SLOTS through one hook, discriminated by `kind`, and that discriminator is load-bearing rather
   * than tidy: both `OnLoad`s run during the same boot (`GlueXML.toc` puts the two documents adjacent),
   * so a shared slot has the create screen's answer overwrite the select screen's before either is ever
   * shown. See `api/characters.ts#SetCharSelectModelFrame` for what that cost.
   *
   * The name is passed through verbatim rather than resolved to a frame here, because whether that frame
   * is the one on screen is a question only the host's screen machine can answer
   * (`screens/framexml-screen.ts`, which compares it against `SetCurrentScreen`).
   */
  onCharacterModelFrame?: (kind: 'select' | 'customize', name: string | null) => void;
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

/**
 * Boots the client's glue interface onto `options.root` and returns the live runtime.
 *
 * Never rejects for a data problem: a missing file, a Lua error, an unmodelled method are all report
 * lines, because that is what the client does with them and because the report is the point.
 */
export async function bootGlueRuntime(options: GlueRuntimeOptions): Promise<GlueRuntime> {
  const stopAfter = options.stopAfter ?? 'CharacterSelect.xml';
  const { order, texts, tocMissing } = await prefetchManifest(GLUE_DIR, TOC, stopAfter);

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
    options.onCharacterModelFrame,
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
  /**
   * The two rotate arrows under Enter World (characterselect.xml:204,248).
   *
   * Named-frame exceptions like `GlueParent` and `CharacterSelectUI`, and for the same reason: their
   * whole `<OnUpdate>` body is `CharacterSelectRotate{Left,Right}_OnUpdate(self)`, which is the
   * ENTIRETY of the arrows' behaviour -- `if self:GetButtonState() == "PUSHED" then
   * SetCharacterSelectFacing(GetCharacterSelectFacing() -/+ CHARACTER_FACING_INCREMENT) end`
   * (characterselect.lua:499-509). There is no `OnClick` rotation to fall back on; the buttons rotate
   * ONLY while held, one increment per frame, and a runtime that fires no `OnUpdate` for them makes
   * them dead art.
   *
   * They write the same `SetCharacterSelectFacing` the drag does, so this adds no second facing path.
   */
  const rotateLeftId = registry.byName('CharacterSelectRotateLeft');
  const rotateRightId = registry.byName('CharacterSelectRotateRight');
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
      for (const { box, caret, selection } of editBoxes) {
        if (box.textRegion !== null) {
          box.textRegion.text = box.displayText;
        }
        placeCaret(box, caret, input, litCaret);
        // TWO(b): the selection highlight, also ours and also engine-drawn in the real client. NOT
        // blinked -- only the caret blinks; a flashing selection is not a thing the client does.
        placeSelection(box, selection, input);
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
      if (characterSelectUiId !== null) {
        invokeScriptHandler(ctx, characterSelectUiId, 'OnUpdate', [dt]);
      }
      // SIX: the two ROTATE ARROWS' own `<OnUpdate>`, and only theirs. See the ids above.
      //
      // This used to carry a comment saying they were deliberately left out because
      // `CHARACTER_FACING_INCREMENT` is defined in `charactercreate.lua`, a file `stopAfter` did not
      // reach -- so ticking them would have computed `GetCharacterSelectFacing() - nil`. That was
      // accurate; the fix was to load what the client loads (`CharacterCreate.xml` is now inside
      // `stopAfter`, see `api/characters.ts#SetCharCustomizeFrame`) rather than to invent a constant
      // here. Each handler is a no-op unless its own button is held, which is what makes an
      // unconditional per-frame call correct.
      if (rotateLeftId !== null) {
        invokeScriptHandler(ctx, rotateLeftId, 'OnUpdate', [dt]);
      }
      if (rotateRightId !== null) {
        invokeScriptHandler(ctx, rotateRightId, 'OnUpdate', [dt]);
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


