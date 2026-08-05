# Glue Foundation — Design

**Date:** 2026-08-05
**Status:** Design approved, spec under review
**Scope:** The in-canvas widget layer, glue art/string/font access, and the client lifecycle state
machine that the four pre-world screens (login, realm list, character select, character create) will
be built on — plus a networking-free debug route into the world.

---

## 1. Problem

The pre-world screens are placeholder HTML. [`pages/auth/auth.tsx`](../../../client/src/pages/auth/auth.tsx)
is a `<form>` with a hand-written "Wowser requires a WebSocket proxy" note;
[`pages/realms/realms.tsx`](../../../client/src/pages/realms/realms.tsx) is a `<select>` that ignores
its own selection and connects to `realms.list[1]`;
[`pages/characters/index.tsx`](../../../client/src/pages/characters/index.tsx) tells the user to "use
the official WoW Client" to create a character, and `/create-character` in
[`app.tsx`](../../../client/src/app.tsx) renders the string `create character`.

The reference (`samples/benilla`) builds these screens the way the real client does: authored layouts
transcribed from the client's own GlueXML, art and strings read out of client data at runtime, a 3D
glue scene behind the widgets, and a lifecycle state machine that owns which screen holds the
session. That is ~7,300 lines across `crates/benilla/src/{glue,login,char_select,char_create}` — and
it stands on infrastructure we do not have at all: **a widget layer**. We have no buttons, no edit
boxes, no font strings, no hit-testing, no focus, no anchor resolution. Nothing in this repo draws a
2D interactive element into the WebGL canvas; every UI pixel today is DOM
([`pages/game/controls`](../../../client/src/pages/game/controls/), [`pages/game/debug`](../../../client/src/pages/game/debug/)).

What we *do* have is everything the widget layer needs to feed on. Verified against the asset host
(`https://data-direct.spelunkerdb.com/12340`, [`game/net/loader.js`](../../../client/src/game/net/loader.js)):

| Path | Status |
|---|---|
| `interface/glues/common/glue-panel-button-up-blue.blp` | 200 |
| `interface/gluexml/accountlogin.xml` / `.lua` | 200 (84,576 / 22,891 bytes) |
| `interface/gluexml/realmlist.xml` / `.lua` | 200 (30,909 / 11,640) |
| `interface/gluexml/characterselect.xml` / `.lua` | 200 (42,607 / 17,840) |
| `interface/gluexml/charactercreate.xml` / `.lua` | 200 (33,021 / 17,889) |
| `interface/gluexml/gluetemplates.xml`, `glueparent.xml` | 200 |
| `interface/gluexml/gluestrings.lua` | 200 (77,670) |
| `interface/glues/models/ui_mainmenu/ui_mainmenu.m2` | 200 |
| `fonts/frizqt__.ttf`, `morpheus.ttf`, `skurri.ttf`, `arialn.ttf` | 200 |
| `dbfilesclient/chrraces.dbc`, `charsections.dbc` | 200 |

So no layout has to be guessed — including realm select, which **benilla does not have**: its
`ClientState` lists `RealmList` as a variant that "grows as the glue arc fills in"
(`crates/benilla/src/char_select/mod.rs`), and the reference picks a realm automatically. We
transcribe ours from our own `realmlist.xml`, the same way benilla transcribes `AccountLogin.xml`.

A missing asset returns an HTML error page with status 404, not a short body — the probe above got
27,150 bytes of markup for two wrong paths. `Loader#load` already rejects on `!response.ok`, so this
is handled, but art tables must not treat "it fetched" as "it exists".

## 2. The larger program (context, not this spec's scope)

Seven specs, each with its own plan:

