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

/** Real, live Shift-key state, tracked from the DOM -- not a poll, so it has to be a listener. */
let shiftDown = false;
let shiftTrackerInstalled = false;
function ensureShiftTracker(): void {
  if (shiftTrackerInstalled || typeof window === 'undefined') {
    return;
  }
  shiftTrackerInstalled = true;
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Shift') {
      shiftDown = true;
    }
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
      shiftDown = false;
    }
  });
}

/** Installs the screen/environment globals on `vm`. */
export function installScreenApi(vm: LuaVM, options: ScreenApiOptions = {}): void {
  const viewport = options.viewport ?? defaultViewport;
  ensureShiftTracker();

  // GlueParent_OnLoad: the letterbox-bar math, which needs the real device pixels, not authored units.
  vm.registerFunction('GetScreenWidth', () => [viewport().width]);
  vm.registerFunction('GetScreenHeight', () => [viewport().height]);

  vm.registerFunction('IsShiftKeyDown', () => [shiftDown]);

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
