/**
 * The FrameScript object model: what makes a widget a real Lua object rather than a handle the glue
 * code has to keep passing back to us.
 *
 * A frame's Lua value is a plain TABLE carrying its integer id, with a shared metatable whose
 * `__index` dispatches by method name through per-class method tables. Everything on the JS side is
 * keyed by that integer id -- one flat `FrameRegistry`, no object graph mirrored across the
 * boundary. That is the shape benilla's Rust implementation was forced into (mlua's reference thread
 * caps at 8000 slots, so it holds no persistent Lua handles at all); we are not under that
 * constraint, since fengari is garbage-collected JS, but the shape is worth keeping on its own
 * merits -- ids serialize, survive a VM restart, and can't leak the Lua state into game code.
 *
 * The one rule here that is easy to get backwards, and that the addon goal rests on:
 *
 *   METHOD TABLES ARE PER CLASS, AND A CLASS ONLY SEES ITS OWN CHAIN.
 *
 * Addons discover what a widget is by asking it: `if frame.SetValue then ... end`. If every widget
 * shared one flat method table, every frame would answer yes to every question and that idiom --
 * which is everywhere in real addon code -- would quietly start lying. So a plain Frame resolves
 * `SetValue` to nil, and a CheckButton resolves a method by walking CHECKBUTTON -> BUTTON -> FRAME ->
 * REGION, which is the client's own class hierarchy.
 *
 * Dispatch itself lives in Lua (see `DISPATCH_CHUNK`), not in JS. `__index` is called on every miss
 * -- that is, on every single method call in the entire UI -- so the hot path must not cross the JS
 * boundary more than it has to. The Lua side memoizes the bound closure per (class, method name), so
 * the JS resolver is consulted once per pair and the steady state is a table lookup.
 */
import { LuaRef, LuaVM } from './vm';
import { FontObjectLookup } from '../fonts';
import { Widget, WidgetKind, WidgetRoot } from '../../widget';

/**
 * The client's widget classes, as a real hierarchy rather than a flat list of kinds.
 *
 * REGION and LAYEREDREGION are abstract -- nothing is created as one. They exist because the methods
 * really do belong at those levels: `SetPoint`/`Show`/`GetParent` to everything drawable (REGION),
 * `SetVertexColor`/`SetDrawLayer` to exactly Texture and FontString (LAYEREDREGION). Hoisting the
 * layered ones to REGION would make every Frame answer to `SetVertexColor`, which is the leak this
 * whole file exists to prevent; duplicating them into both leaf classes is the same leak waiting to
 * be introduced by the next editor.
 */
export type WidgetClass =
  | 'REGION'
  | 'LAYEREDREGION'
  | 'TEXTURE'
  | 'FONTSTRING'
  | 'FRAME'
  | 'BUTTON'
  | 'CHECKBUTTON'
  | 'EDITBOX'
  | 'MODEL'
  | 'SCROLLFRAME'
  | 'SLIDER'
  | 'STATUSBAR'
  | 'SIMPLEHTML'
  | 'BACKDROP';

const CLASS_PARENT: Record<WidgetClass, WidgetClass | null> = {
  REGION: null,
  LAYEREDREGION: 'REGION',
  TEXTURE: 'LAYEREDREGION',
  FONTSTRING: 'LAYEREDREGION',
  FRAME: 'REGION',
  BUTTON: 'FRAME',
  CHECKBUTTON: 'BUTTON',
  EDITBOX: 'FRAME',
  MODEL: 'FRAME',
  SCROLLFRAME: 'FRAME',
  SLIDER: 'FRAME',
  STATUSBAR: 'FRAME',
  SIMPLEHTML: 'FRAME',
  // OURS, not the client's: `backdrop` is a Widget kind this project invented for a nine-slice
  // frame. It behaves as a Frame and has no methods of its own today.
  BACKDROP: 'FRAME',
};

/**
 * Every class that is a concrete widget, and the `Widget` kind it is built as.
 *
 * The last five map onto the plain `frame` kind because `widget.ts` has no member for them and
 * widening `WidgetKind` is a bigger change than this task should make. That split is right anyway:
 * the CLASS is what Lua and addons duck-type against, the `Widget` KIND is what the renderer draws.
 * A Slider is a distinct Lua class with distinct methods and, until something draws a slider track,
 * an ordinary frame on screen. Task 4 giving any of them real behaviour is the point at which
 * widening `WidgetKind` becomes worth it.
 */