| # | Spec | Delivers |
|---|---|---|
| **1** | **Glue foundation** — *this document* | Widget layer, layout law, text, input, `GlueArt`/`GlueStrings`, `ClientState` machine, offline world route |
| 2 | Protocol layer | Version-neutral protocol interface + 3.3.5 implementation over the existing SRP/RC4 code; typed messages, login stages, char create/delete, full error codes |
| 3 | Login screen | `AccountLogin.xml` transcribed: account/password boxes, Remember Account Name, Login/Quit, version block, connecting/error dialogs, `UI_MainMenu` glue scene |
| 4 | Realm list screen | `RealmList.xml` transcribed: realm rows, categories, population, Change Realm |
| 5 | Character select | `CharacterSelect.xml` transcribed: realm banner, ten rows, Create New Character, Enter World / Back / Delete with the typed-`DELETE` confirm, rotate pair, arrow cycling, double-click enter. Scene without a character yet |
| 6 | Character appearance + glue booth | `CharSections` skin bake, hair/facial-hair geosets, equipment display from the char-enum record, booth camera/light — puts the character into the select scene and makes create possible |
| 7 | Character create | Full: race/class matrix from DBC, live-preview customization, RANDOMIZE, race/class descriptions, name validation, server responses |

Order is 1→7. After spec 4 the login→realm path is authentic and entry to the world still runs
through the current HTML character list; spec 5 replaces it, 6 fills the scene, 7 adds creation. Every
step keeps a working end-to-end path, and only the two screens that genuinely need the appearance
system wait for it.

Decisions already fixed for the whole program:

- **Protocol target is 3.3.5 (build 12340)**, behind an interface shaped so a 1.12.1 implementation
  can land beside it later. Our client data is 3.3.5; benilla's wire code is 1.12.1. What ports from
  benilla is structure (login stages, park model, typed messages, char actions, error policy), not
  bytes — our [`crypto/crypt.js`](../../../client/src/network/crypto/crypt.js) already implements the
  WotLK RC4-with-HMAC-seeds header crypt and [`crypto/srp.js`](../../../client/src/network/crypto/srp.js)
  the SRP6 exchange.
- **The UI lives in the WebGL canvas**, not the DOM: widget quads in an orthographic scene, our own
  hit-testing, focus and text input — as benilla and the real client do.
- **The canvas fills the window.** There is no fixed virtual screen and no letterbox.

## 3. Scope of this spec

In: `client/src/game/ui/` — the widget layer and its data sources; the `ClientState` machine and its
React host; the offline world route. Out: any transcription of a real screen. The foundation is
proved by one **throwaway probe screen** (logo, a button, an edit box, a dialog) that spec 3 deletes
when the real `AccountLogin` lands.

## 4. Architecture

```
client/src/game/ui/
  layout.ts      pure: units, scale law, anchor resolution   <- unit-tested
  hit.ts         pure: ordered rect hit-test, focus chain    <- unit-tested
  widget.ts      retained widget tree (Frame/Texture/FontString/Button/EditBox/CheckButton/Backdrop)
  text.ts        FontString rendering via client TTF
  material.ts    the two glue blend modes
  input.ts       DOM event -> widget events (hover/press/click/key/paste)
  art.ts         GlueArt: sprite table over TextureLoader
  strings.ts     GlueStrings: gluestrings.lua parser         <- unit-tested
  renderer.ts    ortho scene + second render pass
  screens.ts     ClientState machine, screen mount/update/unmount
  screens/probe.ts  throwaway proof screen (deleted by spec 3)
```

The split is deliberate: **all geometry and interaction logic is pure and Three.js-free**
(`layout.ts`, `hit.ts`), because that is the only way it can be tested in jsdom without WebGL.
`widget.ts` holds state and calls into those; `renderer.ts` is the only file that knows about meshes.

### 4.1 Units and the scale law

Widget coordinates are authored GlueXML units. The scale factor is

```
scale = min(window.innerHeight / 768, 2.2)
```

matching `screen_scale` in `crates/benilla/src/glue/mod.rs`. Two properties of that formula are
load-bearing and are reproduced deliberately:

- **No lower clamp.** A floor of 1.0 draws a 768-unit-tall layout into a shorter window and the
  overflow falls off the bottom — silently, and always the bottom-most controls. benilla recorded
  this at `1276x677`: the last customization row and the RANDOMIZE button simply gone. A short window
  must make everything smaller instead.
- **The upper clamp stays** at 2.2 — that is the shipped size on a tall display.

