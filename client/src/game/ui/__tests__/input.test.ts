import { GlueInput } from '../input';
import { Widget, WidgetRoot } from '../widget';

const viewport = { width: 1024, height: 768 };

function tree() {
  const root = new WidgetRoot();

  const button = root.root.add(new Widget('button', 'button'));
  button.layer = 'ARTWORK';
  button.mouseEnabled = true;
  button.focusable = true;
  button.setSize(100, 40).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

  return root;
}

describe('GlueInput.reset', () => {
  it('clears the focused widget and the hover flag it set', () => {
    const canvas = document.createElement('canvas');
    const input = new GlueInput(canvas);
    const items = tree().drawList(viewport);
    input.setDrawList(items);

    const button = items[0].widget;
    input.setFocus(button);
    // Poke the private hover tracking directly -- reaching this state through a real
    // pointermove would need a full DOM event + layout round-trip that adds nothing here.
    (input as unknown as { hovered: Widget | null }).hovered = button;
    button.hovered = true;

    expect(input.focused).toBe(button);

    input.reset();

    expect(input.focused).toBeNull();
    expect(button.hovered).toBe(false);
    expect((input as unknown as { hovered: Widget | null }).hovered).toBeNull();
  });

  it('is safe to call with nothing focused or hovered', () => {
    const canvas = document.createElement('canvas');
    const input = new GlueInput(canvas);

    expect(() => input.reset()).not.toThrow();
    expect(input.focused).toBeNull();
  });
});
