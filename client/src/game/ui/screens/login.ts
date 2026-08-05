/**
 * The `AccountLogin` screen, transcribed from `interface/gluexml/accountlogin.xml`.
 *
 * Coordinates are the client's own: logo `TOP` +10 at 256x128; account box 600x64 at `BOTTOM` +345;
 * password box 256x64 at `BOTTOM` +275; Login button 170x45 at `BOTTOM` +170. The reference screen's
 * Credits, Cinematics, TOS, survey, token and account-management controls are deliberately absent --
 * they do not serve logging in (benilla cut the same set).
 *
 * The server address field is OURS, not the client's: the real client reads `realmlist.wtf`, and this
 * one targets any private server, so the address has to be reachable from the screen. It is drawn in
 * the authored idiom but it is not authored -- do not cite it as reference fidelity.
 */
import {
  applyRealmlistOverride,
  loadSettings,
  saveSettings,
} from '../../../network/protocol/connection-settings';
import { GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';
import { loginDialog } from './login-state';
import { LOGIN_ART } from './login-art';

/** `GlueFontNormal` in the client: Friz Quadrata, gold, outlined. */
const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffd100',
  outline: true,
  align: 'LEFT',
};

const BUTTON_CAPTION: FontSpec = { ...LABEL, align: 'CENTER' };
const FIELD_TEXT: FontSpec = { ...LABEL, color: '#ffffff' };

export class LoginScreen implements GlueScreen {
  private ctx: GlueContext | null = null;

  private account: Widget | null = null;
  private accountText: Widget | null = null;
  private password: Widget | null = null;
  private passwordText: Widget | null = null;
  private server: Widget | null = null;
  private serverText: Widget | null = null;
  private saveName: Widget | null = null;
  private loginButton: Widget | null = null;
  private loginCaption: Widget | null = null;
  private dialog: Widget | null = null;
  private dialogText: Widget | null = null;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    ctx.art.registerAll(LOGIN_ART);
    void ctx.art.load();

    // The login stage: the Wrath causeway unless this is a trial account. Spec 1's URL override still
    // decides while there is no account to read the flag from.
    ctx.setScene({ kind: 'mainmenu', streamingTrial: false });

    const root = ctx.root.root;
    const settings = applyRealmlistOverride(loadSettings(), window.location.search);

    const logo = root.add(new Widget('texture', 'login-logo'));
    logo.layer = 'ARTWORK';
    logo.sprite = 'logo';
    logo.setSize(256, 128).setAnchors({ point: 'TOP', x: 0, y: -10 });

    // Account box: 600x64 at BOTTOM +345 (accountlogin.xml).
    this.account = this.field(root, 'login-account', 'login-account-text', 600, 345);
    this.accountText = this.account.children[0];
    this.accountText.text = settings.savedAccount ?? '';
    this.account.text = this.accountText.text;
    this.account.caret = this.account.text.length;

    // Password box: 256x64 at BOTTOM +275, masked.
    this.password = this.field(root, 'login-password', 'login-password-text', 256, 275);
    this.passwordText = this.password.children[0];
    this.password.password = true;

    // The server address. Ours, not the client's -- see the file comment.
    this.server = this.field(root, 'login-server', 'login-server-text', 256, 215);
    this.serverText = this.server.children[0];
    this.server.maxLetters = 64;
    this.server.text = `${settings.logonHost}:${settings.logonPort}`;
    this.serverText.text = this.server.text;

    // Save Account Name: a 20x20 check button with its label to the right.
    this.saveName = root.add(new Widget('checkbutton', 'login-save-name'));
    this.saveName.layer = 'ARTWORK';
    this.saveName.sprite = 'check-up';
    this.saveName.mouseEnabled = true;
    this.saveName.checked = Boolean(settings.savedAccount);
    this.saveName.setSize(20, 20).setAnchors({
      point: 'RIGHT',
      relativeTo: 'login-account',
      relativePoint: 'LEFT',
      x: -8,
      y: 0,
    });
    this.saveName.onClick = () => undefined; // the router toggles `checked` itself

    const saveLabel = root.add(new Widget('fontstring', 'login-save-name-text'));
    saveLabel.layer = 'OVERLAY';
    saveLabel.font = LABEL;
    saveLabel.text = ctx.strings.get('SAVE_ACCOUNT_NAME');
    saveLabel.setSize(200, 16).setAnchors({
      point: 'LEFT',
      relativeTo: 'login-save-name',
      relativePoint: 'RIGHT',
      x: 6,
      y: 0,
    });

    // Login button: 170x45 at BOTTOM +170.
    this.loginButton = root.add(new Widget('button', 'login-login'));
    this.loginButton.layer = 'ARTWORK';
    this.loginButton.sprite = 'button-up';
    this.loginButton.mouseEnabled = true;
    this.loginButton.focusable = true;
    this.loginButton.setSize(170, 45).setAnchors({ point: 'BOTTOM', x: 0, y: 170 });
    this.loginButton.onClick = () => this.submit();

