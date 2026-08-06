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
  `;
  const error = vm.run(shim, 'compat.lua');
  if (error !== null) {
    // The shim above is fixed, known-good Lua; a failure here means the VM itself is broken, not
    // that the glue code did anything wrong.
    throw new Error(`installCompat: the 5.1 shim itself failed to load: ${error.message}`);
  }
}
