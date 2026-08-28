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
import { MouseButtonName, Widget } from '../../../widget';

import {
  applyFontObject, ensureFont, fontObjectName, formatText, notImplemented, warnOnce, widgetOf,
} from './region';
import { measureText } from '../../../text';
import { effectiveFont } from '../../../widget';

/** Every button `RegisterForClicks` and `AnyUp`/`AnyDown` can name. */
const ALL_MOUSE_BUTTONS = [
  'LeftButton', 'RightButton', 'MiddleButton', 'Button4', 'Button5',
] as const satisfies readonly MouseButtonName[];


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
  if (arg === undefined || arg === null || arg === '') {
    region.sprite = null;
    return;
  }
  /**
   * **A NON-STRING IS NOT A PATH, and `String(arg)` on a table produced literal `"[object Object]"`.**
   *
   * The owner's console, on the world screen:
   *
   *     glue art missing: [object Object] ([object Object])
   *     Failed to decode texture: [OBJECT OBJECT].BLP
   *
   * `SetNormalTexture` and its siblings accept a TEXTURE OBJECT as well as a path -- the engine then
   * copies that texture's own sprite -- and `skillbuttons`/`GetSpellTabInfo` pass exactly that
   * (`Widget#sprite`'s note on `skillLineTab:SetNormalTexture(texture)`). Stringifying it registered a
   * nonsense path, which `registerTreeArt` then walked into a fetch and a BLP decode of a 404's HTML.
   *
   * DECLARED rather than guessed: copying the other region's live sprite is the engine's behaviour and
   * would need the wrapper resolved back to a widget, which this helper has no context for. Answering
   * null leaves the slot EMPTY -- visibly missing art, which is honest -- instead of a fabricated path
   * that reports as a decode failure and blames the texture pipeline.
   */
  if (typeof arg !== 'string') {
    warnOnce(
      'SetNormalTexture/SetPushedTexture/SetDisabledTexture was given a TEXTURE OBJECT rather than a '
      + 'path. The engine copies the other texture sprite; this client leaves the slot empty, so the '
      + 'button draws without that state art.',
    );
    region.sprite = null;
    return;
  }
  region.sprite = arg;
}

