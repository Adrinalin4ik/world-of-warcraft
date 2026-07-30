# WMO and M2 lighting, matched to benilla

**Date:** 2026-07-30
**Status:** design, pending implementation plan
**Reference:** `samples/benilla` — a from-scratch Rust/Bevy WoW 1.12.1 client whose lighting is
derived from `WoW.exe` 5875 disassembly and apitrace captures, with the derivations recorded in code
comments.

## Why

Two separate problems, found by reading the current code against the reference.

**WMO geometry renders fully unlit.** The active fragment shader
(`client/src/game/pipeline/wmo/material/shaders/fragment/main.glsl`) computes a combiner result and
then discards it:

```glsl
result = combinersOpaque();                    // consumes colors[0], the lit vertex colour
...
result = texture2D(textures[0], coords[0]);     // overwrites it
```

The vertex stage does compute lighting into `colors[0]`. It never reaches the screen. Every WMO in
the world is raw texture plus fog: no time of day, no MOCV bake, no interior/exterior distinction.

**M2 lighting works but runs the wrong response.** It takes a plain matte
`clamp(ambient + diffuse·max(N·L,0))`. The reference does not: exterior M2s are drawn by
`Shaders\Vertex\Model2.bls`, gated on the `M2UseShaders` cvar which defaults to `"1"`, and that
program is an order-2 irradiance lobe. The fixed-function light commits visible in a world frame
belong to terrain and WMO. Alongside that: a hardcoded `* 0.5` on vertex colour, radial-distance fog
where the reference uses planar eye-Z, and linear point-light attenuation where the reference uses a
byte-verified reciprocal.

Also dead: `M2Material.setWmoLights` has no callers, so interior doodads run on ambient alone.

Our `SUN_PHI_TABLE` / `SUN_THETA_TABLE` already match benilla's `DayNight::SetDirection` values
exactly. The sun direction is sound and is not touched.

## Scope

**In:** the M2 exterior irradiance lobe; interior M2 prop SH probes; the WMO fixed-function law with
its three batch classes; SIDN night glow; the WINDOW midpoint law; per-object point-light selection
with the verified falloff; MFOG interior fog with its crossfade; one shared fog implementation across
M2, WMO and terrain; the `Light.dbc` 8-slot `LightParams` schema and slot selection.

**Out, and why:**

- **Specular, and WMO per-group authored colour.** benilla excludes both. Specular is its deferred
  "Step 7b", held back because M2 per-material shininess is *inferred* rather than verified. Matching
  the reference here means matching its uncertainty. This omission is deliberate — not an oversight.
- **Terrain and sky *lighting*.** Outside the request. Terrain's *fog* is in scope (see below).

## Architecture: the per-object lighting block

Reference behaviour needs per-instance lighting data, and our M2 materials are shared across all
instances of a model (`M2` clones share `this.batches`). benilla solves this with a `MeshTag` payload
indexing a GPU slab, because Bevy cannot do per-draw uniforms. three.js can: setting
`material.uniformsNeedUpdate = true` inside a mesh's `onBeforeRender` forces a uniform re-upload for
that draw.

So each M2 batch mesh gets an `onBeforeRender` that writes its instance's block into the shared
material and flags the refresh. Because a per-draw upload is already being paid for, the block
carries **values**, not a slot index — no slab allocator, no refcounting, no content dedup, no
`DataTexture`. benilla's `PropProbes` slab, `ProbeKey` dedup and `PropProbeSlot` lifecycle hook all
exist to work around Bevy's constraint and have no analogue here.

Block contents per instance:

| Field | Meaning |
|---|---|
| `sunIntensity` | terrain-shade family value (exterior lane) |
| `probeCoeffs[7]` | folded order-2 SH probe (interior prop lane) |
| `pointLights[3]` | position + colour, selected nearest to *this instance's* origin |

**This is the design's main risk.** A forced uniform refresh per draw costs more than one refresh per
material. The plan must *measure* it in a doodad-dense scene rather than assume. Fallback if it
regresses: clone materials per instance for interior props only — a bounded set — and keep sharing
everywhere else.

## Module boundaries

