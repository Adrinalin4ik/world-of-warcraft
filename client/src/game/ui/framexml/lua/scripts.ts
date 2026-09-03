/**
 * `SetScript`/`GetScript`, and the one calling convention every handler in the whole runtime is
 * invoked under.
 *
 * 3.3.5's FrameXML and addon code mix two idioms for reading a script call's arguments, and BOTH have
 * to work on every single call, not just the modern one:
 *
 *   function(self, event, ...)      -- reads the frame and its arguments positionally
 *   function()                      -- reads `this`, `event`, `arg1`..`argN` off the globals instead
 *
 * so `invokeScriptHandler` -- the one entry point everything else in this file, and Task 6's events
 * and Task 7's loader, calls a handler through -- always does both: it sets the legacy globals AND
 * passes the same values positionally, then restores whatever `this`/`event`/`argN` held before the
 * call, even if the handler errored. That restore is what makes a handler that fires another handler
 * (a `<OnClick>` that calls `:Click()` on something else, say) safe -- without it, the inner call's
 * globals would still be sitting there when the outer handler's own code runs after the nested call
 * returns.
 *
 * `event` gets the same value as `arg1`, not the frame's own `event` field: this is not a mistake
 * inherited from the OnEvent case, it is a generalization of it. The pre-2.0 calling convention Blizzard
 * kept for backward compatibility set `event` to whatever the first positional argument was for EVERY
 * script (an `OnClick` handler and an `OnEvent` handler read `event` the same way), because `OnEvent`
 * was the idiom the convention was named after.
 */
import { LuaRef, LuaVM, LuaError } from './vm';
import { MethodContext, MethodTable, onFrameTeardown, registerMethods } from './object';
import { Widget } from '../../widget';

/**
 * The fixed list `SetScript` and `<Scripts>` compilation validate a handler name against. Widening
 * this is always safe (a name missing here only downgrades from silent-and-working to
 * warned-and-working); real 3.3.5 FrameXML never invents new ones, so this is not expected to grow.
 */
export const SCRIPT_HANDLERS: ReadonlySet<string> = new Set([
  'OnLoad',
  'OnEvent',
  'OnUpdate',
  'OnShow',
  'OnHide',
  'OnEnter',
  'OnLeave',
  'OnClick',
  // THE CLICK TRIPLE. A Button's click fires `PreClick`, then `OnClick`, then `PostClick`, and the two
  // outer ones are as real as the middle one. Grepped across the 264 files this manifest loads:
  // `<PostClick>` in `actionbarframe.xml:15-17` (`ActionButton_UpdateState(self, button, down)` -- what
  // re-checks the auto-attack button's checked state after a click) and in
  // `multicastactionbarframe.xml:65-67`; `<PreClick>` in `petactionbarframe.xml:45-47` and
  // `spellbookframe.xml:150-152`. NOT on `SecureActionButtonTemplate`, which declares only `<OnClick>`.
  // Both names were absent here, so loading the action bar printed "unknown script handler 'PostClick'"
  // and the handler never ran. See `CLICK_SEQUENCE` for how one pointer click reaches all three.
  'PreClick',
  'PostClick',
  // Real in 3.3.5 and used by the manifest this runtime loads -- `RealmListRealmButtonTemplate`'s
  // `<OnDoubleClick>` joins the realm its `<OnClick>` just selected (realmlist.xml:234). It was missing
  // here, so loading RealmList.xml printed an "unknown script handler" line for a handler that both the
  // client and `Widget#onDoubleClick` support.
  'OnDoubleClick',
  'OnMouseDown',
  'OnMouseUp',
  'OnMouseWheel',
  'OnDragStart',
  'OnDragStop',
  'OnReceiveDrag',
  'OnEnable',
  'OnDisable',
  'OnValueChanged',
  'OnTextChanged',
  'OnEnterPressed',
  'OnEscapePressed',
  'OnTabPressed',
  'OnEditFocusGained',
  'OnEditFocusLost',
  'OnCursorChanged',
  'OnChar',
  'OnKeyDown',
  'OnKeyUp',
  'OnHyperlinkClick',
  'OnHyperlinkEnter',
  'OnHyperlinkLeave',
  'OnScrollRangeChanged',
  'OnVerticalScroll',
  'OnHorizontalScroll',
  'OnSizeChanged',
  'OnAttributeChanged',
  'OnAnimFinished',
  'OnUpdateModel',
  'OnModelLoaded',
  'OnTooltipAddMoney',
  'OnTooltipCleared',
  'OnTooltipSetDefaultAnchor',
  'OnTooltipSetItem',
  'OnTooltipSetSpell',
  'OnTooltipSetUnit',
]);

