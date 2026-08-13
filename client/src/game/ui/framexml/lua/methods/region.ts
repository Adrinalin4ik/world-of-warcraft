/**
 * REGION, LAYEREDREGION, TEXTURE and FONTSTRING: the methods every drawable widget answers to
 * (REGION), the ones shared by exactly Texture and FontString (LAYEREDREGION), and the two leaves'
 * own methods.
 *
 * Class placement is the decision this file exists to get right, and it deliberately does not match
 * the plan's "Region" list one-for-one: that list names methods that only make sense on ONE leaf
 * (`SetText` is FontString-only; `SetTexture` is Texture-only) alongside ones every drawable answers
 * to. Registering a leaf-only method on LAYEREDREGION would make a Texture answer to `SetText` and a
 * FontString answer to `SetTexture` -- exactly the duck-typing leak `object.ts`'s docstring warns
 * about, since `if frame.SetTexture then` is a real addon idiom for "is this a Texture". So:
 *   - REGION: methods every drawable thing has (Show/Hide/SetPoint/SetAlpha/...), shared with FRAME.
 *   - LAYEREDREGION: only what Texture AND FontString both genuinely have (SetVertexColor,
 *     SetTexCoord, SetDrawLayer -- the client's own LayeredRegion base class).
 *   - TEXTURE / FONTSTRING: everything else, on the leaf it actually belongs to.
 */
import { FrameMethod, MethodContext, MethodTable, isObjectType, registerMethods } from '../object';
import { invokeScriptHandler, reportScriptError } from '../scripts';
import { Anchor, AnchorPoint } from '../../../layout';
import { Layer, Widget, deriveSize } from '../../../widget';
import { familyForFontFile, measureText } from '../../../text';
import { FontResolution, isOutlined } from '../../fonts';

const warned = new Set<string>();

/**
 * Frames the player has placed himself, for `IsUserPlaced`/`SetUserPlaced`.
 *
 * A `WeakSet` on the WIDGET rather than a `Set` of frame ids: ids are minted per registry, so a module-level
 * id set would leak one runtime's user-placed frames into the next one's by number collision -- and a torn
 * down and rebuilt screen is the ordinary case here, not an edge one.
 */
const userPlaced = new WeakSet<Widget>();

/** Logs a stub's absence exactly once per message, so a busy screen does not spam the console. */
export function warnOnce(message: string): void {
  if (warned.has(message)) {
    return;
  }
  warned.add(message);
  console.warn(message);
}

const notImplementedNames = new Set<string>();

/**
 * The names of every method that is REGISTERED but does nothing.
 *
 * These exist so duck-typing sees the class correctly -- `if frame.SetBackdrop then` has to be true on
 * a Frame whether or not this engine can draw one -- which means a caller cannot tell a working method
 * from a stub by asking Lua. That is fine for game code and NOT fine for the XML loader
 * (`framexml/loader.ts`): every `<Backdrop>` and every `<NormalFont>` on a real glue screen would be
 * swallowed by a successful-looking call, and the load report would claim a clean load of a screen
 * missing all of its backdrops and label fonts. So the stubs are declared through `notImplemented`
 * below, which records the name here, and the loader turns a call to one into a report warning.
 *
 * Keyed by NAME, not by (class, name): no stub name is also a real method on another class today. If
 * one ever is, the loader over-reports that method as a gap on the class where it works -- widen this
 * to a `class:name` key at that point rather than dropping the check.
 */
export const NOT_IMPLEMENTED: ReadonlySet<string> = notImplementedNames;

/**
 * Declares a method that is registered, warns once, and does nothing -- the honest form of a gap.
 *
 * `results` is for the handful that must still answer something plausible (`GetEffectiveScale` reports
 * the only scale that exists; `HasFocus` reports false).
 */
export function notImplemented(method: string, reason: string, results: unknown[] = []): FrameMethod {
  notImplementedNames.add(method);
  return () => {
    warnOnce(`${method}: not implemented -- ${reason}`);
    return results;
  };
}

/** Every method here is only ever invoked with a live id -- `object.ts` checked before dispatching. */
function widgetOf(ctx: MethodContext, self: number): Widget {
  return ctx.registry.widget(self)!;
}

