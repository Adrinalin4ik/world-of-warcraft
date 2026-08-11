/**
 * The per-frame work a loaded document cannot do for itself: the edit-box text mirror, the caret, and
 * the button state-art poll.
 *
 * All three were private to `runtime.ts` and are shared now, because the WORLD runtime
 * (`world-runtime.ts`) needs exactly the same three for exactly the same reasons -- an `editbox`
 * widget draws no glyphs, the engine's caret has no XML behind it, and a BUTTON's state art follows
 * three fields the input router writes directly and no method sees. Nothing here is glue-specific;
 * `runtime.ts` keeps only the named-frame `OnUpdate` exceptions, which genuinely are.
 */
import { Widget } from '../widget';
import { caretOffset } from '../text';
import { FocusSink, FrameRegistry } from './lua/object';

/**
 * The caret, OURS.
 *
 * The client's edit-box caret is drawn by its engine with no XML behind it, so there is nothing in the
 * document to materialize and nothing here is cited: a one-unit bar, lit for half a second and dark for
 * half a second. `screens/login.ts` draws the same thing by hand for the transcription, with the same
 * two constants -- and this lives in the runtime rather than per screen precisely because every
 * `<EditBox>` on every screen needs it and none of them declares it.
 */
const CARET_WIDTH = 1;
export const CARET_BLINK_SECONDS = 0.5;

/**
 * The SELECTION HIGHLIGHT's colour, and it is OURS -- unsourced, exactly like the caret above.
 *
 * The client's engine draws an edit box's selection itself; there is no XML, no texture path and no
 * FrameXML colour constant behind it (grepped the loaded glue manifest: the only `HighlightText` call
 * sites are `accountlogin.xml:216-220,293-297,355-359` and they pass ranges, never a colour). So this
 * is a plain blue chosen to read as a selection against the client's dark edit boxes, and it is not
 * claimed to match the shipped client's pixel value.
 *
 * IT IS NOT COSMETIC, which is why it is worth having at all. Every login box declares
 * `<OnEditFocusGained> self:HighlightText(); </OnEditFocusGained>` (accountlogin.xml:218-220), so a
 * click into a box that already holds text SELECTS ALL of it, and the next printable key replaces the
 * lot. That is the real client's behaviour too -- but the real client DRAWS the selection, so the
 * replacement is something the player asked for. Drawn nowhere, the same keystroke looks exactly like
 * "the field reset itself", which is the defect as it was reported.
 */
const SELECTION_COLOR = '#2b5fa8';
const SELECTION_ALPHA = 0.75;

/** An edit box and the two engine-drawn regions built for it. */
export interface CaretBox {
  box: Widget;
  /** Null for a box with no adopted text region -- there is no font to size a caret from. */
  caret: Widget | null;
  /** The selection highlight, null for the same reason as `caret`. */
  selection: Widget | null;
}

/**
 * Every `editbox` widget in the tree, each with a caret region built under it. Collected once; the tree
 * is not rebuilt.
 *
 * The caret is created THROUGH THE REGISTRY (`create('Texture', ...)`), not as a loose `Widget`, so it
 * is torn down by the same `reset()` as everything else and cannot outlive the screen. It is anchored to
 * the box's TEXT REGION rather than to the box, which is what makes the authored `<TextInsets>` apply
 * for free -- `kinds.ts#anchorTextRegion` has already inset that region, so the caret starts where the
 * first character does without repeating the arithmetic.
 */
export function collectEditBoxes(registry: FrameRegistry, root: Widget): CaretBox[] {
  const boxes: CaretBox[] = [];
  const walk = (widget: Widget): void => {
    if (widget.kind === 'editbox') {
      // Build order between these two does NOT matter: the caret is `OVERLAY` and the highlight is
      // `BACKGROUND`, so the LAYERS decide which draws over which and creation order never enters into
      // it. (An earlier version of this comment claimed the opposite and was wrong.)
      const selection = buildSelection(registry, widget);
      boxes.push({ box: widget, caret: buildCaret(registry, widget), selection });
    }
    // A copy: `buildCaret` adds a child to the box, and walking the live array would then descend into
    // the caret it just made.
    [...widget.children].forEach(walk);
  };
  walk(root);
  return boxes;
}

function buildCaret(registry: FrameRegistry, box: Widget): Widget | null {
  const region = box.textRegion;
  const boxId = registry.idOfWidget(box);
  if (region === null || boxId === null) {
    return null;
  }
  const caret = registry.widget(registry.create('Texture', null, boxId));
  if (caret === null) {
    return null;
  }
  caret.layer = 'OVERLAY';
  caret.solid = true;
  caret.vertexColor = region.font?.color ?? '#ffffff';
  caret.setSize(CARET_WIDTH, region.font?.size ?? 12).setAnchors({
    point: 'LEFT',
    relativeTo: region.id,
    relativePoint: 'LEFT',
    x: 0,
    y: 0,
  });
  caret.shown = false;
  return caret;
}

/**
 * The selection highlight quad, built the same way and for the same reason as the caret: the client's
 * engine draws it with nothing in the document behind it.
 *
 * `BACKGROUND` rather than the caret's `OVERLAY` -- it has to sit BEHIND the glyphs. The adopted text
 * region declares no layer (`accountlogin.xml:157-238`'s `<FontString inherits="GlueEditBoxFont"/>`),
 * so it defaults to `ARTWORK`, and a highlight in `OVERLAY` would paint over the very text it is
 * selecting. Anchored to the TEXT REGION, like the caret, so the authored `<TextInsets>` apply without
 * restating the arithmetic.
 */
