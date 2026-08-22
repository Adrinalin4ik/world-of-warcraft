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
import { NOT_IMPLEMENTED, warnOnce } from './lua/methods/region';
import { compileScriptHandler, invokeScriptHandler } from './lua/scripts';
import { DEFAULT_PARENT_NAME, TemplateRegistry, resolveName } from './templates';
import { FontResolution, outlineFlags, readFontObject } from './fonts';
import {
  ParsedDocument,
  XmlElement,
  absDimension,
  absValue,
  attr,
  attrBool,
  childrenNamed,
  colorOf,
  num,
  parseXml,
} from './xml';

// Side-effect imports: the FRAME, MODEL, SCROLLFRAME/SLIDER and BUTTON/CHECKBUTTON/EDITBOX method
// tables (REGION and the leaves come in with `NOT_IMPLEMENTED` above). `object.ts` deliberately imports
// none of them, so
// SOMETHING has to, and this is the module that cannot function without the whole surface -- a
// forgotten import would show up as a document that materializes and then does nothing at all.
// Registering after a VM is installed is safe (`registerMethods` flushes the dispatch cache).
import './lua/methods/cooldown';
import './lua/methods/worldframe';
import './lua/methods/frame';
import './lua/methods/gametooltip';
import './lua/methods/kinds';
import './lua/methods/messageframe';
import {
  setMessageFrameDuration, setMessageFrameInsertMode, setMessageFrameMaxLines,
} from './lua/methods/messageframe';
import './lua/methods/model';
import './lua/methods/scroll';
import './lua/methods/statusbar';
// `lua/events.ts` registers `RegisterEvent`/`UnregisterEvent` on FRAME, and it was NOT in this list --
// only `runtime.ts` pulled it in, as a side effect of importing `fireEvent`. So any load that did not
// go through `runtime.ts` had no `RegisterEvent` at all.
//
// That is not hypothetical: it is what the FrameXML load survey measured before the instrument was
// corrected. `TextStatusBar.lua:3` and `UnitFrame.lua:209` both call `self:RegisterEvent(...)` from an
// `OnLoad`, so the miss produced 275 load errors across the manifest -- 115 of them in the 71-file
// prefix that reaches `TargetFrame.xml`, including every health and mana bar's `OnLoad`. Importing it
// here, beside the other method modules, is what makes "the methods are registered" a property of the
// loader rather than of whoever happened to boot it.
import './lua/events';

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

/**
 * The sanctioned way to build a runtime: two fresh registries around an installed object model.
 *
 * This is also where the object model gets its font-object door. `installObjectModel` leaves
 * `ctx.fontObject` null because it knows nothing about documents, and the font registry does not exist
 * until this line -- so the lookup is installed here, pointing at the registry the loads about to
 * happen will fill. Everything that resolves a font object at RUN time (`SetFontObject`,
 * `SetNormalFontObject` and the two per-state siblings) goes through it, so a name means the same
 * thing to Lua as it does to the loader. A `MethodContext` built without a runtime keeps null and those
 * methods report the gap instead of guessing.
 */
/**
 * The handlers whose mere DECLARATION makes a frame mouse-interactive.
 *
 * See the mouse-enable step at the end of `applyScripts` for the evidence and the citations. Compared
 * lower-cased because FrameXML is not consistent about handler-name casing between documents.
 *
 * `OnMouseWheel` is deliberately NOT here: the wheel is `EnableMouseWheel`, a separate flag in the
 * engine (`chatframe.lua:2550` calls it on its own), and nothing in this widget layer routes a wheel
 * event yet -- adding it would arm a frame for a mouse it does not otherwise take.
 */
const MOUSE_SCRIPTS = new Set([
  'onenter', 'onleave', 'onmousedown', 'onmouseup', 'onclick', 'ondoubleclick',
  'ondragstart', 'ondragstop', 'onreceivedrag',
]);

export function createFrameXmlRuntime(vm: LuaVM, ctx: MethodContext): FrameXmlRuntime {
  const fonts = new TemplateRegistry();
  ctx.fontObject = (name) => readFontObject(fonts, name, warnOnce);
  const runtime: FrameXmlRuntime = { vm, ctx, templates: new TemplateRegistry(), fonts };
  // The other door installed here, and for the same reason: `CreateFrame`'s 4th argument needs the
  // template registry that does not exist until this line. See `applyTemplateToFrame`.
  ctx.template = (frameId, templateName) => applyTemplateToFrame(runtime, frameId, templateName);
  return runtime;
}

/**
 * The loader in progress, if any -- so a template applied from Lua reports into the report of the load
 * that caused it.
 *
 * Almost every templated `CreateFrame` in the glue manifest happens DURING a load: it is an `OnLoad`
 * body, run by `loadDocument` itself (`GlueDropDownMenu.lua:159`, reached from
 * `AccountLoginDropDown`'s `OnLoad`). Those warnings and errors belong in that file's report lines,
 * not on the console where the report cannot see them -- the report is how this runtime's gaps are
 * counted at all. A call from OUTSIDE a load (a click, a timer) has no report to join, and
 * `applyTemplateToFrame` sends those lines to the console instead.
 *
 * Module-level, like `scripts.ts`'s error queue and for the same reason: the Lua call comes up through
 * `object.ts`, which knows nothing about documents, so there is no parameter to thread it through.
 * Loads never nest at this level (an `<Include>` reuses the same `DocumentLoader`).
 */
let activeLoader: DocumentLoader | null = null;

/**
 * Apply a registered template to a just-created frame, through the LOADER's own element pass.
 *
 * Reuse, deliberately, down to the report lines: this borrows the in-progress `DocumentLoader` when
 * there is one, so a `<Layers>` texture whose method this runtime lacks is warned about once for the
 * whole load whether the frame came from XML or from Lua. Outside a load there is nothing to borrow, so
 * a throwaway loader runs the same pass and its lines go to the console -- which is the only honest
 * place for them; inventing a report for a click would be a report nobody reads.
 *
 * NOTHING HERE THROWS, which is the rule the whole loader keeps -- and it matters more here than
 * anywhere, because this is called from inside `CreateFrame`. A raise would come out of the client's own
 * `CreateFrame(...)` call as a Lua error and take the enclosing handler down with it, turning an
 * incomplete template into a dead screen.
 */
