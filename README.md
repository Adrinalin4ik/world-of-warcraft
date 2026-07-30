# world-of-warcraft

World of Warcraft (3.3.5a) rendered in the browser with WebGL.

Game assets are fetched over HTTP from a host serving loose, extracted client files, and every
format — BLP, WDT, ADT, M2, WMO, DBC — is parsed in the browser. There is no asset server to run and
no local copy of the game needed: StormLib and BLPConverter are no longer used.

## Client

```bash
cd client
npm install
npm run start
```

### Asset host

The client reads its asset host from `REACT_APP_DATA_URI`, set in `client/.env.development`:

```
REACT_APP_DATA_URI=https://data-direct.spelunkerdb.com/12340
```

Point it at any host that serves extracted 3.3.5a files as `<base>/<path>`, including a local static
directory. Paths are lower-cased with forward slashes before the request goes out, so
`DBFilesClient\Map.dbc` is fetched as `dbfilesclient/map.dbc`. A cross-origin host must send
`Access-Control-Allow-Origin`.

## Game server

`server/game-server` is the multiplayer piece and is unrelated to assets. The client points at it via
`gameServerUrl` in the same env file.
