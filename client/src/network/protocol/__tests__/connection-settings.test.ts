import {
  DEFAULT_SETTINGS,
  gatewaySocketUrl,
  loadSettings,
  saveSettings,
} from '../connection-settings';

/** A localStorage stand-in, so the test never touches the real one. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('loadSettings', () => {
  it('falls back to the defaults when nothing was saved', () => {
    // `logonHost` is asserted separately below: it defaults to the SERVED host, not to
    // `DEFAULT_SETTINGS.logonHost`, and under jsdom those two happen to be the same string -- so
    // comparing the whole object would pass by coincidence and stop testing the fallback it names.
    expect(loadSettings(fakeStorage())).toEqual({
      ...DEFAULT_SETTINGS,
      logonHost: window.location.hostname,
    });
  });

  it('defaults the logon host to the host the app was served from', () => {
    // The WebSocket-to-TCP proxies listen wherever the app is served, so a literal `localhost` would
    // send anyone running this off their own machine to the wrong place.
    expect(loadSettings(fakeStorage()).logonHost).toBe(window.location.hostname);
  });

  it('reads what was saved', () => {
    const storage = fakeStorage();
    saveSettings({ ...DEFAULT_SETTINGS, logonHost: 'wow.example.com', logonPort: 3724 }, storage);

    expect(loadSettings(storage).logonHost).toBe('wow.example.com');
  });

  it('ignores corrupt saved data rather than throwing on startup', () => {
    // A half-written value must not stop the app from loading -- a client that cannot start is
    // strictly worse than one that starts with defaults.
    expect(loadSettings(fakeStorage({ 'wow.connection': '{not json' }))).toEqual(DEFAULT_SETTINGS);
  });
});

describe('gatewaySocketUrl', () => {
  it('addresses the target in the URL, so any host and port work without provisioning', () => {
    const settings = { ...DEFAULT_SETTINGS, gatewayUrl: 'ws://localhost:9000' };

    expect(gatewaySocketUrl(settings, 'logon.example.com', 3724)).toBe(
      'ws://localhost:9000/tcp/logon.example.com:3724',
    );
  });

  it('keeps wss when the gateway is behind TLS', () => {
    // Served over https, a browser refuses ws:// outright. The gateway URL therefore carries its own
    // scheme rather than being assembled from window.location.
    const settings = { ...DEFAULT_SETTINGS, gatewayUrl: 'wss://play.example.com' };

    expect(gatewaySocketUrl(settings, '10.0.0.5', 8085)).toBe('wss://play.example.com/tcp/10.0.0.5:8085');
  });

  it('tolerates a trailing slash on the gateway url', () => {
    const settings = { ...DEFAULT_SETTINGS, gatewayUrl: 'ws://localhost:9000/' };

    expect(gatewaySocketUrl(settings, 'h', 1)).toBe('ws://localhost:9000/tcp/h:1');
  });
});
