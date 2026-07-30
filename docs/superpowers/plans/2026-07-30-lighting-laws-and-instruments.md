# Lighting Laws and Instruments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the pure lighting laws ported from `samples/benilla` as a tested, dependency-free
module, plus the debug instruments that every later lighting task is verified with.

**Architecture:** One new pure module (`client/src/game/world/light/laws.ts`) holding the maths — SH
probe fold, MODD colour byte laws, day/night curves, point-light selection. No three.js, no I/O, no
renderer: plain number tuples in and out, so it runs under jest's `node` environment and is pinned by
golden vectors taken from benilla's own tests. Then two small React components in the existing debug
panel that drive time-of-day and weather-facing state and print the resolved light as numbers.

**Tech Stack:** TypeScript, React 19 (class components, matching the existing panel), three.js
(consumers only — never `laws.ts`), jest 29 via `react-scripts` (`yarn test`).

**This is plan 1 of 5.** See "Plan decomposition" below before starting.

## Global Constraints

- **Reference source of truth:** `samples/benilla`. Every constant in `laws.ts` must be traceable to a
  named function or table there. Cite it in a comment.
- **`laws.ts` imports nothing.** No `three`, no project modules. This is what makes it node-testable
  and reusable from a worker later.
- **Colour space:** the client pins `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`
  (`pages/game/index.tsx:93`). All lighting maths operates on authored gamma-space values 0..1. Do not
  add any sRGB conversion.
- **Byte laws are integer laws.** `cap96` and `floor112` must reproduce the reference's integer
  arithmetic exactly, including truncation and round-half-to-even. Float shortcuts are wrong here.
- **Frame convention:** angles and directions use the same WoW-space convention as the existing
  `SUN_PHI_TABLE` / `SUN_THETA_TABLE`, which produce `(sinφ·cosθ, sinφ·sinθ, cosφ)` consumed unpermuted
  against world normals. Any new axis constant follows that convention.
- **Test command:** `yarn test --watchAll=false --testPathPattern="<pattern>"` from `client/`.
- **Commit per task**, conventional-commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`).

---

## Plan decomposition

The spec (`docs/superpowers/specs/2026-07-30-wmo-m2-lighting-design.md`) spans five independently
shippable subsystems. Splitting them keeps each plan's review surface small and each deliverable
verifiable on its own:

| Plan | Spec steps | Deliverable |
|---|---|---|
| **1 (this one)** | 1–2 | Tested pure laws + debug instruments |
| 2 | 3–4 | WMO lighting: plumbing, batch classes, SIDN, WINDOW |
| 3 | 5 | Per-object block, M2 lobe, interior probes, point lights |
| 4 | 6 | Fog unification across M2/WMO/terrain, then MFOG |
| 5 | 7–9 | `LightParams` schema, weather state machine, sky bands |

**On the spec's one hard coupling:** risk 3 says removing the interior sun fade before *both* the WMO
batch classes and the M2 probes exist leaves interiors darker than either behaviour. Plans 2 and 3
would trip that if written naively. Resolution: **plan 2 leaves `MapLight`'s interior sun fade in
place**, and **plan 3 removes it** as its final step, once probes exist. That makes both plans safe to
ship alone and dissolves the coupling. Do not move the fade removal into plan 2.

Nothing in this plan depends on plans 2–5, and all of them depend on this one.

---

## File Structure

**Created:**

- `client/src/game/world/light/laws.ts` — all pure lighting maths. One responsibility: given numbers
  describing a light situation, return numbers describing the result. Grows across plans 2–5 (weather
  ramp, dawn/dusk curve consumers); this plan establishes it and fills in the model-lighting laws.
- `client/src/game/world/light/__tests__/laws.test.ts` — golden-vector tests, `node` environment.
- `client/src/pages/game/debug/lighting-controls.tsx` — the drivers (time scrub; weather lands in plan
  5). Takes `mapLight` as its only prop, so it is testable without a game or renderer.
- `client/src/pages/game/debug/lighting-readouts.tsx` — the numeric probes. Same narrow prop.
- `client/src/pages/game/debug/__tests__/lighting-controls.test.tsx` — jsdom environment.

**Modified:**

- `client/src/game/world/light/index.ts` — re-export the new module.
- `client/src/game/world/light/MapLight.ts` — expose `selectedLights` and `sampledPosition` for the
  readouts; publish `sidnNight`.
- `client/src/game/world/light/SceneLight.ts` — fix the `fogStart` getter (see Task 6).
- `client/src/pages/game/debug/debug.tsx` — render the two new components.

**Why two components rather than one:** drivers change when a new control is added; readouts change
when a new value is resolved. They have different reasons to change, so they are different files. Both
take one narrow prop, which is what makes them unit-testable — `DebugPanel` itself early-returns
without a live `game` and reaches deep into `game.world.player`, so testing through it would mean
stubbing half the world.

---

### Task 1: The order-2 SH probe fold

The closed form of the reference's `Model2.bls` lighting block — one function serving both the interior
prop probes and (in plan 5) the exterior sun rows.

**Files:**
- Create: `client/src/game/world/light/laws.ts`
- Test: `client/src/game/world/light/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RGB = [number, number, number]`
  - `type Vec3 = [number, number, number]`
  - `type Vec4 = [number, number, number, number]`
  - `type Lobe = { dir: Vec3; color: RGB }`
  - `type ProbeCoeffs = Vec4[]` (always length 7)
  - `propProbeCoeffs(ambient: RGB, lobes: Lobe[]): ProbeCoeffs`
  - `evalProbe(coeffs: ProbeCoeffs, normal: Vec3): RGB`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/world/light/__tests__/laws.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { evalProbe, propProbeCoeffs, RGB, Vec3 } from '../laws';

// benilla's golden case: the abbey stand MODD[24]. ambient/diffuse are its decoded colour words, and
// `AXIS` is an arbitrary unit direction -- the fold's identities hold in any frame, because the
// response depends only on mu = n.u. The frame-specific constant lives in INTERIOR_LIGHT_AXIS (Task 4).
const AMBIENT: RGB = [61 / 255, 59 / 255, 96 / 255];
const DIFFUSE: RGB = [90 / 255, 86 / 255, 141 / 255];

const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

const AXIS = normalize([-0.30822, 0.9, -0.30822]);

const expectClose = (got: RGB, want: RGB) => {
  for (let ch = 0; ch < 3; ++ch) {
    expect(got[ch]).toBeCloseTo(want[ch], 5);
  }
};

describe('propProbeCoeffs', () => {
  it('returns exactly ambient + diffuse facing the lobe (mu = 1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    expectClose(evalProbe(c, AXIS), [
      AMBIENT[0] + DIFFUSE[0],
      AMBIENT[1] + DIFFUSE[1],
      AMBIENT[2] + DIFFUSE[2],
    ]);
  });

  it('wraps to ambient + 0.0588 x diffuse facing away (mu = -1)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.25;
    const away: Vec3 = [-AXIS[0], -AXIS[1], -AXIS[2]];
    expectClose(evalProbe(c, away), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('gives ambient + 0.0882 x diffuse side-on (mu = 0)', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const k = (4 / 17) * 0.375;
    // Perpendicular to AXIS by construction: dot([az, 0, -ax], [ax, ay, az]) == 0.
    const side = normalize([AXIS[2], 0, -AXIS[0]]);
    expectClose(evalProbe(c, side), [
      AMBIENT[0] + k * DIFFUSE[0],
      AMBIENT[1] + k * DIFFUSE[1],
      AMBIENT[2] + k * DIFFUSE[2],
    ]);
  });

  it('is flat ambient with no lobes at all', () => {
    const c = propProbeCoeffs(AMBIENT, []);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
    expectClose(evalProbe(c, [1, 0, 0]), AMBIENT);
  });

  it('is additive across lobes', () => {
    const second: Lobe = { dir: [0, 1, 0], color: [0.1, 0.2, 0.3] };
    const both = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }, second]);
    const first = propProbeCoeffs(AMBIENT, [{ dir: AXIS, color: DIFFUSE }]);
    const secondOnly = propProbeCoeffs([0, 0, 0], [second]);
    const a = evalProbe(both, AXIS);
    const b = evalProbe(first, AXIS);
    const c2 = evalProbe(secondOnly, AXIS);
    for (let ch = 0; ch < 3; ++ch) {
      expect(a[ch]).toBeCloseTo(b[ch] + c2[ch], 5);
    }
  });

  it('ignores a zero-length lobe direction rather than emitting NaN', () => {
    const c = propProbeCoeffs(AMBIENT, [{ dir: [0, 0, 0], color: DIFFUSE }]);
    expectClose(evalProbe(c, [0, 1, 0]), AMBIENT);
  });
});
```

