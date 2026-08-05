/**
 * The `AccountLogin` screen, transcribed from `interface/gluexml/accountlogin.xml`.
 *
 * Coordinates are the client's own: logo `TOPLEFT` x=3 y=-7 at 256x128; account edit box 200x37 at
 * `BOTTOM` +345, letters=320, with a 600x64 `ACCOUNT_NAME` caption anchored `BOTTOM`-to-`TOP` y=-23
 * and an `ENTER_EMAIL` placeholder shown only while empty; password edit box 200x37 at `BOTTOM` +275,
 * letters=16, masked, with a 256x64 `PASSWORD` caption in the same idiom; Login button 220x45 (an
 * explicit override of its `GlueButtonTemplateBlue` base) at `BOTTOM` +170; Save Account Name label
 * anchored `TOP`-to-Login-button's-`BOTTOM` x=10 y=0, with its 20x20 checkbox anchored `RIGHT`-to-the-
 * label's-`LEFT`; Quit button 150x38 at `BOTTOMRIGHT` x=-5 y=29; Blizzard logo 100x100 at `BOTTOM`
 * y=8. The reference screen's Credits, Cinematics, TOS, survey, token and account-management
 * controls are deliberately absent -- they do not serve logging in (benilla cut the same set).
 *
 * The server address field is OURS, not the client's: the real client reads `realmlist.wtf`, and this
 * one targets any private server, so the address has to be reachable from the screen. It is drawn in
 * the authored idiom (200x37 box, caption above, anchored `BOTTOM` +215 -- the one free slot between
 * the password box and the Login button) but it is not authored -- do not cite it as reference
 * fidelity. Its caption has no honest `GlueStrings` key (nothing in the client names a server-address
 * field), so it is a plain literal string rather than an invented key -- the same treatment the
 * version string below already gets.
 */
import {
  applyRealmlistOverride,
  loadSettings,
  saveSettings,
} from '../../../network/protocol/connection-settings';
import { GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';
import { loginDialog, wantsTrialScene } from './login-state';
import { LOGIN_ART } from './login-art';

/** `GlueFontNormal` in the client: Friz Quadrata, gold, outlined. */
const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffd100',
  outline: true,
  align: 'LEFT',
};

/** `GlueFontNormal`, centered -- what the button captions and the box captions both use. */
const LABEL_CENTER: FontSpec = { ...LABEL, align: 'CENTER' };
const BUTTON_CAPTION: FontSpec = LABEL_CENTER;
const FIELD_TEXT: FontSpec = { ...LABEL, color: '#ffffff' };

/**
 * `GlueFontNormalSmall` at FontHeight 10, colour r=1.0 g=0.78 b=0 (accountlogin.xml:530-537). The
 * client also draws a 1,-1 black shadow on this font; `FontSpec` has no shadow channel (only the
 * outline ring `FontSpec#outline` draws), so the shadow is not reproduced here.
 */
const SAVE_NAME_LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 10,
  color: '#ffc700',
  outline: false,
  align: 'LEFT',
};

/**
 * `GlueFontDisableSmall`, approximated: the client authors this as a dim, non-outlined font for
 * disabled/placeholder text (accountlogin.xml:180-188 names the font but not an exact colour), so
 * `#7f7f7f` stands in for "greyed out" rather than transcribing a value that isn't given. `justifyV
 * ="MIDDLE"` is also not representable -- `FontSpec#align` is horizontal only.
 */
const PLACEHOLDER_TEXT: FontSpec = {
  family: 'FRIZQT',
  size: 12,
  color: '#7f7f7f',
  outline: false,
  align: 'LEFT',
};

export class LoginScreen implements GlueScreen {
  private ctx: GlueContext | null = null;

