/**
 * The addon system's engine globals, for the WORLD runtime.
 *
 * ## Why this is not `api/stubs.ts`
 *
 * `stubs.ts` answers `GetNumAddOns() = 0` and its comment says, correctly for when it was written,
 * "this client has no addon loader at all: nothing reads an `.toc`". That is now false in the world
 * runtime: `addons.ts` (the sibling of `world-runtime.ts`) reads every `Blizzard_*` `.toc`, and the
 * startup set -- `Blizzard_TokenUI` -- is executed with the manifest. So the loaded/not-loaded
 * question has a real answer here and must not be answered by a constant.
 *
 * `GetNumAddOns` is deliberately LEFT at 0 and is not redefined here. It drives `AddonList.xml`, whose
 * subject is the USER's addons -- the character-select Addons button (`addonlist.lua:5`) -- and this
 * client has no third-party addon directory to enumerate. Whether the real client's count includes its
 * own `Blizzard_*` set is UNESTABLISHED from the files this project has; rather than guess, the count
 * keeps the answer it already had and only `IsAddOnLoaded` gains truth.
 *
 * ## The one real global
 *
 * `IsAddOnLoaded(name)` -> `loaded, finished`. `uiparent.lua:325` branches on it directly
 * (`if ( IsAddOnLoaded("Blizzard_GMChatUI") )`), so a nil global there aborts `VARIABLES_LOADED`'s
 * handler part-way. It reads the set the boot actually executed, keyed per VM, because this client
 * relogs without a page reload and a second boot's answer must not be the first boot's.
 *
 * ## `LoadAddOn`
 *
 * Real, and it delegates: this file knows nothing about fetching or about documents. `world-runtime.ts`
 * installs a `loader` that executes one prefetched addon's files and answers whether it could
 * (`framexml/addons.ts`' header has the timing argument for why the files are already in hand).
 *
 * **THE RETURN SHAPE IS LOAD-BEARING AND COMES FROM THE CLIENT'S OWN CALLER, not from invention.**
 * `UIParentLoadAddOn` (`uiparent.lua:234-243`) does `local loaded, reason = LoadAddOn(name)` and, on
 * failure, `format(ADDON_LOAD_FAILED, name, _G["ADDON_"..reason])` -- so `reason` must be a STRING whose
 * `ADDON_`-prefixed global exists, or the concatenation raises and takes the caller's whole handler with
 * it. `MISSING` is used for a name this build does not serve, and `UNKNOWN_ERROR` when the loader itself
 * refused; both are among the 21 `ADDON_*` strings `GlobalStrings.lua` ships. Returning `nil` for the
 * reason would look harmless and would raise.
 *
 * An addon already loaded answers `true` without re-running its files -- the engine's own behaviour, and
 * what stops `GMChatFrame_LoadUI`'s guard from rebuilding a frame tree on every whisper.
 */
import { LuaVM } from '../vm';
import { notImplemented } from '../methods/region';

/**
 * Which addons this VM's boot executed, lower-cased.
 *
 * `WeakMap<LuaVM, ...>` and not a module-level set, for the same reason `api/items.ts`'s purse is one:
 * the state belongs to one VM and must not survive into the next one a relog builds.
 */
const loadedByVm = new WeakMap<LuaVM, Set<string>>();

/** Records an addon as loaded. Called by `world-runtime.ts` as each addon's files finish. */
export function markAddOnLoaded(vm: LuaVM, name: string): void {
  let set = loadedByVm.get(vm);
  if (set === undefined) {
    set = new Set<string>();
    loadedByVm.set(vm, set);
  }
  set.add(name.toLowerCase());
}

/**
 * How `LoadAddOn` actually loads. Returns true once the addon's files have run.
 *
 * Injected rather than imported so this file stays a method/global table with no loader and no world,
 * the same division `api/items.ts#setItemTooltipSource` documents.
 */
export type AddOnLoader = (name: string) => boolean;

export function installAddOnsApi(vm: LuaVM, loader: AddOnLoader | null = null): void {
  /**
   * `IsAddOnLoaded(name)` -> `loaded, finished`.
   *
   * Both returns are `1`/`nil` rather than booleans, matching how the client's own call sites test it
   * (`if ( IsAddOnLoaded(...) )` -- either works in Lua, but the engine's convention is the number and
   * an addon that compares it to 1 would otherwise be wrong). `finished` mirrors `loaded` here: this
   * loader runs an addon's files to completion synchronously or not at all, so there is no state in
   * which an addon is loaded but unfinished.
   */
  vm.registerFunction('IsAddOnLoaded', (args) => {
    const name = typeof args[0] === 'string' ? args[0].toLowerCase() : '';
    const loaded = loadedByVm.get(vm)?.has(name) === true;
    // `[null, null]` and not `[]` for the negative. Returning NOTHING is not the same as returning nil
    // in Lua: `tostring(IsAddOnLoaded("Blizzard_TalentUI"))` raised "bad argument #1 to 'tostring'
    // (value expected)" on the live run, because zero results means the call contributed no argument at
    // all. Every `if IsAddOnLoaded(...)` site is happy either way; a site that passes the result on is
    // not, and the real API returns nil.
    return loaded ? [1, 1] : [null, null];
  });

  // With no loader installed at all this is still a declared gap rather than a silent false -- the glue
  // runtime has no addon machinery and never will, and a screen that calls `LoadAddOn` there should be
  // named in the report.
  const noLoader = notImplemented(
    'LoadAddOn',
    'no addon loader is installed on this runtime -- only the world runtime has one',
    [false, 'UNKNOWN_ERROR'],
  );
  vm.registerFunction('LoadAddOn', (args) => {
    const name = typeof args[0] === 'string' ? args[0] : '';
    if (loader === null) {
      return noLoader(null as never, 0, []);
    }
    if (loadedByVm.get(vm)?.has(name.toLowerCase()) === true) {
      return [true, null];
    }
    // See the header on the reason strings. `loader` returning false means the name is not one this
    // build serves; anything it did load, it recorded through `markAddOnLoaded`.
    return loader(name) ? [true, null] : [false, 'MISSING'];
  });
}
