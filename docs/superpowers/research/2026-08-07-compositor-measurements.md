# The body-texture compositor — measured, and a recommendation

**Date:** 2026-08-07
**Status:** measurement spike complete. Nothing wired in. Sibling to
[`2026-08-07-character-model-findings.md`](2026-08-07-character-model-findings.md), which this settles
**unknown 1** (composite canvas size) and **unknown 4** (CPU blit versus GPU render target) of.
**Question:** where does the bake happen, and how big is the canvas?

Every number below was taken in Chrome against the live asset host
(`https://data-direct.spelunkerdb.com/12340`) through the client's own BLP worker, on the real
`CharSections` layer set for the owner's character (Human male, skin 0 / face 4 / hairStyle 11 /
hairColor 5 / facialHair 1). The prototype is `client/src/game/ui/scene/bake-spike.ts` — inert, console
only, delete it with piece 5. What could not be measured is named in §7 rather than estimated.

---

## 0. The answer in six lines

| | |
|---|---|
| **Composite canvas** | **512×512**, mipped. The base skin *is* the canvas and it measures 512×512. |
| **Where the bake goes** | **CPU (option A).** |
| **Per appearance change** | **4.7 ms** naked, **6.3 ms** dressed, main thread, 512² with a full mip chain. |
| **Why not the GPU** | The GPU is 0.3 ms — 14× faster and equally invisible. It costs the client's first `WebGLRenderTarget`, 8.7 MB of VRAM for source layers, and a borrowed renderer. |
| **The premise that changed** | **All 38 source BLPs are palettized, not DXT.** The loader already returns them decoded. Option A needs *no new decode path* — §2. |
| **What actually costs time** | Not the bake. The source fetch: 53.8–144 ms per texture cold, p50 57.4 ms — §5. |

---

## 1. The real layer set for a Human male

Read out of `CharSections.dbc` (8958 records, 10 fields, 40-byte stride) with the create predicate
`(flags & 0x01) && !(flags & 0x04) && !(flags & 0x08)` from §2.2 of the findings
(`scratchpad/cs-layers.js`). Keying, per `BaseSection`: skin `(variation 0, color = skin)`; face
`(variation = face, color = skin)`; facial hair `(variation = facialHair, color = hairColor)`; hair
`(variation = hairStyle, color = hairColor)`; underwear `(variation 0, color = skin)`.

| BaseSection | row id | flags | `TextureName[0]` | `[1]` | `[2]` |
|---|---|---|---|---|---|
| 0 skin | 1 | 17 | `HumanMaleSkin00_00.blp` | — | — |
| 1 face | 5223 | 1 | `HumanMaleFaceLower04_00.blp` | `HumanMaleFaceUpper04_00.blp` | — |
| 2 facial hair | 146 | 17 | `FacialLowerHair01_05.blp` | `FacialUpperHair01_05.blp` | — |
| 3 hair | 326 | 17 | `Hair02_05.blp` | `ScalpLowerHair02_05.blp` | `ScalpUpperHair02_05.blp` |
| 4 underwear | 3381 | 17 | `HumanMaleNakedPelvisSkin00_00.blp` | — | — |

So the composite is **8 layers**, not 9: `Hair02_05.blp` is the hair *mesh sheet* — texture type 6,
sampled directly by the hair geoset — and never enters the bake. `hairStyle 11 → Hair02_*` confirms the
findings' point that the hair file index is table data, not the dial value.

**One consequence the findings did not draw out: a *skin* click is a four-texture change, not one.**
Face and underwear are keyed on `colorIndex = skin`, so stepping skin 0→1 replaces
`HumanMaleSkin00_00`, `HumanMaleFaceLower04_00`, `HumanMaleFaceUpper04_00` *and*
`HumanMaleNakedPelvisSkin00_00`. Measured on the 12-step sequence (`scratchpad/cs-sequence.js`).
`hairStyle 0` is bald and drops both scalp layers, so the layer count varies 6–8 naked.

Dial ranges, data-derived from the same predicate, agreeing with §2.2 of the findings: skin 10,
face 12, hairStyle 12, hairColor 10, facialHair 9.

---

## 2. The DXT premise was wrong, and it changes the whole question