/** `0..1` floats (the Lua convention) to the `#rrggbb` string `Widget` stores colors as. */
function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * `SetPoint`'s `relativeTo`: a frame table, a frame NAME string, or absent (the parent). All three
 * appear in real FrameXML. An unresolvable NAME warns and falls back to the parent rather than
 * throwing -- a hard error here would take out the whole screen calling it, which is not what the
 * client does.
 */
function resolveRelativeTo(ctx: MethodContext, self: number, value: unknown): string | undefined {
  const parentId = ctx.registry.parentOf(self);
  const parentWidgetId = parentId === null ? undefined : ctx.registry.widget(parentId)?.id;

  if (value === undefined || value === null) {
    return parentWidgetId;
  }
  if (typeof value === 'string') {
    const id = ctx.registry.byName(value);
    if (id === null) {
      warnOnce(`SetPoint: no frame named '${value}' -- anchoring to the parent instead`);
      return parentWidgetId;
    }
    return ctx.registry.widget(id)!.id;
  }
  const id = ctx.frameIdOf(value);
  if (id === null) {
    warnOnce('SetPoint: relativeTo argument is not a frame -- anchoring to the parent instead');
    return parentWidgetId;
  }
  return ctx.registry.widget(id)!.id;
}

/**
 * How many times a `Show`/`Hide` may RE-ENTER before this gives up.
 *
 * `ChangedOptionsDialog_OnShow` calls `self:Hide()` -- a handler hiding the very frame whose showing
 * fired it is the ordinary case, not a pathology, so re-entry has to work. The engine has no limit here
 * at all and relies on the UI not being written in a loop; a browser cannot afford that bet, since a
 * `Show`/`Hide` cycle between two frames would hang the tab rather than print a stack.
 *
 * RE-ENTRIES, not tree depth, and the distinction is not academic -- counting the recursive walk
 * instead would make the cap a limit on how deeply a screen may be NESTED, which `AccountLogin`'s
 * frame-plus-region tree comes within a few levels of on its own. So the counter moves at the two
 * method entry points below, and the walk recurses freely.
 */
const MAX_VISIBILITY_REENTRY = 12;
let visibilityReentry = 0;

/**
 * Runs one `Show`/`Hide`'s cascade under the re-entry cap. Returns with nothing done if a chain of
 * handlers has gone `MAX_VISIBILITY_REENTRY` deep, which can only be a loop.
 */
function cascadeGuarded(ctx: MethodContext, widget: Widget, handler: 'OnShow' | 'OnHide'): void {
  if (visibilityReentry >= MAX_VISIBILITY_REENTRY) {
    warnOnce(
      `${handler}: Show/Hide re-entered ${MAX_VISIBILITY_REENTRY} times and was cut off -- a visibility handler is showing or hiding in a loop`,
    );
    return;
  }
  visibilityReentry += 1;
  try {
    cascadeVisibility(ctx, widget, handler);
  } finally {
    visibilityReentry -= 1;
  }
}

/**
 * Fires `OnShow`/`OnHide` for every frame in `widget`'s subtree whose VISIBILITY just changed.
 *
 * THE SEMANTICS, which are the whole reason this is a walk and not a single call: the engine's
 * `OnShow` fires for each frame that BECOMES VISIBLE, not for the one whose `Show()` was called. A
 * frame is visible only if every ancestor is too (`Widget#visible`), so flipping one frame's own flag
 * changes the visibility of itself plus every descendant that is already `shown` -- and of nothing
 * inside a descendant that is hidden in its own right, which is why a `shown === false` child prunes
 * the walk instead of being skipped-but-descended.
 *
 * PARENT FIRST, and re-checked after each handler: a parent's `OnShow` that hides the parent again
 * (`ChangedOptionsDialog_OnShow` -> `ShowChangedOptionWarnings()` is false -> `self:Hide()`) must stop
 * its children's `OnShow` from firing, exactly as it does in the client. The nested `Hide()` has by
 * then fired the subtree's `OnHide` through this same function.
 *
 * A HANDLER THAT RAISES does not stop the walk and does not propagate: the engine hands a script
 * error to the error handler and lets the call that triggered it return normally, and one broken
 * dialog must not abort the screen change that was showing it. `reportScriptError` is where those go.
 */
