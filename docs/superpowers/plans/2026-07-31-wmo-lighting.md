# WMO Lighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WMO geometry actually lit — it currently renders as raw texture plus fog — and put it on
the reference's fixed-function law with its three interior batch classes, SIDN night glow and the
WINDOW midpoint.

**Architecture:** The flag and colour decoding moves out of the material constructor into a pure,
tested module (`wmo/material/laws.ts`), mirroring what plan 1 did for the maths. The shaders then move
lighting from the vertex stage to the fragment stage and apply the reference law. No new subsystems.

**Tech Stack:** TypeScript, three.js `ShaderMaterial`, GLSL ES 1.0 (WebGL1-style, `varying`/
`gl_FragColor`), jest.

**This is plan 2 of 5.** Plan 1 (`docs/superpowers/plans/2026-07-30-lighting-laws-and-instruments.md`)
is complete and merged into the branch; this plan consumes `MapLight.sidnNight` from it.

## Global Constraints

- **Reference source of truth:** `samples/benilla`, whose `assets/shaders/wow_model.wgsl` carries the
  WMO lane. Cite the reference for every law.
- **Design spec:** `docs/superpowers/specs/2026-07-30-wmo-m2-lighting-design.md`, section "WMO
  surfaces — fixed-function". Where this plan and the spec disagree, the spec governs — raise it.
- **`wmo/material/laws.ts` imports nothing.** Same constraint and same reason as plan 1's `laws.ts`:
  node-testable, no three.js.
- **Colour space:** the client pins `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`. All
  lighting maths is on authored gamma-space 0..1 values. Add no sRGB conversion.
- **GLSL dialect:** these shaders are GLSL ES 1.0 — `attribute`/`varying`/`gl_FragColor`, no `in`/`out`,
  no dynamic loop bounds. Match the surrounding style.
- **DO NOT touch `MapLight`'s interior sun fade** (`#interiorFactor`, the `interior.sunDiffuseColor`
  zeroing). It is removed at the end of plan 3, once the M2 probes also exist. Removing it here makes
  interiors darker than either the old or the new behaviour. This is the plan's one hard constraint.
- **Test command:** `cd client && yarn test --watchAll=false --testPathPattern="<pattern>"`
- **Commit per task**, conventional-commit prefixes. Stage only the task's own paths — the tree carries
  ~420 unrelated dirty files.

---

## What is wrong today

Five defects, found by reading the code against the reference. Tasks map onto them.

**1. The fragment shader throws the lighting away.**
`client/src/game/pipeline/wmo/material/shaders/fragment/main.glsl` computes a combiner result from the
lit vertex colour and then overwrites it:

```glsl
result = combinersOpaque();                   // consumes colors[0], the lit vertex colour
...
result = texture2D(textures[0], coords[0]);   // overwrites it
```

Every WMO in the world is therefore unlit: no time of day, no MOCV bake, no interior/exterior
distinction. The vertex stage's whole lighting block is dead code.

**2. `emissiveColor` is uploaded as raw 0–255 bytes.**
`material/index.js` does `new Float32Array([color.r, color.g, color.b, color.a])` where those
components are `uint8` straight from the chunk. The shader adds that to a 0..1 light value. This is
invisible today only because of defect 1 — fixing the fragment shader without fixing this turns every
SIDN material white.

**3. The SIDN and UNLIT flags are swapped.**
`material/index.js` gates its "unlit" handling on `def.flags & 0x10` under a comment reading
"Flag 0x01 (unlit)". In `MOMT`, `0x01` is `F_UNLIT` and `0x10` is `F_SIDN`. The code therefore
force-unlits precisely the materials that should glow at night, and never unlits the ones that should.

**4. Emissive is applied unconditionally, with no night fraction.**
The vertex shader adds `emissiveColor.rgb` on all three batch types at full strength. The reference
scales it by the live night fraction and applies it to LIT lanes only — full on EXT, weighted by
MOCV alpha on TRANS, and **zero on INT**, where lighting is off so the emission write is dead.

**5. The `0.5` and the `2.0` cancel.**
The vertex shader computes `light.rgb * 0.5`; the combiners multiply the result by `2.0`. They are a
matched pair of fudges around the missing real law, and they come out together.

---

## File Structure

**Created:**

- `client/src/game/pipeline/wmo/material/laws.ts` — pure decode of a `MOMT` material definition and a
  group's batch reference into the values the shader needs. One responsibility: given the parsed
  chunk fields, say what this material *is* (unlit? SIDN colour? window? which batch class?). No
  three.js, no I/O.
- `client/src/game/pipeline/wmo/material/__tests__/laws.test.ts` — node environment.

**Modified:**

- `client/src/game/pipeline/wmo/material/index.js` — consume `laws.ts` instead of decoding inline.
- `client/src/game/pipeline/wmo/material/shaders/fragment/{main,header,functions}.glsl`
- `client/src/game/pipeline/wmo/material/shaders/vertex/{main,header}.glsl`
- `client/src/pages/game/debug/lighting-readouts.tsx` — the interior/batch-class readouts plan 1
  deliberately deferred until the values existed.

**Not touched:** `MapLight.ts` (see the hard constraint), the M2 pipeline, terrain, fog. Fog is plan 4.

---

### Task 1: Pure decode of the MOMT material flags

Extract the flag and colour decoding so it can be tested, and fix defects 2 and 3 in the process.

**Files:**
- Create: `client/src/game/pipeline/wmo/material/laws.ts`
- Test: `client/src/game/pipeline/wmo/material/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MOMT_FLAG` — a const object of the material flag bits
  - `BatchClass` — `'trans' | 'int' | 'ext'`
  - `batchClassOf(batchType: number): BatchClass`
  - `type MomtColor = { r: number; g: number; b: number; a: number }`
  - `type MaterialLighting = { unlit: boolean; sidn: boolean; window: boolean; sidnColor: [number, number, number]; twoSided: boolean; clampS: boolean; clampT: boolean }`
  - `decodeMaterialLighting(flags: number, sidnColor: MomtColor): MaterialLighting`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/wmo/material/__tests__/laws.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { batchClassOf, decodeMaterialLighting, MOMT_FLAG } from '../laws';

const NO_COLOR = { r: 0, g: 0, b: 0, a: 0 };

