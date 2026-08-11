/**
 * The retained glue widget tree.
 *
 * Screens build widgets on mount and MUTATE them; nothing is rebuilt per frame. Art is referenced
 * by sprite KEY and text by string -- resolving either to a GPU resource is the renderer's job, so
 * this file (like `layout.ts` and `hit.ts`) imports no three.js and needs no WebGL to exercise.
 *
 * `drawList` is the single ordered list of what is on screen. Both the renderer and the hit-test
 * consume it, which is what guarantees the thing you click is the thing you see.
 */
// Type-only, and it has to stay that way: `backdrop.ts` imports `TexCoords` from here, so a value
// import in either direction would close a runtime cycle. `isolatedModules` guarantees babel elides
// this one.
import type { BackdropDef, Insets } from './backdrop';
// Type-only for the same reason: `scene/scene-rig.ts` imports three.js-adjacent lighting laws, and
// this file must stay WebGL-free so `layout`/`hit` tests can exercise it without a GL context.
import type { ModelRig } from './scene/scene-rig';
import {
  Anchor, LayoutNode, Rect, resolveAnchors, screenScale, unplaceableNodes, Viewport,
} from './layout';
import { DrawLayer, OrderKey, Strata, compareOrder } from './framexml/order';

/** The five FrameXML draw layers. DIALOG is NOT here -- it is a `Strata`; see `framexml/order.ts`. */
export type Layer = DrawLayer;
export type { Strata };

/** Normal alpha, or the ADD blend the glowing glue art is authored for. */
export type Blend = 'ALPHA' | 'ADD';

/** A sub-rectangle of a sprite sheet, as fractions. `v0` is the TOP edge. */
export type TexCoords = { u0: number; v0: number; u1: number; v1: number };

export type WidgetKind =
  | 'frame'
  | 'texture'
  | 'fontstring'
  | 'button'
  | 'editbox'
  | 'checkbutton'
  | 'backdrop';

export type ButtonState = 'up' | 'down' | 'disabled';

/**
 * A `<StatusBar>`'s value state and the texture that draws its fill.
 *
 * `bar` is a child TEXTURE of the status-bar frame, created lazily by the first `SetStatusBarTexture`
 * or by the loader's `<BarTexture>` -- benilla's `ensure_bar`
 * (`crates/benilla-ui/src/script/statusbar.rs:59-101`). It is a real child widget rather than a field
 * on the frame so that draw layer, vertex colour and the art table all work on it unchanged.
 *
 * The bar carries NO ANCHORS on purpose; see `barFillRect` for what owns its geometry instead.
 */
export interface StatusBarState {
  min: number;
  max: number;
  value: number;
  /** `SetOrientation("VERTICAL")`. Horizontal fills left-to-right, vertical bottom-to-top. */
  vertical: boolean;
  bar: Widget | null;
}

