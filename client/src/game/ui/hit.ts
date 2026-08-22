/**
 * Hit-testing and focus over a widget draw list.
 *
 * Reads the SAME ordered list the renderer draws, walked backwards -- the top-most drawn
 * mouse-enabled widget wins. Pure: no DOM, no three.js. `input.ts` owns the events; this file only
 * answers "what is under this point" and "what gets focus next".
 */
import { DrawItem, Widget } from './widget';

/**
 * The rect this item is CLICKABLE in: the drawn rect shrunk by `SetHitRectInsets`.
 *
 * Positive insets shrink, negative grow -- and `top`/`bottom` are in the same screen-down sense as
 * `Rect`, so `top` moves the upper edge DOWN. Zero on every side (the default, and every widget built
 * before the field existed) leaves the rect exactly as drawn.
 *
 * `TargetFrame_OnLoad`'s `SetHitRectInsets(20, 35, 10, 25)` is the reason this is not cosmetic: the
 * target frame's art is a portrait plate much wider than the unit frame proper, and without the inset
 * the clickable area covers a strip of screen the player expects to click THROUGH.
 */
function contains(item: DrawItem, x: number, y: number): boolean {
  const { left, top, width, height } = item.rect;
  const insets = item.widget.hitRectInsets;
  return (
    x >= left + insets.left &&
    x < left + width - insets.right &&
    y >= top + insets.top &&
    y < top + height - insets.bottom
  );
}

/**
 * The top-most mouse-enabled widget at a point, in logical units, or null.
 *
 * Art that is not `mouseEnabled` is transparent to the mouse even when it draws on top -- which is
 * how a highlight or border over a button keeps the button clickable.
 */
export function hitTest(items: DrawItem[], x: number, y: number): Widget | null {
  for (let index = items.length - 1; index >= 0; --index) {
    const item = items[index];
    if (item.widget.mouseEnabled && contains(item, x, y)) {
      return item.widget;
    }
  }
  return null;
}

/**
 * The frame an `OnMouseWheel` at this point belongs to, or null.
 *
 * **NOT `hitTest` plus an ancestor walk, and that is why the wheel reached nothing on the quest page.**
 * `hitTest` answers the topmost MOUSE-ENABLED item, and over the quest text that is `QuestFrame` itself
 * -- a movable panel, so `enableMouse="true"`. Walking up from there goes `QuestFrame` -> `UIParent`,
 * while `QuestDetailScrollFrame`, the frame that actually binds `<OnMouseWheel>`
 * (`uipaneltemplates.xml:327-329`), is a DESCENDANT of the hit and therefore never consulted. The
 * arrows and the drag were dead for an unrelated reason (`loader.ts#applySliderThumb`); this is the
 * wheel's own.
 *
 * So the search is the engine's: `mouseEnabled` is not consulted at all, because the wheel is
 * `EnableMouseWheel` -- a separate flag, as `framexml/loader.ts:137` already records. Backwards over the
 * draw list is the z-order rule (the same walk `hitTest` and `paneAt` use), and from each item that
 * contains the point we climb to the nearest ancestor carrying a handler: the quest text is drawn after
 * the panel, so it is reached first and its climb finds the scroll frame.
 *
 * Cost is not on the critical path -- this runs once per physical wheel notch, never per frame, and the
 * common case exits on the first few items rather than walking the list.
 */
/**
 * The `<Slider>` thumb under this point, as a DRAW ITEM -- the item, because `drawList` overrides a
 * thumb's rect from its track and the live value, so the item's rect is the only one that is where the
 * knob actually is.
 *
 * `mouseEnabled` is not consulted, for the reason `paneAt` gives: this is an engine gesture, and a
 * `<ThumbTexture>` is art -- it authors no `enableMouse` and never could, so gating on that flag would
 * make the drag impossible rather than optional.
 */
export function sliderThumbAt(items: DrawItem[], x: number, y: number): DrawItem | null {
  for (let index = items.length - 1; index >= 0; --index) {
    const item = items[index];
    if (item.widget.thumbOf !== null && contains(item, x, y)) {
      return item;
    }
  }
  return null;
}

