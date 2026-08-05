/**
 * Hit-testing and focus over a widget draw list.
 *
 * Reads the SAME ordered list the renderer draws, walked backwards -- the top-most drawn
 * mouse-enabled widget wins. Pure: no DOM, no three.js. `input.ts` owns the events; this file only
 * answers "what is under this point" and "what gets focus next".
 */
import { DrawItem, Widget } from './widget';

function contains(item: DrawItem, x: number, y: number): boolean {
  const { left, top, width, height } = item.rect;
  return x >= left && x < left + width && y >= top && y < top + height;
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

/** Focusable widgets in draw order -- the Tab ring. */
export function focusChain(items: DrawItem[]): Widget[] {
  return items.filter((item) => item.widget.focusable).map((item) => item.widget);
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
