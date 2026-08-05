/**
 * A minimal realm picker, standing in until spec 4 transcribes `RealmList.xml`. Plain on purpose --
 * it exists so the machine's `RealmList` stage lands somewhere real, not to look like the client.
 */
import { GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';

const ROW: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  // `GlueFontNormal`'s colour (gluefontstyles.xml:14-22), not FrameXML's
  // `NORMAL_FONT_COLOR` -- the glue layer has its own table.
  color: '#ffc700',
  outline: true,
  align: 'CENTER',
};

export class RealmStubScreen implements GlueScreen {
  private ctx: GlueContext | null = null;
  private rows: Widget[] = [];

  mount(ctx: GlueContext): void {
    this.ctx = ctx;

    const title = ctx.root.root.add(new Widget('fontstring', 'realm-stub-title'));
    title.layer = 'OVERLAY';
    title.font = ROW;
    title.text = ctx.strings.get('SERVER_SELECTION');
    title.setSize(400, 16).setAnchors({ point: 'TOP', x: 0, y: -200 });

    ctx.protocol.realms.forEach((realm, index) => {
      const row = ctx.root.root.add(new Widget('button', `realm-stub-${index}`));
      row.layer = 'ARTWORK';
      row.mouseEnabled = true;
      row.focusable = true;
      row.setSize(300, 24).setAnchors({ point: 'TOP', x: 0, y: -240 - index * 28 });
      row.onClick = () => void ctx.protocol.chooseRealm(realm).catch(() => undefined);

      const label = row.add(new Widget('fontstring', `realm-stub-${index}-text`));
      label.layer = 'OVERLAY';
      label.font = ROW;
      label.text = `${realm.name} (${realm.characterCount})`;
      label.setSize(300, 16).setAnchors({
        point: 'CENTER',
        relativeTo: row.id,
        relativePoint: 'CENTER',
        x: 0,
        y: 0,
      });

      this.rows.push(row);
    });
  }

  update(): void {
    // The roster arrives with the realm choice; the machine changes state and this screen goes away.
  }

  unmount(): void {
    this.ctx = null;
    this.rows = [];
  }
}