### `client/src/game/world/light/laws.ts` (new)

Pure functions. No three.js scene dependencies, no I/O, unit-testable in isolation.

- `propProbeCoeffs(ambient, lobes) → vec4[7]`
- `cap96(bytes) → rgb`, `floor112(bytes) → rgb`
- `foldInteriorProbe(ambient, diffuse, refPoint, molrLights) → vec4[7]`
- `selectPointLights(anchor, lights, max) → light[]`
- `sidnNightFraction(minute) → number`
- `stormBlend(density) → number`

### `client/src/game/world/light/PerObjectLight.ts` (new)

Holds one instance's resolved lighting state and writes it into a material's uniforms. Owns the
`onBeforeRender` attachment. This is the only module that knows about the per-draw push mechanism;
`laws.ts` stays ignorant of it and the shaders stay ignorant of how the values arrive.

### Changed

`m2/material/fragment/common-header.glsl`, `m2/material/vertex/common-main.glsl`,
`wmo/material/shaders/{vertex,fragment}/*.glsl`, `adt/chunk/shader.frag` (fog block only),
`world/light/MapLight.ts`, `wmo/root/loader/definition.js`, `wmo/index.js`.

## The laws

### M2 exterior — the `Model2.bls` lobe

With `A` = ambient, `D` = diffuse, `I` = per-instance intensity, `u` = toward-light unit,
`μ = N·u`:

```
E = A + D·I·(4/17)·(0.375 + 2μ + 1.875μ²)
lit = clamp(E, 0, 1)
```

Peaks at exactly `1.0` at `μ = 1` by construction: `(4/17)(0.375 + 2 + 1.875) = 1`. Side-on gives
`0.0882·D`, fully-away `0.0588·D` — an authored soft wrap, not a bug.

**Clamp the sum, never a term.** The lobe legitimately dips to `−0.037·D` around `μ ≈ −0.53`
(low-order SH ringing). Clamping the sun term alone floors that dip away and erases part of the
authored response.

Intensity family, from the per-material shade selector and the per-instance shade value: `2.5` on lit
ground, `0.5` on MCSH-shadowed ground, fixed `1.0` for an exterior WMO prop, capped by `min(I, 1)`.

**Under the cap the family collapses to two observable states.** `2.5` and `1.0` both render as
`1.0`, so the only visible distinction is MCSH-shadowed (`0.5`) versus everything else. That single
distinction still requires a per-doodad terrain-shade input, and nothing in this client produces one
today: `MCSH` is parsed in the ADT reader but never sampled for doodads. So the intensity family
needs an MCSH lookup at each doodad's base position, and that lookup is the *only* reason the family
is not dead code while the cap stands. If the cap is ever lifted, the same input immediately carries
the full 2.5 ↔ 0.5 range.

**The cap is unfaithful and stays anyway.** benilla's own comment flags it as the one unfaithful term
in the lane: the reference does not cap the gain, so a lit doodad commits ×1.0 where the reference
gives ×2.5, and doodads read dimmer than the reference. Lifting it pushes sun-facing surfaces well
past 1.0 and is a world-wide look change — a call for whoever owns the look, not one to make while
porting. Keeping the cap also keeps benilla's paired CPU-side compensation valid: because the cap
sits on the multiplier, every target from 2.5 down to 1.0 renders identically, so a shade ramp must
aim its lit target at 1.0 or spend most of its travel invisible. **Cut the cap and that target must
go back to 0.0 in the same change; never cut one alone.**

### Interior M2 props — the SH probe

Order-2 probe, folded once at load, day/night-independent. Per lobe (colour `C`, toward-light unit
`u`):

```
DC     += C·(4/17)·(0.375 + 0.9375·(uₓ² + u_y²))
linear += C·(8/17)·u
n.xy   += C·(15/17)·uₓu_y        (n.yz, n.xz alike)
n.z²   += C·(7.5/17)·(u_z² − ½(uₓ² + u_y²))
x²−y²  += C·(7.5/34)·(uₓ² − u_y²)
```

