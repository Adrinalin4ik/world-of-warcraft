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
 * are kept on the Lua side and handed out as `LuaRef` -- an index into the registry table
 * (`LUA_REGISTRYINDEX`), which is itself just a Lua table fengari never garbage-collects out from
 * under us. `newTable`/`setTableField`/`setMetatable` exist because Task 2 (frame wrapper tables with
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

/** A Lua state, typed just widely enough for what this file calls on it. */
type LuaState = unknown;

export class LuaVM {
  private readonly L: LuaState;

  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
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
   * This exists because the registry is the one thing here that JS garbage collection cannot help
   * with: `luaL_ref` stores the value in a table that is a GC root by definition, so an unreleased
   * handle pins its value forever. `toJs` mints a fresh handle for EVERY table or function that
   * crosses the boundary -- including every frame passed as an argument to a widget method -- so
   * without this the registry would grow with each such call, not just with each object.
   *
   * A released handle must not be used again; it is not an error the VM can detect, because the
   * slot may already have been handed to a different value.
   */
  unref(ref: LuaRef): void {
    lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, unbox(ref));
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

  /** Stores the value on top of the stack in the registry and returns a handle to it. Pops the stack. */
  private ref(): LuaRef {
    return box(lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX));
  }

  /** Pushes the value a `LuaRef` points at onto the stack. */
  private pushRef(ref: LuaRef): void {
    lua.lua_rawgeti(this.L, lua.LUA_REGISTRYINDEX, unbox(ref));
  }

}
