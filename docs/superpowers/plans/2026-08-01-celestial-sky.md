# The rest of the sky — celestial bodies, glare, and per-location skyboxes

The gradient dome and the procedural clouds are done. This plan covers everything else the reference
draws in the sky, including the per-location skies the user asked about.

Reference: `samples/benilla/crates/benilla/src/` — `sky_order.rs` (the draw-order ladder, read it
first), `sun/{mod,setup,follow,mesh,materials}.rs` (~1450 lines: discs, glares, stars),
`wmo_sky.rs` (the WMO painted skybox), `ffx_glow.rs` (the bloom composite). Each module header carries
the disassembly addresses and the verification status of its laws.

## The reference's fixed sky pass

`CSky::Render 0x6d4940` draws, in this order, all in one squashed depth slice with depth-write off:

**stars → sun disc → white moon → moon02 → gradient strip → cloud dome**

then the world, then weather, and the **glare quads last of all** — the frame's final draw, painting
over everything the z-buffer leaves visible.

We have the gradient strip and the cloud dome. Everything else on that list is missing, plus the glare
and two kinds of location-specific sky.

**How the order maps here.** benilla fights Bevy's view-z sort with `depth_bias` rungs; this client
does not have that problem, so the ladder is just `renderOrder` integers. **Do not port the
depth-bias numbers.** Port the *order*.

**But the reference's `SKY_FAR_DEPTH` law DOES port, and this section originally said it did not.**
That error shipped: clouds drew over mountains and buildings, and the sun disc would have too.

`renderOrder` sorts only *within* a render pass. three.js draws every **transparent** material after
every **opaque** one, so a transparent sky element with `renderOrder = -999` still draws after all
world geometry. `ProceduralSky` gets away with `depthTest: false` **only because it is
`transparent: false`** — in the opaque pass `-1000` genuinely does put it first, and the world paints
over it. Every other sky element is transparent and must therefore:

- `depthTest: true`, `depthWrite: false`, and
- force `gl_FragDepth = 1.0` in the fragment shader.

With three.js's default `LessEqualDepth`, a fragment at max depth survives exactly where the depth
buffer still holds its cleared value — i.e. where no world geometry drew. That is "the world paints
over the sky", independent of any shell radius, which is precisely what the reference's law says.
`sky/__tests__/sky-depth-law.test.ts` enforces it across every transparent sky element at once;
add new ones to it rather than re-deriving the rule.

(Do not write `gl_FragDepth` in a GLSL comment containing backticks — these shaders live in JS
template literals, and a stray backtick silently terminates the string.)

| element | renderOrder | notes |
|---|---|---|
| stars | −1003 | first, everything paints over them |
| sun disc | −1002 | |
| white moon | −1001 | where the discs cross, the moon paints over the sun |
| moon02 | −1000.5 | vertex-black; see Task 4 |
| gradient dome | −1000 | exists |
| cloud dome | −999 | exists |
| *world geometry* | 0 | |
| glare | +1000 | after the world and the weather |

The glare is the one element that must draw *after* the world, so it is the one element that cannot
simply live in the sky's negative band.

## Scope

Six tasks. Tasks 1–4 are the celestial bodies, Task 5 is the glare, Task 6 is the per-location skies.
FFXGlow (the full-screen bloom that consumes the `glow` band already published) is **out** — it is a
post-processing pass, not a sky element, and it deserves its own plan.

---

### Task 1: The celestial billboard and its shared laws

**Files:** create `client/src/game/world/sky/celestial/laws.ts`, `client/src/game/pipeline/sky/celestial/billboard.ts` (+ tests)

