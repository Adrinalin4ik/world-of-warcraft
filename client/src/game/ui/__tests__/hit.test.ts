import { focusChain, hitTest, nextFocus } from '../hit';
import { Widget, WidgetRoot } from '../widget';

const viewport = { width: 1024, height: 768 };

function tree() {
  const root = new WidgetRoot();

  const back = root.root.add(new Widget('texture', 'back'));
  back.layer = 'BACKGROUND';
  back.mouseEnabled = true;
  back.setSize(400, 400).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  const front = root.root.add(new Widget('button', 'front'));
  front.layer = 'ARTWORK';
  front.mouseEnabled = true;
  front.focusable = true;
  front.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 50, y: -50 });

  const decoration = root.root.add(new Widget('texture', 'decoration'));
  decoration.layer = 'OVERLAY';
  // Deliberately NOT mouse-enabled: art on top of a button must not eat its clicks.
  decoration.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 50, y: -50 });

  const box = root.root.add(new Widget('editbox', 'box'));
  box.layer = 'ARTWORK';
  box.mouseEnabled = true;
  box.focusable = true;
  box.setSize(200, 32).setAnchors({ point: 'TOPLEFT', x: 50, y: -200 });

  return root;
}

describe('hitTest', () => {
  it('returns the top-most mouse-enabled widget', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 60, 60)!.id).toBe('front');
  });

  it('falls through art that is not mouse-enabled', () => {
    const root = tree();
    // Make the decoration cover the button entirely; it still must not be hit.
    const items = root.drawList(viewport);
    const hit = hitTest(items, 100, 70);

    expect(hit!.id).toBe('front');
  });

  it('returns the widget beneath when nothing above is hit', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 10, 300)!.id).toBe('back');
  });

  it('returns null outside every widget', () => {
    const items = tree().drawList(viewport);

    expect(hitTest(items, 900, 700)).toBeNull();
  });

  it('ignores hidden widgets', () => {
    const root = tree();
    root.root.children.find((child) => child.id === 'front')!.hide();
    const items = root.drawList(viewport);

    expect(hitTest(items, 60, 60)!.id).toBe('back');
  });
});

describe('focus', () => {
  it('chains focusable widgets in draw order', () => {
    const items = tree().drawList(viewport);

    expect(focusChain(items).map((widget) => widget.id)).toEqual(['front', 'box']);
  });

  it('advances and wraps with Tab', () => {
    const chain = focusChain(tree().drawList(viewport));

    expect(nextFocus(chain, null)!.id).toBe('front');
    expect(nextFocus(chain, chain[0])!.id).toBe('box');
    expect(nextFocus(chain, chain[1])!.id).toBe('front');
  });

  it('walks backwards with Shift+Tab', () => {
    const chain = focusChain(tree().drawList(viewport));

    expect(nextFocus(chain, chain[0], true)!.id).toBe('box');
  });
});
