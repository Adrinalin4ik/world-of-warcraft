/**
 * The FrameXML loader: the join between the document layer (`xml.ts`, `templates.ts`) and the Lua
 * runtime (`lua/`). It walks a parsed document and MATERIALIZES it -- turning `<Include>`/`<Script>`
 * sequencing, template instances, `<Layers>` regions, nested `<Frames>` and `<Scripts>` handlers into
 * live frames -- by driving the FrameScript object model exactly as an addon does.
 *
 * THE ONE DECISION THIS FILE IS BUILT AROUND: every widget here is created by calling the Lua
 * `CreateFrame` GLOBAL, and every property is set by calling the wrapper's OWN method
 * (`wrapper:SetWidth(80)`), never by touching `FrameRegistry` or a `Widget` field directly. A direct
 * path would be shorter and faster and would also be the end of the addon goal: the whole point of the
 * object model is that game code and the loader reach the widget tree through the same door. If that
 * door is missing a method, the right outcome is a warning in the `LoadReport` naming the method --
 * which is what happens -- not a private shortcut around it.
 *
 * Two rules that look like details and are not:
 *
 *  - `OnLoad` fires BOTTOM-UP. A frame's children are fully built and their own `OnLoad`s have run
 *    before the parent's does. Nested `<Frames>` is a post-load pass in the client, not an inline one,
 *    and real FrameXML depends on it: a parent's `OnLoad` routinely calls a method on a child it
 *    expects to already exist.
 *  - EVERY `<Size>` child applies, in document order, LAST WINNING. `templates.ts#merge` appends the
 *    template's children first and the instance's own last precisely so that the last match is the
 *    override; a `.find()`/`[0]` anywhere in this file undoes that and pins every templated frame to
 *    its template's size. (The reference caught this on a button that declared 125x21 and drew 80x22.)
 *
 * And the one that decides whether anything materializes at all: `virtual` is read BEFORE template
 * expansion, never after. `templates.ts#merge` splices `name` and `virtual` through like any other
 * attribute, so `AccountLoginLoginButton` -- which inherits `GlueButtonTemplateBlue` and declares
 * neither -- comes out of `expand` carrying `virtual="true"`. Classifying on the expanded element
 * would file every button that inherits a virtual template into the template registry, and the login
 * screen would build zero frames. The top-level classification already happens pre-expansion in
 * `xml.ts#classify`; the nested-`<Frames>` walk below does the same check on the same footing.
 *
 * Nothing here throws. A bad handler body, an unknown frame type, a missing include, an attribute with
 * no method behind it: each is a line in the `LoadReport` and the load continues, because that is what
 * the client does. Warnings are deduped by key -- a document with 200 handlers whose name this runtime
 * does not model must produce one warning, not 200.
 *
 * No IO: `<Include>` and `<Script file=>` resolve through an injected `(path) => string | null`, which
 * is also what lets the tests run whole documents from inline strings.
 */
import { LuaRef, LuaVM } from './lua/vm';
import { MethodContext } from './lua/object';
import { NOT_IMPLEMENTED } from './lua/methods/region';
import { compileScriptHandler, invokeScriptHandler } from './lua/scripts';
import { DEFAULT_PARENT_NAME, TemplateRegistry, resolveName } from './templates';
import { ParsedDocument, XmlElement, attr, attrBool, childrenNamed, parseXml } from './xml';

// Side-effect imports: the FRAME/MODEL and BUTTON/CHECKBUTTON/EDITBOX method tables (REGION and the
// leaves come in with `NOT_IMPLEMENTED` above). `object.ts` deliberately imports none of them, so
// SOMETHING has to, and this is the module that cannot function without the whole surface -- a
// forgotten import would show up as a document that materializes and then does nothing at all.
// Registering after a VM is installed is safe (`registerMethods` flushes the dispatch cache).
import './lua/methods/frame';
import './lua/methods/kinds';
import './lua/methods/scroll';

/**
 * What a load produced.
 *
 * `warnings` are tolerable gaps: an attribute or handler this runtime does not model, a missing
 * include, an `inherits=` naming nothing registered. None of them dropped a frame. `errors` dropped
 * something: an unknown frame type (and with it the whole subtree), a handler that did not compile, a
 * method that raised. `frames` is how many `CreateFrame` calls succeeded -- the coverage number to
 * report when this runs over the client's real glue files.
 */
export type LoadReport = { warnings: string[]; errors: string[]; frames: number };

/**
 * Everything a load needs to reach the live runtime, and the two registries that must OUTLIVE any one
 * document.
 *
 * Both registries are global and cross-document on purpose, because the client's template table is:
 * `AccountLogin.xml` inherits templates `GlueTemplates.xml` declared, so a per-document registry drops
 * every such inherit silently -- the frame still materializes, just with none of its template's
 * content. `fonts` is a SEPARATE namespace from `templates` for the reason `xml.ts#classify` spells
 * out: a font object inherits a font object, never a frame, and all 57 `<Font>`s in the client's own
 * `gluefontstyles.xml` carry `virtual="true"` because that is simply how one is declared.
 */
export interface FrameXmlRuntime {
  readonly vm: LuaVM;
  readonly ctx: MethodContext;
  readonly templates: TemplateRegistry;
  readonly fonts: TemplateRegistry;
}

/** The sanctioned way to build a runtime: two fresh registries around an installed object model. */
export function createFrameXmlRuntime(vm: LuaVM, ctx: MethodContext): FrameXmlRuntime {
  return { vm, ctx, templates: new TemplateRegistry(), fonts: new TemplateRegistry() };
}

/** A file resolver. `null` means "not found", which is a warning and never fatal. */
export type FileResolver = (path: string) => string | null;

/**
 * Materialize a parsed document into live frames.
 *
 * `sourceName` only names chunks and report lines (`AccountLogin.xml:OnLoad`); an `<Include>` passes
 * the included path down so a compile error points at the file that holds the source.
 */
export function loadDocument(
  runtime: FrameXmlRuntime,
  doc: ParsedDocument,
  files: FileResolver,
  sourceName = '<inline>',
): LoadReport {
  const loader = new DocumentLoader(runtime, files);
  try {
    loader.loadDoc(doc, sourceName);
  } finally {
    // Nothing in here throws by design, but the `CreateFrame` handle is held for the whole load and a
    // handle stranded by a bug of ours is a registry slot pinned for the life of the VM.
    loader.finish();
  }
  return loader.report;
}

/** A parsed `x`/`y` pair: an `<AbsDimension>` child if there is one, else the element's own attrs. */
function absDim(element: XmlElement): { x?: number; y?: number } {
  const source = childrenNamed(element, 'AbsDimension')[0] ?? element;
  return { x: num(attr(source, 'x')), y: num(attr(source, 'y')) };
}

