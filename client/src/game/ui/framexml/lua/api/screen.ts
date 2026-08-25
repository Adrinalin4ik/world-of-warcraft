/**
 * The glue engine's screen/environment surface: window size, a handful of client/environment
 * predicates, and the two calls that leave the game (`QuitGame`) or switch glue screens
 * (`SetCurrentScreen`).
 *
 * `CreateFrame` is deliberately NOT here -- it already exists once `installObjectModel` (Task 2) has
 * run on the VM, and re-registering it here would shadow that one with a worse one.
 */
import { LuaVM } from '../vm';
import { Viewport, viewportUnits } from '../../../layout';
import config from '../../../../../network/config';

export interface ScreenApiOptions {
  /**
   * The window in DEVICE pixels. `GetScreenWidth`/`GetScreenHeight` convert it to logical units
   * through `viewportUnits`; `GetScreenResolutions` reports it as-is. Defaults to the real window.
   */
  viewport?: () => Viewport;
  /** AccountLogin_Exit -- what "leave the client" means outside a real OS process to end. */
  onQuitGame?: () => void;
  /**
   * `SetCurrentScreen(name)` -- which glue screen is up. Screen switching itself lives in
   * `game/ui/screens.ts` (`GlueApp`/`ClientState`), a separate, already-working system this task does
   * not rewire; this is the hook a caller wanting that wired supplies. Left unset, this is a no-op --
   * naming the OWN scope decision rather than a forgotten binding, unlike `stubs.ts`'s no-ops, which
   * name the client's.
   */
  onSetCurrentScreen?: (name: string) => void;
}