    this.loginCaption = this.loginButton.add(new Widget('fontstring', 'login-login-text'));
    this.loginCaption.layer = 'OVERLAY';
    this.loginCaption.font = BUTTON_CAPTION;
    this.loginCaption.text = ctx.strings.get('LOGIN');
    this.loginCaption.setSize(170, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-login',
      relativePoint: 'CENTER',
      x: 0,
      y: 3, // the template's ButtonText offset
    });

    const version = root.add(new Widget('fontstring', 'login-version'));
    version.layer = 'OVERLAY';
    version.font = { ...LABEL, size: 12 };
    version.text = 'Version 3.3.5 (12340)';
    version.setSize(300, 14).setAnchors({ point: 'BOTTOMLEFT', x: 10, y: 10 });

    const blizzard = root.add(new Widget('texture', 'login-blizzard'));
    blizzard.layer = 'ARTWORK';
    blizzard.sprite = 'blizzard-logo';
    blizzard.setSize(128, 64).setAnchors({ point: 'BOTTOMRIGHT', x: -10, y: 10 });

    // The one dialog, reused for connecting and for a refusal.
    this.dialog = root.add(new Widget('backdrop', 'login-dialog'));
    this.dialog.layer = 'DIALOG';
    this.dialog.sprite = 'dialog-background';
    this.dialog.mouseEnabled = true;
    this.dialog.setSize(400, 140).setAnchors({ point: 'CENTER', x: 0, y: 0 });
    this.dialog.hide();
    this.dialog.onCancel = () => this.dialog?.hide();
    this.dialog.onClick = () => this.dialog?.hide();

    this.dialogText = this.dialog.add(new Widget('fontstring', 'login-dialog-text'));
    this.dialogText.layer = 'DIALOG';
    this.dialogText.font = { ...LABEL, align: 'CENTER' };
    this.dialogText.setSize(380, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-dialog',
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });
  }

  /** One edit box plus its text, at an authored width and `BOTTOM` offset. */
  private field(
    root: Widget,
    id: string,
    textId: string,
    width: number,
    bottomOffset: number,
  ): Widget {
    const box = root.add(new Widget('editbox', id));
    box.layer = 'ARTWORK';
    box.sprite = 'input-border';
    box.mouseEnabled = true;
    box.focusable = true;
    box.maxLetters = 16; // letters="16" on both authored boxes
    box.setSize(width, 64).setAnchors({ point: 'BOTTOM', x: 0, y: bottomOffset });
    box.onClick = () => this.submit(); // Enter in a box submits, as the client does

    const text = box.add(new Widget('fontstring', textId));
    text.layer = 'OVERLAY';
    text.font = FIELD_TEXT;
    text.setSize(width - 32, 16).setAnchors({
      point: 'LEFT',
      relativeTo: id,
      relativePoint: 'LEFT',
      x: 16,
      y: 0,
    });

    return box;
  }

  /** What the Login button and Enter both do. */
  private submit(): void {
    const ctx = this.ctx;
    if (!ctx || !this.account || !this.password || !this.server) {
      return;
    }

    const account = this.account.text.trim();
    const password = this.password.text;
    if (!account || !password) {
      return;
    }

    const [host, port] = this.server.text.split(':');
    saveSettings({
      ...loadSettings(),
      logonHost: host,
      logonPort: Number(port) || loadSettings().logonPort,
      savedAccount: this.saveName?.checked ? account : undefined,
    });

    void ctx.protocol.login(account, password).catch(() => undefined);
  }

  update(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    // Mirror both boxes into their font strings; the widget layer masks the password itself.
    if (this.account && this.accountText) {
      this.accountText.text = this.account.text;
    }
    if (this.password && this.passwordText) {
      this.passwordText.text = this.password.displayText;
    }
    if (this.server && this.serverText) {
      this.serverText.text = this.server.text;
    }

    if (this.saveName) {
      this.saveName.sprite = this.saveName.checked ? 'check-mark' : 'check-up';
    }

    if (this.loginButton) {
      this.loginButton.sprite =
        this.loginButton.state === 'down'
          ? 'button-down'
          : this.loginButton.hovered
            ? 'button-highlight'
            : 'button-up';
      this.loginButton.blend = this.loginButton.hovered ? 'ADD' : 'ALPHA';
    }

    const dialog = loginDialog(ctx.protocol.stage, ctx.protocol.lastRefusal);
    if (this.dialog && this.dialogText) {
      if (dialog.kind === 'none') {
        this.dialog.hide();
      } else {
        this.dialog.show();
        this.dialogText.text =
          dialog.kind === 'connecting'
            ? ctx.strings.get('LOGIN_STATE_CONNECTING')
            : ctx.strings.get(dialog.stringKey);
      }
    }
  }

  unmount(): void {
    this.ctx = null;
    this.account = null;
    this.accountText = null;
    this.password = null;
    this.passwordText = null;
    this.server = null;
    this.serverText = null;
    this.saveName = null;
    this.loginButton = null;
    this.loginCaption = null;
    this.dialog = null;
    this.dialogText = null;
  }
}
