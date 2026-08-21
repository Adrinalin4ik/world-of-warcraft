/**
 * A `<ScrollFrame>` clips its scroll child.
 *
 * `methods/scroll.ts`' header predicted the consequence of not doing so -- "an offset scroll child would
 * draw outside its viewport rather than being scrolled inside it" -- and the trainer round measured it: a
 * rank string beginning at **x = 295 inside a 296-wide viewport**, which the real client hides by
 * clipping and we drew in full.
 *
 * The second test is the one that protects the offscreen target: clipping may only make the draw list
 * SHORTER.
 */
import { Widget, WidgetRoot } from '../widget';

const VIEWPORT = { width: 1024, height: 768 };

/** A scroll frame with a child, wired the way `SetScrollChild` wires it. */
function scrollBox(childWidth: number, childLeft: number) {
  const root = new WidgetRoot();
  const frame = new Widget('frame', 'Viewport');
  frame.setSize(296, 100);
  frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
  root.root.add(frame);

  const child = new Widget('frame', 'ScrollChild');
  child.setSize(600, 100);
  child.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
  frame.add(child);
  // What `SetScrollChild` sets, and only on the child.
  child.clippedBy = frame;

  const row = new Widget('texture', 'Row');
  row.sprite = 'Interface\Buttons\UI-Panel-Button-Up';
  row.setSize(childWidth, 12);
  row.setAnchors({ point: 'TOPLEFT', relativeTo: 'ScrollChild', relativePoint: 'TOPLEFT', x: childLeft, y: 0 });
  child.add(row);

  return { root, frame, row };
}

describe('ScrollFrame clipping', () => {
  it('cuts a row at the viewport edge instead of drawing it in full', () => {
    // The trainer's case: a row starting at x=295 inside a 296-wide viewport.
    const { root, row } = scrollBox(60, 295);
    const items = root.drawList(VIEWPORT);
    const drawn = items.find((item) => item.widget === row);
    expect(drawn).toBeDefined();
    // One unit survives, not sixty.
    expect(Math.round(drawn!.rect.left)).toBe(295);
    expect(Math.round(drawn!.rect.width)).toBe(1);
  });

  it('drops a fully-outside row, and never lengthens the draw list', () => {
    const inside = scrollBox(60, 0);
    const outside = scrollBox(60, 400);

    const insideItems = inside.root.drawList(VIEWPORT);
    const outsideItems = outside.root.drawList(VIEWPORT);

    // Wholly inside: present and untouched.
    const kept = insideItems.find((item) => item.widget === inside.row);
    expect(kept).toBeDefined();
    expect(Math.round(kept!.rect.width)).toBe(60);

    // Wholly outside the 296-wide viewport: gone.
    expect(outsideItems.some((item) => item.widget === outside.row)).toBe(false);

    // THE CONSTRAINT: clipping can only make the list shorter. `items.length` is the offscreen
    // target's whole basis, so a crop that added an item would hand back what it buys.
    expect(outsideItems.length).toBeLessThan(insideItems.length);

    // And the scrollbar case: a sibling of the scroll frame's child is NOT clipped, because
    // `clippedBy` is set only on the child `SetScrollChild` names.
    const bar = new Widget('texture', 'ScrollBar');
    bar.sprite = 'Interface\Buttons\UI-ScrollBar-Knob';
    bar.setSize(16, 100);
    bar.setAnchors({ point: 'TOPLEFT', relativeTo: 'Viewport', relativePoint: 'TOPRIGHT', x: 4, y: 0 });
    inside.frame.add(bar);
    const withBar = inside.root.drawList(VIEWPORT);
    const barItem = withBar.find((item) => item.widget === bar);
    expect(barItem).toBeDefined();
    // Outside the viewport to the right, and still full width -- exactly where the client puts it.
    expect(Math.round(barItem!.rect.left)).toBe(300);
    expect(Math.round(barItem!.rect.width)).toBe(16);
  });
});
