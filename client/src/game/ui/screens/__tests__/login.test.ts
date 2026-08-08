/**
 * The two things a player would notice if they broke: the screen submits what was typed, and the
 * account name comes back next time when they asked it to.
 *
 * Mounted headlessly -- no canvas, no renderer. The screen only builds widgets and reads state, so a
 * fake context is enough.
 */
import { GlueArt } from '../../art';
import { GlueStrings } from '../../strings';
import { Widget, WidgetRoot } from '../../widget';
import { LoginScreen } from '../login';
import {
  applyRealmlistOverride,
  DEFAULT_SETTINGS,
  loadSettings,
} from '../../../../network/protocol/connection-settings';

function fakeContext(protocol: { login: jest.Mock; stage: string; lastRefusal: null }) {
  const root = new WidgetRoot();
  // Mutable, so a test can point focus at a widget the screen only creates during `mount` -- the
  // caret is drawn for the FOCUSED box only.
  const input = { setFocus: jest.fn(), focused: null as Widget | null };
  return {
    ctx: {
      root,
      art: new GlueArt(),
      strings: new GlueStrings(new Map([['LOGIN', 'Login'], ['SAVE_ACCOUNT_NAME', 'Save Account Name']])),
      input: input as never,
      session: {} as never,
      protocol: protocol as never,
      setScene: jest.fn(),
      go: jest.fn(),
    },
    root,
    input,
  };
}

function fakeProtocol() {
  return { login: jest.fn().mockResolvedValue(undefined), stage: 'Offline', lastRefusal: null };
}

/** Depth-first by id: several login widgets (the field captions, button captions) are nested
 * inside their box or button rather than sitting directly under root, and a flat search would
 * miss them. Neither `Widget` nor `WidgetRoot` exposes a by-id lookup, so this is the minimal one. */
function find(root: WidgetRoot, id: string): Widget {
  const walk = (widget: Widget): Widget | null => {
    if (widget.id === id) {
      return widget;
    }
    for (const child of widget.children) {
      const found = walk(child);
      if (found) {
        return found;
      }
    }
    return null;
  };

  const result = walk(root.root);
  if (!result) {
    throw new Error(`no widget with id ${id}`);
  }
  return result;
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

    find(root, 'login-account').text = 'tester';
    find(root, 'login-password').text = 'secret';

    find(root, 'login-login').onClick!();

    // The endpoint is the next test's business; this one is only about the credentials.
    expect(protocol.login).toHaveBeenCalledWith('tester', 'secret', expect.any(Object));
  });

  it('dials the address the player typed, not the config default', () => {
    // The regression: the field wrote localStorage and nothing else, so the client still dialled the
    // host baked into `network/config` however the player edited it.
    const protocol = fakeProtocol();
    const { ctx, root } = fakeContext(protocol);
    const screen = new LoginScreen();
    screen.mount(ctx as never);

    find(root, 'login-account').text = 'tester';
    find(root, 'login-password').text = 'secret';
    find(root, 'login-server').text = 'logon.example.com:8085';

    find(root, 'login-login').onClick!();

    expect(protocol.login).toHaveBeenCalledWith('tester', 'secret', {
      host: 'logon.example.com',
      port: 8085,
    });
  });

  it('remembers the account name only when asked', () => {
    const protocol = fakeProtocol();
    const first = fakeContext(protocol);
    const screen = new LoginScreen();
    screen.mount(first.ctx as never);

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
    remounted.unmount();

    // Submitted a third time with the box unchecked -- and explicitly unchecked, since mount
    // pre-checks it from the settings just saved above -- the name must not still come back.
    const third = fakeContext(fakeProtocol());
    const unchecked = new LoginScreen();
    unchecked.mount(third.ctx as never);
    find(third.root, 'login-account').text = 'someone-else';
    find(third.root, 'login-password').text = 'secret';
    find(third.root, 'login-save-name').checked = false;
    find(third.root, 'login-login').onClick!();

    expect(loadSettings().savedAccount).toBeUndefined();
  });

  it('positions the password caret against the MASK, not the real password', () => {
    // The leak: the caret's x is the measured width of the text before it, so measuring the real
    // password would put the caret at the real characters' widths and show the password's shape on
    // screen to anyone watching. It must measure `displayText` -- the bullets.
    //
    // jsdom here has no 2D canvas, so measurement is stubbed with a per-character advance that makes
    // 'W' four times 'i'. That is what gives the two strings different widths at all, which is the
    // condition the leak would show up under.
    const advance: Record<string, number> = { i: 0.25, W: 1 };
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function () {
      let font = '10px sans-serif';
      return {
        get font() {
          return font;
        },
        set font(value: string) {
          font = value;
        },
        measureText(text: string) {
          const px = Number(/^(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
          return {
            width: Array.from(text).reduce((sum, char) => sum + (advance[char] ?? 0.5), 0) * px,
          };
        },
      };
    };

    const harness = fakeContext(fakeProtocol());
    const screen = new LoginScreen();
    screen.mount(harness.ctx as never);

    const password = find(harness.root, 'login-password');
    password.text = 'WWWW';
    password.caret = 4;
    harness.input.focused = password;
    // Far enough into the blink cycle to be lit, so the caret is shown and its anchor is written.
    screen.update(0);

    const caret = find(harness.root, 'login-password-text-caret');
    expect(caret.shown).toBe(true);

    // Four bullets, not four Ws: the same offset a 'iiii' password of the same length would give.
    const asMask = caret.anchors[0].x;
    password.text = 'iiii';
    screen.update(0);
    expect(find(harness.root, 'login-password-text-caret').anchors[0].x).toBe(asMask);

    // And that offset is NOT the one the real 'WWWW' would have produced, which is what makes the
    // assertion above mean something rather than being trivially true.
    const account = find(harness.root, 'login-account');
    account.text = 'WWWW';
    account.caret = 4;
    harness.input.focused = account;
    screen.update(0);
    expect(find(harness.root, 'login-account-text-caret').anchors[0].x).not.toBe(asMask);

    screen.unmount();
  });
});

describe('applyRealmlistOverride', () => {
  it('takes host and port from the URL, so a link can point at another server', () => {
    const overridden = applyRealmlistOverride(DEFAULT_SETTINGS, '?realmlist=logon.example.com:8085');

    expect(overridden.logonHost).toBe('logon.example.com');
    expect(overridden.logonPort).toBe(8085);
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