/** `0` when the range is empty, so a bar that never had `SetMinMaxValues` draws nothing rather than NaN. */
export function statusBarFraction(sb: StatusBarState): number {
  const span = sb.max - sb.min;
  if (!(span > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(1, (sb.value - sb.min) / span));
}

/**
 * The bar-fill rect: the OWNING FRAME's resolved rect scaled by the value fraction -- rightward from
 * the left edge (horizontal) or upward from the bottom (vertical).
 *
 * Ported from benilla `crates/benilla-ui/src/extract.rs:264-277` (`bar_fill_rect`). The bar region
 * deliberately skips the ordinary anchor/size precedence chain and takes its geometry from the frame:
 * that is what makes an unanchored `<BarTexture>` correct rather than a 0x0 rect.
 */
export function barFillRect(owner: Rect, sb: StatusBarState): Rect {
  const f = statusBarFraction(sb);
  if (sb.vertical) {
    // `Rect.top` grows DOWNWARD, so "upward from the bottom" is a shrinking height with the bottom
    // edge pinned -- i.e. the top edge slides down as the bar empties.
    const height = owner.height * f;
    return { left: owner.left, top: owner.top + owner.height - height, width: owner.width, height };
  }
  return { left: owner.left, top: owner.top, width: owner.width * f, height: owner.height };
}

/**
 * The bar-fill UV rect. THE CLIENT CROPS THE ART, IT DOES NOT SQUEEZE IT.
 *
 * Ported from benilla `crates/benilla-ui/src/extract.rs:279-295` (`bar_fill_uv`), which records the
 * client evidence: `SetValue` (`0x7cc450` -> `0x7833c0`) drives `0x770410`, which rewrites the
 * four-corner UV block (`+0x104..+0x120`) so that `right = left + frac * width`.
 *
 * This is not a refinement. `Interface\TargetingFrame\UI-StatusBar` is a left-to-right ramp; a naive
 * port that merely shrinks the quad and keeps `0..1` UVs squeezes the whole ramp into the filled part
 * and the bar visibly changes colour as it drains.
 */
export function barFillTexCoords(base: TexCoords | null, sb: StatusBarState): TexCoords {
  const u0 = base?.u0 ?? 0;
  const u1 = base?.u1 ?? 1;
  const v0 = base?.v0 ?? 0;
  const v1 = base?.v1 ?? 1;
  const f = statusBarFraction(sb);
  if (sb.vertical) {
    // `v1` is the BOTTOM edge (see `TexCoords`), so a vertical bar grows from `v1` toward `v0`.
    return { u0, u1, v0: v1 - (v1 - v0) * f, v1 };
  }
  return { u0, u1: u0 + (u1 - u0) * f, v0, v1 };
}

export interface FontSpec {
  /** A font family registered by `text.ts` -- e.g. 'FRIZQT', 'MORPHEUS', 'SKURRI'. */
  family: string;
  /** Logical units. */
  size: number;
  color: string;
  /** Draw the client's 1px outline ring. */
  outline: boolean;
  align: 'LEFT' | 'CENTER' | 'RIGHT';
  /**
   * Wrap at this width, in logical units -- a FontString's authored `Size` x when the client lets it
   * wrap (`GlueDialogText` is 450 wide, gluedialog.xml). OPT-IN: absent means the string is measured
   * and rasterized as one line exactly as it always was, so no existing caption's metrics move.
   */
  wrapWidth?: number;
  /**
   * Extra leading between wrapped lines, in logical units -- a `Font`'s `spacing` attribute
   * (`GlueFontNormalLarge` sets `spacing="2"`, gluefontstyles.xml:97). Only reachable through
   * `wrapWidth`, since a single line has no gap to space.
   */
  spacing?: number;
}

let nextWidgetId = 0;
/** Backs `Widget#linkStamp` -- see its doc comment. */
let nextLinkStamp = 0;

export class Widget {
  readonly id: string;
  readonly kind: WidgetKind;

  parent: Widget | null = null;
  readonly children: Widget[] = [];

  layer: Layer = 'ARTWORK';
  /** Frame strata -- a higher-ranked axis than `layer`. Inherited from the parent on `add`. */
  strata: Strata = 'MEDIUM';
  /** Born at the parent's level + 1; see `framexml/order.ts` for why the tie matters. */
  frameLevel = 0;
  /**
   * The widget's position in its draw bucket's live list -- a global monotonic counter, standing in
   * for the client's per-bucket tail pointer. Assigned once at construction (so a screen built once
   * and never re-shown draws in declaration order, unchanged from before this field went live) and
   * bumped by `restamp()` -- called from `show()` and from the frame and region methods (Task 3's
   * `SetFrameLevel`/`SetFrameStrata`) whenever the value they touch actually CHANGES. A same-value
   * `SetFrameLevel` must NOT call `restamp()`: doing so on a no-op set is what makes a frame jump to
   * the front of its bucket for no reason -- the bug `lua/methods/frame.ts` exists to avoid.
   */
  linkStamp = nextLinkStamp++;
  anchors: Anchor[] = [];
  width = 0;
  height = 0;

  shown = true;
  alpha = 1;
  mouseEnabled = false;
  focusable = false;

  /** Sprite key resolved by `GlueArt`; null draws nothing. */
  sprite: string | null = null;
  texCoords: TexCoords | null = null;
  /**
   * A FrameXML `Backdrop`, for the `backdrop` kind: the renderer draws it as the nine pieces
   * `backdrop.ts` computes rather than as one stretched quad. Sprite KEYS, not paths -- the paths
   * stay in the art table.
   */
  backdrop: BackdropDef | null = null;
  /**
   * Draw a flat `vertexColor` quad with no art at all.
   *
   * OURS, not the client's: this exists for the edit-box caret, which the real client's engine draws
   * with no XML to transcribe. Nothing else should need it -- every other quad on a glue screen is
   * authored art.
   */
  solid = false;
  /**
   * A MODEL frame's own model state, for the `MODEL` Lua class (`ModelFFX`, `PlayerModel`).
   *
   * Lazily created by the first `SetModel`/`SetCamera`/`SetSequence`/`SetFog*`/`SetGlow`/`Add*Light`
   * that frame receives (`framexml/lua/methods/model.ts`), so an ordinary Frame keeps it null. It
   * lives on `Widget` rather than in a side table for the same reason `backdrop` does: it is
   * per-widget state the HOST reads -- `screens/framexml-screen.ts` polls the active model frame's
   * `revision` each tick and pushes the rig at `GlueSceneView`. That poll is what makes the client's
   * own `SetLighting` drive the 3D scene without a notification channel through the object model.
   */
  modelRig: ModelRig | null = null;
  /**
   * A `<StatusBar>`'s value state, for the `STATUSBAR` Lua class.
   *
   * Lazily created by the first `SetMinMaxValues`/`SetValue`/`SetStatusBarTexture` the frame receives
   * (`framexml/lua/methods/statusbar.ts`), so an ordinary Frame keeps it null -- the same rule
   * `modelRig` above follows, and for the same reason: a per-widget slot the DRAW pass reads
   * (`drawList` below) rather than a side table the renderer could not see.
   */
  statusBar: StatusBarState | null = null;
  /**
   * A `<Cooldown>`'s running sweep, or null. Written only by `SetCooldown`.
   *
   * This lived in a `WeakMap` in `methods/cooldown.ts` with the stated rule "if a later round draws the
   * sweep, this moves onto `Widget` -- that is the signal that it should". This round draws it, so it has
   * moved: the sweep is rendered from the draw list (`world-ui.ts#drawSweeps`), and a `WeakMap` in a
   * methods module is not reachable from the draw pass.
   *
   * `start` is a `GetTime()`-based timestamp in seconds and `duration` is seconds -- the contract
   * `GetActionCooldown` returns and `CooldownFrame_SetTimer` passes straight through
   * (`actionbutton.lua:345-349`).
   */
  cooldown: { start: number; duration: number } | null = null;
  blend: Blend = 'ALPHA';
  /** Multiplied into the sprite, as `#rrggbb`. */
  vertexColor = '#ffffff';

  text = '';
  font: FontSpec | null = null;

  /** Button/checkbutton state. `hovered` is written by the input router. */
  state: ButtonState = 'up';
  hovered = false;
  checked = false;

  /** EditBox state. `text` always holds the real string -- password masking is a DRAW-time-only
   * transform (`screens.ts#resolveSprite`), never applied to the stored value, since that value is
   * what a login screen submits. */
  maxLetters = 0;
  password = false;
  /**
   * EditBox `TextInsets`: the rect the engine draws typed text in is this box shrunk by them. Held
   * here (rather than only as anchors on the text region) because it is authored state a later
   * `SetTextInsets` has to be able to re-apply, and because the caret needs the same rect.
   */
  textInsets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  /**
   * `SetHitRectInsets` -- the rect this frame is CLICKABLE in, as an inset from the rect it draws in.
   * Positive shrinks, negative grows. Zero on every side (the default) means the two rects are the
   * same, which is what every widget built before this field existed assumed.
   *
   * Read by `hit.ts#hitTest`, never by the renderer: the whole point is that the clickable rect and
   * the drawn rect differ.
   */
  hitRectInsets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  /**
   * The FontString an EditBox draws its typed text in -- the client's engine-owned "special" font
   * string, which FrameXML declares as an unnamed, unanchored direct `<FontString>` child of the box
   * (accountlogin.xml:234) purely to say which font that text is in. The loader ADOPTS that declared
   * child into this slot (`EDITBOX.SetTextRegion`), and whoever is running the tree mirrors the box's
   * `displayText` into it -- which is exactly what the hand-written login screen does by hand.
   *
   * Nothing in this renderer rasterizes glyphs for an `editbox` widget itself
   * (`screens.ts#resolveSprite` only does for `kind === 'fontstring'`), so this slot is how an edit
   * box gets visible text at all.
   */
  textRegion: Widget | null = null;
  caret = 0;
  /** Selection anchor. Equal to `caret` when there is no selection (the common case). */
  selectionAnchor = 0;

  /**
   * Invoked by a pointer click, and by Enter on a widget that has no `onSubmit` of its own.
   *
   * For a button the two are the same act, so the fallback is correct there. For an EDIT BOX they are
   * not: clicking into a box takes focus (which is what the client does), and it was this field
   * carrying both meanings that made clicking back into the account box to fix a typo submit the typo.
   * A widget where Enter means something a click does not uses `onSubmit`.
   */
  onClick: (() => void) | null = null;
  /**
   * Invoked by Enter, in preference to `onClick`. FrameXML's `OnEnterPressed` -- the login screen's
   * edit boxes submit the form on Enter, and a pointer click on them must not.
   */
  onSubmit: (() => void) | null = null;
  /** Invoked by Escape; if absent, Escape does nothing (no fallback to onClick). */
  onCancel: (() => void) | null = null;
  /**
   * FrameXML's `OnDoubleClick`, fired IN ADDITION to the second `onClick` -- which is what the
   * engine does, and what `RealmListRealmButtonTemplate` relies on: its `OnClick` selects a realm
   * and its `OnDoubleClick` joins the one just selected (realmlist.xml:234-239).
   */
  onDoubleClick: (() => void) | null = null;

  /**
   * The rest of the FrameXML script surface the input router can actually observe.
   *
   * Every one of these is a hook the router already had the EVENT for and nowhere to send it: it
   * flipped `hovered`, wrote `state`, mutated `text` and moved `focus` and stopped there, which is
   * fine for a hand-written screen (it re-reads those fields every tick) and is the whole reason an
   * XML-loaded frame was inert -- a `<Scripts>` block has no field to be read out of, only a handler
   * to be called. `framexml/lua/scripts.ts` binds these to the frame's Lua handlers; a hand-written
   * screen leaves them null and behaves exactly as before.
   *
   * `onEnter`/`onLeave` are FrameXML's `OnEnter`/`OnLeave` -- the hover TRANSITION, not the flag.
   * `onMouseDown`/`onMouseUp` are the raw press and release, which are NOT `onClick`: the engine
   * fires them on press and on release regardless of where the release lands, while a click needs
   * both on the same widget.
   */
  onEnter: (() => void) | null = null;
  onLeave: (() => void) | null = null;
  onMouseDown: (() => void) | null = null;
  onMouseUp: (() => void) | null = null;
  /**
   * FrameXML's `OnTabPressed`, and it REPLACES the router's own Tab ring for the widget that has one:
   * `accountlogin.xml`'s account box moves focus to the password box itself, and a document that
   * decides where Tab goes must win over a generic draw-order walk. A widget with none keeps the ring.
   */
  onTabPressed: (() => void) | null = null;
  /**
   * FrameXML's `OnTextChanged`, fired after ANY change to an edit box's text -- typing, backspace,
   * delete, paste, and a Lua `SetText` (the engine fires it for that too, which is what hides the
   * login screen's placeholder after `AccountLogin_OnShow` pre-fills the account name).
   */
  onTextChanged: (() => void) | null = null;
  /** FrameXML's `OnEditFocusGained`/`OnEditFocusLost`, fired by the router's own focus transition. */
  onEditFocusGained: (() => void) | null = null;
  onEditFocusLost: (() => void) | null = null;

  constructor(kind: WidgetKind, id?: string) {
    this.kind = kind;
    this.id = id ?? `${kind}-${nextWidgetId++}`;
  }

  add(child: Widget): Widget {
    child.parent = this;
    child.strata = this.strata;
    // Only a child FRAME is born at parent + 1. A REGION (`texture`, `fontstring`) sits at its
    // owner's level unchanged -- because `frameLevel` outranks `layer` in `compareOrder`, giving a
    // region `+1` would tie it with a child frame at that level and let `layer` decide instead,
    // which is backwards: the client's `SetFrameLevel(GetFrameLevel() - 1)` idiom relies on a child
    // frame's level being strictly above its parent's regions so the layer rank never has to referee
    // parent-region-vs-child-frame at all.
    const isRegion = child.kind === 'texture' || child.kind === 'fontstring';
    child.frameLevel = isRegion ? this.frameLevel : this.frameLevel + 1;
    this.children.push(child);
    return child;
  }

  remove(child: Widget): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
    }
  }

  setAnchors(...anchors: Anchor[]): Widget {
    this.anchors = anchors;
    return this;
  }

  setSize(width: number, height: number): Widget {
    this.width = width;
    this.height = height;
    return this;
  }

  show(): void {
    // The transition, not the call: `login.ts`'s caret and account-fill, and `realms.ts`'s row
    // highlight, call `show()` idempotently on every tick on an already-visible widget (the same
    // reason `SetFrameLevel`/`SetFrameStrata` guard on an unchanged value). Without this guard those
    // per-frame calls would re-stamp to the tail every tick and reorder draw output that never
    // actually became visible again.
    if (this.shown) {
      return;
    }
    this.shown = true;
    this.restamp();
  }

  /** Moves this widget to the tail of its draw bucket. See `linkStamp`'s doc comment for the rule. */
  restamp(): void {
    this.linkStamp = nextLinkStamp++;
  }

  hide(): void {
    this.shown = false;
  }

  /** Shown only if every ancestor is too. */
  get visible(): boolean {
    let node: Widget | null = this;
    while (node) {
      if (!node.shown) {
        return false;
      }
      node = node.parent;
    }
    return true;
  }

  /**
   * What an edit box SHOWS, as opposed to what it holds. `text` is always the real string -- a
   * login screen submits it -- so masking lives here, at the one place every consumer (a mirrored
   * FontString today; the renderer directly, if a future screen draws an editbox's text itself)
   * should read from instead of `text` when putting glyphs on screen.
   */
  get displayText(): string {
    if (this.kind === 'editbox' && this.password) {
      return '•'.repeat(this.text.length);
    }
    return this.text;
  }
}

