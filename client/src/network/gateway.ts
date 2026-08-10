/**
 * The one place that decides what URL a game WebSocket opens.
 *
 * A browser has no raw TCP, so nothing here may dial a game address directly -- every socket goes to
 * the WebSocket-to-TCP gateway (`ws-proxy/server.js`), which is handed its TCP target in the URL and
 * dials it itself. `net/socket.js` is shared by the logon path, the world path and the legacy
 * handlers, so it calls this and there is exactly one answer to "what does this client connect to".
 *
 * The old scheme was one `websockify` process per port, listening on the served host at the SAME port
 * number as its fixed target, which is why the socket used to build `ws://<target-host>:<port>` and
 * why realm hosts were rewritten to the proxy's. That URL is a raw TCP port with no WebSocket
 * listener on it, so it never connected to anything.
 */
import {
  ConnectionSettings,
  applyGatewayOverride,
  gatewaySocketUrl,
  loadSettings,
} from './protocol/connection-settings';

/**
 * The gateway URL for a TCP target.
 *
 * Settings are resolved per call, not cached: the login screen writes them on submit, and a socket
 * opened after that must use what was written rather than whatever was in storage when this module
 * first loaded. Both reads are a `localStorage.getItem` and a `URLSearchParams` on a connect, which
 * happens twice a session.
 */
export function gameSocketUrl(
  host: string,
  port: number,
  settings: ConnectionSettings = currentSettings(),
): string {
  return gatewaySocketUrl(settings, host, port);
}

function currentSettings(): ConnectionSettings {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return applyGatewayOverride(loadSettings(), search);
}