/**
 * THE PARAMETER LIST EACH HANDLER'S BODY IS COMPILED WITH -- the engine's, per handler name.
 *
 * Compiling every body as `function(self, ...)` was the gap §5.4 of the task-9 report names, and it is
 * not cosmetic: real FrameXML bodies read these as NAMED PARAMETERS, and the one that proved it is
 * `gluedialog.xml:167`
 *
 *     <OnEvent>GlueDialog_OnEvent(self, event, ...);</OnEvent>
 *
 * `fireEvent` passes `[eventName, ...eventArgs]` positionally, which is exactly right for the engine's
 * `OnEvent(self, event, ...)` shape -- but with no `event` parameter to absorb the first one, the body's
 * `...` began with the event NAME, so `GlueDialog_OnEvent` received `arg1 = "OPEN_STATUS_DIALOG"` and
 * `arg2 = "CANCEL"`, one slot late, and `GlueDialogTypes[arg1]` was nil. That is why the connecting
 * dialog never appeared even once something fired the event (traced live: `scratchpad/dialog3.js`).
 *
 * `...` is appended after the named list in every case, so a body may still read varargs and a call with
 * more arguments than the list names cannot error. A name absent from this table keeps the old
 * `(self, ...)`, which is right for the majority (`OnShow`, `OnEnterPressed`, ...) that take nothing.
 *
 * The lists are the 3.3.5 API's, not invented: `OnClick`'s second parameter is the `AnyDown` flag, which
 * only a `RegisterForClicks` frame ever sees; `OnTextChanged` takes nothing in 3.3.5 (the `isUserInput`
 * argument is a later expansion).
 */
const SCRIPT_PARAMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['OnEvent', ['event']],
  ['OnUpdate', ['elapsed']],
  ['OnEnter', ['motion']],
  ['OnLeave', ['motion']],
  ['OnClick', ['button', 'down']],
  // The engine passes a `PreClick`/`PostClick` body the same two arguments it passes `OnClick`, and
  // `actionbarframe.xml:16` reads both by name (`ActionButton_UpdateState(self, button, down)`).
  ['PreClick', ['button', 'down']],
  ['PostClick', ['button', 'down']],
  ['OnDoubleClick', ['button']],
  ['OnMouseDown', ['button']],
  ['OnMouseUp', ['button']],
  // `spellbookframe.xml:167` reads it by name: `SpellButton_OnDrag(self, button)`.
  ['OnDragStart', ['button']],
  ['OnMouseWheel', ['delta']],
  ['OnValueChanged', ['value']],
  // `gametooltiptemplate.xml:248-250` reads BOTH by name:
  // `GameTooltip_OnTooltipAddMoney(self, cost, maxcost)`. Without the names that body sees two nils
  // and `SetTooltipMoney` is handed a nil money, so the coins never appear.
  ['OnTooltipAddMoney', ['cost', 'maxcost']],
  ['OnChar', ['text']],
  ['OnKeyDown', ['key']],
  ['OnKeyUp', ['key']],
  ['OnCursorChanged', ['x', 'y', 'width', 'height']],
  ['OnScrollRangeChanged', ['xrange', 'yrange']],
  ['OnVerticalScroll', ['offset']],
  ['OnHorizontalScroll', ['offset']],
  ['OnSizeChanged', ['width', 'height']],
  ['OnAttributeChanged', ['name', 'value']],
  ['OnHyperlinkClick', ['link', 'text', 'button']],
  ['OnHyperlinkEnter', ['link', 'text']],
  ['OnHyperlinkLeave', ['link', 'text']],
]);

const warnedHandlerNames = new Set<string>();

/** Warns (once per name) rather than throwing: rule 3 -- an unknown handler name is not an error. */
function checkHandlerName(name: string, where: string): void {
  if (SCRIPT_HANDLERS.has(name) || warnedHandlerNames.has(name)) {
    return;
  }
  warnedHandlerNames.add(name);
  console.warn(`${where}: unknown script handler '${name}'`);
}

/**
 * Every frame's stored handlers, by frame id then handler name. Holds OWNED handles only.
 *
 * **PER VM, and that is the whole of a "the handler is registered and never dispatches" class of bug.**
 * A `LuaRef` is an index into ONE `LuaVM`'s handle table (`vm.ts`, and see `CLAUDE.md` on why those
 * handles index our own table rather than fengari's registry). Frame ids restart at 1 for every new
 * `FrameRegistry`, so a module-level map keyed by frame id let a SECOND runtime's frame 1 find the FIRST
 * runtime's handle -- and then, worse, `setScriptHandler` below released it: `vm.unref(existing)` with
 * the new VM against the old VM's index frees whatever the NEW VM happens to hold at that slot. Both
 * runtimes load the same documents in the same order, so the slot it frees is very often the handler
 * that same call is about to store, and a freed slot holds the free-list sentinel -- a TABLE. So the
 * handler was stored, `GetScript` answered non-nil, the dispatch happened, and Lua said "attempt to call
 * a table value" into `reportScriptError`.
 *
 * This is not hypothetical and it is not test-only: the world UI host is documented to mount twice with
 * one copy disposed, and a disposed VM's frames are dropped rather than torn down, so its entries stay.
 * MEASURED in `__tests__/scroll-range.test.ts` before this change: `reconcileScrollRanges` computed the
 * right range (776), the entry differed from the last announced, `invokeScriptHandler` was called, and it
 * returned `attempt to call a table value` -- the same "live and inert" shape as three other fixes in
 * flight. Same defect family as `methods/scroll.ts#thumbTextures`, which was keyed by frame id too.
 *
 * A `WeakMap` on the VM, so a disposed runtime's whole store goes with it and nothing here pins a VM.
 */
