/**
 * A minimal character picker, standing in until spec 5 transcribes `CharacterSelect.xml`. Plain on
 * purpose -- it exists so the machine's `CharSelect` stage lands somewhere real, not to look like
 * the client.
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

export class CharacterStubScreen implements GlueScreen {
  private ctx: GlueContext | null = null;
  private rows: Widget[] = [];

  mount(ctx: GlueContext): void {
    this.ctx = ctx;

    const title = ctx.root.root.add(new Widget('fontstring', 'character-stub-title'));
    title.layer = 'OVERLAY';
    title.font = ROW;
    title.text = ctx.strings.get('SELECT_CHARACTER');
    title.setSize(400, 16).setAnchors({ point: 'TOP', x: 0, y: -200 });

    ctx.protocol.characters.forEach((character, index) => {
      const row = ctx.root.root.add(new Widget('button', `character-stub-${index}`));
      row.layer = 'ARTWORK';
      row.mouseEnabled = true;
      row.focusable = true;
      row.setSize(300, 24).setAnchors({ point: 'TOP', x: 0, y: -240 - index * 28 });
      row.onClick = () => void ctx.protocol.enterWorld(character.guid).catch(() => undefined);

      const label = row.add(new Widget('fontstring', `character-stub-${index}-text`));
      label.layer = 'OVERLAY';
      label.font = ROW;
      label.text = `${character.name} (${character.level})`;
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
    // The world join arrives with the character choice; the machine changes state and this screen
    // goes away.
  }

  unmount(): void {
    this.ctx = null;
    this.rows = [];
  }
}