function buildSelection(registry: FrameRegistry, box: Widget): Widget | null {
  const region = box.textRegion;
  const boxId = registry.idOfWidget(box);
  if (region === null || boxId === null) {
    return null;
  }
  const selection = registry.widget(registry.create('Texture', null, boxId));
  if (selection === null) {
    return null;
  }
  selection.layer = 'BACKGROUND';
  selection.solid = true;
  selection.vertexColor = SELECTION_COLOR;
  selection.alpha = SELECTION_ALPHA;
  selection.setSize(0, region.font?.size ?? 12).setAnchors({
    point: 'LEFT',
    relativeTo: region.id,
    relativePoint: 'LEFT',
    x: 0,
    y: 0,
  });
  selection.shown = false;
  return selection;
}

/**
 * Span the selected character range, for the focused box only.
 *
 * Measured with `caretOffset` against `displayText`, at scale 1 -- the SAME call, the same string and
 * the same scale the caret uses, which is what guarantees the two agree. Against the real text a
 * password box's highlight would be the width of the real characters and would leak their identity.
 *
 * An EMPTY selection (anchor == caret) hides the quad rather than drawing a zero-width one: a collapsed
 * selection is what a plain arrow key leaves behind and it must show nothing but the caret.
 *
 * COST, because the draw fingerprint is easy to spoil here (see the report's frame-budget section): the
 * guard below returns BEFORE either `caretOffset` call for every box that is not the focused one holding
 * a live range, so the canvas text measurement runs for at most one box per frame and usually none. And
 * it adds no dirty frames: a selection's rect is static while it stands, and the CARET beside it already
 * dirties the fingerprint twice a second by blinking. The highlight itself deliberately does not blink.
 */
export function placeSelection(box: Widget, selection: Widget | null, input: FocusSink | null): void {
  if (selection === null) {
    return;
  }
  const spec = box.textRegion?.font ?? null;
  if (spec === null || input === null || input.focused !== box || box.selectionAnchor === box.caret) {
    selection.shown = false;
    return;
  }
  const start = Math.min(box.selectionAnchor, box.caret);
  const end = Math.max(box.selectionAnchor, box.caret);
  const left = caretOffset(box.displayText, spec, 1, start);
  const right = caretOffset(box.displayText, spec, 1, end);
  selection.anchors[0].x = left;
  selection.setSize(Math.max(0, right - left), spec.size ?? 12);
  selection.shown = true;
}

/**
 * Put the caret where the next character will land, and blink it, for the focused box only.
 *
 * Measured against `displayText`, so a password box positions against the MASKED string: measuring the
 * real one would put the caret at the real characters' widths and leak them on screen -- the same rule
 * `screens/login.ts#placeCaret` states. Measured at scale 1 because `caretOffset` returns logical units,
 * which the layout scale divides back out anyway.
 *
 * `shown` is assigned rather than `show()`/`hide()` called: a blink is twice a second, and `show()`
 * re-stamps the draw order.
 */
export function placeCaret(
  box: Widget,
  caret: Widget | null,
  input: FocusSink | null,
  lit: boolean,
): void {
  if (caret === null) {
    return;
  }
  if (!lit || input === null || input.focused !== box) {
    caret.shown = false;
    return;
  }
  const spec = box.textRegion?.font ?? null;
  if (spec === null) {
    caret.shown = false;
    return;
  }
  caret.anchors[0].x = caretOffset(box.displayText, spec, 1, box.caret);
  caret.shown = true;
}

/**
 * Every BUTTON/CHECKBUTTON frame id in the tree, for the per-frame art poll.
 *
 * WALKED PER TICK, not collected once at boot -- and it used to be the latter, on the grounds that a
 * frame created from Lua after the load got none of its template's regions and so had no state textures
 * to repaint. `CreateFrame`'s template argument is real now (`loader.ts#applyTemplate`), so that ground
 * is gone: `GlueDropDownMenu_AddButton` and `RealmList_UpdateTabs` build real templated BUTTONs with
 * real `<NormalTexture>`/`<HighlightTexture>` regions, long after the load, and a boot-time snapshot
 * would leave every one of them a painted picture that never lights or presses.
 *
 * The cost is one array walk of the widget tree per frame, beside the one `drawList` already does.
 *
 * `visitHidden = false` prunes a hidden subtree, and that is the world runtime's whole reason for the
 * parameter: on the glue screens the tree is ~450 widgets and pruning would save nothing, while
 * `FrameXML.toc` builds 4211 frames of which the great majority are hidden panels (the spellbook, the
 * talent frame, every `UIPanel`). A hidden frame's state art cannot be seen, so recomputing it is work
 * with no observable result -- and `drawList` already skips the same subtrees.
 */
export function collectButtons(
  registry: FrameRegistry,
  root: Widget,
  visitHidden = true,
): number[] {
  const ids: number[] = [];
  const walk = (widget: Widget): void => {
    if (!visitHidden && !widget.shown) {
      return;
    }
    if (widget.kind === 'button' || widget.kind === 'checkbutton') {
      const id = registry.idOfWidget(widget);
      if (id !== null) {
        ids.push(id);
      }
    }
    widget.children.forEach(walk);
  };
  walk(root);
  return ids;
}
