# Login Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the throwaway probe screen with the real `AccountLogin` screen, transcribed from the client's own GlueXML and wired to the typed session, and retire the placeholder React screens it supersedes.

**Architecture:** One authored screen module builds a widget tree at the coordinates `AccountLogin.xml` declares, using art from a table with the authored tex-coords. A small pure module maps session stage plus last refusal to which dialog is up and what it says. Two minimal stub screens hold `RealmList` and `CharSelect` until specs 4 and 5 transcribe them, so the machine's transitions always land somewhere. The legacy React screens are deleted and `/glue` becomes `/`.

**Tech Stack:** TypeScript, the `game/ui` widget layer from spec 1, the `network/protocol` session from spec 2, jest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-login-screen-design.md`. Read it before Task 1.
- **Tests are deliberately minimal** — the human's instruction: the dialog mapping, that the screen submits what was typed, that the saved account name round-trips, and the realmlist URL override. Do not add more. Visual correctness is checked in a browser, not asserted.
- **No user-visible string may be hardcoded.** Text comes from `GlueStrings` (`ctx.strings.get(key)`); the login screen's keys are in the shipped table (verified present: `ACCOUNT_NAME`, `PASSWORD`, `LOGIN`, `EXIT_GAME`, `SAVE_ACCOUNT_NAME` = "Remember
  Account Name", `LOGIN_STATE_CONNECTING`, `SERVER_SELECTION`, and the `AUTH_*` family). Three keys an
  earlier draft of this plan invented -- `AUTH_CONNECTING`, `REALM_LIST`, `CHARACTER_SELECT` -- do NOT
  exist; `GlueStrings.get` falls back to the key name, so an invented key ships as visible mojibake
  rather than a crash. If you need a key this plan does not name, grep the shipped table for it before
  using it, and say in your report which you checked.
- **No art path in screen code.** Sprites come from a `GlueArt` table by key, with the authored tex-coords below.
- Authored values, transcribed from `interface/gluexml/accountlogin.xml` and `gluebuttons.xml` — use these exactly:
  - logo `Interface\Glues\Common\Glues-WoW-WotLKLogo`, 256×128, anchored `TOP` offset y = 10
  - account edit box 600×64, anchored `BOTTOM` offset y = 345; password edit box 256×64, `BOTTOM` y = 275; both use `Interface\Common\Common-Input-Border`, `letters="16"`
  - Login button 170×45, anchored `BOTTOM` y = 170; art `Glue-Panel-Button-Up-Blue` / `-Down-Blue` / `-Highlight-Blue` (highlight blends ADD) / `Glue-Panel-Button-Disabled`, **all with tex-coords `left 0, right 0.578125, top 0, bottom 0.75`** except highlight, which is `0, 0.625, 0, 0.6875`
  - check button 20×20 with `UI-CheckBox-Up`, `-Down`, `-Highlight`, `-Check`
  - Blizzard logo `Interface\Glues\Mainmenu\Glues-BlizzardLogo`
  - every path above returns 200 from the asset host; `GlueArt` appends `.blp` itself, so table entries stay extensionless
- The probe drew whole sheets and its button looked like a strip. Tex-coords are why. Do not omit them.
- Run tests with `cd client && npm test -- --watchAll=false --testPathPattern=<pattern>`; `cd client && npx tsc --noEmit -p tsconfig.json` must report **zero** errors — it is at zero now, so any error is this plan's.
- The screen honours `?realmlist=host:port`, alongside the `?expansion=` and `?offline=1` affordances
  the earlier specs added. Precedence: URL, then saved settings, then defaults.
- Commit after every task.

---

### Task 1: The dialog mapping

The one piece of logic worth testing on its own: what the player is told, given where the session is.

**Files:**
- Create: `client/src/game/ui/screens/login-state.ts`
- Test: `client/src/game/ui/screens/__tests__/login-state.test.ts`

**Interfaces:**
- Consumes: `LoginStage` from `../../../network/protocol/stages`, `ProtocolRefusal` from `../../../network/protocol/types`.
- Produces: `type LoginDialog = { kind: 'none' } | { kind: 'connecting' } | { kind: 'error'; stringKey: string }`, and `loginDialog(stage: LoginStage, refusal: ProtocolRefusal | null): LoginDialog`.

- [ ] **Step 1: Write the failing test**

```ts
import { LoginStage } from '../../../../network/protocol/stages';
import { loginDialog } from '../login-state';

