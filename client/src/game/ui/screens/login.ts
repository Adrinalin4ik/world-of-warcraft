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

/**
 * `GlueFontNormal`: Friz Quadrata, outlined, colour r=1.0 g=0.78 b=0 -> `#ffc700`
 * (gluefontstyles.xml:14-22). NOT `#ffd100` -- that is FrameXML's `NORMAL_FONT_COLOR` (1.0, 0.82, 0),
 * a different table for a different UI. The client also draws a 1,-1 black shadow under this font;
 * `FontSpec` has no shadow channel (only the outline ring), so the shadow is not reproduced.
 */
const LABEL: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffc700',
  outline: true,
  align: 'LEFT',
};

/** `GlueFontNormal`, centered -- what the button captions and the box captions both use. */
const LABEL_CENTER: FontSpec = { ...LABEL, align: 'CENTER' };
const BUTTON_CAPTION: FontSpec = LABEL_CENTER;
const FIELD_TEXT: FontSpec = { ...LABEL, color: '#ffffff' };

/**
 * `GlueFontNormalSmall`: `SystemFont_Shadow_Outline_Med1` in the same `#ffc700`
 * (gluefontstyles.xml:65-67). The version block and the Blizzard disclaimer both inherit it as-is.
 */
const LABEL_SMALL: FontSpec = { ...LABEL, size: 12 };

/**
 * `GlueFontNormalSmall` overridden with FontHeight 10 and its colour restated as r=1.0 g=0.78 b=0
 * (accountlogin.xml:530-548) -- the same `#ffc700`, spelled out again in the FontString itself.
 */
const SAVE_NAME_LABEL: FontSpec = { ...LABEL, size: 10, align: 'LEFT' };

/**
 * `GlueFontDisableSmall`: `GlueFontNormalSmall` recoloured r=g=b=0.5 -> `#808080`
 * (gluefontstyles.xml:84-86), so it keeps that font's outline ring. `justifyV="MIDDLE"` is the one
 * part not representable -- `FontSpec#align` is horizontal only.
 */