Anchors resolve against the **real window rectangle**, not a 1024×768 box, so a widescreen window
reveals more horizontal space exactly as the real client does. `layout.ts` exposes
`resolveAnchors(nodes, viewport) -> Map<id, Rect>` over FrameXML anchor points
(`TOPLEFT`…`BOTTOMRIGHT`, `CENTER`, relative-to with offsets). Canvas backing store is sized at
`devicePixelRatio`; logical units never see DPR.

### 4.2 Widgets

A retained tree, not a per-frame rebuild: screens create widgets on `mount` and mutate them. Node
types cover what the four screens need and no more — `Frame`, `Texture`, `FontString`, `Button`
(up/down/highlight/disabled art plus caption), `EditBox` (letters cap, password masking, caret,
selection), `CheckButton`, `Backdrop` (edge-tiled border + background, as `gluetemplates.xml`
authors them), `Dialog`. Each node carries anchors, a draw layer, alpha, shown/hidden, and for
textures a tex-coord rect — the glue art sheets are atlases and are addressed by sub-rect, like
benilla's `tc_rect` (`crates/benilla/src/glue/art.rs`).

Draw order is explicit: layer (`BACKGROUND`/`BORDER`/`ARTWORK`/`OVERLAY`/`HIGHLIGHT`/`DIALOG`) then
insertion order, resolved once per tree change into a flat sorted list that both the renderer and the
hit-test read. One list, two consumers — the thing you click is by construction the thing you see.

### 4.3 Text

`FontString` draws through a 2D-canvas texture using the client's own fonts, loaded as `FontFace`
from `fonts/frizqt__.ttf`, `fonts/morpheus.ttf`, `fonts/skurri.ttf`. The reference had to fake the
client's baked 1-pixel outline with offset copies of every string
(`OutlineCopy`, `crates/benilla/src/glue/mod.rs`); a 2D context gives us `strokeText`, so we draw the
outline for real and get closer to the reference with less machinery.

Textures are cached by `(text, font, size, color, outline, maxWidth)` and only re-rasterized when a
key changes — a per-frame rasterize of a character list would be a frame-budget hole for text that
changes on selection, not on frames.

### 4.4 Materials

Two blend modes: standard premultiplied alpha, and **ADD** for the glue art that glows (benilla needed
a dedicated `AddUiMaterial` for this; `crates/benilla/src/glue/add_material.rs`). Both are unlit,
depth-test off, drawn in explicit order.

One trap to encode: `TextureLoader` creates every texture with `flipY = false` uniformly, because
three.js cannot flip a compressed upload
([`texture-loader.js`](../../../client/src/game/pipeline/texture-loader.js)). UI quads must therefore
flip V in their own UVs, or every piece of glue art draws upside down.

### 4.5 Input

`input.ts` translates DOM events on the canvas into widget events: pointer position → logical units →
`hit.ts` (top-most hit wins, `mouseEnabled` nodes only) → hover/press/click on the widget, with
capture so a press that drags off the button still releases on it. Keyboard goes to the focused node;
the focus chain supports Tab order, Enter as submit, Escape as cancel. `EditBox` needs real text
entry — printable keys, backspace/delete, arrows, home/end, selection, and clipboard paste
(benilla needed a whole `textinput` module with a host clipboard for this; in a browser it is a
`paste` event, which is a rare place where we get the easier deal).

### 4.6 Art and strings

`art.ts` declares sprites as `{ path, rect?, size? }` and resolves them through the existing
[`texture-loader.js`](../../../client/src/game/pipeline/texture-loader.js) — no new fetch path, no new
cache. A screen's art table is loaded on first entry and cached for the session.

`strings.ts` parses `interface/gluexml/gluestrings.lua` (assignments of the form `KEY = "value";`,
including escapes and `%s`/`%d` placeholders) into a lookup. **No UI text is ever hardcoded.** This
also decides how errors are worded: a server result byte maps to a glue key (`AUTH_*`,
`CHAR_CREATE_*`), so the message the user reads is the client's own.

### 4.7 The lifecycle state machine

