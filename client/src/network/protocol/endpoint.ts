/**
 * Where the browser may actually connect.
 *
 * A browser has no raw TCP, so every game connection goes through the WebSocket-to-TCP proxy in
 * `client/websockify.js` -- one process per (listen port -> target). The realm list advertises the
 * SERVER's address, which has no WebSocket listener, so by default we keep the realm's port and
 * substitute the proxy host. That is exactly what the existing client does by passing the auth host
 * along with the realm; writing it down here makes it a decision rather than an accident.
 *
 * A realm on a port no proxy listens on cannot be reached from a browser at all. This function
 * cannot fix that -- but every failure out of the transports names the endpoint it tried, so the
 * cause is visible rather than mysterious.
 */
import { RealmInfo } from './types';

export type ProxyConfig = {
  /** The host the WebSocket proxies listen on. */
  proxyHost: string;
  /** False when WebSockets terminate at the realm itself and no rewriting is wanted. */
  rewriteRealmHost: boolean;
};

export function resolveRealmEndpoint(
  realm: RealmInfo,
  config: ProxyConfig,
): { host: string; port: number } {
  return {
    host: config.rewriteRealmHost ? config.proxyHost : realm.host,
    port: realm.port,
  };
}