/**
 * **HOW MANY TIMES DID WE ENTER LUA THIS FRAME?** -- the integer that closes, or refuses to close, a
 * 10x gap.
 *
 * The owner's census reports `actionButtons 8` and `actionButtonMs 1.91`, which reads as 237 us to
 * service one button. The harness prices one invocation of a realistic handler at 23.11 us
 * (`__bench__/script-call.test.ts`), so 8 x 23.11 us = 0.18 ms -- a **10x** shortfall against 1.91.
 *
 * `actionButtons` counts BUTTONS, not invocations, and those are not the same number: a handler body
 * that calls a client function which fires another frame's handler enters Lua again, and the tick's
 * outer loop cannot see it. So either the real invocation count is many times eight -- in which case
 * the per-call price is right and the count was the error -- or it is eight and the live VM's
 * per-call cost genuinely exceeds the harness's. **One counter separates those, and no amount of
 * reading does.**
 *
 * Counted in `invokeScriptHandler`, which `scripts.ts:346-350` already documents as the ONE
 * invocation entry point -- so this is a complete count by construction rather than by a survey of
 * call sites. Incremented only when a handler actually exists and will be called, because a miss
 * costs a `Map` lookup and is not an entry into Lua.
 *
 * One integer add on a path already doing a `pcall` and nine global round-trips.
 */
export const invokeCensus = { calls: 0 };

const handlerStores = new WeakMap<LuaVM, Map<number, Map<string, LuaRef>>>();

/** `vm`'s own frame-id -> handler-name -> handle store, created on first use. */
function handlersOf(vm: LuaVM): Map<number, Map<string, LuaRef>> {
  let store = handlerStores.get(vm);
  if (store === undefined) {
    store = new Map();
    handlerStores.set(vm, store);
  }
  return store;
}

/**
 * The teardown half of the map above: a released frame's handlers are the LARGEST thing this runtime
 * pins per screen -- one owned registry handle per `<Scripts>` child, and `AccountLogin.xml` alone
 * declares dozens. Nothing cleared them before, so a screen rebuilt on every session-state change
 * pinned a fresh set each time.
 */
onFrameTeardown((ctx, id) => {
  const byName = handlersOf(ctx.vm).get(id);
  if (byName === undefined) {
    return;
  }
  for (const handler of byName.values()) {
    ctx.vm.unref(handler);
  }
  handlersOf(ctx.vm).delete(id);
});

/**
 * Stores (or, with `handler` null, clears) `self`'s handler for `name`, releasing whatever handle was
 * there before. `handler` must already be an OWNED handle -- `SetScript` below retains its argument
 * before calling this; `compileScriptHandler`'s result is already owned (it was just loaded, never
 * borrowed from a call boundary), so the loader (Task 7) can pass it straight through.
 */
export function setScriptHandler(vm: LuaVM, self: number, name: string, handler: LuaRef | null): void {
  const store = handlersOf(vm);
  let byName = store.get(self);
  const existing = byName?.get(name);
  if (existing !== undefined) {
    vm.unref(existing);
  }
  if (handler === null) {
    byName?.delete(name);
    return;
  }
  if (byName === undefined) {
    byName = new Map();
    store.set(self, byName);
  }
  byName.set(name, handler);
}

/** The handle `self` has stored for `name`, or null if nothing is set. Never releases or retains it. */
export function getScriptHandler(vm: LuaVM, self: number, name: string): LuaRef | null {
  return handlerStores.get(vm)?.get(self)?.get(name) ?? null;
}

/**
 * Compiles a `<Scripts>` child's body into a callable handler (rule 1), or resolves the `function="..."`
 * fallback when the body is empty (rule 5). Returns null -- with a warning, not a thrown error, so one
 * bad handler does not take out the whole document -- if neither produces a function.
 *
 * The returned handle is OWNED: pass it straight to `setScriptHandler`, don't `retain` it again.
 */