Every disc and glare is the same thing: a camera-anchored quad at `cam + 12·dir` (world space, no
local→world rotation — the reference's `0x6d3b80` builder), textured, tinted, and routed through the
shared horizon clip+fade `0x6d1960`.

Build that once. The bodies in Tasks 2–4 are then configuration, not new code.

**The tint law, and it is the big one** (the reference calls it "the big 0485 correction"): the discs'
and glares' RGB is **not hardcoded**. The client broadcasts one DayNight **celestial diffuse** colour —
`LightIntBand sub-9`, which stage 1 named `BAND_SUN_COLOR` when it corrected the off-by-one — into the
sun disc, the sun glare, the white-moon disc and the moon glare, every frame, alpha forced to 0xFF.
Warm cream at night, orange at dawn/dusk.

`BAND_SUN_COLOR` is loaded but **not yet blended or published**. Add it to `blendLights` through the
same per-light storm lerp as every other band, and publish it off `MapLight` as `celestialTint`.

Also port the horizon clip+fade — every disc uses it, and a disc that does not fade at the horizon pops
in and out.

---

### Task 2: The sun disc

**Files:** `client/src/game/pipeline/sky/celestial/sun.ts` (+ tests)

`sunCenter.blp`, plain alpha blend, a 1.0-unit quad at radius 12 — angular diameter
`2·atan(0.5/12) = 4.77°`. Size multiplied by the day curve: **2× at the dawn/dusk horizon, 1× at
midday**. Direction is the negated `sunDir` (the to-body vector), exactly as `cloudGlowDir` already
computes for the cloud glow — reuse that, do not recompute it.

Textures load through `client/src/game/pipeline/texture-loader.js`, which already handles BLP.

---

### Task 3: Stars

**Files:** `client/src/game/pipeline/sky/celestial/stars.ts` (+ tests)

The real `Environments\Stars\Stars.m2` — 7 textured patches covering an upper hemisphere,
camera-anchored. Load it through `M2ManagerLite`, which already exists.

Global alpha is the star curve; each patch is additionally scaled by **its own authored transparency
weight** (the reference notes `Stars.m2`'s weights run 1.0 … 0.25 — dimmer and brighter star groups).
The model is fully static, so sample any animation track at `t = 0`.

Keep the reference's procedural fallback for the case where the asset is missing, and make it look
obviously like a fallback rather than a plausible star field.

---

### Task 4: The white moon, and moon02

**Files:** `client/src/game/pipeline/sky/celestial/moons.ts` (+ tests)

- **White moon** — `moon.blp`, alpha blend, base size ×1.75, azimuth 45° (the sun's bearing). Direction
  is `laws.moonDirection`, already ported and tested for the cloud glow. Reuse it.
- **moon02** — draw it, and expect nothing. The reference is explicit: its colour field `[0xce98a4]`
  has **no writer in the binary**, so it renders vertex-black on a phase-precessed schedule
  (`fmod(dayCounter + todPhase, 1.7)`, clamped to [0,1], so it parks frozen high for the whole
  `[1.0, 1.7)` leg) and can never read as a second moon. Port it because it is in the draw order and
  omitting it silently changes what is on screen; do not "fix" it into visibility.

**Carry the reference's own note on the teal moon rim.** A director observed one moon with a teal rim
in Westfall. That is reproduced **not** by any cool tint — the moon and its glare are warm — but by the
dome's teal night bands alpha-blending through the moon disc's feathered edge and horizon fade. If the
rim does not appear, the bug is in the dome or the fade, not in the moon's colour. Do not chase it by
tinting the moon.

---

### Task 5: The glare — and the payoff for the cloud coverage field

**Files:** `client/src/game/pipeline/sky/celestial/glare.ts` (+ tests)

Two additive quads co-located with their discs, on the reference's **near sphere** (`cam + 12·dir`).

**Do not place these at the far plane.** The reference records exactly that attempt: a far-placed quad
at the byte-law flare size pierced the sky dome and the depth test cut a giant faceted halo edge
(decision 0500). Near sphere, and the *envelope* hides an occluded flare, not the depth buffer.

- **Sun glare** — `sunGlare.blp`, a **view-lerped lens flare**: quad scale 3→20 world units as the view
  axis swings onto the sun, `f = saturate((cosθ − 0.7)/0.3)`, intensity `lerp(0.5, 1, f)` × the slewed
  day envelope. A DAY flare: full 07:30–19:30, gone by 21:00.
- **Moon glare** — `moonglare.blp`, scale `2.0 × the moon size curve`, intensity `lerp(0.1, 1, f)` on
  the same view lerp × its own envelope. A DEEP-NIGHT halo: nothing until 22:45, full only near
  midnight.

**This is where the cloud coverage field finally gets its consumer.** `CloudKernel.coverage(d)`,
`occ1Sun` and `occ1Moon` are already implemented, tested, and published off `SkyManager` — unconsumed.
Sample coverage at the body's sky point and dim the flare by `occ1Sun = 1 − R` for the sun,
`occ1Moon = 1 − |2(R − 0.5)|` for the moon. The moon's is a **tent**: zero in perfectly clear sky *and*
under full cover, blooming only when a wisp crosses the moon.

Wire the glare to the *same* kernel instance the dome renders from. If it ever samples a second field,
the flare will dim for clouds that are not the ones on screen — which is precisely the failure the
one-field architecture exists to prevent.

The glare also needs the terrain/interior visibility gate the reference uses as its occlusion-query
stand-in.

---

### Task 6: Per-location skies

Two independent mechanisms, both of which this client already has the data for.

- [ ] **Step 1: zone skyboxes (`LightSkybox.dbc`)**

`client/src/wow-data-parser/dbc/entities/light-skybox.js` exists, and `lightSkyboxID` is already parsed
onto `LightParams` — and already **dropped**, exactly as `highlightSky`/`glow` were before stage 1.
Carry it through `blendLights` (a nearest-wins pick, not a blend — you cannot lerp a model path) and
publish it.

When a zone names a skybox, load that M2 and draw it in place of the gradient dome.

`client/src/game/pipeline/sky/skybox/index.ts` already exists but builds a **cube texture** from the
DBC. The reference draws the **M2 model** as authored. Replace the cube-texture approach rather than
extending it, and say so in the report.

- [ ] **Step 2: WMO skyboxes (MOSB)**

The painted sky a building swaps in — Stratholme's burning red sky is the one released 1.12 example.
`MOSB` is already parsed (`client/src/wow-data-parser/wmo/index.js:140`).

**The predicate is the trap, and it is what shipped wrong in the reference first.** The group flag
`0x40000` is tested **on the groups the portal flood REACHES, never on the group the camera stands
in**. In Stratholme's King's Square the camera stands in group 39 — the root's only EXTERIOR group,
which does *not* set the bit — yet the reference draws the painted sky, because 61 of the 83 groups its
flood reaches from there do carry it. So the predicate is *"any flood-reached group carries `0x40000`,
and the root names a MOSB"*.

A containing-group test draws no skybox in the one place the feature is visible in 1.12. Do not write
one.

Note also that four roots name a MOSB no group ever asks for (DireMaul's instance shell,
`Stratholme_A`, and both Sunken Temple roots — whose MOSB is not even a model path, it is the string
"the temple of atal'hakkar"). Keying off the chunk alone paints skies the reference never shows.

- [ ] **Step 3: the suppression rule**

**A skybox replaces the WHOLE celestial pass, not just the backdrop.** `CSky::Render` carries one
shared boolean and `0x6d4a3b` skips **all six** element draws together — stars, sun disc, both moons,
gradient band, and cloud dome. There is no per-element gating. Confirmed in a live capture of the
reference in King's Square: the entire sky slice is three draws (the cube's three texture pairs) and
nothing else.

Only the **glare** survives, because it renders outside the sky pass.

Implement it as one gate over the whole sky group, not six independent checks. This also matters for
the clouds already shipped: the reference notes that layering procedural clouds over painted art
"lifted the painted zenith out of its near-black".

---

## Done when

- `yarn test --watchAll=false` passes; `npx tsc --noEmit` clean.
- The sun tracks across the day and the moon across the night, both tinted by `BAND_SUN_COLOR` rather
  than a hardcoded colour, both fading at the horizon.
- Stars appear at night and fade out by day.
- The sun flare blooms as you look toward the sun and **dims when a cloud crosses it** — the coverage
  field's first real consumer.
- Standing in Stratholme's King's Square shows the painted red sky and **no** stars, discs, gradient or
  clouds — only the glare.
- The draw order matches the ladder above: clouds over a setting sun, glare over everything.

## Risks

1. **The tint law.** Hardcoding disc colours looks right at midday and is wrong at every other hour.
   The colour is `BAND_SUN_COLOR`, per zone and per time, and it is not currently published at all.
2. **The WMO skybox predicate.** A containing-group test is the intuitive implementation and it draws
   nothing in the only place the feature ships in 1.12.
3. **The suppression rule is all-or-nothing.** Six independent checks will drift; one gate will not.
4. **Glare placement.** Far-plane placement produces a faceted halo edge cut by the sky dome — an
   attempt the reference already made and recorded.
5. **The shared coverage field.** The glare must sample the same kernel the dome renders, or the flare
   dims for clouds nobody can see.
6. **Asset availability.** `Stars.m2`, `sunCenter.blp`, `sunGlare.blp`, `moon.blp`, `moonglare.blp` and
   the skybox M2s must all resolve through this client's asset chain. Verify each loads **before**
   building its consumer, and report any that do not rather than silently falling back.

## Handoff

After this the sky is complete against the reference except **FFXGlow** — the full-screen glow pass
(scene → ½ → ¼ downsample → separable Gauss4 → `out = screen + w·blur²` in gamma bytes, `w` = the
per-zone `LightParams.glow` weight already published and still unconsumed). That is a post-processing
pass rather than a sky element and wants its own plan.