function applyTemplateToFrame(
  runtime: FrameXmlRuntime,
  frameId: number,
  templateName: string,
): boolean {
  const borrowed = activeLoader;
  const loader = borrowed ?? new DocumentLoader(runtime, () => null);
  try {
    return loader.applyTemplate(frameId, templateName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = `CreateFrame("${templateName}"): applying the template raised: ${message}`;
    if (borrowed !== null) {
      borrowed.report.errors.push(line);
    } else {
      warnOnce(line);
    }
    return false;
  } finally {
    if (borrowed === null) {
      loader.finish();
      for (const warning of loader.report.warnings) {
        warnOnce(warning);
      }
      for (const error of loader.report.errors) {
        warnOnce(error);
      }
    }
  }
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
  const outer = activeLoader;
  activeLoader = loader;
  try {
    loader.loadDoc(doc, sourceName);
  } finally {
    activeLoader = outer;
    // Nothing in here throws by design, but the `CreateFrame` handle is held for the whole load and a
    // handle stranded by a bug of ours is a registry slot pinned for the life of the VM.
    loader.finish();
  }
  return loader.report;
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
          this.publishFontObject(item.element);
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
   * `SetHighlightFontObject`/`SetDisabledFontObject` exist so duck-typing sees the class correctly and
   * then return quietly, so without `NOT_IMPLEMENTED` (`lua/methods/region.ts`) this would report a
   * clean load of a screen missing every per-state caption font. A method that exists and RAISED is an
   * error: something was wrong with the document or with us.
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
    // `parent="Name"` -- the LoadXML attribute that says whose child a DOCUMENT-TOP-LEVEL frame is.
    //
    // It was ignored, and that was the single biggest visual defect in the world: every frame
    // declared at the top of its file with `parent="UIParent"` or `parent="CharacterFrame"` was built
    // under the document root instead, so it inherited neither its owner's SHOWN state nor its rect.
    // MEASURED (`W9-census.txt`, `/game?offline=1&ui=lua`): `PaperDollFrame`
    // (`paperdollframe.xml:229`, `parent="CharacterFrame"`) drew over the world although
    // `CharacterFrame` carries `hidden="true"` (`characterframe.xml:4`), and so did the whole of
    // `VideoOptionsFrame` and `AudioOptionsFrame`, which inherit `hidden="true"` from
    // `OptionsFrameTemplate` (`optionsframetemplates.xml:333`). 752 draw items, of which several
    // hundred were panels the player had not opened.
    //
    // Resolved through the Lua GLOBAL of that name, because that is exactly what the attribute means:
    // a named frame is a global, and the engine looks it up the same way. An unresolvable name is a
    // report line and the frame stays at the root -- a document that names a parent declared later in
    // the manifest is a real possibility and must not be silently reparented to nothing.
    //
    // TOP LEVEL ONLY (`parent === null`). A `parent=` on a NESTED element also has meaning in the
    // engine -- it is how a dropdown list escapes its owner -- and is deliberately still ignored
    // here, because a nested element's `$parent` name resolution and its `<Anchors>` are written
    // against the element it is nested in, and moving both at once is a second change with its own
    // failure mode. Declared, not forgotten.
    let effectiveParent = parent;
    let effectiveParentName = parentName;
    let borrowedParent: LuaRef | null = null;
    // Set when `parent="Name"` did NOT resolve: the frame is built at the root and then HIDDEN. See
    // `orphanHidden` below for why hiding it is the honest fallback and not a workaround.
    let orphaned = false;
    const declaredParent = parent === null ? attr(element, 'parent') : undefined;
    if (declaredParent !== undefined && declaredParent !== '') {
      const global = this.rt.vm.getGlobal(declaredParent);
      if (this.rt.vm.isRef(global)) {
        borrowedParent = global;
        effectiveParent = global;
        effectiveParentName = declaredParent;
      } else {
        orphaned = true;
        this.report.warnings.push(
          `${sourceName}:${attr(element, 'name') ?? `<${element.tag}>`}: ` +
            `parent="${declaredParent}" names no frame; built at the root and HIDDEN`,
        );
      }
    }

    // 1 - CreateFrame(type, resolvedName, parent), through the Lua global. AFTER the parent is
    // settled, because `$parent` in this frame's own name substitutes against it.
    const resolvedName = resolveName(attr(element, 'name'), effectiveParentName);
    const dbg = `${sourceName}:${resolvedName ?? `<${element.tag}>`}`;
    const wrapper = this.create(element.tag, resolvedName ?? null, effectiveParent, dbg);
    // `parentKey` HERE, not next to `decorate`, and the reason is ownership rather than order:
    // `borrowedParent` is released two lines down, so `effectiveParent` is a dangling handle after
    // that point for the `parent="Name"` case. This is also before `decorate`, which is what the
    // engine does -- the key exists for the whole subtree build, so a child's own `OnLoad` reaching
    // `self:GetParent().someKey` cannot race it.
    if (wrapper !== null) {
      this.applyParentKey(element, wrapper, effectiveParent, dbg);
    }
    if (borrowedParent !== null) {
      // The handle is only needed for the `CreateFrame` call: the registry owns the parent frame and
      // its permanent Lua table, and this was a `getGlobal` result.
      this.rt.vm.unref(borrowedParent);
    }
    if (wrapper === null) {
      return null;
    }
    this.report.frames += 1;

    // Read BEFORE the `finally` below releases the handle: an id is a plain number that outlives both
    // the handle and this call, which is why it is what gets returned.
    const frameId = this.rt.ctx.frameIdOf(wrapper);

    // An unnamed frame passes the nearest named ancestor through unchanged, so a region inside it
    // still resolves `$parent` to something addressable.
    const selfName = resolvedName ?? effectiveParentName;

    // AN ORPHAN IS HIDDEN, and this is the honest fallback rather than a workaround.
    //
    // `parent="X"` is not decoration: it is where the frame IS and what it is visible WITH. A document
    // that names a parent this client never built has authored neither a rect nor a shown state we can
    // honour, and leaving it at the root gives it BOTH -- invented ones. It resolves its `CENTER` anchor
    // against the screen instead of against its owner and it inherits nothing's hidden state, so it
    // draws in the middle of the world.
    //
    // MEASURED, and it is the owner's "часть какого-то интерфейса" dead centre of the screen:
    // `CombatLogQuickButtonFrame_Custom` is `parent="ChatFrame2"` with
    // `<Anchor point="CENTER" relativeTo="ChatFrame2" relativePoint="CENTER">` and `hidden="false"`
    // (`interface/addons/blizzard_combatlog/blizzard_combatlog.xml:28-36`) -- a 65x24 black 70%-alpha
    // panel with a 28x28 `UI-MainMenu-ScrollDownButton-Up` filter button, which is exactly the "dark
    // panel with a gold icon" reported. It appeared now because `Blizzard_CombatLog` genuinely loads at
    // `PLAYER_LOGIN` (`uiparent.lua:480-483`) and `LoadAddOn` only became real last round.
    //
    // **The root cause is one class down, not here**: `ChatFrame2` is a `<ScrollingMessageFrame>`
    // (`floatingchatframe.xml:991`) and `object.ts` has no such `WidgetClass`, so all seven chat frames
    // fail to be created -- a gap `STATE.md` already records ("`ScrollingMessageFrame` 10, so no chat").
    // Adding the class is a task of its own (`AddMessage`, `SetMaxLines`, `ScrollUp` &c. are what
    // `FloatingChatFrame_OnLoad` then needs) and is NOT done here. What is done here is to stop
    // inventing a position and a visibility for any frame whose declared owner is absent.
    try {
      this.decorate(element, wrapper, effectiveParentName, selfName, sourceName, dbg);
      // AFTER `decorate`, not before, and deliberately: the frame's own `<OnLoad>` runs in there and may
      // `Show()` itself (`Blizzard_CombatLog_QuickButtonFrame_OnLoad` is one). In the real client that
      // Show is still invisible because the PARENT is hidden, so hiding last is what reproduces the
      // engine -- hiding first would let a script undo it and put the frame back on screen.
      if (orphaned) {
        this.callMethod(wrapper, 'Hide', [], dbg);
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

  /**
   * Steps 2 to 8: everything `materialize` does to a frame once it EXISTS.
   *
   * Split out from `materialize` for one caller and one reason: `CreateFrame(kind, name, parent,
   * template)` from Lua creates the frame itself and then needs precisely this pass over the template's
   * element. Every property still goes through the wrapper's own Lua method, so a Lua-created frame and
   * an XML-declared one are decorated by the same code -- which is the point. A second materializer for
   * the Lua path would be free to drift from this one, and the drift would be invisible until some
   * screen built the same template both ways and got two different frames.
   */
  private decorate(
    element: XmlElement,
    wrapper: LuaRef,
    parentName: string,
    selfName: string,
    sourceName: string,
    dbg: string,
  ): void {
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
    // 5b - <Attributes>. BEFORE <Scripts>, so an `OnLoad` that reads one sees it -- and before
    // `OnAttributeChanged` can be installed, so seeding them fires no spurious dispatch. That is also
    // the engine's order: attributes are part of the frame's declaration, not a later write.
    this.applyAttributes(element, wrapper, dbg);
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
  }

  /**
   * `CreateFrame`'s template argument, materialized: apply a registered template to a frame Lua has
   * just created.
   *
   * THE ELEMENT IS SYNTHESIZED AND THEN EXPANDED BY THE ORDINARY PATH -- `<Kind inherits="Template"/>`
   * through `TemplateRegistry.expand` -- rather than the template being read out of the registry
   * directly. That is what makes a Lua-created frame get *exactly* what an XML-declared
   * `<Button inherits="RealmListTabButtonTemplate"/>` gets: the same multi-name `inherits="A, B"`
   * left-to-right layering, the same chain resolution through a template that itself inherits, the same
   * inherited-first/own-last child order.
   *
   * The synthesized element carries no `name`, and it does not need to: the frame already has its name
   * from `CreateFrame`, and `selfName`/`parentName` below come from the REGISTRY, which is the only
   * place that knows them. (`merge` will splice the template's own `name` and `virtual="true"` onto the
   * expansion -- see `templates.ts` -- and nothing in `decorate` reads either, which is why that
   * documented quirk is inert here.)
   */
  applyTemplate(frameId: number, templateName: string): boolean {
    const cls = this.rt.ctx.registry.classOf(frameId);
    if (cls === null) {
      return false;
    }
    const selfName = this.rt.ctx.registry.nameOf(frameId);
    const parentId = this.rt.ctx.registry.parentOf(frameId);
    const parentName =
      (parentId === null ? null : this.rt.ctx.registry.nameOf(parentId)) ?? DEFAULT_PARENT_NAME;
    const dbg = `CreateFrame:${selfName ?? cls}("${templateName}")`;

    if (!this.rt.templates.has(templateName)) {
      // Not a template this runtime ever registered. An error rather than a warning: unlike a
      // `<FontString inherits=>` (which may legitimately name a font object instead), the 4th argument
      // of `CreateFrame` can only ever be a template, so this is a frame that came out incomplete.
      this.report.errors.push(`${dbg}: no template of that name is registered; the frame is bare`);
      return false;
    }

    const synthetic: XmlElement = {
      tag: cls,
      attrs: new Map([['inherits', templateName]]),
      children: [],
      body: '',
    };
    // The frame's PERMANENT handle (`ctx.wrapper`), which `FrameRegistry` owns -- so, unlike
    // `materialize`'s call-result handle, it is deliberately not released here.
    const wrapper = this.rt.ctx.wrapper(frameId);
    this.decorate(
      this.expand(synthetic),
      wrapper,
      parentName,
      selfName ?? parentName,
      'CreateFrame',
      dbg,
    );
    return true;
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
    // `<MessageFrame displayDuration="5" insertMode="TOP">` -- `uierrorsframe.xml:4`, the only
    // MessageFrame in the manifest. Applied HERE because these are LoadXML attributes like every other
    // one in this method, and NOT through a Lua method because the class has none: nothing in the
    // manifest calls `SetTimeVisible` or `SetInsertMode`, so inventing them to carry an attribute would
    // add API surface that no file has ever pinned. See `methods/messageframe.ts`' header.
    const displayDuration = num(attr(element, 'displayDuration'));
    if (displayDuration !== undefined) {
      setMessageFrameDuration(this.rt.ctx.frameIdOf(wrapper), displayDuration);
    }
    // `<ScrollingMessageFrame maxLines="128">` (`chatframe.xml:4`). It is the scrollback DEPTH, not the
    // number of lines on screen, and it is also the signal that separates a chat frame from an error
    // frame at load time -- see `setMessageFrameMaxLines`, which turns fading off with it.
    const maxLines = num(attr(element, 'maxLines'));
    if (maxLines !== undefined) {
      setMessageFrameMaxLines(this.rt.ctx.frameIdOf(wrapper), maxLines);
    }
    const insertMode = attr(element, 'insertMode');
    if (insertMode !== undefined) {
      setMessageFrameInsertMode(this.rt.ctx.frameIdOf(wrapper), insertMode);
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
      const { x, y } = absDimension(size);
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
        const { x, y } = offset === undefined ? {} : absDimension(offset);
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
            this.applyParentKey(region, regionWrapper, wrapper, dbg);
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
   *
   * ## A region with no `<Anchors>` FILLS ITS OWNER
   *
   * The client's own files are the oracle here, and they are unambiguous.
   * `PlayerFrameTexture` (playerframe.xml:71) is the entire 232x100 player-frame art -- the border,
   * the portrait ring, the bar surround -- and it is authored with **no `<Size>` and no
   * `<Anchors>`**, inside two nested `<Frame setAllPoints="true">`. Without a default it resolved to
   * a 0x0 rect: the health bar, the mana bar, the name and the level drew, and the art that is meant
   * to surround them did not, which is exactly the "data outside its frames" report. It is not one
   * texture either -- **at least** 105 regions across the 133 XML files reachable from
   * `FrameXML.toc` are authored with no anchors (68 with no `<Size>` either; the count EXCLUDES
   * anything with an `inherits=`, whose anchors may come from its template, so it is a floor and not
   * a total), and the ones that were visibly missing include every `ActionButton<n>Icon`
   * (actionbuttontemplate.xml `$parentIcon`), `MainMenuBarBackpackButtonIconTexture` and the four
   * `CharacterBag<n>SlotIconTexture`s (itembuttontemplate.xml `$parentIconTexture`), and
   * `MinimapBorder` (minimap.xml).
   *
   * The engine ANCHORS such a region, it does not merely size it: `PlayerFrameTexture` carries a
   * `<TexCoords>` block and no size at all, so "give it the parent's width and height at the
   * parent's origin" and "pin all four points to the parent" are the same thing here. The
   * `SetAllPoints` form is the one this runtime already uses for the same situation elsewhere --
   * `lua/methods/kinds.ts#fillParent` gives a button's state textures and its label exactly these
   * two anchors on creation, and `applyAnchors` below already clears them when the element declares
   * its own.
   *
   * SCOPE, stated because it is a real limit: this is the XML loader's default only. A region created
   * from Lua by `CreateTexture`/`CreateFontString` and never given a point is left as it was, because
   * nothing in the game's own files settles what the engine does there and inventing an answer would
   * put the default beyond the evidence. Benilla is silent on both -- its `apply_region_layout`
   * (`crates/benilla-ui/src/loader/regions.rs:130-190`) handles `setAllPoints` and `<Anchors>` and
   * has no default, which costs it nothing because it runs its own authored XML rather than
   * Blizzard's.
   *
   * The 37 regions that declare a `<Size>` but no `<Anchors>` get the fill too, and the size loses to
   * the two opposing anchors. That is the same precedence benilla pins for an explicit
   * `setAllPoints` ("size present, but setAllPoints wins", `script/tests/regions.rs:131`). Most of
   * them are positioned from Lua later -- `TutorialFrame`'s arrows, `GameTooltipTemplate`'s ten
   * `$parentTexture<n>` slots.
   *
   * **THE STACKING THIS PARAGRAPH PREDICTED HAS NOW COST SOMETHING, so the prediction is replaced by
   * what happened.** It used to end "a later `SetPoint` at a NEW point stacks on top of the fill rather
   * than replacing it ... nothing observable rests on it today". `QuestInfo_Display` positions every
   * element of the quest page with a single `SetPoint` and no `ClearAllPoints` (`questinfo.lua:73,75`),
   * so `QuestInfoTitleHeader` -- authored with a `<Size>` and no `<Anchors>` (`questinfo.xml:251-255`)
   * -- got four fill anchors plus one more, resolved to the whole 295x324 viewport instead of its text
   * height, and pushed everything chained below its `BOTTOMLEFT` under the fold where the scroll clip
   * dropped it. Blank body, dead scroll, one cause.
   *
   * The fill is now marked `Widget#anchorsAreDefault` and the first explicit `SetPoint` REPLACES it,
   * which is what the engine does with a default position. A region nothing positions still fills.
   *
   * **AND THE DEFAULT ITSELF IS OURS, not the reference's.** `regions.rs:131` is cited above for the
   * size-versus-`setAllPoints` PRECEDENCE and covers only the explicit `setAllPoints="true"` attribute;
   * benilla has no default for an ABSENT `<Anchors>` block at all. Two facts from the manifest bound the
   * question and they point opposite ways: **44** anchorless textures write `setAllPoints="true"`
   * explicitly, which would be redundant if anchorless already filled -- yet
   * `actionbuttontemplate.xml`'s `$parentIcon` is anchorless with no size and no attribute and
   * demonstrably fills its button. So the engine's real rule is probably narrower than this one, the
   * evidence does not settle where, and the default is kept as OURS rather than removed on a guess --
   * **58** bare anchorless textures currently draw because of it.
   */
  private applyRegionLayout(
    region: XmlElement,
    wrapper: LuaRef,
    ownerName: string,
    dbg: string,
  ): void {
    this.applySize(region, wrapper, dbg);
    const declaresAnchors = childrenNamed(region, 'Anchors').some(
      (anchors) => childrenNamed(anchors, 'Anchor').length > 0,
    );
    if (!declaresAnchors && !attrBool(region, 'setAllPoints')) {
      this.callMethod(wrapper, 'SetAllPoints', [], dbg);
      /**
       * MARKED AS A DEFAULT, which is what the paragraph above predicted would matter one day.
       *
       * It said "a later `SetPoint` at a NEW point stacks on top of the fill rather than replacing it
       * ... nothing observable rests on it today". Something did: `QuestInfo_Display` positions every
       * element with a single `SetPoint` and no `ClearAllPoints` (`questinfo.lua:73,75`), so
       * `QuestInfoTitleHeader` ended up with five anchors and the whole viewport's rect. See
       * `Widget#anchorsAreDefault` -- the flag is set AFTER the call, because `setAnchors` clears it.
       *
       * An explicit `setAllPoints="true"` is NOT marked: that is the document's own statement, and 44
       * textures in the manifest make it deliberately.
       */
      const frameId = this.rt.ctx.frameIdOf(wrapper);
      const widget = frameId === null ? undefined : this.rt.ctx.registry.widget(frameId);
      if (widget !== undefined) {
        widget.anchorsAreDefault = true;
      }
    }
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
      // `outlineFlags`, not the raw attribute: the XML vocabulary is `NONE`/`NORMAL`/`THICK` and
      // `SetFont`'s third argument is the Lua one (`OUTLINE`/`THICKOUTLINE`), which tests for the
      // substring "OUTLINE". Passing "NORMAL" through read as no outline at all, which silently
      // stripped the ring off every outlined font object in the manifest -- see `fonts.ts#isOutlined`.
      this.callMethod(
        wrapper,
        'SetFont',
        [resolved.file, resolved.height ?? null, outlineFlags(resolved.outline) ?? null],
        dbg,
      );
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
    // `<Shadow>`, through the same two Lua methods a script would call, so the XML path and the Lua
    // path cannot diverge. Colour BEFORE offset for no functional reason -- neither reads the other --
    // but offset is what makes the shadow visible, so it goes last and a half-applied pair never draws.
    if (resolved.shadow !== undefined) {
      const [r, g, b, a] = resolved.shadow.color;
      this.callMethod(wrapper, 'SetShadowColor', [r, g, b, a], dbg);
      this.callMethod(wrapper, 'SetShadowOffset', [resolved.shadow.x, resolved.shadow.y], dbg);
    }
    // `maxLines` -- an ELEMENT attribute, not a font-object value, so it is read from the region rather
    // than from `resolveFont`. COUNTED over the 127 XML files `framexml.toc` lists: 24 occurrences in
    // 5 files -- `interfaceoptionspanels.xml` 17, `videooptionspanels.xml` 3, `audiooptionspanels.xml`
    // 2, `chatframe.xml` 1 and `spellbookframe.xml:100` 1. (Round 17 recorded the last as the ONLY one;
    // it had read six files.)
    const maxLines = num(attr(region, 'maxLines'));
    if (maxLines !== undefined) {
      this.callMethod(wrapper, 'SetMaxLines', [maxLines], dbg);
    }
    // `nonspacewrap` IS authored -- 31 occurrences across 10 of the 127 manifest XML files, and 22 of
    // them are the options panels' description paragraphs, i.e. exactly the strings the owner reported
    // running out of their panel (`videooptionspanels.xml:37`, `interfaceoptionspanels.xml:64`, ...).
    // Read through the same method a script would call, like `maxLines` above.
    // A real BOOLEAN, not the attribute string: `SetNonSpaceWrap` applies Lua truthiness (`luaFlag`),
    // under which the string `"false"` is TRUE -- the `SetChecked("false")` defect again.
    // `wordwrap` is still NOT read: 0 occurrences across the same 127 files, so a reader would be dead
    // code. The Lua setter exists.
    if (attr(region, 'nonspacewrap') !== undefined) {
      this.callMethod(wrapper, 'SetNonSpaceWrap', [attrBool(region, 'nonspacewrap')], dbg);
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
    // The element's OWN `<Shadow>`, layered over the inherited font object's -- and FontStrings really
    // do declare one: `accountlogin.xml:541-546` gives `AccountLoginSaveAccountNameText` an
    // `<Offset><AbsDimension x="1" y="-1"/></Offset>` and a black `<Color>` of its own, and
    // `targetframe.xml` does the same for several. Read with the same last-occurrence and
    // absent-Color-is-black rules `fonts.ts#readFontObject` documents; the reading is shared through
    // `absDimension`, and only the SOURCE element differs.
    const shadows = childrenNamed(region, 'Shadow');
    if (shadows.length > 0) {
      const shadow = shadows[shadows.length - 1];
      const { x, y } = absDimension(childrenNamed(shadow, 'Offset')[0] ?? shadow);
      const colorElement = childrenNamed(shadow, 'Color')[0];
      resolution.shadow = {
        x: x ?? 0,
        y: y ?? 0,
        color: colorElement === undefined ? [0, 0, 0, 1] : colorOf(colorElement),
      };
    }
    return resolution;
  }

  /** A registered `<Font>`, flattened through its `inherits=` chain, as font values. */
  private readFont(name: string): FontResolution {
    return (
      readFontObject(this.rt.fonts, name, (warning) =>
        this.warnOnce(`font-expand:${warning}`, warning),
      ) ?? {}
    );
  }

  /**
   * A `<Font name="X">` also becomes the Lua GLOBAL `X`, because that is how the client's own code
   * addresses one: `realmlist.lua:123` is `button:SetNormalFontObject(RealmCharactersNormal)` -- a bare
   * global, not the string. Without this the argument is nil and the row keeps whatever font it had,
   * which is exactly why every realm name drew gold where the reference shows one of four colours.
   *
   * A TABLE carrying its own name, and both halves of that are deliberate. A table because a font
   * object in the client IS one (`type()` reports "table" for every FrameScript object), so
   * `SetDisabledFontObject("GlueFontHighlightSmall")` -- the string form, realmlist.lua:236 -- and the
   * object form stay distinguishable at the method boundary rather than both being strings. Its name
   * because that is all any consumer in the loaded manifest ever wants: every one of the eight call
   * sites passes the object straight through to a `Set*FontObject`, none reads a field or calls a
   * method on it. What this object does NOT have is the rest of the engine's Font surface
   * (`GetFont`/`SetTextColor`/`CopyFontObject` and the dozen others), so a document that treats a font
   * object as a live, mutable thing rather than as a name would find nothing there. Nothing in the glue
   * manifest does; the day something does, this is the table to grow.
   *
   * Non-overwriting, like every other name publication here: the first claimant of a global keeps it.
   */
  private publishFontObject(element: XmlElement): void {
    const name = attr(element, 'name');
    if (!name) {
      return;
    }
    const existing = this.rt.vm.getGlobal(name);
    if (this.rt.vm.isRef(existing)) {
      // `getGlobal` mints a handle for a table-valued global; dropping it unreleased pins a registry
      // slot for the life of the VM.
      this.rt.vm.unref(existing);
    }
    if (existing !== undefined) {
      this.warnOnce(
        `font-global:${name}`,
        `<Font name="${name}">: a global of that name already exists; the font object was not published`,
      );
      return;
    }
    const table = this.rt.vm.newTable();
    try {
      this.rt.vm.setTableField(table, 'name', name);
      this.rt.vm.setGlobal(name, table);
    } finally {
      // The global holds the table now; this handle was only for building it.
      this.rt.vm.unref(table);
    }
  }

  /**
   * Step 5, continued: `<Backdrop>` -- the tiled background plus the eight-piece border, built as the
   * same table a Lua `SetBackdrop` call would pass.
   *
   * `SetBackdrop` is REAL (`lua/methods/frame.ts`): it writes a `BackdropDef` and the nine-slice draws.
   * It was a warn-once no-op when this pass was written, on the stated grounds that a backdrop needs art
   * resolved through `GlueArt` and `MethodContext` cannot reach one -- which turned out to have a hole
   * in it, since a sprite key may simply BE the path (`runtime.ts`'s art discovery). Its two COLOUR
   * companions are real now too, so the `<Color>`/`<BorderColor>` calls below tint the background piece
   * and the eight edge pieces respectively.
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
    } else if (tag === 'statusbar') {
      this.applyStatusBar(element, wrapper, dbg);
    } else if (tag === 'slider') {
      // `<ThumbTexture>` IS APPLIED NOW, and its absence is why no scrollbar in the client had a
      // visible thumb. It is a first-class element on a `<Slider>` and the state-texture list in
      // `applyButton` stops at Checked -- so it was read by nothing. Six exist in the manifest and two
      // are in `uipaneltemplates.xml`, the scrollbar template every scroll frame inherits.
      this.applySliderThumb(element, wrapper, selfName, dbg);
      // The remaining gap is narrower than this line used to claim: a Slider's VALUE methods are real
      // (`lua/methods/scroll.ts`, and `SetValue` now fires `OnValueChanged`, which is what makes the
      // arrows scroll), and its thumb ART is applied above. What is still missing is thumb TRAVEL --
      // nothing moves the thumb as the value changes, because `widget.ts` models no slider geometry.
      this.warnOnce(
        'kind:slider',
        `<Slider> thumb art is applied but does not TRACK the value: this renderer models no thumb travel, so the thumb sits where its XML anchors put it (first: ${dbg})`,
      );
    } else if (tag === 'model' || tag === 'modelffx' || tag === 'playermodel') {
      this.applyModel(element, wrapper, dbg);
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
   * `<Model>`/`<ModelFFX>`/`<PlayerModel>`: the model attributes, through the frame's own methods.
   *
   * `UI.xsd`'s `ModelType` declares `file`, `scale`, `fogNear`, `fogFar` and `glow` as ATTRIBUTES and
   * the fog COLOUR as an optional `<FogColor>` CHILD -- which is why the colour is read separately
   * below and not out of the attribute map. The one element in the loaded manifest that uses any of
   * them is the login screen, and it uses four:
   *
   *   accountlogin.xml:93   `<ModelFFX name="AccountLogin" ... fogNear="0" fogFar="1200" glow="0.08">`
   *   accountlogin.xml:2501 `<FogColor r="0.25" g="0.06" b="0.015"/>`
   *
   * Those two lines are 2408 apart, with the whole `<Frames>` and `<Scripts>` block between them, and
   * a previous pass concluded from the opening tag alone that no colour was authored. It is authored.
   * `scene/scene-rig.ts#MAIN_MENU_FOG` carries the correction.
   *
   * `<FogColor>` is read with `colorOf`, so a present element with a missing channel reads black on
   * that channel -- the same rule every other `<Color>` in this loader follows.
   *
   * ORDER MATTERS, and only in one direction: the colour is issued LAST. `SetFogNear`/`SetFogFar`
   * materialize a fog triple on a frame that has none (`lua/methods/model.ts` says why), so near/far
   * first then colour leaves all three set whichever the document happened to declare; the reverse
   * would work equally well. What must NOT happen is `file=` being issued before them, because
   * `SetModel` is what makes the host load a stage and the stage should land with its fog already
   * decided. No glue element uses `file=` -- `AccountLogin` calls `SetModel` from its `OnLoad`, which
   * step 8 fires after all of this -- so that ordering is guarded by the sequence rather than relied on.
   *
   * `scale=` is deliberately not issued: `MODEL` has no `SetModelScale` in this object model and no
   * glue element authors one, so emitting the call would produce a report line for a gap nothing has.
   */
  private applyModel(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    const near = num(attr(element, 'fogNear'));
    if (near !== undefined) {
      this.callMethod(wrapper, 'SetFogNear', [near], dbg);
    }
    const far = num(attr(element, 'fogFar'));
    if (far !== undefined) {
      this.callMethod(wrapper, 'SetFogFar', [far], dbg);
    }
    const glow = num(attr(element, 'glow'));
    if (glow !== undefined) {
      this.callMethod(wrapper, 'SetGlow', [glow], dbg);
    }
    const fogColor = childrenNamed(element, 'FogColor')[0];
    if (fogColor !== undefined) {
      const [r, g, b] = colorOf(fogColor);
      this.callMethod(wrapper, 'SetFogColor', [r, g, b], dbg);
    }
    const file = attr(element, 'file');
    if (file !== undefined && file.trim() !== '') {
      this.callMethod(wrapper, 'SetModel', [file], dbg);
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
          // The EXPANDED element here, `texture`, not `raw` -- see `applyParentKey` for why the two
          // attributes take opposite sides of that choice.
          this.applyParentKey(texture, region, wrapper, dbg);
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
        // `parentKey` ON A `<ButtonText>` -- the ONE region path that was missing it, and measured
        // live rather than reasoned about: the quest log printed
        // `QuestLogFrame.lua:190: attempt to index a nil value (local 'questNormalText')`, which is
        // `QuestLogTitleButton_Resize` reading `questLogTitle.normalText` off
        // `<ButtonText name="$parentNormalText" parentKey="normalText">` (questlogframe.xml:86).
        //
        // `applyParentKey` was already called for a `<Layers>` region (:924) and for a button's state
        // textures (:1545), so the gap was this loop alone -- and `publishRegion` publishes only the
        // GLOBAL name, which is why the `$parentNormalText` global existed while the key did not. A
        // caller that uses the key rather than the global therefore saw nil, and
        // `QuestLogTitleButton_Resize` runs for every row of the log.
        this.applyParentKey(buttonText, label, wrapper, dbg);
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
   * ALL THREE ARE NOW ONE LINE EACH, and that is the point of the font-object registry rather than a
   * shortcut. This pass used to resolve the NORMAL font itself -- flattening the `<Font>` chain and
   * pushing a synthetic `<FontString inherits="...">` onto the label `GetFontString()` handed back --
   * while issuing the other two at declared stubs so the report at least named them. Now
   * `SetNormalFontObject`/`SetHighlightFontObject`/`SetDisabledFontObject` all resolve the name through
   * the same registry themselves (`lua/methods/kinds.ts`), so the loader's job is to say what the
   * document said and nothing more, and a per-state font is applied by the state poll rather than
   * dropped. It also means a Lua caller and an XML author reach the identical code path, which is the
   * property this file exists to preserve.
   *
   * ORDER still matters and is unchanged: this runs after `applyRegionLayout` for the `<ButtonText>`,
   * so the font object's `justifyH` overrides an element-level one, exactly as it did before.
   */
  private applyButtonFonts(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    for (const [tag, method] of [
      ['NormalFont', 'SetNormalFontObject'],
      ['HighlightFont', 'SetHighlightFontObject'],
      ['DisabledFont', 'SetDisabledFontObject'],
    ] as const) {
      for (const font of childrenNamed(element, tag)) {
        const name = attr(font, 'style') ?? attr(font, 'inherits');
        if (name !== undefined) {
          this.callMethod(wrapper, method, [name], dbg);
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
  /**
   * `parentKey="name"` -- publish this element on its PARENT's Lua table as `parent.name`.
   *
   * A 3.x addition, so the reference is silent on it (`benilla-ui` has no `parent_key` at all; its one
   * hit is the unrelated `$parentKey` name substitution, `framexml.rs:371`) and the game's own files are
   * the only oracle. They are unambiguous about what it is for: `targetframe.xml:215` declares
   * `<Texture name="$parentNameBackground" ... parentKey="nameBackground">` and `targetframe.lua:263,268`
   * addresses it as `self.nameBackground` and NOTHING ELSE. It was being dropped, so
   * `TargetFrame_CheckFaction` raised `attempt to index a nil value (field 'nameBackground')` at line
   * 268 -- measured live (`scratchpad/t17k-nb.js`) -- which is why the target frame's name strip stayed
   * FULL WHITE however good `UnitSelectionColor` got. One dropped attribute, and the visible symptom was
   * a mis-coloured bar.
   *
   * FROM THE EXPANDED element, unlike `name` (see `publishRegion` for why a name must come from the raw
   * one). The two attributes differ in kind: a `name` inherited from a template would publish every
   * inheritor's region under ONE global and clash, whereas a `parentKey` inherited from a template is
   * exactly what the engine does -- each inheritor gets the key on ITS OWN table, so there is no clash
   * and dropping the inherited case would lose the templated frames that are the attribute's main use.
   *
   * A parent-less element (a document-top-level frame with no `parent=`) has nowhere to put the key and
   * is reported rather than silently skipped: the client would have assigned it to `UIParent`, and
   * guessing that here would put a key on a frame the document did not name.
   */
  private applyParentKey(
    element: XmlElement,
    child: LuaRef,
    parent: LuaRef | null,
    dbg: string,
  ): void {
    const key = attr(element, 'parentKey');
    if (key === undefined || key === '') {
      return;
    }
    if (parent === null) {
      this.report.warnings.push(
        `${dbg}: parentKey="${key}" on an element with no parent frame; the key was not published`,
      );
      return;
    }
    // `setTableField` pushes the referenced value INTO the table, so the table holds its own reference
    // and the caller's handle can be released as it always was.
    this.rt.vm.setTableField(parent, key, child);
  }

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

  /**
   * `<StatusBar>`: the value range, the orientation, the fill art and its tint -- all through the
   * frame's own methods, so XML and Lua go down one path.
   *
   * ORDER IS LOAD-BEARING here and is not the document's order. `<BarTexture>` runs BEFORE
   * `SetMinMaxValues`/`SetValue` because `SetStatusBarColor` tints the bar texture and
   * `SetStatusBarTexture` (the colour overload) replaces it -- and `<BarColor>` must land on the art
   * `<BarTexture>` named, not create a solid fill that then gets a sprite. `minValue`/`maxValue`
   * before `defaultValue` for the obvious reason: `SetValue` clamps into the range.
   *
   * The `UI.xsd` `StatusBarType` surface is `minValue`, `maxValue`, `defaultValue`, `drawLayer` and
   * `orientation` as ATTRIBUTES with `<BarTexture>` and `<BarColor>` as CHILDREN. `<BarTexture>` is a
   * full `<Texture>` element in the schema, but the only thing this reads off it is `file` and
   * `drawLayer`: a bar texture's own size and anchors are meaningless because the fill takes its
   * geometry from the frame (`widget.ts#barFillRect`), which is exactly what benilla does
   * (`crates/benilla-ui/src/extract.rs:69-81`). Anything else authored on it is dropped, and the
   * warning below says so rather than letting it look honoured.
   */
  private applyStatusBar(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    const barTexture = childrenNamed(element, 'BarTexture')[0];
    if (barTexture !== undefined) {
      const file = attr(barTexture, 'file');
      const layer = attr(barTexture, 'drawLayer') ?? attr(element, 'drawLayer');
      if (file !== undefined && file !== '') {
        this.callMethod(wrapper, 'SetStatusBarTexture', [file, layer], dbg);
      }
      if (childrenNamed(barTexture, 'Size').length > 0 || childrenNamed(barTexture, 'Anchors').length > 0) {
        this.warnOnce(
          'statusbar:bartexture-geometry',
          `<BarTexture> declares its own <Size>/<Anchors>; both are ignored because a status bar's`
            + ` fill takes its rect from the frame and its value (first: ${dbg})`,
        );
      }
    }

    const barColor = childrenNamed(element, 'BarColor')[0];
    if (barColor !== undefined) {
      this.callMethod(wrapper, 'SetStatusBarColor', colorOf(barColor), dbg);
    }

    const orientation = attr(element, 'orientation');
    if (orientation !== undefined && orientation !== '') {
      this.callMethod(wrapper, 'SetOrientation', [orientation], dbg);
    }

    // Both bounds are sent whenever EITHER is authored: `SetMinMaxValues` takes a pair, and defaulting
    // the absent one to the widget's constructed 0..1 (rather than to 0) would make
    // `<StatusBar maxValue="100">` a 0..1 bar that reads full at 1 hit point.
    const minValue = num(attr(element, 'minValue'));
    const maxValue = num(attr(element, 'maxValue'));
    if (minValue !== undefined || maxValue !== undefined) {
      this.callMethod(wrapper, 'SetMinMaxValues', [minValue ?? 0, maxValue ?? 0], dbg);
    }
    const defaultValue = num(attr(element, 'defaultValue'));
    if (defaultValue !== undefined) {
      this.callMethod(wrapper, 'SetValue', [defaultValue], dbg);
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
  /**
   * `<ThumbTexture>` on a `<Slider>`.
   *
   * EXPANDED first, exactly like `applyButton`'s slots and for the same reason: a thumb routinely
   * carries no `file=` of its own and inherits a virtual `<Texture>` that does. `UIPanelScrollFrame`'s
   * is `<ThumbTexture name="$parentThumbTexture" file="Interface\Buttons\UI-ScrollBar-Knob">`, which
   * does carry one, but `colorpickerframe.xml` and `optionspaneltemplates.xml` are not guaranteed to.
   *
   * The region is reached through `SetThumbTexture`/`GetThumbTexture` (`methods/scroll.ts`) so the
   * object model owns the slot, then decorated by the SAME `applyRegion` path a `<Layers>` texture
   * takes -- so its `<Size>`, `<Anchors>`, `<TexCoords>` and `<Color>` all work without a second
   * implementation.
   */
  private applySliderThumb(
    element: XmlElement,
    wrapper: LuaRef,
    selfName: string,
    dbg: string,
  ): void {
    for (const raw of childrenNamed(element, 'ThumbTexture')) {
      const thumb = this.expandRegion(raw);
      const file = attr(thumb, 'file');
      // The setter runs even with an empty file: it is what CREATES the slot. Same contract the button
      // state textures use.
      this.callMethod(wrapper, 'SetThumbTexture', [file ?? ''], dbg);
      const region = this.callForWidget(wrapper, 'GetThumbTexture', [], dbg);
      if (region === null) {
        continue;
      }
      try {
        /**
         * **THE NAME, AND DROPPING IT KILLED THE WHOLE SCROLLBAR -- arrows, drag and wheel at once.**
         *
         * The comment above this method already quoted `name="$parentThumbTexture"`
         * (`uipaneltemplates.xml:207`) and then read only `file=`, so the thumb existed in our object
         * model and had no global. The client indexes it by that global in the one function that gives a
         * scrollbar its limits: `ScrollFrame_OnScrollRangeChanged` does
         * `_G[scrollbar:GetName().."ThumbTexture"]:Hide()` at `uipaneltemplates.lua:300` and `:Show()` at
         * `:305`, on the zero-range and non-zero-range branches respectively -- so EVERY announcement
         * raised, whatever the range.
         *
         * The owner's console named it exactly: `WorldMapQuestScrollFrame: OnScrollRangeChanged:
         * [string "UIPanelTemplates.lua"]:300: attempt to index a nil value (field '?')`.
         *
         * What that truncation costs is the whole symptom, and it is why all three input routes died
         * together while the range itself was computed correctly. `:284` sets the bar's min/max and runs
         * BEFORE the throw, so the limits were right and every static check of the range chain passed.
         * Everything after the throw never ran: `:311`'s `ScrollDownButton:Enable()`, so both arrows
         * stayed disabled from `ScrollFrame_OnLoad`'s `:255-256`, and `:305`'s `ThumbTexture:Show()`, so
         * there was no thumb to drag.
         *
         * FROM THE RAW element, not the expanded one -- `publishRegion`'s own contract: a `name`
         * inherited from a template would publish every inheritor's thumb under ONE global and clash.
         * `parentKey` takes the expanded one, for the opposite reason. Same split, and the same two
         * calls, as the button state textures at `:1587-1590`.
         */
        this.publishRegion(raw, region, selfName, dbg);
        this.applyParentKey(thumb, region, wrapper, dbg);
        const texCoords = texCoordsOf(thumb);
        if (texCoords !== null) {
          this.callMethod(region, 'SetTexCoord', texCoords, dbg);
        }
        // The SAME layout path a `<Layers>` texture takes, so `<Size>` and `<Anchors>` need no second
        // implementation here.
        this.applyRegionLayout(thumb, region, selfName, dbg);
      } finally {
        this.rt.vm.unref(region);
      }
    }
  }

  /**
   * `<Attributes><Attribute name= type= value=/></Attributes>` -- and NOTHING read these before.
   *
   * **This killed the whole UI-panel layout pass**, and the owner's own console log is the evidence:
   *
   *     framexml: OnAttributeChanged(panel-update): [string "UIParent.lua"]:1717:
   *       attempt to perform arithmetic on a nil value
   *
   * `uiparent.lua:1717` is `rightOffset = leftOffset + UIParent:GetAttribute("DEFAULT_FRAME_WIDTH") * 2`,
   * and `uiparent.xml:5-12` declares that attribute -- along with `TOP_OFFSET`, `LEFT_OFFSET`,
   * `CENTER_OFFSET`, `RIGHT_OFFSET` and `RIGHT_OFFSET_BUFFER` -- in an `<Attributes>` block. With the
   * block ignored, all six read nil, `UpdateUIPanelPositions` raised on its first arithmetic, and
   * everything after that line never ran: `SetAttribute("RIGHT_OFFSET", ...)`, the right-panel
   * placement, and the slot bookkeeping that decides which panel currently occupies "left".
   *
   * There are only **14** of these in the whole loaded manifest, and every one matters:
   *  - `uiparent.xml` x6 -- the panel geometry above.
   *  - `multiactionbars.xml` x4 -- `actionpage` on the four bonus bars (`SecureButton_GetModifiedAttribute`
   *    reads it to decide which page a button acts on).
   *  - `securetemplates.xml` x4 -- `showParty`/`showRaid` on the secure group headers.
   *
   * `type` defaults to `"string"` per `UI.xsd:181`, and the manifest uses `number` (10) and `boolean`
   * (4). A `number` that does not parse is DROPPED with a report rather than coerced to `NaN`, because
   * `NaN` propagates silently through exactly the arithmetic this exists to fix.
   */
  private applyAttributes(element: XmlElement, wrapper: LuaRef, dbg: string): void {
    for (const block of childrenNamed(element, 'Attributes')) {
      for (const item of childrenNamed(block, 'Attribute')) {
        const name = attr(item, 'name');
        if (name === undefined || name === '') {
          this.report.errors.push(`${dbg}: <Attribute> with no name; ignored`);
          continue;
        }
        const raw = attr(item, 'value') ?? '';
        const kind = (attr(item, 'type') ?? 'string').toLowerCase();
        let value: unknown = raw;
        if (kind === 'number') {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) {
            this.report.errors.push(
              `${dbg}: <Attribute name="${name}" type="number" value="${raw}"> is not a number; ignored`,
            );
            continue;
          }
          value = parsed;
        } else if (kind === 'boolean') {
          // The engine's spelling is `value="true"`. Anything else false, rather than truthy-by-string
          // -- `"false"` is a non-empty string and would otherwise come out TRUE.
          value = raw.toLowerCase() === 'true' || raw === '1';
        }
        this.callMethod(wrapper, 'SetAttribute', [name, value], dbg);
      }
    }
  }

  private applyScripts(element: XmlElement, wrapper: LuaRef, dbg: string): boolean {
    let hasOnLoad = false;
    let declaresMouseScript = false;
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
        if (MOUSE_SCRIPTS.has(name.toLowerCase())) {
          declaresMouseScript = true;
        }
      }
    }
    /**
     * A FRAME THAT DECLARES A MOUSE SCRIPT IS MOUSE-INTERACTIVE, and not doing this made every such
     * handler dead code.
     *
     * MEASURED, and it is one cause behind three of the owner's reports at once -- no tooltip on a
     * character-panel stat, none on a resistance icon, none on the experience bar -- while ITEM tooltips
     * worked. The difference is the widget CLASS, not the frame:
     *
     *     StatLike  (Frame,     <OnEnter>) mouseEnabled false  onEnter bound   <- handler never runs
     *     BarLike   (StatusBar, <OnEnter>) mouseEnabled false  onEnter bound   <- handler never runs
     *     ButtonLike(Button,    <OnClick>) mouseEnabled TRUE   onClick bound   <- works
     *
     * `object.ts:504-508` enables the mouse for `button`/`checkbutton`/`editbox` by class, which is right
     * as far as it goes, and `loader.ts` applies `enableMouse="true"` when a document declares it.
     * Neither covers the case the client's own files are full of: `StatFrameTemplate`
     * (`paperdollframe.xml:170,202-209`), `MagicResistanceFrameTemplate` (`:211,215-224`) and
     * `MainMenuExpBar` (`mainmenubar.xml:12`) are a Frame, a Frame and a StatusBar, every one of them
     * declares `<OnEnter>`, and NOT ONE declares `enableMouse` -- `UI.xsd:470` gives that attribute
     * `default="false"`. All three show tooltips in the real client, and grepping `EnableMouse` over the
     * served FrameXML finds no call for any of them. So the engine's rule is not the class alone and not
     * the attribute alone: declaring a mouse handler is what arms the frame.
     *
     * `hitTest` only ever answers a `mouseEnabled` widget (`ui/hit.ts:41`), so without this the `OnEnter`
     * the loader had just bound could never be reached by the router.
     *
     * The STARTING VALUE, exactly like the class rule beside it: a later `EnableMouse(false)` still turns
     * it off, which `watchframe.lua:465` and `friendsframe.lua:896` rely on. An explicit
     * `enableMouse="false"` on the element is honoured rather than overridden -- the attribute is the
     * document's own statement and outranks an inference from its scripts.
     */
    if (declaresMouseScript && attr(element, 'enableMouse') !== 'false') {
      this.callMethod(wrapper, 'EnableMouse', [true], dbg);
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