Ambient adds to DC ×1. Lobes are additive. Evaluated per fragment over the basis
`(n, 1)`, `(n.xy, n.yz, n.z², n.xz)`, `n.x² − n.y²`. The expansion depends only on `μ = n·u`, so
folding and evaluating in the same frame is exact regardless of which frame that is.

Inputs, per MODD entry: `ambient = cap96(MODD.color)`, `diffuse = floor112(MODD.color)` committed on
the fixed engine axis `(0.30822, 0.30822, 0.9)` — **never the day/night sun** — plus each MOLR lobe
of the owning group, gated by that light's disk window from the doodad's position:
`d ≤ attenStart → 1`; `d ≥ attenEnd → excluded`; otherwise linear.

`cap96` and `floor112` are integer byte laws and must be ported as such:

- `cap96`: max channel ≤ 96 passes through; otherwise scale by `round(96·255/max − 0.5)` and
  recombine as `(v·scale + 255) >> 8`.
- `floor112`: max channel ≥ 112 (or 0) passes through; otherwise the **truncating** integer scale
  `(v·112)/max`. Truncation is load-bearing — `63·(168/83) = 127.52` must land on 127, and
  nearest-rounding gives 128.

A group with no MOLR means **no point light at all**, its own flame included.

### WMO surfaces — fixed-function

WMO genuinely is fixed-function, so it takes the matte, not the lobe:

```
primary = clamp(MOCV·(ambient + diffuse·max(N·L,0)) + emission, 0, 1)
out     = texture × primary
```

MOCV multiplies the lit terms *inside* the clamp (`GL_COLOR_MATERIAL` — MOCV is the material
ambient+diffuse) and never the emission terms beside them. **The light sum saturates first, then the
texture modulates**, so a surface never exceeds its own fully-lit texture. Ordering it the other way
lets a close fixture blow a dim bake to saturated colour.

Lighting moves from the vertex stage to the fragment stage, matching benilla.

Batch classes come from `MOBA` ordering, already parsed as `batchType` (1 = TRANS, 2 = INT,
3 = EXT):

- **EXT (3)** — plain `primary` above.
- **INT (2)** — unlit: `clamp(texture · MOCV · (1 + 4·MOCV.a))`. The baked vertex colours *are* the
  room's light, constant day and night. The `4.0` is literal in the reference's interior pixel
  shader, and this product is **not** pre-clamped like the FFP light sum — it may legitimately
  overdrive to white. MOCV alpha is an authored emissive mask (a fireplace surround bakes ≈100,
  giving ×2.6) and is near-zero everywhere unpainted, where this collapses to plain `tex × MOCV`.
- **TRANS (1)** — per-vertex lerp between lit and the unlit bake: lit factor becomes
  `mix(1, lit, MOCV.a)`. This collapses the reference's two-pass
  `lit×SRC_ALPHA + unlit×(1−SRC_ALPHA)` into one pass.

Note the current shader has TRANS and INT doing the *same* thing and neither matches; only EXT is
close.

**MOCV alpha must be un-folded before any cutout test.** Coverage is the texel alpha; MOCV alpha
never reaches coverage.

**SIDN** (MOMT `0x10`): the authored emissive colour × the live night fraction, added *inside* the
clamped lit sum — a `glMaterialfv(GL_EMISSION)` term. Full weight on EXT, weighted by MOCV.a on
TRANS, **zero on INT** (lighting is off there, so the emissive write is dead), and zero under UNLIT.

**WINDOW** (MOMT `0x20`), interior drawer only: ambient *and* diffuse both become the midpoint
`(direct + ambient)/2`, with ambient `+16/255` saturating. Exterior-group batches have no WINDOW
machinery and keep the plain law.

Interior is `(groupFlags & 0x48) == 0`, consistent with the existing
`WMOLightIntegration` check.

**Removed:** the `light > 0.5 → 0.5 + (light−0.5)·0.65` curve and the two `light·0.5` halvings. Not
reference laws.

**WMO surfaces receive zero point lights** — observed on every WMO surface batch in benilla's abbey
capture. An earlier "point-lit abbey wall" reading there was a misidentified unit draw.

### Point lights

