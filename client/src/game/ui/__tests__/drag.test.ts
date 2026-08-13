import { GlueInput } from '../input';
import { Widget, WidgetRoot } from '../widget';

/**
 * THE DRAG GESTURE: press, move past the threshold, release over a different widget.
 *
 * This is the half that did not exist -- `RegisterForDrag` stored its registration and nothing ever fired
 * `OnDragStart`, so dragging an ability was inert. The three things worth pinning, all of which a
 * screenshot of a moved icon would not catch:
 *
 *   1. `onDragStart` fires on the SOURCE once the threshold is crossed, and only on a widget that
 *      registered for drag -- otherwise every button on the screen becomes draggable.
 *   2. `onReceiveDrag` fires on whatever is UNDER THE CURSOR at the release, which is a different widget.
 *      The router's pre-existing "released off the widget -> no click" return sits at exactly the point a
 *      drop needs to be handled, so this is the case most likely to be swallowed.
 *   3. The drag SUPPRESSES the click. Releasing a drag over the source must not also cast the ability.
 */
const BOUNDS = { width: 1024, height: 768, left: 0, top: 0 };

/** Two adjacent mouse-enabled buttons, the source registered for drag and the target not. */
function twoButtons() {
  const root = new WidgetRoot();

  const source = root.root.add(new Widget('button', 'source'));
  source.layer = 'ARTWORK';
  source.mouseEnabled = true;
  source.dragRegistered = true; // what `RegisterForDrag("LeftButton")` does
  source.setSize(40, 40).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  const target = root.root.add(new Widget('button', 'target'));
  target.layer = 'ARTWORK';
  target.mouseEnabled = true;
  target.setSize(40, 40).setAnchors({ point: 'TOPLEFT', x: 200, y: 0 });

  return { root, source, target };
}

function canvasWithBounds(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  // `toUnits` needs a real rect; jsdom reports zeroes, which would collapse every coordinate to 0.
  canvas.getBoundingClientRect = () => BOUNDS as DOMRect;
  return canvas;
}

/** Drive the router's pointer handlers directly, as `input.test.ts` does for keys. */
function pointer(input: GlueInput, phase: 'down' | 'move' | 'up', x: number, y: number): void {
  const event = { clientX: x, clientY: y, preventDefault: () => undefined } as unknown as PointerEvent;
  const handlers = input as unknown as Record<string, (event: PointerEvent) => void>;
  const name = phase === 'down' ? 'onPointerDown' : phase === 'move' ? 'onPointerMove' : 'onPointerUp';
  handlers[name](event);
}

describe('the drag gesture', () => {
  it('starts a drag past the threshold and drops it on the widget under the cursor, with no click', () => {
    const input = new GlueInput(canvasWithBounds());
    const { root, source, target } = twoButtons();
    input.setDrawList(root.drawList(BOUNDS, () => ({ width: 0, height: 0 })));

    const fired: string[] = [];
    source.onDragStart = () => fired.push('source:dragStart');
    source.onDragStop = () => fired.push('source:dragStop');
    source.onClick = () => fired.push('source:click');
    source.onReceiveDrag = () => fired.push('source:receive');
    target.onReceiveDrag = () => fired.push('target:receive');
    target.onClick = () => fired.push('target:click');

    // Press on the source, at its centre. `BOUNDS` is 1024x768 so a logical unit is a pixel here.
    pointer(input, 'down', 20, 20);
    expect(fired).toEqual([]);

    // A move INSIDE the threshold (4 units) is not a drag yet -- otherwise a click's own jitter starts one.
    pointer(input, 'move', 22, 20);
    expect(fired).toEqual([]);

    // Past it: `OnDragStart` on the source, exactly once however far it then travels.
    pointer(input, 'move', 40, 20);
    pointer(input, 'move', 120, 20);
    pointer(input, 'move', 215, 20);
    expect(fired).toEqual(['source:dragStart']);

    // Release over the TARGET: stop on the source, receive on the target -- and no click on either.
    pointer(input, 'up', 215, 20);
    expect(fired).toEqual(['source:dragStart', 'source:dragStop', 'target:receive']);
  });

  it('leaves an unregistered widget clickable: no drag, and the click still fires', () => {
    const input = new GlueInput(canvasWithBounds());
    const { root, target } = twoButtons();
    input.setDrawList(root.drawList(BOUNDS, () => ({ width: 0, height: 0 })));

    const fired: string[] = [];
    target.onDragStart = () => fired.push('dragStart');
    target.onClick = () => fired.push('click');

    // `target.dragRegistered` is false, so moving well past the threshold must not begin a drag -- and the
    // release back over the widget is then an ordinary click.
    pointer(input, 'down', 215, 20);
    pointer(input, 'move', 230, 20);
    pointer(input, 'move', 215, 20);
    pointer(input, 'up', 215, 20);

    expect(fired).toEqual(['click']);
  });
});
