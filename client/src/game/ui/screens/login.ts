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
import { BackdropDef } from '../backdrop';
import { GlueContext, GlueScreen } from '../screens';
import { caretOffset, measureText } from '../text';
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

/**
 * `GlueEditBoxFont`: `EditBoxFont_Large` recoloured r=g=b=1.0 (gluefontstyles.xml:126-128), and
 * `EditBoxFont_Large` is `Fonts\ARIALN.TTF` at FontHeight 16 with no outline and no shadow
 * (gluefonts.xml:76-80). Not the `GlueFontNormal` face the rest of this screen uses: the client
 * deliberately puts typed input in narrow Arial, which is why a 320-letter account name fits a
 * 200-wide box at all.
 */
const FIELD_TEXT: FontSpec = {
  family: 'ARIALN',
  size: 16,
  color: '#ffffff',
  outline: false,
  align: 'LEFT',
};

/**
 * `GlueFontNormalLarge`: `SystemFont_Shadow_Outline_Large` -- FRIZQT, outlined, FontHeight 18
 * (gluefonts.xml:53-63) -- with `spacing="2"` and colour r=1.0 g=0.78 b=0 -> `#ffc700`
 * (gluefontstyles.xml:97-99). `GlueDialogText` inherits it and is 450 wide (gluedialog.xml), so this
 * is the one font string on the screen that WRAPS.
 */
const DIALOG_TEXT: FontSpec = {
  family: 'FRIZQT',
  size: 18,
  color: '#ffc700',
  outline: true,
  align: 'CENTER',
  wrapWidth: 450,
  spacing: 2,
};

/**
 * The edit boxes' authored `Backdrop` (accountlogin.xml:190-201; the password box repeats it
 * verbatim, and the server box borrows the same idiom). Sprite KEYS -- the paths are in
 * `login-art.ts`.
 */
const EDITBOX_BACKDROP: BackdropDef = {
  bgSprite: 'editbox-bg',
  edgeSprite: 'editbox-edge',
  edgeSize: 16,
  tileSize: 16,
  backgroundInsets: { left: 10, right: 5, top: 4, bottom: 9 },
};

/** `TextInsets` on all three authored edit boxes: left 12, right 5, bottom 5 -- and NO top inset
 * (accountlogin.xml:235-237). The missing top is the whole point: the text is not centred in the
 * box, it is centred in the box shrunk from the bottom only, so it rides slightly high. */
const FIELD_TEXT_INSETS = { left: 12, right: 5, top: 0, bottom: 5 };

/** `GlueDialogBackground`'s authored `Backdrop` (gluedialog.xml). */
const DIALOG_BACKDROP: BackdropDef = {
  bgSprite: 'dialog-bg',
  edgeSprite: 'dialog-edge',
  edgeSize: 32,
  tileSize: 32,
  backgroundInsets: { left: 11, right: 12, top: 12, bottom: 11 },
};

/** `GlueDialogBackground` is 512x256, and `origWidth` -- the width it keeps for every dialog that is
 * not a `showAlert` type (gluedialog.lua:637-638; `alertWidth` 600 is for those, and none of ours
 * are). The HEIGHT is recomputed from the content -- see `dialogHeight`. */
const DIALOG_WIDTH = 512;
/** `GlueDialogText` is anchored `TOP` with offset y=-16 (gluedialog.xml). */
const DIALOG_TEXT_OFFSET = 16;
/** `GlueDialogButtonTemplate` is 220x40 (gluedialog.xml), anchored `BOTTOM` to the background's
 * `BOTTOM` with offset y=16 in the single-button branch (gluedialog.lua:562). */
const DIALOG_BUTTON_WIDTH = 220;
const DIALOG_BUTTON_HEIGHT = 40;
const DIALOG_BUTTON_OFFSET = 16;

