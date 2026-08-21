/**
 * A frame that has never been DRAWN still has a rect -- and asking for one must not put it in the draw
 * list.
 *
 * The chat round found this precisely: `ChatFrame2..7` die in `FCF_UpdateButtonSide` on
 * `GetScreenWidth() - chatFrame:GetRight()` (`floatingchatframe.lua:1281`), reached from a chat frame's
 * own load path (`:167`) -- arithmetic on nil, because `rectOf` returned null whenever no draw list had
 * been published yet.
 *
 * Two assertions, and the second is the one that protects the offscreen target: the `items` count is
 * IDENTICAL before and after the query, because `layoutRects` returns a Map and never touches
 * `drawList`.
 */
import { publishRects, rectOf, clearRects, setRectResolver, rectStats } from '../rects';
import { Widget, WidgetRoot } from '../widget';

describe('a rect for a frame that was never drawn', () => {
  afterEach(() => {
    setRectResolver(null);
    clearRects();
  });

  it('answers before the first publish, and does not grow the draw list', () => {
    const root = new WidgetRoot();
    const viewport = { width: 1024, height: 768 };

    // A hidden, laid-out frame -- the shape of a chat window the client positions during OnLoad.
    const hidden = new Widget('frame', 'ChatFrame2');
    hidden.setSize(430, 120);
    hidden.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 32, y: -60 });
    hidden.hide();
    root.root.add(hidden);

    setRectResolver(() => root.layoutRects(viewport));

    // NOTHING has been published: this is the manifest-load case, and it used to answer null.
    const rect = rectOf('ChatFrame2');
    expect(rect).not.toBeNull();
    expect(Math.round(rect!.left)).toBe(32);
    // `GetRight()` is `left + width`, which is the value `FCF_UpdateButtonSide` subtracts.
    expect(Math.round(rect!.left + rect!.width)).toBe(462);

    // THE CONSTRAINT: the draw list is unchanged by asking. A hidden frame must stay out of it.
    const before = root.drawList(viewport).length;
    publishRects(root.drawList(viewport), viewport.height);
    expect(rectOf('ChatFrame2')).not.toBeNull();
    const after = root.drawList(viewport).length;
    expect(after).toBe(before);
    // And the frame itself is genuinely absent from it, not merely counted the same.
    expect(root.drawList(viewport).some((item) => item.widget === hidden)).toBe(false);
  });

  it('costs one resolve per geometry change, not one per query', () => {
    const root = new WidgetRoot();
    const viewport = { width: 1024, height: 768 };
    for (let i = 0; i < 200; i += 1) {
      const frame = new Widget('frame', `Row${i}`);
      frame.setSize(100, 12);
      frame.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 0, y: -12 * i });
      root.root.add(frame);
    }
    setRectResolver(() => root.layoutRects(viewport));

    const start = rectStats.resolves;
    // Many queries, no geometry change between them: the cache must hold.
    for (let i = 0; i < 200; i += 1) {
      expect(rectOf(`Row${i}`)).not.toBeNull();
    }
    expect(rectStats.resolves - start).toBe(1);

    // One geometry change invalidates it exactly once.
    root.root.children[0].setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 9, y: 0 });
    expect(Math.round(rectOf('Row0')!.left)).toBe(9);
    expect(rectStats.resolves - start).toBe(2);
  });
});
