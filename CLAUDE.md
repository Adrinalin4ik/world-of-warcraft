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

**benilla is 1.12.1, and this client is 3.3.5a.** It is authoritative on *structure* — how a document
loads, how a template expands, how a model is dressed, how a spline is followed, how a unit's scale is
chosen. It is **not** authoritative on any version-numbered value. Update-field offsets are the sharp
case: benilla puts health at 22 and level at 34; here they are 24 and 54. Take mechanism from the
reference and take numbers from the game's own data.

One thing it is *not* the authority on either: benilla **never loads `FrameXML.toc` or `GlueXML.toc`** —
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

And distrust a NEGATIVE the same way. A probe that reports the feature broken deserves the same
scepticism as one that reports it fixed: two rounds here wrote up "the right-click never arrives" and
"the classifier is silent" when the code was fine — the first because Playwright's `mouse.click(...,
{button:'right'})` does not reach our handler while a separated move/down/up does, the second because
the probe read a property off something that was a function. A negative that confirms your worry is
still a number that agreed with you.

- **The world UI host can be double-mounted with one copy disposed, so `window` handles go stale
  mid-probe.** Hold the runtime reference you were given and never re-read `window.worldRuntime`
  between reads. This has now voided four measurement arms: a `uiDrawStats` replaced mid-run, a
  portrait cost arm that captured 2 frames, a `GetScript` that read `nil` then `function`, and a
  `UIErrorsFrame` arm that went "in draw list" → "not registered" and tore the VM down. A handle that
  changes answer between two reads is the host settling, not the feature. Capture the reference AFTER the mount
  settles, and validate one you are holding by running a trivial chunk through it: a disposed copy
  keeps its object graph but its `lua_State` is gone, so touching it dies inside fengari rather than
  returning an error.
  Three faces of this have now cost arms, and one rule covers all of them: **existence at boot proves
  nothing; ticking at the moment of use is the only test that has held.** Assert the handle is the
  right *type*, read its counter twice, and require it to have **advanced** — then report `VOID`
  rather than a number if it has not.
- **World population varies by spawn, so poll it — never sleep a guessed amount.** The same probe at
  the same elapsed time saw **1** entity in one run and **72** in the next. An arm that needed an NPC
  and slept instead produced two panes of placeholder art and a ratio measured against nothing; it was
  declared void, which is the only honest end for it. Poll `entities.size` (or whatever the arm
  actually depends on) and say `VOID` when the world never populated.
- **This runtime fires no general `OnUpdate` — it hand-picks named frames. So any client code whose
  RECOVERY from a temporary state lives in an `<OnUpdate>` leaves that state PERMANENT.** The quest
  detail page was blank because `QuestInfo_ShowFadingFrame` unconditionally does `SetAlpha(0)` plus
  `acceptButton:Disable()` and only `QuestInfoFadingFrame_OnUpdate` undoes either — so the panel sat at
  alpha 0 for ever, and the panel it blanked is the one the objectives, the group line and the whole
  reward block get parented into. It read as "no animation"; it was "no panel". Three more instances
  were closed in the same round by forcing `QUEST_FADING_DISABLE`, whose default hands recovery to a
  *different* unfired `OnUpdate`.
  **So before concluding a blank frame is a missing global, grep it for `SetAlpha(0)` and `:Disable()`
  in an `OnShow` or a display path**, and check what is supposed to undo them.
- **A silent gap is indistinguishable from a bug, and the load report is not where the owner looks.**
  Fifteen unit-popup rows read as broken when 26 of them were honest `notImplemented` gaps. An
  **action** the owner invoked should say so where he already sees refusals — `UIErrorsFrame`, the
  client's own red line. A **getter** must stay silent: `UnitPopup_HideButtons` calls them on every
  open, so a notice there reddens the screen once per right-click.

State a noise floor before claiming an improvement. Run-to-run spread has repeatedly covered an
entire claimed change.

## Performance is a standing requirement, not a phase

The owner has asked for this explicitly and more than once: **always think about performance.** Every
feature carries a cost question, and it is answered with a number or it is not answered.

What this project has already paid for, and what it bought:

- The interface renders to an **offscreen target redrawn only when a draw-list fingerprint changes** —
  worth 4-7.5 ms on ~92% of frames. Anything that dirties that every frame hands the whole saving
  back. The cooldown sweeps, the selection ring and the nameplates each measured a fingerprint cost of
  **zero** by drawing outside the widget list; that is the pattern to copy.
- `scene.matrixWorldAutoUpdate = false` took the render section from 8.1 ms to 1.9 ms by not walking
  31k static nodes every frame.
- The interface froze for **10.1 s** because fengari's `luaL_ref`/`luaL_unref` are O(live handles) over
  a JS `Map`. Handles now index our own table, freed with a sentinel so no key is deleted.
- Startup built **457 collision BVHs over 793,919 triangles and read them 0 times** — 1.5 s of pure
  waste, found by an instrument that counted reads as well as builds.
- A persistent asset cache took a warm load from ~2550 requests / ~90 MB to **6 requests / 0.00 MB**.

So: state the cost of what you add, measure the arm without it, and give the noise floor first. A
feature that is correct and 5 ms slower per frame is not finished. Prefer moving work off the critical
path or into the existing worker pool over doing less of it — the UI is the client's own Lua and every
frame must still be built.

## Tests

**Happy path only, and few.** Two per task at most, one where one will do. Cover the path that
matters; add a test when something breaks and stays broken. Do not enumerate edge cases.

## Verification

- `npx tsc --noEmit` and `npm test` are **separate** checks. Babel type-checks nothing, so a fully
  green jest run has repeatedly coexisted with a type error. Run both.
- **`npm test` defaults to WATCH mode and never exits**, producing empty output and a task that hangs
  until something reaps it. Use `CI=true node scripts/test.js --watchAll=false`. Two rounds lost
  measurements to this and read the empty output as a passing suite.
- Visual claims need a screenshot. Many visual "successes" here did not reproduce when checked.
- Pixel diffs are useless in the world and on the glue screens: the sky animates, the dragon moves,
  and characters blink.
- **A gate taken on a convenient route can miss the bug entirely.** The loading screen was gated on
  `?ui=lua` into the offline world, passed, and never drew on a real login — offline worldports the
  player *later* in the same method, so it was the one ordering where the race could not lose.
  Verify on the path the owner actually walks, not the one that was easy to instrument.
- **The owner will look for you, and has said so.** When something is hard to verify from here —
  cursors (a Playwright screenshot contains no OS pointer), a colour, a layout, anything where the
  instrument is the doubtful part — hand it over and ask. That is faster and more honest than a
  claim propped up by a weak gate.
- **Visual verification is the OWNER'S, not yours. Do not attempt it.** He has said so three times, the
  last one flatly: "все визуальное я проверю сам, просто пиши мне список того что нужно проверить."
  So do not stage a login to look at a frame, do not screenshot a colour, do not build a rig to
  photograph a menu. **End your round with a numbered list of what he should do and what he should
  see** — the route, the gesture, the expected result — and spend the round on the work instead. He has
  checked every round this way and it has been faster and more accurate than any gate built here.
  The test window is for **measurement**, not for looking: a timing, a residual, a dirty-frame ratio,
  a packet count, a wire shape. Those are still owed, because they are the half he cannot check by
  looking.
- **Two attempts, then ask — and prefer asking sooner.** If a visual check has not worked twice, stop
  and hand it to the owner instead of building a third instrument. He has said so plainly, twice: "Я
  всегда готов помочь, чтобы сэкономить время" and "Don't spend too much on validation. I can check it
  for you." So do not build a rig to photograph something he can see in a second — spend the round on
  the work, and name precisely what you want him to look at and on what route. This does **not** relax
  measurement: a number — a count, a timing, a residual, a dirty-frame ratio — is still owed for
  anything performance- or correctness-critical, because that is the part he cannot check by looking.

## Parallel agents write; ONE tests at a time

Agents may write and commit in parallel. **Live testing is serialised.** The dev server recompiles on
every save, so a second agent saving a file mid-probe reads as a defect in the thing being probed:
one round lost several probe runs to recompiles and one red test suite to a neighbour's in-flight
edit, and diagnosed neither until afterwards.

The protocol:

- **No live browser run without a granted test window.** Ask the coordinator, then wait. Batch the
  round's live work into that one window instead of probing continuously as you go.
- **While a window is open, everyone else stops writing to disk.** Reading, grepping, planning and
  decoding files are all fine — a `git status` that changes nothing cannot break a probe.
- **Say when you are done** so the window closes. A window nobody released is the same stall as no
  protocol at all.
- Static work needs no window: `tsc`, the suite, byte-level decoding of a served asset, reading the
  reference. Only the browser and the game connection are contended.

The coordinator grants windows one at a time and tells the others to hold. If a probe result looks
impossible, suspect a mid-edit recompile before suspecting the code, and say so rather than working
around it silently.

## The owner's build and this working tree are the same files

**While the owner is testing, no agent may be live in this tree.** The dev server recompiles on every
save, so an agent's half-written file is served straight into his browser. This has produced a
"loading never finishes, then it falls back to offline" report that was five mid-edit files and
nothing else — an hour on a false trail. Stop the agents, then let him look.

For the same reason: **read in-flight work before parking or discarding it.** Stashing an interrupted
agent's five modified files reverted a finished fix along with the scratch work; `git stash show -p`
would have separated them in one command. Park with `git stash push -- <paths>`, never a blanket
reset, and never `git add -A` — a blanket add has already swept one agent's files into another's
commit, leaving a message that no longer described its contents.

## Comments are the design record

Cite real file, line, DBC column or opcode evidence — or write plainly that a value is unexplained.
A comment that invents a source, or that still describes a gap now closed, is treated as a defect.

The sharper version, and it has now happened five times with three by one agent: **a commit message
that asserts a correction never made.** One said "that sentence is now false and the header says so"
while the header still carried the old claim, untouched. A comment can go stale by neglect; a commit
message is the permanent record and lies on purpose. **Re-read the file against your own message
before committing** — that is how all five were caught, and the same habit found a defect in every
recent round.

## Environment

- **The dev server needs Node 18** (`node-sass`'s binding is Node-18 ABI), and **`node` on PATH is not
  reliably 18** — it has reported 18.20.8 and 20.19.4 in the same session. Name the binary:
  `"$LOCALAPPDATA/nvm/v18.20.8/node.exe" scripts/start.js` from `client/`. Started under Node 20 the
  server still **serves a 9 MB bundle and answers 200**, with a `resolve-url-loader` failure on
  `app.scss` baked into it, so the page loads and `window.session` is never defined. A healthy port is
  not a healthy app: check that `session` exists, not that the bundle downloads. The first cold
  compile takes about a minute, and the first page load well over 30 s more.
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
- **`python` works; `python3` does NOT.** `python --version` is 3.13.5, while `python3` hits the Windows
  Microsoft-Store alias stub and prints an install advert to stdout -- which looks like a broken script,
  not a missing binary. Two people lost time to this in one session. `py` is absent too.
- **The asset host is CASE-SENSITIVE.** `Spells/LevelUp/LevelUp.m2` 404s where the all-lowercase path
  answers 200. The client`s own files name paths in mixed case with backslashes, so a lookup that does
  not lowercase looks exactly like a missing asset — and a 404 returns an HTML page, which downstream
  code then fails to *decode*, naming the wrong subsystem twice over.