export function compileScriptHandler(
  vm: LuaVM,
  handlerName: string,
  body: string,
  functionAttr: string | null,
  fileName: string,
): LuaRef | null {
  checkHandlerName(handlerName, `<Scripts> in ${fileName}`);

  const trimmedBody = body.trim();
  if (trimmedBody === '') {
    if (functionAttr === null || functionAttr.trim() === '') {
      return null;
    }
    const global = vm.getGlobal(functionAttr);
    if (!vm.isRef(global)) {
      console.warn(
        `<Scripts> in ${fileName}: function="${functionAttr}" for ${handlerName} is not a defined global`,
      );
      return null;
    }
    return global;
  }

  const chunkName = `${fileName}:${handlerName}`;
  // The engine's parameter list for this handler, then `...` -- see `SCRIPT_PARAMS`.
  const named = SCRIPT_PARAMS.get(handlerName) ?? [];
  const parameters = ['self', ...named, '...'].join(', ');
  const source = `return function(${parameters})\n${body}\nend`;
  const result = vm.runExpr(source, chunkName);
  if ('message' in result) {
    console.warn(`${chunkName}: failed to compile: ${result.message}`);
    return null;
  }
  if (!vm.isRef(result.value)) {
    console.warn(`${chunkName}: did not compile to a function`);
    return null;
  }
  return result.value;
}

/**
 * Errors raised by a handler this runtime fired from JS rather than from the loader.
 *
 * The loader owns a `LoadReport` and pushes an `OnLoad` failure straight into it. A handler fired from
 * a WIDGET METHOD -- `Show()`'s `OnShow` cascade, in `methods/region.ts` -- has no report in reach and
 * must not throw either: the engine routes a script error to the error handler and lets the call that
 * triggered it return, so re-raising out of `Show` would abort whatever piece of the client's Lua
 * happened to be showing a frame. So the message is queued here and `runtime.ts` drains it into the
 * load report after the boot sequence, which is the one place these are worth reading.
 *
 * Console too, immediately: a cascade fired long after the load report was printed (a dialog opening
 * ten minutes in) would otherwise sit in this list unread.
 */
const pendingScriptErrors: string[] = [];

/** Records a handler failure. `where` should name the frame and the handler. */
export function reportScriptError(where: string, message: string): void {
  const line = `${where}: ${message}`;
  pendingScriptErrors.push(line);
  console.error(`framexml: ${line}`);
}

/** Takes and clears the queued handler failures. `runtime.ts` calls this once per boot. */
export function drainScriptErrors(): string[] {
  return pendingScriptErrors.splice(0, pendingScriptErrors.length);
}

/**
 * THE calling convention, in one place. Sets the legacy globals, calls positionally as
 * `(self, ...args)`, and restores the previous globals afterwards no matter how the call came back --
 * a handler that itself fires another handler (directly, or via `invokeScriptHandler` again) must see
 * its own `this`/`event`/`argN` again once the nested call returns.
 */