```
ClientState = Login | RealmList | CharSelect | CharCreate | InWorld
```

Mirrors benilla's `ClientState` (`crates/benilla/src/char_select/mod.rs`), including the pre-world
"glue" layer versus the world being distinct states rather than routes. A screen is a module:

```ts
interface GlueScreen {
  mount(ctx: GlueContext): void;   // build the widget tree, request art
  update(dt: number): void;        // per-frame; refresh from session state
  unmount(): void;                 // drop the tree, release textures
}
```

`GlueContext` hands over the widget root, `GlueArt`, `GlueStrings`, the input router and the session
facade. Screens do not know about React, routing, or each other; state transitions are requested
through the machine.

`renderer.ts` renders the ortho UI scene as a second pass with `autoClear = false` over whatever
`THREE.WebGLRenderer` it is given. On the glue screens that renderer belongs to the glue host; when
the in-world HUD is built on this same layer later, it will be the game's — the widget layer never
owns a renderer.

React's role shrinks to hosting a full-window canvas and routing. During this spec the glue app
mounts at **`/glue`** and shows only the probe screen; `/`, `/realms`, `/characters` keep working
exactly as they do today, so the path into the world is never broken by foundation work. Spec 3 moves
the glue app onto `/` when the real `AccountLogin` replaces the probe, and specs 4–7 retire the
remaining React screens as each authentic screen lands.

### 4.8 The offline world route

`/game?offline=1` (bare `?offline` too) enters `InWorld` with no socket opened at all: a stub
character (race/class/gender and a position from [`game/world/spots`](../../../client/src/game/world/)),
and the world's dependency on the session behind an interface so world code never branches on
"networked or not". This is the fast debug loop for world/render work, and it is the reason the
dependency is an interface rather than a flag: benilla found the same need for deterministic
no-server runs and marked it explicitly with a `NetOffline` resource so a run that never touched the
wire can't be mistaken for one that did (`crates/benilla/src/net.rs`). We do the same — the offline
entry announces itself in the console once.

## 5. Testing

Four unit tests, deliberately no more:

1. `layout.ts` — the scale law (including that a short window scales down rather than clipping) and
   anchor resolution for each anchor point with offsets.
2. `hit.ts` — top-most-wins ordering on an overlapping tree, `mouseEnabled` skipping, Tab focus order.
3. `strings.ts` — gluestrings parsing: quoted values, escapes, placeholders, a real excerpt of the
   shipped file.
4. The offline route — `?offline=1` selects the stub session and opens no socket.

Everything else is verified by hand: `npm start`, then the probe screen against the reference for
scale behaviour (resize the window tall/short/wide), ADD blending, font rendering with outline, and
edit-box typing/paste/focus. The probe screen exists for exactly this and is deleted in spec 3.

## 6. Out of scope

Any real screen layout; the protocol refactor (spec 2); character appearance (spec 6); the in-world
HUD; FrameXML/Lua interpretation. Note that last one explicitly: benilla's `benilla-ui` crate is a
FrameXML *interpreter* for the in-game UI. We are **not** building one. GlueXML is read by us as a
reference document and transcribed into TypeScript, exactly as benilla transcribes it for the glue
screens.

## 7. References

- `samples/benilla/crates/benilla/src/glue/` — `mod.rs` (scale law, outline copies), `art.rs` (sprite
  table and tex-coord rects), `widgets.rs` (widget builders), `add_material.rs`, `backdrop.rs`
- `samples/benilla/crates/benilla/src/char_select/mod.rs` — `ClientState`
- `samples/benilla/crates/benilla/src/net.rs` — offline/no-IO marking
- Client data, read at runtime: `interface/gluexml/*.xml|.lua`, `interface/glues/**/*.blp`, `fonts/*.ttf`
- Existing infrastructure reused as-is: [`game/net/loader.js`](../../../client/src/game/net/loader.js),
  [`game/pipeline/texture-loader.js`](../../../client/src/game/pipeline/texture-loader.js),
  [`game/pipeline/blp/loader.js`](../../../client/src/game/pipeline/blp/loader.js)
