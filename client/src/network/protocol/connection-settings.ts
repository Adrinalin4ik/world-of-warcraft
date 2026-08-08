/**
 * Where this client connects, as DATA a person can change -- not constants baked at build time.
 *
 * This client is meant to work against any private 3.3.5 server, so the logon address belongs to the
 * player the way `realmlist.wtf` did in the real client, not to our webpack config. Two further
 * consequences are already visible: served over https a browser refuses `ws://`, so the gateway URL
 * carries its own scheme instead of being assembled from `window.location`; and the gateway addresses
 * its TCP target in the URL, so a realm on any port needs no per-port process provisioned in advance.
 */
const STORAGE_KEY = 'wow.connection';

export type ConnectionSettings = {
  /** The logon (realmd) server the player wants. */
  logonHost: string;
  logonPort: number;
  /** Base URL of the WebSocket-to-TCP gateway, including scheme. */
  gatewayUrl: string;
  /** The Save Account Name check button on the login screen owns this. */
  savedAccount?: string;
};

/** `ws-proxy/server.js`'s own default listen port. */
const GATEWAY_PORT = 9000;

export const DEFAULT_SETTINGS: ConnectionSettings = {
  logonHost: 'localhost',
  logonPort: 3724,
  gatewayUrl: `ws://localhost:${GATEWAY_PORT}`,
};

/**
 * The logon host a fresh install should show and dial.
 *
 * `DEFAULT_SETTINGS` cannot carry this as a constant: the WebSocket-to-TCP proxies listen on the host
 * the app was SERVED from (which is why `network/config`'s `serverhost` is `window.location.hostname`),
 * so the honest default is a property of the page rather than a literal. This matters now that the
 * screen's address field actually dials -- before it did, `localhost` was merely wrong on screen.
 * Storage still wins over this, and this wins over `DEFAULT_SETTINGS.logonHost`.
 */
function servedHost(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_SETTINGS.logonHost;
  }
  return window.location.hostname || DEFAULT_SETTINGS.logonHost;
}

/**
 * The gateway URL a fresh install should dial, for the same reason `servedHost()` exists: the gateway
 * is deployed beside the app, so the honest default is a property of the page rather than a literal.
 *
 * The SCHEME has to be derived too, and that is not cosmetic -- a page served over https may not open
 * a `ws://` socket at all (the browser blocks it as mixed content, before any request is made), so a
 * baked `ws://` would make an https deployment unusable. Only the port stays a constant, because it is
 * the gateway's own default and nothing on the page can reveal it. Storage still wins over this, and
 * this wins over `DEFAULT_SETTINGS.gatewayUrl`.
 */
function servedGatewayUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_SETTINGS.gatewayUrl;
  }
  const host = window.location.hostname || 'localhost';
  return `${servedScheme()}://${host}:${GATEWAY_PORT}`;
}

/** The only WebSocket scheme this page is allowed to open: https may not fall back to `ws://`. */
function servedScheme(): 'ws' | 'wss' {
  const https = typeof window !== 'undefined' && window.location.protocol === 'https:';
  return https ? 'wss' : 'ws';
}

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Storage can be unavailable (private mode, embedded contexts). Defaults still work.
    return null;
  }
}

export function loadSettings(storage: Storage | null = defaultStorage()): ConnectionSettings {
  const defaults: ConnectionSettings = {
    ...DEFAULT_SETTINGS,
    logonHost: servedHost(),
    gatewayUrl: servedGatewayUrl(),
  };

  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // Corrupt or partially written settings must not stop the client from starting.
    return defaults;
  }
}

export function saveSettings(
  settings: ConnectionSettings,
  storage: Storage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Nothing to do: unsaved settings are a lost preference, not a failure worth surfacing.
  }
}

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

/**
 * `?gateway=ws://host:port` -- the URL override for the gateway, beside `?realmlist=` above.
 *
 * Same precedence: the URL wins for the session it is in, then storage, then the derived default. It
 * exists because the derived default (`servedGatewayUrl()`) is a guess about deployment -- someone
 * running the app from a dev server while the gateway sits elsewhere has no other way to say so, and
 * there is no field on the login screen for it. A scheme-less value is accepted and given the page's
 * own (`?gateway=10.0.0.2:9000`), since a bare host:port is what a person types and `new WebSocket`
 * would reject it outright.
 */
export function applyGatewayOverride(
  settings: ConnectionSettings,
  search: string,
): ConnectionSettings {
  const raw = new URLSearchParams(search).get('gateway')?.trim();
  if (!raw) {
    return settings;
  }

  return {
    ...settings,
    gatewayUrl: /^wss?:\/\//i.test(raw) ? raw : `${servedScheme()}://${raw}`,
  };
}

/**
 * `<gateway>/tcp/<host>:<port>` -- the target is in the path, so no port needs provisioning.
 *
 * The host is percent-encoded because it is player-supplied and lands in a URL path: without it a
 * typed `host/x` or `host?x` would silently retarget or truncate the request, and the gateway
 * `decodeURIComponent`s it straight back (`ws-proxy/server.js`). The port is not encoded -- it is
 * already a number.
 */
export function gatewaySocketUrl(
  settings: ConnectionSettings,
  host: string,
  port: number,
): string {
  const base = settings.gatewayUrl.replace(/\/+$/, '');
  return `${base}/tcp/${encodeURIComponent(host)}:${port}`;
}
