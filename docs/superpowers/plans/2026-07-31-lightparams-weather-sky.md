# LightParams, Weather and Sky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the `LightParams` slots the client already parses but ignores, drive the storm slot from a
UI-controlled weather state machine, and put the sky dome on its authored DBC bands. Then close the two
gaps earlier plans deliberately left.

**Architecture:** No new subsystems. Most of the maths already exists and is tested in
`client/src/game/world/light/laws.ts` (`stormBlend`, `skyWarp`, `dawnDuskCurve`, `quantizeGlow`, from
plan 1). This plan is largely wiring: load more of what the DBCs already give us, and route it.

**Tech Stack:** TypeScript, three.js, GLSL ES 1.0, React 19 class components, jest.

**This is plan 5 of 5.** Plans 1–4 are complete and on the branch.

## Global Constraints

- **Reference source of truth:** `samples/benilla` — `lighting/resolve.rs` for the slot selection and
  storm blend, `weather/mod.rs` for the intensity ramp, `daynight.rs` + `sky.wgsl` for the sky.
- **Design spec:** `docs/superpowers/specs/2026-07-30-wmo-m2-lighting-design.md`, sections "MapLight",
  "Weather" and "Sky".
- **Reuse `laws.ts`.** `stormBlend`, `skyWarp`, `dawnDuskCurve`, `quantizeGlow` and `interpDayNight` are
  already there and tested. Do not re-derive them. That module imports nothing — keep it that way.
- **Colour space:** gamma-space 0..1. Add no sRGB conversion.
- **GLSL dialect:** GLSL ES 1.0. Do NOT reintroduce `#pragma glslify: import(...)` in the M2 or WMO
  shaders — invisible to webpack's watcher, and it silently swallowed an entire plan's shader work.
- **A dev-server restart is needed once** after any shader edit if the running instance predates it.
- **Test command:** `cd client && yarn test --watchAll=false --testPathPattern="<pattern>"`
- **Commit per task.** Stage only the task's own paths — ~420 unrelated dirty files exist.

---

## What is actually wrong — corrected from the spec's framing

The spec says the `Light.dbc` schema needs an 8-slot fix and that `LightParams` fields need decoding.
**Both are already there.** Verified before writing this plan:

- `client/src/wow-data-parser/dbc/entities/light.js` declares all eight slots — `skyFogID`, `waterID`,
  `sunsetID`, `otherID`, `deathID`, plus three reserved words. No schema change is needed.
- `client/src/wow-data-parser/dbc/entities/light-params.js` already declares `highlightSky`,
  `lightSkyboxID`, `glow`, and all four water alphas.

So the real defects are narrower, and two of them are wiring rather than parsing:

**1. `MapLight` loads only slot 0.** `#getAreaLightsFromDb` reads `lightRecord.skyFogID` and builds a
one-element `params` array (`MapLight.ts:551-556`). The other four meaningful slots are never read, so
there is nothing to blend a storm against.

**2. `lightParams` is fetched and then dropped.** `MapLight.ts:514` looks up
`lightParamsDb[lightRecord.skyFogID]` and never uses the result. `highlightSky` and `glow` — which the
sky warp and the bloom weight need — are sitting right there, already parsed, going nowhere.

**3. The slot field NAMES are misleading, and one is outright wrong.** The real `Light.dbc` slot order is
`[0] standard, [1] standard underwater, [2] stormy, [3] stormy underwater, [4] death`. The schema names
them `skyFogID, waterID, sunsetID, otherID, deathID` — so `sunsetID` is positionally the **stormy** slot
and `otherID` the **stormy underwater** slot. Anyone reaching for "the storm params" will not find them
under a plausible name, and anyone using `sunsetID` for a sunset effect gets storm data. Rename them.

**4. There is no weather state.** Nothing drives the storm blend. `SMSG_WEATHER` (`0x2F4`) is declared in
`client/src/network/game/opcode.js` but has no handler; per the design decision this plan drives weather
from the debug UI instead, leaving the wire as a one-call seam.

**5. The sky dome does not use its authored bands.** `sky/procedural/index.ts` has hardcoded fallback
colours and reads only a couple of bands. The five gradient stops (`LightIntBand` rows 2–6) are
enumerated in `constants.ts` already.

---

## File Structure

**Created:**
- `client/src/game/world/light/weather.ts` — the two ramped intensity channels and `setWeather`. Imports
  nothing; node-testable.
- `client/src/game/world/light/__tests__/weather.test.ts`

