# FrameXML Runtime — Design

**Date:** 2026-08-06
**Status:** Design proposed, awaiting approval
**Supersedes the approach of:** specs 1–3 of the glue program (hand-transcribed screens)

---

## 1. Why this exists

The glue screens are currently hand-transcribed from GlueXML into TypeScript. That was my call and it
was wrong. The reference this project is porting — `samples/benilla` — does not transcribe: its
`benilla-ui` crate depends on `roxmltree` and `mlua` with the `lua51` feature, and it *loads the
client's own XML and runs the client's own Lua*. I cited benilla as the fidelity standard for three
specs while not porting its central architectural decision.

The cost of transcription is measured, not theoretical. In one session it produced: wrong edit-box
sizes (600×64 for a 200×37 control), the wrong font family for typed text (Friz Quadrata for what is
narrow Arial), the wrong colour table (FrameXML's `NORMAL_FONT_COLOR` for `GlueFontNormal`), a wrong
`letters` cap, a missing Quit button, the wrong sheet for two buttons, a sort applied to a list the
client leaves in server order, and a lock byte dropped on the wire so a column could never render. An
interpreter makes none of those mistakes, because it never reads a value with human eyes.

The goal beyond fidelity is addons. A real frame API and a real event system are what addons consume,
so building them properly now is the same work, not extra.

## 2. Scope

**In:** the default glue screens — `AccountLogin`, `RealmList`, `CharacterSelect`, `CharacterCreate`
and what they depend on (`GlueParent`, `GlueTemplates`, `GlueButtons`, `GlueDialog`,
`GlueDropDownMenu`, `GlueTooltip`, `GlueFontStyles`, `GlueStrings`), loaded from `gluexml.toc` in its
own order and driven by their own Lua.

**Out, for now:** FrameXML (the in-world HUD), third-party addons, the options/video/audio panels,
credits, the DLL scanner, patch download, the realm wizard, security matrix. The architecture must not
preclude them; nothing here is built to be thrown away when they arrive.

## 3. What we keep, and what changes

We are not starting from nothing. benilla's own module split maps almost cleanly onto what this repo
already has:

| benilla-ui | this repo, today | verdict |
|---|---|---|
| `widget/` (frame arena) | `game/ui/widget.ts` | keep, extend |
| `layout.rs` (anchors → rects) | `game/ui/layout.ts` | keep, extend |
| `order.rs` (draw order) | the `layer` field + insertion order | **replace** — see §6 |
| — (renders app-side) | `renderer.ts`, `material.ts`, `backdrop.ts`, `text.ts`, `art.ts` | keep |
| — (input app-side) | `input.ts` | keep |
| `toc.rs` | — | **new** |
| `framexml.rs` | — | **new** |
| `loader/` | — | **new** |
| `script/` | — | **new** |

The hand-written `screens/login.ts` and `screens/realms.ts` are deleted at the end — but not before
they have served as the oracle (§9).

## 4. Pipeline

Following benilla's, which is the client's:

```
gluexml.toc ──► Toc { directives, files }        ordered, never fails
      │
      ▼  for each file, in order
   parse XML ──► ParsedDocument { items: TopLevel[] }
      │            TopLevel = Include | Script(file|inline) | Font | Template | Instance
      │            ORDER-PRESERVING: the client interleaves script execution with
      ▼            frame definitions in document order, and Lua load order depends on it
   load(doc)
      ├─ Include  → resolve, parse, recurse
      ├─ Script   → run in the Lua VM
      ├─ Font     → register in the FONT registry (not the template registry)
      ├─ Template → register RAW in the GLOBAL template registry
      └─ Instance → expand templates, then materialize
                        1  CreateFrame(tag, resolvedName, parent)   ← a Lua call
                        2  attributes    3  <Size>      4  <Anchors>
                        5  <Layers> / direct <FontString> / <Backdrop> / per-kind
                        6  <Scripts>  (OnLoad captured, NOT fired)
                        7  recurse into <Frames>
                        8  fire OnLoad                              ← bottom-up
```

Two properties of this are load-bearing and both are ground-truthed in benilla against the real
client:

- **`OnLoad` fires bottom-up.** A frame's children are fully built and their `OnLoad`s fired before
  the parent's runs.
- **The loader materializes by calling the Lua object model** — `CreateFrame`, `SetPoint`, `SetText`
  — exactly as an addon would, never by reaching into the widget tree directly. This is what makes
  the API real rather than a private back door, and it is the single design choice that decides
  whether addons can ever work.

**IO stays out.** benilla's loader takes a `files(path) -> string | null` closure and never opens
anything. We do the same: the existing asset `Loader` (already used by `strings.ts` to fetch
`Interface\GlueXML\GlueStrings.lua`) is injected. The runtime is then testable with inline XML
strings and no network, which is how benilla's 16 loader tests work.

**Never throw.** A bad handler body, an unknown frame type, a missing include, an unsupported
attribute — each is an entry in a `LoadReport { warnings, errors, frames }` and the load continues.
The client logs and continues; so do we. Warnings dedupe, or a document with 200 unsupported handlers
emits 200 identical lines.

## 5. Templates, `$parent`, and the two namespaces

Transcribed from benilla, because every one of these has a bug attached to it:

- **The template registry is GLOBAL and persists across files.** `RealmList.xml` may inherit a
  template `GlueTemplates.xml` registered earlier. A per-document registry silently drops every
  cross-file inherit.
- **Merge is inherited-first, own-last, last-wins.** An instance's `<Size>` is the *second* `<Size>`
  child. Taking `.first()` anywhere pins every templated frame to its template's value — the bug that
  rendered a 125×21 button at 80×22. The same "last wins" applies to `<FontHeight>`, `<Color>` and
  `<Shadow>` in font resolution.
- **`inherits="A, B"`** is left-to-right, later wins; chains expand recursively; cycles are guarded
  and warn.
- **`inherits=` is two namespaces.** On a `<FontString>` it almost always names a *font object*; on a
  `<Texture>` it may name an element template. Look before leaping: run the template merge only if
  the name is actually in the template registry, otherwise pass the element through so the font path
  can claim it.
- **`$parent`** substitutes case-insensitively on the 7-char prefix only, against the nearest
  **named** ancestor, with `"Top"` as the fallback root name. The asymmetry matters: a frame's own
  anchors substitute against its **parent's** name, while its regions and children substitute against
  **its own**.

## 6. Draw order — an extension, not the correction I first claimed

benilla's `order.rs` is the part of this port that changes existing rendering behaviour.

**First, a correction to an earlier draft of this spec.** I wrote that `WidgetRoot#drawList` groups a
frame's regions behind their frame, the mistake benilla shipped and fixed. It does not.
`widget.ts:265-270` sorts by layer index first and insertion order second, **globally over the whole
tree** — so "the draw layer outranks the frame" is already true here, and the interleave benilla's
regression test protects is already our behaviour. Our base is right; what follows is what is missing
from it, which is a smaller and lower-risk change than a correction would have been.

Four gaps against the client's key:

- **Strata is conflated with layer.** `Layer` currently carries a sixth member, `DIALOG`, which in the
  client is not a draw layer at all — it is a *frame strata*, a separate and higher-ranked axis. The
  real layer ladder is five: BACKGROUND, BORDER, ARTWORK, OVERLAY, HIGHLIGHT. Splitting these is the
  bulk of this task, and it is a breaking change to every screen that sets `layer = 'DIALOG'`.
- **No frame level**, so `SetFrameLevel` has nothing to write to and the `GetFrameLevel() - 1` idiom
  cannot work.
- **No texture-before-fontstring rank** within a layer.
- **No link-stamp**: we use static DFS insertion order where the client uses live list position,
  re-stamped when a frame is shown, changes strata, or has its level changed.

The full key, most- to least-significant:

```
stratum ▸ frame level ▸ DRAW LAYER ▸ fontstring? ▸ frame link-stamp ▸ is-region ▸ sub-level ▸ decl seq
```

Three consequences, each counterintuitive and each with a distinct visual signature:

1. **The order is flat, not hierarchical.** A child frame with a lower strata or level draws *before*
   its parent.
2. **The draw layer outranks the frame.** Every frame's BACKGROUND, then every frame's BORDER, then
   every frame's ARTWORK — regions are *not* glued behind their owner. This is why
   `SetFrameLevel(GetFrameLevel() - 1)` is a real FrameXML idiom: a child is born at `parent + 1`, so
   `-1` creates a *tie*, and the tie exists so the layer key can decide.
3. **All textures of a layer precede all its font strings**, across frames.

The **link-stamp** is the live list position, re-stamped to the bucket tail when a frame becomes
visible, changes strata, or has its level *changed* — not creation order. A same-value
`SetFrameLevel` must early-out and not re-stamp.

This is the highest-risk item in the spec: it is invisible in a unit test unless the test is written
for it, and it misdiagnoses as bad art. It gets its own module with a written bit layout and a test
per field, including benilla's regression test that the layer interleaves frames rather than grouping
them.

## 7. The Lua boundary

**VM: fengari** — MIT, pure JS, no wasm. It is Lua **5.3** where WoW is 5.1, so this needs saying: I
scanned all 27 glue Lua files for the constructs that differ. `setfenv`/`getfenv`, `string.gfind`,
`math.mod`, `loadstring`, `arg[...]`, `module()`, `table.setn`: **zero occurrences**. `unpack(`: one,
in `glueparent.lua`. `getn(`: one, in a file we do not load. Integer division `//`: 68 hits, every one
of them `http://` inside a string. The entire gap is two call sites.

So: fengari plus a compatibility shim, and **the shim lives in exactly one module**, because addons
are not as disciplined as Blizzard's glue code — they use `setfenv`, `arg` and 5.1 vararg semantics
freely. If addons later demand true 5.1 we build an Emscripten Lua 5.1 and swap it behind the VM
interface; keeping the shim in one file is what makes that a contained change rather than an
excavation.

**Object model**, following benilla: a frame's Lua value is a **table**, not userdata, carrying its
integer id, with a shared metatable whose `__index` dispatches by method name through **per-kind
method tables** consulted before the shared one. Per-kind rather than one flat table for a specific
reason: addons duck-type widgets (`if frame.SetValue then`), so a plain Frame must resolve `SetValue`
to nil. CheckButton resolves through `[CHECKBUTTON, BUTTON]` — the class chain. Wrappers are cached
per id so `GetParent()` returns the same table every time. Named frames publish to `_G`
**non-overwriting** — first frame with a name owns it.

benilla's other big constraint — holding zero persistent Lua handles in Rust because mlua's reference
thread is capped at `LUAI_MAXCSTACK = 8000` — **does not apply to us**. JS is garbage-collected and
fengari hands back ordinary JS values. We keep the *shape* it forced (one plain state object,
integer-keyed) because it is a good shape, but not the ceremony.

**Handlers.** `<Scripts>` children compile as `return function(self, ...) <body> end`, named for
debugging. `OnLoad` is captured and fired by the loader, not at compile time. The handler name is
validated against a fixed list of script kinds; an unknown one is a warning, not an error.

**Both calling conventions, always.** Before every handler call, set the legacy globals `this`,
`event`, `arg1..argN`; pass the same values positionally as `(self, event, ...)`; restore the
previous globals afterwards **even on error**, so nested firing is safe. Inside one handler,
`this == self` and `arg1 == select(1, ...)`. 3.3.5 Lua uses both idioms and mixed code is common.

**Events.** `RegisterEvent` appends to an ordered per-event list; re-registering keeps position.
Dispatch walks **by index, re-reading the live list each step**, so a frame registered mid-dispatch is
still visited. Cross-frame order is a law consumers depend on — the last writer to a shared
FontString decides what it says. Events reach registered frames regardless of visibility.

## 8. The engine API

Two surfaces, both measured against the actual glue Lua rather than estimated:

**60 frame/region methods** — `SetPoint`, `SetText`, `Show`/`Hide`, `Enable`/`Disable`, `SetChecked`,
`SetTextColor`, `SetVertexColor`, `SetTexCoord`, `LockHighlight`, `RegisterEvent`, `SetScript` and so
on. Most are one-liners over the `Widget` that already exists. A handful are model-frame methods
(`SetModel`, `SetCamera`, `SetSequence`, `SetFogNear`/`Far`, `ClearFog`) that map onto the glue scene
already rendering the main-menu stage.

**89 engine globals**, of which roughly 25 must genuinely work — `CreateFrame`, `GetScreenWidth`/
`Height`, `IsStreamingTrial`, `GetBuildInfo`, `DefaultServerLogin`, `CancelLogin`, `RequestRealmList`,
`GetNumRealms`, `GetRealmInfo`, `ChangeRealm`, `GetSavedAccountName`/`Set…`, `QuitGame` — each a short
bridge to the `ProtocolSession` and `connection-settings` that already exist and are already proven
against a live server. Around 35 more belong to paths we never trigger (account messages, EULA/TOS
notices, the DLL scanner, PIN/token entry, video and audio options) and exist as no-ops so a reference
does not error. The `GlueDropDownMenu_*` family is not engine at all — it is Lua, and comes free with
the file.

Every binding reads or writes a plain snapshot; none of them reach into React, three.js or a socket
directly. Verbs queue intents the app drains.

**Text measurement is synchronous for us.** benilla makes it an async round-trip — the engine asks,
the app answers, the *next* resolve uses it — because its font stack is app-side and a frame of lag
was acceptable. Our `text.ts` measures on a canvas, synchronously, in-process. We take the simpler
path and note the divergence, since it is a simplification rather than a shortcut.

## 9. Verification

The oracle is the thing that makes this port safe, and it exists only because the screens were
hand-written first.

1. **Two independent derivations of the same screen.** `screens/login.ts` and `screens/realms.ts`
   already match the project owner's reference screenshots of the real client on his own server. When
   the runtime executes `AccountLogin.xml` and `RealmList.xml`, the two must agree. Any disagreement
   is a bug in one of them, and finding out which is exactly the work worth doing.
2. **Unit tests over inline XML**, no network, asserting *through the runtime* — evaluate Lua, or read
   the draw list — never against loader internals. benilla's flagship test builds a document with a
   template, an inherit, sizes, anchors, a layered texture, a nested frame and two `OnLoad`s, then
   asserts an exact rect, both calling conventions, and bottom-up load order. That is the shape.
3. **A draw-order test per key field**, including the interleave regression.
4. **The browser pass against a live server**, which has already caught what tests did not: a wiring
   bug that a green suite missed entirely because the resolver was private to a class that cannot be
   instantiated in jsdom.

Tests stay minimal per the project's standing instruction — happy path, plus a regression whenever
something actually breaks. The exception is §6, where the tests *are* the specification.

## 10. Risks

- **Draw order (§6)** — highest. Changes existing rendering, misdiagnoses as an art bug.
- **fengari is 5.3** — measured as two call sites for these files; unbounded for future addons.
- **Scale.** ~150 bindings is a lot of small surface area. It decomposes cleanly, which is what the
  implementation plan is for.
- **Performance.** A Lua VM plus a per-frame `OnUpdate` sweep in a browser is unproven here. Mitigated
  by the same discipline benilla uses: keep a presence mirror of which frames have `OnUpdate` so the
  tick does not cross into Lua for frames that do not.