  private account: Widget | null = null;
  private accountText: Widget | null = null;
  private accountFill: Widget | null = null;
  private password: Widget | null = null;
  private passwordText: Widget | null = null;
  private server: Widget | null = null;
  private serverText: Widget | null = null;
  private saveName: Widget | null = null;
  private loginButton: Widget | null = null;
  private loginCaption: Widget | null = null;
  private quitButton: Widget | null = null;
  private quitCaption: Widget | null = null;
  private dialog: Widget | null = null;
  private dialogText: Widget | null = null;

  mount(ctx: GlueContext): void {
    this.ctx = ctx;
    ctx.art.registerAll(LOGIN_ART);
    void ctx.art.load();

    // The login stage: the Wrath causeway unless this is a trial account. The client's real condition
    // is `IsStreamingTrial()`; the URL is a debug stand-in until there is an account to read the flag
    // from.
    ctx.setScene({ kind: 'mainmenu', streamingTrial: wantsTrialScene(window.location.search) });

    const root = ctx.root.root;
    const settings = applyRealmlistOverride(loadSettings(), window.location.search);

    const logo = root.add(new Widget('texture', 'login-logo'));
    logo.layer = 'ARTWORK';
    logo.sprite = 'logo';
    logo.setSize(256, 128).setAnchors({ point: 'TOPLEFT', x: 3, y: -7 });

    // Account box: 200x37 at BOTTOM +345, letters=320 (accountlogin.xml:157-165).
    this.account = this.field(root, 'login-account', 'login-account-text', 200, 37, 345, 320);
    this.accountText = this.account.children[0];
    this.accountText.text = settings.savedAccount ?? '';
    this.account.text = this.accountText.text;
    this.account.caret = this.account.text.length;

    // The box's own caption -- a separate FontString, not the typed-value mirror above
    // (accountlogin.xml:167-179).
    const accountLabel = root.add(new Widget('fontstring', 'login-account-label'));
    accountLabel.layer = 'OVERLAY';
    accountLabel.font = LABEL_CENTER;
    accountLabel.text = ctx.strings.get('ACCOUNT_NAME');
    accountLabel.setSize(600, 64).setAnchors({
      point: 'BOTTOM',
      relativeTo: 'login-account',
      relativePoint: 'TOP',
      x: 0,
      y: -23,
    });

    // `$parentFill`: shown only while the account box is empty (accountlogin.xml:180-188; the client
    // hides it in `OnTextChanged`). Driven from `this.account.text` in `update()`.
    this.accountFill = this.account.add(new Widget('fontstring', 'login-account-fill'));
    this.accountFill.layer = 'OVERLAY';
    this.accountFill.font = PLACEHOLDER_TEXT;
    this.accountFill.text = ctx.strings.get('ENTER_EMAIL');
    this.accountFill.setSize(200 - 32, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-account',
      relativePoint: 'CENTER',
      x: 0,
      y: 3,
    });

    // Password box: 200x37 at BOTTOM +275, letters=16, masked (accountlogin.xml:239-247).
    this.password = this.field(root, 'login-password', 'login-password-text', 200, 37, 275, 16);
    this.passwordText = this.password.children[0];
    this.password.password = true;

    const passwordLabel = root.add(new Widget('fontstring', 'login-password-label'));
    passwordLabel.layer = 'OVERLAY';
    passwordLabel.font = LABEL_CENTER;
    passwordLabel.text = ctx.strings.get('PASSWORD');
    passwordLabel.setSize(256, 64).setAnchors({
      point: 'BOTTOM',
      relativeTo: 'login-password',
      relativePoint: 'TOP',
      x: 0,
      y: -23,
    });

    // The server address. Ours, not the client's -- see the file comment. Same idiom as the two
    // authored boxes above (200x37, captioned above it), at the one free slot between the password
    // box and the Login button.
    this.server = this.field(root, 'login-server', 'login-server-text', 200, 37, 215, 64);
    this.serverText = this.server.children[0];
    this.server.text = `${settings.logonHost}:${settings.logonPort}`;
    this.serverText.text = this.server.text;

