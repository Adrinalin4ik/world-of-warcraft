/**
 * The glue engine's screen/environment surface: window size, a handful of client/environment
 * predicates, and the two calls that leave the game (`QuitGame`) or switch glue screens
 * (`SetCurrentScreen`).
 *
 * `CreateFrame` is deliberately NOT here -- it already exists once `installObjectModel` (Task 2) has
 * run on the VM, and re-registering it here would shadow that one with a worse one.
 */
import { LuaVM } from '../vm';
import { Viewport } from '../../../layout';
import config from '../../../../../network/config';

export interface ScreenApiOptions {
  /** Device-pixel window size `GetScreenWidth`/`GetScreenHeight` read. Defaults to the real window. */
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

  // GlueParent_OnLoad: the letterbox-bar math, which needs the real device pixels, not authored units.
  vm.registerFunction('GetScreenWidth', () => [viewport().width]);
  vm.registerFunction('GetScreenHeight', () => [viewport().height]);

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

  // CharacterSelectFrame's drag-to-rotate (characterselect.lua:479,492,494).
  vm.registerFunction('GetCursorPosition', () => [cursorX, cursorY]);

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
function installCVars(vm: LuaVM): void {
  const cvars = new Map<string, string>([
    // Off by default: this is the launcher/tools checkbox, and there is no launcher to show.
    ['showToolsUI', '0'],
  ]);

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
