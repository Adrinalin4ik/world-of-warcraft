# Fog Unification and MFOG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every fogged pipeline on the reference's fog coordinate, and give WMO interiors their own
MFOG fog so a room keeps its authored haze while a storm outside stays grey through the open door.

**Architecture:** No new subsystems. One shared fog coordinate change across five shaders, then a
second fog triple in the light uniforms with a 4-second crossfade in `MapLight`.

**Tech Stack:** TypeScript, three.js, GLSL ES 1.0, jest.

**This is plan 4 of 5.** Plans 1–3 are complete and on the branch.

## Global Constraints

- **Reference source of truth:** `samples/benilla` — `wow_model.wgsl` and `terrain.wgsl` for the fog
  coordinate, `lighting/resolve.rs::WmoFogRamp` for the crossfade.
- **Design spec:** `docs/superpowers/specs/2026-07-30-wmo-m2-lighting-design.md`, section "Fog".
- **Colour space:** gamma-space 0..1 throughout. Add no sRGB conversion.
- **GLSL dialect:** GLSL ES 1.0 — `varying`/`gl_FragColor`, no `in`/`out`.
- **Shader build paths:** M2 and WMO shaders are assembled in JS now — do NOT reintroduce
  `#pragma glslify: import(...)`, which is invisible to webpack's watcher. ADT, liquid and particle
  shaders do not use pragmas and are safe to edit directly.
- **Test command:** `cd client && yarn test --watchAll=false --testPathPattern="<pattern>"`
- **Commit per task.** Stage only the task's own paths — the tree carries ~420 unrelated dirty files.

---

## What is actually wrong — corrected from the spec's framing

The spec implies the pipelines disagree about fog. **They do not.** All of them pack fog the same way
and evaluate the same law, and the real defect is narrower:

`blendLights` packs `fogParams = (-1/(end-start), end/(end-start), 1.0, 1.0)`, and every fogged shader
computes:

```glsl
  float f1 = (cameraDistance * fogParams.x) + fogParams.y;   // = (end - d) / (end - start)
  float f4 = min(pow(max(f1, 0.0), fogParams.z), 1.0);       // z is ALWAYS 1.0, so pow is a no-op
  float fogFactor = 1.0 - f4;
```

which is already the reference's linear law. So:

**1. The `pow` is vestigial.** `fogParams.z` is hardcoded `1.0` at the only packing site. The
exponentiation costs a per-fragment `pow` for nothing and disguises the law as something more exotic
than it is.

**2. The fog coordinate is RADIAL everywhere, and the reference uses PLANAR EYE-Z.** All five sites
compute a radial distance:

| Shader | Expression |
|---|---|
| `adt/chunk/shader.vert:21` | `distance(cameraPosition, vertexWorldPosition)` |
| `liquid/material/shader.vert:69` | `distance(cameraPosition, vertexWorldPosition)` |
| `m2/material/vertex/common-main.glsl:45` | `distance(cameraPosition, worldVertexPosition)` |
| `m2/particle/shader.vert:41` | `length(viewCenter.xyz)` |
| `wmo/material/shaders/vertex/main.glsl:21` | `length(modelViewMatrix * vec4(position, 1.0))` |

Radial distance over-fogs the screen edges: a surface at the edge of view is further from the eye than
one dead ahead at the same depth, so it fogs more, and the haze visibly curves. The reference uses
view-space depth. This is the whole of the "unification" work — they need to change **together**, or a
tree fogs differently from the dirt under it.

**3. M2's per-blend-mode fog colour policy is incomplete.** It correctly fades additive modes toward
black (the additive identity) but has no case for Mod (should fade toward **white**, the multiplicative
identity) or Mod2x (toward **grey**, `0.5`). Those modes currently take the `#else`-nothing path and
are left unfogged, so a modulating decal stays crisp at any distance while everything around it hazes.

**4. Interiors have no MFOG.** A WMO interior takes the scene fog, so a storm outside greys out an inn's
interior. `MFOG` is parsed (`client/src/wow-data-parser/wmo/index.js`, with both the FOG and UWFOG
blocks) and `MOGP.fogOffsets` is parsed — but neither reaches `WMOGroupDefinition`.

---

## File Structure

**Created:**
- `client/src/game/world/light/fog.ts` — the pure fog laws: the MFOG staging transform and the
  crossfade ramp. Imports nothing; node-testable.
- `client/src/game/world/light/__tests__/fog.test.ts`