**Modified:**
- `client/src/wow-data-parser/dbc/entities/light.js` — rename the slots to what they are.
- `client/src/game/world/light/{MapLight,blend,types,constants}.ts` — load all slots, carry
  `highlightSky`/`glow`, apply the storm lerp.
- `client/src/pages/game/debug/{lighting-controls,lighting-readouts}.tsx` — weather drivers and readouts.
- `client/src/game/pipeline/sky/**` — the five gradient stops, backdrop convergence, the warp.
- `client/src/game/pipeline/m2/material/**` + `wmo/index.js` — the M2 interior fog gap (Task 5).
- `client/src/game/pipeline/m2/material/index.ts` — the `assignShaders` override (Task 6).

---

### Task 1: Load every LightParams slot, and carry what they hold

**Files:**
- Modify: `client/src/wow-data-parser/dbc/entities/light.js`
- Modify: `client/src/game/world/light/MapLight.ts`
- Modify: `client/src/game/world/light/types.ts`

**Interfaces:**
- Produces: `AreaLightParams` gains `highlightSky: boolean` and `glow: number`; `AreaLight.params`
  becomes an array indexed by `LIGHT_PARAM`, with holes for slots a record does not define.

- [ ] **Step 1: Rename the slots to what they are**

In `light.js`, replace the misleading names. Keep the field order and types identical — this is a rename,
not a layout change:

```js
export default Entity({
  id: r.uint32le,
  mapID: r.uint32le,
  position: Vec3Float,
  fallOffStart: r.floatle,
  fallOffEnd: r.floatle,
  // The eight LightParams slots, in the order Light.dbc stores them. The previous names for slots 2 and
  // 3 -- `sunsetID` and `otherID` -- were positionally WRONG: slot 2 is the STORMY params and slot 3 is
  // stormy underwater. Anyone reaching for "the storm params" could not find them, and anyone using
  // `sunsetID` for a sunset effect would have been handed storm data.
  paramsStandard: r.uint32le,
  paramsUnderwater: r.uint32le,
  paramsStormy: r.uint32le,
  paramsStormyUnderwater: r.uint32le,
  paramsDeath: r.uint32le,
  unknowns: new r.Reserved(r.uint32le, 3)
});
```

**Grep for every use of the old names before committing** — `skyFogID` in particular is referenced in
`MapLight` more than once, including in the band-id arithmetic. A missed rename is a silent `undefined`
that turns into `NaN` band indices.

- [ ] **Step 2: Load all five meaningful slots**

`#getAreaLightsFromDb` currently builds `params: [{ id: skyFogID, intBands, floatBands }]`. Build a
sparse array indexed by `LIGHT_PARAM` instead, one entry per slot whose id is non-zero. A slot id of 0
means the record does not define that param — leave the hole rather than substituting slot 0's data.

The band-id arithmetic (`(paramsId * 18) - 17 + i` for int bands, `(paramsId * 6) - 5 + i` for float
bands) is per-params-id, so it must be computed from **each slot's own id**, not from slot 0's. That is
the single easiest thing to get wrong here: reusing slot 0's id would load the same bands five times and
make every slot identical, which looks like "the storm has no effect" rather than like a bug.

Also carry the `LightParams` row's own fields, which are currently fetched and dropped:

```ts
        // highlightSky gates the dawn/dusk sky warp; glow is the per-zone bloom weight. Both were
        // already parsed and already looked up here -- the result was simply discarded.
        highlightSky: !!lightParams?.highlightSky,
        glow: lightParams?.glow ?? 0.5,
```

- [ ] **Step 3: Verify and commit**

`cd client && yarn test --watchAll=false` and `npx tsc --noEmit` clean. Nothing consumes the new slots
yet, so the app should look unchanged — expected, not a failure.

```bash
git commit -m "feat(lighting): load every LightParams slot and carry highlightSky/glow"
```

---

### Task 2: The weather intensity state machine

**Files:**
- Create: `client/src/game/world/light/weather.ts`
- Test: `client/src/game/world/light/__tests__/weather.test.ts`

**Interfaces:**
- Produces:
  - `enum WeatherKind { Fine, Rain, Snow, Sand }`
  - `class WeatherState` with `setWeather(kind, grade, instant)`, `tick(dt)`, and getters
    `kind`, `effectIntensity`, `skyDensity`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/world/light/__tests__/weather.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { WeatherKind, WeatherState } from '../weather';

