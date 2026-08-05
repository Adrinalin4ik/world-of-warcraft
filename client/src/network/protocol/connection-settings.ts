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
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // Corrupt or partially written settings must not stop the client from starting.
    return DEFAULT_SETTINGS;
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