- Game data: `https://data-direct.spelunkerdb.com/12340` — the host rejects some user agents, so use
  `curl`, not urllib.
- Never write credentials into a committed file; pass them via argv.

## Known traps

- **`0` IS TRUTHY IN LUA**, so an engine global that means "nothing" must return **nil**, not 0. Three
  occurrences now, twice in `skills-bridge.ts` alone: `stepCost`/`rankCost` rendered every skill row as
  "Learn <skill>", and `isAbandonable` returning 0 put an Unlearn button on every skill -- with a comment
  directly above it that already said a truthy value would do exactly that. Writing the warning down is
  not the same as returning nil.
- **A wire test that builds its fixture from the widths it reads proves SELF-CONSISTENCY, not
  correctness.** It cannot catch a wrong width, which is the most repeated defect class in this project
  — eleven instances across items, merchants and quests, every one silent. Only a **residual against
  real traffic** settles a layout: decode a captured body and assert nothing is left over. Until a
  packet has been through that, say "self-consistent" rather than "verified".
  Better still, make the residual **name the error instead of only reporting one**. For a body shaped
  `header + count * stride + tail`, divide the remainder by the wire count: a whole number puts the
  error **inside the row and says by how many bytes** (a `u8` read where a `u32` sits is +3, an
  inserted word +4); `null` with a nonzero remainder means the stride is right and the header or tail
  moved; a throw means we over-read, so the stride is too large — which neither of the others can
  express. Stash the header **before** the row loop, the only placement that survives a throwing one.
  And feed the diagnostic two deliberately wrong bodies: a fixture that only ever sees correct input
  is the arm a self-built fixture cannot be.
