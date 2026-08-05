# Glue Foundation — Design

**Date:** 2026-08-05
**Status:** Design approved, spec under review
**Scope:** The in-canvas widget layer, the 3D glue scene, glue art/string/font access, and the client
lifecycle state machine that the four pre-world screens (login, realm list, character select,
character create) will be built on — plus a networking-free debug route into the world.

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

The 3D half is missing too, and less visibly. A glue screen's background is a model scene framed by
the model's own camera with the character standing on its own attachment point — and our M2 parser
skips exactly those three chunks: `cameras`, `lights` and `attachments` are declared as typeless
`Nofs` entries ([`m2/index.js:152-157`](../../../client/src/wow-data-parser/m2/index.js)), which read
the count and discard the payload. So today we could load `UI_MainMenu.m2` and would have no camera to
look through, no stage spot, and no point lights.

What we *do* have is everything both halves need to feed on. Verified against the asset host
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
| **1** | **Glue foundation** — *this document* | Widget layer, layout law, text, input, `GlueArt`/`GlueStrings`, **the 3D glue scene** (M2 cameras/lights/attachments, `SetBackgroundModel`, fog and light rigs), `ClientState` machine, offline world route |
| 2 | Protocol layer | Version-neutral protocol interface + 3.3.5 implementation over the existing SRP/RC4 code; typed messages, login stages, char create/delete, full error codes |
| 3 | Login screen | `AccountLogin.xml` transcribed: account/password boxes, Remember Account Name, Login/Quit, version block, connecting/error dialogs, `UI_MainMenu` glue scene |
| 4 | Realm list screen | `RealmList.xml` transcribed: realm rows, categories, population, Change Realm |
| 5 | Character select | `CharacterSelect.xml` transcribed: realm banner, ten rows, Create New Character, Enter World / Back / Delete with the typed-`DELETE` confirm, rotate pair, arrow cycling, double-click enter. Scene without a character yet |
| 6 | Character appearance | `CharSections` skin bake, hair/facial-hair geosets, equipment display from the char-enum record — puts a character onto the stage spot the foundation's scene already establishes, and makes create possible |
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
- **A glue screen is a 3D scene with widgets on top**, not a picture with widgets on top. The login
  screen is the `UI_MainMenu` model burning behind the boxes; select and create stand the character in
  a `UI_<Race>` stage. That 3D half is foundation, not per-screen decoration — §5.

## 3. Scope of this spec

In: `client/src/game/ui/` — the widget layer and its data sources; the 3D glue scene (§5) including
the M2 parser work it needs; the `ClientState` machine and its React host; the offline world route.
Out: any transcription of a real screen. The foundation is proved by one **throwaway probe screen**
(the real `UI_MainMenu` scene behind a logo, a button, an edit box and a dialog) that spec 3 deletes
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

client/src/game/ui/scene/       the 3D half (§5)
  glue-scene.ts  load UI_<token>.m2, sequence 0, camera 0, stage spot
  scene-rig.ts   pure: RaceLights -> probe/ambient, CharModelFogInfo -> fog triple  <- unit-tested
  tokens.ts      pure: race -> scene token, expansion -> main-menu variant
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

## 5. The 3D glue scene

A glue screen is not a widget sheet over a still: it is a live model scene with the widgets drawn on
top. Every pre-world screen in the program depends on this, so it is foundation.

### 5.1 The mechanism, from our own client data

Read out of `interface/gluexml/` on the asset host — this is our version's law, not an inference:

```lua
-- glueparent.lua:376
function SetBackgroundModel(model, name)
    local path = "Interface\\Glues\\Models\\UI_"..name.."\\UI_"..name..".m2";
    ... SetCharCustomizeBackground(path) / SetCharSelectBackground(path)
    PlayGlueAmbience(GlueAmbienceTracks[strupper(name)], 4.0);
    SetLighting(model, strupper(name))
end

-- characterselect.lua:11 / charactercreate.lua:66
self:SetSequence(0);
self:SetCamera(0);
```

