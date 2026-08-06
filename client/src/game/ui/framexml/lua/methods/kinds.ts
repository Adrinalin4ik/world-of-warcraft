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
import { FocusSink, MethodContext, MethodTable, onFrameTeardown, registerMethods } from '../object';
import { Anchor } from '../../../layout';
import { Widget } from '../../../widget';
import { applyFontObject, fontObjectName, notImplemented, warnOnce, widgetOf } from './region';

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
 * A button's three CAPTION FONTS, by state, as font-object NAMES.
 *
 * The engine keeps three font objects per button and draws the caption in whichever the current state
 * calls for; `FontSpec` holds one font per region, so the state is resolved here instead and the
 * winning font is written onto the one label. Names rather than resolved specs, because the name is
 * what the document and the client's Lua both say, and resolving on application keeps one code path
 * (`region.ts#applyFontObject`) rather than two snapshots that could disagree.
 *
 * `applied` is what makes writing it every tick safe: the poll only pushes a font when the WINNING
 * SLOT changes, so a `Button:SetTextColor` in between survives until the state actually moves -- which
 * is also what the engine does, since switching font objects is what resets a per-state colour.
 */
interface ButtonFonts {
  normal?: string;
  highlight?: string;
  disabled?: string;
  applied?: 'normal' | 'highlight' | 'disabled';
}
const buttonFonts = new Map<number, ButtonFonts>();

/**
 * All five tables above are keyed by frame id, so all five go the same way as the frame -- see
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
  buttonFonts.delete(id);
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
 * Stores one of a button's three caption font objects and repaints the caption if that slot is the one
 * in force. Shared by all three `Set*FontObject` methods, which differ only in the slot.
 */
function setButtonFont(
  ctx: MethodContext,
  self: number,
  slot: 'normal' | 'highlight' | 'disabled',
  arg: unknown,
): void {
  const name = fontObjectName(ctx, arg);
  if (name === null) {
    warnOnce(
      `Set${slot === 'normal' ? 'Normal' : slot === 'highlight' ? 'Highlight' : 'Disabled'}FontObject: the argument is neither a font object nor a <Font> name; ignored`,
    );
    return;
  }
  let fonts = buttonFonts.get(self);
  if (fonts === undefined) {
    fonts = {};
    buttonFonts.set(self, fonts);
  }
  fonts[slot] = name;
  // The slot in force may not have moved, but its NAME just did, so the memo has to be dropped or a
  // second `SetNormalFontObject` on the same button (which `RealmListUpdate` does on every refresh)
  // would be a no-op.
  fonts.applied = undefined;
  applyButtonFont(ctx, self);
}

/**
 * Writes whichever of the three caption fonts the button's CURRENT state calls for onto its label.
 *
 * The rule is the engine's: the disabled font while disabled, the highlight font while the pointer is
 * over it or `LockHighlight` holds it, the normal font otherwise -- and each falls back to the normal
 * font when its own slot was never set, because a button with only a `<NormalFont>` (most of them) must
 * not lose its caption font on hover. The transcription states the same rule from the other side:
 * `screens/realm-list-state.ts#realmNameColor` takes `highlighted = selected || hovered`, where
 * `selected` is the row `RealmListUpdate` calls `LockHighlight()` on (realmlist.lua:146).
 *
 * A no-op for a button with no label yet: `SetText` calls this after creating one, so a font object set
 * before any caption still lands.
 */
