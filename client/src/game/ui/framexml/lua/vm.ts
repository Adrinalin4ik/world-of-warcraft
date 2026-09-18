/**
 * A thin wrapper around fengari's Lua 5.3 VM, giving TypeScript callers a value-in/value-out API
 * instead of fengari's raw C-style stack protocol.
 *
 * fengari mirrors the Lua C API almost exactly: every function takes the `lua_State` as its first
 * argument, and JS <-> Lua values move through an explicit stack (`lua_push*` to send a value in,
 * `lua_to*` to read one back, `lua_pop`/`lua_settop` to balance it). A JS function registered with
 * `lua_pushjsfunction` is literally a Lua C function: it receives the state, reads its arguments off
 * the stack by position, and returns how many result values it left on top of the stack. The
 * `fengari-interop` package (bundled into fengari-web, not installed here) exists to marshal whole
 * DOM/JS objects across that boundary; we don't need that -- `registerFunction` below re-implements
 * the small slice of the same stack protocol the glue code actually needs: read N arguments off the
 * stack, hand them to a plain JS callback as an array, push whatever it returns back onto the stack.
 *
 * Lua values that aren't JS primitives (tables, functions) can't be copied into a JS value, so they
 * are kept on the Lua side and handed out as `LuaRef` -- an index into a Lua table this class owns,
 * itself anchored in the registry (`LUA_REGISTRYINDEX`) and so never garbage-collected out from under
 * us. It is deliberately NOT `luaL_ref`'s use of the registry table itself; `ref`'s docstring carries
 * the measurement that decided it. `newTable`/`setTableField`/`setMetatable` exist because Task 2 (frame wrapper tables with
 * a `CreateFrame` metatable) needs to build and shape a table from the JS side, and the brief's
 * original surface -- `run`/`call`/`setGlobal`/`getGlobal`/`registerFunction` -- has no way to create
 * a table or attach a metatable to one at all.
 */
import * as fengari from 'fengari';

const { lua, lauxlib, lualib } = fengari;

export type LuaError = { message: string; chunk: string };

/**
 * An opaque handle to a Lua value that has no JS representation (table, function, ...). Internally
 * it is an index into the registry table; the `unique symbol` brand exists only so TypeScript won't
 * let callers construct or inspect one, since doing anything with the number besides handing it back
 * to this class would be meaningless.
 */
export type LuaRef = { readonly __lua: unique symbol };

type LuaRefBox = { readonly registryIndex: number };

function box(registryIndex: number): LuaRef {
  return { registryIndex } as unknown as LuaRef;
}

function unbox(ref: LuaRef): number {
  return (ref as unknown as LuaRefBox).registryIndex;
}

/**
 * A `LuaRef` marked for a ONE-TIME trip across the boundary: whatever pushes it (a method's or a
 * registered function's result, so far the only place one of these should ever be built) also frees
 * the registry slot immediately after, because nothing else owns it past that push.
 *
 * This exists opposite a BORROWED return like `ctx.wrapper(id)` -- `FrameRegistry` owns that handle
 * permanently and releases it itself in `reset()`, so pushing it must NOT also release it, or the next
 * read of the same frame's wrapper would find its registry slot already handed to something else. A
 * handle minted just to satisfy one return value (`vm.dup(existing)`, when `existing` is not
 * `ctx.wrapper`'s permanent handle) has no such owner, so wrap it in `transfer` instead of returning it
 * bare -- otherwise it is pinned in the registry forever, which is exactly the bug `GetScript` had
 * before this type existed: it returned a bare `dup`, and nothing downstream ever released it.
 */
export type LuaTransfer = { readonly __luaTransfer: unique symbol };

type LuaTransferBox = { readonly transferIndex: number };

function boxTransfer(registryIndex: number): LuaTransfer {
  return { transferIndex: registryIndex } as unknown as LuaTransfer;
}

function isTransferBox(value: unknown): value is LuaTransferBox {
  return typeof value === 'object' && value !== null && 'transferIndex' in value;
}

/** A Lua state, typed just widely enough for what this file calls on it. */
type LuaState = unknown;