/**
 * **THIS FUNCTION IS O(THE SIZE OF THE GLOBALS TABLE), AND THAT IS THE WHOLE OF `actionButtonMs`.**
 *
 * MEASURED (`__bench__/script-call.test.ts`), one VM, one handler, growing only `_G`:
 *
 * | globals | per invocation |
 * |---------|----------------|
 * |       0 |      18.74 us  |
 * |   2,000 |      34.21 us  |
 * |   6,000 |      93.86 us  |
 * |  12,000 |     175.29 us  |
 *
 * Linear, at about **13 us per thousand globals**, against a `vm.call` floor of **1.5-2.4 us**. So a
 * handler invocation in a bare harness costs ~20 us and the same invocation with `FrameXML.toc`
 * loaded costs an order of magnitude more -- which is exactly the 10x that survived a correct
 * per-call measurement, and it is why the harness structurally under-reports this path.
 *
 * ## The mechanism, corrected -- an earlier version of this comment named the wrong layer
 *
 * It is the nine `lua_getglobal`/`lua_setglobal` round-trips below (`this`, `event` and `arg1` each
 * saved, set and restored), and specifically the **nil** ones. That much is measured three ways:
 *
 *  - at a FIXED 12,000-entry `_G`, cost scales with the round-trip count: **0 trips 2.29 us,
 *    3 trips 8.37 us, 9 trips 19.91 us**. So the write path is the multiplier, not the environment.
 *  - a plain get+set pair is **size-INDEPENDENT**: 4.52 us at a bare `_G`, 4.32 us at 12,000.
 *  - a set followed by a NIL set is not: **6.60 us bare, 75.25 us at 12,000**, an 11x.
 *
 * `vm.ts#ref` records that writing nil to a fengari key DELETES it, and that is true -- but the
 * earlier claim here that the next insert then "rehashes the whole thing" inside fengari is **wrong
 * and is withdrawn**. `luaH_setfrom` (`node_modules/fengari/src/ltable.js:209-212`) calls
 * `mark_dead`, and `mark_dead` (`:141-162`) is one `Map.delete`, a linked-list unlink and a `set`
 * into `dead_strong` -- O(1), no rehash. `add` (`:118`) does open with `dead_strong.clear()`, but
 * that map only holds keys killed since the last insert, which here is at most three.
 *
 * The linear term is one layer further down, in **V8's `Map`**, and it was isolated with no Lua in
 * the picture at all -- a bare JS `Map` of N entries, timing one key:
 *
 * | entries | set+delete | set+get |
 * |---------|------------|---------|
 * |       0 |   0.12 us  | 0.02 us |
 * |   2,000 |   4.20 us  | 0.02 us |
 * |   6,000 |  20.43 us  | 0.01 us |
 * |  12,000 |  40.81 us  | 0.02 us |
 *
 * Overwriting an existing key is flat; **deleting and re-inserting one forces V8 to compact the
 * backing store, which is O(capacity)**. So the cost is not that fengari rehashes -- it is that the
 * delete/re-insert CYCLE makes V8 rehash, repeatedly, on a table the size of `_G`.
 *
 * The steady state of `this` is nil, so every invocation inserts the key and the restore deletes it
 * again: one full churn per legacy global per call, on a 17,000-entry `_G`. Three of them is the
 * ~239 us the owner measures.
 *
 * It also explains what the leak fix did not: `ui.tick` reading 1.6, 3.4, 4.8, 5.6, 6.6, 9.7 ms
 * across the owner's samples. That is not a leak and not "state" -- **the globals table GROWS as the
 * manifest and its panels initialise**, and every handler invocation in the client gets more
 * expensive as it does.
 *
 * **THE FIX THEREFORE IS TO STOP DELETING KEYS FROM `_G`, not to reduce the round-trip count.** An
 * overwrite is already free; only the nil write is not.
 *
 * ## What is NOT available: "delete once per outermost invocation instead of once per call"
 *
 * It sounds like it should divide the cost by the number of invocations, and it does nothing,
 * because **this function already behaves that way and gets it for free.** The restore writes back
 * the SAVED value. A nested invocation saves the enclosing handler's wrapper, which is non-nil, so
 * its restore is an overwrite and never a delete; only an invocation whose saved value was nil --
 * the outermost one -- deletes. A depth counter would gate a case that is already gated.
 *
 * MEASURED, eight entries into Lua at a fixed 12,000-entry `_G`
 * (`__bench__/script-call.test.ts`):
 *
 *  - eight SEQUENTIAL top-level invocations: 1245.7 us, **155.7 us each**
 *  - one top-level invocation NESTING seven:  289.7 us, **36.2 us each**
 *
 * 4.3x cheaper per entry, which is the deferral already working. The tick's eight action buttons are
 * eight sequential top-level invocations, not a nest -- there is no enclosing invocation to defer
 * into, so each is outermost and each deletes, and no depth counter can merge them.
 *
 * ## Not clearing at all is settled AGAINST, by the reference
 *
 * `benilla-ui/src/script/event.rs:264-306` restores the SAVED value, which at the outermost
 * invocation is nil -- so **the reference clears too**. Leaving the legacy globals set between
 * top-level invocations is not a faithful port waiting on a fact about 3.3.5a; it is a deviation
 * from the only authority we have on mechanism. That also closes the per-frame-flush variant, whose
 * failure mode when someone forgets the hook is exactly that deviation, reached by accident.
 *
 * ## THE FIX THAT IS LEFT, and it is measured: give the handler its own ENVIRONMENT
 *
 * The three legacy names do not have to live in `_G` at all. This is fengari (Lua 5.3), so a handler
 * compiled through `load(chunk, name, mode, env)` carries its own `_ENV` upvalue: a three-entry
 * table holding `this`/`event`/`argN` and chaining to `_G` via `__index`. The saves and sets then
 * write into a table with three keys -- **O(1), and no key is ever deleted from `_G`** -- while
 * `this` still resolves inside the handler exactly as today. The save-restore structure the
 * reference requires is untouched; only the table it writes to changes.
 *
 * The objection to doing this on `_G` itself was that `__index` would fire on every absent-global
 * read in the game. Confined to handler BODIES that population is small, and MEASURED it costs
 * nothing at all -- 10 global reads per call against a 12,000-entry `_G`, four runs:
 *
 *  - plain `_ENV = _G`:        4.09 - 4.20 us/call
 *  - chained 3-entry `_ENV`:   3.60 - 3.73 us/call
 *
 * The chained environment is consistently **FASTER**, by ~0.45 us per call, in the same direction
 * 4/4 with a within-arm spread of ~0.1 us. `__index = _G` is a table rather than a function, so the
 * miss resolves by a raw get and the three-entry probe that precedes it is free.
 *
 * The hazard is a WRITE, not a read: a handler assigning a new global would land in the environment
 * table and vanish from everyone else's view. A `__newindex` pass-through fixes it and is asserted
 * in the bench rather than assumed (`BenchWroteThrough` reaches `_G`).
 *
 * NOT BUILT YET -- the shape and these numbers went to the coordinator first.
 *
 * **DO NOT "FIX" THIS BY DROPPING THE SAVE-RESTORE.** The reference does exactly what this does and
 * says why: `samples/benilla/crates/benilla-ui/src/script/event.rs:264-306`,
 * "saving and restoring the globals around the call (even on error) so nested handler firing is
 * safe". Under mlua's real C Lua those writes are amortised O(1), so the reference pays nothing for
 * a structure that costs us everything. The structure is right; the global writes are the defect,
 * and the fix belongs in how `LuaVM` reaches a global -- not here.
 */
