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

/** An edit box and the caret bar built for it. */
export interface CaretBox {
  box: Widget;
  /** Null for a box with no adopted text region -- there is no font to size a caret from. */
  caret: Widget | null;
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
      boxes.push({ box: widget, caret: buildCaret(registry, widget) });
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