export class LuaVM {
  private readonly L: LuaState;

  /**
   * THE HANDLE TABLE: one real fengari registry slot, holding one Lua table that every `LuaRef`
   * indexes into. `luaL_ref`/`luaL_unref` on `LUA_REGISTRYINDEX` are NOT used for handles, and the
   * reason is measured rather than stylistic -- see `ref`/`unref` below.
   */
  private readonly slotsRef: number;

  /** Freed slots, newest first. Ours, not fengari's: `luaL_unref`'s freelist is the thing being avoided. */
  private readonly freeSlots: number[] = [];

  /** Next never-used slot. 1-based only so a slot number is never the falsy 0. */
  private nextSlot = 1;

  /**
   * **LIVE HANDLE COUNT -- the instrument that separates a LEAK from a state-dependent cost.**
   *
   * Every table or function crossing from Lua to JS mints a slot (`toJs`'s default branch calls
   * `ref()`), and only an explicit `unref` gives it back. A caller that reads a table-valued global
   * and forgets to release it therefore leaks one slot per call, and a per-frame caller leaks at
   * frame rate -- which reads on a profile as a cost that GROWS with session length rather than one
   * that depends on what is on screen. Those two look identical in a single sample and completely
   * different in two, so the count is exported and censused rather than argued about.
   *
   * It is also the number that decides how much a leak COSTS. Slot allocation itself is O(1) here by
   * design -- that is the whole point of not using `luaL_ref` (see `ref` below) -- so a leak is not
   * automatically slow. But the handle table it grows is a fengari `Table` backed by a JS `Map`, and
   * the measured `luaL_ref` table above is what a growing one did to this interface: a 10.1 s freeze.
   * So a rising `liveHandles` is a defect to fix on its own terms whether or not it is today's
   * hot line.
   *
   * Two subtractions and no allocation, so it is free to read every frame.
   */
  get liveHandles(): number {
    return this.nextSlot - 1 - this.freeSlots.length;
  }

  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    lua.lua_newtable(this.L);
    this.slotsRef = lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX);
  }

  /** Loads and runs a chunk of Lua source. Never throws -- a load or runtime error comes back as a value. */
  run(source: string, chunkName: string): LuaError | null {
    const bytes = fengari.to_luastring(source);
    const loadStatus = lauxlib.luaL_loadbuffer(this.L, bytes, bytes.length, chunkName);
    if (loadStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    const callStatus = lua.lua_pcall(this.L, 0, 0, 0);
    if (callStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    return null;
  }

  /** Calls a Lua function referenced by `fn` with `args`, discarding any results. */
  call(fn: LuaRef, args: unknown[]): LuaError | null {
    this.pushRef(fn);
    for (const arg of args) {
      this.pushValue(arg);
    }
    const status = lua.lua_pcall(this.L, args.length, 0, 0);
    if (status !== lua.LUA_OK) {
      return this.popError('<call>');
    }
    return null;
  }

  /**
   * `call`, but keeping the function's FIRST result instead of discarding it.
   *
   * The loader (Task 7) is the first caller that needs one: it materializes a document by calling the
   * Lua `CreateFrame` global and the wrapper's own `CreateTexture`/`GetFontString`/`GetNormalTexture`,
   * every one of which is only useful for the widget it hands back. The alternatives were both worse
   * than a second call method -- reaching into `FrameRegistry` behind Lua's back (the private back door
   * the whole object model exists to avoid), or splicing frame names into a `runExpr` source string
   * (which puts arbitrary XML attribute text inside Lua quotes: one apostrophe in a frame name and the
   * chunk stops parsing).
   *
   * The returned value follows `toJs`'s mapping, so a table or function arrives as a FRESH `LuaRef`
   * the caller owns and must `unref` -- even when the Lua side handed back a permanently-held handle
   * like a frame's wrapper, because the registry slot is this call's, not that handle's.
   */
  callReturning(fn: LuaRef, args: unknown[]): LuaError | { value: unknown } {
    this.pushRef(fn);
    for (const arg of args) {
      this.pushValue(arg);
    }
    const status = lua.lua_pcall(this.L, args.length, 1, 0);
    if (status !== lua.LUA_OK) {
      return this.popError('<call>');
    }
    return { value: this.popValue() };
  }

  /**
   * Loads and runs a chunk of Lua source that ends in a single `return <expr>`, and hands back the
   * value it returned. `run` above discards every result, which is fine for side-effecting chunks but
   * useless for Task 5's `compileScriptHandler`: compiling `return function(self, ...) ... end` into a
   * callable value requires reading that return, not just knowing the chunk didn't error.
   */
  runExpr(source: string, chunkName: string): LuaError | { value: unknown } {
    const bytes = fengari.to_luastring(source);
    const loadStatus = lauxlib.luaL_loadbuffer(this.L, bytes, bytes.length, chunkName);
    if (loadStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    const callStatus = lua.lua_pcall(this.L, 0, 1, 0);
    if (callStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    return { value: this.popValue() };
  }

  /**
   * `runExpr`, but running the chunk with a CALLER-SUPPLIED `_ENV` instead of `_G`.
   *
   * This is the Lua 5.3 mechanism that replaces 5.1's `setfenv`, and it is what lets a compiled
   * script handler resolve `this`/`event`/`argN` out of a small table rather than out of `_G` --
   * see `scripts.ts#callWithBothConventions` for the measurement that made that necessary. A
   * function defined inside the chunk inherits the chunk's `_ENV`, so setting it on the chunk is
   * enough to give the returned handler its environment.
   *
   * `_ENV` is upvalue 1 of any main chunk, which is why the index below is a literal 1 and not a
   * search: `luaL_loadbuffer` produces a closure whose only upvalue is `_ENV`.
   */
  runExprInEnv(source: string, chunkName: string, env: LuaRef): LuaError | { value: unknown } {
    const bytes = fengari.to_luastring(source);
    const loadStatus = lauxlib.luaL_loadbuffer(this.L, bytes, bytes.length, chunkName);
    if (loadStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    this.pushRef(env);
    // Pops the env and installs it as the chunk's `_ENV`. Every chunk `luaL_loadbuffer` produces has
    // exactly one upvalue and it is `_ENV`, so this cannot miss.
    lua.lua_setupvalue(this.L, -2, 1);
    const callStatus = lua.lua_pcall(this.L, 0, 1, 0);
    if (callStatus !== lua.LUA_OK) {
      return this.popError(chunkName);
    }
    return { value: this.popValue() };
  }

  /**
   * Re-points a Lua function's `_ENV` upvalue at `env`. Returns false if it has none.
   *
   * A function with no `_ENV` upvalue references no globals at all, so there is nothing to re-point
   * and false is the ordinary answer rather than a failure. The upvalue is FOUND BY NAME and not
   * assumed to be index 1: that holds for a main chunk, but a nested function's upvalue order is
   * whatever the compiler assigned.
   *
   * Used on every handler as it is stored (`scripts.ts#setScriptHandler`) so that a handler a
   * pre-2.0 addon compiled itself resolves `this`/`event`/`argN` the same way one this runtime
   * compiled does. Re-pointing is behaviour-preserving for everything else, because the environment
   * chains to `_G` for reads and forwards writes back to it.
   */
  setFunctionEnv(fn: LuaRef, env: LuaRef): boolean {
    this.pushRef(fn);
    for (let i = 1; ; i += 1) {
      const name = lua.lua_getupvalue(this.L, -1, i);
      if (name === null) {
        lua.lua_pop(this.L, 1);
        return false;
      }
      // `lua_getupvalue` pushed the upvalue's value; drop it either way.
      lua.lua_pop(this.L, 1);
      if (fengari.to_jsstring(name) === '_ENV') {
        this.pushRef(env);
        lua.lua_setupvalue(this.L, -2, i);
        lua.lua_pop(this.L, 1);
        return true;
      }
    }
  }

  /**
   * RAW read of `table[key]` -- no `__index`, so a miss reads as absent rather than chaining.
   *
   * The save half of the legacy-globals save-restore uses this deliberately: it must read what the
   * environment itself holds, not what `_G` would supply through the chain, or a nested invocation
   * would "save" an unrelated global and restore it over the outer handler's value.
   */
  rawGet(table: LuaRef, key: string): unknown {
    this.pushRef(table);
    lua.lua_pushstring(this.L, key);
    lua.lua_rawget(this.L, -2);
    const value = this.toJs(-1);
    lua.lua_pop(this.L, 2);
    return value;
  }

  /**
   * RAW write of `table[key] = value` -- no `__newindex`, so it cannot be forwarded to `_G`.
   *
   * This is what keeps the environment's pass-through metamethod free to be an unconditional
   * forward: the three legacy keys never go through it, so it needs no special-casing and a
   * handler's ordinary `foo = 1` still lands in `_G`.
   */
  rawSet(table: LuaRef, key: string, value: unknown): void {
    this.pushRef(table);
    lua.lua_pushstring(this.L, key);
    this.pushValue(value);
    lua.lua_rawset(this.L, -3);
    lua.lua_pop(this.L, 1);
  }

  setGlobal(name: string, value: unknown): void {
    this.pushValue(value);
    lua.lua_setglobal(this.L, name);
  }

  getGlobal(name: string): unknown {
    lua.lua_getglobal(this.L, name);
    return this.popValue();
  }

  /**
   * Exposes a JS function to Lua as a global. `fn` receives the call's arguments as a plain array
   * and returns the values Lua should see back, in order -- the stack bookkeeping happens here so
   * every caller of `registerFunction` gets to work with values, not stack indices.
   *
   * If `fn` throws an `Error`, it is converted into a real Lua error (`luaL_error`), so a binding
   * can reject bad input the way the client's own engine does -- `CreateFrame("Sparkle")` has to be
   * catchable by `pcall` and carry a source position, not tear the JS call stack down through
   * fengari. Anything thrown that is NOT an `Error` is re-thrown untouched, because that is how
   * fengari signals its own errors internally (it throws the state's `errorJmp` object, which
   * `lua_pcall` up the stack is waiting to catch); swallowing one would corrupt the VM.
   */
  registerFunction(name: string, fn: (args: unknown[]) => unknown[]): void {
    lua.lua_pushjsfunction(this.L, (L: LuaState) => {
      const nargs = lua.lua_gettop(L);
      const args: unknown[] = [];
      for (let i = 1; i <= nargs; i++) {
        args.push(this.toJs(i));
      }
      let results: unknown[];
      try {
        results = fn(args) ?? [];
      } catch (error) {
        if (error instanceof Error) {
          return lauxlib.luaL_error(L, fengari.to_luastring('%s'), error.message);
        }
        throw error;
      }
      // GROW THE STACK BEFORE PUSHING. A Lua C function is guaranteed only `LUA_MINSTACK` (20) free
      // slots, and pushing past that without asking is undefined -- in fengari it surfaces as an error
      // whose MESSAGE IS THE VALUE THAT DID NOT FIT, which is about as misleading as a diagnostic gets.
      //
      // MEASURED: `GetChatWindowMessages` returns a list of 30 message-group names, and the call raised
      // `AFK` -- the 21st entry. Nothing in the message said "stack", the function looked correct, and
      // the failure was two subsystems away from its cause. Any global returning more than 20 values
      // had this waiting for it.
      if (results.length > 0 && !lua.lua_checkstack(L, results.length)) {
        return lauxlib.luaL_error(
          L, fengari.to_luastring('%s'),
          `${name}: cannot return ${results.length} values -- the Lua stack could not grow`,
        );
      }
      for (const result of results) {
        this.pushValue(result);
      }
      return results.length;
    });
    lua.lua_setglobal(this.L, name);
  }

  /** Creates a fresh Lua table and returns a handle to it, for building frame wrapper tables (Task 2). */
  newTable(): LuaRef {
    lua.lua_newtable(this.L);
    return this.ref();
  }

  /** Sets `table[key] = value`. */
  setTableField(table: LuaRef, key: string, value: unknown): void {
    this.pushRef(table);
    this.pushValue(value);
    lua.lua_setfield(this.L, -2, key);
    lua.lua_pop(this.L, 1);
  }

  /** Reads `table[key]`. */
  getTableField(table: LuaRef, key: string): unknown {
    this.pushRef(table);
    lua.lua_getfield(this.L, -1, key);
    const value = this.toJs(-1);
    lua.lua_pop(this.L, 2);
    return value;
  }

  /** Sets `table`'s metatable to `metatable`, the mechanism `CreateFrame`'s method dispatch (Task 2) needs. */
  setMetatable(table: LuaRef, metatable: LuaRef): void {
    this.pushRef(table);
    this.pushRef(metatable);
    lua.lua_setmetatable(this.L, -2);
    lua.lua_pop(this.L, 1);
  }

  /**
   * Releases a handle, freeing its registry slot for reuse. The Lua value itself lives or dies by
   * ordinary garbage collection afterwards.
   *
   * This exists because the handle table is the one thing here that JS garbage collection cannot help
   * with: it is anchored in the registry and so is a GC root by definition, so an unreleased
   * handle pins its value forever. `toJs` mints a fresh handle for EVERY table or function that
   * crosses the boundary -- including every frame passed as an argument to a widget method -- so
   * without this the registry would grow with each such call, not just with each object.
   *
   * A released handle must not be used again; it is not an error the VM can detect, because the
   * slot may already have been handed to a different value.
   */
  unref(ref: LuaRef): void {
    this.freeSlot(unbox(ref));
  }

  /**
   * Returns a SECOND, independent handle to the same Lua value, so a caller can keep the value after
   * whoever handed it over releases their handle.
   *
   * This is what lets a binding RETAIN something: `frame:SetScript("OnClick", handler)` receives a
   * handle to the handler function that the call boundary is about to release, and a stored handle
   * whose registry slot has been freed is far worse than a leak -- the slot is reused by the next
   * value crossing the boundary, so the stored handler silently becomes some unrelated Lua value
   * with no error anywhere. Duplicating gives the storing side a handle it owns, and must `unref`.
   */
  dup(ref: LuaRef): LuaRef {
    this.pushRef(ref);
    return this.ref();
  }

  /** Whether a value that came back out of Lua is a handle (and so needs `unref` when discarded). */
  isRef(value: unknown): value is LuaRef {
    return typeof value === 'object' && value !== null && 'registryIndex' in value;
  }

  /**
   * Marks `ref` as a one-time transfer for the NEXT time it is pushed (see `LuaTransfer`'s docstring).
   * `ref` itself must not be used again after this -- the same registry slot, not a fresh one, is what
   * gets freed once it is pushed, so this is a relabeling of the handle's ownership, not a copy of it.
   */
  transfer(ref: LuaRef): LuaTransfer {
    return boxTransfer(unbox(ref));
  }

  dispose(): void {
    lua.lua_close(this.L);
  }

  /** Pops the error object fengari left on top of the stack after a failed load/pcall. */
  private popError(chunk: string): LuaError {
    const message = lua.lua_tojsstring(this.L, -1) ?? String(lua.lua_tostring(this.L, -1));
    lua.lua_pop(this.L, 1);
    return { message, chunk };
  }

  /** Pushes a JS value onto the Lua stack. `undefined`/`null` become `nil`; a `LuaRef` pushes the value it references. */
  private pushValue(value: unknown): void {
    if (value === undefined || value === null) {
      lua.lua_pushnil(this.L);
    } else if (typeof value === 'boolean') {
      lua.lua_pushboolean(this.L, value);
    } else if (typeof value === 'number') {
      // Lua 5.3 keeps integer and float subtypes distinct in ways that are observable, not just
      // internal: tostring(3.0) is "3.0", and FrameXML concatenates numbers into strings constantly
      // ("Level "..level, name.." ("..major.."."..minor..")"). Pushing every JS number as a float
      // would render "80.0" everywhere a whole number was expected, so integral values go through
      // lua_pushinteger instead. Number.isSafeInteger, not Number.isInteger: a value beyond 2^53
      // isn't exactly representable as an integer either, so it should stay a float rather than
      // silently truncate.
      if (Number.isSafeInteger(value)) {
        lua.lua_pushinteger(this.L, value);
      } else {
        lua.lua_pushnumber(this.L, value);
      }
    } else if (typeof value === 'string') {
      lua.lua_pushstring(this.L, value);
    } else if (isTransferBox(value)) {
      // Push the value the slot holds, THEN free the slot -- Lua now has its own reference (the
      // stack, or wherever the caller of `registerFunction`/`call` puts the result), and this
      // registry slot was never going to be used again.
      // Through the handle table, not `LUA_REGISTRYINDEX`: a transfer index is a slot number minted by
      // `ref`, so reading or freeing it against fengari's own registry would address a different table.
      this.pushRef(box(value.transferIndex));
      this.freeSlot(value.transferIndex);
    } else if (this.isRef(value)) {
      this.pushRef(value);
    } else {
      throw new Error(`LuaVM: cannot push a JS value of type ${typeof value} onto the Lua stack`);
    }
  }

  /** Reads the Lua value at stack index `idx` back into a JS value, per the same mapping as `pushValue`. */
  private toJs(idx: number): unknown {
    const type = lua.lua_type(this.L, idx);
    switch (type) {
      case lua.LUA_TNIL:
        return undefined;
      case lua.LUA_TBOOLEAN:
        return lua.lua_toboolean(this.L, idx);
      case lua.LUA_TNUMBER:
        return lua.lua_tonumber(this.L, idx);
      case lua.LUA_TSTRING:
        return lua.lua_tojsstring(this.L, idx);
      default:
        // Tables, functions, and anything else with no JS shape: keep it on the Lua side and hand
        // out a registry reference to it instead.
        lua.lua_pushvalue(this.L, idx);
        return this.ref();
    }
  }

  /** Pops the top of the stack via `toJs`, leaving the stack as it was before the value was pushed. */
  private popValue(): unknown {
    const value = this.toJs(-1);
    lua.lua_pop(this.L, 1);
    return value;
  }

  /**
   * Stores the value on top of the stack in the handle table and returns a handle to it. Pops the stack.
   *
   * ## Why this is not `luaL_ref`, and it is the single largest cost in booting the interface
   *
   * `luaL_ref`/`luaL_unref` on `LUA_REGISTRYINDEX` are O(NUMBER OF LIVE HANDLES) under fengari, not
   * O(1) as they are in C Lua. Measured on this machine with fengari 0.1.4 (`node`, a state with N
   * long-lived handles held, timing 20,000 ref+unref cycles):
   *
   * | live handles |  per cycle |
   * |--------------|------------|
   * |            0 |    0.65 us |
   * |        5,000 |   40.26 us |
   * |       10,000 |   71.56 us |
   * |       20,000 |  151.27 us |
   *
   * The cause is fengari's table representation, not its ref logic. `ltable.js`'s `Table` is backed by
   * a JS `Map` (`t.strong`); writing nil to a key runs `mark_dead`, which does `strong.delete(hash)`,
   * and writing a fresh key runs `add`, which does `strong.set(hash, ...)`. `luaL_unref` does
   * `t[ref] = t[freelist]` and `t[freelist] = ref`, and `luaL_ref` undoes it -- so an alternating
   * ref/unref pair deletes and re-inserts a key of the registry table on every cycle. **A V8 `Map`'s
   * delete+set churn is itself O(size)**, measured separately on a bare `Map` with no Lua involved:
   * 1.36 us at 1,000 entries, 13.59 us at 20,000, 25.24 us at 80,000.
   *
   * This client fills the registry with thousands of PERMANENT handles -- `FrameRegistry` holds a
   * wrapper table for each of the 4,928 frames `FrameXML.toc` builds, plus every `SetScript` handler --
   * while `toJs` mints and releases a TRANSIENT handle for every table or function that crosses the
   * boundary, which is several per widget method call. So the two costs multiply, and they did:
   * `unref` was **6,174 ms of the 10,102 ms** the manifest load blocked the main thread for (V8 CPU
   * profile, `/game?offline=1&ui=lua`, self time attributed to the nearest non-fengari caller).
   *
   * The fix keeps the same O(1)-in-C-Lua contract without patching fengari: a slot is freed by writing
   * a NON-NIL sentinel (`false`) rather than nil, so the key is never deleted from the backing `Map`
   * and the next allocation of that slot is a plain overwrite (`luaH_setint`'s `setfrom` fast path).
   * The freelist lives in JS, where popping an array is genuinely O(1). Re-measured with the same
   * bench: **0.39 / 0.61 / 0.67 / 0.47 us per cycle at 0 / 5,000 / 20,000 / 80,000 live handles** --
   * flat, and a handle held across all that churn still reads back as the table it was.
   *
   * The sentinel is not a leak: it replaces the value, so what the slot used to hold is unreachable
   * from the registry and dies by ordinary garbage collection, which is exactly what `luaL_unref`
   * promises. What survives is the integer key itself, one `Map` entry per slot ever allocated, and
   * slots are reused.
   */
  private ref(): LuaRef {
    const slot = this.freeSlots.length > 0 ? (this.freeSlots.pop() as number) : this.nextSlot++;
    lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, this.slotsRef);
    // The table is on top and the value below it; `lua_insert` puts the table under the value so
    // `lua_rawseti` can consume the value as `table[slot]`.
    lua.lua_insert(this.L, -2);
    lua.lua_rawseti(this.L, -2, slot);
    lua.lua_pop(this.L, 1);
    return box(slot);
  }

  /** Releases a slot: see `ref` for why the sentinel is `false` and not nil. */
/**
   * **THE GENERAL TRAP, and this is the place someone will find it: NEVER DELETE A KEY FROM A LARGE
   * `Map` ON A HOT PATH. Overwrite it, or park a sentinel in it.**
   *
   * `false` is pushed here rather than nil precisely so no key is deleted, and that choice was
   * originally made for fengari's sake. It turns out to matter one layer further down as well, and
   * far more. MEASURED on a bare JS `Map` of N entries with no Lua in the picture, timing one key:
   *
   * | entries | set+delete | set+get |
   * |---------|------------|---------|
   * |       0 |   0.12 us  | 0.02 us |
   * |   2,000 |   4.20 us  | 0.02 us |
   * |   6,000 |  20.43 us  | 0.01 us |
   * |  12,000 |  40.81 us  | 0.02 us |
   *
   * **Overwriting an existing key is flat and free at any size. Deleting one and re-inserting it
   * makes V8 compact the backing store, which is O(capacity)** -- so a delete/re-insert cycle on a
   * large map costs proportionally to the WHOLE MAP, every time round.
   *
   * That is not a fengari defect and it is not fixed by fengari's own code being O(1): `ltable.js`'s
   * `mark_dead` (`:141-162`) really is one `Map.delete`, an unlink and a `set` into `dead_strong`,
   * with no rehash anywhere. The cost is underneath it, in the JS `Map` primitive.
   *
   * It has already cost this project real milliseconds once, in a different file: a handler
   * invocation saves and restores the legacy `this`/`event`/`argN` globals
   * (`scripts.ts#callWithBothConventions`), the steady state of `this` is nil, and a nil write to a
   * Lua table IS a delete -- so every invocation inserted a key into `_G` and deleted it again.
   * At the ~17,000 globals `FrameXML.toc` defines that measured **~239 us per invocation**, against a
   * `lua_pcall` floor of 1.5 us. See that function for the full arc.
   *
   * So: this handle table is the other large `Map` on a hot path in this codebase, and the sentinel
   * below is what keeps it out of that regime. Do not "tidy" it into a delete.
   */
  private freeSlot(slot: number): void {
    lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, this.slotsRef);
    lua.lua_pushboolean(this.L, false);
    lua.lua_rawseti(this.L, -2, slot);
    lua.lua_pop(this.L, 1);
    this.freeSlots.push(slot);
  }

  /** Pushes the value a `LuaRef` points at onto the stack. */
  private pushRef(ref: LuaRef): void {
    lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, this.slotsRef);
    lua.lua_rawgeti(this.L, -1, unbox(ref));
    // Overwrite the handle table with the value it yielded, so only the value is left.
    lua.lua_replace(this.L, -2);
  }

}
