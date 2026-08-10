# Procedural clouds — the coverage field and the visible layer

Stage 2 of cloud support. Stage 1 (`842e15a`) named and published the authored inputs: cloud density
`C` (`LIGHT_FLOAT_BAND.BAND_CLOUD_DENSITY`), the three palette colours
(`BAND_CLOUD_SUN_COLOR`/`BAND_CLOUD_SLOPE_COLOR`/`BAND_CLOUD_BASE_COLOR`), and the storm blend `bcc`,
all resolved through the per-light storm lerp. Nothing consumes them. This plan builds the consumer.

Reference: `samples/benilla/crates/benilla/src/clouds/{kernel,layer,tables,mod}.rs` (1163 lines) plus
`lighting/daynight.rs`'s glow envelope and moon direction. Read the module headers first — they carry
the disassembly addresses, the verification status of each law, and four deliberate deviations from the
bytes.

## The architecture, and why it is not negotiable

**One coverage field serves every consumer.** The kernel maintains a scrolling 128² byte tile; a glare
gate samples it for sun/moon occlusion, and the visible dome renders the same bytes as a texture. A cloud
crossing the sun dims the glare *and* is the cloud you see — they cannot desynchronize. Splitting them
into "a cloud texture" and "an occlusion term" is the one design mistake that cannot be corrected later
without redoing both.

`C` rides the weather blend already, so a storm with an authored overcast band raises coverage with no
extra wiring.

## Scope

In: the noise kernel, the tone curve and tables, the colour pass, the coverage sampler, the day/night
glow envelope and moon direction, the visible dome, and instruments.

Out, and stated as gaps rather than oversights:
- **The glare/flare pass.** This client has no bloom, glare, or lens-flare pass and no sun/moon discs, so
  `occ1Sun`/`occ1Moon` have no consumer. Port and test them anyway — they are four lines and they are the
  other half of the shared-field design — but do not build a glare pass to justify them.
- **`SkyCloudLOD` 1.** The CVar clamps to [0,1] and defaults to 0. Implement LOD 0 only, as the reference
  does.
- **The WMO-skybox suppression.** The reference hides all six sky elements together when a painted WMO
  skybox is active. This client's skybox path is separate; note the interaction, do not rework it here.

## Tasks

---

### Task 1: The frozen tables

**Files:**
- Create: `client/src/game/world/sky/clouds/tables.ts`
- Test: `client/src/game/world/sky/clouds/__tests__/tables.test.ts`

Pure data and two builders, imports nothing. Copy from `samples/benilla/.../clouds/tables.rs` verbatim:

- `PERM` — the static 256-byte permutation from `.rdata` (`0x86f2d0`), always indexed `& 0xff`. There is
  no doubled-512 layout; do not "helpfully" duplicate it.
- `CURVE` — the 256-byte tone curve (`0xce91d8`, gamma 0.96). **Frozen bytes, not recomputed through
  `Math.pow`.** The reference froze it deliberately for cross-platform determinism; recomputing it
  reintroduces exactly the drift it avoided.
- `gradientTable()` — `1 − 2·rand()/32767` over MSVC's LCG (`seed = seed·214013 + 2531011`,
  `(seed >> 16) & 0x7fff`), seed fixed at 1. The real seed is process-random and not visually
  load-bearing; any uniform table in [−1, 1] is equivalent.
- `fadeTable()` — the raised-cosine ease `0.5·(1 − cos(iπ/256))`.

**JS hazard:** the LCG must run in unsigned 32-bit. `seed * 214013` overflows the f64 integer-exact range,
so use `Math.imul(seed, 214013) + 2531011 >>> 0`.

- [ ] Test: `PERM` is a permutation of 0..255 (every value exactly once) — that catches a transcription
  slip that a spot-check of a few entries would not. `CURVE` is monotonic non-decreasing, starts 0, ends
  254. The gradient table is 256 values within [−1, 1]. The fade table is 0 at 0, 1 at 256/2... check
  `fade[128] === 1` is NOT true — verify against the formula, not an assumption.

---

### Task 2: The noise kernel and colour pass

**Files:**
- Create: `client/src/game/world/sky/clouds/kernel.ts`
- Test: `client/src/game/world/sky/clouds/__tests__/kernel.test.ts`

**Interfaces:**
- `COLS = 128`, `SHIFT = 7`, `ROWS_PER_TICK = 32`, `OCTAVES = 4`, `REGEN_PERIOD = 0.1`
- `type CloudFrame = { sun: [number,number,number]; slope: …; gbase: …; bcc: number; glowDir: {x,y,z}; glowTrack: number }`
- `class CloudKernel` with `tick(dt, density, frame): boolean`, `rebuild(density, frame)`,
  `recolor(frame)`, `coverage(d: {x,y,z}): number`, `rgba(): Uint8Array`, and test accessors for the
  tile and the phase.