const PLACEHOLDER_TEXT: FontSpec = { ...LABEL, size: 12, color: '#808080' };

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
  private saveNameCheck: Widget | null = null;
  private saveNameHighlight: Widget | null = null;
  private loginButton: Widget | null = null;
  private loginCaption: Widget | null = null;
  private loginHighlight: Widget | null = null;
  private quitButton: Widget | null = null;
  private quitCaption: Widget | null = null;
  private quitHighlight: Widget | null = null;
  private dialog: Widget | null = null;
  private dialogText: Widget | null = null;
  /** Last frame's dialog visibility, so focus moves on the EDGE rather than every frame. */
  private dialogShown = false;

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
    // `AccountLoginLogo` is authored on OVERLAY (accountlogin.xml:128-141), above the ARTWORK layer the
    // Blizzard logo and the version block sit on.
    logo.layer = 'OVERLAY';
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
    // BACKGROUND, as authored: the box's own layers sit above its Backdrop, and this caption overlaps
    // the top of the box by 23 units, which is why the two orders are distinguishable at all.
    accountLabel.layer = 'BACKGROUND';
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
    this.accountFill.layer = 'BACKGROUND';
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
    passwordLabel.layer = 'BACKGROUND'; // as authored (accountlogin.xml:248-262)
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
    serverLabel.layer = 'BACKGROUND'; // the same layer the two authored captions use
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

    // `HighlightTexture ... alphaMode="ADD"` OVERLAYS the normal texture (gluebuttons.xml,
    // `GlueButtonTemplateBlue`); replacing the button art with the glow alone lost the button.
    this.loginHighlight = this.overlay(
      this.loginButton,
      'login-login-highlight',
      'button-highlight',
      220,
      45,
      'ADD',
    );

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

    // The authored CheckButton draws its `CheckedTexture` (`UI-CheckBox-Check`) ON TOP of the
    // `NormalTexture` frame, and its `HighlightTexture` on ADD on top of both
    // (accountlogin.xml:579-583) -- not instead of them. Swapping the parent's sprite showed a bare
    // tick with no frame, so both are child quads: same layer as the parent, later in insertion order,
    // which is how this widget layer stacks siblings.
    this.saveNameCheck = this.overlay(this.saveName, 'login-save-name-check', 'check-mark', 20, 20);
    this.saveNameHighlight = this.overlay(
      this.saveName,
      'login-save-name-highlight',
      'check-highlight',
      20,
      20,
      'ADD',
    );

    // Quit button: 150x38 at BOTTOMRIGHT -5,29 (accountlogin.xml, GlueButtonSmallTemplateBlue). There
    // is no browser tab for it to close -- it is authored, so it is drawn, but its click is a no-op.
    this.quitButton = root.add(new Widget('button', 'login-quit'));
    this.quitButton.layer = 'ARTWORK';
    this.quitButton.sprite = 'button-small-up';
    this.quitButton.mouseEnabled = true;
    this.quitButton.focusable = true;
    this.quitButton.setSize(150, 38).setAnchors({ point: 'BOTTOMRIGHT', x: -5, y: 29 });
    this.quitButton.onClick = () => undefined; // no browser tab for this button to close

    this.quitHighlight = this.overlay(
      this.quitButton,
      'login-quit-highlight',
      'button-small-highlight',
      150,
      38,
      'ADD',
    );

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

    // These three are all on ARTWORK and the disclaimer sits INSIDE the logo's 100x100 box, so the
    // order they are added in is the order they draw in. The client's ARTWORK layer lists the logo
    // first, then the disclaimer, then the version (accountlogin.xml:96-127) -- built the other way
    // round, the logo covers the disclaimer.

    // Blizzard logo: 100x100 at BOTTOM +8 (accountlogin.xml:96-107) -- bottom-CENTER, not bottom-right,
    // and much smaller than this screen first drew it.
    const blizzard = root.add(new Widget('texture', 'login-blizzard'));
    blizzard.layer = 'ARTWORK';
    blizzard.sprite = 'blizzard-logo';
    blizzard.setSize(100, 100).setAnchors({ point: 'BOTTOM', x: 0, y: 8 });

    // `BLIZZ_DISCLAIMER` at BOTTOM y=10 (accountlogin.xml:108-116). The authored FontString carries no
    // Size and sizes itself to its text; a widget here needs a rect, so it gets a wide centered one --
    // the renderer draws the string at its measured size inside it rather than stretching to fill.
    const disclaimer = root.add(new Widget('fontstring', 'login-disclaimer'));
    disclaimer.layer = 'ARTWORK';
    disclaimer.font = { ...LABEL_SMALL, align: 'CENTER' };
    disclaimer.text = ctx.strings.get('BLIZZ_DISCLAIMER');
    disclaimer.setSize(600, 14).setAnchors({ point: 'BOTTOM', x: 0, y: 10 });

    // `AccountLoginVersion`: BOTTOMLEFT x=0 y=10, GlueFontNormalSmall justifyH="LEFT"
    // (accountlogin.xml:117-127). The client fills the text from `GetBuildInfo()`; there is no build
    // info to read here, so the WORDING is OURS -- a literal, not an invented GlueStrings key.
    const version = root.add(new Widget('fontstring', 'login-version'));
    version.layer = 'ARTWORK';
    version.font = LABEL_SMALL;
    version.text = 'Version 3.3.5 (12340)';
    version.setSize(300, 14).setAnchors({ point: 'BOTTOMLEFT', x: 0, y: 10 });

    // The one dialog, reused for connecting and for a refusal.
    this.dialog = root.add(new Widget('backdrop', 'login-dialog'));
    this.dialog.layer = 'DIALOG';
    this.dialog.sprite = 'dialog-background';
    this.dialog.mouseEnabled = true;
    // Focusable so Escape can reach `onCancel` at all -- `input.ts` routes Escape to the FOCUSED
    // widget, and a dialog that never takes focus has a dead cancel handler however it is written.
    this.dialog.focusable = true;
    this.dialog.setSize(400, 140).setAnchors({ point: 'CENTER', x: 0, y: 0 });
    this.dialog.hide();
    // Dismissing has to clear the SESSION's state, not just hide the widget: `update()` re-derives the
    // dialog from `protocol.stage`/`lastRefusal` every frame, so a hidden widget came straight back on
    // the next one -- and this quad is `mouseEnabled` and covers the account box, so after "Unknown
    // account" the player could not edit the account name at all.
    this.dialog.onCancel = () => this.ctx?.protocol.dismiss();
    this.dialog.onClick = () => this.ctx?.protocol.dismiss();

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

  /**
   * A texture the client authors ON TOP of a control's normal art -- a `CheckedTexture`, or a
   * `HighlightTexture` on ADD. Starts hidden; `update()` shows it when its condition holds. Same layer
   * as the parent, so sibling insertion order puts it above the parent's own quad.
   */
  private overlay(
    parent: Widget,
    id: string,
    sprite: string,
    width: number,
    height: number,
    blend: 'ALPHA' | 'ADD' = 'ALPHA',
  ): Widget {
    const texture = parent.add(new Widget('texture', id));
    texture.layer = parent.layer;
    texture.sprite = sprite;
    texture.blend = blend;
    texture.setSize(width, height).setAnchors({
      point: 'CENTER',
      relativeTo: parent.id,
      relativePoint: 'CENTER',
      x: 0,
      y: 0,
    });
    texture.hide();
    return texture;
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
    // BACKGROUND, because a FrameXML `Backdrop` draws BENEATH every layer of its own frame -- including
    // the BACKGROUND FontStrings this box carries (its caption and `$parentFill`). Our layer ladder is
    // flat, so the stand-in quad expresses that by sitting on BACKGROUND ahead of them in insertion
    // order, which is what keeps the placeholder visible on top of the border instead of behind it.
    box.layer = 'BACKGROUND';
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

    const current = loadSettings();
    const [typedHost, typedPort] = this.server.text.split(':');
    const endpoint = {
      host: typedHost.trim() || current.logonHost,
      port: Number(typedPort) || current.logonPort,
    };

    saveSettings({
      ...current,
      logonHost: endpoint.host,
      logonPort: endpoint.port,
      savedAccount: this.saveName?.checked ? account : undefined,
    });

    // The endpoint travels WITH the attempt. Saving it is a preference; passing it is what makes this
    // client reach a server other than the one baked into `network/config`, which is the whole point of
    // the field -- and it has to be read here, at submit time, because the player can edit it until then.
    void ctx.protocol.login(account, password, endpoint).catch(() => undefined);
  }

  private setShown(widget: Widget | null, shown: boolean): void {
    if (!widget) {
      return;
    }
    if (shown) {
      widget.show();
    } else {
      widget.hide();
    }
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

    // Normal/Pushed swap on the control itself; Checked and Highlight are separate quads on top, which
    // is how the client authors all three (accountlogin.xml:579-583, gluebuttons.xml).
    if (this.saveName) {
      this.saveName.sprite = this.saveName.state === 'down' ? 'check-down' : 'check-up';
      this.setShown(this.saveNameCheck, this.saveName.checked);
      this.setShown(this.saveNameHighlight, this.saveName.hovered);
    }

    if (this.loginButton) {
      this.loginButton.sprite =
        this.loginButton.state === 'down'
          ? 'button-down'
          : this.loginButton.state === 'disabled'
            ? 'button-disabled'
            : 'button-up';
      this.setShown(this.loginHighlight, this.loginButton.hovered);
    }

    if (this.quitButton) {
      this.quitButton.sprite =
        this.quitButton.state === 'down'
          ? 'button-small-down'
          : this.quitButton.state === 'disabled'
            ? 'button-small-disabled'
            : 'button-small-up';
      this.setShown(this.quitHighlight, this.quitButton.hovered);
    }

    const dialog = loginDialog(ctx.protocol.stage, ctx.protocol.lastRefusal, ctx.protocol.retrying);
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

      // On the frame it appears, the dialog takes focus so Escape dismisses it; when it goes, focus
      // returns to the box the player will type in next. Edge-triggered, or this would fight the
      // player's own Tab and clicks every frame.
      const shown = dialog.kind !== 'none';
      if (shown !== this.dialogShown) {
        this.dialogShown = shown;
        ctx.input.setFocus(shown ? this.dialog : this.account);
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
    this.saveNameCheck = null;
    this.saveNameHighlight = null;
    this.loginButton = null;
    this.loginCaption = null;
    this.loginHighlight = null;
    this.quitButton = null;
    this.quitCaption = null;
    this.quitHighlight = null;
    this.dialog = null;
    this.dialogText = null;
    this.dialogShown = false;
  }
}
