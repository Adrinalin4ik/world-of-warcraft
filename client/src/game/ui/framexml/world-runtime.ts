/**
 * Booting the client's OWN in-world interface: fetch `Interface\FrameXML\FrameXML.toc`, run its
 * files in order, and hand back a live tree plus the load report.
 *
 * This is `runtime.ts`'s sibling, not its replacement. Everything structural is shared -- the
 * manifest prefetch (`manifest.ts`), the per-frame work a document cannot do for itself
 * (`tick.ts`), the loader, the object model, the widget layer. What differs is exactly three things,
 * and each is a real difference rather than a copy that drifted:
 *
 *  1. **The manifest and the directory -- and there are now TWO roots.**
 *     `Interface\FrameXML\FrameXML.toc`, 139 entries, loaded ENTIRE -- no `stopAfter`. The glue
 *     runtime stops after `CharacterCreate.xml` because the glue documents past it name screens this
 *     client has no state for; the world manifest has no such natural cut, and cutting it arbitrarily
 *     would drop the frames the player is here to see.
 *
 *     The second root is `Interface\AddOns\Blizzard_*`, which the real client also loads and this
 *     one did not. Its startup set is ONE addon (`addons.ts` has the census and the `## LoadOnDemand`
 *     reading), and without it `TokenFrame` is nil and the character sheet cannot open at all. It runs
 *     after the manifest and before the login events, in the addon pass below.
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
 * counterpart here yet. Anything whose behaviour lives entirely in an `<OnUpdate>` therefore does not
 * animate -- the chat-frame fade is still in that set. That is a declared gap with a measured reason
 * (see the report), not an oversight.
 *
 * The NAMED exceptions have grown to five, each argued at its own `registry.byName` below:
 * `BonusActionBarFrame`, `CastingBarFrame`, the 24 action buttons, `TemporaryEnchantFrame` and --
 * newest -- `PlayerFrame`, which is what makes `CombatFeedback` animate. The cast bar and
 * `CombatFeedback` are named in this paragraph's older wording as things that do NOT animate; both now
 * do, and the wording is corrected rather than left describing a closed gap.
 */
import { GlueArt } from '../art';
import { Viewport } from '../layout';
import { Widget } from '../widget';
import { LoadReport, createFrameXmlRuntime, loadDocument } from './loader';
import { PrefetchedAddOn, prefetchStartupAddOns } from './addons';
import { cacheKey, prefetchManifest, registerTreeArt } from './manifest';
import { CARET_BLINK_SECONDS, collectButtons, collectEditBoxes, placeCaret, placeSelection } from './tick';
import { parseXml } from './xml';
import { installCompat } from './lua/compat';
import { fireEvent } from './lua/events';
import { drainScriptErrors } from './lua/scripts';
import { FocusSink, FrameRegistry, MethodContext, installObjectModel } from './lua/object';
import { syncInteractiveArt } from './lua/methods/kinds';
import { tickMessageFrames } from './lua/methods/messageframe';
import { LuaVM } from './lua/vm';
import { installScreenApi } from './lua/api/screen';
import { raceClassData } from '../../pipeline/dbc/race-class-data';
import { installSecureApi } from './lua/api/secure';
import { installSoundApi } from './lua/api/sound';
import { installStubApi } from './lua/api/stubs';
import { installActionsApi } from './lua/api/actions';
import { installAccountApi } from './lua/api/account';
import { installUnitsApi } from './lua/api/units';
import { installPortraitApi } from '../portrait-bridge';
import { installBindingsApi, setBindingTable } from './lua/api/bindings';
import { installCastingApi } from './lua/api/casting';
import { installItemsApi } from './lua/api/items';
import { installSpellsApi } from './lua/api/spells';
import { installCursorApi } from './lua/api/cursor';
import { installAddOnsApi, markAddOnLoaded } from './lua/api/addons';
import { DEFAULT_BINDINGS, fetchBindings } from './bindings';
import { invokeScriptHandler } from './lua/scripts';
import type { FileReport } from './runtime';

const FRAMEXML_DIR = 'Interface\\FrameXML\\';

/**
 * The separator between an addon's name and its file in a report label -- one backslash, matching the
 * manifest paths the rest of the report prints.
 *
 * A named constant because writing it inline as a template literal silently produced the LITERAL
 * text "Blizzard_TokenUI${file}" in every addon's file report: the escape needed to get a backslash
 * next to a `$` also escaped the interpolation. Caught on a live run, not on paper.
 */
const ADDON_LABEL_SEP = '\\';
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
  /**
   * Called once the engine globals are installed and BEFORE the first manifest file runs, so a host can
   * put real world state behind them.
   *
   * The reference client has the player's data before FrameXML loads and several documents read unit
   * state in their `OnLoad`. One of them cannot recover from a zero -- `MainMenuExpBar` hides itself on
   * a zero max and its own `<OnValueChanged>` returns early while hidden -- so "load first, feed after"
   * is not merely late, it is permanent. See `ui/unit-bridge.ts#seedUnitSnapshots`.
   *
   * Snapshots only. Events belong to the bridges, which attach after the tree exists.
   */
  seed?: (vm: LuaVM) => void;
  /**
   * Called during the manifest load with (files executed, total), so a host can drive a real progress
   * readout. Called only at a YIELD point -- calling it per file would report progress the browser has
   * no opportunity to draw.
   */
  onProgress?: (done: number, total: number) => void;
}

