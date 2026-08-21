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

/** Every frame's stored handlers, by frame id then handler name. Holds OWNED handles only. */
const handlersByFrame = new Map<number, Map<string, LuaRef>>();

/**
 * The teardown half of the map above: a released frame's handlers are the LARGEST thing this runtime
 * pins per screen -- one owned registry handle per `<Scripts>` child, and `AccountLogin.xml` alone
 * declares dozens. Nothing cleared them before, so a screen rebuilt on every session-state change
 * pinned a fresh set each time.
 */
onFrameTeardown((ctx, id) => {
  const byName = handlersByFrame.get(id);
  if (byName === undefined) {
    return;
  }
  for (const handler of byName.values()) {
    ctx.vm.unref(handler);
  }
  handlersByFrame.delete(id);
});

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
    const present = clickNames.filter((handler) => getScriptHandler(self, handler) !== null);
    if (present.length === 0) {
      binder(widget, null);
      return;
    }
    binder(widget, (args = []) => {
      // Re-read the handler set at CLICK time, not at bind time, so a `SetScript` between the two takes
      // effect -- the same rule the single-handler path relies on by firing through `invokeScriptHandler`.
      for (const handler of clickNames) {
        if (getScriptHandler(self, handler) !== null) {
          fireFromInput(ctx, self, handler, args);
        }
      }
    });
    return;
  }
  if (getScriptHandler(self, name) === null) {
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