function callWithBothConventions(vm: LuaVM, handler: LuaRef, selfValue: unknown, args: unknown[]): LuaError | null {
  const previousThis = vm.getGlobal('this');
  const previousEvent = vm.getGlobal('event');
  const previousArgs = args.map((_, index) => vm.getGlobal(`arg${index + 1}`));

  vm.setGlobal('this', selfValue);
  vm.setGlobal('event', args[0]);
  args.forEach((arg, index) => vm.setGlobal(`arg${index + 1}`, arg));

  try {
    return vm.call(handler, [selfValue, ...args]);
  } finally {
    vm.setGlobal('this', previousThis);
    vm.setGlobal('event', previousEvent);
    previousArgs.forEach((value, index) => vm.setGlobal(`arg${index + 1}`, value));

    // **RELEASE THE SAVED HANDLES.** `getGlobal` goes through `toJs`, whose default branch mints a
    // registry slot for anything with no JS shape -- a table or a function (`vm.ts#toJs`) -- and only
    // an explicit `unref` gives it back. Nothing here released them, so every invocation that found a
    // TABLE in `this` leaked one slot, for ever.
    //
    // MEASURED at exactly **1.00 handle per call** (`__bench__/script-call.test.ts`), and `this` holds
    // a table on any NESTED invocation, which is the ordinary case: an outer handler sets `this` to
    // its own wrapper before calling a client function that fires another frame's handler. At the
    // per-frame tick's rate that is a leak at frame rate.
    //
    // AFTER the `setGlobal`s, never before: `setGlobal` pushes the value and stores it in the Lua
    // globals table, so Lua holds its own reference by then and freeing our slot cannot collect a
    // value the global still names.
    //
    // Why this matters beyond memory: slot allocation is O(1) here by design (`vm.ts#ref` exists
    // precisely because `luaL_ref` is O(live handles)), so a leak is not automatically slow -- but it
    // grows the fengari-side handle table without bound, and a growing handle table is what once
    // froze this interface for 10.1 s. `LuaVM#liveHandles` is censused so a regression is visible
    // rather than inferred.
    releaseSaved(vm, previousThis);
    releaseSaved(vm, previousEvent);
    previousArgs.forEach((value) => releaseSaved(vm, value));
  }
}

/** Frees a handle `getGlobal` minted for a table- or function-valued global. A no-op for the
 * scalars, which `toJs` maps to plain JS values and which own no slot. */
function releaseSaved(vm: LuaVM, value: unknown): void {
  if (vm.isRef(value)) {
    vm.unref(value);
  }
}

/**
 * The invocation entry point: Task 6 (events) and Task 7 (the loader, for every handler except
 * `OnLoad`, which it fires directly once it has captured it -- rule 2) call a frame's handler through
 * this and nothing else. Returns null with no effect if `self` has no handler stored for `name` --
 * that is the ordinary case for most handler names on most frames, not a bug to report.
 */
export function invokeScriptHandler(
  ctx: MethodContext,
  self: number,
  name: string,
  args: unknown[] = [],
): LuaError | null {
  const handler = getScriptHandler(ctx.vm, self, name);
  if (handler === null) {
    return null;
  }
  invokeCensus.calls += 1;
  return callWithBothConventions(ctx.vm, handler, ctx.wrapper(self), args);
}

/**
 * THE INPUT BRIDGE: the missing link between the router's JS callbacks and a frame's Lua handlers.
 *
 * `ui/input.ts` hit-tests, tracks a press, moves focus and edits text, and announces each of those
 * through a `Widget#onX` callback (`widget.ts`). Nothing set those callbacks for an XML-loaded frame, so
 * a document whose `<Scripts>` declared `OnClick` rendered perfectly and did nothing at all -- the gap
 * §5.5 of the task-9 report names.
 *
 * BOUND FROM `SetScript`, and that placement is the decision here. `SetScript` is the ONE door a handler
 * enters by: the XML loader installs every `<Scripts>` child through it (`loader.ts#applyScripts` calls
 * the Lua method, not `setScriptHandler` directly), and so does every line of the client's own Lua. So
 * binding here covers both, needs no second pass over the tree, and stays exact -- a frame gets a JS
 * callback for precisely the handlers it has, and clearing a handler clears the callback with it. The
 * alternative, binding all of them on every frame at materialize time, would give 292 frames ten
 * closures each and still miss anything wired from Lua after the load.
 *
 * The callback fires the handler BY NAME through `invokeScriptHandler`, never by holding the handle: a
 * `SetScript` that replaces the handler afterwards has to take effect, which is the same reason
 * `loader.ts` fires `OnLoad` by slot.
 *
 * WHAT A HANDLER IS PASSED. The engine hands `OnClick` the mouse button (`"LeftButton"`), and both
 * `accountlogin.lua` and `realmlist.lua` ignore it -- but it is passed anyway, because an addon will not,
 * and because `scripts.ts`'s legacy convention makes it `arg1` and `event` as well. `OnMouseDown`/`OnMouseUp`
 * take the same argument. Everything else in 3.3.5 takes nothing that the router knows.
 *
 * A body that reads `button` as a NAMED PARAMETER now gets it: `SCRIPT_PARAMS` above compiles each
 * handler with the engine's own parameter list, so `<OnClick>` is `function(self, button, down, ...)`.
 * The legacy `arg1`/`event` globals are still set for the same call, which is what the pre-2.0
 * convention every glue handler in this manifest is actually written against.
 */
