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
  Anchor, LayoutNode, Rect, boundsBothHorizontalEdges, resolveAnchors, screenScale,
  unplaceableNodes, Viewport,
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
  /**
   * `<Shadow>` -- a dark offset copy of the glyphs drawn BEHIND them, and the reason the client's text
   * survives a bright background. Authored, never chosen here: `SystemFont_Shadow_Small`
   * (`fonts.xml:31-40`) is `<Offset><AbsDimension x="1" y="-1"/></Offset>` with `<Color r="0" g="0"
   * b="0"/>`, and that is `GameFontNormalSmall`'s chain, i.e. the target and player name fonts.
   *
   * `offset` keeps FRAMEXML'S CONVENTION -- logical units, **`+y` UP** -- so the authored `y="-1"` is
   * one unit DOWN the screen. `text.ts` is the one place that flips it, next to the flip it already
   * documents for anchors. Absent means the font declares no shadow, which is the true answer for
   * every `SystemFont_*` without `Shadow` in its name.
   */
  shadowOffset?: { x: number; y: number };
  /** The shadow's colour as `#rrggbb`, with `shadowAlpha` carrying the channel `#rrggbb` cannot. */
  shadowColor?: string;
  shadowAlpha?: number;
  /**
   * `maxLines` -- the hard cap on wrapped lines. Counted over the 127 XML files `framexml.toc` lists:
   * **24 occurrences in 5 files** -- `interfaceoptionspanels.xml` 17, `videooptionspanels.xml` 3,
   * `audiooptionspanels.xml` 2, `chatframe.xml` 1, and `spellbookframe.xml:100`'s `maxLines="3"` on
   * `$parentSpellName`. (Round 17 called that last one the only occurrence, having read six files.)
   * Absent means no cap from the DOCUMENT -- `effectiveFont` may still impose one from a fixed height.
   *
   * An element ATTRIBUTE rather than a font property, carried on the spec because the spec is what the
   * rasterizer sees -- the same reason `wrapWidth` lives here.
   */
  maxLines?: number;
  /**
   * `SetWordWrap(false)` -- draw on one line however narrow the rect. **Nothing in the manifest
   * authors `wordwrap`**: 0 occurrences across all 127 XML files `framexml.toc` lists (round 17 said
   * the same of `nonspacewrap` below, from 6 files, and that half was wrong). So the default is the
   * only behaviour that can be observed, and `true` (wrap) is what makes the client's own bounded
   * paragraphs paragraphs. **The DEFAULT VALUE IS UNSOURCED** -- FrameXML never states it and benilla
   * (1.12.1) has no `word_wrap` at all -- so this is written as an override nothing exercises.
   */
  wordWrap?: boolean;
  /**
   * `SetNonSpaceWrap(true)` -- allow a break INSIDE a run wider than the rect.
   * **AUTHORED, 31 times across 10 of the manifest's 127 XML files**, and read by the loader:
   * `interfaceoptionspanels.xml` 17, `macoptionsframe.xml` 3, `videooptionspanels.xml` 3,
   * `audiooptionspanels.xml` 2, `helpframe.xml` 2, `minimap.xml` 2, and one each in `basiccontrols.xml`,
   * `chatframe.xml`, `mailframe.xml`, `questlogframe.xml`. Every options-panel description paragraph
   * carries it -- the client's own guarantee that those strings cannot run out of their panel.
   * The DEFAULT (false: an overlong run overhangs rather than splitting) is still unsourced.
   */
  nonSpaceWrap?: boolean;
}

let nextWidgetId = 0;
/** Backs `Widget#linkStamp` -- see its doc comment. */
let nextLinkStamp = 0;
/**
 * Bumped by every `add`/`remove` anywhere in any tree: the invalidation stamp for
 * `WidgetRoot#addHiddenTargets`' id index, which is an O(tree) walk nothing else needs per frame.
 *
 * Deliberately GLOBAL and deliberately coarse. A per-root counter would need the child to know which
 * root it is under -- a widget is `add`ed before it is parented into one -- and the only cost of a
 * false invalidation is one extra walk. Anchors are NOT counted: an id-to-widget index cannot go stale
 * when a `SetPoint` changes which id a node points at, and `SetPoint` is the call FrameXML makes
 * constantly (`ActionButton_UpdateHotkeys`, every dropdown) where an `add` is a load-time event.
 */
let treeStructure = 0;

/**
 * Bumped whenever anything that can MOVE OR RESIZE a widget changes: its anchors, its shown flag, its
 * size, or the tree's shape.
 *
 * `ui/rects.ts` keys its on-demand rect map on this. That map exists because the client's own Lua
 * measures a frame in the tick it shows it (`ToggleDropDownMenu`'s `Show()` then `GetCenter()`), and
 * caching it only until the next `publishRects` was a stale-map hazard the moment a SECOND
 * Show-then-measure happened in the same frame -- which the unit-popup submenus now do.
 *
 * Deliberately COARSE: one counter for the whole tree, not per widget. A geometry change anywhere can
 * move anything anchored to it transitively, so a per-widget revision would have to walk the anchor
 * graph to be correct, and that is more expensive than the resolve it would save.
 *
 * NOT bumped by `restamp()`, `SetFrameLevel` or alpha: those change draw ORDER or opacity, never a
 * rect, and bumping on them would throw the map away for nothing on a cooldown sweep.
 */