Findings §2.7 says *"The base skin and most region textures are DXT (`compress = 1` in the measurements
above), so a CPU blit needs them decompressed — the existing loader deliberately does not"*, and
unknown 4 is built on it. **It does not hold.** Every BLP in the layer set, and every one in the eight
armour regions, is **palettized** — BLP2 `colorEncoding = 1`, not 2.

Measured two independent ways. From the file headers with `curl` (`scratchpad/blp-dims-all.js`), and at
runtime from what `pipeline/blp/loader.js` actually returned through the worker: **all 38 sources came
back as `format: 2` = `IMAGE_ABGR8888`**, i.e. decoded RGBA. `loader.js:19-23` only leaves a level
compressed when `blp.colorFormat === COLOR_DXT`, and for these files it never is.

```
 512x512 palette a0 mips=10  350697B  humanmaleskin00_00.blp        <- the base skin, NOT DXT
 256x128 palette a0 mips= 9   44863B  humanmalefacelower04_00.blp
 256x 64 palette a0 mips= 9   23019B  humanmalefaceupper04_00.blp
 128x 64 palette a8 mips= 8   23018B  faciallowerhair01_05.blp
 128x 32 palette a8 mips= 8   12098B  facialupperhair01_05.blp
 128x 64 palette a8 mips= 8   23018B  scalplowerhair02_05.blp
 128x 32 palette a8 mips= 8   12098B  scalpupperhair02_05.blp
 256x128 palette a0 mips= 9   44863B  humanmalenakedpelvisskin00_00.blp
  64x128 DXT     a1 mips= 8    6652B  hair02_05.blp                 <- the MESH SHEET, not a layer
```

The one DXT file in the neighbourhood is the hair mesh sheet, which the bake never touches. All eight
`ItemDisplayInfo` region tiles for the findings' own example row 40390 are palettized too
(`scratchpad/equip-probe.js`): ArmUpper `_U` 128×64, ArmLower `_U` 128×64, Hand `_U` 128×32,
TorsoUpper `_M` 128×64, TorsoLower `_M` 128×32, LegUpper `_U` 128×64, LegLower `_M` 128×64,
Foot `_M` 128×32 — every one `enc=1`.

**So the "either the BLP worker gains a decode-DXT mode, or the bake goes on the GPU" fork is a false
one.** The decode a CPU blit needs already happens, in a worker, with transferables. There is no new
decode path to write. That removes the only structural cost option A ever had.

Do not read this as "DXT never appears in a bake": a spot check is not the whole table, and armour art
for other item families was not swept. It does mean the layers a naked Human male needs, and the one
robe row the findings cite, are all palette — and that a DXT layer, if one turns up, is a *fallback* the
existing `dxt.ts` already covers rather than a blocker.

---

## 3. The composite canvas is 512×512

**The canvas is the base skin's own size**, because the base skin is blitted over the whole of it
(benilla `sections.rs:205`, the first overlay in the order). In 1.12.1 that was 256×256. In 3.3.5a
`HumanMaleSkin00_00.blp` measures **512×512 with 10 authored mips**, and so does `TaurenMaleSkin00_00`,
so this is not one file's quirk.

Everything else follows, and the confirmation is that benilla's tile table doubles into it *exactly*:

| tile | benilla, 1.12.1 (`sections.rs:31-47`) | ×2 → 512² | 3.3.5a art measured | fit |
|---|---|---|---|---|
| head upper | `(0,160,128,32)` | `(0,320,256,64)` | `HumanMaleFaceUpper04_00` **256×64** | **1:1** |
| head lower | `(0,192,128,64)` | `(0,384,256,128)` | `HumanMaleFaceLower04_00` **256×128** | **1:1** |
| pelvis | `(128,96,128,64)` | `(256,192,256,128)` | `HumanMaleNakedPelvisSkin00_00` **256×128** | **1:1** |
| body | whole canvas | whole canvas | `HumanMaleSkin00_00` **512×512** | **1:1** |
| head upper (scalp/facial) | — | `(0,320,256,64)` | `ScalpUpperHair02_05` 128×32 | needs **×2** |
| head lower (scalp/facial) | — | `(0,384,256,128)` | `ScalpLowerHair02_05` 128×64 | needs **×2** |
| all 8 item regions | `(…,128,64/32)` | doubled | still 128×64 / 128×32 | needs **×2** |

