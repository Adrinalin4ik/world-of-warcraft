/**
 * BUTTON, CHECKBUTTON and EDITBOX: the classes that give the client's UI its buttons and text entry.
 *
 * Placement matters here more than anywhere else in the object model: the chain is
 * `CHECKBUTTON <- BUTTON <- FRAME`, so `CHECKBUTTON`'s own table is consulted BEFORE `BUTTON`'s
 * (`object.ts`'s `chainOf`). `Enable`/`Disable`/`IsEnabled`/`SetButtonState`/... are real Button
 * methods a CheckButton also answers to by inheritance, so they live on `BUTTON` ONLY -- copying them
 * onto `CHECKBUTTON` too would still work today (the dispatch cache does not care which table answered)
 * but would silently stop being true the moment Button's behaviour changes and CheckButton's copy does
 * not, which is exactly the duck-typing leak `object.ts`'s docstring and Task 3's review both warn
 * about. `SetChecked`/`GetChecked`/`SetCheckedTexture`/`GetCheckedTexture` are the reverse case: a
 * plain Button has no `checked` concept at all, so those live on `CHECKBUTTON` only.
 *
 * `EDITBOX` is a sibling of `BUTTON` under `FRAME` (`object.ts`'s `CLASS_PARENT`), not a descendant --
 * it shares no methods with Button beyond what FRAME already gives both.
 */
import { MethodContext, MethodTable, onFrameTeardown, registerMethods } from '../object';
import { Anchor } from '../../../layout';
import { Widget } from '../../../widget';
import { notImplemented, widgetOf } from './region';

/** `0..1` floats to the `#rrggbb` string `Widget` stores colors as -- duplicated from `region.ts`'s
 * private helper of the same shape rather than exported, since it is three lines and not worth a
 * cross-module dependency for. */
