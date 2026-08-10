/**
 * The Lua 5.1 compatibility shim the glue code needs, layered onto fengari's Lua 5.3 semantics.
 *
 * All 27 glue Lua files were scanned for 5.1-vs-5.3 differences before this was written:
 * `setfenv`/`getfenv`, `string.gfind`, `math.mod`, `loadstring`, `arg[...]`, `module()`, and
 * `table.setn` never occur. `unpack(` occurs once, in `glueparent.lua`. `getn(` occurs once, in a
 * file we do not load. That is why the shim below is this small -- every entry exists because a
 * specific piece of loaded (or plausibly-soon-loaded) glue code needs it, not because Lua 5.1 had it.
 * A shim entry with no reason attached is indistinguishable from a mistake later, so each one below
 * is commented, and this file is the seam a future swap to a real Lua 5.1 runtime would go through.
 */
import { LuaVM } from './vm';

export function installCompat(vm: LuaVM): void {
  const startedAt = Date.now();

  // GetTime(): Blizzard's glue uses this for animation and timeout logic. fengari has no notion of
  // a game clock, so this reads the one thing the runtime actually advances -- the wall clock --
  // as seconds since the VM was created.
  vm.registerFunction('GetTime', () => [(Date.now() - startedAt) / 1000]);

  // GetLocale(): several glue files branch on the client's locale. We are not localizing, so a
  // fixed 'enUS' keeps that branch deterministic instead of undefined.
  vm.registerFunction('GetLocale', () => ['enUS']);

  const shim = `
    -- unpack was a global in 5.1; 5.2 moved it to table.unpack and fengari (5.3) only has the
    -- latter. glueparent.lua calls the 5.1 name, so restore it as a global alias.
    unpack = table.unpack

    -- getn(t) was table.getn's 5.1-only global spelling, replaced by the '#' length operator in
    -- 5.2+. Nothing in the glue files this runtime loads calls it, but one unloaded file does, and
    -- the replacement is exact and free, so it is defined here rather than left to surprise a
    -- future loader change.
    function getn(t) return #t end

    -- THE ENGINE'S OWN GLOBAL ALIASES, which are not a Lua version difference at all: WoW's Lua
    -- environment publishes a flat set of names left over from Lua 5.0's standard library layout, and
    -- FrameXML uses them in preference to the namespaced spellings everywhere. They have to be here for
    -- the same reason the shims above do -- without them the file that calls one stops loading -- and
    -- the omission was not visible until the runtime ran the real files: gluedialog.lua:102 calls
    -- format at FILE SCOPE, so the whole of GlueDialog.lua failed to load, GlueDialog_OnLoad was
    -- therefore never defined, and the login screen came up with an uninitialized dialog panel sitting
    -- across the middle of it.
    --
    -- Exactly the ones the loaded manifest calls, counted in the files rather than guessed:
    -- format (5), strsub (6), strlen (5), strupper (1), mod (5), floor (12), min (1), max (1),
    -- random (2), tinsert (1), tremove (1).
    format = string.format
    strsub = string.sub
    strlen = string.len
    strupper = string.upper
    floor = math.floor
    min = math.min
    max = math.max
    random = math.random
    tinsert = table.insert
    tremove = table.remove
    -- wipe(t) / table.wipe(t): WoW's own table extension -- empty the table IN PLACE and return it.
    -- Not a Lua version difference either; there is no standard-library equivalent in any version.
    -- IN PLACE is the whole point: FrameXML wipes tables other frames hold references to, so
    -- replacing the table would leave every holder looking at the old contents.
    --
    -- Only reachable in the WORLD manifest, which is why the glue boot never missed it:
    -- BuffFrame.lua:84 calls table.wipe(...) from BuffFrame_Update, which PlayerFrame_ToPlayerArt
    -- reaches -- so its absence took out the first thing PlayerFrame_OnEvent does on
    -- PLAYER_ENTERING_WORLD. (No backticks in this shim: it is a JS TEMPLATE LITERAL.)
    function wipe(t)
      for k in pairs(t) do t[k] = nil end
      return t
    end
    table.wipe = wipe

    -- WoW's mod() is the C fmod, not Lua 5.3's integer-flavoured '%': gluetemplates.lua's scroll math
    -- and glueparent.lua's fade math both pass floats.
    mod = math.fmod

    -- seterrorhandler(handler): the engine's hook for "a script errored". gluebasiccontrols.xml
    -- installs FrameXML's own _ERRORMESSAGE through it in an INLINE script, so a missing global
    -- aborted that chunk -- taking the message() global it also defines with it. Nothing in this
    -- runtime routes Lua errors through a handler (vm.run/pcall return them to the JS caller, which
    -- is where the load report gets them), so this records the handler and calls nobody, rather than
    -- pretending to be a hook.
    local errorHandler = nil
    function seterrorhandler(handler) errorHandler = handler end
    function geterrorhandler() return errorHandler or function(message) return message end end
    -- debuginfo(): a debug-build engine call with no observable effect in a release client.
    function debuginfo() end
  `;
  const error = vm.run(shim, 'compat.lua');
  if (error !== null) {
    // The shim above is fixed, known-good Lua; a failure here means the VM itself is broken, not
    // that the glue code did anything wrong.
    throw new Error(`installCompat: the 5.1 shim itself failed to load: ${error.message}`);
  }
}
