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
  /** Dial realms through the gateway rather than at the address they advertise. */
  rewriteRealmHost: boolean;
  /** The Save Account Name check button on the login screen owns this. */
  savedAccount?: string;
};

export const DEFAULT_SETTINGS: ConnectionSettings = {
  logonHost: 'localhost',
  logonPort: 3724,
  gatewayUrl: 'ws://localhost:9000',
  rewriteRealmHost: true,
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
  const defaults: ConnectionSettings = { ...DEFAULT_SETTINGS, logonHost: servedHost() };

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

/** `<gateway>/tcp/<host>:<port>` -- the target is in the path, so no port needs provisioning. */
export function gatewaySocketUrl(
  settings: ConnectionSettings,
  host: string,
  port: number,
): string {
  const base = settings.gatewayUrl.replace(/\/+$/, '');
  return `${base}/tcp/${host}:${port}`;
}
