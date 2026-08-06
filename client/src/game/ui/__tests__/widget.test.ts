import { Widget, WidgetRoot } from '../widget';

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