/**
 * Recomputes which of Normal/Pushed/Disabled is visible for the button's CURRENT `state`, mutually
 * exclusive.
 *
 * **THE TWO SLOTS DO NOT SHARE A RULE, and treating them alike hid the spellbook tabs' icons.**
 * The reference states both halves off the byte-verified `SetState 0x779790`
 * (`benilla-ui/src/widget/kinds/mod.rs:388-418`, `region_visible`):
 *
 *  - DISABLED has **no fallback**: a disabled button whose Disabled texture was never set draws
 *    NOTHING. An empty equipment slot in the real client is empty for exactly this reason, and a
 *    fallback would make every unset Disabled texture look like an enabled button.
 *  - PUSHED **falls back to Normal**: `self.pushed.or(self.normal)`, and the reference says why in
 *    words -- "a pressed button without pushed art keeps its normal art in the reference".
 *
 * This function had the disabled rule applied to both, and that was the owner's report: holding the
 * mouse on a spellbook skill-line tab made its icon vanish and releasing brought it back.
 * `SpellBookSkillLineTabTemplate` authors **no `<PushedTexture>` at all** and its `<NormalTexture/>` is
 * the ICON (`spellbookframe.xml:9-44`; `spellbookframe.lua:110` does
 * `skillLineTab:SetNormalTexture(texture)` from `GetSpellTabInfo`'s second return), so hiding Normal on
 * the press left only the tab's BACKGROUND frame art -- a visible tab with a hole in it. The same file
 * gives the SPELL buttons a real `<PushedTexture file="Interface\Buttons\UI-Quickslot-Depress"/>`
 * (`:191`), which is the authorship argument on its own: a document that gives one button depress art
 * and its neighbour none is not asking for the neighbour to blank.
 *
 * Keyed on the REGION EXISTING, not on it carrying a sprite -- which is what `Option<RegionHandle>`
 * means in the reference. A region with a null sprite is skipped by the renderer anyway, so the two
 * readings agree on screen and this one agrees with the reference's model.
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
  // `pushed.or(normal)`: a button with no Pushed region keeps its Normal art down through the press.
  const pushed = state === 'down' && bySlot.pushed !== undefined;
  show('normal', state === 'up' || (state === 'down' && !pushed));
  show('pushed', pushed);
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
  /**
   * `SetFormattedText(format, ...)` -- REAL API on a Button, and **the gossip menu does not draw a
   * single row without it.**
   *
   * FOUND LIVE at a Northshire questgiver. `GossipFrameAvailableQuestsUpdate` and
   * `GossipFrameActiveQuestsUpdate` both title their row with
   * `titleButton:SetFormattedText(NORMAL_QUEST_DISPLAY, select(i, ...))`
   * (`gossipframe.lua:93,96,124,127`) -- on the BUTTON, not on its font string. With the method absent
   * the raise landed inside the loop that builds the rows, so a questgiver's menu came up with five
   * buttons shown, all of them blank, and the greeting empty: measured
   * `options: []`, one available quest decoded off the wire as
   * `{ questId 18, title "Brotherhood of Thieves" }`, and `GossipTitleButton1:GetText()` empty.
   *
   * `GossipFrameOptionsUpdate` uses plain `SetText`, which is why a pure vendor's "Let me browse your
   * goods" row would have drawn and a questgiver's would not -- the same document, two methods, one
   * present.
   *
   * Delegates through `ensureLabelId` + `applyButtonFont` exactly as `SetText` above does, and shares
   * `region.ts#formatText` with the FontString version so the two cannot drift on `%s` handling.
   */
  SetFormattedText: (ctx, self, args) => {
    const label = ctx.registry.widget(ensureLabelId(ctx, self))!;
    label.text = formatText(args);
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
  /**
   * The width of the button's CAPTION, not of the button -- `GetWidth` is the button's.
   *
   * Real, because it is arithmetic the client depends on: `CharacterSelect_TabResize`
   * (characterselect.lua:413-421) sizes the Change Realm and Create Character buttons to
   * `GetTextWidth() - 8` plus twice their left cap, so a stub answering 0 would collapse both to their
   * end caps. Measured through the same `measureText` a `<FontString>`'s `GetStringWidth` uses, at
   * scale 1, for the same reason that one gives (`region.ts#GetWidth`): a widget's size is in authored
   * units and no Lua caller expects device pixels back.
   */
  GetTextWidth: (ctx, self) => {
    const id = buttonLabels.get(self);
    if (id === undefined) {
      return [0];
    }
    const label = ctx.registry.widget(id)!;
    return [measureText(label.text, ensureFont(label), 1).width];
  },
  /**
   * `GetTextHeight()` -- the twin of `GetTextWidth`, and **a blocker for the gossip menu rather than a
   * symmetry exercise.**
   *
   * `GossipResize(titleButton)` is one line -- `titleButton:SetHeight(titleButton:GetTextHeight() + 2)`
   * (`gossipframe.lua:171-173`) -- and it runs for EVERY row of a gossip menu, from all three of
   * `GossipFrameAvailableQuestsUpdate`, `GossipFrameActiveQuestsUpdate` and
   * `GossipFrameOptionsUpdate`. A nil method there raises inside the loop that is building the buttons,
   * so the menu would have come up with NO ROWS AT ALL -- including "Let me browse your goods", which
   * is how most vendors in the game are opened. `questframe.lua:239,279` calls it the same way.
   *
   * Found by a static sweep of every name `MerchantFrame`/`GossipFrame` calls against what this client
   * registers, not by a click. It is the one genuine gap that sweep turned up: `SetDesaturation` looked
   * like a second, and is not -- it is FrameXML's own (`uiparent.lua:2799`), and it reads the RESULT of
   * `texture:SetDesaturated`, which is a declared gap here answering nothing, so the client's own
   * `if ( not shaderSupported )` fallback takes over and greys the icon with `SetVertexColor` instead.
   * That is exactly what the real client does on hardware without the shader, so the gap composes
   * correctly and needed no change.
   *
   * Through `effectiveFont` and NOT through `ensureFont`, which is the one place this differs from its
   * sibling above -- the same asymmetry `region.ts#GetStringHeight` documents, and here it is
   * load-bearing rather than incidental: a gossip option long enough to wrap is precisely the case
   * `GossipResize` exists for, and `ensureFont` would report one line's height and collapse a two-line
   * option onto one row. Measured at scale 1, for the reason `GetTextWidth` gives.
   */
  GetTextHeight: (ctx, self) => {
    const id = buttonLabels.get(self);
    if (id === undefined) {
      return [0];
    }
    const label = ctx.registry.widget(id)!;
    return [measureText(label.text, effectiveFont(label) ?? ensureFont(label), 1).height];
  },
  /**
   * `RegisterForClicks("LeftButtonUp", "RightButtonUp", ...)` -- which buttons fire `OnClick`.
   *
   * **THIS WAS A DECLARED GAP AND THE GAP WAS WHY NOTHING COULD BE EQUIPPED.** Its reason was true when
   * written -- "`ui/input.ts` routes only a left-button press and hardcodes `LeftButton`, so nothing
   * downstream could honour a registration" -- and both halves of that are now false: the router reads
   * `PointerEvent#button` and reports the real one (`ui/input.ts#buttonName`). Its census was also wrong:
   * it named two callers, and there are **73 registrations across the manifest**, 37 of them exactly
   * `"LeftButtonUp", "RightButtonUp"`, including `ContainerFrameItemButton_OnLoad`
   * (`containerframe.lua:614`) -- the bag slot whose right-click is the equip gesture.
   *
   * The whole set of forms in the manifest is `<Button>Up`, `<Button>Down`, `AnyUp` and `AnyDown`. Only
   * the BUTTON half is kept; see `Widget#clickButtons` for why the phase is not honoured and why that is
   * the safe direction.
   *
   * An UNPARSEABLE entry is warned about rather than dropped silently, and it does not poison the rest of
   * the call: a registration this runtime cannot read must not turn into "no buttons at all", which would
   * make the frame dead to the mouse.
   *
   * **The XML ATTRIBUTE form is NOT wired, and it is one frame.** `registerForClicks=` appears exactly
   * once in the manifest -- `LFRBrowseButtonTemplate` (`lfrframe.xml:41`) -- and `loader.ts` does not
   * issue it. Left as a named gap rather than plumbed: the raid browser has no feed in this client, so
   * the attribute has no reachable effect, and every button that matters registers in Lua.
   */
  RegisterForClicks: (ctx, self, args) => {
    const buttons = new Set<MouseButtonName>();
    for (const arg of args) {
      if (typeof arg !== 'string') {
        continue;
      }
      const entry = arg.trim();
      const phase = /(Up|Down)$/.exec(entry);
      const name = phase === null ? entry : entry.slice(0, -phase[1].length);
      if (name === 'Any') {
        for (const any of ALL_MOUSE_BUTTONS) {
          buttons.add(any);
        }
      } else if ((ALL_MOUSE_BUTTONS as readonly string[]).includes(name)) {
        buttons.add(name as MouseButtonName);
      } else {
        warnOnce(`RegisterForClicks: unrecognised registration '${entry}'`);
      }
    }
    // An empty call is `RegisterForClicks()` with no arguments, which the engine treats as clearing the
    // registration -- so the frame goes back to the LEFT-only default rather than to "no buttons".
    widgetOf(ctx, self).clickButtons = buttons.size === 0 ? null : buttons;
    return [];
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
  Click: (ctx, self, args) => {
    // `Click([button])` -- the argument is real FrameXML (`Click("RightButton")` appears in the
    // manifest) and it defaults to the left button, which is what a bare `Click()` means.
    const button = typeof args[0] === 'string' ? (args[0] as MouseButtonName) : 'LeftButton';
    widgetOf(ctx, self).onClick?.(button);
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

/**
 * `SetChecked`'s argument, and a plain `Boolean()` on it was making EVERY SPELL IN THE BOOK look pressed.
 *
 * `SpellButton_UpdateSelection` is the whole evidence, and it is conclusive because it passes BOTH forms
 * from the two branches of one decision (`spellbookframe.lua:409-413`):
 *
 *     if ( IsSelectedSpell(id, SpellBookFrame.bookType) ) then
 *         self:SetChecked("true");
 *     else
 *         self:SetChecked("false");
 *     end
 *
 * -- with a third `self:SetChecked("false")` on the no-such-spell path at `:405`. `Boolean("false")` is
 * `true` in JS and `"false"` is truthy in Lua too, so every one of the twelve `SpellButton`s came back
 * CHECKED whatever the answer was, and `SpellButtonTemplate`'s `<CheckedTexture
 * file="Interface\Buttons\CheckButtonHilight" alphaMode="ADD"/>` (`spellbookframe.xml:191`) drew over all
 * of them. That is the owner's "every spell renders as if pressed".
 *
 * So the engine cannot be doing `lua_toboolean` on this argument: if it were, those two branches would be
 * identical and a spellbook button could never un-check, which is not what the real client does. The
 * client's own file is the oracle and it says a STRING is parsed.
 *
 * WHAT IS SOURCED and what is not: `"true"` and `"false"` are the only quoted arguments anywhere in the
 * 264 loaded manifest files (grepped -- every other call site passes `1`, `0`, `nil`, `true`, `false` or a
 * variable), so those two are the measured cases. `""`, `"0"` and `"nil"` are folded in with `"false"` as
 * the same class of spelling; that extension is NOT sourced and is written down here as a guess, made in
 * the direction that cannot invent a checked state.
 */
function checkedArg(value: unknown): boolean {
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    return !(lowered === '' || lowered === 'false' || lowered === 'nil' || lowered === '0');
  }
  return Boolean(value);
}

const CHECKBUTTON: MethodTable = {
  SetChecked: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    widget.checked = checkedArg(args[0]);
    const id = checkedTextures.get(self);
    if (id !== undefined) {
      ctx.registry.widget(id)!.shown = widget.checked;
    }
    return [];
  },
  GetChecked: (ctx, self) => [widgetOf(ctx, self).checked],
  /**
   * THE DISABLED-CHECKED ART -- a fourth state texture, declared rather than drawn.
   *
   * From the owner's world-map log:
   *
   *     warning: SetDisabledCheckedTexture is not in this runtime's object model
   *              (first: WorldMapFrame.xml:WorldMapTrackQuest)
   *
   * A CheckButton has four state textures in the engine -- normal, pushed, checked and
   * DISABLED-checked -- and this widget layer models three (`ensureStateTexture` above). The fourth is
   * what a ticked box that is also greyed out draws, which `WorldMapTrackQuest` is whenever the
   * selected quest cannot be tracked. Declared on CHECKBUTTON and not BUTTON, since a plain Button has
   * no checked concept at all -- the same split the header of this file records.
   */
  SetDisabledCheckedTexture: notImplemented('SetDisabledCheckedTexture',
    'this widget layer models three button state textures (normal, pushed, checked) and not the '
    + 'fourth disabled-checked one'),
  GetDisabledCheckedTexture: notImplemented('GetDisabledCheckedTexture',
    'as SetDisabledCheckedTexture -- there is no fourth state region to hand back'),

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
    /**
     * LEFT, whatever the FONT says -- and this was "печатает по центру".
     *
     * `ChatFrameEditBoxTemplate` gives its text region `inherits="ChatFontNormal"`, and neither that
     * font nor `NumberFont_Shadow_Med` above it declares a `justifyH` (`fontstyles.xml:166`,
     * `fonts.xml:187`) -- so the region took the FontString default, CENTER, and the typed text sat
     * in the middle of the field.
     *
     * Two conventions meeting again: a FontString centres by default, and a TEXT FIELD has no
     * justification at all -- the engine draws typed text from the left text inset outward, which is
     * why the client makes room for the "Say:" label with `SetTextInsets(15 + header:GetWidth(), ...)`
     * (`chatframe.lua:3627`) rather than by nudging an alignment. This renderer already assumes it:
     * `tick.ts#placeCaret` puts the caret at an offset measured from the region's left edge, so a
     * centred region had the caret disagreeing with its own glyphs as well.
     *
     * Set at the ADOPTION rather than in the loader: this is the moment a FontString stops being one
     * and becomes a field's text, and it is the one door every route goes through.
     */
    ensureFont(region).align = 'LEFT';
    /**
     * AND IT DOES NOT WRAP. A single-line text field has one line by definition.
     *
     * The owner pasted a long string into chat and it came out on THREE lines, pushing the box open;
     * the original keeps one line. `effectiveFont` hands a wrap budget to any font string whose
     * anchors bound both horizontal edges (`widget.ts:1066-1096`), and this region is anchored
     * TOPLEFT/BOTTOMRIGHT to the box by `anchorTextRegion` -- so it qualified, and a 32-pixel-tall box
     * fits two or three lines of chat font, which is exactly what he photographed.
     *
     * `wordWrap = false` and NOT "clear the budget": the flag is the mechanism `text.ts:207` already
     * reads, and it survives `effectiveFont` recomputing the budget from a resized box. Clearing
     * `wrapWidth` here would be undone the next time that function ran.
     *
     * A `multiLine` box would want the opposite, and `SetMultiLine` is a method this runtime does not
     * have -- the loader already reports it missing for every document that asks. So no box here is
     * multi-line today, and the one that would be (`MacroFrameText`) is unreachable in this client.
     * When that method lands, it flips this flag.
     *
     * WHAT THIS DOES NOT DO: scroll. The real client keeps the caret visible by sliding the text
     * horizontally and clipping at the box edge; with one line and no window, text longer than the box
     * now runs PAST its right edge instead of wrapping inside it. That is closer to the original than
     * wrapping was and it is not the original -- named here rather than left to be discovered.
     */
    ensureFont(region).wordWrap = false;
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
  /**
   * `SetTextColor(r, g, b)` -- and its ABSENCE was a thrown error that took a whole handler with it.
   *
   * The owner's console, every time the chat field gained or lost focus:
   *
   *     ChatFrame1EditBox: OnEditFocusGained: ChatFrame.lua:3628:
   *         attempt to call a nil value (method 'SetTextColor')
   *
   * `ChatEdit_UpdateHeader` colours the header, sets the text insets and then colours the box's own
   * text (`chatframe.lua:3625-3633`); the throw at 3628 meant the three `focusLeft`/`focusRight`/
   * `focusMid` vertex colours below it never ran either, so the focus border stayed uncoloured.
   *
   * An EditBox is not a FontString, so `region.ts`'s method did not reach it -- but the colour lands
   * in the same place: the adopted text region's font spec, which is what actually rasterizes the
   * typed glyphs. Alpha is dropped for the reason `FONTSTRING.SetTextColor` drops it: `FontSpec.color`
   * is a plain `#rrggbb`.
   */
  SetTextColor: (ctx, self, args) => {
    const region = widgetOf(ctx, self).textRegion;
    if (region !== null) {
      ensureFont(region).color = toHex(
        Number(args[0] ?? 1),
        Number(args[1] ?? 1),
        Number(args[2] ?? 1),
      );
    }
    return [];
  },

  /**
   * `AddHistoryLine(text)` -- and its absence is why the field never cleared after a send.
   *
   * The owner: "После отправки поле не очищается." The clear is real, and it is at the END of a chain
   * this call sits in the middle of: `ChatEdit_OnEnterPressed` -> `ChatEdit_SendText` ->
   * `ChatEdit_AddHistory` -> `editBox:AddHistoryLine(text)` (`chatframe.lua:3655`), and only after
   * `SendText` returns does `OnEnterPressed` reach `ChatEdit_OnEscapePressed`, whose body is the
   * `editBox:SetText(""); editBox:Hide()` pair (`:3715-3724`). A missing method THROWS, so the send
   * went out and everything after it did not -- exactly the shape he reported: the message arrives,
   * the field keeps the text and stays open.
   *
   * OLDEST FIRST and capped at `historyLines`, and a repeat of the newest line is not stored twice.
   * Adding resets the walk, so Up after a send offers the line just sent.
   */
  AddHistoryLine: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const line = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    if (line === '') {
      return [];
    }
    if (widget.history[widget.history.length - 1] !== line) {
      widget.history.push(line);
      while (widget.historyLines > 0 && widget.history.length > widget.historyLines) {
        widget.history.shift();
      }
    }
    widget.historyAt = widget.history.length;
    return [];
  },

  /**
   * `historyLines="32"` (`chatframe.xml:21`), the ring's size. The loader has always walked the
   * attribute list; this is the setter it had nowhere to send this one.
   */
  SetHistoryLines: (ctx, self, args) => {
    widgetOf(ctx, self).historyLines = Math.max(0, Number(args[0] ?? 0));
    return [];
  },
  GetHistoryLines: (ctx, self) => [widgetOf(ctx, self).historyLines],

  /**
   * `ignoreArrows="true"` -- the arrows do not move the caret here, which is what frees Up and Down
   * to walk the history (`input.ts`). Previously a missing method, so the flag the document sets on
   * every chat box was dropped and the load report named it.
   */
  SetIgnoreArrows: (ctx, self, args) => {
    widgetOf(ctx, self).ignoreArrows = args[0] !== false && args[0] !== undefined
      && args[0] !== null;
    return [];
  },

  /**
   * `GetInputLanguage()` -> the IME state's name, and `'ROMAN'` is the sourced answer here.
   *
   * Another nil method that threw: `ChatEdit_OnInputLanguageChanged` does
   * `_G["INPUT_"..self:GetInputLanguage()]` (`chatframe.lua:3883`), reached from
   * `ChatEdit_ResetChatType` (`:3356`) and therefore from the edit box's `OnShow`, its `OnHide` and
   * every deactivation. The owner saw all three in one session.
   *
   * THE RETURN IS NOT A GUESS: `globalstrings.lua:4236-4239` declares exactly four `INPUT_*` strings
   * -- `INPUT_CHINESE = "CH"`, `INPUT_JAPANESE = "JP"`, `INPUT_KOREAN = "KO"`, `INPUT_ROMAN = "A"` --
   * so the method's range is those four names and nothing else. `ROMAN` is the one that means "no IME
   * is composing", which is every keystroke a browser delivers here: there is no IME state to read,
   * and a `KeyboardEvent` carries no composition language. Its indicator is the "A" a Western install
   * shows.
   *
   * The button that displays it stays hidden anyway unless `CHAT_SHOW_IME` is set, which only
   * `ChatEdit_LanguageShow` does (`chatframe.lua:3877`) and nothing in this client calls -- so the
   * value is consumed and not drawn. That is why this is a plain answer rather than a gap notice: a
   * `notImplemented` here would redden `UIErrorsFrame` on every open of the chat field.
   */
  GetInputLanguage: () => ['ROMAN'],

  /**
   * `Insert(text)` -- put text in at the caret, replacing any selection.
   *
   * The owner: "я не могу линкануть предмет или способность в чат." `ChatEdit_InsertLink` is one
   * statement -- `activeWindow:Insert(" "..text)` (`chatframe.lua:3493`) -- and this method did not
   * exist, so every shift-click that reached a chat field threw instead of inserting. It is also what
   * the macro box and the auction browser use for the same gesture (`:3506-3520`).
   *
   * REPLACES THE SELECTION, which is what an insert into a text field means everywhere and what the
   * engine does: a box opened by a link click has its text selected, and appending instead of
   * replacing would leave both. The caret lands AFTER the inserted run so a second link appends.
   *
   * `maxLetters` is honoured, because the box declares one (`letters="255"`, `chatframe.xml:21`) and a
   * pasted item link is 60-odd characters -- three links overflow a real limit, and the engine
   * truncates rather than refusing.
   */
  Insert: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const insert = args[0] === undefined || args[0] === null ? '' : String(args[0]);
    if (insert === '') {
      return [];
    }
    const from = Math.min(widget.caret, widget.selectionAnchor);
    const to = Math.max(widget.caret, widget.selectionAnchor);
    const next = widget.text.slice(0, from) + insert + widget.text.slice(to);
    widget.text = widget.maxLetters > 0 ? next.slice(0, widget.maxLetters) : next;
    widget.caret = Math.min(from + insert.length, widget.text.length);
    widget.selectionAnchor = widget.caret;
    widget.onTextChanged?.();
    return [];
  },

  GetNumLetters: (ctx, self) => [widgetOf(ctx, self).text.length],

  /**
   * `SetCursorPosition(pos)` / `GetCursorPosition()` -- the caret's write and read halves.
   *
   * The `Widget.caret` field these move has existed all along (the input router edits through it and
   * `tick.ts#placeCaret` draws it); what was missing was the Lua door onto it. Clamped to the text,
   * which is what the engine does with an out-of-range position.
   *
   * `SetCursorPosition` COLLAPSES the selection, and that is the difference between it and
   * `HighlightText`: moving the caret is what a click or an arrow key does, and neither leaves a range
   * behind. `HighlightText(a, b)` above is the call that makes one.
   *
   * NOTE ON REACH: nothing in the loaded GLUE manifest calls either -- grepped `accountlogin.xml`,
   * `accountlogin.lua` and `characterselect.lua`, whose only edit-box calls are `HighlightText(0, 0)`
   * and `HighlightText()` (accountlogin.xml:216-220, 293-297, 355-359, 1174-1177). They are here
   * because they are the read/write pair of a model that is now real, and because an addon reaching a
   * nil `SetCursorPosition` is the class of one-missing-global failure that has killed three whole
   * FrameXML files on this project. `GetCursorPosition` on an EditBox is a DIFFERENT function from the
   * global mouse `GetCursorPosition` in `api/screen.ts`; a method and a global cannot collide.
   */
  SetCursorPosition: (ctx, self, args) => {
    const widget = widgetOf(ctx, self);
    const position = Math.max(0, Math.min(widget.text.length, Number(args[0] ?? 0)));
    widget.caret = position;
    widget.selectionAnchor = position;
    return [];
  },
  GetCursorPosition: (ctx, self) => [widgetOf(ctx, self).caret],

  /**
   * `GetTextInsets()` -> `left, right, top, bottom`. The read half of `SetTextInsets` above, over the
   * same `Widget.textInsets` field, so the two cannot disagree.
   */
  GetTextInsets: (ctx, self) => {
    const { left, right, top, bottom } = widgetOf(ctx, self).textInsets;
    return [left, right, top, bottom];
  },

  /**
   * `GetUTF8CursorPosition` is a REAL call site and is deliberately not implemented.
   *
   * `chatframe.lua:3869` calls it (`AutoComplete_Update(self, target, self:GetUTF8CursorPosition() -
   * strlenutf8(command) - 1)`), so this is a gap the client can reach rather than a hypothetical one.
   * What is not sourced is whether it counts UTF-8 BYTES or CHARACTERS -- the arithmetic there subtracts
   * a `strlenutf8`, which is a character count, but that does not settle the other operand, and our
   * `caret` is a UTF-16 index that coincides with both only for ASCII. Guessing would be right on every
   * login name and wrong the moment a non-ASCII character is typed, silently and off by the byte
   * difference. Chat cannot run anyway: `ScrollingMessageFrame` is still a missing frame TYPE.
   */
  GetUTF8CursorPosition: notImplemented(
    'GetUTF8CursorPosition',
    'whether the engine counts UTF-8 bytes or characters here is not sourced, and our caret is a UTF-16 index that agrees with both only for ASCII (chatframe.lua:3869 is the one call site)',
  ),
};

registerMethods('BUTTON', BUTTON);
registerMethods('CHECKBUTTON', CHECKBUTTON);
registerMethods('EDITBOX', EDITBOX);
