#!/usr/bin/env node

/**
 * A WebSocket-to-TCP gateway.
 *
 * The relay is websockify's (Joel Martin, 2012, LGPLv3 -- see client/websockify.js), with one thing
 * changed: the TCP target arrives with each connection instead of being fixed at startup. One process
 * therefore serves logon and every realm on every port, which matters because a client learns a
 * realm's address at runtime and cannot be told to wait for a proxy to be provisioned for it.
 *
 *   node server.js --port 9000
 *
 *   ws://localhost:9000/?out=projectrx.net:3724   ->  TCP projectrx.net:3724
 *   ws://localhost:9000/tcp/projectrx.net:3724    ->  the same, the form the client already builds
 */

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = 9000;

/**
 * `$ALLOWED_TARGETS` -- which TCP targets this gateway will relay to.
 *
 * Unset means any, which is this gateway's original behaviour and the right one on a laptop. On a
 * public host it is an open TCP relay: anything on the internet could use it to reach any host and
 * port, which is a port scanner with someone else's return address. So a deployment states its
 * targets (`deploy/render.yaml` does) and everything else is refused during the upgrade.
 *
 * Entries are comma-separated and take two forms:
 *
 *   logon.gladewow.ru        the host, on ANY port -- realms live on the same host as logon, and a
 *                            client learns their ports at runtime from the realm list
 *   109.173.22.120:8085      one host and one port
 *
 * Matching is exact on the host, not by suffix: `gladewow.ru` does not admit
 * `anything.gladewow.ru`, because a wildcard here would hand over every subdomain a DNS operator
 * ever adds. Realm addresses often arrive as bare IPs rather than names, so the refusal below names
 * the target that was rejected -- that message is how you learn what to add.
 */
function parseAllowlist(raw) {
  const entries = (raw || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return entries.length ? entries : null;
}

function isAllowed(allowlist, host, port) {
  if (!allowlist) {
    return true;
  }
  const name = host.toLowerCase();
  return allowlist.includes(name) || allowlist.includes(`${name}:${port}`);
}

/** `--port N` / `--host ADDR`, else `$PORT`, else 9000 and every interface. */
function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || DEFAULT_PORT, host: undefined };

  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = splitFlag(argv[i]);
    const value = inline !== undefined ? inline : argv[i + 1];
    if (inline === undefined && (flag === '--port' || flag === '--host')) {
      i += 1;
    }

    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be 1-65535, got ${value}`);
      }
      opts.port = port;
    } else if (flag === '--host') {
      opts.host = value;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }

  return opts;
}

function splitFlag(arg) {
  const eq = arg.indexOf('=');
  return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * The TCP target for a request URL, or `{ error }` naming what is wrong with it.
 *
 * Two forms, both naming the same thing: `?out=host:port` is this proxy's own interface, and
 * `/tcp/host:port` is what the client's `gatewaySocketUrl()` emits, so the client reaches this
 * unchanged. The port is required either way -- a target without one is a mistake, not a default
 * worth guessing.
 */
function parseTarget(requestUrl) {
  const url = new URL(requestUrl, 'http://placeholder');
  const out = url.searchParams.get('out');
  const path = url.pathname.startsWith('/tcp/') ? url.pathname.slice('/tcp/'.length) : null;
  const raw = out || path;

  if (!raw) {
    return { error: 'no target: use ?out=host:port or /tcp/host:port' };
  }

  // Last colon, so a bracketless IPv6 literal fails on the host rather than silently losing octets.
  const idx = raw.lastIndexOf(':');
  if (idx < 0) {
    return { error: `target must be host:port, got "${raw}"` };
  }

  const host = decodeURIComponent(raw.slice(0, idx));
  const port = Number(raw.slice(idx + 1));

  if (!host) {
    return { error: `target has no host: "${raw}"` };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `target port must be 1-65535, got "${raw.slice(idx + 1)}"` };
  }

  return { host, port };
}

/** Pump bytes both ways until either side goes away, then take the other side with it. */
function relay(client, target, log) {
  const base64 = client.protocol === 'base64';

  target.on('data', (data) => {
    try {
      client.send(base64 ? data.toString('base64') : data, { binary: !base64 });
    } catch (e) {
      log(`client gone (${e.message}), closing target`);
      target.end();
    }
  });

  target.on('end', () => {
    log('target disconnected');
    client.close();
  });

  target.on('error', (e) => {
    log(`target error: ${e.message}`);
    target.destroy();
    client.close();
  });

  client.on('message', (msg) => {
    target.write(base64 ? Buffer.from(msg.toString(), 'base64') : msg);
  });

  client.on('close', (code, reason) => {
    log(`client disconnected: ${code} [${reason}]`);
    target.end();
  });

  client.on('error', (e) => {
    log(`client error: ${e.message}`);
    target.end();
  });
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n\nusage: server.js [--port N] [--host ADDR]`);
  process.exit(2);
}

const allowlist = parseAllowlist(process.env.ALLOWED_TARGETS);

const webServer = http.createServer((request, response) => {
  // `/healthz` exists for platform health checks, which expect a 2xx and would read this gateway's
  // honest `426` as a dead service and restart it forever. Everything else still answers 426, because
  // that is what a WebSocket-only endpoint should say to a plain GET.
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok\n');
    return;
  }

  response.writeHead(426, { 'Content-Type': 'text/plain' });
  response.end('426 Upgrade Required: this is a WebSocket-to-TCP gateway\n');
});

// `noServer` so a bad target is refused during the upgrade -- a client sees a failed connection with a
// stated reason instead of a socket that opens and dies.
const wsServer = new WebSocketServer({
  noServer: true,
  // websockify's selection, preferring 'binary'. A client that offers a subprotocol expects one named
  // back -- answering nothing makes a strict client fail the handshake with "sent no subprotocol".
  handleProtocols: (protocols) => {
    if (protocols.has('binary')) return 'binary';
    if (protocols.has('base64')) return 'base64';
    console.error(`refusing subprotocols [${[...protocols]}]: must offer 'binary' or 'base64'`);
    return false;
  },
});

let nextId = 1;

webServer.on('upgrade', (request, socket, head) => {
  const id = nextId++;
  const target = parseTarget(request.url);

  if (target.error) {
    console.error(`[${id}] refused: ${target.error}`);
    socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n${target.error}\n`);
    return;
  }

  if (!isAllowed(allowlist, target.host, target.port)) {
    const reason = `target not allowed: ${target.host}:${target.port}` +
      ' -- add it to $ALLOWED_TARGETS (host, or host:port)';
    console.error(`[${id}] refused: ${reason}`);
    socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${reason}\n`);
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (client) => {
    const log = (msg) => console.log(`[${id}] ${msg}`);
    log(`ws ${request.socket.remoteAddress} -> ${target.host}:${target.port}` +
        ` (${client.protocol === 'base64' ? 'base64' : 'binary'})`);

    const tcp = net.createConnection(target.port, target.host, () => log('target connected'));
    relay(client, tcp, log);
  });
});

webServer.listen(opts.port, opts.host, () => {
  console.log(`WebSocket-to-TCP gateway listening on ${opts.host || '0.0.0.0'}:${opts.port}`);
  console.log(`  ws://localhost:${opts.port}/?out=host:port   (or /tcp/host:port)`);
  // Printed at startup and not only on a refusal: "any host:port" is the risky setting, and a log line
  // is where someone looks when a target is unexpectedly refused -- or unexpectedly is not.
  console.log(allowlist
    ? `  targets: ${allowlist.join(', ')}`
    : '  targets: ANY -- set $ALLOWED_TARGETS before exposing this to the internet');
});
