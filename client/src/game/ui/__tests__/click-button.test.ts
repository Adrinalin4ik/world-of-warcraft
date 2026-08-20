import { GlueInput } from '../input';
import { MouseButtonName, Widget, WidgetRoot } from '../widget';

const viewport = { width: 1024, height: 768 };

/**
 * A press-then-release on the widget, driving the router's own private handlers.
 *
 * `toUnits` needs a bounding rect that jsdom's canvas does not have, so the press coordinates are given
 * in widget space and the conversion is stubbed -- the same shortcut `input.test.ts` takes for hover.
 */
function click(input: GlueInput, button: number): void {
  const router = input as unknown as {
    onPointerDown: (event: PointerEvent) => void;
    onPointerUp: (event: PointerEvent) => void;
    toUnits: (event: { clientX: number; clientY: number }) => { x: number; y: number };
  };
  router.toUnits = () => ({ x: 10, y: 10 });
  const event = { button, pointerId: undefined, clientX: 10, clientY: 10 } as unknown as PointerEvent;
  router.onPointerDown(event);
  router.onPointerUp(event);
}

function buttonWidget(registered: MouseButtonName[] | null) {
  const root = new WidgetRoot();
  const widget = root.root.add(new Widget('button', 'slot'));
  widget.layer = 'ARTWORK';
  widget.mouseEnabled = true;
  widget.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });
  widget.clickButtons = registered === null ? null : new Set(registered);
  return { root, widget };
}

describe('GlueInput click routing', () => {
  /**
   * THE BUG THIS PINS is why nothing could be equipped: every click reached Lua as `"LeftButton"`, so
   * `ContainerFrameItemButton_OnClick` took its LEFT branch (`PickupContainerItem`, the item-cursor
   * gap) on a right-click instead of its right branch (`UseContainerItem`).
   * `ContainerFrameItemButton_OnLoad` registers `"LeftButtonUp", "RightButtonUp"`
   * (`containerframe.lua:614`), which is the registration used here.
   */
  it('reports the real button to a frame registered for it', () => {
    const { root, widget } = buttonWidget(['LeftButton', 'RightButton']);
    const seen: MouseButtonName[] = [];
    widget.onClick = (button) => { seen.push(button); };

    const input = new GlueInput(document.createElement('canvas'));
    input.setDrawList(root.drawList(viewport));

    click(input, 0);
    click(input, 2);

    expect(seen).toEqual(['LeftButton', 'RightButton']);
  });

  it('a frame that never called RegisterForClicks takes the left button only', () => {
    const { root, widget } = buttonWidget(null);
    const seen: MouseButtonName[] = [];
    widget.onClick = (button) => { seen.push(button); };

    const input = new GlueInput(document.createElement('canvas'));
    input.setDrawList(root.drawList(viewport));

    click(input, 2);
    click(input, 0);

    expect(seen).toEqual(['LeftButton']);
  });
});
