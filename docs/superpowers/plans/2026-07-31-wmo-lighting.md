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
    // The colour word is guarded: `def.textures` only contains slots whose texture path RESOLVED
    // (see WMORoot's build loop), so it can be empty, and on a material whose first slot has no
    // path, index 0 is a LATER slot carrying color_2 rather than the SIDN colour. Black is the safe
    // reading -- a material we cannot identify must not glow. See the open questions.
    const sidnWord =
      def.textures.length > 0 ? def.textures[0].textureData.color : { r: 0, g: 0, b: 0, a: 0 };
    // Kept on the instance because Task 5 reads `sidnColor` and `window` off it, and because a
    // material's decoded lighting is worth inspecting from a breakpoint.
    this.lighting = decodeMaterialLighting(def.flags, sidnWord);
    const lighting = this.lighting;

    if (lighting.unlit) {
      this.uniforms.lightModifier.value = 0.0;
    }
```

- [ ] **Step 7: Verify in the running app**

Buildings should now be lit per fragment rather than per vertex — smooth shading across large wall
faces instead of visible triangle banding — and should track the time-of-day slider. Interiors will
still look wrong (the batch classes land in Task 4) and SIDN materials still have no glow (Task 5).
Note what you see.

- [ ] **Step 8: Commit**

```bash
git add client/src/game/pipeline/wmo/material/shaders client/src/game/pipeline/wmo/material/index.js
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

Keep `this.defines.INTERIOR = 1` where it already is set for interior groups.

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

1. **The `interior` derivation disagrees with the spec.** `blizzardry/src/lib/wmo/group.js` computes
   `interior = (flags & 0x2000) !== 0 && (flags & 0x8) === 0`, while the spec calls for
   `(groupFlags & 0x48) === 0` — the reference's rule, using EXTERIOR (`0x8`) and EXTERIOR_LIT
   (`0x40`). They agree on most groups and disagree on groups flagged EXTERIOR_LIT without INTERIOR.
   This plan keeps the existing derivation, because it also drives portal culling and changing it
   reaches well beyond lighting. Raise it if interiors misclassify.
2. **`alphaTestValue` keys off `flags & 0x80`**, which is `F_CLAMP_T` — a texture wrap flag with no
   obvious bearing on an alpha threshold. Not touched here. Flag it if alpha-keyed WMO geometry looks
   wrong.
3. **`def.textures` is a filtered list, not slot-indexed.** `WMORoot` appends only those `MOMT`
   texture slots whose path resolved, so index 0 is not reliably slot 0 — on a material whose first
   slot has no texture, `textures[0].textureData.color` is `color_2`, not `sidnColor`. Task 3 guards
   the empty case and Task 1 forces black on non-SIDN materials, which contains the damage, but the
   real fix is for the loader to preserve slot indices. Out of scope here. Raise it if a SIDN
   material glows the wrong colour.

## Handoff to plan 3

- **`MapLight`'s interior sun fade is still in place** and must come out at the END of plan 3, once
  the M2 interior probes exist.
- **Two point-light selection strategies are live.** `MapLight.#selectWmoPointLights` ranks by
  `falloff x intensity` from the camera; `world/light/laws.ts`'s `selectPointLights` ranks by plain
  distance from the receiving object. Plan 3 replaces the old call sites rather than adding beside
  them. Note WMO **surfaces** take no point lights at all in the reference — only M2s do — so this is
  purely plan 3's concern.
- **`INTERIOR_LIGHT_AXIS` is inferred, not measured.** Plan 3's first interior check must confirm it.