For every receiver that does get them — exterior doodads, entities — the reference commits **at most
three**, the nearest to the *receiving object's own position*, never the camera and never the vertex.
A light's packed range bounds candidacy; a selected light then reaches every vertex with **no
distance cutoff**, so selection pops at object granularity, which is the authored behaviour.

```
atten = 1 / (0.7·d + 0.03·d²)
sum  += colour · atten · max(N·L, 0)
```

Diffuse only — committed ambient and specular are zero. Summed inside the clamp.

This replaces the current camera-relative selection of 4 with linear `attenStart→attenEnd` falloff.

### Fog

One implementation, shared by M2, WMO and terrain, so a tree and the dirt under it land on the same
haze byte at the same distance:

```
factor = clamp((end − eyeZ) / (end − start), 0, 1)
out    = mix(fogRGB, colour, factor)
```

**The coordinate is planar eye-Z** — view-space depth, not radial distance. Radial over-fogs screen
edges. `start = fraction × end`, left **unclamped**: a negative fraction floors the whole near field
in haze, which is the reference's constant near veil in storms.

Per-batch fog colour policy: scene colour for opaque and alpha; **black for additive** (an additive
batch must fade toward the additive identity, or a torch's glow picks up the fog tint and draws a
coloured halo); white for Mod; grey for Mod2x; unfogged for render flag `0x02`. The existing M2
shader already gets the additive case right and that reasoning is preserved.

**MFOG interior fog.** Interior lanes fog with a *second* triple rather than the scene fog, so a room
keeps its warm authored haze while a storm outside stays grey through the open door. Staging:
`end = min(record end, farclip)`, `start = end × startMultiplier` — MFOG start is a *fraction* of end
in 1.12.1. Crossfade in and out at `0.25`/second (4 seconds each way). The staged triple **latches on
exit** so the fade-out lerps from the room's fog instead of popping. Data is already parsed: `MFOG`
carries `fogEnd`, `fogStartMultiplier` and colour, and `MOGP.fogOffsets` gives the group assignment.

Selection into the interior lane has two routes: the material's interior-group flag (interior WMO
surfaces and that group's doodad props) and a per-instance flag for an entity standing inside a
fogged WMO. Terrain, liquid, sky and exterior groups keep scene fog.

## MapLight

- Add `sidnNightFraction` to the published uniforms. Curve: `1.0` overnight, `0.0` all day, linear
  ramps 20:30→21:30 and 06:00→07:00.
- **Remove the interior sun fade** — `#interiorFactor` and the `interior.sunDiffuseColor = 0`. These
  approximate what the reference gets from batch classes and probes; keeping both double-darkens.
- Fix the `Light.dbc` schema: the row carries `lightParamsID[8]`, not a single `skyFogID`. Load all
  eight param sets.
- Add slot selection and the storm lerp `bcc = min(1, density·4)`, which blends the storm param over
  the clear one across every band at once — ambient, diffuse, fog colour *and* distances.
- The DBC sphere blend, sun tables and band decode are unchanged.

### Inert inputs, stated plainly

Three of the four slot selectors have no signal in this client. Each gets **one** call site returning
a constant, so the machinery behind it goes live unchanged when the upstream system lands:

| Input | Reports | Blocked on |
|---|---|---|
| weather density | `0` (clear) | no weather system; needs `SMSG_WEATHER` |
| submersion | `dry` | no liquid height query exists anywhere in the client |
| ghost | `alive` | player flags not surfaced from the network layer |

Building those three is networking and collision work, not lighting work, and is not in this spec.
Until they land, the storm/underwater/death param slots are loaded and selectable but never selected.

## Load-time wiring

Everything needed is already parsed: MODD colour, MODR group refs, MOLR light refs, MOLT lights,
MFOG, `MOGP.fogOffsets`.

- **MODD ownership:** a doodad's instantiating group is the **first** MODR that names it. The
  reference creates a doodad once, on the first visible-group walk naming it, and that create freezes
  its lighting lane. This is the *lighting* key only — the cull key stays as it is.
- Classify by the owning group's flags. Not EXTERIOR-flagged ⇒ interior prop ⇒ fold its probe once at
  load. Exterior ⇒ the day/night lane.