Three of the four character-owned tiles land on the nose at 512², which is what a canvas size *means* —
the art was re-authored for it. The mixed-scale layers need an integer ×2, and a factor of exactly two
by nearest neighbour **replicates each source texel**: it invents no detail and discards none. The
composite's own mip 1 is then that layer's authored resolution, so the chain is honest all the way down.
(The kernel expresses this as a per-layer mip shift: `shift = log2(tileWidth / sourceWidth)`, `+1` for a
1×-era layer, and only dest level 0 ever doubles.)

**256² is the worse choice, and there are two measured reasons, not one.**

1. It halves the character's linear resolution everywhere. Every re-authored 3.3.5a layer — the base
   skin and all three face/pelvis tiles, i.e. the whole body and the face, the parts a player looks at
   — has to be read one authored mip down. That is exactly the resolution the art was re-authored to
   escape.
2. It makes the two bake options stop agreeing. See §4: at 512² the CPU and GPU bakes are the same
   picture (mean absolute difference **0.027**/255, max 2, 97.3 % of channels bit-identical); at 256²
   they diverge (**1.715**, max **144**, only 64.8 % identical), because a *downscale* makes the CPU
   kernel's authored-mip read and the GPU's filtered minification two different operations. A canvas
   size that only one of the two implementations can hit correctly is a canvas size with a hidden
   constraint in it.

The findings' §2.3 leaned the other way ("the cheap correct-looking choice is 256²… no resampler is
needed"). The premise there was that 512² "needs every 1× layer upscaled" and that upscaling is loss.
It is not, at a factor of two — and 256² needs a *downscale* of the majority of the art, which is.

**Bytes.** 512² RGBA with 10 mips = **1 398 100 B** per composite. 256² with 9 mips = 349 524 B. At one
composite per character, 1.4 MB is not a number worth trading a face for; the LRU the findings §3.4
already asks for bounds it.

---

## 4. Do the two options produce the same picture?

Asked and answered by pixel comparison rather than by eye, because the whole recommendation rests on the
two being interchangeable. `bakeSpike.verify()` bakes step 0 both ways and sweeps the two orientation
choices (source `flipY`, readback row flip) against the CPU kernel as reference:

| orientation | mean abs diff /255 | max diff | channels bit-identical |
|---|---|---|---|
| `srcFlipY=true, readbackFlip=true` | **0.027** | **2** | **97.33 %** |
| `srcFlipY=true, readbackFlip=false` | 32.676 | 254 | 26.80 % |
| `srcFlipY=false, readbackFlip=true` | 27.231 | 254 | 27.36 % |
| `srcFlipY=false, readbackFlip=false` | 15.582 | 219 | 72.90 % |

One combination is right and the residual is ±1–2 on 2.7 % of channels — the GPU's fixed-function
8-bit source-over rounding against the kernel's integer division. **The options are equivalent at 512².**

Worth recording because it is a trap: the source textures need `flipY = true` for the GPU path, against
this client's otherwise uniform `flipY = false` (`pipeline/texture-loader.js:26-28`). `PlaneGeometry`'s
UV puts `v = 0` at the bottom, so a `flipY = false` texture draws its first row — the image's *top* —
along the quad's *bottom* edge. Three of the four combinations above are a plausible-looking upside-down
bake, and only the number distinguishes them.

Eyeball artefacts: `scratchpad/bakeA-512-preview-cpu.png`, `scratchpad/bakeB-512-preview-gpu.png`.

---

## 5. The numbers

**Backend matters and is stated per column.** *Real GPU* = headed Chrome, `ANGLE (NVIDIA GeForce RTX
4070 Laptop, D3D11)`. *SwiftShader* = headless with `--use-angle=swiftshader`, i.e. no GPU at all, which
is the floor a user without hardware acceleration lands on. Sources pre-warmed; p50 of 7 repeats per
step over the 13-step sequence; `scratchpad/R512-512.json`, `R256b-256.json`, `SW512-512.json`,
`V512-512.json`.

### Per appearance change — the number that decides it

