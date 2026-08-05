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

/**
 * Which main-menu stage the URL asks for. A debug affordance, not the client's law: the client keys
 * off `IsStreamingTrial()`, and `expansion` is here because an expansion number is the way a human
 * thinks about "show me the 3.3.5 screen". `expansion=0` (or `1`) means the pre-Wrath art, which the
 * client only ever shows to a trial account; anything else, or nothing at all, means Wrath.
 */
export function wantsTrialScene(search: string): boolean {
  const params = new URLSearchParams(search);

  if (params.get('trial') === '1' || params.get('trial') === 'true') {
    return true;
  }

  const expansion = params.get('expansion');
  if (expansion === null) {
    return false;
  }

  const level = Number(expansion);
  return Number.isFinite(level) && level < 2;
}

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

    // The login scene. The real client forks on `IsStreamingTrial()` (`accountlogin.lua:32-37`), so
    // the Wrath causeway is the DEFAULT and the vanilla arch is the trial variant; spec 3 will read
    // the account's own flag once there is an account. Until then the URL decides, so both scenes can
    // be looked at without a code edit:
    //
    //   /glue                -> UI_MainMenu_Northrend (what a normal 3.3.5 account sees)
    //   /glue?expansion=0    -> UI_MainMenu           (the vanilla arch, i.e. the trial screen)
    //   /glue?expansion=2    -> UI_MainMenu_Northrend
    //   /glue?trial=1        -> UI_MainMenu           (names the client's actual condition)
    ctx.setScene({ kind: 'mainmenu', streamingTrial: wantsTrialScene(window.location.search) });

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
      // `displayText`, not `text`: the box's stored value is the real string (a login screen
      // submits it); `displayText` is where password masking lives, per `Widget#displayText`.
      this.boxText.text = this.box.displayText;
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
