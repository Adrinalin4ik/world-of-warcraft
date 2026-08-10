# ws-proxy

A WebSocket-to-TCP gateway. A browser cannot open a TCP socket, so every byte the client exchanges
with a 3.3.5 server crosses this.

It is `client/websockify.js` with the target moved out of the command line and into the connection URL.
One process serves logon and every realm on every port — no more `proxy1`/`proxy2` per-port scripts,
and a realm the client discovers at runtime is reachable without provisioning anything first.

## Run it

```sh
npm install        # one dependency: ws
npm start          # listens on 9000
```

```sh
node server.js --port 9000            # listen port; else $PORT, else 9000
node server.js --host 127.0.0.1       # bind address; else every interface
```

## Connect to it

The TCP target is named per connection, in either of two equivalent forms:

```
ws://localhost:9000/?out=projectrx.net:3724     # logon
ws://localhost:9000/?out=95.181.139.52:8086     # a realm
ws://localhost:9000/tcp/projectrx.net:3724      # what the client itself builds
```

`out=` is the interface to use by hand. `/tcp/host:port` is what
`client/src/network/protocol/connection-settings.ts` already emits from `gatewaySocketUrl()`, so the
client reaches this gateway with no changes — its `gatewayUrl` already defaults to
`ws://localhost:9000`.

The port is required. A missing or malformed target is refused with a `400` during the upgrade, naming
the reason, before any WebSocket or TCP connection is opened.

## What it logs

One monotonic id per connection, so interleaved connections stay readable:

```
[1] ws 127.0.0.1 -> projectrx.net:3724 (binary)
[1] target connected
[1] target disconnected
[2] refused: target must be host:port, got "projectrx.net"
```

## Which targets it will relay to

`$ALLOWED_TARGETS`, comma-separated. Unset means **any**, which is right on a laptop and an open TCP
relay on a public host — anything on the internet could use it to reach any host and port.

```sh
ALLOWED_TARGETS=logon.example.com               # that host, on any port
ALLOWED_TARGETS=logon.example.com,10.0.0.7:8085 # a host, and one host:port
```

Bare hosts are what realms need: a client learns a realm's port at runtime from the realm list, so the
ports cannot be listed in advance. Matching is exact on the host, not by suffix — `example.com` does
not admit `anything.example.com`.

A refused target answers `403` during the upgrade and names itself, in the response body and the log.
That message is how you learn what to add, which matters because realm addresses often arrive as bare
IPs rather than names. The startup log states the effective list, or warns that it is `ANY`.

## Deploying it

The client cannot reach a gateway on your machine from an https page — a browser blocks `ws://` from
https as mixed content before any request — so a deployed client needs a deployed gateway with TLS.

`render.yaml` at the repository root is a ready blueprint for Render's free plan: Render dashboard →
New → Blueprint → this repository. It sets `ALLOWED_TARGETS`, and it terminates TLS, which is why it
is worth using over a bare VPS. Two properties of the free plan to know: the service **spins down
after 15 minutes idle** and takes about a minute to wake, so the first login attempt after a pause can
time out and the second succeed; and WebSocket traffic counts as activity, so a live session keeps
itself up. See [`docs/github-pages.md`](../docs/github-pages.md) for how the client is then pointed at
it.

## Notes

- Binary frames by default; the `base64` subprotocol is honoured if a client asks for it and does not
  also offer `binary`.
- No TLS here. For `wss://`, terminate at Render, nginx or Caddy and proxy to this port.
- `/healthz` answers `200` for platform health checks. Every other plain GET answers `426 Upgrade
  Required`, which is this gateway being healthy — a health check pointed at `/` reads that as a dead
  service and restarts it forever.