- **A field widened between 1.12 and 3.3.5a fails SILENTLY, with no reply at all.** Six have been found
  in the item area alone: the vendor row (7 words → 8), `CMSG_SELL_ITEM`'s count (`u8` → `u32`),
  `CMSG_REPAIR_ITEM` (16 B → 17), `CMSG_SPLIT_ITEM`'s count (`u8` → `i32`) and
  `CMSG_DESTROYITEM`'s (`u8` → `u32`) — plus six more in the quest area, one of which makes a 1.12
  read land its strings 8 bytes early. (A sibling trap in the same area is NOT a width and does not
  fail silently: `BUYBACK_SLOT_START` moved 69 → 74.) A short body makes the server's `ByteBuffer`
  read past the end and throw; the packet is discarded and **nothing comes back**, so the gesture looks
  inert rather than refused — and no `SMSG_*_FAILURE` will ever explain it. When a send produces
  silence, suspect a width before suspecting the handler.
  **When a send produces silence and you cannot capture the wire, prefer the LONGER body.** A server
  `ByteBuffer` throws only on an under-read; trailing bytes it never reads are ignored. So 16 bytes is
  required if a third word exists and harmless if it does not, while 12 is fatal in the first case —
  the asymmetry is free. But check the shared helpers: two quest sends must **stay** at 12, and
  widening the helper would have fixed one send while silently breaking two.