    const serverLabel = root.add(new Widget('fontstring', 'login-server-label'));
    serverLabel.layer = 'OVERLAY';
    serverLabel.font = LABEL_CENTER;
    // OURS: no honest GlueStrings key names a server-address field -- see the file comment.
    serverLabel.text = 'Server Address';
    // 64 tall, like the authored captions: the renderer centres a font string vertically in its rect,
    // so a 16-tall rect at the same -23 offset lands the text inside the box instead of above it.
    serverLabel.setSize(200, 64).setAnchors({
      point: 'BOTTOM',
      relativeTo: 'login-server',
      relativePoint: 'TOP',
      x: 0,
      y: -23,
    });

    // Login button: 220x45 at BOTTOM +170. `GlueButtonTemplateBlue` is 170x45, but
    // AccountLoginLoginButton overrides it with an explicit 220x45 (accountlogin.xml:385-392).
    this.loginButton = root.add(new Widget('button', 'login-login'));
    this.loginButton.layer = 'ARTWORK';
    this.loginButton.sprite = 'button-up';
    this.loginButton.mouseEnabled = true;
    this.loginButton.focusable = true;
    this.loginButton.setSize(220, 45).setAnchors({ point: 'BOTTOM', x: 0, y: 170 });
    this.loginButton.onClick = () => this.submit();