export function wheelTargetAt(items: DrawItem[], x: number, y: number): Widget | null {
  for (let index = items.length - 1; index >= 0; --index) {
    const item = items[index];
    if (!contains(item, x, y)) {
      continue;
    }
    for (let node: Widget | null = item.widget; node !== null; node = node.parent) {
      if (node.onMouseWheel !== null) {
        return node;
      }
    }
  }
  return null;
}

/**
 * The MODEL PANE a press at this point should spin, or null -- and it deliberately ignores
 * `mouseEnabled`.
 *
 * A `<PlayerModel>`'s drag-to-rotate is not a FrameXML script. Grepped the whole loaded world manifest:
 * `CharacterModelFrame`'s only mouse handlers are `<OnMouseUp>` and `<OnReceiveDrag>`, both
 * `CharacterModelFrame_OnMouseUp` -> `AutoEquipCursorItem()` (paperdollframe.xml:479-481,
 * paperdollframe.lua:149-153), and no file anywhere binds a press-and-move handler to a model frame.
 * Yet the real client rotates the paper doll when you drag on it, so that behaviour belongs to the
 * ENGINE's model widget -- which is why it is answered here rather than by a script.
 *
 * `mouseEnabled` governs SCRIPT dispatch (`hitTest` above), and `CharacterModelFrame` authors no
 * `enableMouse` attribute, so it is false for us. Gating the engine's own drag on it would make the
 * behaviour depend on a flag that describes something else. (That the frame is not mouse-enabled for
 * us is also why its `OnMouseUp` equip-from-cursor never fires -- a separate defect, in the equipment
 * area rather than this one, and reported rather than fixed here.)
 *
 * ## Z-ORDER, and it is the whole of the function
 *
 * ONE backwards walk that stops at the first thing it recognises, which is what makes this a
 * z-order rule rather than two independent tests. The first version asked `hitTest` for null and only
 * then looked for a pane -- and it never fired once, because `CharacterFrame` IS
 * `enableMouse="true"` (it is a movable panel) and sits UNDER the pane, so `hitTest` always answered
 * the panel and the pane was never reached. MEASURED: an 80-pixel drag across the middle of the pane
 * left `CharacterModelFrame.rotation` at `Model_OnLoad`'s 0.61.
 *
 * Stopping at the first recognised item gets both cases right for the same reason the renderer does:
 * the two rotate BUTTONS are children of the pane and therefore draw after it, so they are found
 * first and this answers null (a script owns that press); the panel behind the pane is found later
 * and never reached.
 */
export function paneAt(items: DrawItem[], x: number, y: number): Widget | null {
  for (let index = items.length - 1; index >= 0; --index) {
    const item = items[index];
    if (!contains(item, x, y)) {
      continue;
    }
    const rig = item.widget.modelRig;
    // `framing === 'body'` and not merely "has a rig": a PORTRAIT is a `<Texture>` region carrying a
    // rig too (`ui/portrait-bridge.ts`), and dragging on a unit frame's face must not spin it -- the
    // real client's portrait does not rotate.
    if (rig !== null && rig.unit !== null && rig.framing === 'body') {
      return item.widget;
    }
    if (item.widget.mouseEnabled) {
      // Something scriptable is on top of (or is) whatever is here. Its press is not a pane spin.
      return null;
    }
  }
  return null;
}

/** Focusable, non-disabled widgets in draw order -- the Tab ring. */
export function focusChain(items: DrawItem[]): Widget[] {
  return items
    .filter((item) => item.widget.focusable && item.widget.state !== 'disabled')
    .map((item) => item.widget);
}

/** The next focus target, wrapping. `current` of null starts at the first (or last, backwards). */
export function nextFocus(
  chain: Widget[],
  current: Widget | null,
  backwards = false,
): Widget | null {
  if (chain.length === 0) {
    return null;
  }

  const index = current ? chain.indexOf(current) : -1;
  if (index < 0) {
    return backwards ? chain[chain.length - 1] : chain[0];
  }

  const step = backwards ? -1 : 1;
  return chain[(index + step + chain.length) % chain.length];
}