/** A parsed `<AbsValue val=>` child, else the element's own inline `val`. */
function absValue(element: XmlElement): number | undefined {
  const source = childrenNamed(element, 'AbsValue')[0] ?? element;
  return num(attr(source, 'val'));
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `<Color r= g= b= a=>` as an RGBA tuple. A PRESENT element's missing channels read black, alpha 1. */
function colorOf(element: XmlElement): [number, number, number, number] {
  const channel = (key: string, fallback: number) => num(attr(element, key)) ?? fallback;
  return [channel('r', 0), channel('g', 0), channel('b', 0), channel('a', 1)];
}

/**
 * A `<TexCoords>` child's UV rect, only if all four edges are there.
 *
 * A half-specified one is skipped rather than defaulted: leaving the texture at full-texture UVs is a
 * visible, debuggable no-op, while guessing the missing edges is a crop nobody authored.
 */
function texCoordsOf(element: XmlElement): [number, number, number, number] | null {
  const tc = childrenNamed(element, 'TexCoords')[0];
  if (tc === undefined) {
    return null;
  }
  const edges = ['left', 'right', 'top', 'bottom'].map((key) => num(attr(tc, key)));
  return edges.every((edge): edge is number => edge !== undefined)
    ? [edges[0]!, edges[1]!, edges[2]!, edges[3]!]
    : null;
}

/** The font values a `<FontString>` ends up with, from its inherited font object and its own attrs. */
interface FontResolution {
  file?: string;
  height?: number;
  outline?: string;
  color?: [number, number, number, number];
  justifyH?: string;
}

class DocumentLoader {
  readonly report: LoadReport = { warnings: [], errors: [], frames: 0 };

  /** Warn-once keys, so 200 identical gaps are one line. */
  private readonly warned = new Set<string>();

  /**
   * The Lua `CreateFrame` global, fetched once per load rather than per frame: `getGlobal` mints a
   * fresh registry handle every call, so per-frame lookups would be one leaked slot per frame unless
   * each were released. Released in `finish`.
   */
  private createFrame: LuaRef | null = null;
  private createFrameMissing = false;

  constructor(
    private readonly rt: FrameXmlRuntime,
    private readonly files: FileResolver,
  ) {}

  finish(): void {
    if (this.createFrame !== null) {
      this.rt.vm.unref(this.createFrame);
      this.createFrame = null;
    }
  }

  /**
   * A `text=` attribute, resolved the way the client's LoadXML resolves one: if the value NAMES A
   * GLOBAL STRING, the string is what gets drawn; otherwise the value is the literal.
   *
   * This is not a convenience, it is the whole localization mechanism. `accountlogin.xml` writes
   * `text="ACCOUNT_NAME"`, `text="BLIZZ_DISCLAIMER"`, `text="SAVE_ACCOUNT_NAME"`, and
   * `GlueStrings.lua` -- which the manifest loads FIRST, for this reason -- defines
   * `ACCOUNT_NAME = "Battle.net Account Name"`. Without the lookup the login screen draws its own
   * string keys in place of every caption, which is exactly what the side-by-side diff against the
   * hand-written screen showed.
   *
   * Only an ALL-CAPS identifier is looked up. That is the client's own naming convention for the string
   * table and it keeps a genuine literal (`text="3.3.5"`, a button captioned `text="X"`) from being
   * shadowed by an unrelated global; a non-string global of the same name (a table, a function) is not
   * a string and falls through to the literal too.
   */
  private resolveText(value: string): string {
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
      return value;
    }
    const global = this.rt.vm.getGlobal(value);
    if (typeof global === 'string') {
      return global;
    }
    if (this.rt.vm.isRef(global)) {
      // `getGlobal` mints a handle for a table- or function-valued global; discarding it unreleased
      // pins a registry slot per lookup.
      this.rt.vm.unref(global);
    }
    return value;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.report.warnings.push(message);
  }

  // ---------------------------------------------------------------------------------------------
  // The top level
  // ---------------------------------------------------------------------------------------------

  /**
   * One document's top-level items, IN ORDER. The order is the contract: `<Script>` runs where it
   * sits, so a `<Frame>`'s `OnLoad` can call a function an earlier `<Script>` defined, and an
   * `<Include>`'s templates are registered before the instances below it inherit them.
   */
  loadDoc(doc: ParsedDocument, sourceName: string): void {
    for (const error of doc.errors) {
      this.report.errors.push(`${sourceName}: ${error}`);
    }

    for (const item of doc.items) {
      switch (item.kind) {
        case 'include':
          this.doInclude(item.path);
          break;
        case 'script': {
          const text = this.files(item.path);
          if (text === null) {
            this.report.warnings.push(`<Script file="${item.path}">: no provider hit; skipped`);
            break;
          }
          const error = this.rt.vm.run(text, item.path);
          if (error !== null) {
            this.report.errors.push(`<Script file="${item.path}">: ${error.message}`);
          }
          break;
        }
        case 'inlineScript': {
          const error = this.rt.vm.run(item.body, `${sourceName}:<Script>`);
          if (error !== null) {
            this.report.errors.push(`${sourceName}: inline <Script>: ${error.message}`);
          }
          break;
        }
        case 'font':
          // Registered RAW, like a template: `expand` chain-resolves whatever `inherits=` it carries
          // at the point a `<FontString>` names it. An unnamed one cannot be inherited, and
          // `register` drops it.
          this.rt.fonts.register(item.element);
          break;
        case 'template':
          this.rt.templates.register(item.element);
          break;
        case 'instance':
          this.materialize(this.expand(item.element), null, DEFAULT_PARENT_NAME, sourceName);
          break;
      }
    }
  }

  private doInclude(path: string): void {
    const text = this.files(path);
    if (text === null) {
      this.report.warnings.push(`<Include file="${path}">: no provider hit; skipped`);
      return;
    }
    this.loadDoc(parseXml(text), path);
  }

  /** `TemplateRegistry.expand`, with its warnings folded in and deduped. */
  private expand(element: XmlElement): XmlElement {
    const warnings: string[] = [];
    const expanded = this.rt.templates.expand(element, warnings);
    for (const warning of warnings) {
      this.warnOnce(`expand:${warning}`, warning);
    }
    return expanded;
  }

  /**
   * `expand` for a `<Texture>`/`<FontString>` REGION, gated on the `inherits=` actually naming a
   * registered ELEMENT template. A `<FontString inherits="GameFontNormal">` names a font OBJECT, which
   * lives in the other registry entirely and must pass through here untouched rather than warn as an
   * unknown template.
   */
  private expandRegion(element: XmlElement): XmlElement {
    const inherits = attr(element, 'inherits');
    const hit =
      inherits !== undefined &&
      inherits
        .split(',')
        .map((name) => name.trim())
        .some((name) => name !== '' && this.rt.templates.has(name));
    return hit ? this.expand(element) : element;
  }

  // ---------------------------------------------------------------------------------------------
  // Calling into the object model
  // ---------------------------------------------------------------------------------------------

  /**
   * Call `target:method(...args)` through Lua, discarding the result -- this is the setter path, and
   * `callForWidget` below is the same call for the getters whose result is the point.
   *
   * THREE outcomes, and keeping them apart is what makes the report worth reading. A method the object
   * model has never heard of is a GAP: warned once by name, one line per missing method for the whole
   * load. A method that is REGISTERED BUT DOES NOTHING is the same kind of gap wearing a success:
   * `SetBackdropColor` and `SetHighlightFontObject`/`SetDisabledFontObject` exist so duck-typing sees
   * the class correctly and then return quietly, so without `NOT_IMPLEMENTED` (`lua/methods/region.ts`)
   * this would report a clean load of a screen missing every backdrop tint and every per-state caption
   * font. A method that exists and RAISED is an error: something was wrong with the document or with us.
   *
   * `getTableField` runs the wrapper's `__index`, which mints a handle for the bound closure it
   * returns, so every call here releases that handle -- the frame's Lua-side dispatch cache still
   * holds the closure itself; this only gives back the registry slot.
   */
  private callMethod(target: LuaRef, method: string, args: unknown[], dbg: string): void {
    const value = this.callRaw(target, method, args, dbg);
    if (this.rt.vm.isRef(value)) {
      // A result nobody asked for is still a registry slot. Nothing called through here returns a
      // widget today (the getters go through `callForWidget`), so this is a guard against the next
      // method that does rather than a live leak.
      this.rt.vm.unref(value);
    }
  }

  /** `callMethod` where the result is expected to be a widget wrapper. Null if it was not one. */
  private callForWidget(target: LuaRef, method: string, args: unknown[], dbg: string): LuaRef | null {
    const value = this.callRaw(target, method, args, dbg);
    if (this.rt.vm.isRef(value)) {
      return value;
    }
    return null;
  }

  /** The call itself. Any handle among the results belongs to the caller. */
  private callRaw(target: LuaRef, method: string, args: unknown[], dbg: string): unknown {
    const fn = this.rt.vm.getTableField(target, method);
    if (!this.rt.vm.isRef(fn)) {
      this.warnOnce(
        `method:${method}`,
        `${method} is not in this runtime's object model; every XML use of it is ignored (first: ${dbg})`,
      );
      return undefined;
    }
    try {
      const result = this.rt.vm.callReturning(fn, [target, ...args]);
      if ('message' in result) {
        this.report.errors.push(`${dbg}: ${method}: ${result.message}`);
        return undefined;
      }
      if (NOT_IMPLEMENTED.has(method)) {
        this.warnOnce(
          `stub:${method}`,
          `${method} is registered but does nothing in this runtime; every XML use of it is ignored (first: ${dbg})`,
        );
      }
      return result.value;
    } finally {
      this.rt.vm.unref(fn);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The eight steps
  // ---------------------------------------------------------------------------------------------

  /**
   * Materialize one ALREADY-EXPANDED element, then its nested frames, then fire its `OnLoad`.
   *
   * `parent` is the enclosing frame's wrapper (null at top level). `parentName` is the resolved name
   * of the nearest NAMED ancestor (or `Top`), and the `$parent` asymmetry hangs off it: this frame's
   * OWN anchors substitute `$parent` against `parentName`, because their `$parent` is the frame they
   * are anchored inside; its regions and its children substitute against THIS frame's name, because
   * for them this frame IS the parent. Getting that backwards moves a frame to where its sibling is.
   */
  private materialize(
    element: XmlElement,
    parent: LuaRef | null,
    parentName: string,
    sourceName: string,
  ): number | null {
    // 1 - CreateFrame(type, resolvedName, parent), through the Lua global.
    const resolvedName = resolveName(attr(element, 'name'), parentName);
    const dbg = `${sourceName}:${resolvedName ?? `<${element.tag}>`}`;
    const wrapper = this.create(element.tag, resolvedName ?? null, parent, dbg);
    if (wrapper === null) {
      return null;
    }
    this.report.frames += 1;

    // Read BEFORE the `finally` below releases the handle: an id is a plain number that outlives both
    // the handle and this call, which is why it is what gets returned.
    const frameId = this.rt.ctx.frameIdOf(wrapper);

    // An unnamed frame passes the nearest named ancestor through unchanged, so a region inside it
    // still resolves `$parent` to something addressable.
    const selfName = resolvedName ?? parentName;

    try {
      // 2 - the LoadXML attribute set.
      this.applyAttrs(element, wrapper, dbg);
      // 3 - <Size>: every one of them, in order, last winning.
      this.applySize(element, wrapper, dbg);
      // 4 - <Anchors>, against the PARENT's name.
      this.applyAnchors(element, wrapper, parentName, dbg);
      // 5 - the visual content, against THIS frame's name.
      this.applyLayers(element, wrapper, selfName, dbg);
      this.applySpecialFontStrings(element, wrapper, selfName, dbg);
      this.applyBackdrop(element, wrapper, dbg);
      this.applyPerKind(element, wrapper, selfName, dbg);
      // 6 - <Scripts>. OnLoad is noted, not fired.
      const hasOnLoad = this.applyScripts(element, wrapper, dbg);
      // 7 - nested <Frames>, whose own OnLoads therefore run first, then <ScrollChild> (which is the
      //     same thing wearing a different container, plus the one call that links it to the viewport).
      this.applyChildFrames(element, wrapper, selfName, sourceName);
      this.applyScrollChild(element, wrapper, selfName, sourceName, dbg);
      // 8 - and only now this frame's OnLoad, with its subtree complete.
      if (hasOnLoad) {
        this.fireOnLoad(wrapper, dbg);
      }
    } finally {
      // The wrapper handle lives exactly as long as this frame's own subtree build. The frame itself
      // and its permanent Lua table are owned by `FrameRegistry`; this was a call-result handle.
      this.rt.vm.unref(wrapper);
    }
    // The frame ID, not the handle: an id needs no ownership and outlives this call. `applyScrollChild`
    // is the caller that needs it, to hand the child back to its viewport through `SetScrollChild`.
    return frameId;
  }

  /** Step 1: the `CreateFrame` global. An unknown frame type drops this element and its subtree. */
  private create(tag: string, name: string | null, parent: LuaRef | null, dbg: string): LuaRef | null {
    if (this.createFrame === null && !this.createFrameMissing) {
      const global = this.rt.vm.getGlobal('CreateFrame');
      if (this.rt.vm.isRef(global)) {
        this.createFrame = global;
      } else {
        this.createFrameMissing = true;
        this.report.errors.push(
          'CreateFrame is not a global in this VM -- installObjectModel has not run; nothing can be built',
        );
      }
    }
    if (this.createFrame === null) {
      return null;
    }

    const result = this.rt.vm.callReturning(this.createFrame, [tag, name, parent]);
    if ('message' in result) {
      this.report.errors.push(`${dbg}: CreateFrame("${tag}"): ${result.message}`);
      return null;
    }
    if (!this.rt.vm.isRef(result.value)) {
      this.report.errors.push(`${dbg}: CreateFrame("${tag}") did not return a frame`);
      return null;
    }
    return result.value;
  }

  /**
   * Step 2: the LoadXML attributes this object model has methods for, plus a warn-once for the
   * window-behaviour ones it does not (`toplevel`, `movable`, `resizable`, `enableKeyboard`). Those
   * are flagged rather than dropped silently, because a frame that quietly does not move is a bug
   * report with nowhere to start.
   */
  private applyAttrs(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    if (attrBool(element, 'hidden')) {
      this.callMethod(wrapper, 'Hide', [], dbg);
    }
    const strata = attr(element, 'frameStrata');
    if (strata !== undefined) {
      this.callMethod(wrapper, 'SetFrameStrata', [strata], dbg);
    }
    const level = num(attr(element, 'frameLevel'));
    if (level !== undefined) {
      this.callMethod(wrapper, 'SetFrameLevel', [level], dbg);
    }
    const alpha = num(attr(element, 'alpha'));
    if (alpha !== undefined) {
      this.callMethod(wrapper, 'SetAlpha', [alpha], dbg);
    }
    const id = num(attr(element, 'id'));
    if (id !== undefined) {
      this.callMethod(wrapper, 'SetID', [id], dbg);
    }
    if (attrBool(element, 'enableMouse')) {
      this.callMethod(wrapper, 'EnableMouse', [true], dbg);
    }
    // The window-behaviour attributes. These are ISSUED, not pre-judged: none of the four has a method
    // in this object model today, and `callMethod` reports that by name from evidence -- so the day one
    // lands, the attribute starts working and the warning stops, with nothing here to remember to
    // change. A hardcoded "not in this runtime" line would keep claiming the gap after it closed.
    for (const [name, method] of [
      ['enableKeyboard', 'EnableKeyboard'],
      ['toplevel', 'SetToplevel'],
      ['movable', 'SetMovable'],
      ['resizable', 'SetResizable'],
      ['clampedToScreen', 'SetClampedToScreen'],
    ] as const) {
      if (attrBool(element, name)) {
        this.callMethod(wrapper, method, [true], dbg);
      }
    }
    // `<HitRectInsets><AbsInset .../></HitRectInsets>`, also accepted inline on the element: the
    // frame's MOUSE rect, inset from its resolved rect. An absent side reads 0, so a partial element
    // insets only what it names.
    const hitRect = childrenNamed(element, 'HitRectInsets')[0];
    if (hitRect !== undefined) {
      const source = childrenNamed(hitRect, 'AbsInset')[0] ?? hitRect;
      const side = (key: string) => num(attr(source, key)) ?? 0;
      this.callMethod(
        wrapper,
        'SetHitRectInsets',
        [side('left'), side('right'), side('top'), side('bottom')],
        dbg,
      );
    }
  }

  /**
   * Step 3: EVERY `<Size>` child, in document order, last winning -- see the file header. A dimension
   * that is absent is left alone (the client's "0 means derive from the anchors"), which is why this
   * cannot be simplified to one `SetWidth`/`SetHeight` pair from the last element.
   */
  private applySize(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    for (const size of childrenNamed(element, 'Size')) {
      const { x, y } = absDim(size);
      if (x !== undefined) {
        this.callMethod(wrapper, 'SetWidth', [x], dbg);
      }
      if (y !== undefined) {
        this.callMethod(wrapper, 'SetHeight', [y], dbg);
      }
    }
  }

  /**
   * Step 4: `setAllPoints` first (a frame carrying only the attribute pins itself to its parent), then
   * every `<Anchor>`. `relativePoint` defaults to `point`; `relativeTo` is `$parent`-substituted and
   * passed BY NAME, letting the object model resolve it (and fall back to the parent if it cannot).
   */
  private applyAnchors(element: XmlElement, wrapper: LuaRef, parentName: string, dbg: string): void {
    if (attrBool(element, 'setAllPoints')) {
      this.callMethod(wrapper, 'SetAllPoints', [], dbg);
    }
    // An element's declared `<Anchors>` ARE its anchors -- they replace whatever it had, they do not
    // add to it. That only matters for a region whose CONSTRUCTOR gave it some: a button's state
    // textures and its label are born filling the button (`lua/methods/kinds.ts#fillParent`), so
    // `<ButtonText><Anchor point="CENTER"><Offset y="3">` (gluebuttons.xml, every glue button) left the
    // label carrying TOPLEFT, BOTTOMRIGHT *and* CENTER at once, and `resolveAnchors` then put every
    // button's caption somewhere off to one side of its art instead of on it.
    //
    // Cleared once, before the first declared anchor rather than per anchor, or the second `<Anchor>` of
    // a stretched pair would wipe out the first.
    const declared = childrenNamed(element, 'Anchors').some(
      (anchors) => childrenNamed(anchors, 'Anchor').length > 0,
    );
    if (declared) {
      this.callMethod(wrapper, 'ClearAllPoints', [], dbg);
    }
    for (const anchors of childrenNamed(element, 'Anchors')) {
      for (const anchor of childrenNamed(anchors, 'Anchor')) {
        const point = attr(anchor, 'point');
        if (point === undefined) {
          this.report.warnings.push(`${dbg}: <Anchor> with no point; skipped`);
          continue;
        }
        const relativePoint = attr(anchor, 'relativePoint') ?? point;
        const relativeTo = resolveName(attr(anchor, 'relativeTo'), parentName) ?? null;
        const offset = childrenNamed(anchor, 'Offset')[0];
        const { x, y } = offset === undefined ? {} : absDim(offset);
        this.callMethod(
          wrapper,
          'SetPoint',
          [point, relativeTo, relativePoint, x ?? 0, y ?? 0],
          dbg,
        );
      }
    }
  }

  /**
   * Step 5: `<Layers>`/`<Layer level=>`/`<Texture>`/`<FontString>`. Each region is created through the
   * OWNER (`wrapper:CreateTexture(name, layer)`) -- which is how the client creates one and the reason
   * `CreateFrame("Texture")` is an error in the first place.
   */
  private applyLayers(element: XmlElement, wrapper: LuaRef, selfName: string, dbg: string): void {
    for (const layers of childrenNamed(element, 'Layers')) {
      for (const layer of childrenNamed(layers, 'Layer')) {
        const level = attr(layer, 'level') ?? 'ARTWORK';
        for (const raw of layer.children) {
          const region = this.expandRegion(raw);
          const isTexture = region.tag.toLowerCase() === 'texture';
          const isFontString = region.tag.toLowerCase() === 'fontstring';
          if (!isTexture && !isFontString) {
            this.report.warnings.push(
              `${dbg}: <Layer> child <${region.tag}> is neither a Texture nor a FontString; skipped`,
            );
            continue;
          }
          const method = isTexture ? 'CreateTexture' : 'CreateFontString';
          const name = resolveName(attr(region, 'name'), selfName) ?? null;
          const regionWrapper = this.callForWidget(wrapper, method, [name, level], dbg);
          if (regionWrapper === null) {
            continue;
          }
          try {
            if (attrBool(region, 'hidden')) {
              this.callMethod(regionWrapper, 'Hide', [], dbg);
            }
            const alpha = num(attr(region, 'alpha'));
            if (alpha !== undefined) {
              this.callMethod(regionWrapper, 'SetAlpha', [alpha], dbg);
            }
            this.applyRegionLayout(region, regionWrapper, selfName, dbg);
            if (isFontString) {
              this.applyFontStringFont(region, regionWrapper, dbg);
            }
            this.applyRegionVisual(region, regionWrapper, isTexture, dbg);
          } finally {
            this.rt.vm.unref(regionWrapper);
          }
        }
      }
    }
  }

  /**
   * Step 5, continued: a frame's DIRECT-child `<FontString>`, outside any `<Layers>` -- the engine's
   * "special" font string (an EditBox's text font, a message frame's line font), which real FrameXML
   * attaches at OVERLAY.
   *
   * ON AN `<EditBox>`, this pass is also the ADOPTION: the FIRST such child is handed to the box as
   * its text region (`SetTextRegion`), which is what the client's engine does implicitly and what the
   * reference does under the name `adopt_text_region`. `accountlogin.xml:234` is the shape --
   * `<FontString inherits="GlueEditBoxFont"/>`, unnamed, no size, no anchors: a font DECLARATION for
   * text the engine draws inside the box's `<TextInsets>`, not a region with a place of its own. The
   * anchors come from the insets (`kinds.ts#anchorTextRegion`), which is why nothing is lost by this
   * element having none.
   *
   * FROM THE DECLARED CHILD, never by searching the tree -- the reference records a find-first
   * adoption that reached into a `<Layers>` block and took a chat header, so typing overwrote the
   * label. `element.children` here is direct children only, and the first is the one the engine takes.
   */
  private applySpecialFontStrings(
    element: XmlElement,
    wrapper: LuaRef,
    selfName: string,
    dbg: string,
  ): void {
    const isEditBox = element.tag.toLowerCase() === 'editbox';
    let adopted = false;
    for (const raw of element.children) {
      if (raw.tag.toLowerCase() !== 'fontstring') {
        continue;
      }
      const region = this.expandRegion(raw);
      const name = resolveName(attr(region, 'name'), selfName) ?? null;
      const regionWrapper = this.callForWidget(wrapper, 'CreateFontString', [name, 'OVERLAY'], dbg);
      if (regionWrapper === null) {
        continue;
      }
      try {
        this.applyRegionLayout(region, regionWrapper, selfName, dbg);
        this.applyFontStringFont(region, regionWrapper, dbg);
        this.applyRegionVisual(region, regionWrapper, false, dbg);
        if (isEditBox && !adopted) {
          this.callMethod(wrapper, 'SetTextRegion', [regionWrapper], dbg);
          adopted = true;
        }
      } finally {
        this.rt.vm.unref(regionWrapper);
      }
    }
    // The case that has no font at all to draw with. Reported here rather than for every EditBox,
    // because this IS the one where nothing renders the typed text -- `resolveSprite` (`screens.ts`)
    // rasterizes glyphs only for `kind === 'fontstring'`, so a box with no adopted region has no
    // glyphs anywhere.
    if (isEditBox && !adopted) {
      this.warnOnce(
        'editbox:no-text-region',
        `${dbg}: an <EditBox> with no direct-child <FontString> has no text region to adopt, and nothing else renders an editbox widget's typed text -- this box draws its border and nothing typed`,
      );
    }
  }

  /**
   * A region's own geometry: `<Size>` (all of them, last winning, same rule as a frame's),
   * `justifyH`/`justifyV`, the `setAllPoints` shorthand, and `<Anchors>`. `relativeTo` substitutes
   * `$parent` against the OWNING frame's name -- a region's parent is the frame that created it.
   */
  private applyRegionLayout(
    region: XmlElement,
    wrapper: LuaRef,
    ownerName: string,
    dbg: string,
  ): void {
    this.applySize(region, wrapper, dbg);
    const justifyH = attr(region, 'justifyH');
    if (justifyH !== undefined) {
      this.callMethod(wrapper, 'SetJustifyH', [justifyH], dbg);
    }
    const justifyV = attr(region, 'justifyV');
    if (justifyV !== undefined) {
      this.callMethod(wrapper, 'SetJustifyV', [justifyV], dbg);
    }
    this.applyAnchors(region, wrapper, ownerName, dbg);
  }

  /**
   * A region's paint: a Texture's `file=`/`<Color>`/`<TexCoords>`/`alphaMode`, a FontString's `text=`
   * and `<Color>`.
   *
   * Divergence from the reference, on purpose: it applies a FontString's `<Color>` with
   * `SetVertexColor`, whose engine tints text the same way. Ours calls `SetTextColor`, because in this
   * renderer a font string's colour is a `FontSpec` field read when the glyphs are RASTERIZED
   * (`text.ts`), and `SetTextColor` is also what creates that spec -- a `SetVertexColor` on a font
   * string with no spec yet would tint a texture that never gets made.
   */
  private applyRegionVisual(
    region: XmlElement,
    wrapper: LuaRef,
    isTexture: boolean,
    dbg: string,
  ): void {
    // The LAST <Color>, for the same reason as <Size>: a templated region's own colour must beat the
    // template's.
    const colors = childrenNamed(region, 'Color');
    const color = colors.length > 0 ? colorOf(colors[colors.length - 1]) : null;

    if (!isTexture) {
      const text = attr(region, 'text');
      if (text !== undefined) {
        this.callMethod(wrapper, 'SetText', [this.resolveText(text)], dbg);
      }
      if (color !== null) {
        this.callMethod(wrapper, 'SetTextColor', [color[0], color[1], color[2]], dbg);
      }
      return;
    }

    const file = attr(region, 'file');
    if (file !== undefined) {
      this.callMethod(wrapper, 'SetTexture', [file], dbg);
      if (color !== null) {
        // A texture with BOTH a file and a <Color> is a tint, not a fill.
        this.callMethod(wrapper, 'SetVertexColor', [color[0], color[1], color[2]], dbg);
      }
    } else if (color !== null) {
      // No file: a solid colour quad, which is the numeric form of SetTexture.
      this.callMethod(wrapper, 'SetTexture', [color[0], color[1], color[2], color[3]], dbg);
    }

    const texCoords = texCoordsOf(region);
    if (texCoords !== null) {
      this.callMethod(wrapper, 'SetTexCoord', texCoords, dbg);
    }
    const alphaMode = attr(region, 'alphaMode');
    if (alphaMode !== undefined) {
      this.callMethod(wrapper, 'SetBlendMode', [alphaMode], dbg);
    }
  }

  /**
   * A `<FontString>`'s font.
   *
   * The reference calls `SetFontObject(name)` and then `SetFont` for the element's own overrides. This
   * runtime has no live font-object registry for `SetFontObject` to consult (it is a warn-once stub),
   * so the loader resolves the object HERE -- flattening the named `<Font>`'s `inherits=` chain
   * through the font registry -- and issues ONE `SetFont` from the merged values. One call rather than
   * two also avoids a trap: our `SetFont` needs a real font FILE, so an element that overrides only
   * `<FontHeight>` must still pass the inherited face, or the override is dropped with a warning
   * about a font file of `''`.
   */
  private applyFontStringFont(region: XmlElement, wrapper: LuaRef, dbg: string): void {
    const resolved = this.resolveFont(region, dbg);
    if (resolved.file !== undefined) {
      this.callMethod(wrapper, 'SetFont', [resolved.file, resolved.height ?? null, resolved.outline ?? null], dbg);
    } else if (resolved.height !== undefined || resolved.outline !== undefined) {
      this.warnOnce(
        'font:no-face',
        `${dbg}: a <FontString> sets a height/outline with no font face anywhere in its inherits chain; SetFont needs a face`,
      );
    }
    // The font object's colour and justification.
    //
    // ORDER, precisely, because the two halves differ and both match the reference: this pass runs
    // AFTER `applyRegionLayout` and BEFORE `applyRegionVisual`, so the font object's `justifyH`
    // OVERRIDES an element-level `justifyH="LEFT"` (the layout pass already applied it), while an
    // element-level `<Color>` overrides the object's (the visual pass has not run yet).
    if (resolved.color !== undefined) {
      const [r, g, b] = resolved.color;
      this.callMethod(wrapper, 'SetTextColor', [r, g, b], dbg);
    }
    if (resolved.justifyH !== undefined) {
      this.callMethod(wrapper, 'SetJustifyH', [resolved.justifyH], dbg);
    }
  }

  /** The element's own font values layered over its inherited font object's. */
  private resolveFont(region: XmlElement, dbg: string): FontResolution {
    const resolution: FontResolution = {};
    const inherits = attr(region, 'inherits');
    if (inherits !== undefined) {
      for (const raw of inherits.split(',')) {
        const name = raw.trim();
        if (name === '') {
          continue;
        }
        if (!this.rt.fonts.has(name)) {
          // Not necessarily wrong: the same attribute names an element TEMPLATE on some regions, and
          // `expandRegion` has already spliced that case in.
          if (!this.rt.templates.has(name)) {
            this.warnOnce(
              `font:${name}`,
              `${dbg}: inherits="${name}" names neither a registered <Font> nor a template; ignored`,
            );
          }
          continue;
        }
        Object.assign(resolution, this.readFont(name));
      }
    }

    const file = attr(region, 'font');
    if (file !== undefined) {
      resolution.file = file;
    }
    const heights = childrenNamed(region, 'FontHeight');
    const height = heights.length > 0 ? absValue(heights[heights.length - 1]) : undefined;
    if (height !== undefined) {
      resolution.height = height;
    }
    const outline = attr(region, 'outline');
    if (outline !== undefined) {
      resolution.outline = outline;
    }
    return resolution;
  }

  /** A registered `<Font>`, flattened through its `inherits=` chain, as font values. */
  private readFont(name: string): FontResolution {
    // A synthetic `<Font inherits="name"/>` is the shortest way to ask `TemplateRegistry` for the
    // flattened chain: `expand` resolves the reference and merges inherited-first, so the values here
    // are already the whole chain with the leaf winning.
    const reference: XmlElement = {
      tag: 'Font',
      attrs: new Map([['inherits', name]]),
      children: [],
      body: '',
    };
    const warnings: string[] = [];
    const merged = this.rt.fonts.expand(reference, warnings);
    for (const warning of warnings) {
      this.warnOnce(`font-expand:${warning}`, warning);
    }

    const resolution: FontResolution = {};
    const file = attr(merged, 'font');
    if (file !== undefined) {
      resolution.file = file;
    }
    const heights = childrenNamed(merged, 'FontHeight');
    if (heights.length > 0) {
      const height = absValue(heights[heights.length - 1]);
      if (height !== undefined) {
        resolution.height = height;
      }
    }
    const outline = attr(merged, 'outline');
    if (outline !== undefined) {
      resolution.outline = outline;
    }
    const colors = childrenNamed(merged, 'Color');
    if (colors.length > 0) {
      resolution.color = colorOf(colors[colors.length - 1]);
    }
    const justifyH = attr(merged, 'justifyH');
    if (justifyH !== undefined) {
      resolution.justifyH = justifyH;
    }
    return resolution;
  }

  /**
   * Step 5, continued: `<Backdrop>` -- the tiled background plus the eight-piece border, built as the
   * same table a Lua `SetBackdrop` call would pass.
   *
   * `SetBackdrop` is REAL (`lua/methods/frame.ts`): it writes a `BackdropDef` and the nine-slice draws.
   * It was a warn-once no-op when this pass was written, on the stated grounds that a backdrop needs art
   * resolved through `GlueArt` and `MethodContext` cannot reach one -- which turned out to have a hole
   * in it, since a sprite key may simply BE the path (`runtime.ts`'s art discovery). Its two COLOUR
   * companions are still stubs: `BackdropDef` has no tint field, so `<Color>`/`<BorderColor>` below are
   * issued and named in the report rather than dropped.
   */
  private applyBackdrop(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    const backdrop = childrenNamed(element, 'Backdrop')[0];
    if (backdrop === undefined) {
      return;
    }

    const vm = this.rt.vm;
    const table = vm.newTable();
    try {
      const bgFile = attr(backdrop, 'bgFile');
      if (bgFile !== undefined) {
        vm.setTableField(table, 'bgFile', bgFile);
      }
      const edgeFile = attr(backdrop, 'edgeFile');
      if (edgeFile !== undefined) {
        vm.setTableField(table, 'edgeFile', edgeFile);
      }
      if (attrBool(backdrop, 'tile')) {
        vm.setTableField(table, 'tile', true);
      }
      const edgeSize = childrenNamed(backdrop, 'EdgeSize')[0];
      if (edgeSize !== undefined) {
        const value = absValue(edgeSize);
        if (value !== undefined) {
          vm.setTableField(table, 'edgeSize', value);
        }
      }
      const tileSize = childrenNamed(backdrop, 'TileSize')[0];
      if (tileSize !== undefined) {
        const value = absValue(tileSize);
        if (value !== undefined) {
          vm.setTableField(table, 'tileSize', value);
        }
      }
      const insetsElement = childrenNamed(backdrop, 'BackgroundInsets')[0];
      if (insetsElement !== undefined) {
        const source = childrenNamed(insetsElement, 'AbsInset')[0] ?? insetsElement;
        const insets = vm.newTable();
        try {
          for (const side of ['left', 'right', 'top', 'bottom']) {
            const value = num(attr(source, side));
            if (value !== undefined) {
              vm.setTableField(insets, side, value);
            }
          }
          vm.setTableField(table, 'insets', insets);
        } finally {
          vm.unref(insets);
        }
      }
      this.callMethod(wrapper, 'SetBackdrop', [table], dbg);
    } finally {
      vm.unref(table);
    }

    const color = childrenNamed(backdrop, 'Color')[0];
    if (color !== undefined) {
      this.callMethod(wrapper, 'SetBackdropColor', colorOf(color), dbg);
    }
    const borderColor = childrenNamed(backdrop, 'BorderColor')[0];
    if (borderColor !== undefined) {
      this.callMethod(wrapper, 'SetBackdropBorderColor', colorOf(borderColor), dbg);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Per-kind LoadXML extras
  // ---------------------------------------------------------------------------------------------

  private applyPerKind(element: XmlElement, wrapper: LuaRef, selfName: string, dbg: string): void {
    const tag = element.tag.toLowerCase();
    if (tag === 'button' || tag === 'checkbutton') {
      this.applyButton(element, wrapper, tag === 'checkbutton', selfName, dbg);
    } else if (tag === 'editbox') {
      this.applyEditBox(element, wrapper, dbg);
    } else if (tag === 'statusbar' || tag === 'slider') {
      // Divergence from the reference, stated: it maps `<StatusBar>`/`<Slider>` LoadXML
      // (minValue/maxValue/orientation/<BarTexture>/<ThumbTexture>/...) onto a real bar and thumb.
      // `lua/methods/scroll.ts` now gives SLIDER its VALUE methods -- which is what the client's own
      // scroll code reads and what eleven of the manifest's load errors turned on -- but nothing in
      // `widget.ts` draws a slider track or a status bar's fill, and STATUSBAR still has no methods at
      // all. Emitting the calls would produce a warning per missing method per document; one line
      // naming the whole gap is the honest version.
      this.warnOnce(
        `kind:${tag}`,
        `<${element.tag}> bar/thumb attributes are ignored: nothing in this renderer draws a ${element.tag}'s track or fill${tag === 'slider' ? ' (its value methods are real; only the art is missing)' : ', and this object model registers no StatusBar methods at all'} (first: ${dbg})`,
      );
    } else if (tag === 'scrollframe') {
      // The counterpart line for the class that just gained methods: a `<ScrollFrame>`'s scroll VALUES
      // are tracked for real (`lua/methods/scroll.ts`), and its pixels are not -- `widget.ts` cannot
      // clip a frame's children, so an offset scroll child would draw outside its viewport instead of
      // scrolling inside it, and the child is deliberately left where it is. Without this line the
      // whole gap is invisible: every method the client calls now answers successfully.
      this.warnOnce(
        'kind:scrollframe',
        `<ScrollFrame> scrolling is bookkeeping only: the scroll offsets and ranges are real, but nothing in this renderer clips a viewport or moves a scroll child, so the content does not scroll (first: ${dbg})`,
      );
    }
  }

  /**
   * `<Button>`/`<CheckButton>`: the state textures, the checked flag, `<ButtonText>` and `text=`.
   *
   * THE RULE HERE: a state texture is CREATED THROUGH THE SETTER and then DECORATED THROUGH THE
   * GETTER. `SetNormalTexture(file)` is what makes the region exist -- the setter is its lazy
   * constructor -- so a `<Size>`/`<Anchors>`/`<TexCoords>` on the XML element has to be applied to
   * whatever `GetNormalTexture()` hands back afterwards. Building a region and then setting the file
   * on it would create a second one that nothing draws.
   */
  private applyButton(
    element: XmlElement,
    wrapper: LuaRef,
    isCheck: boolean,
    selfName: string,
    dbg: string,
  ): void {
    const slots: Array<[string, string, string]> = [
      ['NormalTexture', 'SetNormalTexture', 'GetNormalTexture'],
      ['PushedTexture', 'SetPushedTexture', 'GetPushedTexture'],
      ['DisabledTexture', 'SetDisabledTexture', 'GetDisabledTexture'],
      ['HighlightTexture', 'SetHighlightTexture', 'GetHighlightTexture'],
    ];
    if (isCheck) {
      slots.push(['CheckedTexture', 'SetCheckedTexture', 'GetCheckedTexture']);
      // `DisabledCheckedTexture` has NEITHER half in this object model -- unlike the four above, whose
      // getters Task 7 added, this one would need a new region slot and a new visibility rule
      // (shown only while checked AND disabled). Listed anyway, so `callMethod` names both missing
      // methods in the report instead of the element vanishing without a trace.
      slots.push(['DisabledCheckedTexture', 'SetDisabledCheckedTexture', 'GetDisabledCheckedTexture']);
    }

    for (const [tag, setter, getter] of slots) {
      for (const raw of childrenNamed(element, tag)) {
        // EXPANDED, like a `<Layers>` region: a state texture routinely carries no `file=` of its own
        // and inherits a virtual `<Texture>` that has one -- `GlueButtonTemplateBlue` is
        // `<NormalTexture inherits="GluePanelButtonUpTextureBlue"/>`, and that template holds both the
        // sheet and the `<TexCoords>` picking the button out of it (gluebuttons.xml). Reading `file=`
        // off the unexpanded element found nothing, so EVERY glue button drew as a bare caption with no
        // art behind it -- on the login screen, all seven of them.
        const texture = this.expandRegion(raw);
        const file = attr(texture, 'file');
        const colorElement = childrenNamed(texture, 'Color')[0];
        // The setter runs even for the colour-only form, with an empty file: it is what creates the
        // slot, and the colour is then applied to the region through `SetTexture(r,g,b,a)` below --
        // the state setters take a sprite key only, never the numeric fill form.
        this.callMethod(wrapper, setter, [file ?? ''], dbg);

        const region = this.callForWidget(wrapper, getter, [], dbg);
        if (region === null) {
          continue;
        }
        try {
          if (file === undefined && colorElement !== undefined) {
            this.callMethod(region, 'SetTexture', colorOf(colorElement), dbg);
          }
          const alphaMode = attr(texture, 'alphaMode');
          if (alphaMode !== undefined) {
            this.callMethod(region, 'SetBlendMode', [alphaMode], dbg);
          }
          this.applyRegionLayout(texture, region, selfName, dbg);
          const texCoords = texCoordsOf(texture);
          if (texCoords !== null) {
            this.callMethod(region, 'SetTexCoord', texCoords, dbg);
          }
          // From the RAW element, not the expanded one: `merge` splices `name` through like any other
          // attribute, so an inheriting `<NormalTexture inherits="GluePanelButtonUpTextureBlue"/>`
          // comes out of `expand` wearing the TEMPLATE's name -- which would publish every blue
          // button's normal texture under that one global and warn about the clash for all but the
          // first. Only a name the element declares ITSELF is a name.
          this.publishRegion(raw, region, selfName, dbg);
        } finally {
          this.rt.vm.unref(region);
        }
      }
    }

    if (isCheck) {
      const checked = attr(element, 'checked');
      if (checked !== undefined) {
        this.callMethod(wrapper, 'SetChecked', [/^(true|1)$/i.test(checked.trim())], dbg);
      }
    }

    for (const buttonText of childrenNamed(element, 'ButtonText')) {
      // `SetText` runs EVEN WITH NO TEXT: it is the label slot's lazy constructor, and the geometry
      // below has to land on a real region. Skipping it is what makes a labelled button centre its
      // text over its whole face instead of where the XML put it.
      const caption = attr(buttonText, 'text');
      this.callMethod(wrapper, 'SetText', [caption === undefined ? '' : this.resolveText(caption)], dbg);
      const label = this.callForWidget(wrapper, 'GetFontString', [], dbg);
      if (label === null) {
        continue;
      }
      try {
        this.applyRegionLayout(buttonText, label, selfName, dbg);
        this.publishRegion(buttonText, label, selfName, dbg);
      } finally {
        this.rt.vm.unref(label);
      }
    }

    const text = attr(element, 'text');
    if (text !== undefined) {
      this.callMethod(wrapper, 'SetText', [this.resolveText(text)], dbg);
    }

    this.applyButtonFonts(element, wrapper, dbg);
  }

  /**
   * `<NormalFont>`/`<HighlightFont>`/`<DisabledFont>` on a button: the font OBJECT its caption uses.
   *
   * `style=`, NOT `inherits=`, is the attribute that carries the name, and reading only the latter is
   * what made every glue button's caption white FRIZQT 12 instead of `GlueFontNormal`'s outlined gold.
   * All 26 of these elements in the loaded manifest spell it `style=` and not one spells it `inherits=`
   * (gluebuttons.xml, gluetemplates.xml, accountlogin.xml, gluedropdownmenutemplates.xml) -- the
   * client's `UI.xsd` gives `ButtonStyle` a `style` attribute and no `inherits`, because unlike a
   * `<FontString>` this element is not a region that could inherit a template; it is a reference to a
   * font object and nothing else. Both are read here anyway: `inherits=` costs a line and the day some
   * document uses it, it works.
   *
   * NORMAL IS APPLIED FOR REAL, the other two are not, and the split is the object model's:
   *
   *  - The normal font is the caption's font, full stop, so it is resolved the same way a
   *    `<FontString inherits="...">` is -- through `readFont`'s flattened `<Font>` chain -- and pushed
   *    onto the label region `GetFontString()` hands back. That reuses `applyFontStringFont` whole,
   *    including its "a height with no face" warning and its colour/justification ordering, rather
   *    than growing a second font path that could drift from the first.
   *  - Highlight and disabled are PER-STATE fonts, and `FontSpec` has one font per region with no
   *    notion of state. So those two are still issued as `SetHighlightFontObject`/
   *    `SetDisabledFontObject`, which are declared stubs -- and that is the point: issuing them is what
   *    puts a line in the load report naming the gap. Before this, the calls never happened at all,
   *    so a wrong font on every hovered and every disabled caption was completely silent.
   */
  private applyButtonFonts(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    for (const [tag, method] of [
      ['NormalFont', 'SetNormalFontObject'],
      ['HighlightFont', 'SetHighlightFontObject'],
      ['DisabledFont', 'SetDisabledFontObject'],
    ] as const) {
      for (const font of childrenNamed(element, tag)) {
        const name = attr(font, 'style') ?? attr(font, 'inherits');
        if (name === undefined) {
          continue;
        }
        if (tag !== 'NormalFont') {
          this.callMethod(wrapper, method, [name], dbg);
          continue;
        }
        // `GetFontString()` returns nil for a button that has never been given a caption -- the label
        // is `SetText`'s lazy creation (`lua/methods/kinds.ts`), and a font object with no text to
        // draw has nothing to land on. Not a gap: a captionless button has no caption to get wrong.
        const label = this.callForWidget(wrapper, 'GetFontString', [], dbg);
        if (label === null) {
          continue;
        }
        try {
          // A synthetic `<FontString inherits="name"/>`: the shortest honest way to say "this region's
          // font is that font object", and it goes through the ONE font path the loader has.
          this.applyFontStringFont(
            { tag: 'FontString', attrs: new Map([['inherits', name]]), children: [], body: '' },
            label,
            dbg,
          );
        } finally {
          this.rt.vm.unref(label);
        }
      }
    }
  }

  /**
   * A NAMED state texture or button label gets its resolved name -- in BOTH name spaces.
   *
   * These regions are created by a setter that takes no name, so `FrameRegistry` never learns one --
   * but real FrameXML addresses them by global (`getglobal(tabName.."Text")` in the reference kit's
   * own tab code), so the name has to reach `_G`.
   *
   * `_G` ALONE IS NOT ENOUGH, and that was a real defect rather than a nicety. This runtime has two
   * name spaces and only one of them was being filled: `SetPoint`'s `relativeTo` may be a frame NAME
   * STRING, which `methods/region.ts` resolves through `registry.byName`. `realmlist.xml:221` anchors
   * every realm row's type column to `self:GetName().."NormalText"` by exactly that route, found
   * nothing, and fell back to the parent -- which put the type, character-count and population of every
   * row off the right edge of the panel. `registry.publishName` is the other half; it also makes
   * `GetName()` answer, as it does in the client, and hands the teardown path the name to clear.
   *
   * THE TWO ARE TAKEN TOGETHER OR NOT AT ALL, which is why the registry name is claimed after the `_G`
   * check below rather than before it. Teardown clears the global a frame OWNS
   * (`object.ts`'s release listener, keyed off `registry.nameOf`), so a region that took the registry
   * name while the global belonged to something else would have `reset()` null out a stranger's
   * global -- a FrameXML function, in the case the warning below exists for.
   */
  private publishRegion(element: XmlElement, region: LuaRef, selfName: string, dbg: string): void {
    const name = resolveName(attr(element, 'name'), selfName);
    if (name === undefined) {
      return;
    }
    const existing = this.rt.vm.getGlobal(name);
    if (this.rt.vm.isRef(existing)) {
      // `getGlobal` mints a handle for a table- or function-valued global; discarding it without
      // releasing pins a registry slot per named region for the life of the VM.
      this.rt.vm.unref(existing);
    }
    if (existing !== undefined) {
      // Non-overwriting, like `object.ts`'s own name publication: the first thing to claim a global
      // keeps it, so a region never clobbers a FrameXML function that happens to share its name.
      this.warnOnce(
        `global:${name}`,
        `${dbg}: '${name}' is already a global; this region is unreachable by name (the setter created it unnamed, so GetName() is nil too)`,
      );
      return;
    }
    this.rt.vm.setGlobal(name, region);
    const id = this.rt.ctx.frameIdOf(region);
    if (id !== null) {
      this.rt.ctx.registry.publishName(id, name);
    }
  }

  /**
   * `<EditBox>`: the letter cap, the text insets, and the config flags.
   *
   * The text REGION is not here: it is the declared direct-child `<FontString>`, adopted by
   * `applySpecialFontStrings` above, which is also where the "this box has none" warning lives now.
   * `SetTextInsets` below is what positions that region, and it re-anchors an already-adopted one, so
   * the two passes are order-independent.
   */
  private applyEditBox(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    const letters = num(attr(element, 'letters'));
    if (letters !== undefined) {
      this.callMethod(wrapper, 'SetMaxLetters', [letters], dbg);
    }
    const insetsElement = childrenNamed(element, 'TextInsets')[0];
    if (insetsElement !== undefined) {
      const source = childrenNamed(insetsElement, 'AbsInset')[0] ?? insetsElement;
      const side = (key: string) => num(attr(source, key)) ?? 0;
      this.callMethod(
        wrapper,
        'SetTextInsets',
        [side('left'), side('right'), side('top'), side('bottom')],
        dbg,
      );
    }
    // A flag absent from the XML keeps the widget's constructed default, which is how the reference
    // reads them too. `numeric`/`multiLine`/`ignoreArrows` have no setter here; `callMethod` names
    // each missing one once for the whole load.
    for (const [name, method] of [
      ['autoFocus', 'SetAutoFocus'],
      ['numeric', 'SetNumeric'],
      ['password', 'SetPassword'],
      ['multiLine', 'SetMultiLine'],
      ['ignoreArrows', 'SetIgnoreArrows'],
    ] as const) {
      if (attrBool(element, name)) {
        this.callMethod(wrapper, method, [true], dbg);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Scripts, children, OnLoad
  // ---------------------------------------------------------------------------------------------

  /**
   * Step 6: `<Scripts>` -> `SetScript` per handler. Returns whether an `OnLoad` was installed, so the
   * caller can fire it after the subtree is built.
   *
   * Divergence from the reference, and a deliberate one: it captures the compiled `OnLoad` FUNCTION
   * and calls that exact value later. This returns only the fact that a handler exists and fires it by
   * NAME through `invokeScriptHandler`, for two reasons. It keeps the calling convention
   * (`this`/`event`/`arg1` set, positional arguments passed, both restored even on error) in the one
   * place that owns it -- `lua/scripts.ts` -- rather than half-reimplemented here. And firing the SLOT
   * matches what the client does: the observable difference is a child whose `OnLoad` rewires its
   * parent's `OnLoad` before the parent fires, and in that case the client runs the new handler too.
   */
  private applyScripts(element: XmlElement, wrapper: LuaRef, dbg: string): boolean {
    let hasOnLoad = false;
    for (const scripts of childrenNamed(element, 'Scripts')) {
      for (const handler of scripts.children) {
        const name = handler.tag;
        const functionAttr = attr(handler, 'function') ?? null;
        const compiled = compileScriptHandler(this.rt.vm, name, handler.body, functionAttr, dbg);
        if (compiled === null) {
          // `compileScriptHandler` has already logged WHY to the console and does not hand the message
          // back, so what is left here is the DISTINCTION between its two failures, which the report
          // must not blur. An empty body with a `function=` is a FORWARD REFERENCE: a global that the
          // Lua file for this screen defines later in the load order, which is a deduped gap and not a
          // drop -- making it an error fills the report with noise that resolves itself. A body that
          // failed to compile really did drop a handler.
          if (handler.body.trim() === '' && functionAttr !== null) {
            this.warnOnce(
              `fn:${functionAttr}`,
              `${dbg}: <${name} function="${functionAttr}"> names no global function (yet); no handler installed`,
            );
          } else {
            this.report.errors.push(`${dbg}: <${name}> produced no handler; see the console for why`);
          }
          continue;
        }
        // `SetScript` retains its own handle, so the owned one from the compiler is released here.
        this.callMethod(wrapper, 'SetScript', [name, compiled], dbg);
        this.rt.vm.unref(compiled);
        if (name.toLowerCase() === 'onload') {
          hasOnLoad = true;
        }
      }
    }
    return hasOnLoad;
  }

  /**
   * Step 7: nested `<Frames>`. Children are materialized -- and their `OnLoad`s fired -- BEFORE this
   * frame's own, which is the bottom-up rule.
   *
   * `virtual` is read on the PRE-EXPANSION child, for the reason the file header gives: after
   * expansion an inheriting child carries its template's `virtual="true"` and would be filed away as a
   * template instead of built. A genuinely virtual nested child is registered rather than materialized
   * (the reference materializes every `<Frames>` child unconditionally; building one would publish a
   * global name that the real instance inheriting it later wants).
   */
  private applyChildFrames(
    element: XmlElement,
    wrapper: LuaRef,
    selfName: string,
    sourceName: string,
  ): void {
    for (const frames of childrenNamed(element, 'Frames')) {
      for (const child of frames.children) {
        if (attrBool(child, 'virtual')) {
          this.rt.templates.register(child);
          continue;
        }
        this.materialize(this.expand(child), wrapper, selfName, sourceName);
      }
    }
  }

  /**
   * Step 7, continued: `<ScrollChild>` -- the single frame a `<ScrollFrame>` scrolls.
   *
   * A different container from `<Frames>`, and it was being dropped entirely, which cost more than the
   * frames themselves. The client addresses these children by global from Lua like any other:
   * `AccountLogin_ShowUserAgreements` calls `TOSText:Hide()` (accountlogin.lua:259) and
   * `GlueScrollFrame_Update` reads `_G[frameName.."ScrollChildFrame"]` -- so an absent scroll child is
   * a nil global in the client's own code, not a missing rectangle. It also decides whether
   * `GetVerticalScrollRange` can mean anything: the range IS the child's overhang
   * (`lua/methods/scroll.ts`), and with no child every scroll frame's range is flat zero.
   *
   * ANCHORED TOPLEFT-TO-TOPLEFT when it declares no anchors of its own, which none of the twelve in the
   * loaded manifest does. That is not a default invented here -- a scroll child's position is not the
   * document's to choose in the first place, it is the viewport's origin plus the scroll offset, and the
   * engine places it. Left unanchored it would fall wherever `layout.ts` puts an anchorless widget.
   *
   * ONE child, and the first: `<ScrollChild>` is singular in the schema, and a scroll frame has exactly
   * one thing it scrolls. A second is reported rather than silently built into the same parent.
   */
  private applyScrollChild(
    element: XmlElement,
    wrapper: LuaRef,
    selfName: string,
    sourceName: string,
    dbg: string,
  ): void {
    const blocks = childrenNamed(element, 'ScrollChild');
    if (blocks.length === 0) {
      return;
    }
    if (blocks.length > 1 || blocks[0].children.length > 1) {
      this.report.warnings.push(
        `${dbg}: a <ScrollFrame> declares more than one scroll child; only the first is built`,
      );
    }
    const declared = blocks[0].children[0];
    if (declared === undefined) {
      return;
    }
    const childId = this.materialize(this.expand(declared), wrapper, selfName, sourceName);
    if (childId === null) {
      return;
    }
    const registry = this.rt.ctx.registry;
    const child = registry.widget(childId);
    const viewportId = this.rt.ctx.frameIdOf(wrapper);
    const viewport = viewportId === null ? null : registry.widget(viewportId);
    if (child !== null && viewport !== null && child.anchors.length === 0) {
      child.setAnchors({
        point: 'TOPLEFT',
        relativePoint: 'TOPLEFT',
        relativeTo: viewport.id,
        x: 0,
        y: 0,
      });
    }
    // The child's PERMANENT wrapper handle, deliberately not released: `ctx.wrapper` hands back the
    // frame's own table, which `FrameRegistry` owns for the life of the frame. The method boundary
    // mints and frees its own fresh handle for the argument it sees (`object.ts`'s ownership note), so
    // this is the same shape as `SetTextRegion`'s call and not a double free.
    this.callMethod(wrapper, 'SetScrollChild', [this.rt.ctx.wrapper(childId)], dbg);
  }

  /** Step 8: this frame's `OnLoad`, through the one dispatch path (`lua/scripts.ts`). */
  private fireOnLoad(wrapper: LuaRef, dbg: string): void {
    const id = this.rt.ctx.frameIdOf(wrapper);
    if (id === null) {
      this.report.errors.push(`${dbg}: OnLoad: the wrapper is not a live frame`);
      return;
    }
    const error = invokeScriptHandler(this.rt.ctx, id, 'OnLoad');
    if (error !== null) {
      this.report.errors.push(`${dbg}: OnLoad: ${error.message}`);
    }
  }
}