export interface WorldRuntime {
  readonly vm: LuaVM;
  readonly ctx: MethodContext;
  readonly registry: FrameRegistry;
  /** The whole manifest's totals, warnings deduped across files. */
  readonly report: LoadReport;
  /** Per file, in load order. */
  readonly files: FileReport[];
  /**
   * Wall clock across the whole execution pass, in ms. Fetching is not counted -- it is async.
   *
   * **This is no longer one block.** The loop yields every `YIELD_EVERY` files (see the loop), so this
   * includes the yields and everything the browser does inside them. `longestBlockMs` is the number
   * that answers "how long was the screen frozen".
   */
  readonly loadMs: number;
  /**
   * The longest UNBROKEN synchronous span of the execution pass, in ms -- the actual freeze.
   *
   * Reported separately because `loadMs` stopped being a block when the yield landed, and a stall
   * measurement taken from `loadMs` afterwards would silently be measuring something else.
   */
  readonly longestBlockMs: number;
  /**
   * Wall clock for the `Interface\AddOns\Blizzard_*` startup pass only, in ms -- execution, not fetch.
   *
   * Reported apart from `loadMs` on purpose. Rounds 28 and 28b spent themselves getting the interface's
   * first draw down, and adding a second manifest root is exactly the kind of change that gives some of
   * that back without anyone noticing. A separate number is the detector.
   */
  readonly addOnsMs: number;
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
  // `Bindings.xml` is fetched ALONGSIDE the manifest and not after it. It is one 37 KB file against the
  // manifest's 264, so it costs nothing here -- and it has to be in hand before the first file runs, for
  // the reason `installBindingsApi` is called early below. Fetching it after the load would be the
  // `Spell.dbc` mistake in miniature (`ui/action-bridge.ts`): a fetch that starves the boot.
  const [{ order, texts, tocMissing }, bindingCommands, { startup: addOns, demand }] = await Promise.all([
    prefetchManifest(FRAMEXML_DIR, TOC, options.stopAfter),
    fetchBindings(),
    // THE `Interface\AddOns\Blizzard_*` STARTUP SET, fetched alongside the manifest for the same
    // reason `Bindings.xml` is: it is 23 `.toc` probes plus one addon's three files against the
    // manifest's 264, and it has to be in hand before the load ends so the addons can run in the
    // client's own order -- FrameXML, then addons, then the login events.
    //
    // `options.stopAfter` SUPPRESSES it. That option exists so a measurement can bisect the manifest,
    // and an addon executed on top of a deliberately truncated FrameXML would inherit templates that
    // were never registered -- so a bisect run would report the addon's failures as its own.
    options.stopAfter === undefined
      ? prefetchStartupAddOns()
      : Promise.resolve({ startup: [] as PrefetchedAddOn[], demand: Promise.resolve(new Map()) }),
  ]);

  const started = performance.now();
  const vm = new LuaVM();
  // The queue is module-level (see `scripts.ts`), so anything a PREVIOUS runtime's last cascade left
  // behind would otherwise be attributed to this boot's report.
  drainScriptErrors();
  installCompat(vm);
  const registry = new FrameRegistry(options.root);
  const ctx = installObjectModel(vm, registry, options.input ?? null);