function cascadeVisibility(ctx: MethodContext, widget: Widget, handler: 'OnShow' | 'OnHide'): void {
  const id = ctx.registry.idOfWidget(widget);
  if (id !== null) {
    const error = invokeScriptHandler(ctx, id, handler);
    if (error !== null) {
      const name = ctx.registry.nameOf(id) ?? widget.id;
      reportScriptError(`${name}: ${handler}`, error.message);
    }
    // The handler may have flipped this frame's own flag (the `self:Hide()` case above), in which
    // case the nested call has already dealt with the subtree and descending again would fire the
    // opposite handler's children twice.
    if (widget.shown !== (handler === 'OnShow')) {
      return;
    }
  }
  // A copy: a handler is free to create or destroy children, and the client's dialogs do.
  for (const child of [...widget.children]) {
    if (child.shown) {
      cascadeVisibility(ctx, child, handler);
    }
  }
}

const REGION: MethodTable = {
  // The TRANSITION is what dispatches, not the call. `Widget#show` already guards on an unchanged
  // flag (per-frame code calls it idempotently), and the same guard has to be visible here: an
  // `OnShow` fired on every tick for a frame that was already up would re-run every dialog's
  // initialization forever.
  //
  // `visible`, not `shown`, decides whether anything is dispatched: showing a frame inside a hidden
  // ancestor changes nothing about what is on screen, so no `OnShow` is owed. That is also what makes
  // the boot sequence work out -- every glue screen is authored `hidden="true"`, so their children's
  // `OnShow` waits for `SetGlueScreen("login")` to show the screen itself, which is precisely when the
  // client fires them.
  Show: (ctx, self) => {
    const widget = widgetOf(ctx, self);
    if (widget.shown) {
      return [];
    }
    widget.show();
    if (widget.visible) {
      cascadeGuarded(ctx, widget, 'OnShow');
    }
    return [];
  },
  Hide: (ctx, self) => {
    const widget = widgetOf(ctx, self);
    // Read BEFORE the flag moves: afterwards `visible` is false either way and cannot tell a frame
    // that was on screen from one that was already hidden by an ancestor.
    const wasVisible = widget.visible;
    if (!widget.shown) {
      return [];
    }
    widget.hide();
    if (wasVisible) {
      cascadeGuarded(ctx, widget, 'OnHide');
    }
    return [];
  },
  // The widget's OWN flag, not the ancestor chain -- `IsVisible` below is the one that walks up.
  IsShown: (ctx, self) => [widgetOf(ctx, self).shown],
  IsVisible: (ctx, self) => [widgetOf(ctx, self).visible],
  /**
   * `IsMouseOver()` -- answered from the INPUT ROUTER's hit, not from a rect test.
   *
   * `Widget#hovered` is what `GlueInput` sets on the single topmost widget the pointer is over
   * (`ui/input.ts#onPointerMove`), which is what the callers in this manifest mean: every one of them
   * is inside an `OnMouseUp`/`OnEnter` on the frame itself, deciding whether the release landed on
   * the button -- `MainMenuBarMicroButtons.xml:CharacterMicroButton`'s `OnMouseUp` is the one that
   * found this method missing, and its whole body is guarded on it.
   *
   * It is NOT identical to the engine's, and the difference is worth stating: the engine tests the
   * cursor against this frame's rect whether or not another frame is on top and whether or not this
   * frame takes the mouse, so a frame UNDER the pointer but beneath another one answers true there
   * and false here. Closing that gap needs a rect the frame keeps outside the draw list, which it
   * does not have.
   */
  IsMouseOver: (ctx, self) => [widgetOf(ctx, self).hovered],
  GetName: (ctx, self) => [ctx.registry.nameOf(self)],
  /**
   * `IsObjectType(name)` -- is this widget of that class, or descended from it?
   *
   * THE CLASS CHAIN, not an equality test, and the chain is the one the method dispatcher already walks
   * (`object.ts#chainOf`, `CLASS_PARENT`). A Button IS a Frame IS a Region, and FrameXML relies on that:
   * this method's caller here asks a CastingBarFrame, a ChatFrame and a GroupLootFrame alike whether each
   * `IsObjectType("frame")`, and a StatusBar answering false would be excluded from the managed pass.
   *
   * CASE-INSENSITIVE, and that is read off the call site rather than assumed: `uiparent.lua:1301` passes
   * the LOWERCASE `"frame"` while the engine's own `GetObjectType` returns `"Frame"`, so the engine cannot
   * be comparing the strings as given.
   *
   * WHY IT MATTERS OUT OF PROPORTION TO ITS SIZE: `uiparent.lua:1301` is
   * `if ( frame ~= ChatFrame2 and not(frame:IsObjectType("frame") and frame:IsUserPlaced()) ) then
   * frame:SetPoint(...)`. Missing, this resolves to nil (`object.ts`'s `__index` returns nil for a name no
   * class carries, rather than an error stub), so the call raises -- and `securecall` in this runtime is a
   * plain call, not a `pcall` (`lua/api/secure.ts:38-54`), so the raise aborts the whole `for` loop at
   * `uiparent.lua:1806` and NOT ONE managed frame is ever moved.
   */
  IsObjectType: (ctx, self, args) => {
    const cls = ctx.registry.classOf(self);
    return [cls !== null && isObjectType(cls, String(args[0] ?? ''))];
  },
  /**
   * `IsUserPlaced()` -- has the player dragged this frame to a position of his own?
   *
   * FALSE for everything, and that is the TRUE answer rather than a stub: a frame becomes user-placed only
   * through `SetUserPlaced(true)`, which the engine persists in the layout cache across sessions, and this
   * client has no layout cache and no frame the player can drag. `SetUserPlaced` is registered beside it so
   * a caller that sets the flag is answered honestly instead of being ignored -- the pair is what makes
   * this an implementation and not a placeholder.
   *
   * The consequence at `uiparent.lua:1301` is the one that matters: false is what lets the managed pass
   * position the frame at all. A frame the player has placed himself is deliberately left alone.
   */
  IsUserPlaced: (ctx, self) => [userPlaced.has(widgetOf(ctx, self))],
  SetUserPlaced: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    if (args[0] === false || args[0] === undefined || args[0] === null) {
      userPlaced.delete(widget);
    } else {
      userPlaced.add(widget);
    }
    return [];
  },
  GetParent: (ctx, self) => {
    const parent = ctx.registry.parentOf(self);
    return [parent === null ? null : ctx.wrapper(parent)];
  },
  SetAlpha: (ctx, self, args) => {
    widgetOf(ctx, self).alpha = Number(args[0] ?? 1);
    return [];
  },
  GetAlpha: (ctx, self) => [widgetOf(ctx, self).alpha],
  SetWidth: (ctx, self, args) => {
    widgetOf(ctx, self).width = Number(args[0] ?? 0);
    return [];
  },
  SetHeight: (ctx, self, args) => {
    widgetOf(ctx, self).height = Number(args[0] ?? 0);
    return [];
  },
  // A FONT STRING with a 0 dimension derives it from its text, exactly as the layout does
  // (`widget.ts#deriveSize`) and for the same reason: `GlueDialogText` is authored `<Size x="450"
  // y="0">` and `gluedialog.lua:610,677` sizes the whole dialog panel from its `GetHeight()`, which
  // reported 0 and left the panel one text-height short. `GetStringWidth` already measured this way.
  // Measured at scale 1: a widget's size is in logical units, so the live layout scale divides out.
  // Everything else reports its stored size unchanged -- a FRAME's 0 still means "derive from the
  // opposing anchors", which only `resolveAnchors` can do.
  GetWidth: (ctx, self) => [deriveSize(widgetOf(ctx, self), 1, measureText).width],
  GetHeight: (ctx, self) => [deriveSize(widgetOf(ctx, self), 1, measureText).height],
  SetPoint: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const point = String(args[0]).toUpperCase() as AnchorPoint;

    // Two overload families: (point, x, y) anchors to the parent at the SAME point, and
    // (point, relativeTo[, relativePoint][, x, y]) anchors elsewhere. A NUMBER in slot 1 -- not a
    // frame, a name, or nil -- is the only tell for the first family; nil in slot 1 is the second
    // family's "anchor to the parent" spelling, not the first family's.
    let relativeToId: string | undefined;
    let relativePoint: AnchorPoint;
    let x: number;
    let y: number;
    if (typeof args[1] === 'number') {
      relativeToId = resolveRelativeTo(ctx, self, undefined);
      relativePoint = point;
      x = Number(args[1] ?? 0);
      y = Number(args[2] ?? 0);
    } else {
      // `relativeTo` occupies this slot whether it is a frame, a name, or an EXPLICIT nil --
      // `SetPoint("P", nil, "P", 40, -40)` is the common FrameXML idiom for "anchor to the screen at
      // an offset" (samples/benilla's anchors.rs regression test for exactly this call). A present
      // nil must still consume its slot, or the offsets that follow shift left and land on the wrong
      // parameters -- silently dropping the real x/y, which is what pinned a screen-anchored frame to
      // the corner. `args.length`, not the VALUE at a slot, is what tells "this argument is absent"
      // apart from "this argument is nil": both read back as `undefined` from Lua.
      relativeToId = resolveRelativeTo(ctx, self, args[1]);
      if (typeof args[2] === 'string') {
        relativePoint = args[2].toUpperCase() as AnchorPoint;
        x = Number(args[3] ?? 0);
        y = Number(args[4] ?? 0);
      } else if (args.length >= 5) {
        // The relativePoint slot is PRESENT (an explicit nil) -- still consumed, so the offsets are
        // at 3/4, not 2/3. This branch is the one the same bug would otherwise skip.
        relativePoint = point;
        x = Number(args[3] ?? 0);
        y = Number(args[4] ?? 0);
      } else {
        // (point, relativeTo[, x, y]) -- no relativePoint slot at all.
        relativePoint = point;
        x = Number(args[2] ?? 0);
        y = Number(args[3] ?? 0);
      }
    }

    const anchor: Anchor = { point, relativePoint, x, y };
    if (relativeToId !== undefined) {
      anchor.relativeTo = relativeToId;
    }
    // Replace only the anchor at this POINT -- FrameXML stacks a TOPLEFT and a BOTTOMRIGHT call to
    // stretch a frame, and a second SetPoint("TOPLEFT", ...) is meant to move that corner, not add one.
    widget.setAnchors(...widget.anchors.filter((existing) => existing.point !== point), anchor);
    return [];
  },
  ClearAllPoints: (ctx, self) => {
    widgetOf(ctx, self).setAnchors();
    return [];
  },
  SetAllPoints: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const relativeToId = resolveRelativeTo(ctx, self, args[0]);
    const of = (point: AnchorPoint): Anchor => {
      const anchor: Anchor = { point, relativePoint: point, x: 0, y: 0 };
      if (relativeToId !== undefined) {
        anchor.relativeTo = relativeToId;
      }
      return anchor;
    };
    widget.setAnchors(of('TOPLEFT'), of('BOTTOMRIGHT'));
    return [];
  },
};

