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
