import { FontSpec, MeasureText, Widget, WidgetRoot } from '../widget';

describe('WidgetRoot#drawList', () => {
  it('draws a DIALOG-strata frame over a MEDIUM frame whatever their layers say', () => {
    const root = new WidgetRoot();

    const behind = root.root.add(new Widget('texture', 'behind'));
    behind.layer = 'HIGHLIGHT';
    behind.setSize(10, 10).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

    const dialog = root.root.add(new Widget('texture', 'dialog'));
    dialog.strata = 'DIALOG';
    dialog.layer = 'BACKGROUND';
    dialog.setSize(10, 10).setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });

    const ids = root.drawList({ width: 1024, height: 768 }).map((item) => item.widget.id);

    expect(ids.indexOf('dialog')).toBeGreaterThan(ids.indexOf('behind'));
  });
});

/**
 * An unsized `<FontString>` and what hangs off it.
 *
 * The tree is `AccountLoginSaveAccountNameText` and `AccountLoginSaveAccountName` as
 * accountlogin.xml:530-562 authors them: the label carries no `<Size>` at all and the 20x20 check
 * button anchors its `RIGHT` to the label's `LEFT`. Measurement is stubbed at a flat 4 units per
 * character rather than run through a real typeface -- the rule under test is that layout takes the
 * measured size, not what any TTF measures to.
 */
describe('an unsized font string', () => {
  const FONT: FontSpec = {
    family: 'FRIZQT',
    size: 10,
    color: '#ffc700',
    outline: true,
    align: 'CENTER',
  };

  const measure: MeasureText = (text) => ({ width: text.length * 4, height: 14 });

  const VIEWPORT = { width: 1024, height: 768 };

  /** The label, its anchor, and the check button whose right edge meets the label's left. */
  function tree(): WidgetRoot {
    const root = new WidgetRoot();

    const label = root.root.add(new Widget('fontstring', 'save-name-text'));
    label.font = FONT;
    label.text = 'Remember Account Name';
    // `<Anchor point="TOP" relativeTo="AccountLoginLoginButton" relativePoint="BOTTOM">` with x=10;
    // standing in for the login button here, since only the label's own zero size is under test.
    label.setAnchors({ point: 'TOP', x: 10, y: -400 });

    const check = root.root.add(new Widget('checkbutton', 'save-name'));
    check
      .setSize(20, 20)
      .setAnchors({ point: 'RIGHT', relativeTo: 'save-name-text', relativePoint: 'LEFT', x: 0, y: 0 });

    return root;
  }

  it('resolves to the size of its text instead of 0x0', () => {
    const items = tree().drawList(VIEWPORT, measure);
    const rect = items.find((item) => item.widget.id === 'save-name-text')!.rect;

    expect(rect.width).toBe('Remember Account Name'.length * 4);
    expect(rect.height).toBe(14);
  });

  it('puts a sibling anchored to its LEFT edge a full label to the left of its centre', () => {
    const items = tree().drawList(VIEWPORT, measure);
    const label = items.find((item) => item.widget.id === 'save-name-text')!.rect;
    const check = items.find((item) => item.widget.id === 'save-name')!.rect;

    // The check button's RIGHT edge sits exactly on the label's LEFT edge -- which is half a label
    // width left of the anchor point, where a 0-wide label used to put both of them.
    expect(check.left + check.width).toBe(label.left);
    expect(label.left).toBe(10 + VIEWPORT.width / 2 - label.width / 2);
  });
});