const LAYEREDREGION: MethodTable = {
  SetVertexColor: (ctx, self, args) => {
    widgetOf(ctx, self).vertexColor = toHex(
      Number(args[0] ?? 1),
      Number(args[1] ?? 1),
      Number(args[2] ?? 1),
    );
    return [];
  },
  /**
   * `GetVertexColor()` -> `r, g, b` as 0..1 floats.
   *
   * The read half of `SetVertexColor`, and it was absent. No 3.3.5a FrameXML file calls it -- the tint is
   * only ever written -- but its absence made the action bar's usable/unusable colour UNOBSERVABLE from
   * outside the renderer, which meant "the button is greyed" could not be checked without comparing
   * pixels. `alpha` is not returned: `Widget#vertexColor` is `#rrggbb` and carries none, and the region's
   * alpha is a separate field that `GetAlpha` already answers.
   */
  GetVertexColor: (ctx, self) => {
    const hex = widgetOf(ctx, self).vertexColor;
    const value = Number.parseInt(hex.replace('#', ''), 16);
    if (!Number.isFinite(value)) {
      return [1, 1, 1];
    }
    return [
      ((value >> 16) & 0xff) / 255,
      ((value >> 8) & 0xff) / 255,
      (value & 0xff) / 255,
    ];
  },
  SetTexCoord: (ctx, self, args) => {
    // The 8-argument (quad-corner) form is the client's general case; the 4-argument
    // (left, right, top, bottom) form used everywhere in GlueXML is the axis-aligned special case of
    // it. Only the latter is worth modeling -- `Widget.texCoords` is a plain `{u0,v0,u1,v1}` rect,
    // and no glue screen this project transcribes rotates or flips a texture's UVs.
    const [left, right, top, bottom] = args.map((value) => Number(value ?? 0));
    widgetOf(ctx, self).texCoords = { u0: left, v0: top, u1: right, v1: bottom };
    return [];
  },
  SetDrawLayer: (ctx, self, args) => {
    const layer = String(args[0] ?? '').toUpperCase();
    if (!isDrawLayer(layer)) {
      warnOnce(`SetDrawLayer: unknown layer '${layer}'`);
      return [];
    }
    widgetOf(ctx, self).layer = layer;
    return [];
  },
};

