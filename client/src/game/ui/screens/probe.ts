/**
 * THROWAWAY proof screen. Deleted in spec 3, when the transcribed `AccountLogin` replaces it.
 *
 * Its whole job is to exercise the foundation against real client data: an ADD-blended logo, a
 * three-state button, an edit box that takes typing and paste, an outlined font string, and a
 * dialog on the DIALOG layer. Nothing here is authored layout -- do not treat it as reference.
 */
import { PROBE_ART } from '../art';
import { ClientState, GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';

const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffd100',
  outline: true,
  align: 'CENTER',
};

export class ProbeScreen implements GlueScreen {
  private ctx: GlueContext | null = null;
  private dialog: Widget | null = null;
  private box: Widget | null = null;
  private boxText: Widget | null = null;
  private button: Widget | null = null;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    ctx.art.registerAll(PROBE_ART);
    void ctx.art.load();

    // The login scene, chosen exactly as accountlogin.lua does. `northrend: false` is the base
    // main menu; spec 3 picks the variant from the account's expansion level.
    ctx.setScene({ kind: 'mainmenu', northrend: false });

    const logo = ctx.root.root.add(new Widget('texture', 'probe-logo'));
    logo.layer = 'BACKGROUND';
    logo.sprite = 'logo';
    logo.blend = 'ADD';
    logo.setSize(400, 200).setAnchors({ point: 'TOP', x: 0, y: -40 });

    const box = ctx.root.root.add(new Widget('editbox', 'probe-editbox'));
    box.layer = 'ARTWORK';
    box.sprite = 'editbox-left';
    box.mouseEnabled = true;
    box.focusable = true;
    box.maxLetters = 16;
    box.setSize(200, 32).setAnchors({ point: 'CENTER', x: 0, y: 40 });

    const boxText = box.add(new Widget('fontstring', 'probe-editbox-text'));
    boxText.layer = 'OVERLAY';
    boxText.font = { ...LABEL, color: '#ffffff', align: 'LEFT' };
    boxText.setSize(190, 16).setAnchors({
      point: 'LEFT',
      relativeTo: 'probe-editbox',
      relativePoint: 'LEFT',
      x: 8,
      y: 0,
    });

    const button = ctx.root.root.add(new Widget('button', 'probe-button'));
    button.layer = 'ARTWORK';
    button.sprite = 'button-up';
    button.mouseEnabled = true;
    button.focusable = true;
    button.setSize(128, 32).setAnchors({ point: 'CENTER', x: 0, y: -20 });
    button.onClick = () => this.dialog?.show();

    const caption = button.add(new Widget('fontstring', 'probe-button-caption'));
    caption.layer = 'OVERLAY';
    caption.font = LABEL;
    caption.text = ctx.strings.get('OKAY');
    caption.setSize(128, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'probe-button',
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });

    this.dialog = ctx.root.root.add(new Widget('backdrop', 'probe-dialog'));
    this.dialog.layer = 'DIALOG';
    this.dialog.sprite = 'dialog-background';
    this.dialog.mouseEnabled = true;
    this.dialog.setSize(300, 120).setAnchors({ point: 'CENTER', x: 0, y: 0 });
    this.dialog.onClick = () => this.dialog?.hide();
    this.dialog.hide();

    const dialogText = this.dialog.add(new Widget('fontstring', 'probe-dialog-text'));
    dialogText.layer = 'DIALOG';
    dialogText.font = LABEL;
    dialogText.text = ctx.strings.get('CANCEL');
    dialogText.setSize(280, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'probe-dialog',
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });

    this.boxText = boxText;
    this.box = box;
    this.button = button;
  }

  update(): void {
    if (this.box && this.boxText) {
      this.boxText.text = this.box.text;
    }
    if (this.button) {
      // Three-state art, as the reference's buttons swap it.
      this.button.sprite =
        this.button.state === 'down'
          ? 'button-down'
          : this.button.hovered
            ? 'button-highlight'
            : 'button-up';
    }
  }

  unmount(): void {
    this.ctx = null;
    this.box = null;
    this.boxText = null;
    this.button = null;
    this.dialog = null;
  }
}

/** The state the probe stands in for while spec 3's real login screen does not exist yet. */
export const PROBE_STATE = ClientState.Login;