function toHex(r: number, g: number, b: number): string {
  const channel = (value: number) =>
    Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Anchors `region` to fill `parent` exactly -- the default a state texture or button label starts
 * at, same as `SetAllPoints` in `region.ts`. A later `region:SetPoint(...)` overrides this the same
 * way it would override an XML-authored anchor. */
function fillParent(region: Widget, parent: Widget): void {
  const of = (point: 'TOPLEFT' | 'BOTTOMRIGHT'): Anchor => ({
    point,
    relativePoint: point,
    relativeTo: parent.id,
    x: 0,
    y: 0,
  });
  region.setAnchors(of('TOPLEFT'), of('BOTTOMRIGHT'));
}

/**
 * Per-button state-texture regions.
 *
 * `Button:SetNormalTexture("path")` creates a real child TEXTURE region the first time it is called
 * for a given button -- mirroring the reference, which creates the region THROUGH the setter -- and
 * `Button:GetNormalTexture()` hands back that SAME region every time, through `ctx.wrapper`, so a
 * later `button:GetNormalTexture():SetTexCoord(...)` (a real addon idiom, used to pick one icon out
 * of a sprite sheet) lands on the right object rather than minting a new one that nothing draws.
 *
 * Every slot has BOTH halves, and the getters are not optional conveniences: the XML loader
 * (`framexml/loader.ts`) creates a state texture through the setter and then decorates whatever the
 * matching getter hands back, because the setter is the region's lazy constructor and takes nothing but
 * a file. With `GetPushedTexture`/`GetDisabledTexture`/`GetHighlightTexture` missing (as they were
 * until Task 7 needed them), the loader silently dropped `alphaMode`, `<Size>`, `<Anchors>` and
 * `<TexCoords>` for those three slots -- and `alphaMode="ADD"` on a glue button's `<HighlightTexture>`
 * is the difference between an additive glow and an opaque grey bar over the button.
 *
 * Each slot keeps its OWN region (never a shared one), since setting one must not overwrite another.
 */
type StateSlot = 'normal' | 'pushed' | 'disabled' | 'highlight';
const stateTextures = new Map<number, Partial<Record<StateSlot, number>>>();
const checkedTextures = new Map<number, number>();
const buttonLabels = new Map<number, number>();
/** `LockHighlight`/`UnlockHighlight`: which buttons have forced their highlight on regardless of hover. */
const highlightLocked = new Set<number>();

/**
 * All four tables above are keyed by frame id, so all four go the same way as the frame -- see
 * `object.ts`'s `FRAME_TEARDOWN`. Not in the ledger's list of four leaks (which named `scripts.ts`,
 * `events.ts` and `frame.ts`'s `frameIds`), but the same root cause and the same fix: a glue screen
 * has a state-texture entry per button and a label per captioned one, so every rebuild added a set.
 * The REGIONS themselves are registry frames and are released by the same `reset()`; these tables
 * only hold their ids.
 */
onFrameTeardown((_ctx, id) => {
  stateTextures.delete(id);
  checkedTextures.delete(id);
  buttonLabels.delete(id);
  highlightLocked.delete(id);
});

function ensureStateTextureId(ctx: MethodContext, self: number, slot: StateSlot): number {
  let bySlot = stateTextures.get(self);
  if (bySlot === undefined) {
    bySlot = {};
    stateTextures.set(self, bySlot);
  }
  let id = bySlot[slot];
  if (id === undefined) {
    id = ctx.registry.create('Texture', null, self);
    fillParent(ctx.registry.widget(id)!, widgetOf(ctx, self));
    bySlot[slot] = id;
  }
  return id;
}

function ensureCheckedTextureId(ctx: MethodContext, self: number): number {
  let id = checkedTextures.get(self);
  if (id === undefined) {
    id = ctx.registry.create('Texture', null, self);
    fillParent(ctx.registry.widget(id)!, widgetOf(ctx, self));
    checkedTextures.set(self, id);
  }
  return id;
}

function ensureLabelId(ctx: MethodContext, self: number): number {
  let id = buttonLabels.get(self);
  if (id === undefined) {
    id = ctx.registry.create('FontString', null, self);
    const label = ctx.registry.widget(id)!;
    fillParent(label, widgetOf(ctx, self));
    label.font = { family: 'FRIZQT', size: 12, color: '#ffffff', outline: false, align: 'CENTER' };
    buttonLabels.set(self, id);
  }
  return id;
}

/**
 * Applies a `SetXTexture` argument: a sprite-sheet key, or nil/`''` to clear. Real FrameXML never
 * passes the `(r, g, b)` solid-colour overload `TEXTURE.SetTexture` (`region.ts`) special-cases to a
 * STATE texture, so this does not repeat that branch.
 */
function applyStateArg(region: Widget, arg: unknown): void {
  region.sprite = arg === undefined || arg === null || arg === '' ? null : String(arg);
}

/**
 * Recomputes which of Normal/Pushed/Disabled is visible for the button's CURRENT `state`, mutually
 * exclusive.
 *
 * THE RULE the byte-verified client enforces, preserved here on purpose: a disabled button whose
 * Disabled texture was never set draws NOTHING while disabled -- there is no fallback to Normal. That
 * is why this is a straight three-way switch with no "else use normal" branch; an empty equipment
 * slot in the real client is empty for exactly this reason, and adding a fallback here would make
 * every unset Disabled texture look like an enabled button instead of a blank one.
 *
 * Known gap, honestly stated rather than papered over: `input.ts`'s `onPointerDown`/`onPointerUp`
 * write `widget.state` DIRECTLY on every press and release, the same way they do for every
 * hand-written screen (`screens/login.ts`, `screens/realms.ts`) -- and those screens re-poll
 * `button.state` every render tick to move `.sprite` themselves. Nothing does that generic per-frame
 * poll for a Lua-driven tree yet, so a texture set here stays correct for every state change that
 * goes through `Enable`/`Disable`/`SetButtonState` (every method below that can change `state` calls
 * this), but a raw mouse press that never reaches Lua will not repaint a state texture until one of
 * those methods runs again. Wiring a per-frame sync is a renderer-side change outside this file.
 */
function syncStateTextures(ctx: MethodContext, self: number): void {
  const bySlot = stateTextures.get(self);
  if (bySlot === undefined) {
    return;
  }
  const state = widgetOf(ctx, self).state;
  const show = (slot: StateSlot, visible: boolean) => {
    const id = bySlot[slot];
    if (id !== undefined) {
      ctx.registry.widget(id)!.shown = visible;
    }
  };
  show('normal', state === 'up');
  show('pushed', state === 'down');
  show('disabled', state === 'disabled');
}

const BUTTON: MethodTable = {
  SetText: (ctx, self, args) => {
    const label = ctx.registry.widget(ensureLabelId(ctx, self))!;
    label.text = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    return [];
  },
  GetText: (ctx, self) => {
    const id = buttonLabels.get(self);
    return [id === undefined ? '' : ctx.registry.widget(id)!.text];
  },
  // Real `GetFontString` returns nil for a button that has never had `SetText`/`SetNormalFontObject`
  // called -- unlike `GetNormalTexture` below, nothing forces this one to exist up front.
  GetFontString: (ctx, self) => {
    const id = buttonLabels.get(self);
    return [id === undefined ? null : ctx.wrapper(id)];
  },

  Enable: (ctx, self) => {
    const widget = widgetOf(ctx, self);
    if (widget.state === 'disabled') {
      widget.state = 'up';
      syncStateTextures(ctx, self);
    }
    return [];
  },
  Disable: (ctx, self) => {
    widgetOf(ctx, self).state = 'disabled';
    syncStateTextures(ctx, self);
    return [];
  },
  IsEnabled: (ctx, self) => [widgetOf(ctx, self).state !== 'disabled'],

  LockHighlight: (ctx, self) => {
    highlightLocked.add(self);
    const id = stateTextures.get(self)?.highlight;
    if (id !== undefined) {
      ctx.registry.widget(id)!.shown = true;
    }
    return [];
  },
  UnlockHighlight: (ctx, self) => {
    highlightLocked.delete(self);
    const id = stateTextures.get(self)?.highlight;
    if (id !== undefined) {
      // Best-effort, not a live binding: falls back to the CURRENT hover flag rather than one that
      // stays in sync with the mouse -- the same gap `syncStateTextures` documents for press/release.
      ctx.registry.widget(id)!.shown = widgetOf(ctx, self).hovered;
    }
    return [];
  },

  SetButtonState: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    // Disabled is `Enable`/`Disable`'s call, not this one's -- the real API's two `SetButtonState`
    // values (`NORMAL`/`PUSHED`) never reach a disabled button either.
    if (widget.state === 'disabled') {
      return [];
    }
    widget.state = String(args[0] ?? '').toUpperCase() === 'PUSHED' ? 'down' : 'up';
    syncStateTextures(ctx, self);
    return [];
  },
  GetButtonState: (ctx, self) => {
    const state = widgetOf(ctx, self).state;
    return [state === 'down' ? 'PUSHED' : state === 'disabled' ? 'DISABLED' : 'NORMAL'];
  },
  // Real `Click()` fires even on a disabled button -- it is a forced simulated click, not a pointer
  // event the input router would refuse.
  Click: (ctx, self) => {
    widgetOf(ctx, self).onClick?.();
    return [];
  },

  SetNormalTexture: (ctx, self, args) => {
    applyStateArg(ctx.registry.widget(ensureStateTextureId(ctx, self, 'normal'))!, args[0]);
    syncStateTextures(ctx, self);
    return [];
  },
  GetNormalTexture: (ctx, self) => [ctx.wrapper(ensureStateTextureId(ctx, self, 'normal'))],
  SetPushedTexture: (ctx, self, args) => {
    applyStateArg(ctx.registry.widget(ensureStateTextureId(ctx, self, 'pushed'))!, args[0]);
    syncStateTextures(ctx, self);
    return [];
  },
  GetPushedTexture: (ctx, self) => [ctx.wrapper(ensureStateTextureId(ctx, self, 'pushed'))],
  SetDisabledTexture: (ctx, self, args) => {
    applyStateArg(ctx.registry.widget(ensureStateTextureId(ctx, self, 'disabled'))!, args[0]);
    syncStateTextures(ctx, self);
    return [];
  },
  GetDisabledTexture: (ctx, self) => [ctx.wrapper(ensureStateTextureId(ctx, self, 'disabled'))],
  SetHighlightTexture: (ctx, self, args) => {
    const region = ctx.registry.widget(ensureStateTextureId(ctx, self, 'highlight'))!;
    applyStateArg(region, args[0]);
    // Starts visible only if the highlight is already locked on; otherwise hidden until a hover (or
    // `LockHighlight`) shows it -- see `syncStateTextures`'s note on what actually drives that.
    region.shown = highlightLocked.has(self);
    return [];
  },
  // Hands back the region WITHOUT changing its visibility -- `SetHighlightTexture` above owns that
  // decision, and a getter that re-ran it would show a hover highlight because the loader asked for
  // the region in order to size it.
  GetHighlightTexture: (ctx, self) => [ctx.wrapper(ensureStateTextureId(ctx, self, 'highlight'))],

  // All three: real FrameXML names a global `Font` template (`GameFontNormal`, ...) that these switch
  // a button's label/highlight/disabled text to wholesale. Nothing in this runtime keeps a
  // name -> FontSpec registry -- same gap `FONTSTRING.SetFontObject` documents in `region.ts`.
  SetNormalFontObject: notImplemented('SetNormalFontObject', 'no runtime Font-object registry exists yet'),
  SetHighlightFontObject: notImplemented('SetHighlightFontObject', 'no runtime Font-object registry exists yet'),
  SetDisabledFontObject: notImplemented('SetDisabledFontObject', 'no runtime Font-object registry exists yet'),
  // Real `Button:SetTextColor` also takes an alpha channel `FontSpec.color` has nowhere to put --
  // dropped for the same reason `FONTSTRING.SetTextColor` drops it in `region.ts`.
  SetTextColor: (ctx, self, args) => {
    const label = ctx.registry.widget(ensureLabelId(ctx, self))!;
    label.font!.color = toHex(Number(args[0] ?? 1), Number(args[1] ?? 1), Number(args[2] ?? 1));
    return [];
  },
};

