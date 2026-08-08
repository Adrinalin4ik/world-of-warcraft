/**
 * `CMSG_TIME_SYNC_RESP` (0x391), the answer this client owed `SMSG_TIME_SYNC_REQ` (0x390) and never
 * sent.
 *
 * MEASURED, not assumed. A five-minute sit in the world on `becd1df` (scratchpad `D1-net.txt`) shows
 * the server sending `SMSG_TIME_SYNC_REQ` on a ten-second beat -- t+1.6, 24.0, 24.1, 31.7, 41.7,
 * 51.7 s -- while the ONLY packet this client sent in the whole session was one `CMSG_PING` at
 * t+46.6 s, which was answered with `SMSG_PONG`. At t+58.7 s the game server closed the TCP
 * connection: the gateway log for the same run reads `[2] target disconnected` BEFORE
 * `[2] client disconnected: 1005`, so the close came from the realm, not from the browser and not
 * from `ws-proxy`, whose relay has no timeout of any kind (`ws-proxy/server.js` sets none, and
 * `net.Socket`'s default is none).
 *
 * The body is the counter echoed back, then the client's own tick count in milliseconds. The server
 * subtracts the two to learn the client's clock offset, which is why an unanswered request is not
 * cosmetic: every timestamp in an inbound `MovementInfo` is in the client's timebase, and the server
 * cannot check a single one of ours until it has this.
 *
 * `clientTicks` is a uint32 of milliseconds. It is taken from a monotonic origin captured when this
 * module loads rather than from `Date.now()`, whose low 32 bits are an arbitrary point in 1970-epoch
 * milliseconds -- the server treats the value as a tick count and a wall-clock one would make the
 * first delta it computes enormous.
 */

/** Counter and ticks, both uint32 little-endian. */
export const TIME_SYNC_RESP_BODY_BYTES = 8;

const origin = typeof performance === 'undefined' ? Date.now() : performance.now();

/** Milliseconds since this client started, wrapped into the uint32 the wire carries. */
export function clientTicks(): number {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now();
  return Math.floor(now - origin) >>> 0;
}

export function encodeTimeSyncResponse(counter: number, ticks: number): Uint8Array {
  const body = new Uint8Array(TIME_SYNC_RESP_BODY_BYTES);
  const view = new DataView(body.buffer);
  view.setUint32(0, counter >>> 0, true);
  view.setUint32(4, ticks >>> 0, true);
  return body;
}
