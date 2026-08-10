# Deploying the client to GitHub Pages

The whole client is static files, so Pages can host it. Two things about Pages break a build that
works on the dev server, and both are handled in the repo now: it serves the site from a **sub-path**,
and it serves it from an **origin the game-data host does not allow**.

## What is already wired

| Piece | Where |
| --- | --- |
| Build + deploy on push to `master` / `feature/remote-assets` | [.github/workflows/deploy-client.yml](../.github/workflows/deploy-client.yml) |
| `PUBLIC_URL=/world-of-warcraft` for the sub-path | `client/package.json` → `build:gh-pages` |
| Router `basename` from `PUBLIC_URL` | [client/src/app.tsx:43](../client/src/app.tsx#L43) |
| `404.html` SPA fallback, so a reload of `/world-of-warcraft/game` works | [client/scripts/gh-pages-postbuild.js](../client/scripts/gh-pages-postbuild.js) |
| Gateway URL and logon host derived from the served page, `wss://` under https | [client/src/network/protocol/connection-settings.ts](../client/src/network/protocol/connection-settings.ts) |

## One-time repository setup

1. **Settings → Pages → Build and deployment → Source = "GitHub Actions".** With the branch source
   selected instead, the workflow runs green and nothing ever appears on the site.
2. **Settings → Secrets and variables → Actions → Variables → `REACT_APP_DATA_URI`.** Set it to an
   asset host that allows your Pages origin — see below. Without it the site deploys and loads no
   game data.

If the repository is ever renamed, or moved to a user/organisation page or a custom domain,
`PUBLIC_URL` in `build:gh-pages` is the single value to change. For a domain root it becomes an empty
string, not `/`.

## The sub-path

`PUBLIC_URL` covers the bundle, `%PUBLIC_URL%` covers `index.html`, and the router's `basename`
covers the routes. What it does **not** cover is a root-absolute URL written by hand: a
`url('/assets/…')` in a stylesheet resolves against the server root and 404s under
`/world-of-warcraft/`. The six border-image files that did this now live in `src/` beside the styles
that use them and are referenced relatively, so webpack rewrites them with `output.publicPath` —
see the comment at the top of [client/src/styles/ui/frame/index.scss](../client/src/styles/ui/frame/index.scss).
Anything new under `client/public/` referenced from code needs `process.env.PUBLIC_URL` in front of it.

## The asset origin (this is the one that bites)

The default data host sends `Access-Control-Allow-Origin` for `http://localhost:3000` and for nothing
else, and answers preflights with `403` — measured, with the commands to reproduce it, in
[deploy/asset-proxy/README.md](../deploy/asset-proxy/README.md). From a `github.io` origin every asset
fetch is blocked by the browser, and the symptom is not an error page: the app boots, the login screen
draws out of its own bundle, and the world is empty.

Two ways out:

- Ask the host's operator to allowlist your Pages origin, then point `REACT_APP_DATA_URI` at them.
- Deploy [deploy/asset-proxy/](../deploy/asset-proxy/) — a Cloudflare Worker that mirrors the host and
  adds the header — and point `REACT_APP_DATA_URI` at it.

## What still will not work on Pages, and why

- **`/game?offline=1`** needs nothing at all: a real world map, no server.
- **Connecting to a game server needs a gateway that Pages cannot host.** The client talks to
  realmd/worldd through `ws-proxy/server.js`, a WebSocket-to-TCP gateway, because a browser cannot open
  a TCP socket. Pages hosts static files only, so the derived default (`wss://<the page's host>:9000`,
  from `servedGatewayUrl()`) points at nothing and the login screen times out.

## Pointing the client at a deployed gateway

[`render.yaml`](../render.yaml) deploys `ws-proxy` on Render's free plan, which terminates TLS — the
reason a hosted gateway is needed at all is that an https page may not open a `ws://` socket, so a
gateway on your own machine is unreachable from the deployed client no matter what. Then:

```
https://<owner>.github.io/world-of-warcraft/?ui=lua&realmlist=logon.example.com:3724&gateway=wss://wow-ws-gateway.onrender.com
```

`?gateway=` takes the **base URL only** — `gatewaySocketUrl()` appends `/tcp/<host>:<port>` itself from
`?realmlist=`, so passing a `/tcp/...` path yourself produces it twice. Both overrides are read by
`applyGatewayOverride` / `applyRealmlistOverride`, and the URL wins for the session it is in; logging in
saves it.

Two things about the free plan that look like client bugs: the service spins down after 15 minutes idle
and takes ~1 minute to wake, so the first attempt after a pause can time out where the second succeeds;
and the gateway refuses any target not in `$ALLOWED_TARGETS` with a `403` naming it, which is what you
will see if a realm's world server arrives as an IP that isn't listed yet.

## Verifying a deployment

`npx tsc --noEmit` and `npm test` are separate gates and the workflow runs both. Neither says anything
about whether assets load, which is the failure this page is mostly about — so after a deploy, open the
site with the network panel and confirm `.adt`/`.blp`/`.dbc` requests return 200 **and** are not
CORS-blocked. A screenshot of a drawn world is the only claim worth making; the sky animates and
characters blink, so a pixel diff is not.