    this.loginCaption = this.loginButton.add(new Widget('fontstring', 'login-login-text'));
    this.loginCaption.layer = 'OVERLAY';
    this.loginCaption.font = BUTTON_CAPTION;
    this.loginCaption.text = ctx.strings.get('LOGIN');
    this.loginCaption.setSize(220, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-login',
      relativePoint: 'CENTER',
      x: 0,
      y: 3, // the template's ButtonText offset
    });

    // Save Account Name: the label anchors TOP to the Login button's BOTTOM (accountlogin.xml:
    // 530-537); the 20x20 checkbox anchors RIGHT to the label's LEFT (accountlogin.xml:551-558). Not
    // beside the account box -- that was this screen's own earlier mistake, not the client's layout.
    const saveLabel = root.add(new Widget('fontstring', 'login-save-name-text'));
    saveLabel.layer = 'OVERLAY';
    saveLabel.font = SAVE_NAME_LABEL;
    saveLabel.text = ctx.strings.get('SAVE_ACCOUNT_NAME');
    saveLabel.setSize(200, 14).setAnchors({
      point: 'TOP',
      relativeTo: 'login-login',
      relativePoint: 'BOTTOM',
      x: 10,
      y: 0,
    });

    this.saveName = root.add(new Widget('checkbutton', 'login-save-name'));
    this.saveName.layer = 'ARTWORK';
    this.saveName.sprite = 'check-up';
    this.saveName.mouseEnabled = true;
    this.saveName.checked = Boolean(settings.savedAccount);
    this.saveName.setSize(20, 20).setAnchors({
      point: 'RIGHT',
      relativeTo: 'login-save-name-text',
      relativePoint: 'LEFT',
      x: 0,
      y: 0,
    });
    this.saveName.onClick = () => undefined; // the router toggles `checked` itself

    // Quit button: 150x38 at BOTTOMRIGHT -5,29 (accountlogin.xml, GlueButtonSmallTemplateBlue). There
    // is no browser tab for it to close -- it is authored, so it is drawn, but its click is a no-op.
    this.quitButton = root.add(new Widget('button', 'login-quit'));
    this.quitButton.layer = 'ARTWORK';
    this.quitButton.sprite = 'button-small-up';
    this.quitButton.mouseEnabled = true;
    this.quitButton.focusable = true;
    this.quitButton.setSize(150, 38).setAnchors({ point: 'BOTTOMRIGHT', x: -5, y: 29 });
    this.quitButton.onClick = () => undefined; // no browser tab for this button to close

    this.quitCaption = this.quitButton.add(new Widget('fontstring', 'login-quit-text'));
    this.quitCaption.layer = 'OVERLAY';
    this.quitCaption.font = BUTTON_CAPTION;
    this.quitCaption.text = ctx.strings.get('QUIT');
    this.quitCaption.setSize(150, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-quit',
      relativePoint: 'CENTER',
      x: 0,
      y: 3, // the template's ButtonText offset
    });

    const version = root.add(new Widget('fontstring', 'login-version'));
    version.layer = 'OVERLAY';
    version.font = { ...LABEL, size: 12 };
    version.text = 'Version 3.3.5 (12340)';
    version.setSize(300, 14).setAnchors({ point: 'BOTTOMLEFT', x: 10, y: 10 });

    // Blizzard logo: 100x100 at BOTTOM +8, ARTWORK (accountlogin.xml:96-109) -- bottom-CENTER, not
    // bottom-right, and much smaller than this screen first drew it.
    const blizzard = root.add(new Widget('texture', 'login-blizzard'));
    blizzard.layer = 'ARTWORK';
    blizzard.sprite = 'blizzard-logo';
    blizzard.setSize(100, 100).setAnchors({ point: 'BOTTOM', x: 0, y: 8 });

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

    // `AccountLogin_OnShow` (accountlogin.lua:67-72): the account box when there is no saved name, the
    // PASSWORD box when a name was restored -- the only field left to fill in. Safe only now that Enter
    // and a pointer click are separate hooks; before that, focusing a box armed the submit.
    ctx.input.setFocus(settings.savedAccount ? this.password : this.account);
  }

  /** One edit box plus its text, at an authored size, `BOTTOM` offset and letter cap. */
  private field(
    root: Widget,
    id: string,
    textId: string,
    width: number,
    height: number,
    bottomOffset: number,
    maxLetters: number,
  ): Widget {
    const box = root.add(new Widget('editbox', id));
    box.layer = 'ARTWORK';
    // The authored control is a 9-slice `Backdrop`: bg `Interface\Tooltips\UI-Tooltip-Background`
    // tiled at 16, edge `Interface\Glues\Common\Glue-Tooltip-Border` at edgeSize 16, background
    // insets left 10 right 5 top 4 bottom 9 (accountlogin.xml:190-201). Our widget layer's `backdrop`
    // kind has no 9-slice renderer yet, so this single stretched `Common-Input-Border` quad is a
    // STAND-IN we invented for this screen -- it is not the client's own art, and is a follow-up to
    // replace once 9-slice backdrops exist.
    box.sprite = 'input-border';
    box.mouseEnabled = true;
    box.focusable = true;
    box.maxLetters = maxLetters;
    box.setSize(width, height).setAnchors({ point: 'BOTTOM', x: 0, y: bottomOffset });
    // `OnEnterPressed` -> `AccountLogin_Login()` (accountlogin.xml). `onSubmit`, NOT `onClick`: the
    // pointer handler must only take focus, or clicking back into a box to fix a typo submits the typo.
    box.onSubmit = () => this.submit();

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

    // `$parentFill`: hidden as soon as there is anything typed (accountlogin.xml's `OnTextChanged`).
    if (this.account && this.accountFill) {
      if (this.account.text.length > 0) {
        this.accountFill.hide();
      } else {
        this.accountFill.show();
      }
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

    if (this.quitButton) {
      this.quitButton.sprite =
        this.quitButton.state === 'down'
          ? 'button-small-down'
          : this.quitButton.hovered
            ? 'button-small-highlight'
            : 'button-small-up';
      this.quitButton.blend = this.quitButton.hovered ? 'ADD' : 'ALPHA';
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
    this.accountFill = null;
    this.password = null;
    this.passwordText = null;
    this.server = null;
    this.serverText = null;
    this.saveName = null;
    this.loginButton = null;
    this.loginCaption = null;
    this.quitButton = null;
    this.quitCaption = null;
    this.dialog = null;
    this.dialogText = null;
  }
}