const CLASS_KIND: Partial<Record<WidgetClass, WidgetKind>> = {
  TEXTURE: 'texture',
  FONTSTRING: 'fontstring',
  FRAME: 'frame',
  BUTTON: 'button',
  CHECKBUTTON: 'checkbutton',
  EDITBOX: 'editbox',
  BACKDROP: 'backdrop',
  MODEL: 'frame',
  SCROLLFRAME: 'frame',
  SLIDER: 'frame',
  STATUSBAR: 'frame',
  SIMPLEHTML: 'frame',
};

/**
 * FrameXML type names that are not simply the class name.
 *
 * `ModelFFX` is the one that matters: it is the ROOT element of `AccountLogin.xml`
 * (`<ModelFFX name="AccountLogin" ...>`), so without this entry rule 5 turns the login screen into
 * a hard error and nothing materializes at all.
 */
const CLASS_ALIASES: Record<string, WidgetClass> = {
  MODELFFX: 'MODEL',
  PLAYERMODEL: 'MODEL',
};

/**
 * What `CreateFrame` will build. Deliberately NOT every concrete class: the real client errors on
 * `CreateFrame("Texture")` because a texture is created through its owner (`CreateTexture`), and
 * rule 5 makes `CreateFrame` the validation point -- so it has to be able to say no.
 */
const CREATE_FRAME_CLASSES: WidgetClass[] = [
  'FRAME',
  'BUTTON',
  'CHECKBUTTON',
  'EDITBOX',
  'MODEL',
  'SCROLLFRAME',
  'SLIDER',
  'STATUSBAR',
  'SIMPLEHTML',
  'BACKDROP',
];

