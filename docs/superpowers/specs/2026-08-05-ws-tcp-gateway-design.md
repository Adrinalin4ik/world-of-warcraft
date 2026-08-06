# WebSocket-to-TCP Gateway — Design

**Date:** 2026-08-05
**Status:** Approved
**Scope:** A standalone, self-contained replacement for `client/websockify.js`: one process, one listen
port, target chosen per connection by the connection URL. Lives at `ws-proxy/` with its own
`package.json` and `node_modules`.

---

## 1. Problem

A browser cannot open a TCP socket, so every byte the client exchanges with a 3.3.5 server crosses a
WebSocket-to-TCP proxy. Today that proxy is [`client/websockify.js`](../../../client/websockify.js), a
2012 vendored copy of websockify whose target is fixed at startup:

```
node websockify.js 3724 projectrx.net:3724
```

Three consequences:

**One process per target port.** `client/package.json` already carries `proxy1` (logon, 3724) and
`proxy2` (a realm, 8086) as separate scripts, and any realm advertising a third port needs a third
process provisioned before a player can reach it. The client cannot discover a realm's address at
runtime and then dial it, because the proxy for that address may not exist.

**It lives inside the client's dependency tree.** Running the proxy means installing the client's
~120 packages. Its own three dependencies (`ws`, `optimist`, `policyfile`) are listed among them, so
the proxy's needs and the web app's needs are indistinguishable.

**It carries dead weight.** A static file server (`--web`), an HTTPS/cert mode, and a Flash
`policyfile` responder — the last two are the reason `optimist` and `policyfile` are dependencies at
all.

What already exists and this must fit: [`connection-settings.ts`](../../../client/src/network/protocol/connection-settings.ts)
defaults `gatewayUrl` to `ws://localhost:9000` and `gatewaySocketUrl()` builds `<gateway>/tcp/<host>:<port>`.
The client, in other words, already assumes a gateway that takes its target from the URL.

## 2. Approach

A new `ws-proxy/` at repo root: one listening port, the TCP target read from each connection's URL.

```
node server.js --port 9000

ws://localhost:9000/?out=projectrx.net:3724   ->  TCP projectrx.net:3724
ws://localhost:9000/?out=95.181.139.52:8086   ->  TCP 95.181.139.52:8086
```

A single running process serves logon and every realm on every port. `websockify.js` stays where it
is; nothing in the client is changed by this spec.

### 2.1 Target address

Two accepted forms, both naming the same thing:

| Form | Example | Why |
|---|---|---|
| Query | `/?out=host:port` | This spec's interface; convenient by hand |
| Path | `/tcp/host:port` | What `gatewaySocketUrl()` already emits, so the current client reaches this proxy unchanged |

`out` wins if both appear. The port is required in both forms — a target without one is a mistake, not
a default worth guessing.

Rejected: an `in=<port>` parameter mirroring websockify's source argument. A WebSocket client cannot
ask the server to open a listening port; it connects to one that already exists. The listen port is
therefore process configuration (§2.2), not per-connection data.

### 2.2 Process configuration

| Setting | Flag | Fallback |
|---|---|---|
| Listen port | `--port N` | `$PORT`, then `9000` |
| Bind address | `--host ADDR` | all interfaces |

Deployments serve the app from a real hostname, so binding everywhere is the useful default and
`--host 127.0.0.1` is the way to restrict it.

### 2.3 Validation

A missing or malformed target is refused during the HTTP upgrade — `400` with a one-line reason, the
socket destroyed, no WebSocket opened. A client then sees a failed connection it can report, rather
than a socket that opens and dies for no stated reason. The proxy never opens a TCP connection for a
request it is going to refuse.

Malformed means: no `out` and no `/tcp/` path; an empty host; a port that is not an integer in
1–65535.

### 2.4 Relaying

Ported from `websockify.js`, behaviour unchanged:

- On connection, `net.createConnection(port, host)`; bytes flow both ways from then on.
- If the client negotiated the `base64` subprotocol, target-to-client data is base64 text and
  client-to-target messages are base64-decoded. Otherwise binary frames, `{binary: true}`.
- `end`, `error`, or `close` on either side ends the other. A send to a closed client ends the target.

Dropped: `--web`, the cert/HTTPS mode, and the `policyfile` responder. TLS belongs at a reverse proxy
(nginx/Caddy) rather than in this file, which keeps `ws` the single dependency.

### 2.5 Logging

Each connection gets a monotonic id, so interleaved connections stay readable:

```
[1] ws 127.0.0.1 -> projectrx.net:3724 (binary)
[1] target connected
[1] target closed, closing ws
[2] refused: out must be host:port
```

## 3. Files

| Path | Contents |
|---|---|
| `ws-proxy/package.json` | name, `start` script, one dependency: `ws` |
| `ws-proxy/server.js` | argument parsing, target parsing, upgrade validation, the relay (~120 lines) |
| `ws-proxy/README.md` | what it is, how to run it, the URL forms, the `gatewayUrl` connection to the client |
| `ws-proxy/.gitignore` | `node_modules/` |

`server.js` splits into three named units: `parseArgs(argv)`, `parseTarget(requestUrl)` (returns
`{host, port}` or an error string), and `relay(ws, target)`. The first two are pure functions of their
input — the parts most worth being able to reason about without a socket in hand.

## 4. Testing

Manual, matching how the thing is used:

1. Start the proxy; connect the client with `gatewayUrl` = `ws://localhost:9000` and log into a real
   3.3.5 server — logon on 3724 and a realm on its own port, through the one process.
2. `?out=` form by hand against logon; confirm the same handshake bytes flow.
3. Bad input: no `out`, `out=host` (no port), `out=host:0` — each a `400` naming the reason.
4. Unreachable target: connection error logged, WebSocket closed, proxy still serving.

No committed test suite: the proxy's whole behaviour is two sockets and an OS network stack, and the
two pure parsers are small enough that a real login exercises them more honestly than a unit test
would. A throwaway script (echo target + spawned proxy + real `ws` clients) covered items 2–4 above
during implementation; it caught one real defect — answering a client's subprotocol offer with nothing,
which makes a strict client fail the handshake with "Server sent no subprotocol" — and is kept out of
the repo rather than maintained.

## 5. Out of scope

- Changes to the client. Its default `gatewayUrl` and `gatewaySocketUrl()` already match §2.1.
- Removing or editing `client/websockify.js`, or the `proxy*` scripts in `client/package.json`.
- A target whitelist. Worth adding if this is ever exposed publicly, where it would otherwise be an
  open relay; not needed for local and single-deploy use, and easy to add later at §2.3's one
  validation point.