describe('loginDialog', () => {
  it('says nothing while the player is still typing', () => {
    expect(loginDialog(LoginStage.Offline, null)).toEqual({ kind: 'none' });
  });

  it('shows the connecting dialog while the exchange is in flight', () => {
    expect(loginDialog(LoginStage.Connecting, null)).toEqual({ kind: 'connecting' });
    expect(loginDialog(LoginStage.Authenticating, null)).toEqual({ kind: 'connecting' });
  });

  it('shows the server’s own words when it refused', () => {
    // The key is the client's; the wording comes from GlueStrings at draw time.
    expect(loginDialog(LoginStage.Offline, { code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' })).toEqual({
      kind: 'error',
      stringKey: 'AUTH_UNKNOWN_ACCOUNT',
    });
  });

  it('drops the error once a new attempt starts', () => {
    // Otherwise the previous failure sits on screen over the connecting dialog.
    expect(loginDialog(LoginStage.Connecting, { code: 0x04, stringKey: 'AUTH_UNKNOWN_ACCOUNT' })).toEqual({
      kind: 'connecting',
    });
  });

  it('says nothing once the realm list has arrived', () => {
    expect(loginDialog(LoginStage.RealmList, null)).toEqual({ kind: 'none' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=login-state`
Expected: FAIL — cannot resolve `../login-state`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * What the login screen tells the player, given where the session is.
 *
 * Pure, and separate from the layout, because this is the part with actual rules: an in-flight attempt
 * outranks a previous failure (otherwise a stale "unknown account" sits over the connecting dialog),
 * and a refusal survives the return to `Offline` precisely so the player can read it.
 *
 * Returns a string KEY, never wording -- `GlueStrings` resolves it at draw time, so the player reads
 * the client's own words.
 */
import { LoginStage } from '../../../network/protocol/stages';
import { ProtocolRefusal } from '../../../network/protocol/types';

export type LoginDialog =
  | { kind: 'none' }
  | { kind: 'connecting' }
  | { kind: 'error'; stringKey: string };

export function loginDialog(stage: LoginStage, refusal: ProtocolRefusal | null): LoginDialog {
  if (stage === LoginStage.Connecting || stage === LoginStage.Authenticating) {
    return { kind: 'connecting' };
  }

  if (refusal && stage === LoginStage.Offline) {
    return { kind: 'error', stringKey: refusal.stringKey };
  }

  return { kind: 'none' };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=login-state`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/ui/screens/login-state.ts client/src/game/ui/screens/__tests__/login-state.test.ts
git commit -m "feat(login): map session stage and refusal to what the player is told"
```

---

### Task 2: The authored layout

**Files:**
- Create: `client/src/game/ui/screens/login-art.ts`
- Create: `client/src/game/ui/screens/login.ts`

**Interfaces:**
- Consumes: `Widget`, `FontSpec`, `TexCoords` from `../widget`; `GlueScreen`, `GlueContext`, `ClientState` from `../screens`; `SpriteDef` from `../art`; `loginDialog` from `./login-state`.
- Produces: `LOGIN_ART` (a `Record<string, SpriteDef>`), and `class LoginScreen implements GlueScreen` with the widget ids `login-logo`, `login-account`, `login-account-text`, `login-password`, `login-password-text`, `login-server`, `login-server-text`, `login-save-name`, `login-login`, `login-quit`, `login-version`, `login-blizzard`, `login-dialog`, `login-dialog-text`.

No test in this task — it is layout and art, and the widget layer it stands on is already tested. Its verification is the compile plus the browser pass in Task 4.

- [ ] **Step 1: Write the art table**

```ts
/**
 * The login screen's art, keyed by name, with the tex-coords the client authors.
 *
 * The tex-coords are not decoration: `Glue-Panel-Button-Up-Blue` is a 256x64 sheet whose button
 * occupies `0..0.578125` by `0..0.75`, and the probe screen that drew the whole sheet looked like a
 * blue strip. The values come from `GluePanelButtonUpTextureBlue` and its siblings in
 * `interface/gluexml/gluebuttons.xml`.
 *
 * Paths stay extensionless because `GlueArt` appends `.blp`, the way the client's own UI paths do.
 */
import { SpriteDef } from '../art';

/** The button sheet's used region, shared by up/down/disabled. */
const BUTTON_TC = { u0: 0, v0: 0, u1: 0.578125, v1: 0.75 };
/** The highlight sheet's used region differs -- it is a slightly larger glow. */
const BUTTON_HIGHLIGHT_TC = { u0: 0, v0: 0, u1: 0.625, v1: 0.6875 };

export const LOGIN_ART: Record<string, SpriteDef> = {
  logo: { path: 'Interface\\Glues\\Common\\Glues-WoW-WotLKLogo', size: [256, 128] },
  'input-border': { path: 'Interface\\Common\\Common-Input-Border' },
  'button-up': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Up-Blue',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  'button-down': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Down-Blue',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  'button-highlight': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Highlight-Blue',
    texCoords: BUTTON_HIGHLIGHT_TC,
    size: [170, 45],
  },
  'button-disabled': {
    path: 'Interface\\Glues\\Common\\Glue-Panel-Button-Disabled',
    texCoords: BUTTON_TC,
    size: [170, 45],
  },
  'check-up': { path: 'Interface\\Buttons\\UI-CheckBox-Up', size: [20, 20] },
  'check-down': { path: 'Interface\\Buttons\\UI-CheckBox-Down', size: [20, 20] },
  'check-highlight': { path: 'Interface\\Buttons\\UI-CheckBox-Highlight', size: [20, 20] },
  'check-mark': { path: 'Interface\\Buttons\\UI-CheckBox-Check', size: [20, 20] },
  'blizzard-logo': { path: 'Interface\\Glues\\Mainmenu\\Glues-BlizzardLogo' },
  'dialog-background': { path: 'Interface\\DialogFrame\\UI-DialogBox-Background' },
};
```

- [ ] **Step 2: Write the screen**

The authored coordinates are in the Global Constraints and are repeated in the code's comments so a reader never has to leave the file to know where a number came from. Anchors follow the client: `+y` is up.

```ts
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
import { loadSettings, saveSettings } from '../../../network/protocol/connection-settings';
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
    const settings = loadSettings();

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
```

- [ ] **Step 3: Add the saved-account field and the `?realmlist=` override**

Two additions to `client/src/network/protocol/connection-settings.ts`:

1. `savedAccount?: string` on `ConnectionSettings`, absent from `DEFAULT_SETTINGS`, with a one-line
   comment saying the Save Account Name check button owns it.
2. A URL override for the logon address, the same debugging affordance `?offline=1` and `?expansion=0`
   already give:

```ts
/**
 * `?realmlist=host:port` -- the URL override for the logon address.
 *
 * The real client reads `realmlist.wtf`; this is the same idea reachable from a link, which makes "try
 * it against that other server" a one-URL operation instead of a typing exercise. The port is optional
 * and falls back to whatever the base settings carry, so `?realmlist=logon.example.com` works.
 *
 * Precedence is URL, then what was saved, then the defaults. The URL wins for the session it is in;
 * submitting the screen saves whatever the field then holds, so an override sticks only if the player
 * logs in with it.
 */
export function applyRealmlistOverride(
  settings: ConnectionSettings,
  search: string,
): ConnectionSettings {
  const raw = new URLSearchParams(search).get('realmlist');
  if (!raw) {
    return settings;
  }

  const [host, port] = raw.split(':');
  if (!host) {
    return settings;
  }

  const parsed = Number(port);
  return {
    ...settings,
    logonHost: host,
    logonPort: Number.isFinite(parsed) && parsed > 0 ? parsed : settings.logonPort,
  };
}
```

Then have the login screen read it in `mount`, in place of the bare `loadSettings()`:

```ts
    const settings = applyRealmlistOverride(loadSettings(), window.location.search);
```

and add `applyRealmlistOverride` to the screen's import from `connection-settings`.

- [ ] **Step 4: Compile**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/ui/screens/login.ts client/src/game/ui/screens/login-art.ts client/src/network/protocol/connection-settings.ts
git commit -m "feat(login): transcribe the AccountLogin layout at its authored coordinates"
```

---

### Task 3: Submit and remember

Two tests, both about behaviour a player would notice.

**Files:**
- Test: `client/src/game/ui/screens/__tests__/login.test.ts`

**Interfaces:**
- Consumes: `LoginScreen` from `../login`; `WidgetRoot` from `../../widget`; `GlueArt` from `../../art`; `GlueStrings` from `../../strings`; `loadSettings`/`saveSettings` from `../../../../network/protocol/connection-settings`.

- [ ] **Step 1: Write the tests**

```ts
/**
 * The two things a player would notice if they broke: the screen submits what was typed, and the
 * account name comes back next time when they asked it to.
 *
 * Mounted headlessly -- no canvas, no renderer. The screen only builds widgets and reads state, so a
 * fake context is enough.
 */
import { GlueArt } from '../../art';
import { GlueStrings } from '../../strings';
import { WidgetRoot } from '../../widget';
import { LoginScreen } from '../login';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../../../../network/protocol/connection-settings';

function fakeContext(protocol: { login: jest.Mock; stage: string; lastRefusal: null }) {
  const root = new WidgetRoot();
  return {
    ctx: {
      root,
      art: new GlueArt(),
      strings: new GlueStrings(new Map([['LOGIN', 'Login'], ['SAVE_ACCOUNT_NAME', 'Save Account Name']])),
      input: { setFocus: jest.fn() } as never,
      session: {} as never,
      protocol: protocol as never,
      setScene: jest.fn(),
      go: jest.fn(),
    },
    root,
  };
}

function fakeProtocol() {
  return { login: jest.fn().mockResolvedValue(undefined), stage: 'Offline', lastRefusal: null };
}

/** localStorage in jsdom is real but shared; clear what these tests write. */
beforeEach(() => {
  window.localStorage.clear();
});

describe('LoginScreen', () => {
  it('submits the account and password the player typed', () => {
    const protocol = fakeProtocol();
    const { ctx, root } = fakeContext(protocol);
    const screen = new LoginScreen();
    screen.mount(ctx as never);

    const find = (id: string) => root.root.children.find((child) => child.id === id)!;
    find('login-account').text = 'tester';
    find('login-password').text = 'secret';

    find('login-login').onClick!();

    expect(protocol.login).toHaveBeenCalledWith('tester', 'secret');
  });

  it('remembers the account name only when asked', () => {
    const protocol = fakeProtocol();
    const first = fakeContext(protocol);
    const screen = new LoginScreen();
    screen.mount(first.ctx as never);

    const find = (root: WidgetRoot, id: string) =>
      root.root.children.find((child) => child.id === id)!;
    find(first.root, 'login-account').text = 'tester';
    find(first.root, 'login-password').text = 'secret';
    find(first.root, 'login-save-name').checked = true;
    find(first.root, 'login-login').onClick!();
    screen.unmount();

    expect(loadSettings().savedAccount).toBe('tester');

    // Mounted again, the box comes back filled.
    const second = fakeContext(fakeProtocol());
    const remounted = new LoginScreen();
    remounted.mount(second.ctx as never);
    expect(find(second.root, 'login-account').text).toBe('tester');
  });
});
```

- [ ] **Step 2: Run them**

Run: `cd client && npm test -- --watchAll=false --testPathPattern=screens/__tests__/login`
Expected: PASS (2 tests). If a test fails because the screen reads or writes something differently than the test assumes, fix the SCREEN if the test describes what a player expects, and fix the test only if it describes something a player would not care about. Say which you chose and why in your report.

- [ ] **Step 3: Add the one test for the URL override**

Append to the same file, and add `applyRealmlistOverride` to its import from `connection-settings`.

```ts
describe('applyRealmlistOverride', () => {
  it('takes host and port from the URL, so a link can point at another server', () => {
    const overridden = applyRealmlistOverride(DEFAULT_SETTINGS, '?realmlist=logon.example.com:3724');

    expect(overridden.logonHost).toBe('logon.example.com');
    expect(overridden.logonPort).toBe(3724);
  });

  it('keeps the existing port when the URL gives only a host', () => {
    const base = { ...DEFAULT_SETTINGS, logonPort: 3725 };

    expect(applyRealmlistOverride(base, '?realmlist=logon.example.com')).toMatchObject({
      logonHost: 'logon.example.com',
      logonPort: 3725,
    });
  });

  it('changes nothing when the URL says nothing', () => {
    expect(applyRealmlistOverride(DEFAULT_SETTINGS, '?offline=1')).toEqual(DEFAULT_SETTINGS);
  });
});
```

Run: `cd client && npm test -- --watchAll=false --testPathPattern="screens/__tests__/login|connection-settings"`

- [ ] **Step 4: Commit**

```bash
git add client/src/game/ui/screens/__tests__/login.test.ts
git commit -m "test(login): pin submitting credentials, remembering the account, and the realmlist override"
```

---

### Task 4: Take over the route, retire the placeholders

**Files:**
- Create: `client/src/game/ui/screens/realm-stub.ts`
- Create: `client/src/game/ui/screens/character-stub.ts`
- Modify: `client/src/pages/glue/index.tsx`
- Modify: `client/src/app.tsx`
- Delete: `client/src/game/ui/screens/probe.ts`, `client/src/pages/auth/auth.tsx`, `client/src/pages/auth/auth.scss`, `client/src/pages/realms/realms.tsx`, `client/src/pages/realms/realms.scss`, `client/src/pages/characters/index.tsx`
- Modify: `client/src/game/ui/art.ts` (drop `PROBE_ART`)

**Interfaces:**
- Produces: `class RealmStubScreen implements GlueScreen`, `class CharacterStubScreen implements GlueScreen`.

Retiring the React screens is what closes the hazard spec 2 left: the world handshake reaches its
account and key by writing a stand-in onto `session.auth.srp`, and that is the same `AuthHandler`
singleton the old screens drive. With them gone, one `GameSession` cannot hold a real `SRP` for one
path and a stand-in for the other.

- [ ] **Step 1: Write the two stubs**

Deliberately plain: a title and one row per item, using the same widget layer. Specs 4 and 5 replace
them with transcriptions, exactly as this task replaces the probe.

```ts
/**
 * A minimal realm picker, standing in until spec 4 transcribes `RealmList.xml`. Plain on purpose --
 * it exists so the machine's `RealmList` stage lands somewhere real, not to look like the client.
 */
import { GlueContext, GlueScreen } from '../screens';
import { FontSpec, Widget } from '../widget';

const ROW: FontSpec = {
  family: 'FRIZQT',
  size: 14,
  color: '#ffd100',
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
```

The character stub is the same shape over `ctx.protocol.characters`, with the title
`ctx.strings.get('SELECT_CHARACTER')`, ids `character-stub-<n>`, and `row.onClick` calling
`ctx.protocol.enterWorld(character.guid)`. Write it out in full in
`client/src/game/ui/screens/character-stub.ts` — do not import the realm stub and generalise it; two
short throwaway files that each read straight through are worth more here than one clever one.

- [ ] **Step 2: Register the three screens in the host**

In `client/src/pages/glue/index.tsx`, replace the probe registration:

```tsx
    this.app = new GlueApp(canvas, this.props.session);
    this.app.register(ClientState.Login, new LoginScreen());
    this.app.register(ClientState.RealmList, new RealmStubScreen());
    this.app.register(ClientState.CharSelect, new CharacterStubScreen());
    void this.app.start(ClientState.Login);
```

- [ ] **Step 3: Take over `/` and delete the placeholders**

In `client/src/app.tsx`: point `path: "/"` at `<GlueHost session={gameSession} />`, remove the
`/realms`, `/characters` and `/create-character` routes and their imports, keep `/game` exactly as it
is, and keep `/glue` as an alias of `/` so existing links and any bookmark still work. Then delete the
six placeholder files listed above and `PROBE_ART` from `art.ts`.

- [ ] **Step 4: Verify**

Run, and put the real output in your report:
- `cd client && npx tsc --noEmit -p tsconfig.json` — zero errors.
- `cd client && npm test -- --watchAll=false` — everything passes. Tests that referenced the deleted
  screens must be deleted with them; say which you removed.
- The dev server with a bounded polling loop over its log, then 200 from `/`, `/glue` and
  `/game?offline=1`. `/realms` and `/characters` are expected to 404 now — confirm that too, since it
  is the point of the task.

- [ ] **Step 5: Commit**

```bash
git add -A client/src
git commit -m "feat(login): serve the login screen at / and retire the placeholder screens"
```

---

## Done criteria

- `/` shows the authored login screen over the main-menu stage: real logo, both edit boxes at their
  authored sizes, a Login button that is a button rather than a strip of sheet, the check button, the
  version block and the Blizzard logo.
- Typing an account and password and pressing Login drives `ProtocolSession.login`; a refusal shows the
  client's own wording; the connecting dialog shows while the exchange is in flight.
- With Save Account Name checked, the account comes back on the next visit.
- The realm and character stubs receive the machine's transitions, so the path continues past login.
- `/realms` and `/characters` are gone; `/game` and `/game?offline=1` are untouched.
- `/?realmlist=host:port` points the screen at another server without typing, and `?realmlist=host`
  alone keeps the current port.
- `npx tsc --noEmit` is at zero and the full suite passes, with only the small test files this plan adds.

---

## Follow-ups carried out of this plan

Recorded here because the plan's own workspace is scratch and gets deleted. All are known and
disclosed in the code where they bite; none block the done criteria above.

- **The edit boxes' border is not the authored art.** The client draws a 9-slice `Backdrop`:
  background `Interface\Tooltips\UI-Tooltip-Background` tiled at 16, edge
  `Interface\Glues\Common\Glue-Tooltip-Border` at edgeSize 16, background insets left 10 right 5 top 4
  bottom 9 (`accountlogin.xml:190-201`). The widget layer has a `backdrop` kind but no 9-slice
  renderer, so a single stretched `Common-Input-Border` quad stands in — art the client does not use
  on this screen at all. The stand-in is commented as such in `login-art.ts`. Doing it properly is a
  widget-layer feature, not login layout, and every later glue screen wants it.
- **The Northrend main-menu stage renders on a flat cyan sky.** Not a missing sky feature: the vanilla
  stage (`/?expansion=0`) renders its own sky correctly, so this is specific to that scene. Predates
  this plan; much more visible now that the screen is the app's front door.
- **The connecting dialog cannot be cancelled.** `ProtocolSession#dismiss` clears the refusal and the
  queued retry but does not touch the stage, and there is no way to abort a socket mid-attempt. Until
  the session exposes one, the dialog simply is not dismissable while an attempt is in flight; it
  clears itself when the attempt resolves. Explained at `LoginScreen#dismissDialog`.
- **`login-state.ts` and `screens.ts` import each other.** `clientStateForStage` needs `ClientState`
  and `GlueApp` needs the mapping. Safe today only because the enum is read inside a function body.
  Whoever adds the next state should move `ClientState` into its own module.
- **`FontSpec` has no shadow channel.** The client draws a 1,-1 black shadow under `GlueFontNormal`
  and its small variants; only the outline ring is reproduced. Noted at the `LABEL` declaration.
- **`AuthorizationStatus` and `SocketConnestionStatus`** (`src/network/enums/index.ts`) lost their last
  consumers when `GameSession.authenticate()`/`connect()` went. Dead exports, safe to delete.