/** Parses a FrameXML type name (`"CheckButton"`, `"checkbutton"`, `"ModelFFX"`) into a class. */
function parseClass(name: string): WidgetClass | null {
  const upper = name.toUpperCase();
  // `hasOwnProperty`, not `in`: `in` walks Object.prototype, so a type named "constructor" or
  // "toString" would parse as a class. Harmless today only by luck -- no prototype key is all-caps.
  if (hasOwn(CLASS_ALIASES, upper)) {
    return CLASS_ALIASES[upper];
  }
  return hasOwn(CLASS_PARENT, upper) ? (upper as WidgetClass) : null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The lookup order for a class: itself, then each ancestor. */
function chainOf(cls: WidgetClass): WidgetClass[] {
  const chain: WidgetClass[] = [];
  let node: WidgetClass | null = cls;
  while (node !== null) {
    chain.push(node);
    node = CLASS_PARENT[node];
  }
  return chain;
}

/**
 * A widget method, as tasks 3-5 write them.
 *
 * `self` is the frame's integer id, not its Lua table -- a method that needs the widget asks
 * `ctx.registry.widget(self)`, and one that needs to hand a frame BACK to Lua returns
 * `ctx.wrapper(id)`. Nothing on the JS side ever holds a Lua table.
 *
 * `args` are the call's remaining arguments, already converted to JS values; a table argument
 * (usually another frame) arrives as a `LuaRef`, and `ctx.frameIdOf` turns that into an id.
 */
export type FrameMethod = (ctx: MethodContext, self: number, args: unknown[]) => unknown[];

export type MethodTable = Record<string, FrameMethod>;

/**
 * The slice of `GlueInput` the object model needs, and nothing more.
 *
 * `EditBox:SetFocus`/`ClearFocus`/`HasFocus` are meaningless without the live focus pointer, and that
 * pointer belongs to the router (`ui/input.ts`), which is constructed per screen outside anything the
 * object model holds. Declared here as a two-member interface rather than imported as `GlueInput`:
 * `object.ts` has no business knowing about DOM event routing, `GlueInput` satisfies this structurally,
 * and a test can hand in a two-line object.
 */
export interface FocusSink {
  readonly focused: Widget | null;
  setFocus(widget: Widget | null): void;
}

export interface MethodContext {
  vm: LuaVM;
  registry: FrameRegistry;
  /**
   * The screen's focus router, or null when nothing threaded one in -- in which case the three
   * EditBox focus methods report themselves as the gap they are (`methods/kinds.ts`) rather than
   * quietly doing nothing.
   */
  input: FocusSink | null;
  /**
   * The live font-object lookup: a `<Font>` name to the font values its whole `inherits=` chain
   * resolves to. Null until a `FrameXmlRuntime` installs one (`framexml/loader.ts`), because the
   * registry it reads is per-load and this module knows nothing about documents -- while it is null,
   * the four `Set*FontObject` methods report the gap rather than guessing at a font.
   */
  fontObject: FontObjectLookup | null;
  /** The frame's Lua table, created on first use and the same table forever after. */
  wrapper(id: number): LuaRef;
  /** The frame id behind a Lua value that is (or should be) a frame table; null if it is not one. */
  frameIdOf(value: unknown): number | null;
  /**
   * Takes ownership of a handle a method wants to KEEP past the end of the call -- a `SetScript`
   * handler, most obviously.
   *
   * Handle ownership at this boundary, stated once:
   *   - Arguments are borrowed. The call boundary releases every handle among them when the method
   *     returns, because `toJs` mints a fresh one per call and they would otherwise pin the Lua
   *     registry per CALL, not per object.
   *   - To store one, `retain` it and keep what `retain` returns. Release it with `ctx.vm.unref`
   *     when you drop it (replacing a script handler, say) or it leaks.
   *   - Returning a handle is safe: the boundary skips anything it finds among the results. The
   *     usual case, `ctx.wrapper(id)`, is the frame's permanent handle and is never released here.
   */
  retain(ref: LuaRef): LuaRef;
}

/**
 * Method tables, per class. `Object.create(null)` and `hasOwn` below, not `{}` and `[name]`: with a
 * plain object literal every frame would answer non-nil to `toString`, `constructor`, `valueOf` and
 * `hasOwnProperty`, which breaks exactly the duck-typing invariant this file exists to protect --
 * and `frame:toString()` would then call `Object.prototype.toString` as a widget method and push
 * "[object Undefined]" into Lua as its return values.
 */
const METHODS = new Map<WidgetClass, MethodTable>();

/**
 * A once-per-message console warning, LOCAL to this file.
 *
 * `methods/region.ts` exports one of these, and importing it here would be wrong twice: it would make
 * an import cycle (`region.ts` imports this file), and it would break the rule this file's docstring
 * states -- `object.ts` imports none of the method modules, so that a forgotten import shows up as a
 * missing method surface rather than being papered over by a transitive one. Two memos rather than one
 * is the price; the cost is a duplicated message if the same text is warned from both, which none is.
 */
const warnedMessages = new Set<string>();
function warnOnce(message: string): void {
  if (warnedMessages.has(message)) {
    return;
  }
  warnedMessages.add(message);
  console.warn(message);
}

/**
 * One entry per installed VM, clearing that VM's Lua-side dispatch cache.
 *
 * The cache memoizes "this class does not have that method" as hard as the positive answer, which is
 * what makes duck-typing cheap -- but it also means a method table registered after something has
 * already asked for that name would stay invisible for the life of the VM. Since `object.ts`
 * deliberately imports none of the method modules, whether they are imported at all is up to the
 * caller of `installObjectModel`, and a forgotten import would otherwise show up as a UI that
 * renders and does nothing at all. So registration invalidates instead of relying on ordering.
 */
const CACHE_INVALIDATORS = new Set<() => void>();

/**
 * Registers methods against a class. THIS IS THE EXTENSION POINT for every later task: task 3 calls
 * it for REGION and FRAME, task 4 for BUTTON / CHECKBUTTON / EDITBOX / TEXTURE / FONTSTRING, task 5
 * adds `SetScript` to FRAME. Calls merge, so a class can be filled in from more than one module and
 * registering the same name twice is a deliberate override rather than an error.
 *
 * Registration is module-level rather than per-VM on purpose: method tables are static definitions
 * that depend on nothing but the `MethodContext` handed to them at call time, so there is nothing
 * per-VM about them, and making them global means a task's module only has to be imported, not
 * threaded through `installObjectModel`.
 *
 * Registering late is safe -- every installed VM's dispatch cache is flushed here -- but registering
 * at import time is still the habit to keep, since a flush throws away the whole memo.
 */
export function registerMethods(cls: WidgetClass, methods: MethodTable): void {
  const table = METHODS.get(cls) ?? (Object.create(null) as MethodTable);
  for (const [name, method] of Object.entries(methods)) {
    table[name] = method;
  }
  METHODS.set(cls, table);

  for (const invalidate of [...CACHE_INVALIDATORS]) {
    try {
      invalidate();
    } catch {
      // The VM behind this entry is gone (disposed, most likely, as tests do). Drop it rather than
      // letting a dead VM break registration for the live ones.
      CACHE_INVALIDATORS.delete(invalidate);
    }
  }
}

function resolveMethod(cls: WidgetClass, name: string): FrameMethod | null {
  for (const link of chainOf(cls)) {
    const table = METHODS.get(link);
    if (table !== undefined && hasOwn(table, name)) {
      return table[name];
    }
  }
  return null;
}

interface FrameEntry {
  readonly id: number;
  readonly cls: WidgetClass;
  /** Mutable for `publishName` alone: a region created unnamed may learn the name its XML declared. */
  name: string | null;
  readonly widget: Widget;
  /**
   * The frame's Lua table, cached so `GetParent()` returns the same table every time -- identity
   * has to be stable or `frameA == frameB` in Lua lies. Held here rather than in a Map beside the
   * object model so that `reset` has one place to release from.
   */
  wrapper: LuaRef | null;
}

/** One frame going away, as `FrameRegistry.reset` announces it. */
export interface FrameRelease {
  readonly id: number;
  /** The frame's Lua table, if one was ever materialized. Whoever minted it releases it. */
  readonly wrapper: LuaRef | null;
  /** The `_G` name this frame published, if it was the frame that got it. */
  readonly ownedName: string | null;
}

/**
 * Listeners for "this frame id is dead", installed at module import time by every module that keys
 * state by frame id.
 *
 * THE ONE TEARDOWN PATH: `screen.unmount()` -> `FrameRegistry.reset()` -> per frame, the object
 * model's own subscriber releases the wrapper handle and gives up the `_G` name, then fans out to
 * these so the side tables scattered across `scripts.ts`, `events.ts` and `methods/` drop that id
 * too. Adding a new side table means adding a listener HERE, in the module that owns the table, not a
 * new cleanup call in whatever code happens to tear a screen down.
 *
 * Module-level rather than per-registry for the same reason `METHODS` is: the tables these listeners
 * clean are module-level themselves. A listener therefore sees releases from EVERY registry, and must
 * key strictly on the id it is handed -- never sweep its whole table.
 */
const FRAME_TEARDOWN: Array<(ctx: MethodContext, id: number) => void> = [];

/** Registers a side-table cleanup. Called at import time; there is no unregister and nothing needs one. */
export function onFrameTeardown(listener: (ctx: MethodContext, id: number) => void): void {
  FRAME_TEARDOWN.push(listener);
}

/**
 * Every frame the runtime knows about, keyed by integer id.
 *
 * The registry owns the widget tree and the name -> id map; it knows nothing about Lua beyond
 * storing the opaque wrapper handle the object model puts there, and calling back to release it.
 */
export class FrameRegistry {
  /** The tree's root. A frame created with no parent is parented here. */
  readonly root: Widget;

  private readonly entries = new Map<number, FrameEntry>();
  private readonly names = new Map<string, number>();
  private readonly widgetIds = new Map<Widget, number>();
  private readonly releaseListeners: Array<(release: FrameRelease) => void> = [];
  private nextId = 1;

  constructor(root: Widget = new WidgetRoot().root) {
    this.root = root;
  }

  /**
   * Builds a widget and returns its id. `kind` is a FrameXML type name (`"CheckButton"`); an
   * unrecognized one THROWS, which `installObjectModel` turns into a Lua error, because
   * `CreateFrame` is where the client validates and a silently-created wrong widget would surface
   * as a mystery three screens later.
   */
  create(kind: string, name: string | null, parent: number | null): number {
    const cls = parseClass(kind);
    const widgetKind = cls === null ? undefined : CLASS_KIND[cls];
    if (cls === null || widgetKind === undefined) {
      throw new Error(`CreateFrame: unknown frame type '${kind}'`);
    }

    const parentWidget = parent === null ? this.root : this.entries.get(parent)?.widget;
    if (parentWidget === undefined) {
      throw new Error(`CreateFrame: parent frame ${parent} does not exist`);
    }

    const id = this.nextId++;
    const widget = new Widget(widgetKind, `lua:${id}`);
    // INTERACTIVITY IS A PROPERTY OF THE CLASS, not of an attribute. `enableMouse="true"` appears on
    // exactly six elements in the whole loaded manifest and on none of the login form's controls: the
    // engine makes a Button mouse-enabled and an EditBox mouse-enabled AND focusable because that is
    // what those classes ARE, and `enableMouse` exists for the other case -- a plain `<Frame>` that
    // wants to eat clicks (a modal backdrop, which is every one of those six). Without this, nothing an
    // XML document declares can be clicked or focused at all, whatever its `<Scripts>` say. A later
    // `EnableMouse(false)` still turns it off; this is the starting value, exactly like `state = 'up'`.
    if (widgetKind === 'button' || widgetKind === 'checkbutton') {
      widget.mouseEnabled = true;
    } else if (widgetKind === 'editbox') {
      widget.mouseEnabled = true;
      widget.focusable = true;
    }
    // `Widget#add` already carries the client's rule -- the child takes the parent's strata, a child
    // FRAME is born at the parent's level + 1, a region stays at its owner's level. Do not re-apply
    // any of that here.
    parentWidget.add(widget);

    this.entries.set(id, { id, cls, name, widget, wrapper: null });
    this.widgetIds.set(widget, id);
    // Non-overwriting: the first frame with a name owns it.
    if (name !== null && !this.names.has(name)) {
      this.names.set(name, id);
    }
    return id;
  }

  widget(id: number): Widget | null {
    return this.entries.get(id)?.widget ?? null;
  }

  /**
   * The inverse of `widget`: the frame id behind a live `Widget`, or null for one this registry did
   * not create (the screen ROOT, most importantly -- it is a `Widget` but not a frame).
   *
   * Needed by anything that walks the WIDGET tree and then has to talk to Lua about what it found:
   * `region.ts`'s `Show`/`Hide` visibility cascade walks a subtree of widgets and fires each frame's
   * `OnShow`/`OnHide`, and the widget tree is the only place the parent/child relation lives (the
   * registry stores ids, not a tree).
   */
  idOfWidget(widget: Widget): number | null {
    return this.widgetIds.get(widget) ?? null;
  }

  byName(name: string): number | null {
    return this.names.get(name) ?? null;
  }

  classOf(id: number): WidgetClass | null {
    return this.entries.get(id)?.cls ?? null;
  }

  nameOf(id: number): string | null {
    return this.entries.get(id)?.name ?? null;
  }

  /**
   * Names a frame that was created WITHOUT one -- a button's label region and its state textures, which
   * their setters construct anonymously while the XML declares a `name=` for them.
   *
   * The loader was already publishing those names as Lua GLOBALS (`loader.ts#publishRegion`) and that
   * is not the same thing, which is the defect this exists to close: `SetPoint`'s `relativeTo` may be a
   * frame NAME STRING, and `region.ts` resolves such a string through `byName` -- the registry, not
   * `_G`. So `realmlist.xml:221`'s
   * `_G[self:GetName().."PVP"]:SetPoint("LEFT", self:GetName().."NormalText", "RIGHT", 10, 0)` could not
   * find a label the loader had published perfectly well, and fell back to anchoring against the whole
   * 512-wide button -- putting the type, character-count and population columns of every realm row off
   * the right edge of the panel.
   *
   * Non-overwriting on both sides, for the two reasons that differ: an id that already has a name keeps
   * it (a frame's name is its identity and a second one would make `GetName()` a lie), and a name
   * already taken stays with its first claimant (`create`'s own rule). Answers whether it took the name,
   * so a caller can report the collision.
   */
  publishName(id: number, name: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.name !== null || this.names.has(name)) {
      return false;
    }
    entry.name = name;
    this.names.set(name, id);
    return true;
  }

  /** The id of a frame's parent, or null at the root (whose own id is not a frame id). */
  parentOf(id: number): number | null {
    const parent = this.entries.get(id)?.widget.parent;
    if (parent === undefined || parent === null) {
      return null;
    }
    return this.widgetIds.get(parent) ?? null;
  }

  /** Internal, for `installObjectModel`: the cached Lua table for a frame. */
  wrapperOf(id: number): LuaRef | null {
    return this.entries.get(id)?.wrapper ?? null;
  }

  /** Internal, for `installObjectModel`. */
  setWrapper(id: number, ref: LuaRef): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      entry.wrapper = ref;
    }
  }

  /**
   * Internal, for `installObjectModel`: subscribe to frame release.
   *
   * MULTI-SUBSCRIBER, and that is the whole point of the shape. The single-slot field this replaced
   * was already claimed by `installObjectModel` (it is the only thing that can give a wrapper handle
   * back to the VM), so every OTHER thing that keys state by frame id -- `scripts.ts`'s
   * `handlersByFrame`, `events.ts`'s `framesByEvent`, `methods/frame.ts`'s `frameIds`,
   * `methods/kinds.ts`'s state-texture/label tables -- had nowhere to hear about a teardown and grew
   * for the life of the process. They are notified through `onFrameTeardown` below, which
   * `installObjectModel`'s subscriber fans out to because it is the one holding the `MethodContext`
   * those listeners need; this hook stays low-level and Lua-free, like the rest of this class.
   *
   * Returns an unsubscribe, so a listener can outlive nothing.
   */
  onRelease(listener: (release: FrameRelease) => void): () => void {
    this.releaseListeners.push(listener);
    return () => {
      const index = this.releaseListeners.indexOf(listener);
      if (index !== -1) {
        this.releaseListeners.splice(index, 1);
      }
    };
  }

  /**
   * Drops every frame, releasing the Lua handle each one held.
   *
   * A glue screen is torn down and rebuilt whenever the session changes state, so without this the
   * Lua registry would gain a permanently-pinned table per frame per rebuild. The wrapper TABLES are
   * then ordinary garbage; it is the registry slots that had to be handed back explicitly, since the
   * Lua registry is a GC root by definition and no amount of JS garbage collection reaches into it.
   *
   * Every entry is announced, wrapper or not: a frame whose Lua table was never materialized can
   * still have script handlers and event registrations against its id, and those are exactly what the
   * listeners are here to drop.
   */
  reset(): void {
    for (const entry of this.entries.values()) {
      const owned = entry.name !== null && this.names.get(entry.name) === entry.id;
      const release: FrameRelease = {
        id: entry.id,
        wrapper: entry.wrapper,
        ownedName: owned ? entry.name : null,
      };
      // A copy of the list, because a listener that unsubscribes itself while being notified would
      // otherwise make the walk skip its neighbour.
      for (const listener of [...this.releaseListeners]) {
        listener(release);
      }
      entry.wrapper = null;
    }
    this.entries.clear();
    this.names.clear();
    this.widgetIds.clear();
    for (const child of [...this.root.children]) {
      this.root.remove(child);
    }
  }
}

