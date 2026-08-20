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

/**
 * THE game clock, in `GetTime()` seconds, shared by the Lua and by everything on the host side that has
 * to agree with it.
 *
 * The epoch used to be a LOCAL captured per `installCompat` call -- "seconds since the VM was created" --
 * and that was fine while `GetTime` was only ever read from inside the Lua. It is not fine now: a
 * cooldown is a `GetTime()`-based `start` that the ACTION BRIDGE stamps and the DRAW PASS compares
 * against (`ui/action-bridge.ts`, `ui/world-ui.ts#drawSweeps`), and neither of those can reach a local in
 * this function. Two clocks with different epochs would have put every sweep at a wildly wrong fraction --
 * silently, since both are plausible seconds-since-something.
 *
 * Module load rather than VM creation, so the epoch is the same for the glue VM and the world VM. The
 * difference between the two is the few seconds of a page load, and nothing measures across it.
 */
const EPOCH = Date.now();

/** `GetTime()`, callable from the host. The ONE clock a cooldown's `start` is measured on. */
export function gameTime(): number {
  return (Date.now() - EPOCH) / 1000;
}

export function installCompat(vm: LuaVM): void {
  // GetTime(): Blizzard's glue uses this for animation and timeout logic. fengari has no notion of
  // a game clock, so this reads the one thing the runtime actually advances -- the wall clock --
  // as seconds since the module was loaded. See `gameTime` for why the epoch is not per-VM.
  vm.registerFunction('GetTime', () => [gameTime()]);

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
    -- THE WORLD MANIFEST'S OWN SET, and its absence was a whole-manifest defect rather than a cosmetic
    -- one: an alias missing here is nil, a nil called at FILE SCOPE aborts the chunk, and every function
    -- the rest of that file would have defined is then undefined for the whole session.
    -- SpellBookFrame.lua:4 (MAX_SPELL_PAGES = ceil(MAX_SPELLS / SPELLS_PER_PAGE)) is the one that
    -- exposed it -- ceil was absent, so SpellBookFrame_OnLoad, SpellButton_OnLoad and the other 30
    -- functions in that file never existed, and the load report showed
    -- 'function="SpellBookFrame_OnLoad" is not a defined global' for a file whose XML had loaded fine.
    -- ChatFrame.lua:630 did the same on strlower, LFDFrame.lua:1 on GetExpansionLevel, and
    -- PetActionBarFrame.lua:384 on gsub (12 handler failures).
    --
    -- COUNTED over the 264 files the world manifest actually loads (a grep for each name over the
    -- served .lua and .xml), not guessed: gsub 87, strlower 55, ceil 52, strmatch 43, strfind 27,
    -- abs 14, date 5, sqrt 3, time 3, gmatch 2. Each is an EXACT standard-library equivalent under a
    -- 5.0-era flat name. (No backticks anywhere in this shim: it is a JS template literal.)
    ceil = math.ceil
    abs = math.abs
    sqrt = math.sqrt
    strlower = string.lower
    strfind = string.find
    strmatch = string.match
    gsub = string.gsub
    gmatch = string.gmatch
    date = os.date
    time = os.time
    -- NOT aliased, deliberately, because they are engine functions with no standard-library twin and
    -- their exact semantics are not sourced here: strsplit (18 calls -- its first argument is a SET of
    -- delimiter characters and it returns a tuple), strjoin (2), strtrim (12). Each still aborts its
    -- chunk where it is called at file scope, and the load report names it.
    -- PI: an engine CONSTANT, not a function, and the only one on this list.
    --
    -- Defined in no FrameXML file at all -- GameTime.lua:16 is literally "local PI = PI", which caches
    -- an engine global. Its absence is a silent killer rather than a missing feature, because every
    -- caller uses it in ARITHMETIC: Model_OnUpdate's held-rotate-button sweep is
    -- "elapsedTime * 2 * PI * rotationsPerSecond" (UIParent.lua:2851), so with PI nil the handler
    -- raised on multiplication the moment a rotate button read PUSHED -- which is exactly the owner's
    -- "it's hard to rotate using buttons": only the per-click 0.03 step survived. MEASURED live before
    -- this line: PI read nil, GetButtonState read PUSHED, and 600 ms of holding moved the yaw by one
    -- 0.03 step instead of 108 degrees.
    --
    -- Three callers in the world manifest and no others: UIParent.lua (Model_OnUpdate),
    -- TabardFrame.lua:62,69 (the same held-button sweep) and GameTime.lua (the minimap clock's hands).
    -- Fully specified, unlike strsplit -- it is math.pi.
    PI = math.pi
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

    -- THE bit LIBRARY, and it was killing Constants.lua -- the second file the world manifest loads.
    --
    -- STATE.md listed bit as "still absent on purpose (a whole library)", with AutoComplete.lua and
    -- TalentFrameBase.lua as the casualties. MEASURED against the served files, the cost was much larger and
    -- in a much worse place: constants.lua:280 is
    --
    --     COMBATLOG_OBJECT_RAIDTARGET_MASK = bit.bor(COMBATLOG_OBJECT_RAIDTARGET1, ...)
    --
    -- AT FILE SCOPE, in a 478-line file, so lines 280-478 never ran. That is where QuestDifficultyColors
    -- (line 403) lives -- the table api/units.ts GetQuestDifficultyColor reads and, until now, never found
    -- -- along with the TOTEM_*, CALENDAR_*, ACHIEVEMENT_* and GMTICKET_* blocks and
    -- TEXTURE_ITEM_QUEST_BANG. VERIFIED LIVE: with FillLocalizedClassList added but this still absent, the
    -- per-file report read exactly one error, "Constants.lua:280: attempt to index a nil value (global
    -- 'bit')", QuestDifficultyColors was nil, and NUM_BAG_SLOTS (line 226) was 4 -- so the file was dying at
    -- 280 and not before it.
    --
    -- NOT UNSOURCED, which is why this is written rather than declared a gap. 3.3.5a ships Reuben Thomas's
    -- BitLib, whose operations are all defined on 32-BIT INTEGERS -- a fully specified domain, unlike
    -- strsplit's delimiter-set semantics, which is why THAT one is still deliberately absent.
    --
    -- ## Built on the VM's NATIVE operators, because this VM has them and they are 32-bit
    --
    -- MEASURED in fengari (the VM this runtime uses) rather than assumed, and the first draft of this block
    -- assumed wrong in two ways worth recording:
    --
    --     _VERSION            Lua 5.3          (not 5.1 -- so & | ~ << >> exist, and integers exist)
    --     math.maxinteger     2147483647       (integers are 32-BIT, exactly BitLib's domain)
    --     0x80000000          -2147483648      (a top-bit literal is NEGATIVE here)
    --     0xFFFFFFFF          -1
    --     0xFF00 & 0x0FF0     3840             (native ops work)
    --     -1 >> 1             2147483647       (native >> is LOGICAL -- exactly BitLib's rshift)
    --
    -- So results are SIGNED 32-bit integers, which is what BitLib returns AND what makes a folded mask
    -- compare equal to the client's own constants. The first draft returned unsigned values and argued that
    -- constants.lua:278's COMBATLOG_OBJECT_NONE = 0x80000000 is "a positive literal" -- it is not, in this
    -- VM, and bit.bnot(0x7FFFFFFF) == 0x80000000 came back FALSE. That draft also produced FLOATS for every
    -- shift (bit.lshift(1,4) printed "16.0"), because 2^n is always a float in 5.3. Nothing in the loaded
    -- manifest compares a bit result to a top-bit constant today, so the bug was latent -- but the recorded
    -- reasoning was what a future reader would have trusted.
    --
    -- (NO BACKTICKS anywhere in this block: it is a JS TEMPLATE LITERAL, as the notes above warn. One
    -- backtick here broke the whole module until tsc named it.)
    bit = {}
    -- BitLib TRUNCATES a fractional operand toward zero; 5.3's native operators RAISE on a number with no
    -- integer representation, so the coercion has to be explicit rather than left to the operator.
    local function toint(v)
      local n = tonumber(v) or 0
      if n >= 0 then n = math.floor(n) else n = -math.floor(-n) end
      n = n % 4294967296
      if n >= 2147483648 then n = n - 4294967296 end
      return math.tointeger(n) or 0
    end
    -- VARIADIC, all three: constants.lua:280 passes EIGHT arguments to bit.bor in one call, so a
    -- two-argument implementation would silently drop raid targets 3-8 out of the mask -- and would not
    -- raise while doing it.
    local function fold(op, ...)
      local n = select('#', ...)
      if n == 0 then return 0 end
      local acc = toint((select(1, ...)))
      for i = 2, n do acc = op(acc, toint((select(i, ...)))) end
      return acc
    end
    function bit.band(...) return fold(function(p, q) return p & q end, ...) end
    function bit.bor(...) return fold(function(p, q) return p | q end, ...) end
    function bit.bxor(...) return fold(function(p, q) return p ~ q end, ...) end
    function bit.bnot(a) return ~toint(a) end
    -- Shift counts are masked to 5 bits, which is what LuaJIT's bit library and the x86 shift instructions
    -- do. 5.3's own << and >> instead yield 0 for a count of 32 or more; masking is the more useful of the
    -- two and nothing in the loaded manifest shifts that far, so the difference is stated rather than
    -- discovered. It also makes a negative count harmless instead of a silent right-shift.
    function bit.lshift(a, n) return toint(a) << (toint(n) & 31) end
    -- LOGICAL, zeros shifted in at the top -- which is what the native >> already does on this VM (measured
    -- above: -1 >> 1 is 2147483647, not -1).
    function bit.rshift(a, n) return toint(a) >> (toint(n) & 31) end
    -- ARITHMETIC, the sign bit replicated. 5.3 has no arithmetic shift, so a negative value is complemented,
    -- shifted logically and complemented back. Kept separate from rshift because BitLib keeps them separate,
    -- and a caller that wanted sign extension and got zero-fill cannot tell on a positive value.
    function bit.arshift(a, n)
      local x, s = toint(a), toint(n) & 31
      if x >= 0 then return x >> s end
      return ~((~x) >> s)
    end
    bit.mod = math.fmod

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