  installScreenApi(vm, { viewport: options.viewport });
  // `ChrRaces.dbc` / `ChrClasses.dbc`, KICKED HERE rather than at `attachUnitBridge` (which runs after
  // this whole function returns). Not awaited: nothing in the load needs it and `UnitRace`/`UnitClass`
  // already document that they answer nil until it lands. Moved earlier because the client's own
  // `VARIABLES_LOADED` handlers read `UnitClass("player")` and a ~20-second manifest load is plenty of
  // time for a two-table DBC -- so this costs nothing and removes a race rather than papering over one.
  //
  // It is HALF the fix for the blank stat panes -- the other half is re-seeding the snapshot after it
  // lands, because the seed that runs before the manifest caches a null class. See the await below.
  void raceClassData.ensureLoaded();
  installSoundApi(vm);
  installStubApi(vm);
  // The two that landed with the `TargetFrame` survey and had no caller until this host existed.
  installSecureApi(vm);
  installUnitsApi(vm);
  // `SetPortraitTexture(texture, unit)` -- the unit frames' 3D faces, against the model booth.
  //
  // BEFORE the load, and that is the whole of whether a portrait ever appears: `UnitFrame_Initialize`
  // asks for it exactly once, from every unit frame's own `<OnLoad>` (`unitframe.lua:51`), and nothing
  // asks again -- `PlayerFrame`'s `<OnEvent>` does not handle `UNIT_PORTRAIT_UPDATE`, so the event that
  // line registers is delivered to a handler that ignores it. Installed after the load (as a bridge, its
  // first shape) the global existed for every caller except the only one that matters. See
  // `ui/portrait-bridge.ts` for the measurement.
  installPortraitApi(vm, ctx, registry);
  // The action bar's globals. Safe with no host feed at all: every slot is empty, so `HasAction` is
  // false everywhere and all 12 buttons stay hidden -- which is exactly the state before this existed.
  installActionsApi(vm);
  // The account's expansion, which is what `ReputationFrame_OnLoad` turns into `MAX_PLAYER_LEVEL`.
  // Installed BEFORE the load for that reason: it is read by a handler the load itself fires.
  installAccountApi(vm);
  // THE KEY BINDINGS. Installed before the load, and the table itself is filled just below, because
  // `ActionButton_OnLoad` calls `ActionButton_UpdateHotkeys` -> `GetBindingKey` on every one of the 12
  // buttons DURING the load (`actionbutton.lua:99`). A table filled afterwards would leave every hotkey
  // showing the range indicator until something else re-ran the update.
  installBindingsApi(vm);
  setBindingTable(vm, bindingCommands, DEFAULT_BINDINGS);
  // `UnitCastingInfo`/`UnitChannelInfo`. `CastingBarFrame_OnEvent` reads them on `PLAYER_ENTERING_WORLD`
  // (which this boot fires below), so they must exist before the load, not after.
  installCastingApi(vm);
  // `GetItemQualityColor`, and it is not a small one: its absence killed `UIParent.lua` at line 102, at
  // FILE SCOPE, taking `ShowUIPanel`, `HideUIPanel`, `ToggleFrame`, `UIParent_OnLoad` and the whole
  // `UIPARENT_MANAGED_FRAME_POSITIONS` table with it. See `lua/api/items.ts` for the measurement.
  installItemsApi(vm);
  /**
   * THE SPELLBOOK's globals, and they must exist BEFORE the load rather than after it.
   *
   * `SpellBookFrame_OnLoad` runs during the manifest load and reaches `GetSpellTabInfo` on its way through
   * `SpellBookSkillLineTab_OnClick(nil, 1)` (`spellbookframe.lua:51` -> `:566` -> `:657`), so a set
   * installed afterwards would leave `SpellBookFrame.selectedSkillLineOffset` nil for ever -- and
   * `SpellBook_GetSpellID` adds that value to a button id, so every slot would be nil-indexed. The book is
   * EMPTY at this point (the bridge attaches after the load and pushes then), which is fine: an empty book
   * makes `GetNumSpellTabs` 0 and `GetSpellTabInfo` answer nothing, which is what
   * `SpellBookFrame_Update`'s `i <= numSkillLineTabs` guard is for.
   */
  installSpellsApi(vm);
  // The cursor. Before the load because `SpellButton_OnLoad` calls `RegisterForDrag` on all 12 buttons
  // during it, and because `installCursorApi` is what makes `PickupSpell` exist for those buttons' handlers
  // to be bound against.
  installCursorApi(vm);
  // `IsAddOnLoaded` (read by `uiparent.lua:325` during `VARIABLES_LOADED`) and the `LoadAddOn` gap.
  // Before the load because the addon files run inside the same pass, below.
  installAddOnsApi(vm);

  /**
   * `SHOW_NEWBIE_TIPS` -- an ENGINE global, not a FrameXML one, and the micro buttons' tooltips need it.
   *
   * Nothing in the 264 loaded files ever ASSIGNS it; three of them only read it
   * (`gametooltip.lua:200`, `friendsframe.xml:210,380`), which is the signature of a value the engine
   * publishes from its config. So it has to come from here.
   *
   * **The value is OURS and unsourced**, and the reasoning is worth stating because a nil would look
   * harmless. `GameTooltip_AddNewbieTip`'s two branches are not symmetrical
   * (`gametooltip.lua:199-215`): the `== "1"` branch ends in `GameTooltip:Show()` and the ELSE branch
   * calls `SetOwner` and `SetText` and never shows anything. A micro button's `<OnEnter>` calls nothing
   * but `GameTooltip_AddNewbieTip` and then `AddLine(" ")`
   * (`mainmenubarmicrobuttons.xml:12-21`) -- its own `GameTooltip:Show()` sits inside an
   * `IsEnabled() == 0 and self.minLevel` branch that a normal enabled button never takes. So with this
   * unset or "0", NO micro button could ever display a tooltip, which contradicts what the client
   * demonstrably does. "1" is the value that makes the client's own code path complete, and that is the
   * whole of the evidence for it.
   */
  vm.setGlobal('SHOW_NEWBIE_TIPS', '1');

  // BEFORE the first file runs -- see `WorldRuntimeOptions#seed` for why the order is load-bearing.
  options.seed?.(vm);

  const runtime = createFrameXmlRuntime(vm, ctx);
  const resolve = (path: string): string | null => texts.get(cacheKey(path)) ?? null;

  const files: FileReport[] = [];
  const report: LoadReport = { warnings: [], errors: [], frames: 0 };
  if (tocMissing) {
    report.errors.push(`${FRAMEXML_DIR}${TOC}: could not be fetched; nothing was loaded`);
  }