function applyButtonFont(ctx: MethodContext, self: number): void {
  const fonts = buttonFonts.get(self);
  const labelId = buttonLabels.get(self);
  if (fonts === undefined || labelId === undefined) {
    return;
  }
  const widget = ctx.registry.widget(self);
  const label = ctx.registry.widget(labelId);
  if (widget === null || label === null) {
    return;
  }
  const slot =
    widget.state === 'disabled'
      ? 'disabled'
      : highlightLocked.has(self) || widget.hovered
        ? 'highlight'
        : 'normal';
  if (fonts.applied === slot) {
    return;
  }
  const name = fonts[slot] ?? fonts.normal;
  if (name === undefined) {
    return;
  }
  applyFontObject(ctx, label, name);
  fonts.applied = slot;
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
 * `input.ts`'s `onPointerDown`/`onPointerUp` write `widget.state` DIRECTLY on every press and release,
 * the same way they do for every hand-written screen (`screens/login.ts`, `screens/realms.ts`) -- and
 * those screens re-poll `button.state` every render tick to move `.sprite` themselves. So this alone
 * only covers the state changes that go through `Enable`/`Disable`/`SetButtonState`; the generic
 * per-frame poll for a Lua-driven tree is `syncInteractiveArt` below, driven from
 * `framexml/runtime.ts#update`, which is what makes a raw press repaint.
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

/**
 * THE PER-FRAME POLL: everything about a button's art that follows from state the INPUT ROUTER owns.
 *
 * `input.ts` writes `widget.state` on a press and `widget.hovered` on a hover, and `input.ts` flips
 * `widget.checked` on a click of a checkbutton -- three fields, none of them reached through a method,
 * so none of them repainted anything. A hand-written screen re-reads all three every render tick
 * (`screens/login.ts:759-791`) and moves its own sprites; nothing did that for a Lua-built tree, which
 * is why a runtime button had no hover glow and no pushed art and a check button looked broken even
 * though its `OnClick` had run. `framexml/runtime.ts#update` calls this once per frame per button.
 *
 * A POLL rather than a callback, deliberately: the three fields are written from several places (the
 * router, `Enable`/`Disable`/`SetButtonState`, `SetChecked`, `LockHighlight`) and the art is a pure
 * function of them, so recomputing is both shorter and impossible to leave stale. It is also idempotent
 * -- `shown` is assigned, never toggled -- and it writes the field directly rather than calling
 * `Widget#show`, because `show()` re-stamps the draw order and doing that 60 times a second would
 * shuffle a bucket for no reason.
 *
 * The HIGHLIGHT is the one that needs a rule rather than a mirror: it is shown while the pointer is
 * over an enabled button, OR unconditionally while `LockHighlight` holds it (which is what
 * `UnlockHighlight` could only guess at before -- its comment called itself best-effort, and this is
 * what makes it live).
 */
export function syncInteractiveArt(ctx: MethodContext, self: number): void {
  const widget = ctx.registry.widget(self);
  if (widget === null) {
    return;
  }
  syncStateTextures(ctx, self);

  const highlight = stateTextures.get(self)?.highlight;
  if (highlight !== undefined) {
    const region = ctx.registry.widget(highlight);
    if (region !== null) {
      region.shown = highlightLocked.has(self) || (widget.hovered && widget.state !== 'disabled');
    }
  }

  const checked = checkedTextures.get(self);
  if (checked !== undefined) {
    const region = ctx.registry.widget(checked);
    if (region !== null) {
      region.shown = widget.checked;
    }
  }

  // The CAPTION follows the same three fields the art does -- the engine draws a hovered button's text
  // in its highlight font, and neither `hovered` nor a raw press goes through a method. Cheap because
  // `applyButtonFont` returns immediately unless the winning slot actually changed this tick.
  applyButtonFont(ctx, self);
}

const BUTTON: MethodTable = {
  SetText: (ctx, self, args) => {
    const label = ctx.registry.widget(ensureLabelId(ctx, self))!;
    label.text = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    // The label may have only just been created, with `ensureLabelId`'s FRIZQT 12 white default -- so
    // a font object set BEFORE any caption existed (the loader issues `<NormalFont>` after `SetText`,
    // but a Lua caller has no such order) lands here.
    applyButtonFont(ctx, self);
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

  // Each of the five state-moving methods below repaints the CAPTION as well as the art: a caller that
  // disables a button and reads its label back must not have to wait for the next frame's poll, and the
  // loader (and every unit test) never ticks at all.
  Enable: (ctx, self) => {
    const widget = widgetOf(ctx, self);
    if (widget.state === 'disabled') {
      widget.state = 'up';
      syncStateTextures(ctx, self);
      applyButtonFont(ctx, self);
    }
    return [];
  },
  Disable: (ctx, self) => {
    widgetOf(ctx, self).state = 'disabled';
    syncStateTextures(ctx, self);
    applyButtonFont(ctx, self);
    return [];
  },
  IsEnabled: (ctx, self) => [widgetOf(ctx, self).state !== 'disabled'],

  LockHighlight: (ctx, self) => {
    highlightLocked.add(self);
    const id = stateTextures.get(self)?.highlight;
    if (id !== undefined) {
      ctx.registry.widget(id)!.shown = true;
    }
    applyButtonFont(ctx, self);
    return [];
  },
  UnlockHighlight: (ctx, self) => {
    highlightLocked.delete(self);
    const id = stateTextures.get(self)?.highlight;
    if (id !== undefined) {
      // The CURRENT hover flag, which is now also what keeps it right from here on: the per-frame
      // `syncInteractiveArt` poll recomputes this every tick, so this line only decides the one frame
      // between the unlock and the next update.
      ctx.registry.widget(id)!.shown = widgetOf(ctx, self).hovered;
    }
    applyButtonFont(ctx, self);
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
    applyButtonFont(ctx, self);
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

  // All three real, over the font-object registry (`framexml/fonts.ts`) and the per-state resolution in
  // `applyButtonFont` above. `realmlist.lua:115-128` is the caller that made this worth doing: it picks
  // one of four `<Font>`s per realm row for the name and a matching highlight, which is the whole reason
  // a row with characters on it is green and one that is down is grey.
  SetNormalFontObject: (ctx, self, args) => {
    setButtonFont(ctx, self, 'normal', args[0]);
    return [];
  },
  SetHighlightFontObject: (ctx, self, args) => {
    setButtonFont(ctx, self, 'highlight', args[0]);
    return [];
  },
  SetDisabledFontObject: (ctx, self, args) => {
    setButtonFont(ctx, self, 'disabled', args[0]);
    return [];
  },
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

/**
 * The focus router, or the honest gap where one was not threaded in.
 *
 * `MethodContext.input` is optional (`object.ts`): the runtime that mounts a screen has a `GlueInput`
 * and passes it, and a test or a future caller that installs an object model with no router at all must
 * not get three silent no-ops. `notImplemented` is called HERE, lazily, rather than at module load, so
 * `NOT_IMPLEMENTED` gains the name only if the gap is ever actually reached -- registering it up front
 * would have the loader report a working method as a stub.
 *
 * Its RESULTS are the caller's, not this helper's: each of the three has a different honest answer for
 * "there is no router" (nothing, nothing, `false`), and threading a results array through here only to
 * discard what the factory returns would look like it was being used.
 */
function focusSinkOr(ctx: MethodContext, self: number, method: string): FocusSink | null {
  if (ctx.input !== null) {
    return ctx.input;
  }
  notImplemented(
    method,
    'no focus router was threaded into this object model -- installObjectModel was called without a GlueInput',
  )(ctx, self, []);
  return null;
}

const EDITBOX: MethodTable = {
  SetText: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const before = widget.text;
    widget.text = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    // Real `SetText` leaves the cursor at the end of the new string -- the same place `input.ts`'s
    // `setFocus` puts it when a box first gains focus.
    widget.caret = widget.text.length;
    widget.selectionAnchor = widget.caret;
    // THE ENGINE FIRES `OnTextChanged` FOR A `SetText` TOO, not only for typing, and that is not a
    // detail: `AccountLogin_OnShow` pre-fills the account box with `GetSavedAccountName()`, and the
    // ONLY thing that hides the "Enter your email address" placeholder is that box's `<OnTextChanged>`.
    // Without this the restored account name and the placeholder draw on top of each other, which is
    // exactly what the owner's screenshot shows. Guarded on a real change, for the same reason
    // `Show`/`Hide` dispatch the transition rather than the call -- `AccountLogin_Login` calls
    // `AccountLoginPasswordEdit:SetText("")` on an already-empty box.
    if (widget.text !== before) {
      widget.onTextChanged?.();
    }
    return [];
  },
  GetText: (ctx, self) => [widgetOf(ctx, self).text],

  // Real, now that `MethodContext` carries the screen's focus router (`object.ts`'s `FocusSink`). The
  // stub these replaced blamed the object model for not being able to reach `GlueInput` -- true, and the
  // fix was to hand it one rather than to keep the claim. `SetFocus` goes through `setFocus` rather than
  // writing a field, so it fires `OnEditFocusLost`/`OnEditFocusGained` and moves the caret exactly as a
  // mouse click into the box does: `AccountLogin_OnShow` focuses a box from Lua and the client's own
  // `<OnEditFocusGained>` (`self:HighlightText()`) has to run for it.
  SetFocus: (ctx, self) => {
    focusSinkOr(ctx, self, 'SetFocus')?.setFocus(widgetOf(ctx, self));
    return [];
  },
  // Only if THIS box has the focus. A blanket clear would let a box that lost focus ages ago yank it
  // off whatever holds it now, and the client calls `ClearFocus` from handlers that fire either way.
  ClearFocus: (ctx, self) => {
    const input = focusSinkOr(ctx, self, 'ClearFocus');
    if (input !== null && input.focused === widgetOf(ctx, self)) {
      input.setFocus(null);
    }
    return [];
  },
  HasFocus: (ctx, self) => {
    const input = focusSinkOr(ctx, self, 'HasFocus');
    return [input !== null && input.focused === widgetOf(ctx, self)];
  },

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