type CallbackBinder = (widget: Widget, fire: ((args?: unknown[]) => void) | null) => void;

/** The mouse button the engine reports for a left click, which is the only one this router routes. */
/**
 * The button an `OnClick`/`OnMouseDown`/`OnMouseUp`/`OnDoubleClick` handler receives is now the REAL one
 * -- `Widget#onClick` takes it from `ui/input.ts` and these binders pass it straight on.
 *
 * It used to be this constant, unconditionally, and that is what stopped anything being equipped: a
 * right-click on a bag slot ran `ContainerFrameItemButton_OnClick`'s LEFT branch. See
 * `Widget#clickButtons`.
 *
 * `OnDragStart` keeps a constant, and deliberately: `ui/input.ts#maybeBeginDrag` has no button of its
 * own to report and `RegisterForDrag` is stored as a boolean for the reason `Widget#dragRegistered`
 * gives.
 */
const LEFT_BUTTON = 'LeftButton';

/**
 * The engine's click order on a Button, in one place: `PreClick`, `OnClick`, `PostClick`.
 *
 * `Widget#onClick` is ONE callback, so all three names bind that same slot and the callback fires
 * whichever of them the frame actually has, in this order -- which is why `bindInputCallback` cannot
 * simply clear the slot when the name it was called for has no handler (a frame with a `PostClick` and
 * no `OnClick` still has to be clickable; `ActionBarButtonTemplate` has both, inherited from two
 * different templates, and they are installed by separate `SetScript` calls).
 */
const CLICK_SEQUENCE = ['PreClick', 'OnClick', 'PostClick'] as const;

const CALLBACK_BINDERS = new Map<string, CallbackBinder>([
  ['OnClick', (w, f) => { w.onClick = f === null ? null : (button) => f([button]); }],
  ['PreClick', (w, f) => { w.onClick = f === null ? null : (button) => f([button]); }],
  ['PostClick', (w, f) => { w.onClick = f === null ? null : (button) => f([button]); }],
  ['OnDoubleClick', (w, f) => { w.onDoubleClick = f === null ? null : (button) => f([button]); }],
  ['OnMouseDown', (w, f) => { w.onMouseDown = f === null ? null : (button) => f([button]); }],
  ['OnMouseUp', (w, f) => { w.onMouseUp = f === null ? null : (button) => f([button]); }],
  // `delta` is a NAMED parameter (`:134` binds it) -- `chatframe.xml` and `uipaneltemplates.xml` both
  // read it by name, so it must be passed positionally here.
  ['OnMouseWheel', (w, f) => { w.onMouseWheel = f === null ? null : (delta) => f([delta]); }],
  // `link`, `text` and `button` are NAMED parameters (`:149` binds them) and `chatframe.xml:15-17`
  // reads all three by name, so they must be passed positionally in that order.
  ['OnHyperlinkClick', (w, f) => {
    w.onHyperlinkClick = f === null
      ? null
      : (link, text, button) => f([link, text, button]);
  }],
  ['OnEnter', (w, f) => { w.onEnter = f === null ? null : () => f(); }],
  ['OnLeave', (w, f) => { w.onLeave = f === null ? null : () => f(); }],
  ['OnEnterPressed', (w, f) => { w.onSubmit = f === null ? null : () => f(); }],
  ['OnEscapePressed', (w, f) => { w.onCancel = f === null ? null : () => f(); }],
  ['OnTabPressed', (w, f) => { w.onTabPressed = f === null ? null : () => f(); }],
  ['OnTextChanged', (w, f) => { w.onTextChanged = f === null ? null : () => f(); }],
  ['OnEditFocusGained', (w, f) => { w.onEditFocusGained = f === null ? null : () => f(); }],
  ['OnEditFocusLost', (w, f) => { w.onEditFocusLost = f === null ? null : () => f(); }],
  // THE DRAG GESTURE. `OnDragStart` takes the button as a named parameter -- `spellbookframe.xml:167` is
  // `SpellButton_OnDrag(self, button)` -- so it gets `LEFT_BUTTON` like the click handlers, and for the
  // same reason: the router accepts any pointer button and always reports it as the left one.
  // `OnDragStop` and `OnReceiveDrag` take none in 3.3.5a.
  ['OnDragStart', (w, f) => { w.onDragStart = f === null ? null : () => f([LEFT_BUTTON]); }],
  ['OnDragStop', (w, f) => { w.onDragStop = f === null ? null : () => f(); }],
  ['OnReceiveDrag', (w, f) => { w.onReceiveDrag = f === null ? null : () => f(); }],
]);

