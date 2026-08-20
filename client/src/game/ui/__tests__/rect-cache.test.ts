/**
 * `rectOf`'s on-demand map must not go stale WITHIN a frame.
 *
 * The map exists because the client's own Lua measures a frame in the tick it shows it
 * (`ToggleDropDownMenu`'s `Show()` then `GetCenter()`, `uidropdownmenu.lua:742-751`). Caching it only
 * until the next `publishRects` was safe for one such sequence per frame and wrong for two -- which the
 * unit-popup submenus now do. It is keyed on `widget.ts#geometryRevision` instead.
 */
import { publishRects, rectOf, clearRects } from '../rects';
import { Widget, WidgetRoot } from '../widget';

describe('the on-demand rect map', () => {
  afterEach(() => clearRects());

  it('re-resolves after a frame moves, instead of answering from the pre-move map', () => {
    const root = new WidgetRoot();
    const viewport = { width: 1024, height: 768 };

    const a = new Widget('frame', 'a');
    a.setSize(50, 20);
    a.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 10, y: -10 });
    root.root.add(a);

    const b = new Widget('frame', 'b');
    b.setSize(50, 20);
    b.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 200, y: -10 });
    root.root.add(b);

    // Nothing is in the DRAW list here -- these frames carry no art -- so every lookup below takes the
    // on-demand path, which is exactly the path under test.
    publishRects([], viewport.height, () => root.layoutRects(viewport));

    const first = rectOf('a');
    expect(first).not.toBeNull();
    expect(Math.round(first!.left)).toBe(10);

    // A SECOND Show-then-measure in the same frame: move `b`, then ask about it. With the old
    // publish-scoped cache this answered from the map built for the `a` lookup above.
    b.setAnchors({ point: 'TOPLEFT', relativePoint: 'TOPLEFT', x: 400, y: -10 });
    const moved = rectOf('b');
    expect(moved).not.toBeNull();
    expect(Math.round(moved!.left)).toBe(400);
  });
});