Add the `Lobe` import to the import line: `import { evalProbe, Lobe, propProbeCoeffs, RGB, Vec3 } from '../laws';`

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: FAIL — cannot resolve module `../laws`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/game/world/light/laws.ts`:

```ts
/**
 * Pure lighting laws, ported from `samples/benilla` (a from-scratch WoW 1.12.1 client whose lighting
 * is derived from WoW.exe 5875 disassembly and apitrace captures).
 *
 * This module imports NOTHING -- no three.js, no project modules. That is deliberate: it keeps the
 * maths testable under jest's `node` environment and reusable from a worker. Callers convert to and
 * from THREE types at the boundary.
 *
 * Every constant here is traceable to a named function or table in the reference; the citations in
 * comments are the reference's own module paths.
 */

export type RGB = [number, number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** One directional lobe: a toward-light direction (need not be normalized) and its colour. */
export type Lobe = { dir: Vec3; color: RGB };

/**
 * Seven rows of order-2 SH coefficients, laid out to match the shader's evaluation basis:
 *   rows 0-2  per channel: xyz = the linear band, w = the DC term
 *   rows 3-5  per channel: the quadratic band over (n.xy, n.yz, n.z^2, n.xz)
 *   row  6    xyz = the per-channel (n.x^2 - n.y^2) coefficient; w is unused padding
 */
export type ProbeCoeffs = Vec4[];

/** The reference's accumulate scale: 16*pi/17 on the standard real-SH basis reduces to this. */
const K = 4 / 17;

/**
 * Fold ambient plus any number of directional lobes into a 7-row order-2 SH probe.
 *
 * This is the closed form of the shipped `Model2.bls` vertex program's lighting block
 * (benilla `lighting/sh.rs::prop_probe_coeffs`). Per lobe, with colour C and toward-light unit u:
 *
 *   DC     += C * (4/17) * (0.375 + 0.9375 * (ux^2 + uy^2))
 *   linear += C * (8/17) * u
 *   n.xy   += C * (15/17) * ux*uy            (n.yz and n.xz alike)
 *   n.z^2  += C * (7.5/17) * (uz^2 - 0.5 * (ux^2 + uy^2))
 *   x2y2   += C * (7.5/34) * (ux^2 - uy^2)
 *
 * The band ratios are exactly 1 : 2/3 : 1/4 and the linear coefficient exactly 8/17, which together
 * make the response peak at exactly 1.0 * C when mu = n.u = 1. Side-on leaves 0.0882 * C and fully
 * away 0.0588 * C -- an authored soft wrap, deliberately NOT a hard max(N.L, 0).
 */
export function propProbeCoeffs(ambient: RGB, lobes: Lobe[]): ProbeCoeffs {
  const c: ProbeCoeffs = [];
  for (let row = 0; row < 7; ++row) {
    c.push([0, 0, 0, 0]);
  }

  // Ambient rides the DC lane at weight 1.
  for (let ch = 0; ch < 3; ++ch) {
    c[ch][3] = ambient[ch];
  }
  // Mirrors the reference's row-6 w. Unused by the evaluation; kept so a packed row is bit-comparable.
  c[6][3] = 1;

  for (const lobe of lobes) {
    const len = Math.hypot(lobe.dir[0], lobe.dir[1], lobe.dir[2]);
    if (len === 0) {
      continue;
    }
    const ux = lobe.dir[0] / len;
    const uy = lobe.dir[1] / len;
    const uz = lobe.dir[2] / len;

    const horiz = ux * ux + uy * uy;
    const dc = K * (0.375 + 0.9375 * horiz);
    const z2 = 1.875 * K * (uz * uz - 0.5 * horiz);
    const x2y2 = 0.9375 * K * (ux * ux - uy * uy);

    for (let ch = 0; ch < 3; ++ch) {
      const s = lobe.color[ch];

      c[ch][0] += 2 * K * s * ux;
      c[ch][1] += 2 * K * s * uy;
      c[ch][2] += 2 * K * s * uz;
      c[ch][3] += s * dc;

      c[3 + ch][0] += 3.75 * K * s * ux * uy;
      c[3 + ch][1] += 3.75 * K * s * uy * uz;
      c[3 + ch][2] += s * z2;
      c[3 + ch][3] += 3.75 * K * s * ux * uz;

      c[6][ch] += s * x2y2;
    }
  }

  return c;
}

/**
 * Evaluate a probe at a surface normal. This mirrors the shader's basis exactly and exists so the
 * tests and the GLSL cannot drift apart: if you change one, this is the thing that fails.
 *
 * The result is NOT clamped -- the caller clamps the whole light sum, never a term, because the SH
 * response legitimately dips slightly negative around mu = -0.53 and that dip is part of the
 * authored response.
 */
export function evalProbe(coeffs: ProbeCoeffs, normal: Vec3): RGB {
  const [x, y, z] = normal;
  const n1: Vec4 = [x, y, z, 1];
  const quad: Vec4 = [x * y, y * z, z * z, x * z];
  const x2y2 = x * x - y * y;

  const dot4 = (a: Vec4, b: Vec4) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  const out: RGB = [0, 0, 0];
  for (let ch = 0; ch < 3; ++ch) {
    out[ch] = dot4(coeffs[ch], n1) + dot4(coeffs[3 + ch], quad) + coeffs[6][ch] * x2y2;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/world/light/laws.ts client/src/game/world/light/__tests__/laws.test.ts
git commit -m "feat(lighting): port the Model2.bls order-2 SH probe fold"
```

---

### Task 2: MODD colour byte laws

The two integer transforms the reference applies to a MODD colour word at doodad create, producing the
ambient and diffuse words an interior prop's probe is folded from.

**Files:**
- Modify: `client/src/game/world/light/laws.ts`
- Test: `client/src/game/world/light/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: `RGB` from Task 1.
- Produces:
  - `cap96(bytes: Vec3): RGB` — bytes 0..255 in, normalized 0..1 out
  - `floor112(bytes: Vec3): RGB`
  - `floor168(bytes: Vec3): RGB`

- [ ] **Step 1: Write the failing test**

Append to `client/src/game/world/light/__tests__/laws.test.ts`, and add `cap96, floor112, floor168` to
the import:

```ts
describe('MODD colour byte laws', () => {
  // Compare in bytes, which is how the reference's own golden values are recorded.
  const asBytes = (c: RGB) => c.map((v) => Math.round(v * 255));

  it('caps the ambient word at value 96, hue preserved', () => {
    expect(asBytes(cap96([78, 76, 134]))).toEqual([56, 55, 96]);
    expect(asBytes(cap96([90, 86, 141]))).toEqual([61, 59, 96]);
  });

  it('passes an ambient word whose max is already <= 96 straight through', () => {
    expect(asBytes(cap96([96, 40, 20]))).toEqual([96, 40, 20]);
  });

  it('rounds the cap scale half-to-even, not half-up', () => {
    // max = 160 makes 96*255/160 - 0.5 land exactly on 152.5 -- the one tie in the whole byte domain.
    // Round-half-to-even gives scale 152, so the max channel recombines to (160*152 + 255) >> 8 = 95.
    // Math.round would give 153 and a max of 96. Note the cap therefore does NOT always land the max
    // exactly on 96; the reference's own rounding is what decides, and here it lands a byte under.
    expect(asBytes(cap96([160, 160, 160]))).toEqual([95, 95, 95]);
    expect(asBytes(cap96([160, 80, 40]))).toEqual([95, 48, 24]);
  });

  it('raises a diffuse word below 112 by a truncating scale', () => {
    expect(asBytes(floor112([56, 28, 14]))).toEqual([112, 56, 28]);
  });

  it('passes a diffuse word at or above 112 through untouched', () => {
    expect(asBytes(floor112([78, 76, 134]))).toEqual([78, 76, 134]);
    expect(asBytes(floor112([90, 86, 141]))).toEqual([90, 86, 141]);
  });

  it('leaves black black rather than dividing by zero', () => {
    expect(asBytes(floor112([0, 0, 0]))).toEqual([0, 0, 0]);
  });

  it('truncates the entity threshold at 168 the same way', () => {
    // The reference's decoded abbey benches: truncation gives 127 where nearest would give 128.
    expect(asBytes(floor168([59, 65, 92]))).toEqual([107, 118, 168]);
    expect(asBytes(floor168([69, 63, 83]))).toEqual([139, 127, 168]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: FAIL — `cap96 is not a function` (and the same for the others).

- [ ] **Step 3: Write minimal implementation**

Append to `client/src/game/world/light/laws.ts`:

```ts
/**
 * Round half to even ("banker's rounding"), which is what Rust's `round_ties_even` and the
 * reference's float-to-int conversion do. JS `Math.round` rounds halves UP, and the two disagree on
 * exactly one input that matters here: a MODD colour whose max channel is 160 makes the cap scale
 * land on 152.5, where this gives 152 and `Math.round` gives 153.
 */
function roundTiesEven(value: number): number {
  const rounded = Math.round(value);
  const isTie = Math.abs(value % 1) === 0.5;
  return isTie && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

/**
 * The AMBIENT-word cap of the reference's colour splitter (benilla `benilla-assets/src/wmo.rs::cap96`,
 * from `0x6a77e0`): a colour whose max channel exceeds 96 is scaled down so the max lands on 96, hue
 * and saturation preserved. Input is 0..255 bytes; output is normalized 0..1.
 *
 * The arithmetic is integer on purpose -- an 8.8 fixed-point scale and a `>> 8` recombine. Doing it in
 * floats drifts by a byte on some inputs.
 */
export function cap96(bytes: Vec3): RGB {
  const max = Math.max(bytes[0], bytes[1], bytes[2]);
  if (max <= 96) {
    return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
  }
  const scale = roundTiesEven((96 * 255) / max - 0.5);
  return [
    ((bytes[0] * scale + 255) >> 8) / 255,
    ((bytes[1] * scale + 255) >> 8) / 255,
    ((bytes[2] * scale + 255) >> 8) / 255,
  ];
}

/**
 * The DIFFUSE-word FLOOR of the same splitter (benilla `wmo.rs::floor_raise`): a colour whose max
 * channel falls BELOW `threshold` is raised so the max lands exactly on it, hue preserved -- and the
 * per-channel scale TRUNCATES.
 *
 * Truncation is load-bearing, not incidental: the reference's decoded abbey benches need
 * 63 * 168 / 83 = 127.52 to land on 127, which truncation gives and nearest-rounding does not.
 */
function floorRaise(bytes: Vec3, threshold: number): RGB {
  const max = Math.max(bytes[0], bytes[1], bytes[2]);
  if (max >= threshold || max === 0) {
    return [bytes[0] / 255, bytes[1] / 255, bytes[2] / 255];
  }
  return [
    Math.floor((bytes[0] * threshold) / max) / 255,
    Math.floor((bytes[1] * threshold) / max) / 255,
    Math.floor((bytes[2] * threshold) / max) / 255,
  ];
}

/** [`floorRaise`] at the MODD create site's threshold 112 -- the interior-prop diffuse word. */
export function floor112(bytes: Vec3): RGB {
  return floorRaise(bytes, 112);
}

/**
 * [`floorRaise`] at the entity/footprint attach site's threshold 168 -- the GameObject M2 lane.
 * Unused by this plan; ported alongside its twin because they are one law with two thresholds and
 * splitting them across plans would invite a divergent second implementation.
 */
export function floor168(bytes: Vec3): RGB {
  return floorRaise(bytes, 168);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/world/light/laws.ts client/src/game/world/light/__tests__/laws.test.ts
git commit -m "feat(lighting): port the MODD colour cap96/floor112 byte laws"
```

---

### Task 3: Day/night curves

The wrap-around table interpolator and the four scalar curves that ride it.

**Files:**
- Modify: `client/src/game/world/light/laws.ts`
- Test: `client/src/game/world/light/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interpDayNight(table: Array<[number, number]>, dayFraction: number): number`
  - `sidnNightFraction(minute: number): number`
  - `dawnDuskCurve(minute: number): number`
  - `skyWarp(minute: number, highlightSky: number): number`
  - `quantizeGlow(glow: number): number`
  - `stormBlend(skyDensity: number): number`

**Note on duplication:** `utils.ts` already exports `interpolateNumericTable`, which also wraps. It is
deliberately not reused. Three reasons: `laws.ts` must import nothing; the wrap semantics here are
pinned to the reference by test; and the shared util currently drives sun direction, which works — so
changing it to satisfy a new caller risks a regression in something already correct. The table shape
differs too (pairs here, flat array there).

- [ ] **Step 1: Write the failing test**

Append to the test file, adding `dawnDuskCurve, interpDayNight, quantizeGlow, sidnNightFraction, skyWarp, stormBlend`
to the import:

```ts
describe('interpDayNight', () => {
  it('lerps between adjacent keyframes', () => {
    const table: Array<[number, number]> = [
      [0.0, 0.0],
      [0.5, 10.0],
    ];
    expect(interpDayNight(table, 0.25)).toBeCloseTo(5.0, 5);
  });

  it('wraps around the end of the day', () => {
    // Between the 0.75 key and the 0.25 key going forwards through midnight: 0.0 is halfway.
    const table: Array<[number, number]> = [
      [0.25, 0.0],
      [0.75, 4.0],
    ];
    expect(interpDayNight(table, 0.0)).toBeCloseTo(2.0, 5);
  });

  it('reproduces the sun elevation table at its keyframes', () => {
    const phi: Array<[number, number]> = [
      [0.0, 2.2165682],
      [0.25, 1.9198623],
      [0.5, 2.2165682],
      [0.75, 1.9198623],
    ];
    expect(interpDayNight(phi, 0.0)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.25)).toBeCloseTo(1.9198623, 5);
    expect(interpDayNight(phi, 0.5)).toBeCloseTo(2.2165682, 5);
    expect(interpDayNight(phi, 0.125)).toBeCloseTo(2.0682153, 4);
  });
});

describe('sidnNightFraction', () => {
  const at = (hour: number, minute: number) => sidnNightFraction(hour * 60 + minute);

  it('is full overnight', () => {
    expect(at(0, 0)).toBeCloseTo(1.0, 5);
    expect(at(6, 0)).toBeCloseTo(1.0, 5);
    expect(at(23, 0)).toBeCloseTo(1.0, 5);
  });

  it('ramps out over 06:00 to 07:00', () => {
    expect(at(6, 30)).toBeCloseTo(0.5, 5);
    expect(at(7, 0)).toBeCloseTo(0.0, 5);
  });

  it('is off all day', () => {
    expect(at(12, 0)).toBeCloseTo(0.0, 5);
    expect(at(20, 30)).toBeCloseTo(0.0, 5);
  });

  it('ramps in over 20:30 to 21:30', () => {
    expect(at(21, 0)).toBeCloseTo(0.5, 5);
    expect(at(21, 30)).toBeCloseTo(1.0, 4);
  });
});

describe('dawnDuskCurve and skyWarp', () => {
  it('is zero across midday and deep night', () => {
    expect(dawnDuskCurve(720)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(0)).toBeCloseTo(0.0, 5);
    expect(dawnDuskCurve(1080)).toBeCloseTo(0.0, 5);
  });

  it('spikes to ~1 at dawn and dusk', () => {
    expect(dawnDuskCurve(390)).toBeGreaterThan(0.99);
    expect(dawnDuskCurve(1290)).toBeGreaterThan(0.99);
  });

  it('is partway up the dawn ramp at 06:00', () => {
    const mid = dawnDuskCurve(360);
    expect(mid).toBeGreaterThan(0.0);
    expect(mid).toBeLessThan(1.0);
  });

  it('is identically zero in a highlightSky = 0 zone at every hour', () => {
    for (let minute = 0; minute < 1440; minute += 15) {
      expect(skyWarp(minute, 0)).toBe(0);
    }
  });

  it('passes the curve through at highlightSky = 1', () => {
    expect(skyWarp(390, 1)).toBeCloseTo(dawnDuskCurve(390), 5);
  });
});

describe('quantizeGlow and stormBlend', () => {
  it('quantizes glow to the byte the reference packs', () => {
    expect(quantizeGlow(0.65)).toBeCloseTo(0.647, 3);
    expect(quantizeGlow(1.0)).toBeCloseTo(1.0, 5);
    expect(quantizeGlow(0.0)).toBe(0);
  });

  it('saturates the storm blend at a quarter sky density', () => {
    expect(stormBlend(0)).toBe(0);
    expect(stormBlend(0.125)).toBeCloseTo(0.5, 5);
    expect(stormBlend(0.25)).toBeCloseTo(1.0, 5);
    // Clamped, so an out-of-domain density cannot overdrive the lerp.
    expect(stormBlend(1.0)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: FAIL — `interpDayNight is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `client/src/game/world/light/laws.ts`:

```ts
/**
 * Vanilla `DayNight::InterpTable` -- wrap-around linear interpolation of a (dayFraction, value) table
 * over [0, 1) (benilla `lighting/daynight.rs::interp_daynight`). Both of the client's return branches
 * reduce to a plain lerp, so this is one.
 *
 * Wrapping matters: several of these tables have their first keyframe well after midnight, and the
 * value at 00:30 comes from interpolating the LAST key forward into the first.
 */
export function interpDayNight(table: Array<[number, number]>, dayFraction: number): number {
  const n = table.length;
  if (n === 0) {
    return 0;
  }

  let ahead = 0;
  while (ahead < n && dayFraction > table[ahead][0]) {
    ahead += 1;
  }

  // Off either end of the table means we are in the wrap span between its last and first keys.
  let a: number;
  let b: number;
  if (ahead === n || ahead === 0) {
    a = ahead === n ? 0 : ahead;
    b = n - 1;
  } else {
    a = ahead;
    b = ahead - 1;
  }

  let span = table[a][0] - table[b][0];
  if (span < 0) {
    span += 1;
  }
  let into = dayFraction - table[b][0];
  if (into < 0) {
    into += 1;
  }

  const t = span !== 0 ? into / span : 0;
  return table[b][1] + t * (table[a][1] - table[b][1]);
}

/**
 * The SIDN self-illumination night schedule (benilla `daynight.rs::SIDN_NIGHT_CURVE`, track
 * `0xce9a34`): 1.0 overnight, 0.0 all day, linear ramps 20:30 -> 21:30 and 06:00 -> 07:00. Every WMO
 * SIDN material's authored emissive colour is multiplied by this, which is the windows-glow-at-night
 * ramp.
 */
const SIDN_NIGHT_CURVE: Array<[number, number]> = [
  [0.25, 1.0], // 06:00 -- still full night glow
  [0.2916667, 0.0], // 07:00 -- faded out for the day
  [0.8541667, 0.0], // 20:30 -- starts ramping in
  [0.8958333, 1.0], // 21:30 -- full glow (wraps forward to 06:00 holding 1.0)
];

/** The SIDN night fraction at a game minute-of-day (0..1439). See [`SIDN_NIGHT_CURVE`]. */
export function sidnNightFraction(minute: number): number {
  return interpDayNight(SIDN_NIGHT_CURVE, minute / 1440);
}

/**
 * The dawn/dusk sky-dome warp strength curve (benilla `daynight.rs::SKY_WARP_CURVE`, table
 * `0xce9b2c`): two triangular spikes at sunrise (~06:29) and sunset (~21:29), and zero everywhere
 * else -- all of midday AND deep night.
 */
const SKY_WARP_CURVE: Array<[number, number]> = [
  [0.125, 0.0], // 03:00
  [0.2708, 1.0], // 06:29 -- dawn spike
  [0.2917, 0.0], // 07:00
  [0.8542, 0.0], // 20:30
  [0.8958, 1.0], // 21:29 -- dusk spike
  [0.9993, 0.0], // 23:59
];

/** The raw dawn/dusk warp curve at a game minute-of-day. See [`SKY_WARP_CURVE`]. */
export function dawnDuskCurve(minute: number): number {
  return interpDayNight(SKY_WARP_CURVE, minute / 1440);
}

/**
 * Sky-dome warp strength `S` = curve x the zone's `highlightSky` flag. Zero across midday and night,
 * and zero at EVERY hour in a highlightSky = 0 zone (Duskwood), so the warp is identity there. At
 * S = 0 the daytime sky stays byte-faithful.
 */
export function skyWarp(minute: number, highlightSky: number): number {
  return dawnDuskCurve(minute) * highlightSky;
}

/**
 * Quantize a raw `LightParams.glow` to the byte the reference packs into its composite-quad colour:
 * `floor(g * 255) / 255`. Elwynn's authored 0.65 becomes 0.647.
 */
export function quantizeGlow(glow: number): number {
  return Math.floor(glow * 255) / 255;
}

/**
 * The storm light blend `bcc = min(1, skyDensity * 4)` (benilla `weather`/`cloud_density_clamp
 * 0x6d4500`). The weather state machine's sky-density channel lives in the [0, 0.25] knee domain, so
 * a fully ramped storm gives exactly 1.0. This weight lerps the storm `LightParams` record over the
 * clear one across every band at once -- ambient, diffuse, sky stops, fog colour AND fog distances.
 */
export function stormBlend(skyDensity: number): number {
  return Math.min(1, Math.max(0, skyDensity * 4));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: PASS, 27 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/world/light/laws.ts client/src/game/world/light/__tests__/laws.test.ts
git commit -m "feat(lighting): port the day/night curves and the storm blend"
```

---

### Task 4: Interior probe fold and point-light selection

The two composite laws that combine Tasks 1–2 into what a caller actually needs.

**Files:**
- Modify: `client/src/game/world/light/laws.ts`
- Modify: `client/src/game/world/light/index.ts`
- Test: `client/src/game/world/light/__tests__/laws.test.ts`

**Interfaces:**
- Consumes: `propProbeCoeffs`, `evalProbe`, `RGB`, `Vec3`, `ProbeCoeffs`, `Lobe` from Task 1.
- Produces:
  - `INTERIOR_LIGHT_AXIS: Vec3`
  - `type PropLobeLight = { position: Vec3; color: RGB; attenStart: number; attenEnd: number }`
  - `foldInteriorProbe(ambient: RGB, diffuse: RGB, refPoint: Vec3, lights: PropLobeLight[], axis?: Vec3): ProbeCoeffs`
  - `selectPointLights<T extends { position: Vec3; attenEnd: number }>(anchor: Vec3, lights: T[], max?: number): T[]`

- [ ] **Step 1: Write the failing test**

Append to the test file, adding `foldInteriorProbe, INTERIOR_LIGHT_AXIS, PropLobeLight, selectPointLights`
to the import:

```ts
describe('foldInteriorProbe', () => {
  const AMB: RGB = [0.2, 0.2, 0.2];
  const DIF: RGB = [0.4, 0.4, 0.4];

  it('commits the diffuse word on the fixed axis, not the sun', () => {
    const c = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Facing the fixed axis returns ambient + diffuse exactly.
    expectClose(evalProbe(c, normalize(INTERIOR_LIGHT_AXIS)), [0.6, 0.6, 0.6]);
  });

  it('adds a MOLR lobe at full gain inside attenStart', () => {
    const light: PropLobeLight = {
      position: [0, 0, 10],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Facing the light, the red channel gains the full lobe peak.
    const toLight: Vec3 = [0, 0, 1];
    expect(evalProbe(withLight, toLight)[0] - evalProbe(without, toLight)[0]).toBeCloseTo(0.5, 5);
  });

  it('excludes a MOLR lobe at or beyond attenEnd', () => {
    const light: PropLobeLight = {
      position: [0, 0, 40],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    expect(evalProbe(withLight, [0, 0, 1])).toEqual(evalProbe(without, [0, 0, 1]));
  });

  it('ramps a MOLR lobe linearly between attenStart and attenEnd', () => {
    const light: PropLobeLight = {
      position: [0, 0, 30],
      color: [0.5, 0, 0],
      attenStart: 20,
      attenEnd: 40,
    };
    const withLight = foldInteriorProbe(AMB, DIF, [0, 0, 0], [light]);
    const without = foldInteriorProbe(AMB, DIF, [0, 0, 0], []);
    // Halfway through the window -> half gain.
    const gained = evalProbe(withLight, [0, 0, 1])[0] - evalProbe(without, [0, 0, 1])[0];
    expect(gained).toBeCloseTo(0.25, 5);
  });

  it('overrides the axis when one is supplied', () => {
    // Plan 3 verifies INTERIOR_LIGHT_AXIS in a real interior. The parameter is how a correction lands
    // in one place, so it needs to actually be honoured.
    const axis: Vec3 = [0, 0, 1];
    const c = foldInteriorProbe(AMB, DIF, [0, 0, 0], [], axis);
    expectClose(evalProbe(c, axis), [0.6, 0.6, 0.6]);
  });
});

describe('selectPointLights', () => {
  const light = (x: number, attenEnd = 100) => ({ position: [x, 0, 0] as Vec3, attenEnd });

  it('keeps the three nearest to the anchor', () => {
    const lights = [light(50), light(10), light(30), light(20), light(40)];
    const picked = selectPointLights([0, 0, 0], lights);
    expect(picked.map((l) => l.position[0])).toEqual([10, 20, 30]);
  });

  it('ranks by distance from the anchor, not from the origin', () => {
    const lights = [light(0), light(100)];
    const picked = selectPointLights([90, 0, 0], lights);
    expect(picked[0].position[0]).toBe(100);
  });

  it('excludes a candidate whose own range does not reach the anchor', () => {
    const lights = [light(10, 5), light(30)];
    const picked = selectPointLights([0, 0, 0], lights);
    expect(picked.map((l) => l.position[0])).toEqual([30]);
  });

  it('returns everything when fewer than the cap are in range', () => {
    expect(selectPointLights([0, 0, 0], [light(10)])).toHaveLength(1);
    expect(selectPointLights([0, 0, 0], [])).toHaveLength(0);
  });

  it('honours an explicit cap', () => {
    const lights = [light(10), light(20), light(30)];
    expect(selectPointLights([0, 0, 0], lights, 2)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: FAIL — `foldInteriorProbe is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `client/src/game/world/light/laws.ts`:

```ts
/**
 * The FIXED engine axis an interior prop's diffuse word is committed on -- never the day/night sun,
 * which is why an interior prop's light is day/night independent (benilla
 * `benilla-assets/src/wmo.rs`, the `0x6a77e0` create site).
 *
 * Expressed toward-light in the same WoW-space convention `SUN_PHI_TABLE` / `SUN_THETA_TABLE` produce
 * and the shaders consume unpermuted. VERIFY THIS IN A REAL INTERIOR before trusting it: the client's
 * world frame versus the WoW frame is only implicitly documented (`MapLight` permutes axes for light
 * positions but not for sun direction), so this constant is inferred from the sun's working
 * convention rather than measured. `foldInteriorProbe` takes the axis as an argument so a correction
 * here never touches the fold.
 */
export const INTERIOR_LIGHT_AXIS: Vec3 = [0.30822, 0.30822, 0.9];

/** One MOLR-referenced omni light as the interior fold consumes it. Colour is pre-multiplied by intensity. */
export type PropLobeLight = {
  position: Vec3;
  color: RGB;
  attenStart: number;
  attenEnd: number;
};

/**
 * Fold one interior prop's committed light into its 7-row SH probe: the ambient word, plus the
 * diffuse word as a directional on the fixed axis, plus each MOLR lobe gated by its own disk window
 * measured from `refPoint` (benilla `terrain_stream.rs::fold_interior_probe`, falloff `0x69e1c0`).
 *
 * The gate is: at or inside `attenStart` full gain; at or beyond `attenEnd` excluded entirely;
 * linear in between. A group with no MOLR lights means NO point light at all -- its own flame
 * included.
 *
 * Deliberately takes no time-of-day argument. An interior prop's light is filled once at create and
 * does not track the clock.
 */
export function foldInteriorProbe(
  ambient: RGB,
  diffuse: RGB,
  refPoint: Vec3,
  lights: PropLobeLight[],
  axis: Vec3 = INTERIOR_LIGHT_AXIS,
): ProbeCoeffs {
  const lobes: Lobe[] = [{ dir: axis, color: diffuse }];

  for (const light of lights) {
    const dx = light.position[0] - refPoint[0];
    const dy = light.position[1] - refPoint[1];
    const dz = light.position[2] - refPoint[2];
    const distance = Math.hypot(dx, dy, dz);

    let gain: number;
    if (distance <= light.attenStart) {
      gain = 1;
    } else if (distance >= light.attenEnd || light.attenEnd <= light.attenStart) {
      gain = 0;
    } else {
      gain = 1 - (distance - light.attenStart) / (light.attenEnd - light.attenStart);
    }
    if (gain <= 0) {
      continue;
    }

    const safe = Math.max(distance, 1e-4);
    lobes.push({
      dir: [dx / safe, dy / safe, dz / safe],
      color: [light.color[0] * gain, light.color[1] * gain, light.color[2] * gain],
    });
  }

  return propProbeCoeffs(ambient, lobes);
}

/**
 * Pick the point lights a receiver actually gets: the NEAREST few to the receiving object's own
 * position (benilla `wow_model.wgsl::point_light_sum`, gather `0x71bf90`). The reference commits at
 * most three and drops the fourth.
 *
 * Two things about this are easy to get wrong:
 *  - The anchor is the RECEIVING OBJECT's position -- never the camera, never the vertex. Selecting
 *    against the camera lights fixtures from sideways lamps the real client never commits.
 *  - Ranking is by plain distance, NOT by estimated contribution. A light's own range bounds
 *    candidacy, but once selected it reaches the whole object with no distance cutoff, so selection
 *    pops at object granularity -- which is the authored behaviour, not an artifact.
 */
export function selectPointLights<T extends { position: Vec3; attenEnd: number }>(
  anchor: Vec3,
  lights: T[],
  max = 3,
): T[] {
  const candidates: Array<{ light: T; d2: number }> = [];

  for (const light of lights) {
    const dx = light.position[0] - anchor[0];
    const dy = light.position[1] - anchor[1];
    const dz = light.position[2] - anchor[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > light.attenEnd * light.attenEnd) {
      continue;
    }
    candidates.push({ light, d2 });
  }

  candidates.sort((first, second) => first.d2 - second.d2);
  return candidates.slice(0, max).map((entry) => entry.light);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: PASS, 37 tests.

- [ ] **Step 5: Re-export from the light module barrel**

In `client/src/game/world/light/index.ts`, add after the existing `blendLights` export:

```ts
// Pure lighting laws ported from samples/benilla. Dependency-free by design -- see laws.ts.
export {
  cap96,
  dawnDuskCurve,
  evalProbe,
  floor112,
  floor168,
  foldInteriorProbe,
  INTERIOR_LIGHT_AXIS,
  interpDayNight,
  propProbeCoeffs,
  quantizeGlow,
  selectPointLights,
  sidnNightFraction,
  skyWarp,
  stormBlend,
} from './laws';

export type { Lobe, ProbeCoeffs, PropLobeLight, RGB, Vec3, Vec4 } from './laws';
```

- [ ] **Step 6: Run the whole light test suite**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light"`
Expected: PASS. No other suite touches these files, so nothing else should change.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/world/light/laws.ts client/src/game/world/light/__tests__/laws.test.ts client/src/game/world/light/index.ts
git commit -m "feat(lighting): port the interior probe fold and point-light selection"
```

---

### Task 5: Debug panel — time-of-day driver

`MapLight.timeOverride` already exists and nothing can reach it. This exposes it, which is what makes
every later visual check possible without waiting on a server clock.

**Files:**
- Create: `client/src/pages/game/debug/lighting-controls.tsx`
- Create: `client/src/pages/game/debug/__tests__/lighting-controls.test.tsx`
- Modify: `client/src/pages/game/debug/debug.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1–4.
- Produces: `LightingControls` — a default-exported React class component taking
  `{ mapLight: LightingControlsTarget | null }`, where
  `type LightingControlsTarget = { time: number; timeOverride: number | null }`. Task 6 mirrors this
  narrow-prop shape.

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/game/debug/__tests__/lighting-controls.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import LightingControls from '../lighting-controls';

// A stand-in for MapLight carrying only what the control touches. Using the real MapLight here would
// drag in three.js, the DBC loader and a network fetch for a slider.
const makeMapLight = (overrides: Partial<{ time: number; timeOverride: number | null }> = {}) => ({
  time: 1440,
  timeOverride: null as number | null,
  ...overrides,
});

describe('LightingControls', () => {
  it('renders nothing without a map light', () => {
    const { container } = render(<LightingControls mapLight={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current time as hours and minutes', () => {
    // 1440 half-minutes = minute 720 = 12:00.
    render(<LightingControls mapLight={makeMapLight({ time: 1440 })} />);
    expect(screen.getByText(/12:00/)).toBeInTheDocument();
  });

  it('follows the clock until the override checkbox is cleared', () => {
    const mapLight = makeMapLight();
    render(<LightingControls mapLight={mapLight} />);
    const follow = screen.getByLabelText(/follow clock/i) as HTMLInputElement;
    expect(follow.checked).toBe(true);

    fireEvent.click(follow);
    // Taking manual control seeds the override from the time currently displayed, so the light does
    // not jump the instant the box is unticked.
    expect(mapLight.timeOverride).toBe(1440);
  });

  it('writes the slider position into timeOverride in half-minutes', () => {
    const mapLight = makeMapLight({ timeOverride: 1440 });
    render(<LightingControls mapLight={mapLight} />);
    // The slider is in MINUTES; MapLight wants half-minutes.
    fireEvent.change(screen.getByLabelText(/time of day/i), { target: { value: '390' } });
    expect(mapLight.timeOverride).toBe(780);
  });

  it('returns to the clock when the checkbox is re-ticked', () => {
    const mapLight = makeMapLight({ timeOverride: 780 });
    render(<LightingControls mapLight={mapLight} />);
    fireEvent.click(screen.getByLabelText(/follow clock/i));
    expect(mapLight.timeOverride).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="lighting-controls"`
Expected: FAIL — cannot resolve `../lighting-controls`.

- [ ] **Step 3: Write minimal implementation**

Create `client/src/pages/game/debug/lighting-controls.tsx`:

```tsx
import React from 'react';

/**
 * The slice of MapLight this control drives. Narrow on purpose: it keeps the component testable
 * without a renderer, a DBC load or a network fetch, and it documents exactly what the panel is
 * allowed to touch.
 */
export type LightingControlsTarget = {
  /** Time in HALF-minutes since midnight, 0..2879. */
  time: number;
  /** Manual override in half-minutes, or null to follow the clock. */
  timeOverride: number | null;
};

type Props = {
  mapLight: LightingControlsTarget | null;
};

/** Half-minutes since midnight to a 24-hour clock string. */
const formatGameTime = (halfMinutes: number) => {
  const minute = Math.floor(halfMinutes / 2);
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/**
 * Time-of-day driver for lighting work.
 *
 * The shader-side lighting laws are not unit-testable, so they are verified by eye -- which means
 * being able to sit at 21:30 and watch windows come up, rather than waiting for a server clock to
 * get there. `MapLight.timeOverride` has existed all along with nothing able to reach it.
 *
 * The parent panel force-updates every frame, so this reads MapLight directly as the source of truth
 * instead of mirroring it into component state, which would drift.
 */
class LightingControls extends React.Component<Props> {
  private toggleFollowClock = () => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    // Seed the override from whatever is on screen, so taking manual control does not jump the light.
    mapLight.timeOverride = mapLight.timeOverride === null ? mapLight.time : null;
  };

  private scrubTime = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { mapLight } = this.props;
    if (!mapLight) {
      return;
    }
    mapLight.timeOverride = Number(event.target.value) * 2;
  };

  render() {
    const { mapLight } = this.props;
    if (!mapLight) {
      return null;
    }

    const following = mapLight.timeOverride === null;
    const halfMinutes = following ? mapLight.time : mapLight.timeOverride!;

    return (
      <div className="lightingControls">
        <h2>Lighting</h2>
        <div className="divider"></div>
        <p>
          <label htmlFor="lighting-follow-clock">Follow clock</label>
          <input
            id="lighting-follow-clock"
            type="checkbox"
            checked={following}
            onChange={this.toggleFollowClock}
          />
        </p>
        <p>Time: {formatGameTime(halfMinutes)}</p>
        <p>
          <label htmlFor="lighting-time-of-day">Time of day</label>
          <input
            id="lighting-time-of-day"
            type="range"
            min={0}
            max={1439}
            step={1}
            value={Math.floor(halfMinutes / 2)}
            disabled={following}
            onChange={this.scrubTime}
          />
        </p>
      </div>
    );
  }
}

export default LightingControls;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="lighting-controls"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Render it from the debug panel**

In `client/src/pages/game/debug/debug.tsx`, add the import beside the existing ones:

```tsx
import LightingControls from './lighting-controls';
```

Then in `render()`, replace this block:

```tsx
        <h2>Player</h2>
        { this.playerStats() }
```

with:

```tsx
        <h2>Player</h2>
        { this.playerStats() }
        <LightingControls mapLight={ this.props.game.world.map ? this.props.game.world.map.mapLight : null } />
```

- [ ] **Step 6: Verify in the running app**

Run the client, open the debug panel, untick "Follow clock" and scrub the slider. The time readout must
track the slider. Nothing else should change yet — no lighting law consumes the panel until plan 2, so
the *scene* need not visibly respond. Confirm no console errors and no dropped frames while dragging.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/game/debug/lighting-controls.tsx client/src/pages/game/debug/__tests__/lighting-controls.test.tsx client/src/pages/game/debug/debug.tsx
git commit -m "feat(debug): expose the map light's time-of-day override"
```

---

### Task 6: Debug panel — resolved-light readouts

The numeric probe. benilla drives this through `WOW_LIGHT_DUMP`; here it is on screen.

Its comment on why the map id and sampled position lead the line is worth heeding: those two inputs
decide everything after them, neither is visible from the chair, and without the map printed *"is this
the atmosphere the zone authored, or the one next door?"* costs a session.

**This deliberately implements a subset of the spec's readout list** — every value that exists today.
The rest arrives with the plan that produces it, and each one is a line in this component: storm `bcc`
and sky warp `S` with plan 5; resolved sun intensity and the per-object point-light detail with plan 3;
the interior fog triple and ramp `t` with plan 4; the claimed WMO, group and batch-class counts with
plan 2. Do not stub them here — a readout wired to a value nothing computes prints a confident zero,
which is worse than its absence.

**Files:**
- Create: `client/src/pages/game/debug/lighting-readouts.tsx`
- Modify: `client/src/game/world/light/MapLight.ts`
- Modify: `client/src/game/world/light/SceneLight.ts`
- Modify: `client/src/pages/game/debug/debug.tsx`
- Test: `client/src/game/world/light/__tests__/laws.test.ts` (the `fogStart` fix)
- Test: `client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx`

**Interfaces:**
- Consumes: `sidnNightFraction` from Task 3.
- Produces: `LightingReadouts` — default-exported React class component taking
  `{ mapLight: LightingReadoutsTarget | null }`, plus the exported `LightingReadoutsTarget` type.
  New on `MapLight`: `get selectedLights(): WeightedAreaLight[]`, `get sampledPosition(): THREE.Vector3 | null`,
  `get sidnNight(): number`.

**Typing decision (overrides an earlier draft of this plan):** `LightingReadoutsTarget` is a narrow
structural type, matching `LightingControlsTarget` in Task 5. It describes colours and vectors by shape
(`{ r, g, b }`, `{ x, y, z }`) rather than importing THREE types, which keeps the component free of
three.js and testable with plain objects. Plans 2–5 extend the type as they add resolved values.

- [ ] **Step 1: Write the failing test for the fog-range bugs**

**Corrected during execution — `fogEnd` is broken too, and this step originally missed it.**
`blendLights` packs `fogParams` as a (slope, intercept) pair for the shader's `f1 = d*x + y`, NOT as
(step, end):

```
x = -1 / (end - start)
y =  end / (end - start)
```

which gives `f1 = 1` at `d = start` and `0` at `d = end`. Two getters try to read `start` and `end`
back out of that pair, and both do it wrongly:

- `fogEnd` returns `y` raw, i.e. `end / (end - start)` — for a 125..500 band, `1.333` instead of `500`.
- `fogStart` computes `fogEnd - 1/x`, which evaluates to `2*end - start` instead of `start`.

Recovery is `fogEnd = -y/x` and `fogStart = fogEnd + 1/x`. Both are fixed in Step 3.

This is safe to change: the only readers of either getter are `getFogParams()` in
`M2LightIntegration` and `WMOLightIntegration`, and **`getFogParams` has no callers anywhere in the
client** — verified before authorising the wider edit. The fix cannot alter rendering; it only makes
the getters return what their names claim.

Append to `client/src/game/world/light/__tests__/laws.test.ts` — a new suite at the end. Note this one
needs the jsdom-free node env the file already declares, and `SceneLight` imports three.js, which
loads fine under node:

```ts
describe('SceneLight fog range', () => {
  // Pack exactly as blendLights does: the shader's (slope, intercept) pair, not (step, end).
  const packed = async (start: number, end: number) => {
    const SceneLight = (await import('../SceneLight')).default;
    const scene = new SceneLight();
    const step = 1 / (end - start);
    scene.fogParams.set(-step, end * step, 1, 1);
    return scene;
  };

  it('recovers the fog range that blendLights packed', async () => {
    const scene = await packed(125, 500);
    expect(scene.fogEnd).toBeCloseTo(500, 4);
    expect(scene.fogStart).toBeCloseTo(125, 4);
  });

  it('recovers a band starting at zero', async () => {
    // A zero start makes fogStart land on exactly 0, which a sign error would miss.
    const scene = await packed(0, 200);
    expect(scene.fogEnd).toBeCloseTo(200, 4);
    expect(scene.fogStart).toBeCloseTo(0, 4);
  });

  it('reads zero rather than NaN before the first blend', async () => {
    const SceneLight = (await import('../SceneLight')).default;
    const scene = new SceneLight();
    scene.fogParams.set(0, 0, 0, 0);
    expect(scene.fogEnd).toBe(0);
    expect(Number.isFinite(scene.fogStart)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: FAIL on `fogEnd` first — it returns `1.333` (`500/375`), expected `500`. Once that is fixed,
`fogStart` fails too, returning `875` (`2*500 - 125`) where `125` is expected.

- [ ] **Step 3: Fix both getters**

In `client/src/game/world/light/SceneLight.ts`, replace the `fogStart` AND `fogEnd` getters:

```ts
  /**
   * `blendLights` packs `fogParams` as the shader's (slope, intercept) pair, not as (step, end):
   * `x = -1/(end - start)`, `y = end/(end - start)`. So the span is recovered by ADDING the
   * reciprocal, not subtracting it: `end + 1/x = end - (end - start) = start`. Subtracting yielded
   * `2*end - start`, which read plausibly on a narrow band and was wrong everywhere.
   */
  get fogStart() {
    const step = this.#params[this.#location].fogParams.x;
    return step !== 0 ? this.fogEnd + 1.0 / step : this.fogEnd;
  }

  /**
   * The packed intercept is `end/(end - start)`, so the raw component is NOT the fog end — recover it
   * as `-y/x`. Returning `y` directly reported 1.333 for a 125..500 yard band.
   *
   * Guarded at `x == 0` so an unset `fogParams` (all zeros, before the first blend) reads 0 rather
   * than NaN or Infinity in a debug readout.
   */
  get fogEnd() {
    const params = this.#params[this.#location].fogParams;
    return params.x !== 0 ? -params.y / params.x : 0;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test --watchAll=false --testPathPattern="light/__tests__/laws"`
Expected: PASS, 40 tests (37 existing + 3 new).

- [ ] **Step 5: Expose what the readouts need on MapLight**

In `client/src/game/world/light/MapLight.ts`, add a field beside the other private ones:

```ts
  // The world position the area-light blend was last sampled at -- the camera eye, not the player.
  // Surfaced for the debug readout: it and the map id decide every colour below them, and neither is
  // otherwise visible.
  #sampledPosition: THREE.Vector3 | null = null;
```

In `#selectLights`, record it as the first statement of the method body:

```ts
  #selectLights(position: THREE.Vector3) {
    this.#sampledPosition = position;

    if (!this.#lights || this.#mapId === undefined || !this.#lights[this.#mapId]) {
      return;
    }

    this.#selectedLights = selectLightsForPosition(this.#lights[this.#mapId], position);
  }
```

Add these getters beside the existing `get time()`:

```ts
  get selectedLights() {
    return this.#selectedLights;
  }

  get sampledPosition() {
    return this.#sampledPosition;
  }

  /**
   * The SIDN self-illumination night fraction for the current time -- 1 overnight, 0 by day. WMO
   * window materials multiply their authored emissive colour by this (consumed from plan 2 onward).
   */
  get sidnNight() {
    return sidnNightFraction(this.#time / 2);
  }
```

Add the import at the top of `MapLight.ts`:

```ts
import { sidnNightFraction } from './laws';
```

- [ ] **Step 6: Write the readouts component**

Create `client/src/pages/game/debug/lighting-readouts.tsx`:

```tsx
import React from 'react';

type Rgb = { r: number; g: number; b: number };
type Xyz = { x: number; y: number; z: number };

/**
 * The slice of MapLight these readouts print. Narrow and structural for the same reasons as
 * `LightingControlsTarget`: no three.js import, and testable with plain objects. Colours and vectors
 * are described by shape, so a THREE.Color and a THREE.Vector3 both satisfy it. Plans 2-5 extend this
 * as they add resolved values (storm bcc, sky warp, interior fog triple, batch-class counts).
 */
export type LightingReadoutsTarget = {
  mapId: number | undefined;
  sampledPosition: Xyz | null;
  location: 'exterior' | 'interior';
  sunAmbientColor: Rgb;
  sunDiffuseColor: Rgb;
  fogColor: Rgb;
  fogStart: number;
  fogEnd: number;
  sunDir: Xyz;
  sidnNight: number;
  selectedLights: Array<{ light: { id: number }; weight: number; distance: number }>;
  wmoPointLights: unknown[];
};

type Props = {
  mapLight: LightingReadoutsTarget | null;
};

/** 0..1 colour to the 0..255 bytes the reference's own dumps report, so values compare directly. */
const asBytes = (color: Rgb | undefined) => {
  if (!color) {
    return '-';
  }
  const byte = (v: number) => Math.round(v * 255);
  return `${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}`;
};

const asFixed = (value: number | undefined, places = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '-';

/**
 * The resolved-light numeric probe.
 *
 * Leads with the map id and the sampled eye position deliberately: those two inputs decide every
 * colour below them, neither is visible from the chair, and "is this the atmosphere the zone
 * authored, or the one next door?" is otherwise unanswerable without a session of guessing.
 *
 * Colours print as 0..255 bytes rather than floats so they can be compared directly against the
 * reference's dumps and against the DBC bytes themselves.
 */
class LightingReadouts extends React.Component<Props> {
  render() {
    const { mapLight } = this.props;
    if (!mapLight) {
      return null;
    }

    const position = mapLight.sampledPosition;
    const selected = mapLight.selectedLights || [];

    return (
      <div className="lightingReadouts">
        <h2>Lighting resolve</h2>
        <div className="divider"></div>
        <p>Map: {mapLight.mapId ?? '-'}</p>
        <p>
          Sampled at:{' '}
          {position
            ? `${asFixed(position.x, 1)}, ${asFixed(position.y, 1)}, ${asFixed(position.z, 1)}`
            : '-'}
        </p>
        <p>Location: {mapLight.location}</p>

        <div className="divider"></div>
        <p>Ambient: {asBytes(mapLight.sunAmbientColor)}</p>
        <p>Diffuse: {asBytes(mapLight.sunDiffuseColor)}</p>
        <p>Fog colour: {asBytes(mapLight.fogColor)}</p>
        <p>
          Fog range: {asFixed(mapLight.fogStart)} / {asFixed(mapLight.fogEnd)}
        </p>
        <p>
          Sun dir: {asFixed(mapLight.sunDir.x, 3)}, {asFixed(mapLight.sunDir.y, 3)},{' '}
          {asFixed(mapLight.sunDir.z, 3)}
        </p>

        <div className="divider"></div>
        <p>SIDN night: {asFixed(mapLight.sidnNight, 3)}</p>

        <div className="divider"></div>
        <p>Area lights: {selected.length}</p>
        {selected.slice(0, 4).map((entry) => (
          <p key={entry.light.id}>
            id {entry.light.id} &middot; weight {asFixed(entry.weight, 3)} &middot; dist{' '}
            {asFixed(entry.distance, 1)}
          </p>
        ))}

        <div className="divider"></div>
        <p>WMO point lights: {(mapLight.wmoPointLights || []).length}</p>
      </div>
    );
  }
}

export default LightingReadouts;
```

- [ ] **Step 7: Test the readouts**

Create `client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import React from 'react';
import LightingReadouts, { LightingReadoutsTarget } from '../lighting-readouts';

const target = (overrides: Partial<LightingReadoutsTarget> = {}): LightingReadoutsTarget => ({
  mapId: 0,
  sampledPosition: { x: 1.25, y: -2.5, z: 83.5 },
  location: 'exterior',
  sunAmbientColor: { r: 61 / 255, g: 59 / 255, b: 96 / 255 },
  sunDiffuseColor: { r: 90 / 255, g: 86 / 255, b: 141 / 255 },
  fogColor: { r: 0.5, g: 0.5, b: 0.5 },
  fogStart: 125,
  fogEnd: 500,
  sunDir: { x: -0.5, y: 0.25, z: -0.83 },
  sidnNight: 0,
  selectedLights: [],
  wmoPointLights: [],
  ...overrides,
});

describe('LightingReadouts', () => {
  it('renders nothing without a map light', () => {
    const { container } = render(<LightingReadouts mapLight={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('prints colours as 0-255 bytes so they compare against the DBC and the reference dumps', () => {
    render(<LightingReadouts mapLight={target()} />);
    expect(screen.getByText(/61, 59, 96/)).toBeInTheDocument();
    expect(screen.getByText(/90, 86, 141/)).toBeInTheDocument();
  });

  it('prints the fog range start-before-end', () => {
    render(<LightingReadouts mapLight={target()} />);
    expect(screen.getByText(/125 \/ 500/)).toBeInTheDocument();
  });

  it('shows a dash rather than a wrong number when nothing has been sampled yet', () => {
    render(<LightingReadouts mapLight={target({ sampledPosition: null })} />);
    expect(screen.getByText(/Sampled at: -/)).toBeInTheDocument();
  });

  it('lists the selected area lights with their blend weights', () => {
    const selected = [
      { light: { id: 16 }, weight: 0.75, distance: 120.5 },
      { light: { id: 2 }, weight: 0.25, distance: 400.0 },
    ];
    render(<LightingReadouts mapLight={target({ selectedLights: selected })} />);
    expect(screen.getByText(/Area lights: 2/)).toBeInTheDocument();
    expect(screen.getByText(/id 16/)).toBeInTheDocument();
    expect(screen.getByText(/0\.750/)).toBeInTheDocument();
  });
});
```

Run: `cd client && yarn test --watchAll=false --testPathPattern="lighting-readouts"`
Expected: PASS, 5 tests.

- [ ] **Step 8: Render it from the debug panel**

In `client/src/pages/game/debug/debug.tsx`, add the import:

```tsx
import LightingReadouts from './lighting-readouts';
```

and render it immediately after `<LightingControls ... />`:

```tsx
        <LightingReadouts mapLight={ this.props.game.world.map ? this.props.game.world.map.mapLight : null } />
```

- [ ] **Step 9: Verify in the running app**

Run the client and confirm:
- Map id and sampled position are populated and the position tracks the camera as it moves.
- Ambient, diffuse and fog colours are plausible bytes rather than `0, 0, 0` or `-`.
- Fog range shows start < end (this is the fix from Step 3 paying off).
- Scrubbing the Task 5 slider from 12:00 to 22:00 visibly changes the ambient and diffuse bytes, and
  drives SIDN night from 0 toward 1.
- The area-light list is non-empty in a zone with `Light.dbc` coverage.

- [ ] **Step 10: Run the full test suite**

Run: `cd client && yarn test --watchAll=false`
Expected: PASS. The `SceneLight.fogStart` change is the only edit reaching outside new files — check
that no existing suite depended on the old wrong value.

- [ ] **Step 11: Commit**

```bash
git add client/src/pages/game/debug/lighting-readouts.tsx client/src/pages/game/debug/__tests__/lighting-readouts.test.tsx client/src/pages/game/debug/debug.tsx client/src/game/world/light/MapLight.ts client/src/game/world/light/SceneLight.ts client/src/game/world/light/__tests__/laws.test.ts
git commit -m "feat(debug): add resolved-light readouts and fix the fogStart getter"
```

---

## Done when

- `yarn test --watchAll=false --testPathPattern="light"` passes, 40 tests.
- `yarn test --watchAll=false --testPathPattern="lighting-controls"` passes, 5 tests.
- `yarn test --watchAll=false --testPathPattern="lighting-readouts"` passes, 5 tests.
- The debug panel drives time of day and prints the resolved light as bytes.
- `laws.ts` imports nothing, and every constant in it cites its reference origin.

## Handoff to plan 2

Plan 2 (WMO lighting) consumes `sidnNightFraction` via `MapLight.sidnNight`, and nothing else from
here. Plan 3 consumes `foldInteriorProbe`, `selectPointLights`, `evalProbe`, `cap96` and `floor112`.

Two things to carry forward:

1. **`INTERIOR_LIGHT_AXIS` is inferred, not measured.** Plan 3's first interior check must confirm it
   reads as light-from-above-and-45°. The fold takes the axis as a parameter so correcting it is a
   one-line change in one place.
2. **Do not remove `MapLight`'s interior sun fade in plan 2.** It comes out at the end of plan 3, once
   both the WMO batch classes and the M2 probes exist. See "Plan decomposition" above.