/**
 * The five FrameXML draw layers, as a runtime check -- `frame.ts`'s `CreateTexture`/`CreateFontString`
 * take a layer argument too, and share this rather than repeating the literal list.
 */
export function isDrawLayer(value: string): value is Layer {
  return value === 'BACKGROUND' || value === 'BORDER' || value === 'ARTWORK' || value === 'OVERLAY' || value === 'HIGHLIGHT';
}

const TEXTURE: MethodTable = {
  // `SetTexture("")` clears the slot -- the live API's blank form, which real FrameXML uses (an
  // authored `<Texture file="">` template override, most commonly). `nil` clears the same way.
  // The (r, g, b[, a]) overload is real too, and maps onto the flat-color quad `Widget.solid` exists
  // for (the edit-box caret's own mechanism).
  //
  // THE ALPHA IS APPLIED, and the reason the old comment gave for dropping it ("nothing in `widget.ts`
  // models a texture-local alpha") did not hold: a Texture is a Region, `SetAlpha` is registered on
  // REGION, and `drawList` multiplies each widget's OWN `alpha` down the ancestor chain -- so a texture
  // has had its own opacity all along. Dropping it made `realmlist.xml:260`'s
  // `<Texture setAllPoints="true"><Color a="0.75" r="0" g="0" b="0"/></Texture>` -- the full-screen dim
  // the realm list lays over the login screen -- an OPAQUE black sheet, which blacked out the whole
  // background scene and the login screen with it.
  //
  // It does land on the same field `SetAlpha` writes, and in the engine those are two channels rather
  // than one. Only the LAST caller wins here, which is exactly right for a colour fill (nothing sets
  // both) and would need a separate field the day some document animates a tinted quad's alpha.
  SetTexture: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const first = args[0];
    if (first === undefined || first === null || first === '') {
      widget.sprite = null;
      widget.solid = false;
      return [];
    }
    if (typeof first === 'number') {
      widget.solid = true;
      widget.sprite = null;
      widget.vertexColor = toHex(first, Number(args[1] ?? 0), Number(args[2] ?? 0));
      if (typeof args[3] === 'number') {
        widget.alpha = Math.max(0, Math.min(1, args[3]));
      }
      return [];
    }
    widget.sprite = String(first);
    widget.solid = false;
    return [];
  },
  SetBlendMode: (ctx, self, args) => {
    // Widget only models ALPHA/ADD (the glue art this project draws never uses MOD/multiply). ADD
    // maps directly; every other client token (BLEND, DISABLE, ALPHAKEY, MOD, ...) is closer to
    // ALPHA than to ADD, so it is the honest default rather than a guess dressed up as one of them.
    const mode = String(args[0] ?? '').toUpperCase();
    widgetOf(ctx, self).blend = mode === 'ADD' ? 'ADD' : 'ALPHA';
    return [];
  },
  SetDesaturated: notImplemented('SetDesaturated', 'widget.ts has no desaturation field yet'),
};

