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

    expect(protocol.login).toHaveBeenCalledWith('tester', 'secret');
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