/**
 * How a font string's rasterized size is obtained -- `text.ts#measureText`'s exact signature.
 *
 * INJECTED rather than imported. `text.ts` imports three.js (it hands the renderer a
 * `CanvasTexture`) and imports `FontSpec` from this file, so importing it here would both close a
 * runtime cycle and put WebGL in the one module the layout, hit-test and screen tests exercise
 * without a GPU. The measuring itself is pure arithmetic over a 2D canvas, so passing the function
 * in keeps this file as dependency-free as `layout.ts` while still using ONE measurement -- the same
 * one `screens.ts#resolveSprite` rasterizes at.
 */
export type MeasureText = (
  text: string,
  font: FontSpec,
  scale: number,
) => { width: number; height: number };

/**
 * A widget's size with a FONT STRING's zeroes filled in from its text.
 *
 * The client's `<Size>` rule, recorded by the loader: an ABSENT dimension is left untouched, and 0
 * means "derive". For a frame it derives from two opposing anchors, which `layout.ts` already does
 * (`resolveOne` sizes an axis constrained on both edges and ignores the declared value there) -- so
 * this touches only `fontstring`, and only the axis that is 0. What a frame's 0 means is unchanged.
 *
 * Why it has to happen at all: an unsized `<FontString>` resolved to a 0x0 rect, so its LEFT edge was
 * its centre and anything anchored to it landed half a label off -- `AccountLoginSaveAccountName`'s
 * 20x20 check button anchors `RIGHT` to `AccountLoginSaveAccountNameText`'s `LEFT` and nothing else
 * gives that label a width (accountlogin.xml:530-562).
 *
 * `displayText`, not `text`, and the SAME `measure` the renderer rasterizes through
 * (`screens.ts#resolveSprite` -> `text.ts`): two notions of a label's size is the bug, not the fix.
 * Empty text keeps 0 on both axes -- `FontStringTextures#get` returns null for it and the renderer
 * draws nothing, so a rect the size of bare padding would be a hit target over nothing.
 */