/** Advance in small steps, as a frame loop would, so the ramp is exercised rather than jumped. */
const run = (state: WeatherState, seconds: number, step = 1 / 60) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    state.tick(step);
  }
};

describe('WeatherState', () => {
  it('starts fine and fully clear', () => {
    const state = new WeatherState();
    expect(state.kind).toBe(WeatherKind.Fine);
    expect(state.effectIntensity).toBeCloseTo(0, 5);
    expect(state.skyDensity).toBeCloseTo(0, 5);
  });

  it('ramps the effect channel to full over about ten seconds', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 5);
    // Half way through the swing, not yet arrived.
    expect(state.effectIntensity).toBeGreaterThan(0.3);
    expect(state.effectIntensity).toBeLessThan(0.7);
    run(state, 6);
    expect(state.effectIntensity).toBeCloseTo(1, 2);
  });

  it('ramps the SKY channel over the same ~10s, not four times slower', () => {
    // The sky channel's span scale is 4, which looks like it should take 4x as long -- but its
    // endpoints live in the [0, 0.25] knee domain, so the x4 cancels the quarter-span. Both channels
    // swing in about ten seconds. Getting this wrong makes the overcast lag the rain badly.
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 11);
    expect(state.skyDensity).toBeCloseTo(0.25, 2);
  });

  it('clamps the sky channel into the [0, 0.25] knee domain for any grade', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, true);
    expect(state.skyDensity).toBeLessThanOrEqual(0.25);
    expect(state.skyDensity).toBeGreaterThanOrEqual(0);
  });

  it('applies an instant change without ramping', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Snow, 1, true);
    expect(state.effectIntensity).toBeCloseTo(1, 5);
    expect(state.skyDensity).toBeCloseTo(0.25, 5);
    expect(state.kind).toBe(WeatherKind.Snow);
  });

  it('re-aims from the CURRENT value when the target changes mid-ramp', () => {
    // Not from the original start -- otherwise a change of mind mid-swing snaps backwards.
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, false);
    run(state, 5);
    const midway = state.effectIntensity;
    state.setWeather(WeatherKind.Fine, 0, false);
    state.tick(1 / 60);
    expect(state.effectIntensity).toBeLessThan(midway);
    expect(state.effectIntensity).toBeGreaterThan(0);
  });

  it('ramps back down to clear', () => {
    const state = new WeatherState();
    state.setWeather(WeatherKind.Rain, 1, true);
    state.setWeather(WeatherKind.Fine, 0, false);
    run(state, 11);
    expect(state.effectIntensity).toBeCloseTo(0, 2);
    expect(state.skyDensity).toBeCloseTo(0, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/weather"`
Expected: FAIL — cannot resolve `../weather`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/world/light/weather.ts`. The law, from the reference's
`weather_intensity_ramp` (benilla `weather/mod.rs`):

```
value = clamped_lerp(from -> to, elapsed / ((|to - from| * spanScale + 0.001) * 10))
```

Two channels share that primitive:
- **effect intensity**, `spanScale = 1`. A full 0→1 swing takes about ten seconds.
- **sky density**, `spanScale = 4`, but its endpoints are `clamp(grade, 0, 0.25)`. The ×4 cancels the
  quarter-span, so it **also** swings in about ten seconds.

Write that cancellation into a comment. The reference's own notes record getting it wrong — reading the
×4 as "four times slower" — and correcting it later. It is the single most misleading thing in this file.

The module imports nothing. Channels run on real elapsed seconds, so a transition keeps ramping through a
loading screen, as the reference's does.

Expose `effectIntensity` (which precipitation would consume — nothing does yet, and that is fine; it is
the same primitive and costs nothing) and `skyDensity`, which lighting turns into the storm blend via
`laws.stormBlend`.

- [ ] **Step 4: Run test, then commit**

Expected: PASS, 7 tests.

```bash
git commit -m "feat(weather): the two ramped intensity channels"
```

---

### Task 3: Blend the storm params, and drive it from the UI

**Files:**
- Modify: `client/src/game/world/light/{MapLight,blend}.ts`
- Modify: `client/src/pages/game/debug/{lighting-controls,lighting-readouts}.tsx`

**Interfaces:**
- Consumes: `WeatherState` from Task 2, `stormBlend` from `laws.ts`, the slots from Task 1.
- Produces: `MapLight.weather` (the state), `MapLight.stormBlend` (the resolved weight).

- [ ] **Step 1: Lerp the storm params over the clear ones**

`blendLights` currently takes a single `param` index. Resolve the clear result as now, then — when the
storm weight is above zero — resolve the **stormy** slot the same way and lerp between them by
`stormBlend(weather.skyDensity)`.

**Every band lerps, not just the colours:** ambient, diffuse, the sky stops, the fog colour **and the fog
distances**. That one blend is the whole of the reference's overcast darkening and fog draw-in. Lerping
only the colours produces a storm that goes grey without closing in, which reads as a tint rather than
weather.

A zone with no stormy slot (a hole in the sparse array from Task 1) makes the lerp an identity — resolve
that by falling back to the clear slot, so the weight has no effect there rather than blending toward
nothing.

- [ ] **Step 2: Drive it from the debug panel**

Add to `lighting-controls.tsx`: a weather kind selector, a grade slider (0..1), an instant toggle, and a
live readout of **both** channels so the ten-second swing can be watched rather than inferred.

**The `shouldComponentUpdate` trap:** this component caches a `displayState` string and compares it,
because the parent force-updates every frame and `mapLight` is mutated in place. Any value you display
must also be in `displayState`, or it will appear frozen while the underlying number moves. There is
already a test for that pattern — follow it for the new values.

Tick the weather state from the same per-frame path that drives the fog ramp — `MapLight.update(camera, dt)`
now receives a real delta. Do not add a second timing source.

- [ ] **Step 3: Report it**

Add the storm weight and both channels to `lighting-readouts.tsx`, keeping `LightingReadoutsTarget` a
narrow structural type.

- [ ] **Step 4: Verify and commit**

Tests and `tsc` clean. Then in the client: set rain at grade 1 and watch, over about ten seconds, the
ambient and diffuse bytes darken and the fog range pull in. Step inside a building — the interior fog
from plan 4 should hold its own values while the outside greys.

```bash
git commit -m "feat(weather): blend the storm LightParams and drive weather from the debug panel"
```

---

### Task 4: The sky dome's authored bands

**Files:** `client/src/game/pipeline/sky/**`, `client/src/game/world/light/MapLight.ts`

**Interfaces:** consumes `skyWarp` and `quantizeGlow` from `laws.ts`, plus `highlightSky`/`glow` from Task 1.

- [ ] **Step 1: Publish the five gradient stops**

`LIGHT_INT_BAND` already enumerates `BAND_SKY_TOP_COLOR` through `BAND_SKY_SMOG_COLOR` — rows 2–6, the
five stops zenith→horizon. Blend them in `blendLights` alongside the existing bands and publish them.

- [ ] **Step 2: Feed the dome**

`sky/procedural/index.ts` has hardcoded fallback colours and reads only a couple of bands. Point it at the
published stops, interpolated across the dome by elevation. Keep a fallback for the DBC-missing case, but
make it obviously a fallback rather than a plausible-looking default.

- [ ] **Step 3: Converge the backdrop on the fog colour**

Set the renderer's clear colour to the row-7 fog colour, written **raw** with no conversion — the client
is on a gamma-passthrough lane (`outputColorSpace = LinearSRGBColorSpace`). This is what stops a seam
appearing where the fully-fogged far plane meets the void behind it.

- [ ] **Step 4: The dawn/dusk warp**

`laws.skyWarp(minute, highlightSky)` is already written and tested. Publish `S` and apply the azimuthal
warp in the dome shader: the sun-facing quarter warms toward the first sky colour, the away side
desaturates toward the second.

`S` is **0 across all of midday and deep night**, and **0 at every hour in a `highlightSky = 0` zone** —
so at `S = 0` the warp must be exactly identity, or you will have changed the daytime sky everywhere
while trying to change it at dusk only. Verify that first, before checking dusk looks right.

**Carry the reference's own caveat rather than presenting this as settled:** benilla records an open
question here — their warp may over-apply to the dome apex and rim versus the binary's four middle rings,
and the dusk result is unconfirmed. Note it in your report.

- [ ] **Step 5: The per-zone glow weight**

Publish `quantizeGlow(glow)` — `floor(g * 255) / 255`, matching how the reference packs it. Nothing
consumes it yet (there is no bloom pass); publishing it is the task. Say so in your report rather than
wiring a bloom pass.

- [ ] **Step 6: Verify and commit**

Tests and `tsc` clean. In the client, scrub a full day and watch the dome track its bands. Check dawn
(~06:30) and dusk (~21:30) in a `highlightSky = 1` zone such as Elwynn against a `highlightSky = 0` zone
such as Duskwood, where the warp must do nothing at all. Check the horizon for a seam.

```bash
git commit -m "feat(sky): the authored DBC gradient stops, backdrop convergence and dawn/dusk warp"
```

---

### Task 5: Fog M2 doodads standing in an interior

The gap plan 4 recorded rather than hid.

**Files:** `client/src/game/pipeline/m2/material/**`, `client/src/game/pipeline/wmo/index.js`

**Interfaces:** extends `PerObjectLighting` with an `interiorFog: boolean`.

- [ ] **Step 1: Flag it per instance**

`PerObjectLighting` already carries per-instance lighting state pushed per draw. Add `interiorFog`, set
when the doodad's owning group is `lightingInterior`, and push it as a uniform alongside the rest.

Note this is a **separate question** from the `interior` flag that selects the lighting probe: the
reference stages a unit's fog by its own light-node classification, and an M2 can want interior fog while
not being an interior *prop*. Keep the two flags distinct rather than reusing one.

- [ ] **Step 2: Select the triple in the M2 shader**

The M2 fragment shader's `applyFog` uses the scene triple. Select the interior pair when the flag is set,
exactly as the WMO shader does. The two new uniforms (`wmoFogColor`, `wmoFogParams`) are already
published by `MapLight`; the M2 material needs to pull them on its per-frame path the same way the WMO
material does.

- [ ] **Step 3: Verify and commit**

Tests and `tsc` clean. Then: stand in an inn with a storm running outside. The props should hold the
room's haze, not the storm's.

```bash
git commit -m "feat(fog): fog interior M2 doodads with the interior triple"
```

---

### Task 6: Stop discarding the authored M2 shader names

**Files:** `client/src/game/pipeline/m2/material/index.ts`

**This task changes how a great many models look, in one step. It is last for that reason.**

`assignShaders` selects the right vertex/fragment pair from the model's authored shader names, and then
ends by overwriting its own work:

```ts
    this.vertexShader = M2Material.VERTEX_SHADERS.Diffuse_T1;
    this.fragmentShader = M2Material.FRAGMENT_SHADERS.Combiners_Opaque;
```

unconditionally. So all 15 fragment combiners and 6 vertex variants are dead, and every M2 in the game
renders through the single-texture opaque combiner regardless of what it authored.

- [ ] **Step 1: Remove the override**

Delete those two lines. The selection above them already handles the missing-names case by falling back
to `Discard`, and warns when a named fragment shader has no entry.

- [ ] **Step 2: Find out what breaks, and report it rather than papering over it**

This is the risky step. Removing the override means models start using combiners that have **never
executed** — the shader build path was only fixed recently, and before that these variants were unreachable.

Expect compile errors or visibly wrong output from at least one variant. For each problem: **report it
with the variant name and the symptom.** Do NOT restore the override to hide a broken variant, and do NOT
"fix" a combiner's maths speculatively — a combiner that renders wrong is a separate, diagnosable bug, and
lumping its fix in here makes both changes unreviewable.

If more than a couple of variants are broken, stop and report. A per-variant fix pass is its own task.

- [ ] **Step 3: Verify and commit**

Tests and `tsc` clean. In the client, look at models with multiple textures — anything with an
environment map or a second layer — which are exactly the ones that were being flattened to a single
opaque texture.

```bash
git commit -m "fix(m2): stop discarding the authored shader names"
```

---

## Done when

- `yarn test --watchAll=false` passes; `npx tsc --noEmit` clean.
- Weather at grade 1 darkens the light and pulls the fog in over about ten seconds, both channels.
- The sky dome tracks its authored bands across a day, and the warp does nothing in a `highlightSky = 0` zone.
- Interior M2 props keep the room's fog while a storm runs outside.
- Multi-texture models render with more than one texture.

## Risks

1. **Task 1's band-id arithmetic must use each slot's own id.** Reusing slot 0's id loads identical bands
   for every slot, which presents as "the storm does nothing" rather than as a bug.
2. **Task 4's warp must be identity at `S = 0`.** Otherwise the daytime sky changes everywhere while
   trying to change dusk only — and the daytime sky is currently correct.
3. **Task 6 is the visually broadest change in all five plans.** It is last, and its instruction is to
   report breakage rather than absorb it.

## Handoff

After this plan the spec's scope is complete except its stated exclusions: specular (which the reference
also defers, its shininess values being inferred), and the underwater and death `LightParams` slots —
loaded by Task 1 but never selected, because this client has no submersion or ghost state to select them
with. Those two remain honest gaps rather than oversights.