- Exterior doodads and entities get the ≤3-nearest MOLT selection at their own origin, which finally
  gives `setWmoLights` a caller.

## Testing

`laws.ts` is pure, so it is tested directly against benilla's own golden vectors — the point of
porting from a reference with tests is to inherit them:

- Probe at `μ = +1` → `ambient + diffuse` exactly; `μ = 0` → `ambient + 0.0882·D`; `μ = −1` →
  `ambient + 0.0588·D`; no lobes → flat ambient; two lobes → additive.
- `cap96([90,86,141]) → [61,59,96]`; `cap96([78,76,134]) → [56,55,96]`; `cap96([96,40,20])`
  passes through.
- `floor112([56,28,14]) → [112,56,28]` (max channel lands exactly on 112, hue preserved);
  `floor112([90,86,141])` passes through; `floor112([0,0,0]) → [0,0,0]` with no divide.
- `sidnNightFraction`: 1.0 at midnight and 06:00; 0.5 at 06:30; 0 from 07:00 through 20:30; 0.5 at
  21:00; 1.0 at 21:30 and 23:00.
- MFOG ramp: 2 s in → half-blended; 4 s → fully the room's fog with `start = end × multiplier`;
  leaving with no target still blends the **latched** room fog at half weight; a further 2 s returns
  scene fog verbatim and releases the latch. Record end beyond farclip commits farclip, and start
  scales off the *clamped* end.
- `selectPointLights`: picks 3 of many by distance from the anchor; excludes a candidate outside its
  own range; a selected light is **not** cut off by distance.

Shader laws are not directly unit-testable here. They are verified by visual A/B against the
reference, listed below.

## Verification

- **Frame:** our world frame's relation to the WoW frame is only implicitly documented — `MapLight`
  permutes axes for light positions but feeds `sunDir` through unpermuted. The sun demonstrably
  works, so the fixed interior axis should follow the same convention, but confirm empirically that
  it lands as light-from-above-and-45° in a real interior rather than trusting the inference.
- **Performance:** measure the per-draw uniform refresh in a doodad-dense scene before and after.
  Fallback is per-instance material clones for interior props only.
- **Looks:** a WMO exterior across a full day/night cycle; an inn interior (INT bake, fireplace
  emissive mask, warm MFOG haze); windows at 20:30 → 21:30 → midnight for the SIDN ramp; a window
  pane from inside by daylight for the WINDOW midpoint; a torch interior for point-light falloff and
  the absence of point light on the walls; a tree at the fog boundary against the terrain under it.

## Implementation order

This is more than one plan's worth of work, and it decomposes cleanly — with one hard coupling.

1. **WMO plumbing.** Stop discarding `colors[0]`; move lighting to the fragment stage; the matte with
   MOCV inside the clamp. Largest single visual change, and independently verifiable.
2. **`laws.ts` + tests.** Pure, no renderer dependency, so it can land before anything consumes it.
3. **WMO batch classes, SIDN, WINDOW.** Depends on 1.
4. **The per-object block + M2 lobe + interior probes + point lights.** Depends on 2. **Steps 3 and 4
   must land together** — see risk 3: removing the interior sun fade before both the batch classes
   and the probes exist leaves interiors darker than either the old or the new behaviour.
5. **Fog: shared implementation across M2, WMO, terrain, then MFOG.** Independent of the lighting
   laws; the shared-implementation part should precede MFOG so there is one place to add the second
   triple.
6. **`Light.dbc` 8-slot schema + slot selection + storm lerp.** Independent of everything above.
   Lands with its selectors inert.

## Risks

1. **Per-draw uniform refresh cost.** Measured, with a stated fallback. Highest-uncertainty item.
2. **Frame convention for the fixed interior axis.** Verified empirically, not assumed.
3. **Removing the interior sun fade** could make interiors read darker than people are used to before
   probes and batch classes are both landed. These need to land together, not separately.
4. **The `min(I, 1)` cap** leaves doodads dimmer than the reference by design. Recorded above so it
   reads as a decision, and paired with the ramp-target constraint so a future change moves both.