export function deriveSize(
  widget: Widget,
  scale: number,
  measure?: MeasureText,
): { width: number; height: number } {
  if (
    widget.kind !== 'fontstring' ||
    !measure ||
    !widget.font ||
    (widget.width !== 0 && widget.height !== 0)
  ) {
    return { width: widget.width, height: widget.height };
  }

  const content = widget.displayText;
  if (!content) {
    return { width: widget.width, height: widget.height };
  }

  const measured = measure(content, widget.font, scale);
  return {
    width: widget.width === 0 ? measured.width : widget.width,
    height: widget.height === 0 ? measured.height : widget.height,
  };
}

export interface DrawItem {
  widget: Widget;
  rect: Rect;
  /** The widget's alpha multiplied down the ancestor chain. */
  alpha: number;
  /**
   * A texture sub-rect that OVERRIDES `widget.texCoords` for this frame only.
   *
   * Set for exactly one thing today: a StatusBar's bar-fill region, whose UVs are a function of the
   * bar's live value and so cannot be stored on the widget without writing to it every frame. See
   * `barFillTexCoords`.
   */
  texCoords?: TexCoords;
}

/**
 * `linkStamp` is now genuinely live (see `Widget#linkStamp`/`restamp`): `strata`/`frameLevel` group a
 * bucket, and `linkStamp` orders within it exactly as the client's own tail-append does. `sequence`
 * (this walk's DFS index) rides along as `declarationSeq` -- a defensive tie-break only, since
 * `linkStamp` is a global monotonic counter and two widgets sharing one is not expected to happen.
 */
