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
import { FrameMethod, MethodContext, MethodTable, registerMethods } from '../object';
import { Anchor, AnchorPoint } from '../../../layout';
import { Layer, Widget } from '../../../widget';
import { familyForFontFile, measureText } from '../../../text';

const warned = new Set<string>();

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

const REGION: MethodTable = {
  Show: (ctx, self) => {
    widgetOf(ctx, self).show();
    return [];
  },
  Hide: (ctx, self) => {
    widgetOf(ctx, self).hide();
    return [];
  },
  // The widget's OWN flag, not the ancestor chain -- `IsVisible` below is the one that walks up.
  IsShown: (ctx, self) => [widgetOf(ctx, self).shown],
  IsVisible: (ctx, self) => [widgetOf(ctx, self).visible],
  GetName: (ctx, self) => [ctx.registry.nameOf(self)],
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
  GetWidth: (ctx, self) => [widgetOf(ctx, self).width],
  GetHeight: (ctx, self) => [widgetOf(ctx, self).height],
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
  // for (the edit-box caret's own mechanism) -- alpha is dropped, since nothing in `widget.ts` models
  // a texture-local alpha distinct from the frame's own `SetAlpha`.
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

/** A `FontSpec`, created on first use so a Texture never carries one and a FontString always can. */
function ensureFont(widget: Widget) {
  if (!widget.font) {
    widget.font = { family: 'FRIZQT', size: 12, color: '#ffffff', outline: false, align: 'LEFT' };
  }
  return widget.font;
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
  SetFontObject: () => {
    // Real FontXML names a global `Font` template (`GameFontNormal`, ...) that this call switches to
    // wholesale. Nothing in this runtime keeps a name -> FontSpec table of those templates -- the
    // loader (Task 7) resolves a `<FontString>`'s inherited font at DOCUMENT-LOAD time into a literal
    // spec, and there is no live registry for a runtime `SetFontObject` call to consult.
    warnOnce('SetFontObject: not implemented -- no runtime Font-object registry exists yet');
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
