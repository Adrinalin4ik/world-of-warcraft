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