const orderKey = (entry: { widget: Widget; sequence: number }): OrderKey => ({
  strata: entry.widget.strata,
  frameLevel: entry.widget.frameLevel,
  layer: entry.widget.layer,
  isFontString: entry.widget.kind === 'fontstring',
  linkStamp: entry.widget.linkStamp,
  declarationSeq: entry.sequence,
});

export class WidgetRoot {
  readonly root = new Widget('frame', 'root');

  constructor() {
    // The root IS the screen: two opposing anchors against the window, which is what makes it the
    // one node in the tree that is placeable without a target. (It used to be described as the
    // reason "a child with no anchors still resolves" -- it is not. An unanchored child resolves to
    // the window's own top-left corner whatever the root's rect is, and `unplaceableNodes` now drops
    // it instead, per the client's resolver.)
    this.root.setAnchors(
      { point: 'TOPLEFT', x: 0, y: 0 },
      { point: 'BOTTOMRIGHT', x: 0, y: 0 },
    );
  }

  /**
   * Flatten to a back-to-front draw list with resolved rects.
   *
   * Order is the client's real key -- strata, then frame level, then draw layer, then textures
   * before font strings, then insertion order -- NOT a simple "walk the tree" order. See
   * `framexml/order.ts` for why the layer outranks the frame and why font strings sort last.
   * Hidden subtrees are skipped whole.
   *
   * `measure` supplies a FONT STRING's size where its own is 0 -- see `deriveSize`. Optional only so
   * that a caller with no text at all (`layout.ts`'s and `hit.ts`'s tests) needs nothing; the app
   * always passes it (`screens.ts`), which is what makes layout and paint agree.
   */
  drawList(viewport: Viewport, measure?: MeasureText): DrawItem[] {
    const flat: Array<{ widget: Widget; alpha: number; sequence: number }> = [];
    const nodes: LayoutNode[] = [];
    let sequence = 0;
    const scale = screenScale(viewport.height);

    const walk = (widget: Widget, alpha: number): void => {
      if (!widget.shown) {
        return;
      }

      const cumulative = alpha * widget.alpha;
      flat.push({ widget, alpha: cumulative, sequence: sequence++ });
      const size = deriveSize(widget, scale, measure);
      nodes.push({
        id: widget.id,
        width: size.width,
        height: size.height,
        anchors: widget.anchors,
      });

      for (const child of widget.children) {
        walk(child, cumulative);
      }
    };

    walk(this.root, 1);

    const rects = resolveAnchors(nodes, viewport);
    // The client's own resolver drops a frame with no anchor points, and everything anchored to it;
    // see `layout.ts#unplaceableNodes` for the reference lines and for the frames it took out of the
    // corner of the world screen. Computed over the SAME node list `resolveAnchors` was given (the
    // doomed nodes stay in it), so a dependent is judged by its target's real state rather than by
    // the target having been withheld.
    const unplaceable = unplaceableNodes(nodes);

    return flat
      .filter((entry) => {
        if (!unplaceable.has(entry.widget.id)) {
          return true;
        }
        // ONE exemption, and it is the same one the rect map is overruled for below: a StatusBar's
        // fill region is authored with no anchors on purpose and takes its geometry from the owning
        // frame (`barFillRect`). Dropping it would delete every health, mana and experience bar in
        // the client. The owner still has to be placeable -- `barFillRect` reads its rect.
        const owner = entry.widget.parent;
        return owner?.statusBar?.bar === entry.widget && !unplaceable.has(owner.id);
      })
      .sort((a, b) => compareOrder(orderKey(a), orderKey(b)))
      .map((entry) => {
        // THE STATUS-BAR FILL, and the one place the anchor solver is deliberately overruled.
        //
        // A `<BarTexture>` is authored with no anchors and no size -- the engine gives it the frame's
        // rect cropped to the value. Resolving it through `resolveAnchors` like any other region
        // would give it a 0x0 rect at its parent's centre, so the bar would simply not exist. Benilla
        // does exactly this override, and states the reason: "the bar region carries no anchors and
        // deliberately skips the whole region-rect precedence chain -- it owns its geometry off the
        // frame's resolved rect" (`crates/benilla-ui/src/extract.rs:69-81`).
        const owner = entry.widget.parent;
        const sb = owner?.statusBar ?? null;
        if (sb !== null && sb.bar === entry.widget) {
          return {
            widget: entry.widget,
            rect: barFillRect(rects.get(owner!.id)!, sb),
            alpha: entry.alpha,
            texCoords: barFillTexCoords(entry.widget.texCoords, sb),
          };
        }
        return {
          widget: entry.widget,
          rect: rects.get(entry.widget.id)!,
          alpha: entry.alpha,
        };
      });
  }
}
