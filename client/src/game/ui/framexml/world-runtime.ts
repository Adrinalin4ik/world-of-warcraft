/**
 * Booting the client's OWN in-world interface: fetch `Interface\FrameXML\FrameXML.toc`, run its
 * files in order, and hand back a live tree plus the load report.
 *
 * This is `runtime.ts`'s sibling, not its replacement. Everything structural is shared -- the
 * manifest prefetch (`manifest.ts`), the per-frame work a document cannot do for itself
 * (`tick.ts`), the loader, the object model, the widget layer. What differs is exactly three things,
 * and each is a real difference rather than a copy that drifted:
 *
 *  1. **The manifest and the directory.** `Interface\FrameXML\FrameXML.toc`, 139 entries, loaded
 *     ENTIRE -- no `stopAfter`. The glue runtime stops after `CharacterCreate.xml` because the glue
 *     documents past it name screens this client has no state for; the world manifest has no such
 *     natural cut, and cutting it arbitrarily would drop the frames the player is here to see.
 *
 *  2. **The engine API set.** `installLoginApi`/`installRealmsApi`/`installCharactersApi` are the
 *     PRE-WORLD session's surface (`AccountLogin`, `RealmList`, `CharacterSelect`) and have no
 *     meaning past world entry; installing them here would register globals no in-world document
 *     calls, against a `ProtocolSession` whose stage machine is already finished. What the world
 *     needs instead is `installUnitsApi` (the `Unit*` globals every unit frame is written against)
 *     and `installSecureApi` (`securecall`/`hooksecurefunc`, which `UIDropDownMenu_Initialize` and
 *     most of `SecureTemplates.xml` route through). BOTH OF THOSE WERE WRITTEN AND NEVER WIRED --
 *     they landed with the `TargetFrame` survey and no production boot called either.
 *
 *  3. **The post-load event sequence.** The glue runtime's is `FRAMES_LOADED` then
 *     `SetGlueScreen("login")`. The world's is the client's own login sequence, and it is what turns
 *     a loaded tree into a visible interface: `VARIABLES_LOADED` (uiparent.lua:456 -- `LocalizeFrames`
 *     and the battlefield-minimap/clock/GM-chat decisions), `PLAYER_LOGIN` (:480 --
 *     `CombatLog_LoadUI`), then `PLAYER_ENTERING_WORLD` (:647 -- `MultiActionBar_Update`,
 *     `CloseAllWindows(1)`, `VoiceChat_Toggle`). Without the third, `MultiActionBar_Update` never
 *     runs and the action bars are never laid out.
 *
 * ## What this does NOT do, deliberately
 *
 * **No general `OnUpdate` dispatch.** `runtime.ts`'s header declines it for the glue screens at 432
 * frames; here the tree is 4211 and the argument is stronger, not weaker. The four named frames that
 * runtime ticks are glue-specific (the glue fade, drag-to-rotate, the two rotate arrows) and have no
 * counterpart here yet. Anything whose behaviour lives entirely in an `<OnUpdate>` -- the chat-frame
 * fade, the cast bar's sweep, `CombatFeedback` -- therefore does not animate. That is a declared gap
 * with a measured reason (see the report), not an oversight.
 */
import { GlueArt } from '../art';
import { Viewport } from '../layout';
import { Widget } from '../widget';
import { LoadReport, createFrameXmlRuntime, loadDocument } from './loader';
import { cacheKey, prefetchManifest, registerTreeArt } from './manifest';
import { CARET_BLINK_SECONDS, collectButtons, collectEditBoxes, placeCaret } from './tick';
import { parseXml } from './xml';
import { installCompat } from './lua/compat';
import { fireEvent } from './lua/events';
import { drainScriptErrors } from './lua/scripts';
import { FocusSink, FrameRegistry, MethodContext, installObjectModel } from './lua/object';
import { syncInteractiveArt } from './lua/methods/kinds';
import { LuaVM } from './lua/vm';
import { installScreenApi } from './lua/api/screen';
import { installSecureApi } from './lua/api/secure';
import { installSoundApi } from './lua/api/sound';
import { installStubApi } from './lua/api/stubs';
import { installActionsApi } from './lua/api/actions';
import { installUnitsApi } from './lua/api/units';
import type { FileReport } from './runtime';

const FRAMEXML_DIR = 'Interface\\FrameXML\\';
const TOC = 'FrameXML.toc';

