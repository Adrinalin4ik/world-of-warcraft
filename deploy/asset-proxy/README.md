# Asset proxy — a CORS-adding mirror of the game-data host

A ~150-line Cloudflare Worker that forwards requests to the loose-file data host and adds the one
response header the browser needs. Deploy it when the client is served from anywhere other than
`http://localhost:3000` — a GitHub Pages site, a staging host, a LAN address.

## Why it is needed

Measured against the live host on 2026-08-10:

| Request | Result |
| --- | --- |
| `GET /12340/dbfilesclient/map.dbc` with `Origin: http://localhost:3000` | `200`, `Vary: Origin`, `Access-Control-Allow-Origin: http://localhost:3000` |
| the same `GET` with `Origin: https://<owner>.github.io` | `200`, **no** `Access-Control-Allow-Origin` |
| `OPTIONS` preflight from any origin | `403` |

Reproduce it with:

```sh
curl -s -D - -o /dev/null -A "Mozilla/5.0" \
  -H "Origin: https://<owner>.github.io" \
  https://data-direct.spelunkerdb.com/12340/dbfilesclient/map.dbc | grep -i access-control
```

The bytes arrive in every case; the browser is what discards them. The failure mode is quiet and
easy to misread: the page boots, the login screen draws (its frames come from the JS bundle), and the
world is empty with no message anywhere saying why. `CLAUDE.md` records this voiding an entire
performance comparison once.

There is a zero-infrastructure alternative to this worker: ask whoever runs the data host to add your
Pages origin to their allowlist. If they do, skip all of this and point `REACT_APP_DATA_URI` straight
at them.

## Deploy

```sh
cd deploy/asset-proxy
# edit wrangler.toml: ALLOWED_ORIGINS must name your Pages origin, or the worker 403s every browser
npx wrangler deploy
```

Then verify the header actually arrives — the header, not the status:

```sh
curl -s -D - -o /dev/null -A "Mozilla/5.0" \
  -H "Origin: https://<owner>.github.io" \
  https://wow-asset-proxy.<subdomain>.workers.dev/12340/dbfilesclient/map.dbc \
  | grep -i "^HTTP\|access-control"
```

Expect `200` plus `Access-Control-Allow-Origin: https://<owner>.github.io`. A `200` on its own is the
thing that looks fine and isn't.

## Point the client at it

Set the repository variable `REACT_APP_DATA_URI` (Settings → Secrets and variables → Actions →
Variables) to the worker URL **including the build sub-path**:

```
https://wow-asset-proxy.<subdomain>.workers.dev/12340
```

`UPSTREAM` in `wrangler.toml` is the host only, so the `/12340` lives in the client's setting and one
worker can mirror more than one build. Locally the same value goes in `client/.env.development.local`
or `client/.env.production.local` (both gitignored).

## Cost

Requests are pass-through and cached at Cloudflare's edge; a session's asset loads land well inside
the Workers free tier. Nothing here needs a paid plan, KV, or R2.
