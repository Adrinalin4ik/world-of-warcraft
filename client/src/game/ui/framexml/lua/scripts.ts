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
import { MethodContext, MethodTable, registerMethods } from './object';

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

const warnedHandlerNames = new Set<string>();

/** Warns (once per name) rather than throwing: rule 3 -- an unknown handler name is not an error. */
function checkHandlerName(name: string, where: string): void {
  if (SCRIPT_HANDLERS.has(name) || warnedHandlerNames.has(name)) {
    return;
  }
  warnedHandlerNames.add(name);
  console.warn(`${where}: unknown script handler '${name}'`);
}

/** Every frame's stored handlers, by frame id then handler name. Holds OWNED handles only. */
const handlersByFrame = new Map<number, Map<string, LuaRef>>();

/**
 * Stores (or, with `handler` null, clears) `self`'s handler for `name`, releasing whatever handle was
 * there before. `handler` must already be an OWNED handle -- `SetScript` below retains its argument
 * before calling this; `compileScriptHandler`'s result is already owned (it was just loaded, never
 * borrowed from a call boundary), so the loader (Task 7) can pass it straight through.
 */
export function setScriptHandler(vm: LuaVM, self: number, name: string, handler: LuaRef | null): void {
  let byName = handlersByFrame.get(self);
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
    handlersByFrame.set(self, byName);
  }
  byName.set(name, handler);
}

/** The handle `self` has stored for `name`, or null if nothing is set. Never releases or retains it. */
export function getScriptHandler(self: number, name: string): LuaRef | null {
  return handlersByFrame.get(self)?.get(name) ?? null;
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
  const source = `return function(self, ...)\n${body}\nend`;
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
 * THE calling convention, in one place. Sets the legacy globals, calls positionally as
 * `(self, ...args)`, and restores the previous globals afterwards no matter how the call came back --
 * a handler that itself fires another handler (directly, or via `invokeScriptHandler` again) must see
 * its own `this`/`event`/`argN` again once the nested call returns.
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
  const handler = getScriptHandler(self, name);
  if (handler === null) {
    return null;
  }
  return callWithBothConventions(ctx.vm, handler, ctx.wrapper(self), args);
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
      return [];
    }
    if (!ctx.vm.isRef(handler)) {
      throw new Error(`SetScript: the handler for '${name}' must be a function or nil`);
    }
    setScriptHandler(ctx.vm, self, name, ctx.retain(handler));
    return [];
  },

  GetScript: (ctx, self, args) => {
    const name = String(args[0] ?? '');
    const handler = getScriptHandler(self, name);
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