describe('decodeMaterialLighting', () => {
  it('reads UNLIT from 0x01, not 0x10', () => {
    // 0x01 is F_UNLIT and 0x10 is F_SIDN. The old material code had these swapped, so it
    // force-unlit exactly the materials that were supposed to glow at night.
    expect(decodeMaterialLighting(0x01, NO_COLOR).unlit).toBe(true);
    expect(decodeMaterialLighting(0x10, NO_COLOR).unlit).toBe(false);
  });

  it('reads SIDN from 0x10', () => {
    expect(decodeMaterialLighting(0x10, NO_COLOR).sidn).toBe(true);
    expect(decodeMaterialLighting(0x01, NO_COLOR).sidn).toBe(false);
  });

  it('reads WINDOW from 0x20', () => {
    expect(decodeMaterialLighting(0x20, NO_COLOR).window).toBe(true);
    expect(decodeMaterialLighting(0x00, NO_COLOR).window).toBe(false);
  });

  it('normalizes the SIDN colour from bytes to 0..1', () => {
    // MOMT stores CImVector bytes. Uploading them raw makes any emissive term saturate instantly.
    const decoded = decodeMaterialLighting(MOMT_FLAG.SIDN, { r: 255, g: 128, b: 0, a: 255 });
    expect(decoded.sidnColor[0]).toBeCloseTo(1, 5);
    expect(decoded.sidnColor[1]).toBeCloseTo(128 / 255, 5);
    expect(decoded.sidnColor[2]).toBeCloseTo(0, 5);
  });

  it('zeroes the SIDN colour on a material without the SIDN flag', () => {
    // An authored colour in the chunk must not glow unless the flag says it is a SIDN material.
    const decoded = decodeMaterialLighting(0x00, { r: 255, g: 255, b: 255, a: 255 });
    expect(decoded.sidnColor).toEqual([0, 0, 0]);
  });

  it('reads the culling and clamp flags', () => {
    expect(decodeMaterialLighting(0x04, NO_COLOR).twoSided).toBe(true);
    expect(decodeMaterialLighting(0x40, NO_COLOR).clampS).toBe(true);
    expect(decodeMaterialLighting(0x80, NO_COLOR).clampT).toBe(true);
    const none = decodeMaterialLighting(0x00, NO_COLOR);
    expect([none.twoSided, none.clampS, none.clampT]).toEqual([false, false, false]);
  });

  it('decodes combined flags independently', () => {
    const decoded = decodeMaterialLighting(0x01 | 0x10 | 0x20 | 0x04, { r: 10, g: 20, b: 30, a: 255 });
    expect(decoded.unlit).toBe(true);
    expect(decoded.sidn).toBe(true);
    expect(decoded.window).toBe(true);
    expect(decoded.twoSided).toBe(true);
    expect(decoded.sidnColor[0]).toBeCloseTo(10 / 255, 5);
  });
});

