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

  /**
   * FAILING OPEN is the property that matters when something upstream is wrong.
   *
   * Clipping is the only stage in `drawList` that can DROP an item, so a viewport whose rect we could
   * not establish must not turn a misplaced panel into a blank one -- blank is far harder to diagnose,
   * because nothing is left on screen to reason about. Two ways a viewport goes unresolvable, and both
   * pass the content through unclipped.
   */
  /**
   * A FONT STRING IS CROPPED, NOT NARROWED, and the distinction is the whole of the owner's report.
   *
   * `renderer.ts` draws a string at its RASTERIZED size centred in its rect, not stretched to it. So
   * shrinking the rect re-centres the text in a smaller box and keeps its full height: the block drifts
   * further the more of it is cropped, blocks at different crops appear to move at different speeds and
   * collide, and the quad spills past the viewport. "нижняя часть движется быстрее и заходит поверх
   * другого текста" + "текст уходит за пределы бокса", one cause.
   *
   * So the rect must survive untouched and the viewport must ride along as `crop`.
   */
  it('leaves a partially clipped font string its rect and carries the crop instead', () => {
    const root = new WidgetRoot();
    const frame = new Widget('frame', 'Viewport');
    frame.setSize(300, 100);
    frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
    root.root.add(frame);

    const child = new Widget('frame', 'ScrollChild');
    child.setSize(300, 400);
    child.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
    child.clippedBy = frame;
    frame.add(child);

    // Straddling the bottom edge: 40 units tall starting 80 down a 100-tall viewport.
    const text = new Widget('fontstring', 'Body');
    text.setSize(285, 40);
    text.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: -80 });
    child.add(text);

    const drawn = root.drawList(VIEWPORT).find((item) => item.widget === text);
    expect(drawn).toBeDefined();

    // The rect is the UNCROPPED placement -- all 40 units of it.
    expect(Math.round(drawn!.rect.height)).toBe(40);
    // And the crop is the VIEWPORT -- all 100 units of it, not the 20 where the two overlap. The
    // renderer intersects the text QUAD with this, and that quad is the rasterized glyph box rather
    // than the rect: cropping to the overlap cut the text at the rect's edge instead of the viewport's,
    // which is the hard dividing line the owner photographed.
    expect(drawn!.crop).toBeDefined();
    expect(Math.round(drawn!.crop!.height)).toBe(100);
    expect(Math.round(drawn!.crop!.top)).toBe(0);
  });

  it('does not clip when the viewport is unplaceable or zero-sized', () => {
    const build = (apply: (frame: Widget) => void) => {
      const root = new WidgetRoot();
      const frame = new Widget('frame', 'Viewport');
      frame.setSize(296, 100);
      frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
      root.root.add(frame);
      const child = new Widget('frame', 'ScrollChild');
      child.setSize(600, 100);
      child.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: 0 });
      frame.add(child);
      child.clippedBy = frame;
      const row = new Widget('texture', 'Row');
      row.sprite = 'Interface\Buttons\UI-Panel-Button-Up';
      row.setSize(60, 12);
      row.setAnchors({ point: 'TOPLEFT', relativeTo: 'ScrollChild', relativePoint: 'TOPLEFT', x: 400, y: 0 });
      child.add(row);
      apply(frame);
      return { items: root.drawList(VIEWPORT), row };
    };

    // Sanity: with a good viewport that row IS dropped -- x=400 in a 296-wide box.
    const clipped = build(() => undefined);
    expect(clipped.items.some((item) => item.widget === clipped.row)).toBe(false);

    // A viewport sized 0 by a script that has not run yet. `drawList` runs from the first frame, so
    // this is reachable during the load for any frame the client sizes in Lua.
    const zero = build((frame) => frame.setSize(0, 0));
    expect(zero.items.some((item) => item.widget === zero.row)).toBe(true);

    // A viewport with no resolvable anchor chain -- `unplaceableNodes` knows, and the clip defers to it.
    const loose = build((frame) => frame.setAnchors());
    expect(loose.items.some((item) => item.widget === loose.row)).toBe(true);
  });
});