**Modified:**
- The five vertex shaders above (fog coordinate) and their fragment consumers (drop the `pow`).
- `client/src/game/pipeline/m2/material/fragment/common-header.glsl` — the Mod/Mod2x policy.
- `client/src/wow-data-parser/wmo/group.js` + `client/src/game/pipeline/wmo/group/loader/definition.js`
  + `client/src/game/pipeline/wmo/group/index.js` — carry `fogOffsets` through.
- `client/src/game/pipeline/wmo/root/loader/definition.js` — expose the MFOG records.
- `client/src/game/world/light/{MapLight,SceneLight,SceneLightParams,types}.ts` — the interior triple.
- `client/src/game/pipeline/wmo/material/**` — select the interior triple on interior lanes.
- `client/src/pages/game/debug/lighting-readouts.tsx` — scene vs interior fog and the ramp.

---

### Task 1: Planar eye-Z, everywhere at once

**Files:** the five vertex shaders listed above, plus their fragment consumers.

**Interfaces:** produces nothing importable — a coordinate change.

- [ ] **Step 1: Change the five vertex shaders**

In each, replace the radial expression with view-space depth. The pattern, adapted per shader to
whatever it already calls the view-space position:

```glsl
  // Fog rides PLANAR EYE-Z (view-space depth), not radial distance. Radial over-fogs the screen edges:
  // a surface at the edge of view is farther from the eye than one dead ahead at the same depth, so it
  // hazes more and the fog visibly curves. VERIFIED in the reference (samples/benilla terrain.wgsl and
  // wow_model.wgsl both use planar eye-Z and say radial over-fogs the edges).
  cameraDistance = -(modelViewMatrix * vec4(position, 1.0)).z;
```

Notes per shader:
- `wmo/material/shaders/vertex/main.glsl` already has `modelViewMatrix * vec4(position, 1.0)`; take
  `-(...).z` instead of `length(...)`.
- `m2/material/vertex/common-main.glsl` already computes `mvPosition` — reuse it: `-mvPosition.z`. On
  the skinned path `mvPosition` derives from the skinned position, which is correct.
- `m2/particle/shader.vert` has `viewCenter`; use `-viewCenter.z`.
- `adt/chunk/shader.vert` and `liquid/material/shader.vert` compute a world position; add the
  view-space transform.

**All five must change in this one commit.** A partial change is worse than none: it introduces a
visible seam where a fogged tree meets fogged ground.

- [ ] **Step 2: Drop the vestigial `pow`**

In every fragment shader that computes the fog factor, replace:

```glsl
  float f3 = pow(f2, fogParams.z);
  float f4 = min(f3, 1.0);
```

with:

```glsl
  // fogParams.z is always 1.0 at the only packing site (blendLights), so the pow was a no-op costing a
  // per-fragment exponentiation and disguising a plain linear ramp. The law is
  // factor = 1 - clamp((end - eyeZ) / (end - start)).
  float f4 = min(f2, 1.0);
```

Leave `fogParams.z` in the packing and the uniform — removing it would churn the vector layout for no
benefit, and it documents the reference's `GL_LINEAR` mode.

- [ ] **Step 3: Verify and commit**

`cd client && yarn test --watchAll=false` and `npx tsc --noEmit` clean. Then in the client: fog should
no longer curve toward the screen edges. Stand where a long wall recedes across the view and check the
haze tracks depth rather than screen position. **Restart the dev server** if shader changes seem absent.

```bash
git commit -m "fix(fog): ride planar eye-Z rather than radial distance, in every fogged pipeline"
```

---

### Task 2: Complete M2's per-blend-mode fog colour policy

**Files:** `client/src/game/pipeline/m2/material/fragment/common-header.glsl`

- [ ] **Step 1: Add the missing modes**

`applyFog` handles `BLENDING_MODE <= 2` (scene colour) and the additive modes (black). Add Mod and
Mod2x, and make the unfogged case explicit:

```glsl
#if BLENDING_MODE <= 2
  // Opaque, alpha-keyed and alpha-blended geometry replaces what is behind it, so fog replaces its
  // colour in the usual way.
  color.rgb = mix(color.rgb, fogColor.rgb, fogFactor);
#elif BLENDING_MODE == 3 || BLENDING_MODE == 4 || BLENDING_MODE == 6
  // Additive modes ADD into the framebuffer, so their fog target is the additive identity: black.
  // Fading them toward a lit fog colour would ADD light with distance -- a torch's glow picking up the
  // zone's blue fog and drawing a violet halo over everything near it.
  color.rgb = mix(color.rgb, vec3(0.0), fogFactor);
#elif BLENDING_MODE == 5
  // Mod is a pure multiply (DstColor/Zero). Its identity is WHITE -- fade toward that, so a modulating
  // decal stops affecting anything at fog distance instead of staying crisp forever.
  color.rgb = mix(color.rgb, vec3(1.0), fogFactor);
#elif BLENDING_MODE == 7
  // Mod2x multiplies and doubles, so its identity is 0.5 -- grey.
  color.rgb = mix(color.rgb, vec3(0.50196078), fogFactor);
#endif
```