/**
 * `__index`, in Lua.
 *
 * It runs on every method call in the UI, so it goes out of its way not to: `cache[class][name]`
 * holds the bound closure (or `false`, meaning "this class genuinely does not have that method" --
 * the answer duck-typing depends on), and the JS resolver is asked exactly once per class/name pair.
 * `false` rather than nil for the negative because a nil cache entry is indistinguishable from a
 * cache miss, and re-asking JS on every `if frame.SetValue then` would be the slow path taken most.
 *
 * The JS bridges are localized and then removed from `_G`: FrameXML and addons walk the global
 * table, and internals of ours have no business being visible there. `__frameFlushCache` leaves the
 * same way, as a handle `installObjectModel` keeps and calls when a method table is registered.
 */
const DISPATCH_CHUNK = `
  local hasMethod = __frameHasMethod
  local invoke = __frameInvokeMethod
  local cache = {}

  __frameFlushCache = function()
    cache = {}
  end

  __frameMetatable = {
    __index = function(self, key)
      local class = rawget(self, '__class')
      -- A table wearing this metatable with no __class is not a frame -- someone nil'd the field, or
      -- built a lookalike. Answer nil rather than dying in 'cache[nil]' with a table-index error
      -- three layers from anything the author wrote.
      if class == nil then
        return nil
      end
      local byClass = cache[class]
      if byClass == nil then
        byClass = {}
        cache[class] = byClass
      end
      local method = byClass[key]
      if method == nil then
        if hasMethod(class, key) then
          method = function(this, ...)
            return invoke(rawget(this, '__id'), key, ...)
          end
        else
          method = false
        end
        byClass[key] = method
      end
      if method == false then
        return nil
      end
      return method
    end,
  }

  __frameHasMethod = nil
  __frameInvokeMethod = nil
`;

