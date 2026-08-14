import { FontSpec, MeasureText, Widget, WidgetRoot, effectiveFont } from '../widget';

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

  /**
   * THE ACTION BAR'S CORNERED SLOTS. `ActionButton6..12` each anchor LEFT to the previous button's RIGHT
   * (`actionbarframe.xml:96-176`) and `ActionButton_Update` HIDES a slot with no action, so one empty slot
   * used to strand every button after it at the window's corner -- correct only while a drag's
   * `ACTIONBAR_SHOWGRID` had the empty ones shown. A hidden frame still has a rect.
   */
  it('places a shown widget anchored to a HIDDEN one against the hidden one\'s rect', () => {
    const root = new WidgetRoot();

    const first = root.root.add(new Widget('button', 'slot1'));
    first.layer = 'ARTWORK';
    first.setSize(36, 36).setAnchors({ point: 'BOTTOMLEFT', x: 8, y: 4 });

    const empty = root.root.add(new Widget('button', 'slot2'));
    empty.layer = 'ARTWORK';
    empty.setSize(36, 36)
      .setAnchors({ point: 'LEFT', relativeTo: 'slot1', relativePoint: 'RIGHT', x: 6, y: 0 });
    empty.hide();

    const after = root.root.add(new Widget('button', 'slot3'));
    after.layer = 'ARTWORK';
    after.setSize(36, 36)
      .setAnchors({ point: 'LEFT', relativeTo: 'slot2', relativePoint: 'RIGHT', x: 6, y: 0 });

    const items = root.drawList({ width: 1024, height: 768 });
    const rect = items.find((item) => item.widget.id === 'slot3')!.rect;

    // 8 + (36+6) + (36+6) = 92, on the bar's own row -- not 0,0.
    expect(rect.left).toBe(92);
    expect(rect.top).toBe(768 - 4 - 36);
    // ... and the hidden slot itself is still not drawn.
    expect(items.some((item) => item.widget.id === 'slot2')).toBe(false);
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

describe('effectiveFont', () => {
  const spec = (): FontSpec => ({
    family: 'FRIZQT', size: 12, color: '#ffffff', outline: false, align: 'LEFT',
  });

  it('gives a wrap budget to a bounded FontString and nothing to a fixed-height one', () => {
    // The spellbook's own shape: 103 wide, height DERIVED (spellbookframe.xml:100-104). A derived
    // height is the document saying "grow to fit the text", so this is the one that wraps.
    const wraps = new Widget('fontstring', 'name');
    wraps.font = spec();
    wraps.width = 103;
    wraps.height = 0;
    expect(effectiveFont(wraps)!.wrapWidth).toBe(103);

    // `TargetFrameTextureFrameName`'s shape: 100x10, exactly one line (targetframe.xml:248-252). A
    // second line would be drawn outside the rect, so it must NOT wrap -- and the spec object comes
    // back BY IDENTITY, which is what keeps the common case allocation-free.
    const fixed = new Widget('fontstring', 'target');
    fixed.font = spec();
    fixed.width = 100;
    fixed.height = 10;
    expect(effectiveFont(fixed)).toBe(fixed.font);

    // No authored width: nothing to wrap at.
    const unbounded = new Widget('fontstring', 'level');
    unbounded.font = spec();
    expect(effectiveFont(unbounded)).toBe(unbounded.font);
  });

  it('wraps an options-panel paragraph at its RESOLVED width, capped to the lines that fit', () => {
    // The shape all 22 options subtexts author (`videooptionspanels.xml:37-51`): `<Size y="32"
    // x="0"/>`, `TOPLEFT` to the panel title and `RIGHT` to the panel edge. No authored width at all,
    // so the budget can only come from the resolved rect -- and a fixed height of 32 admits 3 lines
    // of a 10-unit font, which is exactly the `maxLines="3"` the same element authors.
    const subText = new Widget('fontstring', 'subtext');
    subText.font = { ...spec(), size: 10 };
    subText.width = 0;
    subText.height = 32;
    subText.setAnchors(
      { point: 'TOPLEFT', relativeTo: 'title', relativePoint: 'BOTTOMLEFT', x: 0, y: -8 },
      { point: 'RIGHT', x: -32, y: 0 },
    );
    const resolved = effectiveFont(subText, 456)!;
    expect(resolved.wrapWidth).toBe(456);
    expect(resolved.maxLines).toBe(3);

    // THE CONTROL ARM: the same widget with only ONE horizontal edge pinned is not bounded by the
    // document, so the resolved width is its own text's width and must not become a budget.
    const oneEdge = new Widget('fontstring', 'oneEdge');
    oneEdge.font = { ...spec(), size: 10 };
    oneEdge.height = 32;
    oneEdge.setAnchors({ point: 'TOPLEFT', x: 0, y: 0 });
    expect(effectiveFont(oneEdge, 456)).toBe(oneEdge.font);
  });
});
