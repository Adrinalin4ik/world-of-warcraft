/**
 * Where the browser may actually connect after a realm is chosen: the realm's OWN advertised address.
 *
 * A browser has no raw TCP, but that no longer changes the endpoint. Every socket is opened at the
 * WebSocket-to-TCP gateway with its target named in the URL (`network/gateway.ts`, `ws-proxy/server.js`),
 * and the gateway dials the realm itself -- so the address the realm list advertises is exactly what
 * the client should ask for.
 *
 * This used to substitute a proxy host and keep only the realm's port, because the old scheme was one
 * `websockify` process per port with its target fixed at startup: the client had to aim at a listener
 * on the served host, and a realm on a port no process had been provisioned for was unreachable from a
 * browser at all. Nothing about that scheme is left, so nothing here rewrites anything; this function
 * remains as the one statement of the policy, and because every failure out of the transports names
 * the endpoint it tried.
 */
import { RealmInfo } from './types';

export function resolveRealmEndpoint(realm: RealmInfo): { host: string; port: number } {
  return {
    host: realm.host,
    port: realm.port,
  };
}