let geometryRevision = 0;

/** See `geometryRevision`. Read by `ui/rects.ts` to decide whether its cached map is still valid. */
export function layoutRevision(): number {
  return geometryRevision;
}

/** Bumped from the few places that write a widget's geometry. See `geometryRevision`. */
export function touchGeometry(): void {
  geometryRevision += 1;
}

/**
 * A mouse button, as FrameXML names it -- the string an `OnClick` handler's `button` argument receives.
 *
 * The five the engine knows. `input.ts` maps a DOM `PointerEvent#button` onto these; anything past
 * `Button5` has no FrameXML name and is not delivered.
 */
export type MouseButtonName = 'LeftButton' | 'RightButton' | 'MiddleButton' | 'Button4' | 'Button5';

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

  /**
   * Whether `anchors` is the loader's DEFAULT placement rather than something the document declared.
   *
   * **THE ENGINE'S DEFAULT PLACEMENT IS NOT AN ANCHOR SET, and conflating the two is a real defect.**
   * `loader.ts#applyRegionLayout` gives an anchorless `<Layer>` region the parent's rect, which is
   * right -- an anchorless `$parentIcon` does fill its button in the real client. But it did so by
   * writing four ANCHORS, and the client's own Lua then adds a fifth with `SetPoint` and no
   * `ClearAllPoints`:
   *
   *     shownFrame:SetPoint("TOPLEFT", lastFrame, "BOTTOMLEFT", ...)   questinfo.lua:73
   *     shownFrame:SetPoint("TOPLEFT", parentFrame, "TOPLEFT", ...)    :75
   *
   * Four fill anchors plus that one give OPPOSING edges, so `QuestInfoTitleHeader` resolved to the
   * whole 295x324 viewport instead of its text height -- and every element the client chains below its
   * `BOTTOMLEFT` then started below the fold, where the scroll-frame clip correctly dropped it. One
   * cause, both of "the quest text is missing" and "the scroll does nothing".
   *
   * In the real engine a region with no `SetPoint` has a default POSITION, and the first real
   * `SetPoint` replaces it rather than combining with it -- which is why the client never needs
   * `ClearAllPoints` there. This flag is that distinction: the fill stays for anything never
   * positioned from Lua (a parchment, a background, an icon), and vanishes the moment something
   * places the region itself.
   */
  anchorsAreDefault = false;
  width = 0;
  height = 0;

  shown = true;
  alpha = 1;
  mouseEnabled = false;

  /**
   * The `<ScrollFrame>` that CLIPS this widget's subtree, or null.
   *
   * Set by `SetScrollChild` on the scroll CHILD -- never on the scroll frame and never on its other
   * children, which is the whole precision of it: `UIPanelScrollFrameTemplate` makes
   * `$parentScrollBar` a `<Frames>` child of the ScrollFrame too, and the scrollbar sits OUTSIDE the
   * viewport to the right. Clipping every child would delete it.
   *
   * `drawList` carries this down the subtree and intersects each item's rect with the frame's. See
   * `clipRect`.
   */
  clippedBy: Widget | null = null;

  /**
   * How far this `<ScrollFrame>` has scrolled its child, in logical units. Written by
   * `SetVerticalScroll`/`SetHorizontalScroll`; read by `drawList` when it offsets the clipped subtree.
   *
   * On the FRAME, not the child, so one lookup serves the clip and the offset -- they are two halves of
   * one behaviour. The clip decides what is inside the viewport; this decides which part of the child the
   * viewport is over.
   *
   * **INERT FOR A FAUX SCROLL FRAME, and that is a fact about the client's own files rather than a
   * special case here.** A faux frame recomputes a ROW OFFSET and repaints; its rows are not children of
   * its scroll child at all -- `SkillRankFrame1` is outside `skillframe.xml`'s `<ScrollChild>` block, as
   * are reputation's and the spellbook's. So the scroll child a faux frame declares has nothing drawable
   * under it and offsetting it moves nothing. Nothing needs to distinguish the two kinds.
   */
  scrollOffset: { x: number; y: number } = { x: 0, y: 0 };

  /**
   * The `<Slider>` this texture is the THUMB of, or null. Set by `SetThumbTexture`.
   *
   * A thumb's position is the engine's to choose, not the document's: `<ThumbTexture>` carries a `<Size>`
   * and no `<Anchors>` at all (`uipaneltemplates.xml:207-211`), so it has nothing to be placed by. Under
   * the loader's anchorless default it inherited the whole TRACK's rect -- a knob stretched over the full
   * bar rather than a knob. `drawList` overrides its rect from the track and the slider's value.
   */
  thumbOf: Widget | null = null;

  /**
   * Where this `<Slider>`'s thumb sits along its track: `fraction` in 0..1, and the axis it travels on.
   *
   * Written by `SetValue`/`SetMinMaxValues`/`SetOrientation`. Vertical by default, which is what every
   * scrollbar in the client is.
   */
  sliderTravel: { fraction: number; vertical: boolean } = { fraction: 0, vertical: true };
  focusable = false;

  /**
   * Whether this frame called `RegisterForDrag` with at least one button -- i.e. whether it is a drag
   * SOURCE. Set by `lua/methods/frame.ts#RegisterForDrag`, read by `ui/input.ts`.
   *
   * A boolean here rather than the router reading the button SET, and the reason is the router's own
   * limitation rather than a simplification for its own sake: `input.ts#onPointerDown` never inspects
   * `event.button` and `scripts.ts` reports every press as `"LeftButton"` (the same constraint
   * `RegisterForClicks` is a declared gap for), so "which buttons" is a question nothing downstream could
   * answer differently. The full set is still stored, on the frame id, for introspection.
   */
  dragRegistered = false;

  /**
   * `clampedToScreen="true"` -- the frame keeps itself INSIDE the window whatever its anchors say.
   *
   * The client's own declaration, not a policy of ours: `GameTooltipTemplate` carries it
   * (`gametooltiptemplate.xml:3`) and so do the three `ShoppingTooltip`s (`gametooltip.xml:6-8`),
   * `ConsolidatedBuffsTooltip` (`buffframe.xml:141`) and a dozen other frames. `loader.ts:731` has always
   * ISSUED it as `SetClampedToScreen(true)`; nothing implemented the method, so the attribute did nothing
   * and a tooltip near the bottom edge had its body cut off -- the owner's first screenshot.
   *
   * A SHIFT, never a resize: `layout.ts#resolveAnchors` moves the resolved rect back inside the screen and
   * leaves its width and height alone, which is what the engine does (the frame is not re-flowed, it is
   * nudged). A frame LARGER than the screen is left pinned to the top-left corner rather than being made
   * to fit.
   */
  clampedToScreen = false;

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
  onClick: ((button: MouseButtonName) => void) | null = null;

  /**
   * WHICH MOUSE BUTTONS FIRE `onClick`, from `RegisterForClicks`. `null` means the frame never called it.
   *
   * **This existed as a declared gap and the gap was the reason nothing could be equipped.** Every click
   * used to be reported as `"LeftButton"` whatever button was pressed (`scripts.ts:374`, now fixed), so a
   * RIGHT-click on a bag slot ran `ContainerFrameItemButton_OnClick`'s LEFT branch --
   * `PickupContainerItem`, the item-cursor gap -- instead of its right branch, `UseContainerItem`. The
   * equip path was written and correct and simply never reached. `ContainerFrameItemButton_OnLoad`
   * (`containerframe.lua:614`) registers `"LeftButtonUp", "RightButtonUp"`, which is what this stores.
   *
   * `null` means LEFT ONLY, which is the engine's default for a Button and not a convenience: 37 of the
   * manifest's registrations exist precisely to ADD the right button, and a frame that never asked for
   * it does not get it.
   *
   * **THE Up/Down PHASE IS NOT HONOURED, and that is a stated limitation.** The registration strings
   * are `LeftButtonUp` / `RightButtonDown` / `AnyUp` and the engine fires on the phase named; this
   * router fires `onClick` on the RELEASE only, so only the BUTTON half of each entry is kept. A frame
   * that registers only `...Down` therefore still clicks on release rather than not at all -- which is
   * where this differs from the engine, and it is the safe direction: the alternative would silence two
   * of the manifest's registrations entirely.
   */
  clickButtons: Set<MouseButtonName> | null = null;
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
  onDoubleClick: ((button: MouseButtonName) => void) | null = null;

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
  onMouseDown: ((button: MouseButtonName) => void) | null = null;

  onMouseUp: ((button: MouseButtonName) => void) | null = null;
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

  /**
   * FrameXML's `OnDragStart`/`OnDragStop`/`OnReceiveDrag` -- the drag gesture.
   *
   * A drag is not a click with extra state: the engine fires `OnDragStart` on the frame the press began
   * on once the pointer has moved past a threshold, `OnDragStop` on that same frame when the button is
   * released, and `OnReceiveDrag` on whatever frame is UNDER THE CURSOR at the release -- which is a
   * different frame, and is the whole point of the gesture. A click fires on neither if a drag happened.
   *
   * `onDragStart`/`onDragStop` are only fired on a widget that called `RegisterForDrag`
   * (`methods/frame.ts`), which is the engine's rule and matters: every Frame has these handler slots
   * available but only a registered one is a drag SOURCE, so an unregistered frame keeps its click.
   * `onReceiveDrag` needs no registration -- a drop target is any frame with the handler.
   */
  onDragStart: (() => void) | null = null;
  onDragStop: (() => void) | null = null;
  onReceiveDrag: (() => void) | null = null;

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
    treeStructure += 1;
    geometryRevision += 1;
    return child;
  }

  remove(child: Widget): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parent = null;
      treeStructure += 1;
      geometryRevision += 1;
    }
  }

  setAnchors(...anchors: Anchor[]): Widget {
    this.anchors = anchors;
    // Any explicit call is an authored placement, so it stops being the loader's default. `loader.ts`
    // re-sets the flag straight after its own fill.
    this.anchorsAreDefault = false;
    // Every `SetPoint`/`ClearAllPoints`/`SetAllPoints` funnels through here, so this one bump covers
    // all three. See `geometryRevision`.
    geometryRevision += 1;
    return this;
  }

  setSize(width: number, height: number): Widget {
    geometryRevision += 1;
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
    // A newly shown frame has a rect it did not have a moment ago, and `ToggleDropDownMenu` measures
    // one in this same tick. See `geometryRevision`. Inside the transition guard, so an idempotent
    // per-tick `show()` on an already-visible widget costs nothing.
    geometryRevision += 1;
    this.restamp();
  }

  /** Moves this widget to the tail of its draw bucket. See `linkStamp`'s doc comment for the rule. */
  restamp(): void {
    this.linkStamp = nextLinkStamp++;
  }

  hide(): void {
    if (this.shown) {
      geometryRevision += 1;
    }
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
/**
 * How many whole lines of `spec` fit in `height` logical units, 0 if not even one does.
 *
 * The inverse of `text.ts#measureText`'s own block height -- `n * size + (n - 1) * spacing` -- solved
 * for `n`, so "the height admits three lines" here and "these three lines are this tall" there cannot
 * disagree. That is the whole point: this number is used as a LINE CAP, and a cap the renderer
 * disagreed with would put the last line outside the rect, which is the thing being avoided.
 */
export function linesThatFit(spec: FontSpec, height: number): number {
  const spacing = spec.spacing ?? 0;
  if (!(height > 0) || !(spec.size > 0)) {
    return 0;
  }
  return Math.max(0, Math.floor((height + spacing) / (spec.size + spacing)));
}

/**
 * A font string's spec with its WRAP BUDGET filled in from its own authored geometry.
 *
 * THREE CASES, all read off the manifest rather than chosen. `boundedWidth` is the widget's RESOLVED
 * rect width, which only the draw pass knows (`sprite.ts`); omit it and only the authored width is
 * available.
 *
 * 1. **No width budget** -- no authored width and no pair of opposing horizontal anchors. There is
 *    nothing to wrap at, so the string is measured and drawn on one line exactly as before. 3877 of
 *    the 5151 font strings in the loaded world tree.
 * 2. **A width budget and a DERIVED height** (authored 0 or absent) -- the document saying "grow to
 *    fit the text". Wraps at the budget, uncapped, and the rect grows with it (`deriveSize`). 256
 *    strings, every one a paragraph: `SpellButtonNSpellName` 103x0 (`spellbookframe.xml:100-111`),
 *    `QuestProgressText` 275x0, `TutorialFrameText` 300x0.
 * 3. **A width budget and a FIXED height that admits TWO OR MORE LINES** -- wraps, capped to the
 *    number of lines that fit. This case is round 18's, and it is where round 17's rule was wrong.
 *
 * **WHAT ROUND 17 GOT WRONG, and it was a reading of the height, not a counting error.** Its rule was
 * "a width and a fixed height means ONE LINE'S WORTH", justified on 1017 such strings and on
 * `TargetFrameTextureFrameName` being 100x10. But 100x10 is one line's worth *because 10 is one line
 * of a 10-unit font* -- the height was read as a prohibition when it is a BOUND. Counted over the 127
 * XML files `framexml.toc` actually lists (round 17 read ~6 of them, which is why it also recorded
 * `nonspacewrap` and `maxLines` as unauthored; both are wrong -- see `FontSpec.nonSpaceWrap`), 29
 * fixed-height strings with an authored width are 20 units or taller, and they are paragraphs to a
 * one: `ArenaFrameZoneDescription` 293x115, `MovieFrameSubtitleString` 800x138,
 * `StaticPopup1Text` 103x38, `DressUpFrameDescriptionText` 260x36, `GuildFrameNotesText` 315x45,
 * `MerchantItem1Name` 90x30. The CAP is what answers round 17's objection ("a second line would be
 * drawn outside the rect") instead of trading it away: at most `linesThatFit` lines are ever drawn, so
 * a 10-unit rect still shows exactly one line and nothing lands outside any rect.
 *
 * **AND THE OPTIONS PANELS' PARAGRAPHS HAVE NO AUTHORED WIDTH AT ALL** -- the owner's second
 * screenshot, "These options allow you to change the size and detail...", which is
 * `RESOLUTION_SUBTEXT` (`globalstrings.lua:6124`). All 22 of them are `<Size y="32" x="0"/>` with
 * `TOPLEFT` to their panel's title and `RIGHT` at -32 from the panel's edge
 * (`videooptionspanels.xml:37-51`, `interfaceoptionspanels.xml:64-79`, `audiooptionspanels.xml:67`),
 * so the budget is the RESOLVED width and `boundsBothHorizontalEdges` is what finds it. Their own
 * `maxLines="3"` agrees with `linesThatFit(size 10, 32) == 3` exactly, which is the strongest evidence
 * here that a fixed height is meant to be read in lines: the author wrote the same bound twice.
 *
 * The cap is `min(authored maxLines, linesThatFit)` when both exist -- neither may be exceeded.
 *
 * Returns the widget's own spec object UNCHANGED when there is nothing to add, so the common case
 * allocates nothing and the identity comparisons the raster cache relies on are undisturbed.
 */
export function effectiveFont(widget: Widget, boundedWidth?: number): FontSpec | null {
  const spec = widget.font;
  if (spec === null) {
    return null;
  }
  // An explicit budget from Lua wins: `GameTooltip` sets `wrapWidth` on the region's own font
  // (`methods/gametooltip.ts#writeSide`) and its line slots are unsized, so nothing here may overrule it.
  if (spec.wrapWidth !== undefined) {
    return spec;
  }
  const budget =
    widget.width > 0
      ? widget.width
      : boundedWidth !== undefined &&
        boundedWidth > 0 &&
        boundsBothHorizontalEdges(widget.anchors)
        ? boundedWidth
        : 0;
  if (budget <= 0) {
    return spec;
  }
  if (widget.height > 0) {
    const fits = linesThatFit(spec, widget.height);
    if (fits < 2) {
      return spec;
    }
    const cap =
      spec.maxLines !== undefined && spec.maxLines > 0 ? Math.min(spec.maxLines, fits) : fits;
    return { ...spec, wrapWidth: budget, maxLines: cap };
  }
  return { ...spec, wrapWidth: budget };
}

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

  // THE EFFECTIVE font, so the derived HEIGHT is the wrapped block's height. This is what makes the
  // spellbook's rank subtext follow a two-line name down: `$parentSubSpellName` anchors TOPLEFT to
  // `$parentSpellName`'s BOTTOMLEFT (`spellbookframe.xml:116-121`), so the client's own anchor moves it
  // the moment this height grows -- there is nothing to write for that.
  const measured = measure(content, effectiveFont(widget) ?? widget.font, scale);
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
/**
 * Crop `item` to `clip`, or null when it falls entirely outside.
 *
 * **THE ENGINE'S SCROLLFRAME CLIPS, AND OURS DID NOT.** `methods/scroll.ts`' header predicted exactly
 * this consequence -- "nothing in `widget.ts` clips a frame's children, so an offset scroll child would
 * draw outside its viewport rather than being scrolled inside it" -- and the trainer round then measured
 * it: a rank string beginning at **x = 295 inside a 296-wide viewport**, which the real client hides by
 * clipping and we drew in full.
 *
 * **THE ANCHOR IS NOT TOUCHED, and that was a deliberate rejection.** Nudging the child's offset would
 * invent a number the game's own file does not contain, and would still spill for any other overflowing
 * row. Clipping is what the engine does, and it is also what makes a real scroll frame actually SCROLL
 * rather than spill.
 *
 * ## The UVs move with the rect, or the crop would squash instead of cut
 *
 * A sprite's quad samples `u0..u1` across its width. Shrinking the rect alone would draw the WHOLE
 * texture into a narrower box -- a squash, not a clip, and a subtler wrong than the overflow it
 * replaced. So each edge's fractional travel is applied to the matching UV edge. Reversed coordinates
 * survive this untouched: the interpolation is a plain lerp between `u0` and `u1`, which is how
 * `renderer.ts:208-213` already treats a mirrored crop.
 *
 * ## Cost: the item count can only FALL
 *
 * This is the constraint that matters, because `items.length` is the offscreen target's whole basis.
 * Nothing is added here: an item is passed through, narrowed, or DROPPED. A clipped scroll box therefore
 * makes the draw list shorter than it was, never longer, and the fingerprint cheaper rather than dearer.
 */
function clipItem(item: DrawItem, clip: Rect): DrawItem | null {
  const left = Math.max(item.rect.left, clip.left);
  const top = Math.max(item.rect.top, clip.top);
  const right = Math.min(item.rect.left + item.rect.width, clip.left + clip.width);
  const bottom = Math.min(item.rect.top + item.rect.height, clip.top + clip.height);
  if (right <= left || bottom <= top) {
    // Entirely outside the viewport. The trainer's x=295 rank string in a 296-wide box is all but this.
    return null;
  }
  if (left === item.rect.left && top === item.rect.top
    && right === item.rect.left + item.rect.width
    && bottom === item.rect.top + item.rect.height) {
    // Wholly inside: the common case, and it must allocate nothing.
    return item;
  }
  const rect: Rect = { left, top, width: right - left, height: bottom - top };
  const base = item.texCoords ?? item.widget.texCoords ?? null;
  let texCoords = item.texCoords;
  if (base !== null && item.rect.width > 0 && item.rect.height > 0) {
    const fx0 = (left - item.rect.left) / item.rect.width;
    const fx1 = (right - item.rect.left) / item.rect.width;
    const fy0 = (top - item.rect.top) / item.rect.height;
    const fy1 = (bottom - item.rect.top) / item.rect.height;
    texCoords = {
      u0: base.u0 + fx0 * (base.u1 - base.u0),
      u1: base.u0 + fx1 * (base.u1 - base.u0),
      v0: base.v0 + fy0 * (base.v1 - base.v0),
      v1: base.v0 + fy1 * (base.v1 - base.v0),
    };
  }
  return texCoords === undefined
    ? { widget: item.widget, rect, alpha: item.alpha }
    : { widget: item.widget, rect, alpha: item.alpha, texCoords };
}

/**
 * The intersected clip rect for a widget's chain of clipping ancestors, or null when it has none.
 *
 * Walks up rather than taking only the innermost: a scroll frame nested inside another is clipped by
 * both, and the engine applies each independently. The walk is over CLIPPING ancestors only, so it runs
 * once per clipped item and is a no-op for everything else.
 */
function clipRect(
  clip: Widget | null,
  rects: Map<string, Rect>,
  unplaceable: Set<string>,
  offset: { x: number; y: number },
): Rect | null {
  let out: Rect | null = null;
  let node: Widget | null = clip;
  let guard = 0;
  while (node !== null) {
    /**
     * IT FAILS OPEN, NOT CLOSED, and that is the whole point of these two guards.
     *
     * A clip that cannot establish where its viewport IS must not conclude that the content is
     * off-screen. Clipping is the only stage in `drawList` that can DROP an item, so a viewport whose
     * rect we got wrong turns a misplaced panel into a BLANK one -- and blank is much harder to
     * diagnose than misplaced, because there is nothing left on screen to reason about.
     *
     *  - **UNPLACEABLE**: the frame has no resolvable anchor chain, so `resolveAnchors` placed it by
     *    fallback rather than by its document. `unplaceableNodes` already knows; `drawList` computes it
     *    two lines above for its own filter.
     *  - **DEGENERATE**: zero or negative width or height. A frame sized by a script that has not run
     *    yet reads 0, and `drawList` runs every frame from the first one -- so this is reachable during
     *    the load for any frame whose size the client sets in Lua.
     *
     * In both cases the item is passed through unclipped: overflowing content is a visible, reportable
     * defect, and an empty panel is not.
     */
    if (unplaceable.has(node.id)) {
      return null;
    }
    const rect = rects.get(node.id);
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    // ACCUMULATED with the clip, because they are two halves of one behaviour: this frame decides both
    // what part of the child is over its viewport and which of that survives. Summed up the chain so a
    // scroll frame nested in another scrolls by both.
    offset.x += node.scrollOffset.x;
    offset.y += node.scrollOffset.y;
    if (out === null) {
      out = rect;
    } else {
      const left = Math.max(out.left, rect.left);
      const top = Math.max(out.top, rect.top);
      const right = Math.min(out.left + out.width, rect.left + rect.width);
      const bottom = Math.min(out.top + out.height, rect.top + rect.height);
      out = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }
    // Bounded: `clippedBy` is a graph this file does not own, and a cycle in it would hang the draw
    // pass rather than merely mis-clip. Four is past any real nesting.
    guard += 1;
    if (guard > 4) {
      return out;
    }
    node = node.clippedBy ?? (node.parent === null ? null : node.parent.clippedBy);
  }
  return out;
}

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
  private index: Map<string, Widget> | null = null;
  private indexStructure = -1;

  /**
   * Every widget in this tree by id, REBUILT ONLY WHEN THE TREE CHANGED SHAPE.
   *
   * The walk is O(whole tree) -- 4225 frames in the world -- and `addHiddenTargets` needs it on every
   * frame where any anchor target is hidden, which in the world is every frame (`TemporaryEnchantFrame`
   * anchors to the hidden `ConsolidatedBuffs` from load). MEASURED: walking it per frame took
   * `ui.layout` p50 from **0.4 ms to 2.2 ms** at 257 draw items, against a ±1 ms run-to-run spread --
   * a real regression, not noise, and the reason this cache exists rather than the obvious inline walk.
   * `treeStructure` invalidates it, so the cost is paid once per `CreateFrame`, not once per frame.
   */
  private idIndex(): Map<string, Widget> {
    if (this.index !== null && this.indexStructure === treeStructure) {
      return this.index;
    }
    const byId = new Map<string, Widget>();
    const walk = (widget: Widget): void => {
      byId.set(widget.id, widget);
      for (const child of widget.children) {
        walk(child);
      }
    };
    walk(this.root);
    this.index = byId;
    this.indexStructure = treeStructure;
    return byId;
  }

  /**
   * A HIDDEN FRAME STILL HAS A RECT, and everything anchored to one depends on it.
   *
   * `walk` above skips a hidden subtree whole, which is right for the DRAW list and wrong for the
   * LAYOUT graph: the engine resolves geometry for the whole frame tree and `Hide()` only stops the
   * frame being painted. `samples/benilla/crates/benilla-ui/src/layout.rs` resolves rects off the frame
   * graph with no reference to visibility at all -- the only thing that makes a rect unresolvable there
   * is a frame with no anchor points (`layout.rs:1254`) or a dependent of one (`:1282`).
   *
   * MEASURED, and it is the owner's report: `ActionButton6..12` each anchor `LEFT` to the previous
   * button's `RIGHT` (`actionbarframe.xml:96-176`), and `ActionButton_Update` HIDES a slot with no
   * action. On a character with slots 1-4 and 7 filled, `ActionButton7` resolved to **left 0, top 0**
   * -- the window's corner -- through `resolveAnchors`' lenient fallback, while during a drag it read
   * **left 331, top 728** with the rest of the bar, because `ACTIONBAR_SHOWGRID` had shown 5 and 6 and
   * put them back in the node set. "It shows correctly while I drag and goes to the corner otherwise"
   * is exactly that. `TemporaryEnchantFrame` (0,0, anchored to the hidden `ConsolidatedBuffs`,
   * buffframe.xml:118-125) is the same defect and is fixed by the same lines.
   *
   * ONLY THE CLOSURE, not the whole 4225-frame tree. A hidden widget's rect is observable only through
   * something that depends on it, so this adds the transitive anchor-target closure of the nodes
   * already in the set and nothing else. That keeps the cost where it was measured (`ui.layout` p50
   * 0.4 ms at 257 draw items) instead of taking the node set to the whole tree, whose per-frame
   * `deriveSize` would put a canvas `measureText` behind every hidden font string. The full-tree
   * version is the same SEMANTICS with a bill nobody has measured; if a future case needs a rect for a
   * hidden frame nothing visible references, this is the function to widen.
   *
   * A target that is not in the tree at all is left alone: that is the "destroyed, or never built"
   * case `resolveAnchors` reports, and reporting it is the point.
   */
  private addHiddenTargets(nodes: LayoutNode[], scale: number, measure?: MeasureText): void {
    const wanted: string[] = [];
    for (const node of nodes) {
      for (const anchor of node.anchors) {
        if (anchor.relativeTo !== undefined) {
          wanted.push(anchor.relativeTo);
        }
      }
    }
    if (wanted.length === 0) {
      return;
    }

    const present = new Set(nodes.map((node) => node.id));
    const missing = wanted.filter((id) => !present.has(id));
    if (missing.length === 0) {
      return;
    }

    const byId = this.idIndex();

    const queue = missing;
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (present.has(id)) {
        continue;
      }
      const widget = byId.get(id);
      if (widget === undefined) {
        continue;
      }
      present.add(id);
      const size = deriveSize(widget, scale, measure);
      nodes.push({
        id, width: size.width, height: size.height, anchors: widget.anchors,
        clamped: widget.clampedToScreen,
      });
      for (const anchor of widget.anchors) {
        if (anchor.relativeTo !== undefined && !present.has(anchor.relativeTo)) {
          queue.push(anchor.relativeTo);
        }
      }
    }
  }

  /**
   * Every widget's rect, resolved NOW over the whole tree -- shown or not.
   *
   * **WHY THIS EXISTS, and it is the whole of "the stat selects will not open."** The client's own
   * `ToggleDropDownMenu` does `listFrame:Show()` and then, on the very next line,
   * `local x, y = listFrame:GetCenter()` -- and `if ( not x or not y ) then listFrame:Hide(); return; end`
   * (`uidropdownmenu.lua:742-751`). `Region:GetCenter` answers out of the PUBLISHED draw list
   * (`ui/rects.ts`), which is the PREVIOUS frame's, and a frame shown during an `OnClick` is not in it.
   * So the client's own guard hid the menu one line after showing it, every time. MEASURED live: after a
   * real click, `numButtons` 5 and `UIDROPDOWNMENU_OPEN_MENU` set, but `IsShown()` false through 2.6 s.
   *
   * `drawList` cannot answer this: it skips a hidden subtree whole, and `addHiddenTargets` only adds a
   * hidden frame that something else is ANCHORED to -- nothing anchors to `DropDownList1`.
   *
   * Not on the per-frame path. `ui/rects.ts` calls this only when a script asks for an edge of a widget
   * the last draw list did not contain, and caches it until the next publish.
   */
  layoutRects(viewport: Viewport, measure?: MeasureText): Map<string, Rect> {
    const nodes: LayoutNode[] = [];
    const scale = screenScale(viewport.height);
    const walk = (widget: Widget): void => {
      const size = deriveSize(widget, scale, measure);
      nodes.push({
        id: widget.id,
        width: size.width,
        height: size.height,
        anchors: widget.anchors,
        clamped: widget.clampedToScreen,
      });
      for (const child of widget.children) {
        walk(child);
      }
    };
    walk(this.root);
    return resolveAnchors(nodes, viewport);
  }

  drawList(viewport: Viewport, measure?: MeasureText): DrawItem[] {
    const flat: Array<{
      widget: Widget; alpha: number; sequence: number; clip: Widget | null;
    }> = [];
    const nodes: LayoutNode[] = [];
    let sequence = 0;
    const scale = screenScale(viewport.height);

    const walk = (widget: Widget, alpha: number, clip: Widget | null): void => {
      if (!widget.shown) {
        return;
      }

      const cumulative = alpha * widget.alpha;
      // The innermost `<ScrollFrame>` clipping this widget, inherited down the subtree. `clippedBy` is
      // set only on a scroll CHILD (`methods/scroll.ts#SetScrollChild`), so a scrollbar -- also a child
      // of the frame, and deliberately outside its viewport -- is never clipped.
      const clipping = widget.clippedBy ?? clip;
      flat.push({ widget, alpha: cumulative, sequence: sequence++, clip: clipping });
      const size = deriveSize(widget, scale, measure);
      nodes.push({
        id: widget.id,
        width: size.width,
        height: size.height,
        anchors: widget.anchors,
        clamped: widget.clampedToScreen,
      });

      for (const child of widget.children) {
        walk(child, cumulative, clipping);
      }
    };

    walk(this.root, 1, null);
    this.addHiddenTargets(nodes, scale, measure);

    const rects = resolveAnchors(nodes, viewport);
    // The client's own resolver drops a frame with no anchor points, and everything anchored to it;
    // see `layout.ts#unplaceableNodes` for the reference lines and for the frames it took out of the
    // corner of the world screen. Computed over the SAME node list `resolveAnchors` was given (the
    // doomed nodes stay in it), so a dependent is judged by its target's real state rather than by
    // the target having been withheld.
    const unplaceable = unplaceableNodes(nodes);
    // Which clipping frame each widget inherited, carried out of the walk so the crop stage can find it
    // after `resolveAnchors` has given every clip frame a rect. Empty for a tree with no scroll child,
    // which is the ordinary case.
    const itemClip = new Map<Widget, Widget | null>();
    for (const entry of flat) {
      if (entry.clip !== null) {
        itemClip.set(entry.widget, entry.clip);
      }
    }

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
      })
      // THE SCROLLFRAME CROP. Last, so it sees the final rect -- including a StatusBar fill's
      // overridden one. `clipItem` passes through, narrows, or DROPS: the item count can only fall.
      .map((item) => {
        /**
         * A SLIDER'S THUMB IS PLACED BY THE ENGINE, not by its document.
         *
         * `<ThumbTexture>` carries a `<Size>` and no `<Anchors>` at all
         * (`uipaneltemplates.xml:207-211`), so under the loader's anchorless default it inherited the
         * whole TRACK's rect -- a knob stretched over the full bar instead of a knob. The owner's
         * side-by-side shows the real client's scrollbar with a visible thumb and ours with none.
         *
         * Overridden here rather than by writing anchors, for the reason the scroll offset is: the rect
         * map stays untouched, so a slider that moves costs one arithmetic per frame and never a
         * re-layout. The travel is `trackLength - thumbLength`, which is the engine's rule -- a thumb at
         * `fraction` 1 sits flush with the far end rather than half off it.
         */
        const slider = item.widget.thumbOf;
        if (slider !== null) {
          const track = rects.get(slider.id);
          if (track !== undefined) {
            const size = deriveSize(item.widget, scale, measure);
            const travel = slider.sliderTravel;
            if (travel.vertical) {
              const span = Math.max(0, track.height - size.height);
              return {
                ...item,
                rect: {
                  left: track.left + (track.width - size.width) / 2,
                  top: track.top + travel.fraction * span,
                  width: size.width,
                  height: size.height,
                },
              };
            }
            const span = Math.max(0, track.width - size.width);
            return {
              ...item,
              rect: {
                left: track.left + travel.fraction * span,
                top: track.top + (track.height - size.height) / 2,
                width: size.width,
                height: size.height,
              },
            };
          }
        }
        const owner = itemClip.get(item.widget) ?? null;
        if (owner === null) {
          return item;
        }
        const offset = { x: 0, y: 0 };
        const clip = clipRect(owner, rects, unplaceable, offset);
        if (clip === null) {
          return item;
        }
        /**
         * SCROLLED, THEN CLIPPED -- in that order, and the order is the whole behaviour.
         *
         * Offsetting first is what brings the next lines INTO the viewport; clipping second is what
         * keeps the ones that scrolled past the top edge out of it. Done here at DRAW time rather than by
         * moving the child's anchors, so the rect map and `resolveAnchors` are untouched: a scroll costs
         * one subtraction per already-clipped item and never a re-layout.
         *
         * `top - y` because `Rect.top` grows downward while a scroll offset grows as the view descends,
         * so a positive offset lifts the content.
         */
        const shifted = offset.x === 0 && offset.y === 0
          ? item
          : {
            ...item,
            rect: {
              left: item.rect.left - offset.x,
              top: item.rect.top - offset.y,
              width: item.rect.width,
              height: item.rect.height,
            },
          };
        return clipItem(shifted, clip);
      })
      .filter((item): item is DrawItem => item !== null);
  }
}