const CHECKBUTTON: MethodTable = {
  SetChecked: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    widget.checked = Boolean(args[0]);
    const id = checkedTextures.get(self);
    if (id !== undefined) {
      ctx.registry.widget(id)!.shown = widget.checked;
    }
    return [];
  },
  GetChecked: (ctx, self) => [widgetOf(ctx, self).checked],
  SetCheckedTexture: (ctx, self, args) => {
    const region = ctx.registry.widget(ensureCheckedTextureId(ctx, self))!;
    applyStateArg(region, args[0]);
    region.shown = widgetOf(ctx, self).checked;
    return [];
  },
  GetCheckedTexture: (ctx, self) => [ctx.wrapper(ensureCheckedTextureId(ctx, self))],
};

/**
 * Anchors an EditBox's adopted text region to the box's rect shrunk by its `TextInsets`.
 *
 * Two opposing anchors rather than a size, so `resolveAnchors` derives the rect and nothing here
 * restates the arithmetic -- and `y` is FrameXML's (+up), so the BOTTOMRIGHT anchor's `+bottom` lifts
 * the bottom edge. The authored insets on the login boxes have NO top (accountlogin.xml:235), which is
 * the whole reason this cannot be a "centre it" shortcut: the text is centred in the box shrunk from
 * the bottom only, so it rides slightly high, and that is what the client draws.
 */