So: **model** = `Interface\Glues\Models\UI_<token>\UI_<token>.m2`, **animation** = sequence 0 looping,
**framing** = the model's **authored camera 0**, and the character (spec 6) stands on the scene's
**attachment 0** — the stage spot, which benilla byte-verified is attachment 0, not 1
(`crates/benilla/src/portrait/glue_booth.rs`).

Login is its own case: `accountlogin.lua:34-36` picks `UI_MainMenu` or **`UI_MainMenu_Northrend`** by
expansion account level, and `accountlogin.xml:93` authors the fog on the frame itself —
`<ModelFFX ... fogNear="0" fogFar="1200" glow="0.08">` with `<FogColor r="0.25" g="0.06" b="0.015"/>`.

`SetLighting` (`glueparent.lua:327`) is the rig: sequence 0, fog from `CharModelFogInfo[race]`
(`{r, g, b, far}`, near always 0) or `ClearFog()`, then `ResetLights()` and the `RaceLights[race]`
rows added as `AddCharacterLight`/`AddLight`/`AddPetLight` at index `LIGHT_LIVE = 0`.

**Two divergences from benilla, both because we are 3.3.5 and it is 1.12.1** — where they disagree,
our client data wins:

1. `glueparent.lua:50` states it outright: *"RaceLights[] duplicates the 3.2.2 color values in the
   models. Henceforth, the models no longer contain directional lights."* benilla folds the scene's
   **authored M2 directional rig**; on our data the directionals come from the **Lua table** and only
   the point lights come from the model (`glueparent.lua:361` confirms: *"The current version only
   supports setting directional lights, and pulls the default point lights from the models."*).
2. benilla found that 1.12 renders the **select** scene unfogged (the client overwrites the
   background's fog callback with the light callback). Ours fogs it: `SetBackgroundModel` runs the same
   `SetLighting` for select as for create, and `CharModelFogInfo` even carries a dedicated
   `CHARACTERSELECT` row (`{r=0.8, g=0.65, b=0.73, far=222}`). We follow ours.

`RaceLights` rows are 13 numbers whose grouping is legible but not labelled — enabled flag, an index,
a 3-vector direction, then two colour triples with a scalar between them. Resolving that layout
against `AddLight`'s real signature is an implementation task, and the check is visual: the Night Elf
and Scourge stages are lit almost entirely by their stage lights, so a mis-grouped row is obvious.

### 5.2 What has to be built

**M2 parser: cameras, lights, attachments.** All three are currently *skipped*. In
[`wow-data-parser/m2/index.js:152-157`](../../../client/src/wow-data-parser/m2/index.js) they are
declared as bare `new Nofs()`, and a typeless `Nofs` reads the count, discards the offset and returns
**no payload** ([`nofs.js`](../../../client/src/wow-data-parser/m2/nofs.js)). Without them there is no
camera 0 to frame with, no stage spot to stand on, and no point lights. This spec adds
`cameras` + `cameraLookups` (position and target spline tracks, FOV, near/far), `lights` (type,
bone, position, ambient/diffuse colour and intensity tracks, attenuation, visibility), and
`attachments` + `attachmentLookups`. Ribbons and particle emitters are already parsed, so the
main-menu fires come free through the existing particle system.

**Camera framing.** Camera 0 drives a `THREE.PerspectiveCamera`: eye and target sampled from its
tracks at the sequence-0 time, up from roll, and the authored FOV converted from the M2's
**diagonal** FOV to a vertical one for our aspect (benilla's `DIAG_TO_VERT`,
`crates/benilla/src/portrait/framing.rs`). A window wider than the authored aspect must reveal more
scene, never crop the gate — the same law the widget layer follows in §4.1.

**Rendering.** The scene renders **directly into the canvas** as the first pass, widgets second with
`autoClear = false`. benilla bakes its glue scene to an offscreen texture because one booth serves
portraits, paper doll and glue alike; we have no such sharing, and a fullscreen render-to-texture
would cost a 1024²+ target and a blit for nothing.

**Fog and lights** map onto uniforms the M2 material already has — `fogParams`/`fogColor`/`fogModifier`,
the point-light table, and the 7-vec4 `probeCoeffs` SH block
([`m2/material/index.ts`](../../../client/src/game/pipeline/m2/material/index.ts)). `scene-rig.ts`
folds `RaceLights` into ambient + probe coefficients and `CharModelFogInfo` into the fog triple; the
glue scene pushes them instead of the world's `MapLight`. No shader work, no new material.

**Screen API.** `GlueContext` gains `scene`: `setScene(token | null)` and a `yaw` for the rotate
controls (spec 5 drives it; the scene root never yaws, only the character does). `null` tears the
scene down — a screen without one costs nothing.

## 6. Testing

Five unit tests, deliberately no more:

1. `layout.ts` — the scale law (including that a short window scales down rather than clipping) and
   anchor resolution for each anchor point with offsets.
2. `hit.ts` — top-most-wins ordering on an overlapping tree, `mouseEnabled` skipping, Tab focus order.
3. `strings.ts` — gluestrings parsing: quoted values, escapes, placeholders, a real excerpt of the
   shipped file.
4. `scene-rig.ts` + `tokens.ts` — race→token mapping (including Troll→Orc and Gnome→Dwarf), fog triple
   from a `CharModelFogInfo` row, and that a `RaceLights` table folds to finite ambient/probe values.
5. The offline route — `?offline=1` selects the stub session and opens no socket.

Everything else is verified by hand: `npm start`, then the probe screen for scale behaviour (resize
tall/short/wide), ADD blending, font rendering with outline, edit-box typing/paste/focus — and the
`UI_MainMenu` scene behind it: authored camera framing, looping sequence 0, its fires, and the fog
values from `accountlogin.xml`. That scene is why the probe exists; both are deleted in spec 3.

## 7. Out of scope

Any real screen layout; the protocol refactor (spec 2); character appearance and the character
standing on the stage spot (spec 6); the in-world HUD; FrameXML/Lua interpretation. Note that last one
explicitly: benilla's `benilla-ui` crate is a FrameXML *interpreter* for the in-game UI. We are
**not** building one. GlueXML is read by us as a reference document and transcribed into TypeScript,
exactly as benilla transcribes it for the glue screens.

Sound is also out: `SetBackgroundModel` plays a `GlueAmbienceTracks` entry per scene, and nothing in
this repo plays audio at all. Glue ambience and UI sounds are a spec of their own, after the screens.

## 8. References

- `samples/benilla/crates/benilla/src/glue/` — `mod.rs` (scale law, outline copies), `art.rs` (sprite
  table and tex-coord rects), `widgets.rs` (widget builders), `add_material.rs`, `backdrop.rs`
- `samples/benilla/crates/benilla/src/char_select/mod.rs` — `ClientState`
- `samples/benilla/crates/benilla/src/portrait/glue_booth.rs` — glue scene mechanism, stage spot,
  scene light rig (1.12 variant); `portrait/framing.rs` — diagonal→vertical FOV
- `samples/benilla/crates/benilla/src/net.rs` — offline/no-IO marking
- Client data, read at runtime: `interface/gluexml/*.xml|.lua`, `interface/glues/**/*.blp`,
  `interface/glues/models/ui_*/`, `fonts/*.ttf`
- Client data read as reference documents: `glueparent.lua` (`SetBackgroundModel`, `SetLighting`,
  `RaceLights`, `CharModelFogInfo`), `accountlogin.lua/.xml` (main-menu model choice, `ModelFFX` fog),
  `characterselect.lua`/`charactercreate.lua` (`SetSequence(0)`, `SetCamera(0)`)
- Existing infrastructure reused as-is: [`game/net/loader.js`](../../../client/src/game/net/loader.js),
  [`game/pipeline/texture-loader.js`](../../../client/src/game/pipeline/texture-loader.js),
  [`game/pipeline/blp/loader.js`](../../../client/src/game/pipeline/blp/loader.js)