- **When two agents fix one cascade from different ends, the second can consume a flag the first
  depends on — and both authors' tests still pass, because neither covers the pair.** A `SetParent`
  re-point marked the loader's default fill as an authored placement, which is exactly what the other
  fix relied on being unmarked; two correct changes cancelled. **The tell was that the symptom did not
  move after a fix that should have moved it.** So re-run your own instrument after someone else lands
  in your area, not only after your own change — and when a fix provably lands and changes nothing,
  suspect a neighbour before suspecting your diagnosis.
- **Prefer the reference's BYTES over the reference's RATIONALE when the two can be separated.** A
  comment here trimmed three "trailing bytes the server discards" as 1.12 slack; in 3.3.5a they are the
  high three bytes of a `u32` count. The reference's byte sequence would have worked verbatim — a `u8` 0
  plus three zeros *is* a little-endian `u32` 0 — so the explanation broke a packet that had been
  correct by accident.
- **Read a packet's `Read()` order, never its declaration order.** `CMSG_SPLIT_ITEM` is source-first
  while `CMSG_SWAP_INV_ITEM` in the same handler is destination-first.
- `packet.readByte(N)` does **not** skip N bytes — its argument is the byte ORDER.
- `zlib.inflate`'s callback in `zlib-browserify` is argument **2**, not 3.
- `model.scale.setScalar()` is **inert** under `matrixAutoUpdate = false`.
- three's `projectObject` returns before walking children when `visible === false`.
- Guids: a 64-bit guid does not survive a JS number. `network/guid-hex.ts` is the single formatter.
- **A DRAW CALL IS NOT A PIXEL, AND A REGISTERED HANDLER IS NOT A DISPATCHED ONE.** Four fixes by three
  agents once landed in the owner's build and did nothing, each having passed a headless harness — and
  the one that was diagnosed proved why the harness could not have caught it: `quad.visible` was true,
  the render call executed, the draw call was issued, the triangles were counted, and **not one pixel
  landed**, because the UI's Y-down camera mirrors the projection and three compensates winding only
  for an object's own matrix, never for the camera's. Every piece of *state* was right; only the
  *effect* was missing. So a harness that asserts a handler ran, a value was set or a range was
  announced is asserting state. **When a fix is live and inert, look at the LAST HOP** — where the
  value reaches the thing that actually renders or dispatches — not at the state you already verified.