function anchorTextRegion(box: Widget): void {
  const region = box.textRegion;
  if (region === null) {
    return;
  }
  const insets = box.textInsets;
  region.setAnchors(
    {
      point: 'TOPLEFT',
      relativeTo: box.id,
      relativePoint: 'TOPLEFT',
      x: insets.left,
      y: -insets.top,
    },
    {
      point: 'BOTTOMRIGHT',
      relativeTo: box.id,
      relativePoint: 'BOTTOMRIGHT',
      x: -insets.right,
      y: insets.bottom,
    },
  );
}

const EDITBOX: MethodTable = {
  SetText: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    widget.text = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    // Real `SetText` leaves the cursor at the end of the new string -- the same place `input.ts`'s
    // `setFocus` puts it when a box first gains focus.
    widget.caret = widget.text.length;
    widget.selectionAnchor = widget.caret;
    return [];
  },
  GetText: (ctx, self) => [widgetOf(ctx, self).text],

  // `input.ts`'s `GlueInput` owns the live focus pointer, and is not reachable from `MethodContext`:
  // it is constructed per-screen (see `screens.ts`), outside anything the object model holds a handle
  // to. Wiring these for real needs `MethodContext` to carry that handle -- a change to `object.ts`
  // (Task 3's file), bigger than this task's own file scope (`lua/methods/kinds.ts`). Same shape of
  // gap as `frame.ts`'s `SetScale`/`SetBackdrop`.
  SetFocus: notImplemented('SetFocus', 'MethodContext has no GlueInput handle to move focus through'),
  ClearFocus: notImplemented('ClearFocus', 'MethodContext has no GlueInput handle to move focus through'),
  HasFocus: notImplemented('HasFocus', 'MethodContext has no GlueInput handle to ask', [false]),

  SetMaxLetters: (ctx, self, args) => {
    widgetOf(ctx, self).maxLetters = Number(args[0] ?? 0);
    return [];
  },
  // SetTextInsets(left, right, top, bottom). Real, now that `Widget` has the field: the insets are
  // what positions the adopted text region, so re-anchoring here is not a bonus -- a `SetTextInsets`
  // after the adoption (or a document whose `<TextInsets>` is applied after its `<FontString>`, which
  // is the order `loader.ts`'s steps happen to run in) would otherwise leave the text where the
  // previous insets put it.
  SetTextInsets: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    widget.textInsets = {
      left: Number(args[0] ?? 0),
      right: Number(args[1] ?? 0),
      top: Number(args[2] ?? 0),
      bottom: Number(args[3] ?? 0),
    };
    anchorTextRegion(widget);
    return [];
  },

  /**
   * SetTextRegion(fontString) -- OURS, not the client's API.
   *
   * The client's engine does this implicitly: an `<EditBox>`'s declared direct-child `<FontString>` IS
   * the region it draws typed text in, and there is no Lua call for it because no addon ever needs
   * one. This runtime materializes documents by calling the object model like an addon does
   * (`loader.ts`'s one decision), so the adoption needs a door, and this is it. The reference does the
   * same thing under the name `adopt_text_region`.
   *
   * Takes the DECLARED child, which is the caller's job to pass -- `loader.ts` passes the first direct
   * `<FontString>` of the box and nothing else. Adopting by searching the subtree instead is what once
   * grabbed a header out of a `<Layers>` block, so typing into the box overwrote a label.
   */
  SetTextRegion: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const regionId = ctx.frameIdOf(args[0]);
    const region = regionId === null ? null : ctx.registry.widget(regionId);
    if (region === null || region.kind !== 'fontstring') {
      throw new Error('SetTextRegion: the text region must be a FontString');
    }
    widget.textRegion = region;
    anchorTextRegion(widget);
    return [];
  },
  SetPassword: (ctx, self, args) => {
    widgetOf(ctx, self).password = Boolean(args[0]);
    return [];
  },
  // Real `SetAutoFocus` decides whether a box grabs focus the moment it becomes shown. Nothing in
  // this engine focuses a widget on `show()` at all (there is no such hook on `Widget`), so there is
  // no lifecycle event for this to attach to yet.
  SetAutoFocus: notImplemented('SetAutoFocus', 'nothing in this engine focuses a widget on show'),
  HighlightText: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const length = widget.text.length;
    const start = args[0] === undefined ? 0 : Number(args[0]);
    // Real API's `endPos` default (and any negative value) means "to the end of the text", not a
    // literal negative index.
    const rawEnd = args[1] === undefined ? length : Number(args[1]);
    const end = rawEnd < 0 ? length : rawEnd;
    widget.selectionAnchor = Math.max(0, Math.min(length, start));
    widget.caret = Math.max(0, Math.min(length, end));
    return [];
  },
  GetNumLetters: (ctx, self) => [widgetOf(ctx, self).text.length],
};

registerMethods('BUTTON', BUTTON);
registerMethods('CHECKBUTTON', CHECKBUTTON);
registerMethods('EDITBOX', EDITBOX);