describe('batchClassOf', () => {
  it('maps MOBA batch ranges to their lighting law', () => {
    // MOBA batches are ordered trans, int, ext; the loader numbers those ranges 1, 2, 3.
    expect(batchClassOf(1)).toBe('trans');
    expect(batchClassOf(2)).toBe('int');
    expect(batchClassOf(3)).toBe('ext');
  });

  it('treats an unknown or absent batch type as exterior', () => {
    // An exterior group's batches carry no meaningful class; exterior is the plain law.
    expect(batchClassOf(0)).toBe('ext');
    expect(batchClassOf(99)).toBe('ext');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="wmo/material/__tests__/laws"`
Expected: FAIL — cannot resolve module `../laws`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/pipeline/wmo/material/laws.ts`:

```ts
/**
 * Pure decode of a WMO `MOMT` material entry into the values the shader needs.
 *
 * Imports nothing, for the same reason `world/light/laws.ts` does not: it keeps the decode testable
 * without three.js, a texture loader or a parsed WMO. The material class applies what this returns.
 *
 * Laws follow `samples/benilla` (`assets/shaders/wow_model.wgsl`, the WMO lane).
 */

/** `MOMT.flags` bits (wowdev `SMOMaterial`). */
export const MOMT_FLAG = {
  /** Lighting off entirely — the draw is `tex x white`. */
  UNLIT: 0x01,
  UNFOGGED: 0x02,
  /** Two-sided: the reference disables backface culling for this material. */
  TWO_SIDED: 0x04,
  EXTERIOR_LIGHT: 0x08,
  /** Self-illuminated at night — the authored emissive colour rides the night fraction. */
  SIDN: 0x10,
  /** A window pane: an interior batch swaps GL_LIGHT0 for the brighter midpoint pair. */
  WINDOW: 0x20,
  CLAMP_S: 0x40,
  CLAMP_T: 0x80,
} as const;

/** A `CImVector` as the chunk reader hands it over: four 0..255 bytes. */
export type MomtColor = { r: number; g: number; b: number; a: number };

/**
 * Which lighting law a batch takes, from its position in `MOBA`. The chunk orders batches trans,
 * int, ext, and the group loader numbers those ranges 1, 2, 3.
 */
export type BatchClass = 'trans' | 'int' | 'ext';

export type MaterialLighting = {
  /** `F_UNLIT`: bypass lighting entirely. Also suppresses emission — with GL_LIGHTING off, the
   *  fixed-function GL_EMISSION term is dead. */
  unlit: boolean;
  sidn: boolean;
  window: boolean;
  /** The authored emissive colour, normalized to 0..1, or black when the material is not SIDN. */
  sidnColor: [number, number, number];
  twoSided: boolean;
  clampS: boolean;
  clampT: boolean;
};

/**
 * Decode `MOMT.flags` plus the material's `sidnColor` word.
 *
 * Two things this fixes, both live bugs in the material class it replaces:
 *
 * 1. **UNLIT is `0x01`, not `0x10`.** The old code tested `0x10` — which is SIDN — under a comment
 *    naming `0x01`, so it force-unlit exactly the materials meant to glow at night and never unlit
 *    the ones that should be.
 * 2. **The colour is BYTES.** `MOMT` stores a `CImVector`; uploading its components raw put 0..255
 *    values into a term added to a 0..1 light sum, which saturates instantly. Normalize here, once.
 *
 * The colour is forced to black unless the SIDN flag is set: the chunk carries an authored colour on
 * materials that are not self-illuminated, and it must not glow.
 */
export function decodeMaterialLighting(flags: number, sidnColor: MomtColor): MaterialLighting {
  const sidn = (flags & MOMT_FLAG.SIDN) !== 0;
  return {
    unlit: (flags & MOMT_FLAG.UNLIT) !== 0,
    sidn,
    window: (flags & MOMT_FLAG.WINDOW) !== 0,
    sidnColor: sidn
      ? [sidnColor.r / 255, sidnColor.g / 255, sidnColor.b / 255]
      : [0, 0, 0],
    twoSided: (flags & MOMT_FLAG.TWO_SIDED) !== 0,
    clampS: (flags & MOMT_FLAG.CLAMP_S) !== 0,
    clampT: (flags & MOMT_FLAG.CLAMP_T) !== 0,
  };
}

/**
 * The batch's lighting class. Anything outside the known range is exterior — an exterior group's
 * batches have no meaningful class, and exterior is the plain law.
 */
export function batchClassOf(batchType: number): BatchClass {
  if (batchType === 1) {
    return 'trans';
  }
  if (batchType === 2) {
    return 'int';
  }
  return 'ext';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="wmo/material/__tests__/laws"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/wmo/material/laws.ts client/src/game/pipeline/wmo/material/__tests__/laws.test.ts
git commit -m "feat(wmo): pure decode of MOMT lighting flags and the SIDN colour"
```

---

### Task 2: Stop the fragment shader discarding the lighting

The plumbing fix on its own, so the change in look is attributable to exactly one edit. The law is
still the old one; Task 3 replaces it.

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/shaders/fragment/main.glsl`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing later tasks import — this is a shader edit.

- [ ] **Step 1: Read the current shader and confirm the defect**

Open `client/src/game/pipeline/wmo/material/shaders/fragment/main.glsl`. Confirm `main()` calls a
combiner into `result`, then unconditionally reassigns `result = texture2D(textures[0], coords[0]);`
a few lines later. That second assignment is the bug.

- [ ] **Step 2: Remove the overwrite**

Replace the body of `main()` with:

```glsl
void main() {
  vec4 result;

  // Branch for combiners. Both consume colors[0] -- the lit vertex colour the vertex stage computes.
  #if defined(COMBINERS_OPAQUE)
    result = combinersOpaque();
  #elif defined(COMBINERS_DIFFUSE)
    result = combinersDiffuse();
  #else
    // No combiner define: fall back to the plain texture rather than rendering nothing. This is the
    // one path where discarding the vertex colour is correct, because no combiner ran.
    result = texture2D(textures[0], coords[0]);
  #endif

  #if BLENDING_MODE == 0
    // Opaque geometry: force alpha to 1 so a texture's stray alpha cannot make it translucent.
    result.a = 1.0;
  #endif

  #if BLENDING_MODE == 1
    if (result.a < alphaTestValue) {
      discard;
    }
  #endif

  result = finalizeResult(result);

  gl_FragColor = result;
}
```

Note what changed: the unconditional `result = texture2D(...)` is gone, and the `#else` branch makes
the no-combiner case explicit instead of implicit. Everything else is as it was.

- [ ] **Step 3: Verify in the running app**

Run the client and look at any building. Before this change WMOs render at full texture brightness,
flat, identical at noon and midnight. After it they should be visibly shaded — darker faces away from
the sun, and responsive to the plan-1 time-of-day slider in the debug panel.

**Expect it to look wrong, and note how.** The law is still the old one (`mix(vertexColor, light*0.5,
alpha)` with the combiners' `*2.0`), and `emissiveColor` is still raw bytes, so SIDN materials may
blow out white. Record what you see; Tasks 3–5 fix it. If WMOs go **completely black**, stop and
report — that means the vertex colours or the light uniforms are not arriving, which is a different
defect from the one this task fixes.

- [ ] **Step 4: Commit**

```bash
git add client/src/game/pipeline/wmo/material/shaders/fragment/main.glsl
git commit -m "fix(wmo): stop the fragment shader discarding the lit vertex colour"
```

---

### Task 3: The reference lighting law, per fragment

Move lighting from the vertex stage to the fragment stage and apply
`tex x clamp(MOCV.(ambient + diffuse.max(N.L,0)))`. Emission arrives in Task 4.

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/shaders/vertex/{main,header}.glsl`
- Modify: `client/src/game/pipeline/wmo/material/shaders/fragment/{main,header,functions}.glsl`
- Modify: `client/src/game/pipeline/wmo/material/index.js`

**Interfaces:**
- Consumes: `decodeMaterialLighting` from Task 1.
- Produces: the fragment shader's `applyWmoLighting(vec4 tex)` helper, which Tasks 4–5 extend.

- [ ] **Step 1: Pass the raw inputs through to the fragment stage**

The vertex stage currently computes the whole lit colour into `colors[0]`. Under the reference law the
fragment stage needs the pieces, not the result. In `shaders/vertex/header.glsl`, replace the
`varying vec4 colors[2];` declaration with:

```glsl
// The lighting inputs the fragment stage needs. The reference evaluates N.L per fragment, so the
// vertex stage hands over the raw normal and MOCV rather than a pre-lit colour.
varying vec4 vertexColorOut;
varying vec3 worldNormal;
```

Leave `coords` and `fog` as they are.

- [ ] **Step 2: Reduce the vertex main to transport**

In `shaders/vertex/main.glsl`, replace everything from the `#if USE_LIGHTING == 1` block through the
three `#if BATCH_TYPE` blocks with:

```glsl
  // Lighting moved to the fragment stage (the reference evaluates N.L per fragment). The vertex
  // stage now only transports what that needs. The old `light * 0.5` here and the matching `* 2.0`
  // in the combiners were a cancelling pair of fudges around the missing real law; both are gone.
  #if USE_VERTEX_COLOR == 1
    vertexColorOut = acolor;
  #else
    vertexColorOut = vec4(1.0, 1.0, 1.0, 1.0);
  #endif

  worldNormal = objectNormal;
```

`objectNormal` is already computed at the top of `main()`. Keep the `coords[0]`, `fog` and
`gl_Position` lines exactly as they are.

- [ ] **Step 3: Declare the fragment stage's new inputs**

In `shaders/fragment/header.glsl`, replace `varying vec4 colors[2];` with:

```glsl
varying vec4 vertexColorOut;
varying vec3 worldNormal;

// The scene light, pushed by MapLight. `sunParams.xyz` is the direction light TRAVELS, so the
// to-light vector is its negation.
uniform vec4 sunParams;
uniform vec3 sunDiffuseColor;
uniform vec3 sunAmbientColor;

// 0 for a material whose lighting is off (MOMT F_UNLIT).
uniform float lightModifier;
```

- [ ] **Step 4: Write the law**

In `shaders/fragment/functions.glsl`, add above `finalizeResult`:

```glsl
/**
 * The WMO surface law (samples/benilla, wow_model.wgsl WMO lane).
 *
 * WMO geometry genuinely IS fixed-function in the reference -- GL_LIGHTING with one directional
 * light -- so it takes a plain matte, NOT the order-2 irradiance lobe the M2 lane uses:
 *
 *   out = tex x clamp(MOCV x (ambient + diffuse x max(N.L, 0)))
 *
 * Two orderings matter and are easy to get backwards:
 *
 *  - MOCV multiplies the light terms INSIDE the clamp. Under GL_COLOR_MATERIAL the vertex colour is
 *    the material's ambient+diffuse, not a post-multiply on the result.
 *  - The light sum saturates FIRST, and the texture modulates the clamped result. The other order
 *    lets a bright term push a surface past its own fully-lit texture.
 */
vec3 wmoLitFactor(vec3 normal, vec3 mocv) {
  vec3 toLight = -normalize(sunParams.xyz);
  float incidence = max(dot(normalize(normal), toLight), 0.0);
  vec3 light = sunAmbientColor + sunDiffuseColor * incidence;
  return clamp(mocv * light, 0.0, 1.0);
}

vec4 applyWmoLighting(vec4 tex) {
  if (lightModifier <= 0.0) {
    // F_UNLIT: the draw is tex x white. Faithfully receives no emission either -- with lighting off
    // the fixed-function GL_EMISSION term is dead.
    return tex;
  }

  vec4 result = tex;
  result.rgb = tex.rgb * wmoLitFactor(worldNormal, vertexColorOut.rgb);
  return result;
}
```

- [ ] **Step 5: Call it, and drop the combiners' `* 2.0`**

In `shaders/fragment/combiners.glsl`, both combiners currently multiply by `2.0` to cancel the vertex
stage's `* 0.5`. That pair is gone, so remove the `* 2.0` and the vertex-colour multiply — the
combiners now return the raw texture sample and lighting is applied after:

```glsl
vec4 combinersOpaque() {
  vec4 sampled0 = texture2D(textures[0], coords[0]);

  vec4 result;
  result.rgb = sampled0.rgb;
  result.a = 1.0;

  return result;
}

vec4 combinersDiffuse() {
  vec4 sampled0 = texture2D(textures[0], coords[0]);

  vec4 result;
  result.rgb = sampled0.rgb;
  result.a = sampled0.a;

  return result;
}
```

Then in `shaders/fragment/main.glsl`, apply lighting between the alpha test and `finalizeResult`:

```glsl
  result = applyWmoLighting(result);

  result = finalizeResult(result);
```

- [ ] **Step 6: Supply the uniforms the fragment stage now reads**

In `material/index.js`, the constructor's uniform block already declares `sunParams`,
`sunDiffuseColor` and `sunAmbientColor`, and `setMapLight` already pushes them — those now feed the
fragment stage instead of the vertex stage, with no change needed.

`lightModifier` is only assigned inside a flag branch, so materials without that flag never get the
uniform at all and it reads as 0 — which under the new law makes them all unlit. Declare it in the
constructor's uniform block with a default of 1.0, beside `materialParams`:

```js
      // Declared unconditionally: a uniform the shader reads but nobody supplies reads as ZERO,
      // which under the fragment law means "unlit". Only F_UNLIT materials should be 0.
      lightModifier: { value: 1.0 },
```

Then replace the two flag branches that currently test `0x10` with a single `laws.ts`-driven block.
Add the import at the top of the file:

```js
import { decodeMaterialLighting } from './laws';
```

and in the constructor, after `this.defines.BATCH_TYPE = def.batchType;`, replace **both** the
`if (def.flags & 0x10) { this.uniforms.sunParams.value[3] = 0.0; }` block and the
`if (def.flags & 0x10) { this.uniforms.lightModifier = ... }` block with:

```js
    // Flag decode lives in laws.ts. Note this corrects a swap: the old code tested 0x10 (SIDN) as
    // though it were UNLIT, so it unlit exactly the materials that should glow at night.
    //
    // `def.sidnColor` comes from Task 7 -- MOMT slot 1's colour word, carried on the definition
    // directly. Do NOT read it off `def.textures[0]`: that list holds only the slots whose texture
    // path RESOLVED, so its index 0 is not reliably MOMT slot 0.
    //
    // Kept on the instance because Task 5 reads `sidnColor` and `window` off it, and because a
    // material's decoded lighting is worth inspecting from a breakpoint.
    this.lighting = decodeMaterialLighting(def.flags, def.sidnColor);
    const lighting = this.lighting;

    if (lighting.unlit) {
      this.uniforms.lightModifier.value = 0.0;
    }
```

- [ ] **Step 7: Drive the INTERIOR define from the LIGHTING class**

**Gap closed during execution.** Task 7 added `lightingInterior` to `MOGI` in
`client/src/wow-data-parser/wmo/index.js`, but the material reads its interior flag from **`MOGP`**
(`material/index.js:15` — `this.interior = def.interior || groupData.interior`), whose parser is
`client/src/wow-data-parser/wmo/group.js`. So the new lighting class never reaches the material.

Add the same field to `MOGP`, beside its existing `interior` at around line 172 and leaving that one
untouched:

```js
    // The LIGHTING class — see MOGI.lightingInterior and laws.isLightingInterior. Distinct from
    // `interior` above, which answers the culling/containment question: an EXTERIOR_LIT porch
    // claims the camera but is lit as outdoors.
    lightingInterior: function() {
      return (this.flags & 0x48) === 0;
    }
```

Then in `material/index.js`, keep `this.interior` exactly as it is — other code depends on it — and
add a separate field for the lighting lane:

```js
    // Lighting takes the reference's 0x48 class; `this.interior` above stays the culling question.
    this.lightingInterior = groupData.lightingInterior === undefined
      ? this.interior
      : groupData.lightingInterior;
```

The `undefined` fallback matters: `groupData` also arrives from paths that predate this field, and
falling back to the culling flag is closer than defaulting to exterior.

Finally, set the shader define from the new field rather than the old one:

```js
    if (this.lightingInterior) {
      this.defines.INTERIOR = 1;
    }
```

Task 8 de-duplicates the `0x48` mask across all three sites.

- [ ] **Step 8: Verify in the running app**

Buildings should now be lit per fragment rather than per vertex — smooth shading across large wall
faces instead of visible triangle banding — and should track the time-of-day slider. Interiors will
still look wrong (the batch classes land in Task 4) and SIDN materials still have no glow (Task 5).
Note what you see.

- [ ] **Step 9: Commit**

```bash
git add client/src/game/pipeline/wmo/material/shaders client/src/game/pipeline/wmo/material/index.js client/src/wow-data-parser/wmo/group.js
git commit -m "feat(wmo): put surfaces on the reference fixed-function law, per fragment"
```

---

### Task 4: The three interior batch classes

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/shaders/fragment/{functions,header}.glsl`
- Modify: `client/src/game/pipeline/wmo/material/index.js`

**Interfaces:**
- Consumes: `batchClassOf` from Task 1, `applyWmoLighting` from Task 3.
- Produces: the `BATCH_CLASS` / `INTERIOR` shader defines that Task 5 branches on.

- [ ] **Step 1: Set the defines from the batch class**

In `material/index.js`, replace `this.defines.BATCH_TYPE = def.batchType;` with:

```js
    // The batch's lighting law. MOBA orders batches trans, int, ext and the group loader numbers
    // those ranges 1/2/3; laws.ts maps them. 0 = ext, 1 = int, 2 = trans in the shader.
    const batchClass = batchClassOf(def.batchType);
    this.defines.BATCH_CLASS = batchClass === 'int' ? 1 : batchClass === 'trans' ? 2 : 0;
```

Extend the import: `import { batchClassOf, decodeMaterialLighting } from './laws';`

`this.defines.INTERIOR` is already set from `this.lightingInterior` by Task 3 step 7 — leave it as
Task 3 left it. Do NOT re-point it at `this.interior`, which answers the culling question, not the
lighting one.

- [ ] **Step 2: Implement the three laws**

In `shaders/fragment/functions.glsl`, replace `applyWmoLighting` with:

```glsl
vec4 applyWmoLighting(vec4 tex) {
  if (lightModifier <= 0.0) {
    return tex;
  }

  vec3 mocv = vertexColorOut.rgb;
  vec4 result = tex;

#if defined(INTERIOR) && BATCH_CLASS == 1
  // INT -- UNLIT by design. The baked vertex colours ARE the room's light: the artists' lamp,
  // forge, hearth and candle warmth, constant day and night. No exterior light reaches it, and the
  // reference commits no point lights to any WMO surface.
  //
  // MOCV ALPHA is an authored self-illumination mask, applied as `tex x MOCV x (1 + 4 x MOCV.a)`.
  // The literal 4 is read off the reference's interior pixel shader, and unlike the light sum above
  // this product is NOT pre-clamped -- it may legitimately overdrive to white. A fireplace surround
  // bakes alpha around 100/255, giving roughly x2.6. It is near zero everywhere unpainted, where
  // this collapses to the plain tex x MOCV it replaces.
  result.rgb = clamp(tex.rgb * mocv * (1.0 + 4.0 * vertexColorOut.a), 0.0, 1.0);
#elif defined(INTERIOR) && BATCH_CLASS == 2
  // TRANS -- the per-vertex lerp between the lit surface and that unlit bake. The reference draws
  // this as two passes (lit x SRC_ALPHA + unlit x (1 - SRC_ALPHA)); collapsed to one pass, the lit
  // factor is mix(1, lit, MOCV.a).
  vec3 lit = wmoLitFactor(worldNormal, mocv);
  result.rgb = tex.rgb * mix(vec3(1.0), lit, vertexColorOut.a);
#else
  // EXT -- an interior group's exterior-law batches, and every exterior group batch.
  result.rgb = tex.rgb * wmoLitFactor(worldNormal, mocv);
#endif

  return result;
}
```

- [ ] **Step 3: Keep MOCV alpha out of coverage**

Interior batches carry lighting data in the MOCV alpha, which must never reach the alpha test —
coverage is the texel alpha. Confirm `shaders/fragment/main.glsl`'s alpha test reads `result.a` as it
comes from the combiner (the texel alpha) and that nothing folds `vertexColorOut.a` into it. If the
combiner ever multiplies vertex alpha into `result.a`, remove that — the reference's interior pixel
shader outputs `tex.a` for coverage and MOCV alpha never participates.

- [ ] **Step 4: Verify in the running app**

Enter an inn or the Northshire abbey. Interior surfaces should read as the artists' baked warmth
rather than as exterior-lit walls, and should NOT change as you scrub the time-of-day slider —
interiors are day/night independent under the INT law. Doorways and portal seams may read brighter
(that is the `FixColorVertexAlpha` lift the `1 + 4a` term reproduces). Exterior walls of the same
building must still track the slider.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/wmo/material/shaders client/src/game/pipeline/wmo/material/index.js
git commit -m "feat(wmo): the three interior batch-class lighting laws"
```

---

### Task 5: SIDN night glow and the WINDOW midpoint

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/shaders/fragment/{functions,header}.glsl`
- Modify: `client/src/game/pipeline/wmo/material/index.js`

**Interfaces:**
- Consumes: `decodeMaterialLighting` from Task 1, `MapLight.sidnNight` from plan 1.
- Produces: nothing later tasks import.

- [ ] **Step 1: Add the uniforms**

In `shaders/fragment/header.glsl`, add:

```glsl
// MOMT F_SIDN: the authored emissive colour, already normalized to 0..1 by laws.ts. Black on a
// material without the flag.
uniform vec3 sidnColor;

// The live night fraction: 1 overnight, 0 by day, ramping 20:30-21:30 and 06:00-07:00.
uniform float sidnNight;

// MOMT F_WINDOW: 1 for a window pane, 0 otherwise.
uniform float windowFlag;
```

In `material/index.js`, add to the constructor's uniform block:

```js
      sidnColor: { value: new THREE.Vector3() },
      sidnNight: { value: 0.0 },
      windowFlag: { value: 0.0 },
```

and after the `decodeMaterialLighting` call from Task 3:

```js
    this.uniforms.sidnColor.value.fromArray(lighting.sidnColor);
    this.uniforms.windowFlag.value = lighting.window ? 1.0 : 0.0;
```

In `setMapLight`/`updateLightUniforms` (wherever the material pulls its per-frame light values), add:

```js
    this.uniforms.sidnNight.value = mapLight.sidnNight;
```

- [ ] **Step 2: Apply both laws**

In `shaders/fragment/functions.glsl`, replace `wmoLitFactor` and the EXT/TRANS branches' use of it:

```glsl
/**
 * The interior WINDOW law (MOMT 0x20; samples/benilla wow_model.wgsl, wmo-interior-night-light).
 *
 * An interior-group batch flagged WINDOW swaps GL_LIGHT0 for a brighter pair: ambient AND diffuse
 * both become the MIDPOINT of the direct and ambient bands, with ambient lifted a further 16/255
 * saturating. Folding the warm direct band in at full weight is what makes an interior pane read
 * bright and warm in daylight instead of taking the flat interior ambient -- and it still tracks
 * time of day. The exterior drawer has no WINDOW machinery, so exterior batches never take this.
 */
vec3 wmoLitFactor(vec3 normal, vec3 mocv) {
  vec3 toLight = -normalize(sunParams.xyz);
  float incidence = max(dot(normalize(normal), toLight), 0.0);

  vec3 ambient = sunAmbientColor;
  vec3 diffuse = sunDiffuseColor;

#if defined(INTERIOR)
  if (windowFlag > 0.0) {
    vec3 midpoint = 0.5 * (sunDiffuseColor + sunAmbientColor);
    ambient = midpoint + vec3(16.0 / 255.0);
    diffuse = midpoint;
  }
#endif

  vec3 light = ambient + diffuse * incidence;
  return clamp(mocv * light, 0.0, 1.0);
}
```

Then fold the emission into the lit lanes. Replace the EXT and TRANS branches of `applyWmoLighting`:

```glsl
#elif defined(INTERIOR) && BATCH_CLASS == 2
  // TRANS: emission rides the lit pass, weighted by the same MOCV alpha that weights the lerp.
  vec3 lit = wmoLitFactor(worldNormal, mocv);
  vec3 emission = sidnColor * (sidnNight * vertexColorOut.a);
  result.rgb = tex.rgb * clamp(mix(vec3(1.0), lit, vertexColorOut.a) + emission, 0.0, 1.0);
#else
  // EXT: emission at full weight.
  vec3 emission = sidnColor * sidnNight;
  result.rgb = tex.rgb * clamp(wmoLitFactor(worldNormal, mocv) + emission, 0.0, 1.0);
#endif
```

The INT branch gets **no** emission term and must not gain one: lighting is off on that lane, so the
fixed-function emissive write is dead there, exactly as under `F_UNLIT`.

Note the emission is added INSIDE the clamp, alongside the lit terms and never multiplied by MOCV —
that is where `glMaterialfv(GL_EMISSION)` sits in the fixed-function pipeline.

- [ ] **Step 3: Verify in the running app**

Scrub the time-of-day slider from 20:00 to 22:00 with a building in view. Windows should come up over
20:30 to 21:30 and be fully lit by 21:30, matching the SIDN night fraction shown in the debug
readouts. At noon they should be dark. Then step inside and look at a window pane from indoors in
daylight — it should read bright and warm rather than flat.

Cross-check the readout: the panel's SIDN night value and the visible glow must move together. If the
glow is full at noon, the night fraction is not reaching the uniform.

- [ ] **Step 4: Commit**

```bash
git add client/src/game/pipeline/wmo/material/shaders client/src/game/pipeline/wmo/material/index.js
git commit -m "feat(wmo): SIDN night glow and the interior WINDOW midpoint law"
```

---

### Task 6: Extend the debug readouts with WMO lighting state

Plan 1 deliberately left these out because the values did not exist yet. They do now.

**Files:**
- Modify: `client/src/pages/game/debug/lighting-readouts.tsx`
- Test: `client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx`

**Interfaces:**
- Consumes: `LightingReadoutsTarget` from plan 1's Task 6.
- Produces: an extended `LightingReadoutsTarget` with `sidnNight` already present plus a new optional
  `wmo` field.

- [ ] **Step 1: Write the failing test**

Append to `client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx`:

```tsx
describe('LightingReadouts WMO state', () => {
  it('shows a dash when the camera is not in a WMO', () => {
    render(<LightingReadouts mapLight={target({ wmo: null })} />);
    expect(screen.getByText(/WMO: -/)).toBeInTheDocument();
  });

  it('names the claimed WMO group and its batch-class counts', () => {
    const wmo = { name: 'Stormwind_Inn', groupIndex: 3, ext: 12, int: 40, trans: 5 };
    render(<LightingReadouts mapLight={target({ wmo })} />);
    expect(screen.getByText(/Stormwind_Inn/)).toBeInTheDocument();
    expect(screen.getByText(/group 3/)).toBeInTheDocument();
    expect(screen.getByText(/ext 12/)).toBeInTheDocument();
    expect(screen.getByText(/int 40/)).toBeInTheDocument();
    expect(screen.getByText(/trans 5/)).toBeInTheDocument();
  });
});
```

Extend the existing `target()` helper's defaults with `wmo: null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="lighting-readouts"`
Expected: FAIL — `WMO: -` not found.

- [ ] **Step 3: Extend the type and render the section**

In `lighting-readouts.tsx`, add to `LightingReadoutsTarget`:

```ts
  /** The WMO the camera is standing in, or null outdoors. */
  wmo: {
    name: string;
    groupIndex: number;
    ext: number;
    int: number;
    trans: number;
  } | null;
```

and render, after the existing area-lights section:

```tsx
        <div className="divider"></div>
        <p>
          WMO:{' '}
          {mapLight.wmo
            ? `${mapLight.wmo.name} · group ${mapLight.wmo.groupIndex}`
            : '-'}
        </p>
        {mapLight.wmo && (
          <p>
            Batches: ext {mapLight.wmo.ext} · int {mapLight.wmo.int} · trans {mapLight.wmo.trans}
          </p>
        )}
```

- [ ] **Step 4: Populate it from MapLight**

`MapLight.#trackCameraLocation` already reads `camera.location`. For an interior that object carries
`wmo: { handler, root, group, views }` (built in `game/world/location-manager.js`), and the group
holds `materialRefs`, each with a `batchType` — so everything the readout needs is already in hand.

Add the field beside `#sampledPosition`, following the pattern plan 1 established:

```ts
  // The WMO the camera is standing in, for the debug readout. Null outdoors.
  #wmo: { name: string; groupIndex: number; ext: number; int: number; trans: number } | null = null;
```

In `#trackCameraLocation`, after `this.location` is assigned, add:

```ts
    this.#wmo = interior ? MapLight.#describeWmo(location.wmo) : null;
```

and the static helper beside the other private statics:

```ts
  /**
   * Summarise the claimed WMO group for the debug readout: which building and group, and how its
   * batches split across the three lighting classes. The counts are the fastest way to tell a
   * misclassified group from a mis-lit one -- an interior room reporting all-ext batches is a
   * classification bug, not a shader bug.
   */
  static #describeWmo(wmo: any) {
    const group = wmo && wmo.group;
    if (!group) {
      return null;
    }
    const refs = group.materialRefs || [];
    const count = (type: number) => refs.filter((ref: any) => ref.batchType === type).length;
    return {
      name: (wmo.handler && wmo.handler.filename) || (wmo.root && wmo.root.path) || 'unknown',
      groupIndex: group.index,
      // MOBA order: 1 = trans, 2 = int, 3 = ext.
      trans: count(1),
      int: count(2),
      ext: count(3),
    };
  }
```

plus the getter beside `get sampledPosition()`:

```ts
  get wmo() {
    return this.#wmo;
  }
```

If `materialRefs` turns out not to be reachable on the group at runtime, render the name and group
index and leave the counts at 0 rather than plumbing a new path through the WMO manager — say so in
your report. The readout is worth a getter, not an architecture change.

- [ ] **Step 5: Run tests**

Run: `cd client && yarn test --watchAll=false --testPathPattern="lighting-readouts"`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full suite**

Run: `cd client && yarn test --watchAll=false`
Expected: PASS. Report honestly if anything unrelated fails.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/game/debug/lighting-readouts.tsx client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx client/src/game/world/light/MapLight.ts
git commit -m "feat(debug): report the camera's WMO and its batch-class counts"
```

---

## Done when

- `yarn test --watchAll=false --testPathPattern="wmo/material"` passes, 9 tests.
- `yarn test --watchAll=false --testPathPattern="lighting-readouts"` passes, 7 tests.
- `yarn test --watchAll=false` passes overall; `npx tsc --noEmit` exits 0.
- WMOs are visibly lit, track time of day, and interiors read as their baked warmth.
- Windows glow between 20:30 and 21:30 and are dark at noon.

### Task 7: Slot-exact SIDN colour and the interior lighting class

**RUN THIS AFTER TASK 1 AND BEFORE TASK 3.** Two decode-adjacent defects that Tasks 3–5 depend on.

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/loader/definition.js`
- Modify: `client/src/game/pipeline/wmo/root/index.js`
- Modify: `client/src/wow-data-parser/wmo/index.js`
- Modify: `client/src/game/pipeline/wmo/material/laws.ts`
- Test: `client/src/game/pipeline/wmo/material/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: `MomtColor` from Task 1.
- Produces:
  - `WMOMaterialDefinition.sidnColor: MomtColor` — MOMT slot 1's colour word, always present
  - `isLightingInterior(mogiFlags: number): boolean` in `laws.ts`
  - `MOGI.lightingInterior` on parsed groups

**Defect 1 — `def.textures` is a filtered list, so index 0 is not MOMT slot 0.**
`WMORoot.createMaterialDefs` appends only those texture slots whose path resolved, so on a material
whose first slot has no texture, `textures[0]` carries `color_2` rather than the SIDN word — and the
list can be empty. Reading the emissive colour from it is unsound. The fix is exact and small: the
parser already exposes `data.texture1.color`, which IS the SIDN word, independent of path
resolution.

**Defect 2 — the interior rule disagrees with the reference.**
`MOGI.interior` computes `(flags & 0x2000) !== 0 && (flags & 0x8) === 0`. The reference forks the
**lighting** class on `MOGI & 0x48` — either EXTERIOR (`0x8`) or EXTERIOR_LIT (`0x40`) means the
exterior lighting law (benilla `wmo_portal/mod.rs`, classify `0x6a87f0`). These disagree on a group
flagged EXTERIOR_LIT without INTERIOR.

**This is deliberately a SECOND notion of interior, not a replacement.** The reference keeps both: an
EXTERIOR_LIT-only porch still *claims* the camera for portal and containment purposes while lighting
as outdoors. So `interior` stays exactly as it is — it drives culling — and `lightingInterior` is
added beside it. Do not change `interior`, and do not route culling through the new flag.

- [ ] **Step 1: Write the failing test**

Append to `client/src/game/pipeline/wmo/material/__tests__/laws.test.ts`, adding `isLightingInterior`
to the import:

```ts
describe('isLightingInterior', () => {
  it('is interior when neither EXTERIOR nor EXTERIOR_LIT is set', () => {
    expect(isLightingInterior(0x0000)).toBe(true);
    expect(isLightingInterior(0x2000)).toBe(true);
  });

  it('is exterior when EXTERIOR (0x8) is set', () => {
    expect(isLightingInterior(0x0008)).toBe(false);
    expect(isLightingInterior(0x2008)).toBe(false);
  });

  it('is exterior when EXTERIOR_LIT (0x40) is set, even with INTERIOR also set', () => {
    // This is the case the old rule got wrong: an EXTERIOR_LIT porch flagged INTERIOR read as
    // indoors and took the interior law, where the reference lights it as outdoors.
    expect(isLightingInterior(0x0040)).toBe(false);
    expect(isLightingInterior(0x2040)).toBe(false);
  });

  it('ignores unrelated flag bits', () => {
    // 0x1 BSP, 0x4 vertex colours, 0x200 lights, 0x800 doodads -- none of them classify lighting.
    expect(isLightingInterior(0x0001 | 0x0004 | 0x0200 | 0x0800)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="wmo/material/__tests__/laws"`
Expected: FAIL — `isLightingInterior is not a function`.

- [ ] **Step 3: Add the classifier**

Append to `client/src/game/pipeline/wmo/material/laws.ts`:

```ts
/** `MOGI`/`MOGP` group flag bits that decide the LIGHTING class. */
export const MOGI_FLAG = {
  /** An outdoor group — street, deck, terrace. */
  EXTERIOR: 0x8,
  /** An interior-graph group that is nonetheless LIT as outdoors: a porch, a courtyard. */
  EXTERIOR_LIT: 0x40,
} as const;

/**
 * Whether a group takes the INTERIOR lighting law.
 *
 * The reference forks the lighting class on `MOGI & 0x48` — either EXTERIOR (`0x8`) or EXTERIOR_LIT
 * (`0x40`) sends the group down the exterior leg (benilla `wmo_portal/mod.rs`, classify `0x6a87f0`).
 *
 * This is deliberately a SECOND notion of "interior", separate from the `interior` flag that drives
 * portal culling and camera containment — the reference keeps both, because an EXTERIOR_LIT-only
 * porch still claims the camera while lighting as outdoors. Do not collapse them.
 */
export function isLightingInterior(mogiFlags: number): boolean {
  return (mogiFlags & (MOGI_FLAG.EXTERIOR | MOGI_FLAG.EXTERIOR_LIT)) === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="wmo/material/__tests__/laws"`
Expected: PASS, 13 tests (9 from Task 1 + 4 new).

- [ ] **Step 5: Expose the lighting class on parsed groups**

In `client/src/wow-data-parser/wmo/index.js`, in the `MOGI` struct, add beside the existing
`interior` computed field — leaving `interior` untouched:

```js
    // The LIGHTING class, which is not the same question as `interior` above. The reference forks
    // it on MOGI & 0x48: EXTERIOR (0x8) or EXTERIOR_LIT (0x40) both mean "lit as outdoors". An
    // EXTERIOR_LIT porch still claims the camera for culling, which is why both flags exist.
    lightingInterior: function() {
      return (this.flags & 0x48) === 0;
    }
```

- [ ] **Step 6: Carry the SIDN colour on the material definition**

In `client/src/game/pipeline/wmo/material/loader/definition.js`, add `sidnColor` to the constructor
signature, the field list, and `clone()`:

```js
  constructor(index, flags, blendingMode, shaderID, textures, sidnColor) {
    this.index = index;
    this.flags = flags;
    this.blendingMode = blendingMode;
    this.shaderID = shaderID;
    this.textures = textures;
    // MOMT slot 1's colour word — the SIDN emissive. Carried separately from `textures` because
    // that list is FILTERED to slots whose path resolved, so its index 0 is not reliably slot 0.
    this.sidnColor = sidnColor;
```

and in `clone()`:

```js
  clone() {
    const { index, flags, blendingMode, shaderID, textures, sidnColor } = this;
    return new WMOMaterialDefinition(index, flags, blendingMode, shaderID, textures, sidnColor);
  }
```

In `client/src/game/pipeline/wmo/root/index.js`, pass it at the construction site:

```js
      // data.texture1.color IS the MOMT sidnColor word, and it is present whether or not that
      // slot's texture path resolved — unlike anything reachable through the filtered list above.
      const def = new WMOMaterialDefinition(
        mindex,
        flags,
        blendMode,
        shader,
        textures,
        data.texture1.color,
      );
```

- [ ] **Step 7: Verify nothing regressed**

Run: `cd client && yarn test --watchAll=false` and `npx tsc --noEmit`.
Expected: both clean. Nothing consumes `sidnColor` or `lightingInterior` yet — Tasks 3–5 do — so the
app should look exactly as it did.

- [ ] **Step 8: Commit**

```bash
git add client/src/game/pipeline/wmo/material/laws.ts client/src/game/pipeline/wmo/material/__tests__/laws.test.ts client/src/game/pipeline/wmo/material/loader/definition.js client/src/game/pipeline/wmo/root/index.js client/src/wow-data-parser/wmo/index.js
git commit -m "fix(wmo): slot-exact SIDN colour and the reference interior lighting class"
```

---

### Task 8: Correct the alpha-test and wrap flags, delete the dead shaders

**RUN THIS AFTER TASK 5 AND BEFORE TASK 6.** Three smaller defects, cleaned up once the new law is in
place so any regression is attributable to a known change.

**Files:**
- Modify: `client/src/game/pipeline/wmo/material/index.js`
- Delete: `client/src/game/pipeline/wmo/material/shader.frag`
- Delete: `client/src/game/pipeline/wmo/material/shader.vert`

**Interfaces:**
- Consumes: `decodeMaterialLighting` from Task 1 (its `clampS`/`clampT` fields, unused until now).
- Produces: nothing later tasks import.

**Defect 1 — the alpha-test threshold keys off a texture-wrap flag.** `material/index.js` picks
`0.2999999` instead of `0.878431` when `flags & 0x80` is set. `0x80` is `F_CLAMP_T`, a texture
wrap mode with no bearing on an alpha cutoff. `0.878431` is 224/255, the vanilla cutout reference
(benilla pins the same constant as `VANILLA_ALPHA_KEY = 0.8784314`). The `0.3` branch is not a law;
remove it.

**Defect 2 — clamp is applied to both axes from the S flag alone.** The code sets one `this.wrapping`
from `flags & 0x40` (`F_CLAMP_S`) and passes it as BOTH the S and T wrap mode. A material flagged
clamp-S but not clamp-T gets its T axis wrongly clamped, and one flagged clamp-T only gets neither.

**Defect 3 — dead shader files.** `material/shader.frag` and `material/shader.vert` are not imported
by anything (`index.js` imports from `shaders/{vertex,fragment}/main.glsl`) and still carry a third,
now-superseded lighting law.

- [ ] **Step 1: Fix the alpha-test threshold**

In `material/index.js`, replace the alpha-test block with:

```js
    if (this.def.blendingMode !== 0) {
      // 224/255, the vanilla cutout reference. The previous 0.2999999 branch keyed off flags & 0x80,
      // which is F_CLAMP_T -- a texture wrap mode with nothing to say about an alpha cutoff.
      this.uniforms.alphaTestValue = { value: 0.878431 };
    } else {
      this.uniforms.alphaTestValue = { value: -1.0 };
    }
```

- [ ] **Step 2: Fix the per-axis wrap modes**

Replace the single `this.wrapping` assignment (the `flags & 0x40` branch) with per-axis values taken
from the Task 1 decode, which already exposes both:

```js
    // MOMT carries clamp-S (0x40) and clamp-T (0x80) independently. The old code derived ONE wrap
    // mode from the S flag and passed it for both axes, so a clamp-S-only material had its T axis
    // wrongly clamped and a clamp-T-only material had neither.
    this.wrapS = lighting.clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    this.wrapT = lighting.clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
```

`lighting` is the decode result from Task 3. Then in `loadTextures`, pass them separately:

```js
        TextureLoader.load(textureDef.path, this.wrapS, this.wrapT)
```

Keep `this.wrapping` as an alias for `this.wrapS` **only if** something outside this file reads it —
grep first. If nothing does, remove it.

- [ ] **Step 3: De-duplicate the `0x48` lighting-class mask**

Task 7's review flagged this: `MOGI.lightingInterior` in `client/src/wow-data-parser/wmo/index.js`
inlines `(this.flags & 0x48) === 0`, duplicating `isLightingInterior` in
`client/src/game/pipeline/wmo/material/laws.ts`. Two copies of a magic mask drift.

`laws.ts` imports nothing and is pure, so importing it from the parser introduces no cycle. Add at the
top of `client/src/wow-data-parser/wmo/index.js`:

```js
import { isLightingInterior } from '../../game/pipeline/wmo/material/laws';
```

and replace the inlined field body:

```js
    lightingInterior: function() {
      return isLightingInterior(this.flags);
    }
```

**If that import turns out not to work from this module** — the parser is plain JS evaluated at module
load and may run in a worker with a different resolution root — do NOT force it. Instead move the mask
to a named constant in the parser with a comment pointing at `laws.ts` as the source of truth, and say
in your report which route you took and why.

- [ ] **Step 4: Delete the dead shaders and the orphaned material class**

Task 4's review flagged a third piece of dead code: `client/src/game/pipeline/wmo/material/WMOMaterialNew.ts`
is unimported and still sets the removed `BATCH_TYPE` define. It is a trap rather than mere clutter —
rewiring it, or copying it as a template, silently reinstates the old lighting law with no compile
error, because `BATCH_TYPE` just becomes an inert unused define. Delete it too, after confirming with
a grep that nothing imports it (including barrel files like `game/world/light/index.ts`, which
re-exports several sibling `*New`/`*Lite` classes — check there specifically).


```bash
git rm client/src/game/pipeline/wmo/material/shader.frag client/src/game/pipeline/wmo/material/shader.vert client/src/game/pipeline/wmo/material/WMOMaterialNew.ts
```

Before committing, grep the whole client for `shader.frag` and `shader.vert` under the WMO material
directory to confirm nothing imports them. `material/index.js` has them as commented-out imports at
the top — remove those comment lines too.

- [ ] **Step 5: Verify**

Run: `cd client && yarn test --watchAll=false` and `npx tsc --noEmit`. Then run the client and check
alpha-keyed WMO geometry — railings, lattices, window frames, foliage on buildings. The cutout
silhouette should be clean, with no newly-chunky or newly-disappeared edges.

**If any alpha-keyed geometry looks visibly worse than before, report it** — that would mean some
material genuinely relied on the 0.3 threshold, and the right answer is a per-blend-mode threshold
rather than restoring a wrap flag as the selector.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/wmo/material/index.js client/src/wow-data-parser/wmo/index.js
git commit -m "fix(wmo): correct the alpha-test threshold and per-axis wrap, drop dead shaders"
```

---

## Execution order

Tasks 7 and 8 were added after the plan was first written, when the project owner ruled that the
defects originally listed as "open questions" get fixed now rather than deferred to a later plan.
They are numbered last but **do not run last**. Dispatch in this order:

**1 → 7 → 2 → 3 → 4 → 5 → 8 → 6**

Task 7 must precede Task 3, which reads the SIDN colour and the interior lighting class it
establishes. Task 8 is cleanup that wants the new law already in place so a regression is
attributable. Task 6 (readouts) stays last so it reports the finished state.

## Two things this plan deliberately does NOT do

**No point lights on WMO surfaces.** The reference commits **zero** point lights to any WMO surface
batch — verified across every surface batch in benilla's abbey capture, where an earlier
"point-lit abbey wall" reading turned out to be a misidentified unit draw. The current WMO shaders
have no point-light term, so this is already correct: the work is to *not add one*. `MOLT` lights
reach M2 doodads only, which is plan 3.

**No touching the dead `shader.frag` / `shader.vert`.** `material/index.js` imports from
`shaders/{vertex,fragment}/main.glsl`; the older `material/shader.frag` and `material/shader.vert`
sit unimported beside them and still contain a third lighting law (the
`light > 0.5 -> 0.5 + (light - 0.5) * 0.65` curve the spec calls out for removal). Deleting them is
tempting and out of scope here — a plan that both rewrites the live shaders and removes their
lookalikes makes the diff harder to review, and if anything regresses you want the old law readable.
Delete them in plan 4, once this law is confirmed in-game.

## Open questions to raise, not guess

The three defects previously listed here — the `interior` derivation, the `alphaTestValue` flag, and
the filtered `def.textures` list — are no longer deferred. The project owner ruled they get fixed in
this plan: they are Tasks 7 and 8.

One genuine unknown remains:

1. **Whether any alpha-keyed WMO material relied on the old `0.3` threshold.** Task 8 removes it as
   unfounded (it keyed off a texture-wrap flag). If cutout geometry visibly worsens, the answer is a
   per-blend-mode threshold, not restoring a wrap flag as the selector. Report rather than revert.

## Outcome

All nine tasks landed (run order 1 → 7 → 2 → 3 → 4 → 5 → 8 → 9 → 6), plus Task 9 added mid-flight and
one fix from the final review. Suite 212/212 across 20 suites, `tsc --noEmit` clean.

**Task 9 was not in the original plan.** It fixed two bugs the human found by looking at an interior:

1. **My plan's TRANS snippet was wrong.** It nested MOCV inside `wmoLitFactor` and then did
   `mix(vec3(1.0), lit, MOCV.a)`, so at `MOCV.a = 0` the lane rendered `tex × 1.0` — no vertex colour
   at all. The reference keeps the light factor MOCV-free and multiplies MOCV *outside* the mix, so it
   applies to both branches. Now `a = 0` → `tex × MOCV`, `a = 1` → `tex × clamp(MOCV × lit + emission)`.
2. **The interior sun fade double-darkened every non-INT interior batch** — `tex × MOCV × ambient`
   with diffuse forced to zero.

**The final whole-branch review caught a bug no task-scoped review could see:** the material cache key
was built from `interior` (culling) while the `INTERIOR` shader define came from `lightingInterior`
(lighting). An interior room and an attached `EXTERIOR_LIT` porch collide on one key, and whichever
loads first imposes its lighting law on the other. Fixed by threading `lightingInterior` onto the
definition and into the key, with a regression test. **The lesson generalises: adding a second notion
of an existing concept means auditing every identity key that gates reuse.**

### Unresolved question, recorded rather than guessed

The UNLIT lane (`lightModifier <= 0.0`) returns the bare texture, dropping MOCV. The final review could
not settle whether the reference does the same: its `is_emissive` branch uses `albedo`, which Bevy
folds with the vertex colour whenever `VERTEX_COLORS` is set, so the reference may retain a MOCV
multiply there. It may also be moot if UNLIT-flagged WMO batches conventionally bake near-white MOCV.
Left as-is; revisit with evidence rather than by preference.

## Handoff to plan 3

- **`MapLight`'s interior sun fade is GONE** — removed in Task 9, overriding this plan's own hard
  constraint, on the project owner's explicit call ("make it how it works in reference"). The accepted
  consequence: **M2 doodads standing indoors read as sunlit** until plan 3 lands their per-instance SH
  probes. Plan 3 must fix that by adding the probes, **not** by re-adding the fade.
- **Two point-light selection strategies are live.** `MapLight.#selectWmoPointLights` ranks by
  `falloff x intensity` from the camera; `world/light/laws.ts`'s `selectPointLights` ranks by plain
  distance from the receiving object. Plan 3 replaces the old call sites rather than adding beside
  them. Note WMO **surfaces** take no point lights at all in the reference — only M2s do — so this is
  purely plan 3's concern.
- **`INTERIOR_LIGHT_AXIS` is inferred, not measured.** Plan 3's first interior check must confirm it.