- `occ1Sun(r) = 1 − r`, `occ1Moon(r) = 1 − |2(r − 0.5)|`

No three.js import — directions are structural `{x, y, z}`, like the rest of this project's pure modules.

- [ ] **Step 1: the float discipline, before any algorithm**

This is the whole risk of the task. The reference computes in `f64` with **specific** `f32` round-trips,
and those round-trips are load-bearing (its own comments flag `v8` and the accumulator store as
±1-ulp-significant in the byte diff). JS numbers are f64, so every `as f32` in the Rust must become an
explicit `Math.fround(...)` at exactly the same point — no more, no fewer.

Write the port with the Rust open beside it and mark each `fround` with the Rust line it corresponds to.
A missing `fround` is invisible: the field still looks like clouds, just not *these* clouds.

Bit tricks need a shared 4-byte view, not arithmetic:

```ts
const scratch = new DataView(new ArrayBuffer(4));
const f32Bits = (v: number) => { scratch.setFloat32(0, v); return scratch.getUint32(0); };
const bitsF32 = (b: number) => { scratch.setUint32(0, b); return scratch.getFloat32(0); };
```

Three places need them: the quantize pack (`bits(accum·64 + 128 + 512) >> 14`), `packChannel`
(`bits(ch·255 + 512) >> 14`), and `fisr` — the integer fast-inverse-sqrt leaf
(`0x5f3997bb − ((bits(x) >> 1) & 0x3fffffff)`), **a one-shot seed with NO Newton step**. Do not "fix" it
with `1/Math.sqrt(x)`: its approximation error is part of the reference's glow shape.

u16 keys wrap — mask `& 0xffff` on every advance. `as i32` truncations are `Math.trunc`, and `| 0` is
only safe where the value provably fits in 32 bits.

- [ ] **Step 2: the noise walk**

Port `regen` from `kernel.rs:188`. The structure that matters:

- Threshold refresh per fire: `T = trunc((1 − C)·255)`, clamped C.
- The phase's **high** byte picks the permutation slice pair (`slice_a`, `slice_b`), its **low** byte the
  fade weight between them. That is the time axis.
- Four octaves at `BASE_FREQ = [16, 32, 64, 128]`, amplitude `1/2^oct`.
- `row_key` initialises to `scroll · freq` — **absolute-row keyed**, which is exactly what makes band
  regeneration idempotent. Seed it from anything relative and the field shears between bands.
- `col_key` re-seeds to `phase` every row; corner gradients cache on the column cell and rebuild lazily.
- The octave-2 leg writes the derivative pair (column and row slopes of the three-octave partial sum)
  that the colour pass reads as the shape normal. `scale = 1 << (SHIFT − 7)` = 1 at LOD 0.
- Quantize the band, then run the colour pass over the **same** band, then advance scroll; a wrap bumps
  the phase.

- [ ] **Step 3: the colour pass**

Port `color_band` from `kernel.rs:324`.

- `t === 0` copies the **previous cell's** RGB with alpha 0 — a filtering-friendly hole fill. It is
  order-dependent: iterate columns ascending, and skip the copy at `col === 0`.
- Gradient: `slope·p + gbase` with `p = (((255 − t) >> 1) + 64)/255`, using the binary's own `1/255`
  constant (`0x3b808081`), not `1/255` computed in f64.
- Glow: `sun·(cosθ·intensity)` where `cosθ` aligns the cell→body vector (tile-cell units,
  `z = bcc·192 + 64`) against the shape normal `(dx, dy, 1)` through `fisr`. Accumulation and product
  order are per the bytes — keep them.
- `intensity = glowTrack·(1 − 0.75·bcc)`; channels clamp at 1 **with no lower clamp**; alpha = `t`.

- [ ] **Step 4: the projections**

`projectCells` (`FUN_006cf870`) and `bodyCells` (`0x6cfb00` setup + `sky_dome_ray_point 0x6cf9c0` +
the cmath quadratic `0x454f40`). Carry the reference's four recorded deviations and say in the report
that you did: the `acos` argument clamped to ±1 (the reference NaNs above ~70° elevation, a domain its
bodies never reach), toroidal LUT wrapping instead of running off the flat heap at the measure-zero
`u == 1.0` edge, the fixed gradient seed, and alpha-0 rather than `0xFFFFFFFF` colour-buffer init.