**Check the blend-mode numbering against `applyBlendingMode` in `m2/material/index.ts` before trusting
the `5` and `7` above** — the M2 blend enumeration is not the same list as WMO's, and the previous
comment in this file claimed mode 5 was Mod without the code acting on it. If the numbering differs,
use the real values and say so in your report.

- [ ] **Step 2: Verify and commit**

Tests and `tsc` clean. In the client, look at a modulating decal (shadow blobs under trees are the
common case) at distance — it should fade out rather than stay sharp.

```bash
git commit -m "feat(fog): complete the M2 per-blend-mode fog colour policy"
```

---

### Task 3: The pure MFOG laws

**Files:**
- Create: `client/src/game/world/light/fog.ts`
- Test: `client/src/game/world/light/__tests__/fog.test.ts`

**Interfaces:**
- Produces:
  - `type FogTriple = { color: [number, number, number]; start: number; end: number }`
  - `stageMfog(record, farclip): FogTriple` — the record's own staging law
  - `class WmoFogRamp` with `blend(target: FogTriple | null, scene: FogTriple, farclip: number, dt: number): FogTriple`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/world/light/__tests__/fog.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { FogTriple, stageMfog, WmoFogRamp } from '../fog';

const scene: FogTriple = { color: [0.2, 0.2, 0.2], start: -139, end: 278 };
const room: FogTriple = { color: [1.0, 0.5, 0.0], start: 194.4 * 0.25, end: 194.4 };

describe('stageMfog', () => {
  it('clamps the record end to the farclip and scales start off the CLAMPED end', () => {
    const staged = stageMfog({ color: [1, 1, 1], end: 444.4, startScalar: 0.25 }, 300);
    expect(staged.end).toBeCloseTo(300, 4);
    expect(staged.start).toBeCloseTo(75, 4);
  });

  it('treats the record start as a FRACTION of end, not an absolute distance', () => {
    const staged = stageMfog({ color: [0, 0, 0], end: 200, startScalar: 0.5 }, 1000);
    expect(staged.start).toBeCloseTo(100, 4);
  });
});