function defaultViewport(): Viewport {
  if (typeof window === 'undefined') {
    return { width: 1024, height: 768 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Real, live MODIFIER state, tracked from the DOM -- not a poll, so it has to be a listener.
 *
 * All three, not just Shift, and they are read off the event's own modifier FLAGS rather than off
 * `event.key`: `event.shiftKey`/`ctrlKey`/`altKey` are correct on every keydown and keyup including the
 * ones for other keys, so a modifier held while another key is pressed and released stays true. Watching
 * `event.key === 'Shift'` alone -- which is what this did -- also loses the release when the window loses
 * focus mid-chord, so `blur` clears all three.
 *
 * `IsShiftKeyDown` USED TO BE REGISTERED TWICE, here and as a hard `false` in `api/units.ts`, and units.ts
 * is installed second (`world-runtime.ts:139` then `:144`) -- so in the world the real tracker was shadowed
 * and shift state never reached the Lua. The duplicate is removed there; this is now the only registration
 * of the three.
 */
let shiftDown = false;
let ctrlDown = false;
let altDown = false;
let modifierTrackerInstalled = false;
function ensureModifierTracker(): void {
  if (modifierTrackerInstalled || typeof window === 'undefined') {
    return;
  }
  modifierTrackerInstalled = true;
  const sync = (event: KeyboardEvent): void => {
    shiftDown = event.shiftKey;
    ctrlDown = event.ctrlKey;
    altDown = event.altKey;
  };
  window.addEventListener('keydown', sync);
  window.addEventListener('keyup', sync);
  // A modifier released while the page is not focused never produces a keyup, which would leave the flag
  // stuck true for the rest of the session -- and a stuck Shift silently changes what every click does.
  window.addEventListener('blur', () => {
    shiftDown = false;
    ctrlDown = false;
    altDown = false;
  });
}

/**
 * Live pointer position, tracked the same way (and for the same reason) as the Shift key: a poll has
 * nothing to poll, so it has to be a listener.
 *
 * `GetCursorPosition` is the engine's, and its Y axis is the ENGINE's -- measured up from the bottom of
 * the window, like every FrameXML anchor -- where a DOM `clientY` measures down from the top. The one
 * caller in this manifest (`CharacterSelectFrame_OnMouseDown`/`_OnUpdate`, characterselect.lua:479-496)
 * reads only X, so the flip is unobservable today and is done anyway: the day something reads Y, a
 * silently-inverted axis is a drag that goes the wrong way with nothing to point at.
 */
let cursorX = 0;
let cursorY = 0;
let cursorTrackerInstalled = false;
function ensureCursorTracker(): void {
  if (cursorTrackerInstalled || typeof window === 'undefined') {
    return;
  }
  cursorTrackerInstalled = true;
  window.addEventListener('pointermove', (event) => {
    cursorX = event.clientX;
    cursorY = window.innerHeight - event.clientY;
  });
}

/** Installs the screen/environment globals on `vm`. */
export function installScreenApi(vm: LuaVM, options: ScreenApiOptions = {}): void {
  const viewport = options.viewport ?? defaultViewport;
  ensureModifierTracker();
  ensureCursorTracker();

  /**
   * `GetScreenWidth()`/`GetScreenHeight()` -- **LOGICAL (authored) UNITS, not device pixels.**
   *
   * These returned `viewport().width/height` in DEVICE PIXELS, and the comment here asserted that was
   * wanted. It is not, and the game's own files say so three separate ways:
   *
   * - `uiparent.lua:2243-2245` -- `elseif ( right > GetScreenWidth() ) then newAnchorX =
   *   GetScreenWidth() - frame:GetWidth();`. The result is subtracted from a widget's `GetWidth()` and
   *   used as a `SetPoint` OFFSET, both of which are authored units. Mixing device pixels in here is
   *   dimensionally impossible.
   * - `uiparent.lua:2907-2914` -- `GetScreenHeightScale()` is `GetScreenHeight()/768` and
   *   `GetScreenWidthScale()` is `GetScreenWidth()/1024`, against those two LITERALS. 1024x768 is the
   *   authored virtual screen, so these are ratios against the reference layout and read 1.0 there.
   *   Divided into device pixels they would mean nothing.
   * - `worldmapframe.lua:90-98` -- `local width = GetScreenWidth()` ... `BlackoutWorld:SetWidth(width)`,
   *   straight into `SetWidth`. (Block-commented in 12340, but it is still the client's own intent.)
   *
   * ## What the device-pixel version actually broke
   *
   * `GlueParent_OnLoad` (`interface/gluexml/glueparent.lua:174-184`) letterboxes the glue screen to 16:9:
   *
   *     local width, height = GetScreenWidth(), GetScreenHeight();
   *     if ( width / height > 16 / 9) then
   *       local barWidth = ( width - height * 16 / 9 ) / 2;
   *       self:ClearAllPoints();
   *       self:SetPoint("TOPLEFT", barWidth, 0);
   *       self:SetPoint("BOTTOMRIGHT", -barWidth, 0);
   *
   * `barWidth` goes into `SetPoint`, whose units are authored -- so a device-pixel `barWidth` is
   * over-applied by exactly `screenScale` (`ui/layout.ts`). MEASURED on :3000 at 1920x900 before this
   * fix: `GlueParent`'s anchors read x = +/-160, and 160 authored units at scale 900/768 = 1.171875 is
   * **187.5 device px** of inset per side where the correct answer is **160**.
   *
   * The RATIO test is scale-invariant, so this never changed WHETHER the letterbox fires -- only how
   * wide the bars are. That matters for reading the bug report: at 1382x911 (ratio 1.517 < 16/9) the
   * letterbox does not fire at all and the glue screen already filled the window, measured, with
   * `GlueParent`'s anchors at zero offsets. So the device-pixel confusion is the whole of the EXCESS
   * inset and none of the inset itself; a window wider than 16:9 gets black bars from the real 3.3.5a
   * client too, and this fix makes ours the same width as the client's rather than removing them.
   *
   * `GetScreenResolutions` below deliberately keeps DEVICE pixels: it reports a display MODE, which is a
   * genuinely physical thing, and its only consumer computes an aspect ratio.
   */
  vm.registerFunction('GetScreenWidth', () => [viewportUnits(viewport()).width]);
  vm.registerFunction('GetScreenHeight', () => [viewportUnits(viewport()).height]);

  /**
   * `GetScreenResolutions()` and `GetCurrentResolution()` -- THE BLOCKER THAT STOPPED EVERY MANAGED FRAME
   * POSITION, including the cast bar's.
   *
   * `uiparent.lua:1749` makes `UpdateMenuBarTop()` the FIRST statement of
   * `FramePositionDelegate:UIParentManageFramePositions`, and its whole body is `uiparent.lua:1168-1174`:
   *
   *     menuBarTop = 55;
   *     local width, height = string.match((({GetScreenResolutions()})[GetCurrentResolution()] or ""), "(%d+).-(%d+)");
   *     if ( tonumber(width) / tonumber(height) > 4/3 ) then menuBarTop = 75; end
   *
   * Both globals were absent, so line 1170 raised on the first line of the pass and NOTHING after it ran --
   * no flag gathering, no `securecall` loop, not one `SetPoint`. That is why the cast bar sat at its
   * authored `BOTTOM, y = 55` (`castingbarframe.xml`) with the managed pass apparently "running": the pass
   * was entered and died immediately. The raise was invisible because `SetAttribute`'s
   * `OnAttributeChanged` dispatch discarded the error (now fixed, `methods/frame.ts`).
   *
   * ## The shape, read off that call site
   *
   * `GetScreenResolutions` returns a VARARG of strings and `GetCurrentResolution` a 1-based index into it:
   * `{...}` wraps the varargs into a table and the index subscripts it. The strings are matched with
   * `"(%d+).-(%d+)"`, so `"1920x1080"` yields 1920 and 1080 -- `%d+` is greedy, so the second capture takes
   * the whole `1080` and not just its leading `1`.
   *
   * ## Why ONE resolution, and why device pixels
   *
   * A browser client has exactly one "resolution" -- its window -- and no mode list to enumerate and no way
   * to change modes, so a one-entry list at index 1 is the complete and honest answer, not a stub. Device
   * pixels rather than authored units because that is what the real call reports and because the only thing
   * computed from it is an ASPECT RATIO, which is identical either way -- so this cannot be the units trap
   * that `GetScreenWidth` above falls into.
   *
   * ## THE CONSEQUENCE, and a correction to what was expected
   *
   * A browser window is essentially always wider than 4:3, so `menuBarTop` is **75**, not 55. With
   * `UIPARENT_MANAGED_FRAME_POSITIONS["CastingBarFrame"]`'s `baseY = true` (meaning "use menuBarTop") and
   * `yOffset = 40` (`uiparent.lua:1186`), the managed y is **75 + 40 = 115** -- not the 95 that was
   * predicted from the 4:3 value of `menuBarTop`. `bottomEither`/`pet`/`reputation`/`tutorialAlert` add
   * nothing on these characters: `reputation` needs BOTH `ReputationWatchBar:IsShown()` and
   * `MainMenuExpBar:IsShown()` (`uiparent.lua:1787`) and there is no reputation feed, and no multi-bar,
   * pet bar or tutorial alert is shown. Returning a 4:3 pair to make the number come out at 95 would be a
   * fabricated answer to a question the window already answers.
   */
  vm.registerFunction('GetScreenResolutions', () => {
    const { width, height } = viewport();
    return [`${Math.round(width)}x${Math.round(height)}`];
  });
  vm.registerFunction('GetCurrentResolution', () => [1]);

  vm.registerFunction('IsShiftKeyDown', () => [shiftDown]);
  vm.registerFunction('IsControlKeyDown', () => [ctrlDown]);
  vm.registerFunction('IsAltKeyDown', () => [altDown]);

  /**
   * THE MODIFIED-CLICK TABLE: which modifier a NAMED action is bound to, and whether it is held now.
   *
   * `IsModifiedClick` was a declared gap until the owner asked for a shift-gated action bar, and it is
   * what the client's own Lua consults for that: `ActionBarButtonTemplate`'s `<OnDragStart>` is
   *
   *     if ( LOCK_ACTIONBAR ~= "1" or IsModifiedClick("PICKUPACTION") ) then PickupAction(self.action);
   *
   * (`actionbarframe.xml:19`; the pet bar does the same at `petactionbarframe.lua:296,303,311`). So a
   * drag requires a modifier exactly when the LOCKED setting is on -- see `installCVars`' `lockActionBars`
   * for the other half. Nothing here invents a modifier check: the gate, the action name and the
   * short-circuit are all the client's.
   *
   * THE VALUE DOMAIN IS SOURCED: `"ALT"`, `"CTRL"`, `"SHIFT"`, `"NONE"` are the four values the client's
   * own dropdown offers and writes back through `SetModifiedClick`
   * (`interfaceoptionspanels.lua:174-215`, one `info.value` per branch).
   *
   * THE TABLE'S CONTENTS ARE NOT SOURCED and are marked so. The engine ships this mapping in its own
   * config, no file in the 264-file manifest declares a default for any action, and the only entry this
   * client needs is the one the owner asked for. So exactly one is seeded -- `PICKUPACTION` -> `SHIFT`,
   * which is his requirement -- and every other action name reads `NONE` until `SetModifiedClick` is
   * called for it, which makes `IsModifiedClick` false there: the safe direction, since every caller uses
   * it to ADD behaviour to a click.
   *
   * `IsModifiedClick()` with NO argument is a fifth caller shape (`containerframe.xml:33`,
   * `lootframe.xml:52`, `itemref.lua:175`) meaning "was any modifier held". OURS: answered as
   * shift-or-ctrl-or-alt, which is the only reading those call sites' use as a plain boolean supports.
   */
  const modifiedClicks = new Map<string, string>([
    ['PICKUPACTION', 'SHIFT'],
    /**
     * `SPLITSTACK` -> SHIFT. **The owner's second requirement of this table, and the reason
     * shift-clicking a vendor's stackable did nothing.**
     *
     * `MerchantItemButton_OnModifiedClick` opens the quantity dialogue only behind
     * `IsModifiedClick("SPLITSTACK")` (`merchantframe.lua:415`), and `ContainerFrameItemButton_OnModifiedClick`
     * gates `SplitContainerItem` the same way (`containerframe.lua:754`). With the action unbound this
     * read `NONE`, `IsModifiedClick` answered false, and the click fell through to nothing -- which is
     * exactly what the owner reported.
     *
     * SOURCED THE SAME WAY `PICKUPACTION` IS, AND NO BETTER: the engine ships this default in its own
     * config, and the client's own options panel exposes only `AUTOLOOTTOGGLE`, `SELFCAST` and
     * `FOCUSCAST` through `SetModifiedClick` (grepped `interfaceoptionspanels.lua`) -- so no served file
     * states a default for `SPLITSTACK` either. SHIFT is the owner's requirement, recorded as a
     * requirement and not as a reading of the game's data.
     */
    ['SPLITSTACK', 'SHIFT'],
  ]);
  const modifierHeld = (modifier: string): boolean => {
    if (modifier === 'SHIFT') {
      return shiftDown;
    }
    if (modifier === 'CTRL') {
      return ctrlDown;
    }
    if (modifier === 'ALT') {
      return altDown;
    }
    return false;
  };

  vm.registerFunction('GetModifiedClick', (args) => [
    modifiedClicks.get(String(args[0] ?? '').toUpperCase()) ?? 'NONE',
  ]);

  vm.registerFunction('SetModifiedClick', (args) => {
    const action = String(args[0] ?? '').toUpperCase();
    const value = String(args[1] ?? 'NONE').toUpperCase();
    if (action !== '') {
      modifiedClicks.set(action, value);
    }
    return [];
  });

  vm.registerFunction('IsModifiedClick', (args) => {
    if (args[0] === undefined || args[0] === null) {
      return [shiftDown || ctrlDown || altDown];
    }
    return [modifierHeld(modifiedClicks.get(String(args[0]).toUpperCase()) ?? 'NONE')];
  });

  // CharacterSelectFrame's drag-to-rotate (characterselect.lua:479,492,494).
  vm.registerFunction('GetCursorPosition', () => [cursorX, cursorY]);

  /**
   * `InCinematic()` -- false, and it gates EVERY static popup in the client.
   *
   * `StaticPopup_Show`'s third guard is `if ( InCinematic() and not info.interruptCinematic )`
   * (`staticpopup.lua:2956`), so with this nil **no dialogue could open at all** -- not the delete
   * confirmation, not the logout prompt, not a quest confirmation. It was found while wiring the
   * item-destroy dialogue and is the only engine global on that function's path that was missing
   * (`UnitIsDeadOrGhost` beside it already answers).
   *
   * FALSE is a true answer rather than a stub: this client plays no cinematics -- there is no
   * `CinematicFrame` feed and `SMSG_TRIGGER_CINEMATIC` has no subscriber -- so the player is never in
   * one, and that is precisely the value that lets every popup through.
   */
  vm.registerFunction('InCinematic', () => [false]);

  vm.registerFunction('IsWindowsClient', () => {
    const ua =
      (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '';
    return [/win/i.test(ua)];
  });

  // AccountLoginUI's <OnShow>: `if ( not IsSystemSupported() ) then GlueDialog_Show("SYSTEM_INCOMPATIBLE_SSE")`
  // (accountlogin.xml:1487). In the real client this is the SSE2 CPU-feature check. Anything running
  // this client at all has a WebGL2 context and a JS engine; there is no unsupported system to warn
  // about, so `true` is the answer, not a guess. Newly reachable: nothing dispatched `OnShow` before
  // this fix round, so this global's absence was invisible.
  vm.registerFunction('IsSystemSupported', () => [true]);

  // AccountLogin_OnLoad: which main-menu model to show. This build ships only the Wrath assets.
  vm.registerFunction('IsStreamingTrial', () => [false]);
  // AccountLogin_OnShow's Upgrade Account button. No trial accounts on a private server.
  vm.registerFunction('IsTrialAccount', () => [false]);
  // CinematicsFrame_OnLoad: how many expansions' worth of cinematics to list. WotLK ships two.
  vm.registerFunction('GetClientExpansionLevel', () => [2]);

  // AccountLogin_OnLoad's version string. `network/config.ts` is this client's own build identity.
  vm.registerFunction('GetBuildInfo', () => [
    'WoW',
    'release',
    config.version,
    String(config.build),
    '2010-03-25',
  ]);

  installCVars(vm);

  vm.registerFunction('SetCurrentScreen', (args) => {
    options.onSetCurrentScreen?.(String(args[0] ?? ''));
    return [];
  });

  // GlueParent's FRAMES_LOADED handler. No localization system in this runtime -- every string this
  // client ships is already enUS, so there is nothing for this call to do.
  vm.registerFunction('LocalizeFrames', () => []);

  vm.registerFunction('QuitGame', () => {
    if (options.onQuitGame) {
      options.onQuitGame();
    } else if (typeof window !== 'undefined') {
      // No host was given a say in this; leave a real, observable signal instead of doing nothing.
      window.dispatchEvent(new CustomEvent('wow:quit'));
    }
    return [];
  });
}

/**
 * `GetCVar`/`SetCVar`/`GetCVarBool` over an in-memory store.
 *
 * REAL, not a stub, and the difference is the point: a CVar in the client is just a named string in
 * the config, and a browser client has exactly as much right to keep one in memory as the real client
 * has to keep it in `Config.wtf`. Nothing here needs a backend, so this is a complete implementation
 * of a small thing rather than a placeholder for a big one -- which is why it lives here beside the
 * other environment reads and not in `stubs.ts`.
 *
 * PER VM, deliberately: the map is a local of this function, so two runtimes in one process (a screen
 * torn down and rebuilt, which is the ordinary case) do not inherit each other's settings. A CVar
 * genuinely does not survive a client restart's worth of state in this client, because nothing
 * persists it.
 *
 * The ONE value the loaded manifest reads is `showToolsUI`: `AccountLoginShowLauncher`'s `<OnLoad>`
 * compares `GetCVar("showToolsUI") == "1"` and its `<OnClick>` writes the box back
 * (accountlogin.xml:621,637). Absent that global the OnLoad raised -- one of the fifteen load errors.
 * Everything the client stores is a STRING, including its booleans, which is why the comparison is
 * against `"1"` and why `SetCVar` normalizes: `<OnClick>` passes the result of `GetChecked()`, a Lua
 * boolean, and the real client writes "1"/"0" for it.
 *
 * An UNKNOWN name returns nil, exactly as the real `GetCVar` does. Not an error and not an empty
 * string: FrameXML tests the result for nil in places, and `""` would read as a set-but-empty CVar.
 */
/**
 * THE CVAR STORES, per VM, so the ENGINE can read a value the client's own Lua wrote.
 *
 * The map used to be a pure local of `installCVars` -- correct while every reader was Lua, and a wall
 * the moment one is not. `Bindings.xml:544-553`'s `NAMEPLATES` binding is entirely the client's own Lua
 * and does nothing but `SetCVar("nameplateShowEnemies", ...)`; the thing that acts on it is the engine.
 * That is the real division in 3.3.5a -- a nameplate is engine-created and the CVars are its only
 * switch -- so this is the door, and it is a WeakMap keyed on the VM rather than a module global for
 * exactly the reason `installCVars` gives for the local: two runtimes in one process must not inherit
 * each other's settings.
 */
const CVAR_STORES = new WeakMap<LuaVM, Map<string, string>>();

/**
 * One CVar's value as the client's Lua last left it, or undefined for a name no one has set.
 *
 * Case-insensitive, like `GetCVar` -- FrameXML is not consistent about a name's casing between its read
 * and its write site, and an engine reader must not be the one place that is.
 */
export function cvarValue(vm: LuaVM, name: string): string | undefined {
  const store = CVAR_STORES.get(vm);
  if (store === undefined) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [stored, value] of store) {
    if (stored.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

/** `GetCVarBool`'s rule, for an engine reader: `"1"` is true and everything else, unset included, false. */
export function cvarBool(vm: LuaVM, name: string): boolean {
  return cvarValue(vm, name) === '1';
}

function installCVars(vm: LuaVM): void {
  const cvars = new Map<string, string>([
    // Off by default: this is the launcher/tools checkbox, and there is no launcher to show.
    ['showToolsUI', '0'],
    /**
     * LOCKED ACTION BARS, which is how the client's own Lua asks for a MODIFIER before a drag:
     * `if ( LOCK_ACTIONBAR ~= "1" or IsModifiedClick("PICKUPACTION") )` (`actionbarframe.xml:19`).
     *
     * `LOCK_ACTIONBAR` is not an engine global -- it is a uvar the client's own options code copies out of
     * this CVar: `uvarInfo["LOCK_ACTIONBAR"] = { default = "0", cvar = "lockActionBars", ... }`
     * (`interfaceoptionsframe.lua:311`), seeded to the default by `InterfaceOptionsFrame_InitializeUVars`
     * (`:352-357`) and then overwritten with `_G[control.uvar] = GetCVar(control.cvar)` by
     * `BlizzardOptionsPanel_SetupControl` (`optionspaneltemplates.lua:373-380`), which runs on
     * `PLAYER_ENTERING_WORLD` for the ActionBars panel's `$parentLockActionBars` check button
     * (`interfaceoptionspanels.xml:1448-1464`).
     *
     * **`"1"` IS OURS, and it is the owner's requirement, not the game's default.** `GetCVarDefault`
     * reports `"0"` in the real client and dragging there needs no modifier out of the box; he asked for
     * shift-only ("it works all the time, even without shift. It should work with shift only"). It is a
     * real CVar, so the client's own options panel or a `SetCVar` flips it back with no code change.
     */
    ['lockActionBars', '1'],
    /**
     * THE TWO NAMEPLATE SWITCHES, seeded OFF.
     *
     * Not decoration: `Bindings.xml:544-573`'s three nameplate bindings do nothing but read and write
     * this pair, so they are the entire toggle. Seeded rather than left absent because the seeding is
     * what documents that the names are the CVars the client's own Lua uses -- `GetCVarBool` already
     * answers false for an unset name, so behaviour is identical either way.
     *
     * **OFF is 3.3.5a's own default**, and the evidence is the binding's own shape: the first `V` press
     * takes the `else` arm and turns enemy plates ON, which is only the right first behaviour if they
     * start off. (The value in a real install lives in `Config.wtf`, which the asset host does not
     * serve -- `wtf/config.wtf` 404s -- so this is an inference from the client's Lua, not a read.)
     */
    /**
     * THE WORLD MAP'S FOUR, and the first one was an ARITHMETIC ERROR on the owner's SHIFT-M:
     *
     *     binding TOGGLEWORLDMAPSIZE (SHIFT-M, down): WorldMapFrame.lua:2139:
     *         attempt to perform arithmetic on a nil value (local 'opacity')
     *
     * The chain is two lines in the client's own file. `WorldMapFrame_OnEvent`'s `VARIABLES_LOADED`
     * arm does `WORLDMAP_SETTINGS.opacity = tonumber(GetCVar("worldMapOpacity"))` (`:182`), and an
     * unset CVar makes that **nil** -- overwriting the literal's own 0. `WorldMap_ToggleSizeDown`
     * then hands it to `WorldMapFrame_SetOpacity` (`:1409`), which computes
     * `0.5 + (1.0 - opacity) * 0.5` and raises.
     *
     * **And the raise sat between the two `ToggleFrame` calls of `WorldMapFrame_ToggleWindowSize`** --
     * the first had closed the map and the second never ran, which is exactly what the owner
     * reported: "карта становится компактнее, но приходится заново открывать её". One nil, two
     * symptoms.
     *
     * THREE OF THE FOUR ARE SOURCED, from the client's own initialiser
     * (`worldmapframe.lua:61-68`): `WORLDMAP_SETTINGS = { opacity = 0, advanced = nil,
     * size = WORLDMAP_QUESTLIST_SIZE }`. The `VARIABLES_LOADED` arm overwrites each of those three
     * fields from a CVar, so the CVar that reproduces the literal IS the default -- `0` for the
     * opacity, false for `advancedWorldMap`, and false for `miniWorldMap` (whose true branch would
     * call `WorldMap_ToggleSizeDown` and change the size the literal just set).
     *
     * `questPOI` is the one that is TRANSCRIBED rather than derived: nothing in the client's Lua
     * pins it, the checkbox carries no `checked` attribute, and `Config.wtf` is not served
     * (`wtf/config.wtf` 404s). `1` is retail's out-of-the-box state and it is what the owner is
     * trying to see, so it carries the same standing note as `framexml/bindings.ts`'s default keys.
     */
    ['worldMapOpacity', '0'],
    ['advancedWorldMap', '0'],
    ['miniWorldMap', '0'],
    ['questPOI', '1'],
    /**
     * `showBattlefieldMinimap`, and its ABSENCE left the world map's "Zone Map" dropdown blank.
     *
     * The owner: "Вот этот селектор не выбран." `WorldMapZoneMinimapDropDown_Update` sets the label
     * to `WorldMapZoneMinimapDropDown_GetText(GetCVar("showBattlefieldMinimap"))`
     * (`worldmapframe.lua:717-720`), and that function compares the value to the STRINGS `"0"`,
     * `"1"` and `"2"` and **returns nil for anything else** (`:703-714`). An unset CVar is nil, nil
     * matches none of the three, so the label was set to nil -- an empty dropdown with a working
     * arrow and a working tooltip, which is exactly what he photographed.
     *
     * `"0"` is BATTLEFIELD_MINIMAP_SHOW_NEVER, and it is the right default for the same reason the
     * three above it are: the initialiser ticks whichever entry equals the CVar (`:656-658`), so the
     * default has to be one of the three or nothing is selected. Never is retail's own out-of-the-box
     * state for the battlefield minimap, and this client shows no battlefield minimap at all.
     *
     * A STRING and not a number, and that is the whole trap: `value == info.value` compares against
     * `"0"`, and Lua does not coerce across types -- `0 == "0"` is false. A numeric default here
     * would look set and behave unset.
     */
    ['showBattlefieldMinimap', '0'],
    /**
     * `chatMouseScroll`, and it is the GATE on the chat window's wheel -- not a preference.
     *
     * The owner: "скролить мышью нельзя." The chat frame has no `<OnMouseWheel>` in any of its
     * documents; grepped `chatframe.xml` and `floatingchatframe.xml` and there is none. The handler is
     * installed at RUNTIME and only if this CVar is true:
     *
     *     if ( GetCVarBool("chatMouseScroll") ) then
     *         self:SetScript("OnMouseWheel", FloatingChatFrame_OnMouseScroll);
     *         self:EnableMouseWheel(true);
     *     end
     *
     * (`chatframe.lua:2547-2551`, in the `VARIABLES_LOADED` arm -- an event this runtime does fire,
     * `world-runtime.ts:564`). With the CVar unset `GetCVarBool` answers false and the wheel is never
     * wired to anything, which is exactly the symptom.
     *
     * TRANSCRIBED, not derived, and it carries the same standing note as `questPOI` above: nothing in
     * the client's Lua pins the default, the shape of the gate does not imply it the way the nameplate
     * bindings imply theirs, and `Config.wtf` is not served. `1` is what a real install does -- the
     * wheel scrolls chat out of the box -- and it is what the owner is asking for.
     */
    ['chatMouseScroll', '1'],
    ['nameplateShowEnemies', '0'],
    ['nameplateShowFriends', '0'],
    /**
     * `lastTalkedToGM`, EMPTY -- and its absence put a modal error dialog on the owner's screen.
     *
     * `UIParent_OnEvent`'s `VARIABLES_LOADED` arm reads it and branches on
     * `if ( lastTalkedToGM ~= "" )` (`uiparent.lua:471`), taking the branch that calls
     * `GMChatFrame_LoadUI()` -> `UIParentLoadAddOn("Blizzard_GMChatUI")`. **In Lua `nil ~= ""` is
     * TRUE**, so an ABSENT CVar takes the same branch a real conversation with a GM would, on every
     * login -- and the popup reading "Couldn't load Blizzard_GMChatUI: Unknown load problem" was
     * photographed on a live login before this line existed.
     *
     * The empty string is the game's own default and the comparison is the evidence for it: the client
     * would not test a CVar against `""` unless `""` were its unset value. Seeding it is what makes the
     * branch behave as it does in a real client -- not taken.
     *
     * This is why an unknown-CVar nil is dangerous rather than harmless, and it qualifies the paragraph
     * above about `nil` being the faithful answer for an unknown name: it is faithful for a name the
     * client does not know, and WRONG for one it does.
     */
    ['lastTalkedToGM', ''],
    /**
     * THE TWO STAT-PANE CATEGORIES, EMPTY -- and their absence is the whole of "I don't see character
     * stats under the preview and don't see options in selects there".
     *
     * Exactly the `lastTalkedToGM` case above, with the comparison the other way round.
     * `PaperDollFrame_OnEvent`'s `VARIABLES_LOADED` arm is
     * `if ( GetCVar("playerStatLeftDropdown") == "" or GetCVar("playerStatRightDropdown") == "" ) then`
     * and its body picks the defaults per CLASS -- `PLAYERSTAT_BASE_STATS` on the left, and on the
     * right `PLAYERSTAT_SPELL_COMBAT` for a mage/priest/warlock/druid, `PLAYERSTAT_RANGED_COMBAT` for a
     * hunter, `PLAYERSTAT_MELEE_COMBAT` for everyone else (`paperdollframe.lua:161-174`).
     *
     * **In Lua `nil == ""` is FALSE**, so an absent CVar skipped that whole block: neither category was
     * ever chosen, and `UpdatePaperdollStats(prefix, index)` is a five-way `if index == "PLAYERSTAT_*"`
     * chain with **no else** (`:1680`), so every branch was skipped and both panes kept their authored
     * placeholders. The same nil then went to `UIDropDownMenu_SetSelectedValue`, which is why the two
     * category selects read blank as well -- one cause, three symptoms.
     *
     * The empty string is the game's own default and the client's own `== ""` test is the evidence, the
     * same argument `lastTalkedToGM` above is seeded on. Seeding is all that is needed: **the client
     * picks the actual categories itself**, per class, which is why nothing here names a category.
     */
    ['playerStatLeftDropdown', ''],
    ['playerStatRightDropdown', ''],
    /**
     * `showNewbieTips`, "1" -- THE GAME'S OWN DEFAULT, and its absence was why the experience bar had
     * no tooltip.
     *
     * `interfaceoptionsframe.lua:310` is the source and it gives both halves:
     *
     *     ["SHOW_NEWBIE_TIPS"] = { default = "1", cvar = "showNewbieTips", event = "SHOW_NEWBIE_TIPS_TEXT" }
     *
     * `world-runtime.ts` already sets the uvar `SHOW_NEWBIE_TIPS` to "1" before the load -- but
     * `BlizzardOptionsPanel_SetupControl` then does `_G[control.uvar] = GetCVar(control.cvar)`
     * (`optionspaneltemplates.lua:373-380`) on `PLAYER_ENTERING_WORLD`, and with this CVar unknown that
     * **overwrote the "1" with nil.** MEASURED live: `SHOW_NEWBIE_TIPS` read nil in the world.
     *
     * What that cost: `MainMenuExpBar`'s `<OnEnter>` ends in
     * `GameTooltip_AddNewbieTip(self, XPBAR_LABEL, 1, 1, 1, NEWBIE_TOOLTIP_XPBAR, 1)`
     * (`mainmenubar.xml:46-52`), and the trailing `1` is `noNormalText` -- so in the `~= "1"` branch
     * `GameTooltip_AddNewbieTip` shows NOTHING AT ALL (`gametooltip.lua:199-215`). The owner's "missing
     * tooltip on exp bar" is exactly that branch. The same nil silenced every micro button, which is
     * the case `world-runtime.ts` reasoned its way to before this CVar existed -- correctly, and now
     * with a real source instead of an inference.
     */
    ['showNewbieTips', '1'],
    /**
     * `buffDurations` -- whether the buff icons carry a "2m" line under them.
     *
     * `interfaceoptionsframe.lua:312` is the source and gives both halves:
     *
     *     ["SHOW_BUFF_DURATIONS"] = { default = "0", cvar = "buffDurations", event = "SHOW_BUFF_DURATION_TEXT" }
     *
     * It is here for the reason `showNewbieTips` is: `BlizzardOptionsPanel_SetupControl` runs
     * `_G[control.uvar] = GetCVar(control.cvar)` on `PLAYER_ENTERING_WORLD`
     * (`optionspaneltemplates.lua:373-380`), so an unknown CVar OVERWRITES the uvar with nil.
     * `SHOW_BUFF_DURATIONS` nil and `SHOW_BUFF_DURATIONS == "0"` happen to take the same branch
     * everywhere in `buffframe.lua`, so this changes no pixel today -- it exists so the value is the
     * client's own shipped default rather than an accident, and so `BuffFrame_UpdatePositions`'
     * `BUFF_ROW_SPACING` arm has a defined value to compare.
     */
    ['buffDurations', '0'],
  ]);
  CVAR_STORES.set(vm, cvars);

  // Case-insensitive, like the client's own CVar table -- FrameXML is not consistent about the casing
  // of a name between the read and the write site, and a case-sensitive map would silently create a
  // second CVar rather than update the first.
  const key = (name: unknown) => String(name ?? '').toLowerCase();
  const lookup = (name: unknown): string | undefined => {
    const wanted = key(name);
    for (const [stored, value] of cvars) {
      if (stored.toLowerCase() === wanted) {
        return value;
      }
    }
    return undefined;
  };

  vm.registerFunction('GetCVar', (args) => [lookup(args[0]) ?? null]);

  /**
   * `GetCVarDefault(name)` -- the value the CVar ships with, which is NOT its current value.
   *
   * Needed to reach the lock setting at all: `BlizzardOptionsPanel_OnEvent` calls it for every check
   * button with a `cvar` on `PLAYER_ENTERING_WORLD` (`optionspaneltemplates.lua:333`) and only then
   * `securecall`s `BlizzardOptionsPanel_SetupControl` (`:353`), which is the line that copies the CVar
   * into `LOCK_ACTIONBAR`. Absent, that loop raised on the first panel and no uvar was ever loaded.
   *
   * The one default this client can SOURCE is `lockActionBars`' `"0"`
   * (`interfaceoptionsframe.lua:311`'s `default = "0"`). Anything else answers nil -- the real call's
   * answer for a name the config does not know -- rather than echoing the current value, which would make
   * `InterfaceOptionsFrame_LoadUVars`' `cvarValue == setting.default` test always true.
   */
  const cvarDefaults = new Map<string, string>([
    ['lockactionbars', '0'],
    // `interfaceoptionsframe.lua:310`'s `default = "1"`, the same line the CVar above is seeded from.
    // `InterfaceOptionsFrame_LoadUVars` compares `cvarValue == setting.default`, so a nil here would
    // make that test false for a CVar whose value IS the default.
    ['shownewbietips', '1'],
    // `interfaceoptionsframe.lua:312`'s `default = "0"`, the same line the CVar above is seeded from.
    ['buffdurations', '0'],
  ]);
  vm.registerFunction('GetCVarDefault', (args) => [
    cvarDefaults.get(key(args[0])) ?? null,
  ]);

  vm.registerFunction('SetCVar', (args) => {
    const raw = args[1];
    // The client stores strings and nothing else. A Lua boolean is what `GetChecked()` hands a
    // `SetCVar` call, and the engine writes "1"/"0" for it; a number goes through `String` unchanged.
    const value =
      raw === true ? '1' : raw === false || raw === undefined || raw === null ? '0' : String(raw);
    const wanted = key(args[0]);
    for (const stored of cvars.keys()) {
      if (stored.toLowerCase() === wanted) {
        cvars.set(stored, value);
        return [];
      }
    }
    cvars.set(String(args[0] ?? ''), value);
    return [];
  });

  // The client's own convenience read: "1" is true and everything else, including an unset CVar, is
  // false. Not `Boolean(value)` -- "0" is a non-empty string and would come back true.
  vm.registerFunction('GetCVarBool', (args) => [lookup(args[0]) === '1']);
}