Note the frame convention: the reference is Bevy (+Y up) and converts from WoW's Z-up. Establish which
frame this client's `sunDir` is in **before** porting `bodyCells`, and write the answer in a comment. The
project has already had one axis-convention constant it could only mark as inferred.

- [ ] **Step 5: the tests that would actually catch a wrong port**

Mirror the reference's own suite (`kernel.rs:517`), because its assertions encode measured numbers:

1. **Clear sky** (`C = 0` ⇒ `T = 255`): every cell quantizes below threshold, so `R = 0` everywhere, every
   texel is alpha 0, `occ1Sun(0) = 1`, `occ1Moon(0) = 0`.
2. **Overcast** (`C = 1` ⇒ `T = 0`): no cell is clear, and the tile **mean is ≈242 with min 135**. Those
   are the reference's measured values — assert mean > 200 and min > 100 at minimum, and report the
   actual mean and min you get. **If your mean is not close to 242, the float chain is wrong**, and this
   is the cheapest signal you will get that it is. Chase it before continuing.
3. **Determinism**: two kernels rebuilt with the same inputs agree byte-for-byte on tile and rgba.
4. **Scattered** (`C = 0.6`, the reference's own init threshold): both clear cells and covered cells
   exist.
5. **Incremental bands tile the full field**: rebuild at `C = 0.6`, then four 32-row ticks at a fixed
   phase, and compare against a full rebuild at that phase. This is the structural test — a wrong scroll
   seed or quantize window shears the field between bands and nothing else catches it. Expect **row 0's
   colour to differ legitimately** (its row-derivative reads the persistent prev-row scratch, which
   differs between a fresh full pass and a scrolled one — the reference documents this as its own
   post-rebuild wart, gone by the next wrap). Compare from row 1.

---

### Task 3: The glow envelope and the moon

**Files:** `client/src/game/world/light/laws.ts` (+ its test file)

`interpDayNight` already exists there. Add, from `lighting/daynight.rs`:

- `cloudGlowTrack(minute)` — the 8-key envelope. **Store the keys in the reference's order, which is
  non-monotonic on purpose**: keys 6/7 sit before key 5 in time, the array-order scan makes them
  structurally unreachable, and `t > 0.9236` wraps back to 1.0. That seam is byte-verified; the *intent*
  is flagged INFERRED in the reference. Do not sort the table. Sorting it looks like a cleanup and
  silently deletes the verified night behaviour.
- `cloudGlowIsSun(minute)` — the sun drives the glow in `[0.2013889, 0.9236111]` (≈04:50–22:10), the moon
  otherwise.
- `moonDirection(minute)` — the white moon: a 5-key polar-φ LUT (35° overhead at midnight ↔ 100° parked
  below the horizon 04:00→22:00) with a **constant 45° azimuth**, the sun's own bearing. Same
  `interpDayNight` kernel, same WoW→client frame conversion as the sun tables.

This matters more than it looks: because of the seam wrap, **deep night runs at full glow envelope with
the moon as the body**. Skipping the moon would not dim the night glow, it would point it at a sun that
is parked below the horizon.

- [ ] Tests, from the reference's own assertions: noon = 1.0; the 04:50 notch = 0; approaching 22:10 from
  below < 0.01; **one step past it snaps back to 1.0**; deep night stays 1.0; halfway 21:30→22:10 ≈ 0.5.
  Plus: the moon is below the horizon at noon and above it at midnight, and `cloudGlowIsSun` agrees with
  the window at both.

---

### Task 4: Publish the frame inputs

**Files:** `client/src/game/world/light/MapLight.ts`

Publish `cloudGlowDir` (sun direction inside the window, `moonDirection` outside) and `cloudGlowTrack`.
Density, the three palette colours and `stormBlend` are already published by stage 1 — consume those, do
not re-resolve them.

---

### Task 5: The visible dome

**Files:**
- Create: `client/src/game/pipeline/sky/clouds/index.ts`
- Test: `client/src/game/pipeline/sky/clouds/__tests__/*.test.ts`

Port `layer.rs`'s mesh (`0x6d0530`): 12 rings × 16 azimuth steps = 192 vertices, `RING_COLAT`
(pole → the 45° rim, bunched toward the rim), `RING_ALPHA` (opaque inner 9, `128/255` on ring 10,
transparent rim), positions recentred `−cos(π/4)` so the rim sits at eye level and then **pushed to
uniform radius**, polar UV `(sin·V + 0.5, cos·V + 0.5)` with `V = ring/24`, and the 11 band strips as a
triangle list (352 triangles). Normals are the unit sky direction.

The UV mapping must be the same square mapping the coverage sampler uses (`u` ← world x, `v` ← world z),
or the drawn cloud and the sampled occlusion stop co-locating — which defeats the shared field.

**Depth and ordering.** The reference relies on a squashed depth-range slice this client does not use.
This client's `ProceduralSky` (`sky/procedural/index.ts`) instead uses `renderOrder = -1000`,
`depthWrite: false`, `depthTest: false`, a unit sphere scaled to `far * 0.9`, pinned to the camera each
frame. Match that idiom: `renderOrder = -999` (immediately after the sky gradient, before all world
geometry, so terrain occludes the clouds naturally), same depth flags, scaled to `far * 0.87` — inside
the sky dome, as the reference has it. Read `ProceduralSky`'s comments first: it documents a radius that
sat beyond the far clip and an inverted winding, both of which made the sky invisible until Task 4 of the
previous plan. Do not reintroduce either.

**The texture.** RGBA8 `DataTexture`, 128², `colorSpace` set so it is **never sRGB-decoded** — the texels
are the kernel's gamma bytes and this client is on a gamma-passthrough lane
(`outputColorSpace = LinearSRGBColorSpace`). Premultiplied alpha on the material, unlit, no culling
(viewed from inside), `needsUpdate` on each regen.

**The white-fringe trap — do not skip this.** A partial-alpha dome writing the framebuffer alpha channel
reproduces the halo fixed in `d348889`: the canvas is composited over the page, three.js requests
`alpha: true` unconditionally with `premultipliedAlpha: true`, so any sub-1 framebuffer alpha adds
`(1 − a)` of white. That fix was applied **only** to M2's `applyBlendingMode`. Set
`blendSrcAlpha = ZeroFactor`, `blendDstAlpha = OneFactor` on the cloud material so it leaves the alpha
channel at the cleared 1.0, and leave the RGB factors to the premultiplied blend.

- [ ] Test the mesh against the reference's own assertions: 192 vertices, `11 × 16 × 6` indices, every
  vertex at unit radius, pole at `y = 1`, rim at `y = 0`.

---

### Task 6: Wire the tick, and instrument it

**Files:** `client/src/game/pipeline/sky/manager/index.ts`, the world update path, `lighting-readouts.tsx`

- Full rebuild on the first frame and on a zone change; then `tick(dt, …)` at the reference's ~10 Hz
  self-throttle (the kernel owns the countdown — do not add a second timer). Use the **same per-frame
  `dt`** that already drives the fog ramp and the weather channels. This project has shipped a duplicated
  per-frame update that halved a crossfade rate; a third clock here would be that bug again.
- Re-upload the texture only when `tick` reports a change.
- Readouts: resolved `C`, the phase, the scroll row, the tile mean, and `coverage()` sampled toward the
  glow body. The mean and the sampled coverage are what distinguish "the field is empty" from "the field
  is fine and the dome is not drawing", which is the question you will actually have.
- Publish `coverage(d)` off whatever owns the kernel, for the glare that does not exist yet.

---

## Done when

- `yarn test --watchAll=false` passes; `npx tsc --noEmit` clean.
- Overcast (`C = 1`) produces a tile mean near 242, min near 135 — the reference's measured numbers.
- Four incremental band ticks reproduce a full rebuild at the same phase, from row 1.
- Clouds are visible overhead, drift slowly, and terrain occludes them.
- Raising the storm grade thickens the cover over the ten-second weather ramp, with no cloud-specific
  wiring.
- No white fringe anywhere on the dome, at any coverage.

## Risks

1. **The float chain is the whole task.** A missing or extra `Math.fround` yields plausible clouds that
   are not the reference's. The overcast mean ≈242 / min 135 check is the cheapest detector; run it before
   building anything visual, and treat a mismatch as a blocking failure rather than a tolerance.
2. **Sorting the non-monotonic glow table** deletes verified night behaviour and looks like tidying.
3. **The dome's alpha channel** reproduces the white-fringe bug unless the alpha blend factors are
   Zero/One. The existing fix does not cover this material.
4. **Frame convention** (+Y up vs WoW Z-up) for the glow body direction. Establish it from the client's
   existing `sunDir` rather than inferring, and write the answer down.
5. **The shared field** must stay one field. If the dome's UV mapping and the sampler's projection drift
   apart, the glare (when it exists) will dim for clouds that are not the ones on screen.

## Handoff

After this, the visible half of the cloud pipeline matches the reference and the occlusion half is
implemented but unconsumed. The natural follow-ups, in order of how much they need: a glare/flare pass
(the actual consumer of `occ1Sun`/`occ1Moon`, and the reason the shared field exists), sun and moon discs,
and `moon02` — which the reference notes is drawn every frame but renders vertex-black because its colour
field has no writer in the binary.