/**
 * A `FontSpec`, created on first use so a Texture never carries one and a FontString always can.
 *
 * Exported for `kinds.ts#GetTextWidth`, which measures a BUTTON's caption the same way
 * `GetStringWidth` measures a font string's own text -- one measurement rule, not two.
 */
export function ensureFont(widget: Widget) {
  if (!widget.font) {
    // `align: 'CENTER'` -- THE FRAMEXML DEFAULT, and getting this wrong was the owner's "the target's
    // name is drawn over itself and unreadable". The engine's `JustifyH` field defaults to CENTER
    // (`benilla-ui/src/script/types.rs:176-183`, and `loader/mod.rs:388` / `region.rs:542` both fall
    // back to `JustifyH::Center` for an unrecognised value), so a `<FontString>` that declares no
    // `justifyH` and inherits a font object that declares none either -- which is most of them --
    // centres its text in its own rect. `TargetFrameTextureFrameName` is the sharp case: 100x10,
    // anchored CENTER at (-50, 19) (`targetframe.xml:248-259`), inheriting `GameFontNormalSmall`
    // whose whole chain to `SystemFont_Shadow_Small` (`fonts.xml:31`) declares no justification. Flush
    // LEFT it starts 50 units left of where the client puts it, on top of the health bar's left cap.
    // Measured live as `Sgh` targeting a Vale Moth (`scratchpad/t17b-real-name.png`).
    // The client's own files corroborate the default: `targetframe.xml:516` spells `justifyH="LEFT"`
    // out explicitly and `:81` spells `"RIGHT"`, which authors would not need if either were default.
    widget.font = { family: 'FRIZQT', size: 12, color: '#ffffff', outline: false, align: 'CENTER' };
  }
  return widget.font;
}