export interface WorldRuntimeOptions {
  /** The widget the document's frames are built under -- the world host's own root. */
  root: Widget;
  /** The host's art table. Every path the document names is registered here and then fetched. */
  art: GlueArt;
  /** The host's focus router, which is what makes `EditBox:SetFocus`/`ClearFocus`/`HasFocus` real. */
  input?: FocusSink;
  /**
   * Stop after this manifest entry, inclusive. Absent means the WHOLE manifest, which is the normal
   * case -- it exists only so a measurement can bisect the load.
   */
  stopAfter?: string;
  viewport?: () => Viewport;
}

export interface WorldRuntime {
  readonly vm: LuaVM;
  readonly ctx: MethodContext;
  readonly registry: FrameRegistry;
  /** The whole manifest's totals, warnings deduped across files. */
  readonly report: LoadReport;
  /** Per file, in load order. */
  readonly files: FileReport[];
  /** How long the synchronous execution pass took, in ms. Fetching is not counted -- it is async. */
  readonly loadMs: number;
  /** Per-frame work the document itself cannot do. Safe to call before/after anything. */
  update(dt: number): void;
  /** THE teardown: `FrameRegistry.reset()` plus the VM itself. */
  dispose(): void;
}

/**
 * Boots the client's in-world interface onto `options.root` and returns the live runtime.
 *
 * Never rejects for a data problem: a missing file, a Lua error, an unmodelled method are all report
 * lines, because that is what the client does with them and because the report is the point.
 */
export async function bootWorldRuntime(options: WorldRuntimeOptions): Promise<WorldRuntime> {
  const { order, texts, tocMissing } = await prefetchManifest(FRAMEXML_DIR, TOC, options.stopAfter);

  const started = performance.now();
  const vm = new LuaVM();
  // The queue is module-level (see `scripts.ts`), so anything a PREVIOUS runtime's last cascade left
  // behind would otherwise be attributed to this boot's report.
  drainScriptErrors();
  installCompat(vm);
  const registry = new FrameRegistry(options.root);
  const ctx = installObjectModel(vm, registry, options.input ?? null);

  installScreenApi(vm, { viewport: options.viewport });
  installSoundApi(vm);
  installStubApi(vm);
  // The two that landed with the `TargetFrame` survey and had no caller until this host existed.
  installSecureApi(vm);
  installUnitsApi(vm);
  // The action bar's globals. Safe with no host feed at all: every slot is empty, so `HasAction` is
  // false everywhere and all 12 buttons stay hidden -- which is exactly the state before this existed.
  installActionsApi(vm);

  const runtime = createFrameXmlRuntime(vm, ctx);
  const resolve = (path: string): string | null => texts.get(cacheKey(path)) ?? null;

  const files: FileReport[] = [];
  const report: LoadReport = { warnings: [], errors: [], frames: 0 };
  if (tocMissing) {
    report.errors.push(`${FRAMEXML_DIR}${TOC}: could not be fetched; nothing was loaded`);
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
      if (!report.warnings.includes(warning)) {
        report.warnings.push(warning);
      }
    }
    report.errors.push(...entry.errors);
  }

  // The client's own login sequence -- see decision 3 in the header for what each one does and where.
  // A handler that raises must not abort the rest, so `fireEvent` queues and this drains once after.
  for (const event of ['VARIABLES_LOADED', 'PLAYER_LOGIN', 'PLAYER_ENTERING_WORLD']) {
    fireEvent(vm, event);
  }
  report.errors.push(...drainScriptErrors());

  const loadMs = performance.now() - started;

  await registerTreeArt(options.art, options.root);

  const editBoxes = collectEditBoxes(registry, options.root);
  const input = options.input ?? null;
  /** Seconds since the boot, for the caret blink. */
  let caretClock = 0;

  return {
    vm,
    ctx,
    registry,
    report,
    files,
    loadMs,
    update: (dt: number) => {
      caretClock += dt;
      const litCaret = caretClock % (CARET_BLINK_SECONDS * 2) < CARET_BLINK_SECONDS;
      for (const { box, caret } of editBoxes) {
        if (box.textRegion !== null) {
          box.textRegion.text = box.displayText;
        }
        placeCaret(box, caret, input, litCaret);
      }
      // VISIBLE buttons only. `runtime.ts` walks the whole glue tree because 432 widgets is nothing;
      // this tree is 4211 frames and the great majority of them are hidden panels (the spellbook, the
      // talent frame, every `UIPanel`). A hidden frame's state art cannot be observed, and `drawList`
      // prunes the same subtrees -- so this is the same set of pixels for a fraction of the walk.
      for (const id of collectButtons(registry, options.root, false)) {
        syncInteractiveArt(ctx, id);
      }
    },
    dispose: () => {
      registry.reset();
      vm.dispose();
    },
  };
}