- **Adopting a camera means adopting its whole convention, including the MATERIAL.** A hand-built
  `MeshBasicMaterial` defaults to `FrontSide` and is culled under the Y-down UI camera; the shared
  quad-material factory is where that requirement lives. Grep for a convention's existing home before
  moving anything onto it — the answer was three files away and one search would have found it.
- **Every orientation defect here has been TWO CONVENTIONS MEETING, never a wrong texture — three for
  three — and none was fixed by negating a coordinate.** The loading screen came out upside down
  because `flipY = false` and a Y-down camera cancelled; the micro-button portrait because a widget's
  authored `TexCoords` outranked the `FLIP_V` given to `adopt`; the cursor icon because it drew an
  uploaded BLP through the **framebuffer** camera (Y-up, correct for drawing a render target) instead
  of the interface's own (Y-down, where an uploaded BLP is upright with three's default UVs). Each fix
  adopted the right camera or composed the two crops. **Negating a UV would have looked right and
  disagreed with every other texture path in the renderer.**
- **An in-flight/dedupe set must release on the FAILURE path too.** A thrown template decode left its
  id in `queried` for ever, so that quest could never be asked for again — a permanent silent failure
  from one bad packet. Put the release in a `finally`. That is the second time a dedupe set has hidden
  a defect here.
- A `#pragma glslify: import(...)` chunk is invisible to webpack's watcher.
- **No backticks inside `lua/compat.ts`'s 5.1 shim** — it is a JS template literal, so one backtick-quoted
  identifier in a Lua comment terminates the string and yields ~25 nonsense TS errors pointing at Lua.
- The UI canvas has no `preserveDrawingBuffer`: `drawImage`-ing it into a 2D context reads a **cleared**
  buffer, so a pixel probe returns black whatever is on screen. Screenshot instead.
- **A SHARED material is not yours to write.** This has now cost three rounds. An attachment — a helm,
  a pauldron, a weapon — is a static model, so it instances, and a character clone hands it the
  **shared** batches: the same materials every copy of that item path in the zone is drawing. Writing
  one from a pane, a highlight or any pass outside the world's own light is a write into the world.
  It produced the missing hair (a blend rule right for the world, fatal in a pane), a portrait bake
  leaving the booth's studio light on the world's helm and shoulders **permanently** (the world's light
  refresh is revision-skipped by design, so it never takes them back), and the reason a hover highlight
  cannot reach an attachment at all. **`ownsBatches` is the test.** If you must borrow one, save and
  restore rather than skip — the pattern `model-booth.ts` already uses for the clear colour.
- An `ADD` widget in the world UI must not write destination alpha. The world pass is premultiplied, and
  three's `AdditiveBlending` there is an un-separated `blendFunc(ONE, ONE)` that saturates the offscreen
  target's alpha and masks the world out — an opaque black quad. `material.ts#applyBlend` is the one place.