| | **A: CPU blit** | **B: GPU render target** |
|---|---|---|
| 512², 8 layers (naked), full mip chain — real GPU | **4.7 ms** | **0.3 ms** |
| 512², 16 layers (naked + 8 armour regions) | **6.3 ms** | **0.5 ms** |
| 512², level 0 only (no mip chain) | 3.2 ms | 0.3 ms |
| 256², 8 layers / 16 layers | 1.5 ms / 2.0 ms | 0.4 ms / 0.5 ms |
| 512², 8 layers — **SwiftShader** | 7.6 ms (max 24.4 on the first two bakes, JIT warm-up) | 0.6 ms |
| worst step seen, any config, real GPU | 6.3 ms | 1.0 ms |

Ten successive create-screen clicks therefore cost **~47 ms of main thread** on A and **~3 ms** on B,
warm. A create screen's arrows have `OnClick` only (`charactercreate.xml:176-192`, findings §3.4), so a
4.7 ms bake in a click handler is a third of one frame and cannot produce a visible hitch. The 400 ms
figure the brief was guarding against is two orders of magnitude away from both options.

### Everything else

| | **A: CPU blit** | **B: GPU render target** |
|---|---|---|
| one-time setup | none | **0.9 ms** target allocation (2.1 ms on SwiftShader) |
| composite upload to GPU | 0.2 ms (`renderer.initTexture`, 1.4 MB, 10 levels) | n/a — it is already there |
| source layers uploaded to GPU | **none** | every layer, 8 per bake / **8.67 MB** for the 38-source run |
| VRAM at rest | 1.4 MB (the composite) | 1.4 MB target + 8.67 MB of source layers |
| JS heap resident | 8.67 MB decoded sources + 1.4 MB composite | 8.67 MB decoded sources |
| new machinery needed | **none** | the client's **first** `WebGLRenderTarget` |
| readback needed | no | no — the M2 samples `target.texture` |
| shares the existing renderer | n/a | yes, and must restore `autoClear`/`sortObjects`/target |
| can leave the main thread | **yes** — worker round trip of a 1.4 MB transferable measured at **p50 0.1 ms** | no (a WebGL context is not a worker's) |
| draw calls / blit ops | 73 blits naked, 145 dressed | 8 draws naked, 16 dressed |

### The cost that dwarfs both: getting the sources

| | measured |
|---|---|
| cold fetch + worker decode, per source, sequential | min 53.8 ms, **p50 57.4 ms**, max 144 ms (n=38) |
| decode + worker round trip alone (HTTP cache warm) | min 0.8 ms, **p50 1.3 ms**, max 57 ms |
| all 38 sources cold, sequential | 2.1–4.8 s wall |
| the 4 new sources a **skin** click needs, warm, concurrent | **5.5 ms** |
| total bytes over the wire for the 12-step run | 2 197 878 B |

**Decode is 1.3 ms; the other 56 ms is the network.** So the create screen's real latency budget is
spent on HTTP, identically for both options, and the first click on a fresh dial is a round trip
whichever bake wins. That is where a prefetch-the-neighbouring-dial-values optimisation would pay, and
neither option A nor B changes it.

---

## 6. Recommendation: **CPU, 512², and put the blit in a worker when the world needs it**

**Take option A.** The 14× ratio is real and irrelevant — 4.7 ms and 0.3 ms are both invisible inside a
click handler, and both are dwarfed by the 57 ms source fetch — so latency does not decide this, and the
secondary grounds are one-sided:

1. **A needs nothing new.** Its only claimed blocker, the DXT decode, does not exist (§2): the loader
   already hands back decoded RGBA in a worker. B needs the client's first render target, in a renderer
   that deliberately draws the glue stage straight into the canvas first-pass
   (`glue-scene.ts:15-18` — *"a fullscreen render-to-texture would cost a target and a blit for
   nothing"*), and every bake must borrow and correctly restore that renderer's `autoClear`,
   `sortObjects` and current target. `autoClear` is the dangerous one: `ui/renderer.ts:1-10` runs with
   it **off** so the widget pass composites over the 3D pass, and a bake that left it on would blank the
   UI layer. That is a small hazard, but it is a hazard A does not have.
2. **A costs no VRAM for source layers.** B has to upload every layer it composites — 8.67 MB across the
   38-source run here, and characters in the world (piece 11) multiply the *set*, not the target.
3. **A is portable to a worker for free.** The composite is 1.4 MB and a transferable round trip
   measured **p50 0.1 ms**, so the 4.7 ms leaves the main thread entirely whenever it needs to. That is
   the answer for piece 11: thirty characters at 6.3 ms each is 190 ms of main thread if done inline,
   and ~0 if the blit lives beside the decode in the BLP worker, which already holds the source RGBA.
   B cannot follow — a WebGL context does not belong to a worker.
4. **It is what the reference does.** `CharSections::composite_body` (`sections.rs:181-242`) is a CPU
   8-bit source-over blit with a mip walk, and `blit_over` (`:307-347`) is the kernel this spike ported.
   Porting benilla's structure verbatim, with the numbers doubled for 3.3.5a (§3), is a smaller and more
   auditable piece of work than inventing the GPU equivalent — and the findings' §4.3 rule was already
   "port the structure and the tables, not the numbers".
5. **Correctness is easier to see.** A CPU composite is a `Uint8Array` a test can assert on and a
   `putImageData` can show. A render target needs a readback to inspect at all, and §4 is the evidence
   that its orientation has four plausible answers and one right one.

**Nothing here argues option B is wrong** — it is faster, it works, and it produces the same pixels. If
a later consumer needs a render target anyway (a paper-doll booth, a portrait, benilla's
`portrait/glue_booth.rs` shape), revisit: at that point the target exists for other reasons and the bake
may as well share it. Today it would exist only for this, at 0.3 ms against 4.7 ms that nobody can see.

**Concrete shape for piece 5, then:**

- Canvas **512×512**, RGBA, 10 authored mip levels, `generateMipmaps = false`, `flipY = false` — the
  same convention as every other texture in the client (`texture-loader.js:26-28`).
- Tile table = benilla's, ×2 (§3). Per-layer mip shift `log2(tileWidth / sourceWidth)`; only level 0
  ever point-doubles.
- Overlay order = findings §2.3, including the hair column shift (`[1]/[2]` for hair against `[0]/[1]`
  for face and facial hair).
- Cache keyed on the whole appearance tuple, so a dial cycled back is a map hit (measured: step 11
  returns to step 0's tuple and every source is already resident).
- Ship the blit inline on the main thread. Move it into the BLP worker when piece 11 asks — the
  interface is already a transferable `Uint8Array`, and the transfer costs 0.1 ms.
- **Do not** put a resampler in it. Every scale factor in the whole layer set is exactly 1 or 2.

---

## 7. What could not be measured

Named, not estimated. Each is a real hole in the table above.

1. **GPU execution time, separately from submit.** `gl.finish()` returned inside the timer's resolution
   (0.0 ms) on both the RTX 4070 *and* SwiftShader, so the "GPU total" column is a **CPU-submit**
   measurement with only a lower bound on the GPU's own work. For a bake this small that is probably the
   truth, but the number is not proof of it. A `EXT_disjoint_timer_query_webgl2` pass would settle it.
2. **Peak heap.** `performance.memory` came back `{}` in this Chrome, so every memory figure is computed
   from the buffers allocated (source RGBA levels, composite levels), not read from the engine. VRAM
   likewise: WebGL exposes no query, so 8.67 MB and 1.4 MB are texel arithmetic.
3. **Whether *all* armour art is palettized.** 38 files were measured, including all eight regions of the
   one `ItemDisplayInfo` row the findings cite. `ItemDisplayInfo` has ~40 000 rows; this is a spot check
   with a clean result, not a sweep. A DXT region would fall back to the existing `dxt.ts`, not break
   anything, but the claim in §2 is bounded by what was measured.
4. **A 3.3.5a client screenshot comparison.** §3 argues 512² from the art's own dimensions and from
   benilla's table doubling exactly. Findings unknown 1 asked for a side-by-side against a real client at
   a known camera; that was not done, and it remains the only way to catch a canvas size that is right
   arithmetically and wrong in fact.
5. **Unknowns 2 (`CharacterFacialHairStyles` column order) and 3 (`CharSections` flag `0x10`)** were not
   touched. Neither blocks piece 5.
6. **Online world entry.** Job 1 verified the world render through `/game?offline=1` as instructed, so
   the earlier "both servers answer AUTH_REJECT" claim is neither confirmed nor refuted for the *world*
   handshake. The character roster does arrive from the real server — five characters, `Gesf` among them
   (`scratchpad/bcs-B-after.png`).

---

## 8. The prototype, and what it touches

`client/src/game/ui/scene/bake-spike.ts` — new, ~490 lines, and **inert**: `installBakeSpike(renderer)`
publishes `window.bakeSpike` and returns. Nothing fetches, allocates a target, or touches a material
until a console call asks. Same shape and same justification as `installFramexmlDebug`
(`ui/framexml/debug.ts`) and `skyDebug` (`pipeline/sky/debug/index.ts`).

`client/src/game/ui/screens.ts` — two lines: the import, and `installBakeSpike(this.renderer)` beside
the existing `installFramexmlDebug()` call in `start()`.

Nothing else in `client/src` changed. No dependency was added; both options are built entirely from
three.js and the client's existing BLP worker, which is the finding the brief asked for on that point —
**neither option needs a library**.

Surface:

```
bakeSpike.prefetch(paths)        fetch + worker-decode, per-source ms
bakeSpike.decodeOnly(paths)      the same with the HTTP cache warm: decode alone
bakeSpike.parallel(paths)        the whole set at once, wall time
bakeSpike.encodings()            what the loader really returned (all format:2 = ABGR8888)
bakeSpike.sourceBytes()          decoded-RGBA footprint of the resident sources
bakeSpike.verify(step, canvas)   CPU vs GPU, per-channel, over four orientations
bakeSpike.transferCost(bytes)    a transferable round trip of the composite's size
bakeSpike.run(sequence, opts)    both options over a step sequence; { canvas, allMips, repeats }
bakeSpike.preview(step, how)     a PNG data URL to look at
```

**Delete both, together, when piece 5 lands.** The tile table, the mip-shift rule and the `blit_over`
kernel in it are the parts worth carrying across; the timing harness is not.

Runners and artefacts are in the session scratchpad, not in the repo: `cs-layers.js`,
`cs-sequence.js`, `blp-dims-all.js`, `equip-probe.js`, `add-dressed.js`, `bake-measure.js`,
`bake-measure2.js`, `bake-charselect.js`, and the `R512-*`, `R256b-*`, `SW512-*`, `V512-*`, `V256-*`
JSON and PNG outputs.

---

## 9. Job 1, for the record: the collision hull in the world

Separate from the compositor, and the reason it is here is that it was the same session.

Commit `8ba83e4` was **verified in the world**, through `/game?offline=1` (`OFFLINE_SPOT_ID =
'stormwind'`, `network/offline-session.ts:17`), on a real GPU. The offline path is **not** broken: it
loads Elwynn/Stormwind terrain, WMOs, doodads and the player model and holds 52–60 FPS at 342 draw calls
/ 47 316 triangles (`scratchpad/w1-world-2.png`, `w2-A-fixed.png`). No missing geometry, no pale
rectangles, no depth artefacts. The earlier "both servers answer AUTH_REJECT" claim did not need
resolving to do this.

Two things the world measurement adds that the glue stage could not show:

- **8028 collision hulls exist in the loaded scene.** All 8028 are `visible = false` after the fix, and
  all 8028 still carry `transparent: true` with `depthWrite: true` — so `visible = false` is the *only*
  thing keeping them out of the transparent pass. Before the fix that was 8028 invisible depth-writing
  draws submitted in one zone.
- **Flipping them back to `visible = true` at runtime, same camera, same second, took draw calls from
  342 to 439** — +97 for the hulls in view. So the fix is a measurable draw-call win in the world on top
  of the correctness fix, and the "every doodad, WMO doodad and unit was submitting one" line in the
  commit message is confirmed at scale (`w2-A-fixed.png` versus `w2-B-hulls-visible.png`).

**One correction to the brief.** The change `8ba83e4` makes is `mesh.visible = true` → `false`, not
`depthWrite = false`. `depthWrite` is discussed at length in the comment as the *mechanism* of the bug,
and setting it false was the experiment that pinned the diagnosis, but the shipped fix is stronger: the
hull is not submitted at all.

Also verified, because the spike borrows the shared renderer: the login stage (aurora, clouds, logo,
gold captions) and the character-select stage (cobblestone, Stormwind wall, the character on the stage
spot, the five-character roster) both draw correctly **after** a full render-target bake has run through
that renderer — `scratchpad/bakeB-1-after-spike.png` and `bcs-B-after.png`.
