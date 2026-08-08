# Project rules

A browser-based World of Warcraft 3.3.5a (build 12340) client: React 19 + three.js + TypeScript,
running the game's own data served over HTTP.

## The UI is Lua. This is not negotiable.

**Every screen and every frame must be the client's own XML and Lua, executed by the FrameXML
runtime** — the same way login, the realm list and character select already work. Do not hand-build
a frame, a button or a panel in TypeScript, not even as a stopgap, not even "structured so the real
one can replace it later". A hand-built frame is a frame no addon can hook, and running addons is
the point of the whole runtime.

TypeScript's job is the **engine side**: the widget layer the XML draws onto, the Lua VM, and the
engine globals the client's Lua calls (`UnitName`, `GetCharacterInfo`, `SetCharSelectBackground`, …).
When a screen is missing something, the question is always "which engine global is absent", never
"what should I draw".

A gap you cannot close goes through the `notImplemented` factory so the load report names it. Never
a silent no-op — a silent stub is how a screen renders plausibly and wrongly.

## `samples/benilla/` is the authority

The Rust reference this project ports from. It runs the game's own FrameXML through `mlua` with
`lua51`. Its `crates/benilla-ui/src/` — `toc.rs`, `framexml.rs`, `loader/`, `script/`, `order.rs`,
`layout.rs`, `widget/` — is the shape our runtime follows, and `benilla-m2`, `benilla-dbc`,
`benilla-protocol`, `benilla-assets` are the references for their own areas.

Where our code and benilla disagree about how a document loads, a template expands, a script binds,
a frame orders, or a model is dressed, **benilla is right** unless the game's own files show
otherwise. Cite its file and line when you take a decision from it.

Port what it actually does. Do not substitute an approximation, and do not rule something out of
scope without a stated reason.

One thing it is *not* the authority on: benilla **never loads `FrameXML.toc` or `GlueXML.toc`** —
it runs its own authored XML and Lua (`crates/benilla-ui/.../ui_script/mod.rs:399-411`). So the rule
it demonstrates is "the UI is XML and Lua executed by the runtime", not "load Blizzard's manifest".
This client already loads the real manifest further than benilla attempts, so on manifest loading we
are ahead of the reference and the game's own files are the only oracle.

## Read the real file before building on a claim

Nearly every requirements defect on this project was caught by someone opening the actual XML, Lua,
DBC or packet capture instead of trusting a summary — including summaries written by me. Values in
a brief are a starting point, not the law. If a claim and the data disagree, the data wins and the
disagreement is worth reporting.

Corollary: before declaring a value unsourced, read the **whole** file. One "fabrication" removed
here turned out to have its source 2408 lines below where anyone had looked.

## Measure before fixing; distrust the instruments

Five plausible diagnoses have failed on a single bug here where one measurement then found it in a
step. Build the instrument first.

And check the instrument itself. This codebase has produced: two debug panels that read zero while
the world is fine, a "pixel-identical" measurement that was not, and an instrument a fix would have
blinded. A number that confirms your hypothesis deserves more scepticism than one that refutes it.

State a noise floor before claiming an improvement. Run-to-run spread has repeatedly covered an
entire claimed change.

## Tests

**Happy path only, and few.** Two per task at most, one where one will do. Cover the path that
matters; add a test when something breaks and stays broken. Do not enumerate edge cases.

## Verification

- `npx tsc --noEmit` and `npm test` are **separate** checks. Babel type-checks nothing, so a fully
  green jest run has repeatedly coexisted with a type error. Run both.
- Visual claims need a screenshot. Many visual "successes" here did not reproduce when checked.
- Pixel diffs are useless in the world and on the glue screens: the sky animates, the dragon moves,
  and characters blink.

## Comments are the design record

Cite real file, line, DBC column or opcode evidence — or write plainly that a value is unexplained.
A comment that invents a source, or that still describes a gap now closed, is treated as a defect.

## Environment

- **The dev server needs Node 18** (`node-sass`'s binding is Node-18 ABI). `node scripts/start.js`
  from `client/`. The first cold load takes well over 30 s to boot `window.glueRuntime`.
- **The asset host CORS-allowlists `localhost:3000` and nothing else.** A dev server on any other
  port loads no terrain, no doodads and no models — so the page comes up, the world is empty, and
  nothing announces why. This silently voided one agent's whole performance comparison (half the
  doodads, 40% of the triangles) and can make a broken screen look fixed. Verify on 3000, or use
  `scratchpad/asset-proxy.js` with a gitignored `.env.development.local`. **State which port
  produced a screenshot.** This makes an isolated worktree unverifiable in a browser on its own —
  merge first, then verify.
- In a `.claude/worktrees/...` path, `node scripts/test.js` reports success while finding **0
  tests**: the `.claude` component breaks micromatch's `<rootDir>` glob. Check the suite and test
  counts, or pass an explicit `--testMatch`.
- `ws-proxy/server.js` (port 9000) must run for any game connection. It answers plain HTTP with
  **426 Upgrade Required** — that means healthy.
- The FrameXML UI is behind **`?ui=lua`**. Plain `/` deliberately still serves the hand-written
  transcription, which is the oracle the runtime is compared against.
- `/game?offline=1` loads a real world map with no server.
- Game data: `https://data-direct.spelunkerdb.com/12340` — the host rejects some user agents, so use
  `curl`, not urllib.
- Never write credentials into a committed file; pass them via argv.

## Known traps

- `packet.readByte(N)` does **not** skip N bytes — its argument is the byte ORDER.
- `zlib.inflate`'s callback in `zlib-browserify` is argument **2**, not 3.
- `model.scale.setScalar()` is **inert** under `matrixAutoUpdate = false`.
- three's `projectObject` returns before walking children when `visible === false`.
- Guids: a 64-bit guid does not survive a JS number. `network/guid-hex.ts` is the single formatter.
- A `#pragma glslify: import(...)` chunk is invisible to webpack's watcher.