  /**
   * THE YIELD, and it is what lets the loading screen paint and its bar advance.
   *
   * Running the 264 manifest files back to back is a single synchronous task, and nothing paints
   * inside a task -- so a loading screen presented beforehand would show its FIRST frame and then
   * freeze solid for the whole load. Awaiting a MACROTASK every `YIELD_EVERY` files gives the browser
   * a rendering opportunity in between.
   *
   * `setTimeout` and not a microtask: a resolved promise drains inside the SAME task, so
   * `await Promise.resolve()` yields to nothing and would have measured as a fix while changing
   * nothing on screen.
   *
   * **THE TRADE IS REAL AND WAS MEASURED TWICE.** Without a loading screen it was refused: it bought
   * ~0.7 s off the longest block and cost ~4 s of wall clock, i.e. a LATER interface for a slightly
   * shorter freeze. With a screen on the glass the same seconds are spent drawing it and streaming the
   * world rather than staring at nothing, which is why the decision reversed. The extra wall clock is
   * NOT the timer clamp (16 yields x ~4 ms is ~64 ms); it is the render loop and the asset streaming
   * getting the main thread back, which is the point.
   *
   * Safe between files by construction: the manifest is executed in order either way, and nothing else
   * touches this VM during the boot -- the bridges attach after `bootWorldRuntime` resolves, and
   * `WorldUiHost#render` returns immediately while `this.runtime` is unset.
   *
   * 16 is ours: ~6% of the manifest, so the bar moves in visible steps.
   */
  const YIELD_EVERY = 16;
  let done = 0;
  let longestBlockMs = 0;
  let blockStarted = started;
  for (const file of order) {
    done += 1;
    if (done % YIELD_EVERY === 0) {
      options.onProgress?.(done, order.length);
      longestBlockMs = Math.max(longestBlockMs, performance.now() - blockStarted);
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((yielded) => { setTimeout(yielded, 0); });
      blockStarted = performance.now();
    }
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

  /**
   * Run ONE addon's files. Shared by the startup pass and by `LoadAddOn`, deliberately: a second copy
   * would be a second place for the label, the resolver and the `ADDON_LOADED` fire to drift.
   */
  const runAddOn = (addOn: PrefetchedAddOn): boolean => {
    if (addOn.manifest.tocMissing) {
      report.errors.push(`${addOn.dir}${addOn.name}.toc: could not be fetched; the addon was skipped`);
      return false;
    }
    // A resolver over the ADDON's own file closure, falling back to FrameXML's. The fallback is not
    // theoretical tidiness: `<Include>` and `<Script file=>` inside an addon are relative to the addon
    // directory, and keeping the two maps separate is what stops a shared basename resolving to the
    // wrong tree's file -- `Localization.lua` exists in both.
    const resolveAddOn = (path: string): string | null =>
      addOn.manifest.texts.get(cacheKey(path)) ?? texts.get(cacheKey(path)) ?? null;
    for (const file of addOn.manifest.order) {
      // Labelled with the addon name so a file report cannot be confused with a FrameXML entry of the
      // same basename. See `ADDON_LABEL_SEP` for why the separator is a constant.
      const label = [addOn.name, file].join(ADDON_LABEL_SEP);
      const text = resolveAddOn(file);
      if (text === null) {
        files.push({ file: label, kind: 'missing', frames: 0, warnings: [], errors: [`${label}: not found`] });
        continue;
      }
      if (/\.lua$/i.test(file)) {
        const error = vm.run(text, label);
        files.push({
          file: label,
          kind: 'lua',
          frames: 0,
          warnings: [],
          errors: error === null ? [] : [`${label}: ${error.message}`],
        });
        continue;
      }
      files.push({ file: label, kind: 'xml', ...loadDocument(runtime, parseXml(text), resolveAddOn, label) });
    }
    markAddOnLoaded(vm, addOn.name);
    fireEvent(vm, 'ADDON_LOADED', [addOn.name]);
    return true;
  };

  /**
   * THE ADDONS, after the whole manifest and before the login events -- the client's own order.
   *
   * `Interface\AddOns\Blizzard_TokenUI` is the only member of the startup set (see `addons.ts` for
   * the census and the `## LoadOnDemand` reading), and it is not optional decoration:
   * `CHARACTERFRAME_SUBFRAMES` (`characterframe.lua:1`) lists `TokenFrame`, and
   * `CharacterFrame_ShowSubFrame` walks that table doing `_G[value]:Hide()` at
   * `characterframe.lua:28`. With the addon unloaded that is an index of nil, so the character sheet
   * could not open by ANY tab -- which is the owner's report.
   *
   * AFTER the manifest, not interleaved: the addon's XML inherits `HybridScrollFrameTemplate`
   * (`blizzard_tokenui.xml:211`), `SmallMoneyFrameTemplate` (:237), `UIPanelButtonTemplate` (:244) and
   * `OptionsSmallCheckButtonTemplate` (:314), all registered by FrameXML documents, and a template is
   * only resolvable once its own file has run.
   *
   * `ADDON_LOADED` is fired per addon with the addon's name, which is the engine's contract for it --
   * and BEFORE `VARIABLES_LOADED`, since a frame the addon creates has to exist before
   * `LocalizeFrames` walks the tree.
   *
   * No yield inside this loop, unlike the manifest's: the startup set is three files, and the yield
   * exists to let the loading screen's bar advance across 264.
   *
   * `addOnsMs` covers the STARTUP set only. An addon `LoadAddOn` pulls in later -- `Blizzard_CombatLog`
   * during `PLAYER_LOGIN`, on every login -- runs through the same `runAddOn` and lands in `files` and
   * in the report, but not in this number, because it is not a startup cost.
   */
  const addOnsStarted = performance.now();
  for (const addOn of addOns) {
    runAddOn(addOn);
  }
  const addOnsMs = performance.now() - addOnsStarted;

  /**
   * THE ON-DEMAND SET, AWAITED HERE AND NOWHERE ELSE.
   *
   * This is the last moment before the login events, and `UIParent_OnEvent`'s `PLAYER_LOGIN` arm calls
   * `CombatLog_LoadUI()` unconditionally (`uiparent.lua:481`) -- so `LoadAddOn` is used during the boot
   * itself and its files have to be in hand by now. The fetches were started before the execution pass
   * (`addons.ts#prefetchStartupAddOns`), which takes seconds, so this await is expected to cost nothing.
   * It is here so that "did the fetch win the race" is not a question anyone has to ask.
   *
   * `installAddOnsApi` is called a SECOND time, now with the loader. The first call had to happen before
   * the manifest, because `IsAddOnLoaded` is read during the load and this map did not exist yet;
   * re-registering `LoadAddOn` over its own declared gap is cheaper than deferring the whole set.
   */
  const onDemand = await demand;
  installAddOnsApi(vm, (name: string): boolean => {
    const addOn = onDemand.get(name.toLowerCase());
    return addOn === undefined ? false : runAddOn(addOn);
  });


  /**
   * THE STAT PANES' ONE-SHOT, AND WHY IT NEEDED BOTH AN AWAIT **AND** A RE-SEED.
   *
   * `PaperDollFrame_OnEvent`'s `VARIABLES_LOADED` arm writes the two stat-pane CVars exactly once, off
   * `local temp, classFileName = UnitClass("player")` then `strupper(classFileName)`
   * (`paperdollframe.lua:164-165`). A nil class raises `strupper` and the handler dies before its
   * `SetCVar` calls -- and `UpdatePaperdollStats` is a five-way `if index == "PLAYERSTAT_*"` chain with
   * no else, so both panes then keep their placeholders for the whole session.
   *
   * **Measured, in three steps, and the first two diagnoses were wrong:**
   *  1. seeding the CVars empty (`api/screen.ts`) was necessary -- `nil == ""` is false in Lua -- and
   *     not sufficient;
   *  2. awaiting `ChrClasses.dbc` here alone did NOT help, measured: both CVars still read `""`;
   *  3. `PaperDollFrame:IsEventRegistered("VARIABLES_LOADED")` answers **true** and a manual replay of
   *     the handler fills both panes and both dropdown labels. So the event was delivered and the
   *     handler ran -- and the only thing that differs between then and the replay is `UnitClass`.
   *
   * The missing link is that **the DBC landing does not refresh the snapshot**. `options.seed` runs
   * before the manifest and computes `classInfo` from `raceClassData`, which answers null until its
   * tables land (`unit-bridge.ts:96`); nothing re-pushes that snapshot until `attachUnitBridge`, which
   * is after this function returns. So awaiting the fetch fixed the DATA and left the SNAPSHOT stale.
   * Both are needed: await the tables, then re-run the seed, then fire.
   *
   * The await is free because the fetch was kicked before the manifest (see `installScreenApi` above),
   * and `ensureLoaded` catches its own failure (`race-class-data.ts:52-57`) so a 404 cannot reject here.
   * Re-seeding is idempotent -- `seedUnitSnapshots` only calls `setUnit` with a fresh snapshot.
   */
  await raceClassData.ensureLoaded();
  options.seed?.(vm);

  /**
   * THE REST OF THE ORDERING HAZARD, NAMED AND NOT FIXED HERE.
   *
   * These handlers read unit state, and one of them cannot recover from reading it early:
   * `PaperDollFrame_OnEvent`'s `VARIABLES_LOADED` arm writes the two stat-pane CVars exactly once, off
   * `UnitClass("player")` then `strupper(classFileName)` (`paperdollframe.lua:161-174`) -- so a nil
   * class there raises the handler and the character sheet's stat categories stay unset for the whole
   * session. `installScreenApi` now seeds both CVars empty so the client's own `== ""` test can be
   * true (see `api/screen.ts`), and the globals the panes read are all real
   * (`ui/paperdoll-stats.ts`), but the panes were still measured blank after a full login.
   *
   * Every OTHER login handler that reads unit state reads it out of the snapshots `options.seed` put
   * in before the manifest, which is the seam that exists for exactly this. `UnitClass` is the
   * exception only because its answer needs a DBC as well as a snapshot.
   */
  // The client's own login sequence -- see decision 3 in the header for what each one does and where.
  // A handler that raises must not abort the rest, so `fireEvent` queues and this drains once after.
  for (const event of ['VARIABLES_LOADED', 'PLAYER_LOGIN', 'PLAYER_ENTERING_WORLD']) {
    fireEvent(vm, event);
  }

  /**
   * THE REPORT IS AGGREGATED HERE, AFTER THE LOGIN EVENTS, and the move was forced by a measurement.
   *
   * It used to run before them, which was fine while `files` could only grow during the manifest pass.
   * It cannot any more: `PLAYER_LOGIN` calls `CombatLog_LoadUI()` (`uiparent.lua:481`), so
   * `Blizzard_CombatLog` is demand-loaded DURING this sequence and appends its own file reports. With
   * the aggregation before the events, its `Blizzard_CombatLog.lua:275: attempt to call a nil value
   * (global 'getfenv')` was present in `files` and ABSENT from `report.errors` -- an error that only
   * showed up because a live probe happened to print the per-file list. An instrument that cannot see a
   * real failure is the thing this project keeps writing rules about.
   */
  for (const entry of files) {
    report.frames += entry.frames;
    for (const warning of entry.warnings) {
      if (!report.warnings.includes(warning)) {
        report.warnings.push(warning);
      }
    }
    report.errors.push(...entry.errors);
  }

  /**
   * THE FRAME-POSITION PASS, and it is what put the cast bar 60 units too low.
   *
   * `CastingBarFrame`'s XML anchor is `BOTTOM, y = 55` (`castingbarframe.xml:101-112`) and that is NOT
   * where the real client draws it. Its position is MANAGED: `UIPARENT_MANAGED_FRAME_POSITIONS`
   * (`uiparent.lua:1186`) gives it `baseY = true` -- meaning `menuBarTop` -- plus `yOffset = 40`. The
   * authored 55 is only the pre-managed fallback, and the anchors were resolving correctly all along.
   *
   * **`menuBarTop` is 75 HERE, not the 55 this comment used to give, so the managed y is 115 and the bar was
   * 60 units low rather than 40.** 55 is only its initial value (`uiparent.lua:1169`); `UpdateMenuBarTop`
   * raises it to **75** for any aspect ratio wider than 4:3 (`uiparent.lua:1171-1174`), which a browser
   * window essentially always is. Measured live after this call: the bar's bottom edge is at 115 in 768
   * units, up from 55. See `lua/api/screen.ts#GetScreenResolutions`, which is the global whose absence made
   * `UpdateMenuBarTop` -- and therefore this whole pass -- raise on its first statement.
   *
   * It is engine behaviour, which is why it belongs here beside the login events rather than being
   * triggered from a bridge: the real client runs the layout pass once the interface is up. Fifteen
   * frames read that table (`ChatFrame1`/`2`, `PetActionBar`, `ShapeshiftBarFrame`, `MultiBarRight`,
   * `GroupLootFrame1`, ...), so this is one call for all of them and not a fix for one bar.
   *
   * The chain it drives is entirely the client's own: `UIParent_ManageFramePositions()` sets the
   * `uiparent-manage` attribute on `FramePositionDelegate`, whose `OnAttributeChanged`
   * (`uiparent.lua:1319`) calls `UIParentManageFramePositions`, which `SetPoint`s each frame. Our
   * `SetAttribute` already fires `OnAttributeChanged` (`methods/frame.ts:185`), which is what makes the
   * whole delegate reachable -- nothing about it needed a secure environment.
   *
   * AFTER the login events on purpose: the table's offsets depend on which bars are shown, and
   * `PLAYER_ENTERING_WORLD` is what shows them.
   */
  vm.run('if ( UIParent_ManageFramePositions ) then UIParent_ManageFramePositions(); end', 'engine:manage-frame-positions');

  report.errors.push(...drainScriptErrors());

  const loadMs = performance.now() - started;
  // The tail after the last yield -- the login events and the frame-position pass run in it, so it is
  // a real candidate for the longest block rather than a rounding detail.
  longestBlockMs = Math.max(longestBlockMs, performance.now() - blockStarted);

  await registerTreeArt(options.art, options.root);

  const editBoxes = collectEditBoxes(registry, options.root);

  /**
   * ONE named frame's `<OnUpdate>`, and only that one: `BonusActionBarFrame`.
   *
   * The header above declines a GENERAL `OnUpdate` dispatch at 4904 frames and that still stands. This
   * is the same exception `runtime.ts:324-365` makes for four named glue frames, and it is needed for
   * the same kind of reason -- the frame's entire POSITION lives in its `OnUpdate`:
   * `ShowBonusActionBar` only sets `mode = "show"` and a `slideTimer`, and `BonusActionBar_OnUpdate`
   * (`BonusActionBarFrame.lua:31-65`) is what walks the bar from `y = 0` (below the screen, at
   * `MainMenuBar`'s BOTTOMLEFT) to `y = BONUSACTIONBAR_YPOS = 43`, over the main bar, and then sets
   * `state = "top"`. Without the tick a warrior's bar is shown at the bottom edge, mostly off screen.
   *
   * It costs nothing in the steady state, which is why one named frame is affordable: the body returns
   * on its first line once `completed == 1` (:48-50), so it dirties the draw-list fingerprint for the
   * 0.15 s of the slide and never again until the form changes.
   */
  const bonusBarId = registry.byName('BonusActionBarFrame');
  /**
   * A SECOND named frame's `<OnUpdate>`: `CastingBarFrame`.
   *
   * The same exception, for the same kind of reason, and with the same gate. `CastingBarFrame_OnEvent`
   * only sets `self.value`, `self.maxValue`, `casting` and `holdTime`; `CastingBarFrame_OnUpdate`
   * (`castingbarframe.lua:236-296`) is what integrates `value` by `elapsed`, calls `SetValue`, moves the
   * spark and runs the flash-and-fade at the end. Without the tick the bar appears with a fill of zero
   * and never moves -- which is exactly what "there is no cast bar" would look like even with every
   * global in place.
   *
   * Ticked only while SHOWN, and it hides itself: `CastingBarFrame_OnLoad` leaves it hidden,
   * `UNIT_SPELLCAST_START` shows it, and the `fadeOut` branch calls `self:Hide()` when the alpha reaches
   * zero. So the cost is bounded to the cast plus its ~1 s fade, and is zero the rest of the time.
   *
   * This one DOES dirty the draw-list fingerprint on every frame it runs -- a status bar's fill rect is a
   * function of its value, and `drawListSignature` reads the rect. That is unavoidable and is the honest
   * cost of a filling bar: a full interface re-render per frame for the duration of a cast, which
   * `window.uiDrawStats` measures (`dirtyFrames` climbing to `frames` while a cast runs). It is NOT the
   * cooldown sweep's cost -- the sweep is drawn outside the fingerprinted list on purpose
   * (`world-ui.ts#drawSweeps`) and a running cooldown re-renders nothing.
   */
  const castingBarId = registry.byName('CastingBarFrame');

  /**
   * THE ACTION BUTTONS' own `<OnUpdate>` -- 24 named frames, and the third and last exception.
   *
   * `ActionButton_OnUpdate` (`actionbutton.lua:432-490`) does exactly two things, and both are things a
   * player looks at:
   *
   *  - the ATTACK FLASH: the auto-attack button's `Flash` texture toggled every
   *    `ATTACK_BUTTON_FLASH_TIME` (0.4 s, `actionbutton.lua:4`) while swinging.
   *  - the RANGE INDICATOR: `IsActionInRange(self.action)` polled every `TOOLTIP_UPDATE_TIME` and turned
   *    into the HotKey region's vertex colour -- red `(1.0, 0.1, 0.1)` out of range, grey `(0.6, 0.6, 0.6)`
   *    in. **This is the only red in 3.3.5a's action bar**; there is no red mask over an icon anywhere in
   *    this build's FrameXML.
   *
   * Neither is expressible through an event, which is why they need the tick: nothing fires when the
   * player WALKS out of range, and a flash is a timer by definition.
   *
   * Cost, and why 24 is affordable where a general dispatch at 4904 frames is not: the gate below is
   * `shown`, and `ActionButton_Update` HIDES a button whose slot is empty -- so the real set is however
   * many buttons the character has filled (four, for every character on the test account). The body then
   * early-returns unless the flash is running or the 0.2 s range timer has come round, and when it does
   * run it only writes a vertex colour that has usually not changed -- so it dirties the draw-list
   * fingerprint on a real range crossing and not otherwise.
   */
  const actionButtonIds: number[] = [];
  for (let i = 1; i <= 12; i += 1) {
    for (const name of [`ActionButton${i}`, `BonusActionButton${i}`]) {
      const id = registry.byName(name);
      if (id !== null) {
        actionButtonIds.push(id);
      }
    }
  }

  /**
   * A FOURTH named `<OnUpdate>`: `TemporaryEnchantFrame`, and it exists to HIDE something.
   *
   * `TempEnchant1`/`TempEnchant2` are `<Button>`s with no `hidden` attribute (`buffframe.xml:201-217`),
   * so they are born SHOWN and the only thing that ever hides them is
   * `TemporaryEnchantFrame_OnUpdate` -> `TemporaryEnchantFrame_Hide` (`buffframe.lua:380-405`), whose
   * early exit is "not hasMainHandEnchant and not hasOffHandEnchant". Nothing ticked that frame, so two
   * bordered 32x32 squares were drawn for weapon buffs this character does not have -- the artifact
   * `STATE.md` recorded at the window's top-left, which the hidden-widget-rect fix moved to its real
   * place under `ConsolidatedBuffs` at the top RIGHT. Right place, still wrong to be drawn at all.
   *
   * Cost is one call per frame and no fingerprint churn: with `BuffFrame.numEnchants` at 0
   * (`buffframe.lua:37`) the body skips `BuffFrame_Update`, `Hide()` on an already-hidden widget does not
   * restamp, and the `BuffFrame:SetPoint` it re-issues is the same anchor with the same values.
   *
   * NOT gated on `shown`, unlike the three above: this frame is always shown and it is its CHILDREN that
   * are being hidden.
   */
  const tempEnchantId = registry.byName('TemporaryEnchantFrame');

  /**
   * A FIFTH named `<OnUpdate>`: `PlayerFrame`, and it exists so the COMBAT FEEDBACK TEXT can fade.
   *
   * The same exception as the cast bar's, for the same kind of reason. `UNIT_COMBAT` -> the client's own
   * `CombatFeedback_OnCombatEvent` (`combatfeedback.lua:35-105`) only writes the text, its height, its
   * colour, `feedbackStartTime` and `SetAlpha(0.0)`, then `Show()`s it. **It shows the string at alpha
   * ZERO** -- the entire fade-in, the hold and the fade-out live in `CombatFeedback_OnUpdate`
   * (`combatfeedback.lua:107-131`), which `PlayerFrame_OnUpdate` calls as its last statement
   * (`playerframe.lua:423`). Without the tick the indicator is shown and stays PERMANENTLY at alpha
   * zero: not "no animation", but no text at all.
   *
   * `PlayerFrame_OnUpdate` also runs the resting-status pulse (gated on `PlayerStatusTexture:IsShown()`)
   * and the PvP timer (gated on `PlayerPVPTimerText.timeLeft` being non-nil), so those come along and both
   * are already gated in the client's own body.
   *
   * NOT gated on `shown` -- `PlayerFrame` is always shown -- but the FEEDBACK's cost is bounded by the
   * client's own `if ( feedbackText:IsVisible() )` first line, and `CombatFeedback_OnCombatEvent`'s
   * `Hide()` at the end of the fade closes it. So the fingerprint churns for the 1.2 s of one indicator's
   * life (`COMBATFEEDBACK_FADEINTIME` 0.2 + `_HOLDTIME` 0.7 + `_FADEOUTTIME` 0.3) and not otherwise,
   * which is the cast bar's honest cost in a shorter window. That is the difference between this medium
   * and the floating number: the floating one is world geometry and costs the fingerprint nothing
   * (`world/floating-text.ts`), and having BOTH is what the owner asked for.
   */
  const playerFrameId = registry.byName('PlayerFrame');

  /**
   * A SIXTH named `<OnUpdate>`: `CharacterModelFrame`, and it exists because the rotate buttons are
   * unusable without it.
   *
   * The owner's report was "it's hard to rotate using buttons", and that is precisely what the client's
   * own arithmetic predicts if only the click path runs. A CLICK steps the yaw by
   * `rotationIncrement = 0.03` radians -- 1.7 degrees, so a full turn is 209 clicks
   * (`Model_RotateLeft`, `uiparent.lua:2829-2837`). The usable path is the HELD one:
   * `Model_OnUpdate` sweeps `elapsedTime * 2 * PI * ROTATIONS_PER_SECOND` for as long as a rotate
   * button reads `PUSHED`, and `ROTATIONS_PER_SECOND = .5` (`uiparent.lua:2`), i.e. 180 degrees per
   * second. Both numbers are the client's own.
   *
   * It needs nothing else from us: `GetButtonState()` already answers `"PUSHED"` off `Widget#state`,
   * which the input router writes on press (`ui/input.ts#onPointerDown`), and both rotate buttons
   * declare `RegisterForClicks("LeftButtonDown", "LeftButtonUp")` in their own `<OnLoad>`
   * (paperdollframe.xml:490-493). So the whole gap was the tick.
   *
   * Gated on `shown`, like the bonus bar and the cast bar: the character panel is hidden most of the
   * time, and `Model_OnUpdate`'s body does two `_G` lookups and two `GetButtonState` calls per frame.
   */
  const characterModelId = registry.byName('CharacterModelFrame');

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
    longestBlockMs,
    addOnsMs,
    update: (dt: number) => {
      // `UIErrorsFrame`'s messages expiring. FREE when nothing is on screen -- one `Map.size` test --
      // which is almost always; see `methods/messageframe.ts` on why there is no per-frame fade.
      tickMessageFrames(dt);
      caretClock += dt;
      const litCaret = caretClock % (CARET_BLINK_SECONDS * 2) < CARET_BLINK_SECONDS;
      for (const { box, caret, selection } of editBoxes) {
        if (box.textRegion !== null) {
          box.textRegion.text = box.displayText;
        }
        placeCaret(box, caret, input, litCaret);
        placeSelection(box, selection, input);
      }
      // VISIBLE buttons only. `runtime.ts` walks the whole glue tree because 432 widgets is nothing;
      // this tree is 4211 frames and the great majority of them are hidden panels (the spellbook, the
      // talent frame, every `UIPanel`). A hidden frame's state art cannot be observed, and `drawList`
      // prunes the same subtrees -- so this is the same set of pixels for a fraction of the walk.
      for (const id of collectButtons(registry, options.root, false)) {
        syncInteractiveArt(ctx, id);
      }
      // The bonus bar's slide -- see `bonusBarId`. Only while it is shown: hidden, its own body would
      // still run the `completed` check, and a frame nobody can see has no position worth integrating.
      if (bonusBarId !== null && registry.widget(bonusBarId)?.shown) {
        invokeScriptHandler(ctx, bonusBarId, 'OnUpdate', [dt]);
      }
      // The cast bar's fill and spark -- see `castingBarId`. Shown only during a cast and its fade.
      if (castingBarId !== null && registry.widget(castingBarId)?.shown) {
        invokeScriptHandler(ctx, castingBarId, 'OnUpdate', [dt]);
      }
      // The combat feedback text's fade-in, hold and fade-out -- see `playerFrameId`.
      if (playerFrameId !== null) {
        invokeScriptHandler(ctx, playerFrameId, 'OnUpdate', [dt]);
      }
      // The paper doll's rotate buttons, while one is held -- see `characterModelId`.
      if (characterModelId !== null && registry.widget(characterModelId)?.shown) {
        invokeScriptHandler(ctx, characterModelId, 'OnUpdate', [dt]);
      }
      // The weapon-enchant slots hiding themselves -- see `tempEnchantId`.
      if (tempEnchantId !== null) {
        invokeScriptHandler(ctx, tempEnchantId, 'OnUpdate', [dt]);
      }
      // The range indicator and the attack flash -- see `actionButtonIds`. Shown buttons only, which is
      // however many slots the character has filled.
      for (const id of actionButtonIds) {
        if (registry.widget(id)?.shown) {
          invokeScriptHandler(ctx, id, 'OnUpdate', [dt]);
        }
      }
    },
    dispose: () => {
      registry.reset();
      vm.dispose();
    },
  };
}