/**
 * `GlueDialogBackground:SetHeight(32 + GlueDialogText:GetHeight() + 8 + GlueDialogButton1:GetHeight()
 * + 16)` -- gluedialog.lua:677, the `UPDATE_STATUS_DIALOG` path.
 *
 * That path, not `GlueDialog_Show`'s (line 626, which leads with 16 rather than 32), because it is
 * the one that actually sizes these dialogs. Both `GlueDialogTypes["CANCEL"]` and `["OKAY"]` are
 * authored with `text = ""` (gluedialog.lua:162-190), so at `GlueDialog_Show` time there is no text
 * to measure and the height that matters is the one recomputed when the status text arrives. Ours
 * arrives the same way: `update()` sets it from the session's stage every frame.
 */
function dialogHeight(textHeight: number): number {
  return 32 + textHeight + 8 + DIALOG_BUTTON_HEIGHT + DIALOG_BUTTON_OFFSET;
}

/**
 * The caret, both OURS. The client's own is drawn by the engine with no XML behind it, so there is
 * nothing to cite and nothing here claims otherwise: a one-unit bar, lit for half a second and dark
 * for half a second.
 */
const CARET_WIDTH = 1;
const CARET_BLINK_SECONDS = 0.5;

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
  private dialogButton: Widget | null = null;
  private dialogButtonCaption: Widget | null = null;
  private dialogHighlight: Widget | null = null;
  /** Last frame's dialog visibility, so focus moves on the EDGE rather than every frame. */
  private dialogShown = false;
  /** Which dialog is showing, so the one button knows what it does -- see `dialogAction`. */
  private dialogKind: 'none' | 'connecting' | 'error' = 'none';
  /** Seconds since mount, for the caret blink. */
  private caretClock = 0;

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
    // The SMALL template's caption font: `GlueButtonSmallTemplateBlue` authors
    // `NormalFont style="GlueFontNormalSmall"` (gluebuttons.xml:121), where the full-size
    // `GlueButtonTemplateBlue` authors `GlueFontNormal`. Same colour, smaller face.
    this.quitCaption.font = { ...LABEL_SMALL, align: 'CENTER' };
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
    // first, then the disclaimer, then the version (accountlogin.xml:98-127) -- built the other way
    // round, the logo covers the disclaimer.

    // Blizzard logo: 100x100 at BOTTOM +8 (accountlogin.xml:98-109) -- bottom-CENTER, not bottom-right,
    // and much smaller than this screen first drew it.
    const blizzard = root.add(new Widget('texture', 'login-blizzard'));
    blizzard.layer = 'ARTWORK';
    blizzard.sprite = 'blizzard-logo';
    blizzard.setSize(100, 100).setAnchors({ point: 'BOTTOM', x: 0, y: 8 });

    // `BLIZZ_DISCLAIMER` at BOTTOM y=10 (accountlogin.xml:110-118). The authored FontString carries no
    // Size and sizes itself to its text; a widget here needs a rect, so it gets a wide centered one --
    // the renderer draws the string at its measured size inside it rather than stretching to fill.
    const disclaimer = root.add(new Widget('fontstring', 'login-disclaimer'));
    disclaimer.layer = 'ARTWORK';
    disclaimer.font = { ...LABEL_SMALL, align: 'CENTER' };
    disclaimer.text = ctx.strings.get('BLIZZ_DISCLAIMER');
    disclaimer.setSize(600, 14).setAnchors({ point: 'BOTTOM', x: 0, y: 10 });

    // `AccountLoginVersion`: BOTTOMLEFT x=0 y=10, GlueFontNormalSmall justifyH="LEFT"
    // (accountlogin.xml:119-127). The client fills the text from `GetBuildInfo()`; there is no build
    // info to read here, so the WORDING is OURS -- a literal, not an invented GlueStrings key.
    const version = root.add(new Widget('fontstring', 'login-version'));
    version.layer = 'ARTWORK';
    version.font = LABEL_SMALL;
    version.text = 'Version 3.3.5 (12340)';
    version.setSize(300, 14).setAnchors({ point: 'BOTTOMLEFT', x: 0, y: 10 });

    // `GlueDialog` (gluedialog.xml), reused for connecting and for a refusal -- the client reuses the
    // one dialog for every type too. `GlueDialogBackground` is 512 wide at CENTER with the authored
    // `Backdrop`; the height is recomputed from the text in `update()` (`dialogHeight`).
    this.dialog = root.add(new Widget('backdrop', 'login-dialog'));
    // DIALOG is a frame STRATA, not a draw layer -- it outranks every layer of every MEDIUM frame,
    // which is what puts this panel over the whole screen rather than merely over its own siblings.
    this.dialog.strata = 'DIALOG';
    this.dialog.layer = 'BACKGROUND';
    this.dialog.backdrop = DIALOG_BACKDROP;
    // `enableMouse="true"` on the authored frame. It has to stay on for a reason beyond fidelity:
    // this quad covers the account box, and without it clicks would fall THROUGH the dialog to the
    // box behind it. There is deliberately no `onClick` here -- the client's dialog is dismissed by
    // its button, not by a click anywhere on the frame.
    this.dialog.mouseEnabled = true;
    // Focusable so Escape can reach `onCancel` at all -- `input.ts` routes Escape to the FOCUSED
    // widget, and a dialog that never takes focus has a dead cancel handler however it is written.
    this.dialog.focusable = true;
    this.dialog.setSize(DIALOG_WIDTH, dialogHeight(0)).setAnchors({ point: 'CENTER', x: 0, y: 0 });
    this.dialog.hide();
    // Escape does what the one button does, which is what `GlueDialog_OnKeyDown` does for a
    // single-button dialog.
    this.dialog.onCancel = () => this.dialogAction();

    // `GlueDialogText`: `GlueFontNormalLarge`, 450 wide, anchored TOP y=-16, and it WRAPS -- which is
    // the fix for a long refusal (`RESPONSE_FAILED_TO_CONNECT` is three sentences) previously drawn as
    // one line off both edges of the screen. Height is set from the measurement in `update()`.
    this.dialogText = this.dialog.add(new Widget('fontstring', 'login-dialog-text'));
    // Inherits the DIALOG strata from `this.dialog`; the layer is its own, same as any plain caption.
    this.dialogText.layer = 'ARTWORK';
    this.dialogText.font = DIALOG_TEXT;
    this.dialogText.setSize(DIALOG_TEXT.wrapWidth!, DIALOG_TEXT.size).setAnchors({
      point: 'TOP',
      relativeTo: 'login-dialog',
      relativePoint: 'TOP',
      x: 0,
      y: -DIALOG_TEXT_OFFSET,
    });

    // `GlueDialogButton1`, from `GlueDialogButtonTemplate`: 220x40, anchored BOTTOM to the
    // background's BOTTOM at y=16 (gluedialog.lua:562, the single-button branch). The template
    // authors the non-blue sheet, but `GlueDialog_OnUpdate` swaps all three states to the `-Blue`
    // textures whenever `CURRENT_GLUE_SCREEN == "login"` (gluedialog.lua:651-659) -- which is this
    // screen, so it uses the same blue art the Login button does.
    this.dialogButton = this.dialog.add(new Widget('button', 'login-dialog-button'));
    // Inherits DIALOG strata from `this.dialog`; the layer is ARTWORK, the same as the Login button --
    // its highlight (same layer, via `overlay`) and its caption (OVERLAY) stack on it the same way.
    this.dialogButton.layer = 'ARTWORK';
    this.dialogButton.sprite = 'button-up';
    this.dialogButton.mouseEnabled = true;
    this.dialogButton.focusable = true;
    this.dialogButton
      .setSize(DIALOG_BUTTON_WIDTH, DIALOG_BUTTON_HEIGHT)
      .setAnchors({
        point: 'BOTTOM',
        relativeTo: 'login-dialog',
        relativePoint: 'BOTTOM',
        x: 0,
        y: DIALOG_BUTTON_OFFSET,
      });
    this.dialogButton.onClick = () => this.dialogAction();

    this.dialogHighlight = this.overlay(
      this.dialogButton,
      'login-dialog-button-highlight',
      'button-highlight',
      DIALOG_BUTTON_WIDTH,
      DIALOG_BUTTON_HEIGHT,
      'ADD',
    );

    // `GlueDialogButtonTemplate`'s `ButtonText` is centred with offset y=2 (gluedialog.xml), and its
    // `NormalFont` is `GlueFontNormal` -- the same caption font the Login button uses.
    this.dialogButtonCaption = this.dialogButton.add(
      new Widget('fontstring', 'login-dialog-button-text'),
    );
    // Same idiom as the Login button's caption: OVERLAY, above the button's own ARTWORK and its
    // same-layer highlight, which is what keeps the caption drawing on top of the button art.
    this.dialogButtonCaption.layer = 'OVERLAY';
    this.dialogButtonCaption.font = BUTTON_CAPTION;
    this.dialogButtonCaption.setSize(DIALOG_BUTTON_WIDTH, 16).setAnchors({
      point: 'CENTER',
      relativeTo: 'login-dialog-button',
      relativePoint: 'CENTER',
      x: 0,
      y: 2, // the template's ButtonText offset
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
    // flat, so the backdrop expresses that by sitting on BACKGROUND ahead of them in insertion
    // order, which is what keeps the placeholder visible on top of the border instead of behind it.
    box.layer = 'BACKGROUND';
    // The authored 9-slice `Backdrop` (accountlogin.xml:190-201), drawn as nine pieces by the renderer.
    box.backdrop = EDITBOX_BACKDROP;
    box.mouseEnabled = true;
    box.focusable = true;
    box.maxLetters = maxLetters;
    box.setSize(width, height).setAnchors({ point: 'BOTTOM', x: 0, y: bottomOffset });
    // `OnEnterPressed` -> `AccountLogin_Login()` (accountlogin.xml). `onSubmit`, NOT `onClick`: the
    // pointer handler must only take focus, or clicking back into a box to fix a typo submits the typo.
    box.onSubmit = () => this.submit();

    // The authored `TextInsets`: the text occupies the box shrunk by them, expressed as two opposing
    // anchors so `resolveAnchors` sizes it rather than this code restating the arithmetic. `y` is
    // FrameXML's (+up), so BOTTOMRIGHT's +bottom lifts the bottom edge. With no TOP inset the text
    // rides above the box's true centre, which is what the client draws.
    const text = box.add(new Widget('fontstring', textId));
    text.layer = 'OVERLAY';
    text.font = FIELD_TEXT;
    text.setAnchors(
      {
        point: 'TOPLEFT',
        relativeTo: id,
        relativePoint: 'TOPLEFT',
        x: FIELD_TEXT_INSETS.left,
        y: -FIELD_TEXT_INSETS.top,
      },
      {
        point: 'BOTTOMRIGHT',
        relativeTo: id,
        relativePoint: 'BOTTOMRIGHT',
        x: -FIELD_TEXT_INSETS.right,
        y: FIELD_TEXT_INSETS.bottom,
      },
    );

    // The caret. OURS: the client's edit-box caret is drawn by its engine and has no XML to
    // transcribe, so nothing here is cited. Added after the text so it draws over it, and positioned
    // every frame by `update()` -- `x` is the measured width of the text before the caret.
    const caret = box.add(new Widget('texture', `${textId}-caret`));
    caret.layer = 'OVERLAY';
    caret.solid = true;
    caret.vertexColor = FIELD_TEXT.color;
    caret.setSize(CARET_WIDTH, FIELD_TEXT.size).setAnchors({
      point: 'LEFT',
      relativeTo: textId,
      relativePoint: 'LEFT',
      x: 0,
      y: 0,
    });
    caret.hide();

    return box;
  }

  /**
   * Put the caret where the next character will land, and blink it, for the focused box only.
   *
   * Measured against `displayText`, so a password box positions against the MASKED string: measuring
   * the real one would put the caret at the real characters' widths and leak them on screen. Measured
   * at scale 1 because `caretOffset` returns logical units, which the layout scale divides back out
   * anyway -- the screen has no viewport to ask for the live scale from here.
   */
  private placeCaret(box: Widget | null, textId: string): void {
    if (!box) {
      return;
    }
    const caret = box.children.find((child) => child.id === `${textId}-caret`);
    if (!caret) {
      return;
    }

    const focused = this.ctx?.input.focused === box;
    // Half a second lit, half dark. OURS, like the caret itself.
    const lit = this.caretClock % (CARET_BLINK_SECONDS * 2) < CARET_BLINK_SECONDS;
    if (!focused || !lit) {
      caret.hide();
      return;
    }

    caret.anchors[0].x = caretOffset(box.displayText, FIELD_TEXT, 1, box.caret);
    caret.show();
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

  /**
   * What the dialog's one button does, which depends on which dialog is up -- exactly as the client's
   * does: `GlueDialog_OnClick` runs the `OnAccept` of the current `GlueDialogTypes` entry.
   *
   *  - The ERROR dialog is `GlueDialogTypes["OKAY"]`. `ProtocolSession#dismiss` clears the refusal and
   *    the queued retry, which is what makes it go away and stay away -- `update()` re-derives the
   *    dialog from the session every frame, so merely hiding the widget lasted one frame.
   *  - The CONNECTING dialog is `GlueDialogTypes["CANCEL"]`, and the client's carries a real CANCEL, so
   *    ours does too. `ProtocolSession#cancelLogin` stops the attempt and returns the stage to
   *    `Offline`, which takes the dialog down on the next frame and leaves the screen usable.
   *
   * What cancelling does NOT do is abort the socket already in flight -- the transports expose no
   * abort, and this screen is not the place to add one. What it does instead is make that socket
   * IRRELEVANT: its result is discarded whether it succeeds or fails, the 3 s retry is cancelled, the
   * credentials are dropped so nothing can resubmit them, and the stage returns to `Offline`. The
   * connection may still be open for a few seconds; nothing the player can see or reach depends on it.
   */
  private dialogAction(): void {
    const protocol = this.ctx?.protocol;
    if (!protocol) {
      return;
    }
    if (this.dialogKind === 'connecting') {
      protocol.cancelLogin();
    } else if (this.dialogKind === 'error') {
      protocol.dismiss();
    }
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

  update(dt = 0): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    this.caretClock += dt;

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

    this.placeCaret(this.account, 'login-account-text');
    this.placeCaret(this.password, 'login-password-text');
    this.placeCaret(this.server, 'login-server-text');

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

    if (this.dialogButton) {
      this.dialogButton.sprite =
        this.dialogButton.state === 'down'
          ? 'button-down'
          : this.dialogButton.state === 'disabled'
            ? 'button-disabled'
            : 'button-up';
      this.setShown(this.dialogHighlight, this.dialogButton.hovered);
    }

    const dialog = loginDialog(ctx.protocol.stage, ctx.protocol.lastRefusal, ctx.protocol.retrying);
    this.dialogKind = dialog.kind;
    if (this.dialog && this.dialogText) {
      if (dialog.kind === 'none') {
        this.dialog.hide();
      } else {
        this.dialog.show();
        this.dialogText.text =
          dialog.kind === 'connecting'
            ? ctx.strings.get('LOGIN_STATE_CONNECTING')
            : ctx.strings.get(dialog.stringKey);

        // `GlueDialogButton1:SetText(dialogInfo.button1)`: the connecting dialog is
        // `GlueDialogTypes["CANCEL"]` -> `CANCEL`, an error is `GlueDialogTypes["OKAY"]` -> `OKAY`
        // (gluedialog.lua:162-190). Both keys are in the shipped `gluestrings.lua`.
        if (this.dialogButtonCaption) {
          this.dialogButtonCaption.text = ctx.strings.get(
            dialog.kind === 'connecting' ? 'CANCEL' : 'OKAY',
          );
        }

        // The background is resized to its content, not left at the authored 256 tall
        // (`dialogHeight`). Measured at scale 1: `measureText` returns logical units, which is what a
        // widget's height is in, so the live layout scale divides back out and is not needed here.
        const measured = measureText(this.dialogText.text, DIALOG_TEXT, 1);
        this.dialogText.height = measured.height;
        this.dialog.height = dialogHeight(measured.height);
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
    this.dialogButton = null;
    this.dialogButtonCaption = null;
    this.dialogHighlight = null;
    this.dialogShown = false;
    this.dialogKind = 'none';
    this.caretClock = 0;
  }
}