const CONTEXTS = new WeakMap<LuaVM, MethodContext>();

/**
 * The context installed on a VM, for callers that are not inside a method body.
 *
 * Task 5's script dispatch is driven from JS by events: it has the frame id and the VM, and needs
 * the frame's Lua TABLE to pass as `self`. `installObjectModel` also returns this, which is the
 * shorter path when the caller is the one installing.
 */
export function contextFor(vm: LuaVM): MethodContext | null {
  return CONTEXTS.get(vm) ?? null;
}

/**
 * Installs `CreateFrame` and the metatable machinery into a VM, and returns the context its methods
 * will be called with -- `wrapper` in particular, which is how anything outside a method body turns
 * a frame id into the frame's Lua table.
 *
 * Call once per VM, after `installCompat` and before any glue Lua runs.
 */
export function installObjectModel(
  vm: LuaVM,
  registry: FrameRegistry,
  input: FocusSink | null = null,
): MethodContext {
  if (CONTEXTS.has(vm)) {
    // Installing twice would strand the first metatable's handle and leave two dispatch caches, one
    // of them unreachable and never invalidated. Nothing needs it, so refuse rather than cope.
    throw new Error('installObjectModel: this VM already has an object model installed');
  }

  // Assigned once the dispatch chunk below has run. `wrapper` is a closure, so it only has to be
  // non-null by the time the first frame is created, which is necessarily after that.
  let metatable: LuaRef | null = null;

  const wrapper = (id: number): LuaRef => {
    const existing = registry.wrapperOf(id);
    if (existing !== null) {
      return existing;
    }
    const cls = registry.classOf(id);
    if (cls === null) {
      throw new Error(`frame ${id} does not exist`);
    }
    if (metatable === null) {
      throw new Error('installObjectModel: a frame was created before the dispatch chunk ran');
    }
    const table = vm.newTable();
    vm.setTableField(table, '__id', id);
    vm.setTableField(table, '__class', cls);
    vm.setMetatable(table, metatable);
    registry.setWrapper(id, table);

    // Publish to `_G`, non-overwriting -- the first frame with a name owns it, and an existing
    // global (a FrameXML function, say) is never clobbered by a frame that happens to share its
    // name. `getGlobal` mints a handle for a table-valued global, so release it when we discard it.
    const name = registry.nameOf(id);
    if (name !== null && registry.byName(name) === id) {
      const existingGlobal = vm.getGlobal(name);
      if (existingGlobal === undefined) {
        vm.setGlobal(name, table);
      } else if (vm.isRef(existingGlobal)) {
        vm.unref(existingGlobal);
      }
    }
    return table;
  };

  const frameIdOf = (value: unknown): number | null => {
    if (!vm.isRef(value)) {
      return null;
    }
    const id = vm.getTableField(value, '__id');
    return typeof id === 'number' && registry.classOf(id) !== null ? id : null;
  };

  const ctx: MethodContext = {
    vm,
    registry,
    input,
    // Filled in by `createFrameXmlRuntime`, which is the first thing that has a font registry to read.
    fontObject: null,
    wrapper,
    frameIdOf,
    retain: (ref) => vm.dup(ref),
  };

  // THE teardown path (see `FRAME_TEARDOWN`). Subscribed here, after `ctx` exists, because the
  // fan-out needs it: the side-table listeners hold nothing but their own map and need a VM to hand
  // handles back through.
  //
  // Order inside: the listeners run BEFORE the wrapper handle is released, so one that wants to ask
  // the registry (or Lua) anything about the frame still can. Each is guarded, because a throwing
  // listener must not strand every remaining frame's handle.
  registry.onRelease(({ id, wrapper: held, ownedName }) => {
    for (const listener of FRAME_TEARDOWN) {
      try {
        listener(ctx, id);
      } catch (error) {
        console.warn(`frame teardown listener failed for frame ${id}`, error);
      }
    }
    if (held !== null) {
      vm.unref(held);
    }
    // Giving up the global too, so the name is free for the frame the next screen builds with it.
    if (ownedName !== null) {
      vm.setGlobal(ownedName, null);
    }
  });

  // Does this class have this method at all? The answer duck-typing turns on, asked once per
  // class/name pair and memoized on the Lua side.
  vm.registerFunction('__frameHasMethod', (args) => {
    const cls = parseClass(String(args[0]));
    if (cls === null) {
      return [false];
    }
    return [resolveMethod(cls, String(args[1])) !== null];
  });

  vm.registerFunction('__frameInvokeMethod', (args) => {
    const id = Number(args[0]);
    const name = String(args[1]);
    const cls = registry.classOf(id);
    const method = cls === null ? null : resolveMethod(cls, name);
    const rest = args.slice(2);
    if (method === null) {
      // Reachable if a frame is destroyed between resolve and call; the Lua-side cache is keyed by
      // class, so a stale id is the only way to get here.
      releaseAll(vm, rest, []);
      throw new Error(`${name}: frame ${id} is not a live widget`);
    }
    let results: unknown[] = [];
    try {
      results = method(ctx, id, rest) ?? [];
    } finally {
      // Every table argument arrived as a fresh registry handle from `toJs`; whatever the method
      // did with them, they are dead now. A handle the method is RETURNING is spared -- returning
      // `ctx.wrapper(...)` is the normal case and that one is the frame's permanent handle, but an
      // argument passed straight back through would otherwise be freed before it is pushed.
      releaseAll(vm, rest, results);
    }
    return results;
  });

  const chunkError = vm.run(DISPATCH_CHUNK, 'framescript-dispatch.lua');
  if (chunkError !== null) {
    throw new Error(`installObjectModel: the dispatch chunk failed to load: ${chunkError.message}`);
  }
  const metatableGlobal = vm.getGlobal('__frameMetatable');
  if (!vm.isRef(metatableGlobal)) {
    throw new Error('installObjectModel: the dispatch chunk did not leave a metatable behind');
  }
  metatable = metatableGlobal;
  vm.setGlobal('__frameMetatable', null);

  const flushCache = vm.getGlobal('__frameFlushCache');
  if (!vm.isRef(flushCache)) {
    throw new Error('installObjectModel: the dispatch chunk did not leave a cache flush behind');
  }
  vm.setGlobal('__frameFlushCache', null);

  // Only NOW is the VM installed. Marking it earlier meant that a VM whose install threw was left
  // marked installed, so a caller that caught and retried got the double-install refusal instead of
  // a real second attempt -- a confusing error standing in front of the real one.
  CONTEXTS.set(vm, ctx);

  CACHE_INVALIDATORS.add(() => {
    const callError = vm.call(flushCache, []);
    if (callError !== null) {
      throw new Error(`flushing the dispatch cache failed: ${callError.message}`);
    }
  });

  // CreateFrame(type, name, parent, template).
  vm.registerFunction('CreateFrame', (args) => {
    // Borrowed, and released in the `finally` -- including on every throw path, since an argument
    // handle stranded by a rejected `CreateFrame("Sparkle", nil, parent)` is a registry slot pinned
    // forever, and rule 5 makes that throw a normal thing for game code to do.
    const borrowed = args.filter((arg): arg is LuaRef => vm.isRef(arg));
    try {
      const kind = args[0];
      if (typeof kind !== 'string') {
        throw new Error('CreateFrame: the first argument must be a frame type');
      }
      const cls = parseClass(kind);
      if (cls === null || !CREATE_FRAME_CLASSES.includes(cls)) {
        throw new Error(`CreateFrame: unknown frame type '${kind}'`);
      }
      const name = typeof args[1] === 'string' ? args[1] : null;

      let parent: number | null = null;
      if (vm.isRef(args[2])) {
        parent = frameIdOf(args[2]);
        if (parent === null) {
          throw new Error(`CreateFrame: the parent given for '${name ?? kind}' is not a frame`);
        }
      }

      // THE TEMPLATE ARGUMENT IS ACCEPTED AND IGNORED, and this warning is the one thing standing
      // between that and a mystery.
      //
      // Templates live in the XML loader's `TemplateRegistry`, which is per-load and not reachable from
      // here, and applying one means materializing an element's whole subtree -- `<Layers>`, nested
      // `<Frames>`, `<Scripts>`, `$parent` name publication -- against an ALREADY-CREATED frame, which
      // is a shape `loader.ts#materialize` does not have (it creates and applies in one pass). So a
      // Lua-side `CreateFrame(kind, name, parent, template)` builds a BARE frame.
      //
      // What that costs, concretely, because it was diagnosed the hard way: `GlueDropDownMenu.lua:159`
      // creates each menu button as `CreateFrame("BUTTON", listName.."Button"..i, list,
      // "GlueDropDownMenuButtonTemplate")`, and that template (gluedropdownmenutemplates.xml:3) is where
      // `$parentInvisibleButton` and `$parentCheck` are declared. With the template dropped, those
      // children never exist, so `_G[button:GetName().."InvisibleButton"]` and
      // `_G["DropDownList1Button1Check"]` are nil and the next line indexes nil -- two of the manifest's
      // load errors. NOT a `$parent` or template-expansion defect: both are correct for XML-declared
      // frames, and neither is involved in a frame created from Lua.
      if (typeof args[3] === 'string' && args[3] !== '') {
        warnOnce(
          `CreateFrame: the template "${args[3]}" was ignored -- a frame created from Lua gets none of its template's regions, children or scripts (first: ${name ?? kind})`,
        );
      }
      return [wrapper(registry.create(kind, name, parent))];
    } finally {
      // The wrapper handed back is the frame's own permanent handle, never one of these.
      for (const ref of borrowed) {
        vm.unref(ref);
      }
    }
  });

  return ctx;
}

/** Releases every handle in `values` that is not also being handed back to Lua in `keep`. */
function releaseAll(vm: LuaVM, values: unknown[], keep: unknown[]): void {
  for (const value of values) {
    if (vm.isRef(value) && !keep.includes(value)) {
      vm.unref(value);
    }
  }
}
