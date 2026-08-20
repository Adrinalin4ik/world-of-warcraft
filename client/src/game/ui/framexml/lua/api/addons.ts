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
 * ## The named gap
 *
 * `LoadAddOn` is declared, not implemented, and the blocker is structural. Fetching an addon's files
 * is asynchronous; a Lua global returns synchronously; and `loadDocument`'s resolver is synchronous by
 * design (`manifest.ts`'s header). Prefetching all 23 addons at boot to make it synchronous is exactly
 * the cost `## LoadOnDemand` exists to avoid -- 22 of the 23 carry it.
 *
 * **The RETURN SHAPE is load-bearing and is taken from the client's own caller, not invented.**
 * `UIParentLoadAddOn` (`uiparent.lua:234-243`) does `local loaded, reason = LoadAddOn(name)` and, on
 * failure, `format(ADDON_LOAD_FAILED, name, _G["ADDON_"..reason])` -- so `reason` must be a STRING
 * whose `ADDON_`-prefixed global exists, or the concatenation itself raises and takes the caller's
 * whole handler with it. `UNKNOWN_ERROR` is chosen from the 21 `ADDON_*` strings `GlobalStrings.lua`
 * ships (`ADDON_UNKNOWN_ERROR` is one of them) because it is the only one of the set that is TRUE of
 * us: the addon is not disabled, missing, corrupt, banned or version-mismatched -- this engine simply
 * cannot demand-load. Returning `nil` for the reason would look harmless and would raise.
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

export function installAddOnsApi(vm: LuaVM): void {
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
    return loaded ? [1, 1] : [];
  });

  // See the header for why the reason string is `UNKNOWN_ERROR` and why it may not be nil.
  const loadAddOn = notImplemented(
    'LoadAddOn',
    'demand-loading needs an ASYNCHRONOUS fetch and a Lua global returns synchronously; the 22 '
      + 'LoadOnDemand addons are correctly absent until this is built',
    [false, 'UNKNOWN_ERROR'],
  );
  vm.registerFunction('LoadAddOn', () => loadAddOn(null as never, 0, []));
}