/**
 * Fires `self`'s handler for `name` and reports a failure instead of raising.
 *
 * A handler reached from a POINTER EVENT has no report in reach and nothing above it that could
 * meaningfully catch: the stack is a DOM listener. So it goes the same way `Show`'s `OnShow` cascade
 * does -- `reportScriptError`, console immediately and queued for the load report -- because one broken
 * `OnClick` must not take out the event loop's listener.
 */
function fireFromInput(ctx: MethodContext, self: number, name: string, args: unknown[]): void {
  const error = invokeScriptHandler(ctx, self, name, args);
  if (error !== null) {
    reportScriptError(`${ctx.registry.nameOf(self) ?? `frame ${self}`}: ${name}`, error.message);
  }
}

/**
 * Points (or unpoints) the frame's `Widget` callback for `name` at its Lua handler. Called from
 * `SetScript` for every name, and a no-op for the ones the router cannot observe.
 */
function bindInputCallback(ctx: MethodContext, self: number, name: string): void {
  const binder = CALLBACK_BINDERS.get(name);
  if (binder === undefined) {
    return;
  }
  const widget = ctx.registry.widget(self);
  if (widget === null) {
    return;
  }
  // A CLICK is three handler names sharing one callback slot (see `CLICK_SEQUENCE`): the slot stays
  // bound while ANY of them is set, and one click fires each that exists, in the engine's order.
  const clickNames = (CLICK_SEQUENCE as readonly string[]).includes(name)
    ? CLICK_SEQUENCE
    : null;
  if (clickNames !== null) {
    const present = clickNames.filter((handler) => getScriptHandler(ctx.vm, self, handler) !== null);
    if (present.length === 0) {
      binder(widget, null);
      return;
    }
    binder(widget, (args = []) => {
      // Re-read the handler set at CLICK time, not at bind time, so a `SetScript` between the two takes
      // effect -- the same rule the single-handler path relies on by firing through `invokeScriptHandler`.
      for (const handler of clickNames) {
        if (getScriptHandler(ctx.vm, self, handler) !== null) {
          fireFromInput(ctx, self, handler, args);
        }
      }
    });
    return;
  }
  if (getScriptHandler(ctx.vm, self, name) === null) {
    binder(widget, null);
    return;
  }
  binder(widget, (args = []) => fireFromInput(ctx, self, name, args));
}

const SCRIPT_METHODS: MethodTable = {
  // SetScript(name, handler). `handler` nil/omitted clears it. The retain here is the rule this file
  // was built around: `args[1]` is a BORROWED handle, released the moment this method returns, so
  // storing it bare would leave the handler pointing at whatever the next call happens to hand that
  // registry slot to.
  SetScript: (ctx, self, args) => {
    const name = String(args[0] ?? '');
    checkHandlerName(name, 'SetScript');

    const handler = args[1];
    if (handler === undefined || handler === null) {
      setScriptHandler(ctx.vm, self, name, null);
      // Clearing a handler clears the router callback with it, or a widget would keep firing into a
      // slot nothing answers -- harmless today (`invokeScriptHandler` returns null for a missing
      // handler) and a lie the moment anything asks whether the widget is interactive.
      bindInputCallback(ctx, self, name);
      return [];
    }
    if (!ctx.vm.isRef(handler)) {
      throw new Error(`SetScript: the handler for '${name}' must be a function or nil`);
    }
    setScriptHandler(ctx.vm, self, name, ctx.retain(handler));
    // THE INPUT BRIDGE (see `bindInputCallback`): this is what makes a pointer or a keystroke reach the
    // handler that was just stored, and the reason it is here is that `SetScript` is the one door.
    bindInputCallback(ctx, self, name);
    return [];
  },

  GetScript: (ctx, self, args) => {
    const name = String(args[0] ?? '');
    const handler = getScriptHandler(ctx.vm, self, name);
    if (handler === null) {
      return [null];
    }
    // Not the stored handle itself: `SetScript`/module storage owns that one and will `unref` it on
    // replacement or clear, and a plain `dup` minted a SECOND handle with no owner -- pinned in the
    // registry forever, since nothing on the return path ever frees it. `transfer` marks that second
    // handle for exactly one push: the boundary frees its slot the instant Lua has its own reference,
    // so this leaks nothing while still giving the caller (`local old = self:GetScript(...)`, the
    // standard "wrap the existing handler" idiom) a handle that survives the original being replaced.
    return [ctx.vm.transfer(ctx.vm.dup(handler))];
  },
};

registerMethods('FRAME', SCRIPT_METHODS);
