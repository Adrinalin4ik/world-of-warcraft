/**
 * The taint-system globals -- `securecall`, `issecure`, `hooksecurefunc` and friends.
 *
 * THESE ARE REAL, NOT STUBS, and the distinction matters enough to write down. 3.3.5a's taint system
 * exists to stop an ADDON's code from reaching protected (combat-restricted) frames: `securecall(f,
 * ...)` calls `f` with the taint flag cleared, `issecure()` reports whether the current execution path
 * is untainted, `hooksecurefunc(name, post)` appends a hook that cannot taint its target.
 *
 * A client with no addons and no protected frames has no taint to track. In that world the CORRECT
 * behaviour of `securecall(f, ...)` is not "do nothing" and not "warn" -- it is `return f(...)`. The
 * security is the only part that is absent, and there is nothing for it to secure. So these are
 * written in Lua, in the engine's own semantics, rather than declared through `notImplemented`:
 * declaring them as gaps would make `UIDropDownMenu_Initialize` (which routes its whole initialiser
 * through `securecall`, `UIDropDownMenu.lua:64`) silently not initialise, which is a behaviour change,
 * not an honest gap.
 *
 * WHAT IS ABSENT, said plainly -- **and this paragraph was STALE for several rounds, which by this
 * project's rules is a defect and not untidiness.** It claimed `SetAttribute`/`GetAttribute` and
 * `InCombatLockdown` were missing long after they landed, so an agent reading it would believe a whole
 * subsystem was gone and either rebuild it or route around it. Corrected, and re-checked by grep:
 *
 *  - `SetAttribute`/`GetAttribute` are **REAL** (`methods/frame.ts:290,352`), including the
 *    three-argument `GetAttribute(prefix, name, suffix)` that `SecureButton_GetModifiedAttribute`
 *    needs -- which is what makes an action button's click resolve at all.
 *  - `InCombatLockdown` is **REAL** (`ui/group-bridge.ts:673`), answering false: nothing in this client
 *    is combat-locked because nothing here is protected.
 *  - `IsProtected` is still absent.
 *  - The `RestrictedFrames`/`RestrictedExecution`/`SecureHandlers` stack is still absent, and the
 *    reason is now MEASURED rather than assumed: those three files raise on `newproxy`, a Lua 5.1
 *    function fengari's 5.3 does not have (`RestrictedFrames.lua:67`, `RestrictedExecution.lua:230`,
 *    then `rtable` nil at `SecureHandlers.lua:32` because the module above never finished).
 *    **Do not shim `newproxy` with a table**: `restrictedframes.lua` tests `type(x) == "userdata"` in
 *    ten places (`:197,211,238,460,489,515,535,...`), so a table would make `IsFrameHandle` reject
 *    every handle it had just minted -- loading clean and being comprehensively wrong. A real fix needs
 *    fengari's `lua_newuserdata` through the VM layer and is its own task.
 *
 * benilla has none of this and does not stub it (`crates/benilla-ui`, grepped: zero hits) -- it targets
 * 1.12, where the system does not exist.
 *
 * **NO OUTSTANDING COUNT IS QUOTED HERE, deliberately.** This paragraph used to carry "78
 * `SetAttribute`", and a figure like that goes stale silently: `RegisterForClicks`' gap note claimed 2
 * callers when there were 73, and a texture-format census was quoted before it was verified. Audit the
 * load report before relying on any number for this area.
 *
 * `securecall` accepting a STRING as its first argument is not a convenience: the client's own
 * `UIDropDownMenu.lua` and `ChatFrame.lua` both call it as `securecall("UIDropDownMenu_Initialize",
 * ...)`, and a version that only accepted a function would fail on exactly the callers that use it
 * most.
 */
import { LuaVM } from './../vm';

/**
 * Written as Lua source rather than as JS bindings, deliberately.
 *
 * Every one of these is a HIGHER-ORDER function: it takes a Lua function and calls it with a
 * pass-through vararg. Routing that through `registerFunction`'s value marshalling would mean turning
 * each argument into a JS value and back, which loses tables' identity and cannot express `...` at
 * all. In Lua it is six lines and exact.
 */
const SECURE_LUA = `
-- securecall(funcOrName, ...) -> the function's own returns.
-- No taint to clear, so this is the call and nothing else. A string names a global, which is how
-- UIDropDownMenu.lua:64 and ChatFrame.lua call it.
function securecall(func, ...)
  if type(func) == "string" then
    -- _G, not the engine's getglobal(): this runtime does not define getglobal (compat.ts lists
    -- exactly the aliases the loaded files call, and that is not one of them), and reaching for a
    -- name this file does not own would make the shim depend on a shim.
    -- NOTE for editors: this is a JS template literal, so no backticks may appear below.
    func = _G[func]
  end
  if type(func) ~= "function" then
    return
  end
  return func(...)
end

-- No execution path here is ever tainted, so every path is secure.
function issecure()
  return true
end

function issecurevariable()
  return true
end

-- forceinsecure() taints the current path on purpose. Nothing tracks taint, so there is nothing to
-- set; it is left callable so a caller does not error.
function forceinsecure()
end

-- scrub(...) strips non-primitive values out of an argument list before they cross into secure code.
-- With no secure code to protect, everything passes through unchanged.
function scrub(...)
  return ...
end

-- hooksecurefunc([table, ] name, post): call the original, then post(...) with the SAME arguments.
-- The original's return values are what the caller sees -- a post-hook must not be able to change
-- them, which is the whole reason the client offers this instead of plain reassignment.
function hooksecurefunc(arg1, arg2, arg3)
  local owner, name, post
  if type(arg1) == "table" then
    owner, name, post = arg1, arg2, arg3
  else
    owner, name, post = _G, arg1, arg2
  end
  if type(post) ~= "function" then
    return
  end
  local original = owner[name]
  if type(original) ~= "function" then
    return
  end
  -- The original's returns are collected into a table and unpacked, NOT captured into a fixed list
  -- of locals: a post-hook must be invisible to the caller, and an eight-local version silently
  -- truncates any function that returns more than eight values.
  owner[name] = function(...)
    local results = { original(...) }
    post(...)
    return unpack(results)
  end
end
`;

/**
 * Installs the taint-system globals on `vm`.
 *
 * Returns nothing and cannot fail usefully: a syntax error here is a bug in this file, so it is
 * reported to the console rather than folded into a caller's load report, where it would read as a
 * problem with the document being loaded.
 */
export function installSecureApi(vm: LuaVM): void {
  const error = vm.run(SECURE_LUA, 'lua/api/secure.ts');
  if (error !== null) {
    console.error(`installSecureApi: ${error.message}`);
  }
}