describe('WmoFogRamp', () => {
  it('fades in over four seconds', () => {
    const ramp = new WmoFogRamp();
    const half = ramp.blend(room, scene, 1000, 2);
    expect(half.end).toBeCloseTo(scene.end + (room.end - scene.end) * 0.5, 3);
    const full = ramp.blend(room, scene, 1000, 2);
    expect(full.end).toBeCloseTo(room.end, 3);
    expect(full.color[0]).toBeCloseTo(1.0, 5);
  });

  it('latches the staged fog so leaving fades FROM the room, not from nothing', () => {
    const ramp = new WmoFogRamp();
    ramp.blend(room, scene, 1000, 4);
    // No target now -- but the room's fog must still be the thing we fade away from.
    const out = ramp.blend(null, scene, 1000, 2);
    expect(out.end).toBeCloseTo(scene.end + (room.end - scene.end) * 0.5, 3);
  });

  it('returns the scene triple verbatim once fully faded out, and releases the latch', () => {
    const ramp = new WmoFogRamp();
    ramp.blend(room, scene, 1000, 4);
    ramp.blend(null, scene, 1000, 2);
    const out = ramp.blend(null, scene, 1000, 2);
    expect(out).toEqual(scene);
    expect(ramp.blend(null, scene, 1000, 2)).toEqual(scene);
  });

  it('is the scene triple while the camera has never been inside', () => {
    const ramp = new WmoFogRamp();
    expect(ramp.blend(null, scene, 1000, 0.016)).toEqual(scene);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/fog"`
Expected: FAIL — cannot resolve `../fog`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/world/light/fog.ts`:

```ts
/**
 * Fog laws, ported from `samples/benilla` (`lighting/resolve.rs`). Imports nothing, for the same reason
 * `laws.ts` does not: node-testable without three.js.
 */

export type FogTriple = {
  color: [number, number, number];
  start: number;
  end: number;
};

/** One MFOG record as the staging law consumes it. `startScalar` is a FRACTION of `end`. */
export type MfogRecord = {
  color: [number, number, number];
  end: number;
  startScalar: number;
};

/**
 * Stage an MFOG record into a usable triple: `end = min(record end, farclip)`, and
 * `start = end * startScalar` off the CLAMPED end.
 *
 * The start really is a fraction rather than a distance in 1.12.1 -- reading it as absolute yards puts
 * the near plane of the fog in the wrong place entirely.
 */
export function stageMfog(record: MfogRecord, farclip: number): FogTriple {
  const end = Math.min(record.end, farclip);
  return { color: record.color, start: end * record.startScalar, end };
}

/** Crossfade rate: 0.25/second, i.e. four seconds in and four seconds out. */
export const WMO_FOG_RAMP_PER_SEC = 0.25;

/**
 * The camera-in-WMO interior fog crossfade.
 *
 * While the camera stands in a WMO interior the scene fog -- a storm's veil included -- crossfades
 * toward the building's own MFOG fog over four seconds, and back out over four on leaving. That is why
 * a reference inn keeps its warm authored haze while a storm rages outside: the storm's fog never
 * reaches the room.
 *
 * The staged triple LATCHES while the camera leaves, so the fade-out lerps FROM the room's fog rather
 * than popping to the scene fog and then fading nothing.
 */
export class WmoFogRamp {
  private t = 0;
  private staged: FogTriple | null = null;

  blend(target: MfogRecord | null, scene: FogTriple, farclip: number, dt: number): FogTriple {
    if (target) {
      this.staged = stageMfog(target, farclip);
    }

    const direction = target ? 1 : -1;
    this.t = Math.min(1, Math.max(0, this.t + direction * WMO_FOG_RAMP_PER_SEC * dt));

    if (!this.staged) {
      return scene;
    }

    if (this.t <= 0) {
      this.staged = null;
      return scene;
    }

    const k = this.t;
    const staged = this.staged;
    return {
      color: [
        scene.color[0] + (staged.color[0] - scene.color[0]) * k,
        scene.color[1] + (staged.color[1] - scene.color[1]) * k,
        scene.color[2] + (staged.color[2] - scene.color[2]) * k,
      ],
      start: scene.start + (staged.start - scene.start) * k,
      end: scene.end + (staged.end - scene.end) * k,
    };
  }

  /** The ramp's current blend weight, for the debug readout. */
  get weight(): number {
    return this.t;
  }
}
```

- [ ] **Step 4: Run test, then commit**

Expected: PASS, 7 tests.

```bash
git commit -m "feat(fog): the MFOG staging law and the camera-in-WMO crossfade"
```

---

### Task 4: Carry MFOG through to the camera's claimed group

**Files:** `client/src/wow-data-parser/wmo/group.js`,
`client/src/game/pipeline/wmo/group/loader/definition.js`,
`client/src/game/pipeline/wmo/group/index.js`,
`client/src/game/pipeline/wmo/root/loader/definition.js`

**Interfaces:** produces `WMOGroup.fogOffsets` and `WMORootDefinition.fogs` (staged MFOG records).

- [ ] **Step 1: Thread `fogOffsets`**

`MOGP.fogOffsets` is already parsed as four `uint8` indices into MFOG. Carry it through the same three
layers `lightingInterior` uses — that field was threaded through these exact files recently and is the
local precedent. Follow it rather than inventing a new route.

- [ ] **Step 2: Expose the MFOG records on the root**

`MFOG` is parsed with two fog blocks per record — index 0 is FOG, index 1 is UWFOG (underwater). Take
block 0; underwater fog is out of scope (there is no submersion state in this client). Unpack the
`uint32` colour the same way `createLights` unpacks MOLT colour — CImVector is BGRA, so red is `>> 16`
little-endian. **Confirm in your report that you matched that existing code** rather than guessing.

A group whose `fogOffsets` are all zero, or which indexes past the MFOG array, has no interior fog —
return null and let the scene fog stand. Do not substitute a default.

- [ ] **Step 3: Verify and commit**

Tests and `tsc` clean. Nothing consumes this yet — Task 5 does — so the app should look unchanged.

```bash
git commit -m "feat(fog): carry MOGP fogOffsets and the MFOG records through to the group"
```

---

### Task 5: Resolve and publish the interior fog triple

**Files:** `client/src/game/world/light/{MapLight,SceneLight,SceneLightParams,types}.ts`

**Interfaces:** produces `MapLight.interiorFog: FogTriple` and `MapLight.fogRampWeight: number`, plus
`wmoFogColor` / `wmoFogParams` on the published uniforms.

- [ ] **Step 1: Resolve it per frame**

`MapLight.#trackCameraLocation` already knows the camera's claimed WMO and group. Take that group's
first valid `fogOffsets` entry, look up the root's MFOG record, and feed it to a `WmoFogRamp` instance
held on `MapLight`. Pass `null` as the target when the camera is outside, so the ramp fades out.

The ramp needs a real `dt`. `MapLight.update(camera)` has no delta today — check how the caller drives
it (`WorldMap.update` passes `camera, mapID, time`) and use the frame delta rather than assuming 1/60,
or the crossfade runs at whatever the frame rate happens to be.

- [ ] **Step 2: Publish it as uniforms**

Add `wmoFogColor` (a colour) and `wmoFogParams` (packed exactly like `fogParams`:
`(-1/(end-start), end/(end-start), 1, 1)`) to the published uniform set, so the shader can select
between the two triples with no new maths.

**Reuse the existing packing rather than writing a second one.** If `blendLights` does the packing
inline, extract it to a small shared helper and use it for both triples — two copies of a packing this
subtle is how they drift.

- [ ] **Step 3: Verify and commit**

Tests and `tsc` clean. Nothing consumes the new uniforms yet.

```bash
git commit -m "feat(fog): resolve and publish the interior MFOG triple with its crossfade"
```

---

### Task 6: Select the interior triple in the WMO shader, and report it

**Files:** `client/src/game/pipeline/wmo/material/**`,
`client/src/pages/game/debug/lighting-readouts.tsx`

- [ ] **Step 1: Select per lane**

Interior WMO group batches fog with the interior triple; everything else keeps the scene fog. The
material already knows `lightingInterior` and sets an `INTERIOR` define, so gate on that:

```glsl
#if defined(INTERIOR)
  vec3 fogRgb = wmoFogColor;
  vec4 fogSpan = wmoFogParams;
#else
  vec3 fogRgb = fogColor;
  vec4 fogSpan = fogParams;
#endif
```

and use those in the fog computation. Terrain, liquid, sky and exterior groups keep the scene fog —
that is the point: the storm stays grey through the inn's open door.

**Out of scope, and say so in your report if you are tempted:** the reference also fogs an *M2 doodad*
standing in an interior with the interior triple. That needs a per-instance flag on the per-object
lighting block, which is a bigger change than this task; leave the M2 fog lane alone.

- [ ] **Step 2: Extend the readouts**

The debug panel reports one fog range. Add the interior triple beside it and the ramp weight, so the
four-second crossfade can be watched travelling. Extend `LightingReadoutsTarget` — keep it a narrow
structural type, do not loosen it to `any`.

Watch the `shouldComponentUpdate` in `lighting-controls.tsx` if you touch displayed values there; the
readouts component has no such guard, but the controls one does and a value not included in its
`displayState` will appear frozen.

- [ ] **Step 3: Verify and commit**

Tests and `tsc` clean. Then the real check: stand in an inn or the abbey and watch the readout's
interior triple differ from the scene one, and the ramp weight travel 0→1 over four seconds as you step
inside. The room's haze should be its own; looking out through a door, the outside should keep the
scene fog.

```bash
git commit -m "feat(fog): fog interior WMO groups with their own MFOG triple"
```

---

## Done when

- `yarn test --watchAll=false` passes; `npx tsc --noEmit` clean.
- Fog tracks depth rather than screen position — no curving haze at the screen edges.
- A modulating decal fades out at distance instead of staying crisp.
- An interior's fog differs from the scene's, and the crossfade takes four seconds each way.

## Risks

1. **The five-shader coordinate change must be atomic.** A partial change puts a visible seam between
   two fogged surfaces. If one shader resists the change, revert the task rather than shipping four.
2. **Blend-mode numbering.** Task 2 asserts M2 mode 5 is Mod and 7 is Mod2x. Verify against
   `applyBlendingMode` before trusting it; a wrong constant fogs a mode toward the wrong identity, which
   looks like a tint rather than an obvious bug.
3. **`dt` for the ramp.** If the frame delta is not readily available in `MapLight.update`, plumbing it
   is part of Task 5 — do not substitute a fixed 1/60, or the crossfade's duration tracks frame rate.

## Handoff to plan 5

Plan 5 (LightParams slots, weather, sky) needs the `Light.dbc` 8-slot schema fix, which is where the
storm fog values come from. The interior fog built here is what a storm's fog must NOT reach — that
pairing is the visible test for both.