/**
 * A `Set*FontObject` argument, as the name of a registered `<Font>`.
 *
 * Both forms are real and both are in the loaded manifest: the OBJECT
 * (`SetNormalFontObject(RealmCharactersNormal)`, realmlist.lua:123 -- the Lua global the loader
 * publishes for each `<Font name=>`) and the STRING
 * (`SetDisabledFontObject("GlueFontHighlightSmall")`, realmlist.lua:236). Anything else, including nil,
 * yields null and the caller leaves the font alone.
 *
 * The handle is BORROWED -- the method boundary releases every ref among a call's arguments -- so
 * nothing here unrefs it.
 */
export function fontObjectName(ctx: MethodContext, value: unknown): string | null {
  if (typeof value === 'string') {
    return value === '' ? null : value;
  }
  if (!ctx.vm.isRef(value)) {
    return null;
  }
  const name = ctx.vm.getTableField(value, 'name');
  if (ctx.vm.isRef(name)) {
    // `getTableField` mints a handle for a table- or function-valued field. Not our font object's
    // shape, but a caller may pass any table at all, and dropping the handle unreleased would pin a
    // registry slot per call for the life of the VM.
    ctx.vm.unref(name);
    return null;
  }
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * Resolves a font object by name and writes it onto `widget`'s `FontSpec`.
 *
 * PARTIAL BY DESIGN: only the channels the chain actually declares are written, so a font object that
 * overrides nothing but `<Color>` (there are 20 of those in `gluefontstyles.xml`) keeps the face,
 * height and outline it inherited rather than resetting them to a default. That is also what makes the
 * per-state button fonts work -- `RealmDownHighlight` is a colour and nothing else.
 *
 * Returns false when no font object of that name is registered, which is what the caller turns into a
 * warning: a name that resolves to nothing must not look like a successful call.
 */
export function applyFontObject(ctx: MethodContext, widget: Widget, name: string): boolean {
  if (ctx.fontObject === null) {
    warnOnce(
      `Set*FontObject("${name}"): no font-object registry is installed on this MethodContext, so the font was not applied`,
    );
    return false;
  }
  const resolved = ctx.fontObject(name);
  if (resolved === null) {
    warnOnce(`Set*FontObject: no <Font> named '${name}' is registered; the font was not changed`);
    return false;
  }
  applyFontResolution(widget, resolved, name);
  return true;
}

/** The write half of `applyFontObject`, separate only so the loader's own resolution can share it. */
export function applyFontResolution(widget: Widget, resolved: FontResolution, dbg: string): void {
  const spec = ensureFont(widget);
  if (resolved.file !== undefined) {
    const family = familyForFontFile(resolved.file);
    if (family === null) {
      warnOnce(`${dbg}: unknown font file '${resolved.file}'; the face was not changed`);
    } else {
      spec.family = family;
    }
  }
  if (resolved.height !== undefined) {
    spec.size = resolved.height;
  }
  if (resolved.outline !== undefined) {
    // The XML vocabulary (`NONE`/`NORMAL`/`THICK`), not `SetFont`'s flags string -- see
    // `fonts.ts#isOutlined` for why conflating the two dropped the ring off every outlined font.
    spec.outline = isOutlined(resolved.outline);
  }
  if (resolved.color !== undefined) {
    spec.color = toHex(resolved.color[0], resolved.color[1], resolved.color[2]);
  }
  const align = (resolved.justifyH ?? '').toUpperCase();
  if (align === 'LEFT' || align === 'CENTER' || align === 'RIGHT') {
    spec.align = align;
  }
}

const FONTSTRING: MethodTable = {
  SetText: (ctx, self, args) => {
    widgetOf(ctx, self).text = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    return [];
  },
  GetText: (ctx, self) => [widgetOf(ctx, self).text],
  SetFormattedText: (ctx, self, args) => {
    const format = String(args[0] ?? '');
    let index = 1;
    widgetOf(ctx, self).text = format.replace(/%[sd%]/g, (token) =>
      token === '%%' ? '%' : String(args[index++] ?? ''),
    );
    return [];
  },
  // Real `SetTextColor` also takes an alpha channel; `FontSpec.color` is a plain `#rrggbb` with
  // nowhere to put it, so (like `SetTexture`'s color overload) it is dropped rather than folded into
  // the frame's own `SetAlpha`, which would change what `GetAlpha` reports for an unrelated reason.
  SetTextColor: (ctx, self, args) => {
    ensureFont(widgetOf(ctx, self)).color = toHex(
      Number(args[0] ?? 1),
      Number(args[1] ?? 1),
      Number(args[2] ?? 1),
    );
    return [];
  },
  SetFont: (ctx, self, args) => {
    const family = familyForFontFile(String(args[0] ?? ''));
    if (family === null) {
      warnOnce(`SetFont: unknown font file '${args[0]}'`);
      return [false];
    }
    const spec = ensureFont(widgetOf(ctx, self));
    spec.family = family;
    spec.size = Number(args[1] ?? spec.size);
    const flags = String(args[2] ?? '').toUpperCase();
    spec.outline = flags.includes('OUTLINE');
    return [true];
  },
  // REAL now: `ctx.fontObject` is the live name -> font-values lookup the loader installs over its
  // `<Font>` registry (`framexml/fonts.ts`), so the font object a document declared and the one a Lua
  // call names are the same thing. `GlueTooltip_SetFont` (gluetooltip.xml:41-51) is the manifest's
  // caller: four `textString:SetFontObject(font)` on a tooltip's own font strings.
  SetFontObject: (ctx, self, args) => {
    const name = fontObjectName(ctx, args[0]);
    if (name === null) {
      warnOnce('SetFontObject: the argument is neither a font object nor a <Font> name; ignored');
      return [];
    }
    applyFontObject(ctx, widgetOf(ctx, self), name);
    return [];
  },
  GetStringWidth: (ctx, self) => {
    const widget = widgetOf(ctx, self);
    return [measureText(widget.text, ensureFont(widget), 1).width];
  },
  SetJustifyH: (ctx, self, args) => {
    const value = String(args[0] ?? '').toUpperCase();
    if (value !== 'LEFT' && value !== 'CENTER' && value !== 'RIGHT') {
      warnOnce(`SetJustifyH: unknown justification '${value}'`);
      return [];
    }
    ensureFont(widgetOf(ctx, self)).align = value as 'LEFT' | 'CENTER' | 'RIGHT';
    return [];
  },
  SetJustifyV: notImplemented('SetJustifyV', 'FontSpec has no vertical-justify field yet'),
};

registerMethods('REGION', REGION);
registerMethods('LAYEREDREGION', LAYEREDREGION);
registerMethods('TEXTURE', TEXTURE);
registerMethods('FONTSTRING', FONTSTRING);

// `frame.ts` needs the same "id -> live Widget" lookup and the same warn-once channel for its own
// stubs, and re-opening either there would split the memo `warnOnce` relies on to log once per
// message rather than once per module.
export { widgetOf };
