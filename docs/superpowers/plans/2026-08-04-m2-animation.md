# M2 Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Animate every animated object in the world — terrain doodads, WMO doodads, units, and texture/colour channels — including external `.anim` sequences, without losing a frame.

**Architecture:** Delete the `THREE.AnimationMixer` layer, which binds animation by uuid-string property path and therefore duplicates keyframe tracks per placement. Replace it with a purpose-built evaluator: immutable per-model keyframe data built once in the blueprint cache, plus a small mutable per-placement instance holding only a clock. Sampling is clock-indexed rather than delta-accumulated, which is what makes offscreen gating free of pops and drift.

**Tech Stack:** TypeScript, three.js, Jest (Create React App runner), restructure (binary parsing).

**Spec:** [`docs/superpowers/specs/2026-08-04-m2-animation-design.md`](../specs/2026-08-04-m2-animation-design.md)

## Global Constraints

- **Frame budget: 16.666 ms (60 fps floor).** Headline metric is **worst frame ms** over a rolling window, never average fps. From [`2026-08-01-renderer-60fps-optimization.md`](2026-08-01-renderer-60fps-optimization.md).
- **Acceptance gate: the `anim` CPU section holds ≤ 2 ms**, and worst-frame is unchanged versus the current static build, measured in Stormwind and in open terrain.
- **Target client: 3.3.5a (build 12340).** Benilla is 1.12.1 — port its semantics, never its track-layout mechanics.
- **No new runtime dependencies.**
- Tests live in `__tests__/` beside their source, start with `/** @jest-environment node */`, and are pure — no WebGL context.
- Test command from repo root: `cd client && CI=true npm test -- --testPathPattern="<pattern>"`
- **No allocation in per-frame code paths.** Preallocate every matrix, vector and quaternion; write in place.
- Commit after every task. Do not push.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `client/src/game/pipeline/m2/anim/counters.ts` | Mutable per-frame animation counters for the perf HUD |
| `client/src/game/pipeline/m2/anim/tracks.ts` | Keyframe sampling: step/linear, hold, clamp, slerp, clock law |
| `client/src/game/pipeline/m2/anim/model-anim.ts` | Per-model immutable: sequence table, `classify`, `pickVariation`, `resolve`, global-sequence channels |
| `client/src/game/pipeline/m2/anim/instance-anim.ts` | Per-placement mutable: clock, bone palette, output buffers |
| `client/src/game/pipeline/m2/anim/variation-cycle.ts` | Doodad arming host + the single shared RNG stream |
| `client/src/game/pipeline/m2/anim/gating.ts` | Decimation buckets and the per-frame bone-evaluation budget |
| `client/src/game/pipeline/m2/anim/external-anim.ts` | `.anim` fetch, parse and cache |
| `client/src/game/pipeline/m2/anim/__tests__/*.test.ts` | One test file per module above |

**Modify:**

| File | Change |
|---|---|
| `client/src/game/perf/index.ts` | `SceneCounters` gains the animation fields |
| `client/src/pages/game/index.tsx:243-254` | Feed animation counters into `endFrame` |
| `client/src/game/pipeline/m2/index.ts` | Drop `registerTrack` call sites; per-submesh skinning; preallocate temporaries |
| `client/src/game/pipeline/m2/submesh.js` | Single-bone path; animated uniforms via `onBeforeRender` |
| `client/src/game/pipeline/m2/material/index.ts:496-560` | Delete the three subscription methods |
| `client/src/game/pipeline/m2/blueprint.js` | Own the `ModelAnim` cache; drive instances |
| `client/src/game/world/doodad-manager.js:144-155` | Route through the arming host |
| `client/src/game/pipeline/wmo/index.js:266-274` | Enable, same host |
| `client/src/game/classes/unit.ts:290-340` | Resolve animation ids instead of raw indices |
| `client/src/game/world/index.ts:415-430, 433-459` | Remove the per-doodad `updateMatrixWorld`; drive the evaluator |

**Delete:** `client/src/game/pipeline/m2/animation-manager.js`

---

## Task Ordering Rationale

Task 1 is the instrument, before any evaluator code — this project has already paid for guessing (five plausible diagnoses failed on one bug that a debug-panel measurement found in one step). Tasks 2–9 are pure modules with no renderer involvement, fully testable. Task 10 is the single risky integration point. Tasks 11–17 are the optimizations, each a measurable delta. Tasks 18–20 add `.anim`. Task 21 is the acceptance measurement.

---

### Task 1: Animation counters and the `anim` CPU span

The instrument lands first so every later task is a measured delta.

**Files:**
- Create: `client/src/game/pipeline/m2/anim/counters.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/counters.test.ts`
- Modify: `client/src/game/perf/index.ts:13-24`
- Modify: `client/src/pages/game/index.tsx:243-254`

**Interfaces:**
- Consumes: `SceneCounters` from `client/src/game/perf/index.ts`
- Produces: `animCounters: AnimCounters` (module singleton) with fields `resident`, `posed`, `skipped`, `bonesSolved`, `paletteUploads`, and methods `reset(): void`, `snapshot(): AnimCountersSnapshot`

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { animCounters } from '../counters';

describe('animCounters', () => {
  beforeEach(() => animCounters.reset());

  it('starts at zero', () => {
    expect(animCounters.snapshot()).toEqual({
      resident: 0, posed: 0, skipped: 0, bonesSolved: 0, paletteUploads: 0,
    });
  });

  it('accumulates within a frame', () => {
    animCounters.resident = 12;
    animCounters.posed += 3;
    animCounters.posed += 2;
    animCounters.bonesSolved += 40;
    expect(animCounters.snapshot()).toEqual({
      resident: 12, posed: 5, skipped: 0, bonesSolved: 40, paletteUploads: 0,
    });
  });

  it('reset clears every field, so a frame never inherits the last one', () => {
    animCounters.resident = 9;
    animCounters.posed = 9;
    animCounters.skipped = 9;
    animCounters.bonesSolved = 9;
    animCounters.paletteUploads = 9;
    animCounters.reset();
    expect(animCounters.snapshot()).toEqual({
      resident: 0, posed: 0, skipped: 0, bonesSolved: 0, paletteUploads: 0,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/counters"`
Expected: FAIL — `Cannot find module '../counters'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Per-frame animation counters, read by the perf HUD.
 *
 * A mutable singleton rather than a returned value: the evaluator increments these from several
 * call sites per frame, and threading a counters object through every one of them would be a
 * larger change to the hot path than the measurement is worth.
 *
 * `reset()` is called at the top of each frame. A counter that is never reset silently reports a
 * running total as if it were a per-frame figure, which is worse than no measurement at all.
 */
export interface AnimCountersSnapshot {
  /** Animated instances currently loaded, whether or not they were posed. */
  resident: number;
  /** Instances actually evaluated this frame. */
  posed: number;
  /** Instances skipped by a gate (not drawn, decimated, or over the bone budget). */
  skipped: number;
  /** Bones solved this frame across every posed instance. */
  bonesSolved: number;
  /** Bone-texture uploads issued this frame. */
  paletteUploads: number;
}

class AnimCounters implements AnimCountersSnapshot {
  resident = 0;
  posed = 0;
  skipped = 0;
  bonesSolved = 0;
  paletteUploads = 0;

  reset(): void {
    this.resident = 0;
    this.posed = 0;
    this.skipped = 0;
    this.bonesSolved = 0;
    this.paletteUploads = 0;
  }

  snapshot(): AnimCountersSnapshot {
    return {
      resident: this.resident,
      posed: this.posed,
      skipped: this.skipped,
      bonesSolved: this.bonesSolved,
      paletteUploads: this.paletteUploads,
    };
  }
}

export const animCounters = new AnimCounters();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/counters"`
Expected: PASS (3 tests)

- [ ] **Step 5: Extend `SceneCounters`**

In `client/src/game/perf/index.ts`, add to the `SceneCounters` interface after `visibleDoodads: number;`:

```ts
  animResident: number;
  animPosed: number;
  animSkipped: number;
  animBonesSolved: number;
```

- [ ] **Step 6: Feed the counters from the render loop**

In `client/src/pages/game/index.tsx`, add to the `this.perf.endFrame({...})` object literal at line 243, after `visibleDoodads`:

```ts
        animResident: animCounters.resident,
        animPosed: animCounters.posed,
        animSkipped: animCounters.skipped,
        animBonesSolved: animCounters.bonesSolved,
```

Add the import at the top of the file:

```ts
import { animCounters } from '../../game/pipeline/m2/anim/counters';
```

- [ ] **Step 7: Reset the counters at frame start**

In `client/src/pages/game/index.tsx`, immediately after `this.perf.beginFrame();` (line 187):

```ts
    animCounters.reset();
```

- [ ] **Step 8: Verify the app still builds and the HUD renders the new rows**

Run: `cd client && CI=true npm test -- --testPathPattern="perf"`
Expected: PASS — existing perf tests unaffected.

The HUD prints every `SceneCounters` field it is given, so the four new rows appear with no change to `hud.ts`.

- [ ] **Step 9: Commit**

```bash
git add client/src/game/pipeline/m2/anim/counters.ts \
        client/src/game/pipeline/m2/anim/__tests__/counters.test.ts \
        client/src/game/perf/index.ts \
        client/src/pages/game/index.tsx
git commit -m "feat(perf): animation counters ahead of the evaluator"
```

---

### Task 2: Track sampler — scalar, step and linear

**Files:**
- Create: `client/src/game/pipeline/m2/anim/tracks.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts`

**Interfaces:**
- Produces:
  - `interface SeqTrack { animationIndex: number; timestamps: number[]; values: unknown[] }`
  - `interface AnimBlock { interpolationType: number; globalSequenceID: number; tracks: SeqTrack[] }`
  - `function isStep(block: AnimBlock): boolean`
  - `function trackFor(block: AnimBlock, seqIndex: number): SeqTrack | null`
  - `function sampleScalar(track: SeqTrack, step: boolean, tMs: number, fallback: number): number`

**Reference:** [`key_anim.rs:97-132`](../../../samples/benilla/crates/benilla-formats/src/models/key_anim.rs) (`KeyAnim::sample_or`). Port the law, not the band mechanics — WotLK already stores one key array per sequence.

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { AnimBlock, isStep, sampleScalar, SeqTrack, trackFor } from '../tracks';

const track = (timestamps: number[], values: unknown[]): SeqTrack =>
  ({ animationIndex: 0, timestamps, values });

const linear = track([0, 100, 200], [0, 10, 30]);

describe('isStep', () => {
  it('is step only for interpolationType 0', () => {
    expect(isStep({ interpolationType: 0, globalSequenceID: -1, tracks: [] })).toBe(true);
    expect(isStep({ interpolationType: 1, globalSequenceID: -1, tracks: [] })).toBe(false);
    expect(isStep({ interpolationType: 2, globalSequenceID: -1, tracks: [] })).toBe(false);
  });
});

describe('trackFor', () => {
  const block: AnimBlock = {
    interpolationType: 1,
    globalSequenceID: -1,
    tracks: [track([0], [1]), track([0], [2])],
  };

  it('returns the track for the requested sequence slot', () => {
    expect(trackFor(block, 1)).toBe(block.tracks[1]);
  });

  it('returns null for an out-of-range slot rather than silently using slot 0', () => {
    expect(trackFor(block, 7)).toBeNull();
  });

  it('returns null for a slot whose track has no keys', () => {
    const sparse: AnimBlock = {
      interpolationType: 1, globalSequenceID: -1, tracks: [track([], [])],
    };
    expect(trackFor(sparse, 0)).toBeNull();
  });
});

describe('sampleScalar', () => {
  it('interpolates linearly between bracketing keys', () => {
    expect(sampleScalar(linear, false, 50, 0)).toBeCloseTo(5, 5);
    expect(sampleScalar(linear, false, 150, 0)).toBeCloseTo(20, 5);
  });

  it('holds the previous key when the track is step', () => {
    expect(sampleScalar(linear, true, 50, 0)).toBe(0);
    expect(sampleScalar(linear, true, 199, 0)).toBe(10);
    expect(sampleScalar(linear, true, 200, 0)).toBe(30);
  });

  it('holds the first key before the track starts', () => {
    expect(sampleScalar(linear, false, -50, 0)).toBe(0);
  });

  // The benilla rule that matters most: past the last key, HOLD. Never wrap-lerp back to key 0.
  it('holds the final key past the end instead of wrapping toward key 0', () => {
    expect(sampleScalar(linear, false, 250, 0)).toBe(30);
    expect(sampleScalar(linear, false, 10_000, 0)).toBe(30);
  });

  it('returns the single value when there is one key', () => {
    expect(sampleScalar(track([40], [7]), false, 0, 0)).toBe(7);
    expect(sampleScalar(track([40], [7]), false, 900, 0)).toBe(7);
  });

  it('returns the fallback for an empty track', () => {
    expect(sampleScalar(track([], []), false, 10, -1)).toBe(-1);
  });

  it('holds rather than dividing by zero on duplicate timestamps', () => {
    expect(sampleScalar(track([0, 100, 100, 200], [0, 5, 9, 12]), false, 100, 0)).toBe(9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: FAIL — `Cannot find module '../tracks'`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * M2 keyframe sampling.
 *
 * The sampling law is ported from benilla's `KeyAnim::sample_or`
 * (`samples/benilla/crates/benilla-formats/src/models/key_anim.rs`), which is byte-verified against
 * the 1.12.1 kernel. Its BAND MECHANICS are deliberately NOT ported: benilla parses the vanilla
 * track layout (one absolute key list plus a per-sequence `ranges` index window), while 3.3.5 stores
 * one key array per sequence outright -- see `blizzardry/src/lib/m2/animation-block.js`. The window
 * search benilla needs collapses here to a plain bracket search over the sequence's own keys.
 */

/** One sequence's keys within an animation block. `values` element type depends on the block. */
export interface SeqTrack {
  animationIndex: number;
  timestamps: number[];
  values: unknown[];
}

/** An M2 AnimationBlock as parsed by `wow-data-parser/m2/animation-block.js`. */
export interface AnimBlock {
  interpolationType: number;
  globalSequenceID: number;
  tracks: SeqTrack[];
}

/**
 * `interpolationType == 0` is STEP: hold each key until the next.
 *
 * Treating it as linear is not a rounding difference. Step tracks are used for quantities that were
 * never meant to take an in-between value -- a blink flag, a texture flipbook cell -- and lerping
 * one produces a value the artist never authored.
 */
export function isStep(block: AnimBlock): boolean {
  return block.interpolationType === 0;
}

/**
 * The track a given sequence slot plays, or `null` when it has nothing to say.
 *
 * Returns null rather than falling back to track 0 on purpose: a sequence with no track for a
 * channel is authored to leave that channel alone, and substituting another sequence's keys poses
 * it from an unrelated animation.
 */
export function trackFor(block: AnimBlock, seqIndex: number): SeqTrack | null {
  const track = block.tracks[seqIndex];
  if (!track || track.timestamps.length === 0 || track.values.length === 0) {
    return null;
  }
  return track;
}

/**
 * Index of the last key at or before `tMs`, clamped into range.
 *
 * Shared by every typed sampler so the bracketing rule exists once.
 */
function bracket(timestamps: number[], tMs: number): number {
  let k0 = 0;
  for (let i = 0, len = timestamps.length; i < len; ++i) {
    if (timestamps[i] <= tMs) {
      k0 = i;
    } else {
      break;
    }
  }
  return k0;
}

/**
 * Interpolation fraction between keys `k0` and `k0 + 1`, clamped to [0, 1].
 *
 * The clamp is a NAMED DEVIATION from the reference, taken from benilla (`key_anim.rs:135-148`):
 * the kernel computes the fraction unclamped and therefore extrapolates past a bracket. An
 * extrapolated value below zero on an alpha channel culls a batch on a data quirk rather than on
 * authoring, so we hold at the bracket instead of running past it.
 *
 * Returns 0 for a non-advancing pair, which makes duplicate timestamps hold instead of dividing by
 * zero.
 */
function fraction(timestamps: number[], k0: number, tMs: number): number {
  const ta = timestamps[k0];
  const tb = timestamps[k0 + 1];
  if (tb <= ta) {
    return 0;
  }
  const f = (tMs - ta) / (tb - ta);
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** True when `k0` is the last key, i.e. there is nothing to interpolate toward. */
function atEnd(track: SeqTrack, k0: number): boolean {
  return k0 + 1 >= track.timestamps.length || k0 + 1 >= track.values.length;
}

export function sampleScalar(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  fallback: number,
): number {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return fallback;
  }

  const k0 = bracket(timestamps, tMs);
  const va = values[k0] as number;

  // Step, or past the final key: HOLD. There is deliberately no wrap-lerp back toward key 0.
  if (step || atEnd(track, k0)) {
    return va;
  }

  const vb = values[k0 + 1] as number;
  return va + (vb - va) * fraction(timestamps, k0, tMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/tracks.ts \
        client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts
git commit -m "feat(m2): scalar keyframe sampler with step, hold and clamped fraction"
```

---

### Task 3: Track sampler — vec3 and quaternion

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/tracks.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts`

**Interfaces:**
- Consumes: `SeqTrack`, `trackFor`, `isStep` from Task 2
- Produces:
  - `function sampleVec3(track: SeqTrack, step: boolean, tMs: number, out: THREE.Vector3): THREE.Vector3`
  - `function sampleQuat(track: SeqTrack, step: boolean, tMs: number, out: THREE.Quaternion): THREE.Quaternion`

Both write into `out` and return it. **No allocation** — these run per bone per instance per frame.

**Prerequisite refactor (do this first).** Task 2's fix round added an inline clamp inside `sampleScalar` guarding `k0` against `values.length`. Hoist it into a shared private helper in the same file and make `sampleScalar` use it, so all three samplers share one guard rather than three copies:

```ts
/**
 * Clamp a bracket index into the `values` array.
 *
 * `bracket` only inspects `timestamps`. A track whose `values` array is shorter -- malformed but
 * real data -- therefore yields an index that is valid for `timestamps` and out of bounds for
 * `values`, and the read returns `undefined` typed as a number. Downstream that is NaN in a bone
 * matrix, which silently poisons an entire skeleton while every input still inspects as correct.
 *
 * Callers guarantee `valuesLength > 0` (each sampler returns early on an empty track), so this
 * cannot produce -1.
 */
function clampToValues(k0: number, valuesLength: number): number {
  return k0 < valuesLength - 1 ? k0 : valuesLength - 1;
}
```

Keep `sampleScalar`'s existing tests passing unchanged — this is a pure refactor of that one guard.

**Note on quaternion encoding:** M2 rotation keys are `compfixed16array4`, and [`comp-fixed16.js`](../../../client/src/wow-data-parser/types/comp-fixed16.js) already converts each component to a float in [-1, 1] at parse time via `(value - 32767) / 32767`. **No decompression belongs in this module** — the values arrive as `[x, y, z, w]` floats. (The design doc's §3.1 claim that decompression lives here is wrong; Step 6 verifies the parser's output range instead.)

- [ ] **Step 1: Write the failing test**

Append to `__tests__/tracks.test.ts`:

```ts
import * as THREE from 'three';
import { sampleQuat, sampleVec3 } from '../tracks';

describe('sampleVec3', () => {
  const v = track([0, 100], [[0, 0, 0], [10, 20, -30]]);

  it('interpolates each component', () => {
    const out = sampleVec3(v, false, 50, new THREE.Vector3());
    expect(out.x).toBeCloseTo(5, 5);
    expect(out.y).toBeCloseTo(10, 5);
    expect(out.z).toBeCloseTo(-15, 5);
  });

  it('holds the previous key when step', () => {
    const out = sampleVec3(v, true, 50, new THREE.Vector3());
    expect(out.toArray()).toEqual([0, 0, 0]);
  });

  it('holds the final key past the end', () => {
    const out = sampleVec3(v, false, 5000, new THREE.Vector3());
    expect(out.toArray()).toEqual([10, 20, -30]);
  });

  it('writes into the supplied vector and returns it, allocating nothing', () => {
    const out = new THREE.Vector3(1, 1, 1);
    expect(sampleVec3(v, false, 0, out)).toBe(out);
    expect(out.toArray()).toEqual([0, 0, 0]);
  });

  it('leaves the output untouched for an empty track', () => {
    const out = new THREE.Vector3(3, 4, 5);
    sampleVec3(track([], []), false, 10, out);
    expect(out.toArray()).toEqual([3, 4, 5]);
  });
});

describe('sampleQuat', () => {
  // 0 degrees and 90 degrees about Z.
  const a = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0);
  const b = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const q = track([0, 100], [a.toArray(), b.toArray()]);

  it('slerps rather than component-lerping', () => {
    const out = sampleQuat(q, false, 50, new THREE.Quaternion());
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), Math.PI / 4,
    );
    expect(out.angleTo(expected)).toBeCloseTo(0, 5);
  });

  // The failure a component-lerp produces: a non-unit quaternion, which scales the bone and
  // visibly shortens the limb at mid-swing.
  it('stays unit-length at the midpoint, which a component lerp would not', () => {
    const out = sampleQuat(q, false, 50, new THREE.Quaternion());
    expect(out.length()).toBeCloseTo(1, 6);

    const lerped = new THREE.Quaternion(
      (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, (a.w + b.w) / 2,
    );
    expect(lerped.length()).toBeLessThan(0.99);
  });

  it('holds the previous key when step', () => {
    const out = sampleQuat(q, true, 50, new THREE.Quaternion());
    expect(out.angleTo(a)).toBeCloseTo(0, 6);
  });

  it('holds the final key past the end', () => {
    const out = sampleQuat(q, false, 9999, new THREE.Quaternion());
    expect(out.angleTo(b)).toBeCloseTo(0, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: FAIL — `sampleVec3 is not a function`

- [ ] **Step 3: Write the implementation**

Append to `tracks.ts`:

```ts
import * as THREE from 'three';

/** Scratch quaternion for the slerp target. Module-level: this runs per bone per frame. */
const scratchQuat = new THREE.Quaternion();

export function sampleVec3(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return out;
  }

  const k0 = bracket(timestamps, tMs);
  // Same guard `sampleScalar` carries: `bracket` only inspects `timestamps`, so a track whose
  // `values` array is shorter yields a `k0` out of bounds for `values`, and the read comes back
  // `undefined` -- which becomes NaN in a bone matrix and silently poisons a whole skeleton.
  const k0c = clampToValues(k0, values.length);
  const va = values[k0c] as ArrayLike<number>;

  if (step || atEnd(track, k0)) {
    return out.set(va[0], va[1], va[2]);
  }

  const vb = values[k0c + 1] as ArrayLike<number>;
  const f = fraction(timestamps, k0, tMs);

  return out.set(
    va[0] + (vb[0] - va[0]) * f,
    va[1] + (vb[1] - va[1]) * f,
    va[2] + (vb[2] - va[2]) * f,
  );
}

/**
 * Sample a rotation track.
 *
 * SLERP, never a component-wise lerp. Lerping four components independently produces a shorter,
 * non-unit quaternion at the midpoint, and a non-unit rotation scales the bone -- limbs visibly
 * shorten halfway through every swing while both endpoints look perfect, which is why this reads as
 * a rigging fault rather than a sampling one.
 *
 * Keys arrive already decompressed: `compfixed16` converts each component to a float in [-1, 1] at
 * parse time (`client/src/wow-data-parser/types/comp-fixed16.js`).
 */
export function sampleQuat(
  track: SeqTrack,
  step: boolean,
  tMs: number,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const { timestamps, values } = track;
  if (timestamps.length === 0 || values.length === 0) {
    return out;
  }

  const k0 = bracket(timestamps, tMs);
  const k0c = clampToValues(k0, values.length);
  const va = values[k0c] as ArrayLike<number>;
  out.set(va[0], va[1], va[2], va[3]);

  if (step || atEnd(track, k0)) {
    return out;
  }

  const vb = values[k0c + 1] as ArrayLike<number>;
  scratchQuat.set(vb[0], vb[1], vb[2], vb[3]);

  return out.slerp(scratchQuat, fraction(timestamps, k0, tMs));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/tracks.ts \
        client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts
git commit -m "feat(m2): vec3 and slerped quaternion keyframe samplers"
```

- [ ] **Step 6: Verify the parser's quaternion range against real data**

This confirms the "no decompression needed" claim rather than trusting it.

Create a throwaway script `client/scratch-quat-probe.mjs` is **not** wanted — instead add a temporary `console.log` in `client/src/game/pipeline/m2/loader.js` after `M2.decode(stream)`:

```js
    const rot = data.bones.find((b) => b.rotation.animated)?.rotation;
    if (rot) {
      const vals = rot.tracks.flatMap((t) => t.values).flat();
      console.log('[quat probe]', path, 'min', Math.min(...vals), 'max', Math.max(...vals));
    }
```

Run the app, load any zone, and read the console.
Expected: every logged min/max lies within roughly [-1.001, 1.001].
If values land outside that, the parser is NOT decompressing and Task 3 needs a decompression step — stop and report before continuing.

Remove the `console.log` afterwards. Do not commit it.

---

### Task 4: The clock law — wrap versus clamp

The single most consequential rule in the plan.

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/tracks.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts`

**Interfaces:**
- Produces:
  - `const WRAP = 0`, `const CLAMP = 1`
  - `type ClockLaw = 0 | 1`
  - `function clockLaw(block: AnimBlock, sequenceLoops: boolean): ClockLaw`
  - `function cursorMs(law: ClockLaw, elapsedMs: number, periodMs: number): number`

**Reference:** [`key_anim.rs:74-88`](../../../samples/benilla/crates/benilla-formats/src/models/key_anim.rs).

- [ ] **Step 1: Write the failing test**

Append to `__tests__/tracks.test.ts`:

```ts
import { CLAMP, clockLaw, cursorMs, WRAP } from '../tracks';

describe('clockLaw', () => {
  const gseq: AnimBlock = { interpolationType: 1, globalSequenceID: 3, tracks: [] };
  const seq: AnimBlock = { interpolationType: 1, globalSequenceID: -1, tracks: [] };

  it('always wraps a global sequence, whatever the playing sequence does', () => {
    expect(clockLaw(gseq, true)).toBe(WRAP);
    expect(clockLaw(gseq, false)).toBe(WRAP);
  });

  it('follows the sequence loop flag for an ordinary track', () => {
    expect(clockLaw(seq, true)).toBe(WRAP);
    expect(clockLaw(seq, false)).toBe(CLAMP);
  });
});

describe('cursorMs', () => {
  it('wraps within the period', () => {
    expect(cursorMs(WRAP, 250, 100)).toBe(50);
    expect(cursorMs(WRAP, 100, 100)).toBe(0);
  });

  it('clamps at the period for a one-shot', () => {
    expect(cursorMs(CLAMP, 250, 100)).toBe(100);
    expect(cursorMs(CLAMP, 50, 100)).toBe(50);
  });

  it('never returns a negative cursor', () => {
    expect(cursorMs(WRAP, -30, 100)).toBe(70);
    expect(cursorMs(CLAMP, -30, 100)).toBe(0);
  });

  it('degrades to 0 for a zero-length period instead of dividing by zero', () => {
    expect(cursorMs(WRAP, 250, 0)).toBe(0);
    expect(cursorMs(CLAMP, 250, 0)).toBe(0);
  });
});

/**
 * The regression this whole distinction exists to prevent, stated as the failure it produces:
 * a Death sequence fades every batch to alpha 0, and a wrapped clock snaps it back to a fully
 * opaque body frozen in mid-air one frame later, for ever.
 */
describe('one-shot tail behaviour', () => {
  const fade = track([0, 500, 1000], [1, 0.5, 0]);

  it('holds alpha 0 past the end of a one-shot', () => {
    const t = cursorMs(CLAMP, 1500, 1000);
    expect(sampleScalar(fade, false, t, 1)).toBe(0);
  });

  it('would snap back to opaque if the clock wrapped -- the bug being prevented', () => {
    const t = cursorMs(WRAP, 1500, 1000);
    expect(sampleScalar(fade, false, t, 1)).toBeCloseTo(0.5, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: FAIL — `clockLaw is not a function`

- [ ] **Step 3: Write the implementation**

Append to `tracks.ts`:

```ts
/** Sample at `elapsed mod period` — a loop. */
export const WRAP = 0;
/** Sample at `min(elapsed, period)` — a one-shot that holds its tail. */
export const CLAMP = 1;

export type ClockLaw = typeof WRAP | typeof CLAMP;

/**
 * Which clock a channel runs on. Decided from the DATA, at build time -- never by the caller,
 * which is how benilla got it wrong first (`key_anim.rs:74-88`).
 *
 * A global sequence has its own free-running clock, the same loop in every animation, so it wraps
 * regardless of what the playing sequence does. An ordinary sequence track inherits the sequence's
 * own loop flag.
 *
 * The distinction is only ever visible at the very end of a one-shot clip -- and that is exactly
 * where it is load-bearing. An elemental's Death sequence fades every batch to alpha 0; wrap that
 * clock and one frame later the corpse is fully opaque and frozen in mid-air, permanently.
 */
export function clockLaw(block: AnimBlock, sequenceLoops: boolean): ClockLaw {
  if (block.globalSequenceID > -1) {
    return WRAP;
  }
  return sequenceLoops ? WRAP : CLAMP;
}

/**
 * The cursor to sample at, given elapsed time on this channel's own clock.
 *
 * A zero or negative period degrades to 0 rather than producing NaN: a constant channel has no
 * clock at all, and a NaN cursor would silently poison every downstream matrix.
 */
export function cursorMs(law: ClockLaw, elapsedMs: number, periodMs: number): number {
  if (periodMs <= 0) {
    return 0;
  }
  if (law === CLAMP) {
    return elapsedMs < 0 ? 0 : elapsedMs > periodMs ? periodMs : elapsedMs;
  }
  // Euclidean remainder: a negative elapsed time must land inside the period, not outside it.
  const wrapped = elapsedMs % periodMs;
  return wrapped < 0 ? wrapped + periodMs : wrapped;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/tracks"`
Expected: PASS (28 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/tracks.ts \
        client/src/game/pipeline/m2/anim/__tests__/tracks.test.ts
git commit -m "feat(m2): wrap-vs-clamp clock law resolved from track data"
```

---

### Task 5: `ModelAnim` — sequence table, loop flag and `classify`

**Files:**
- Create: `client/src/game/pipeline/m2/anim/model-anim.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts`

**Interfaces:**
- Consumes: `AnimBlock` from `tracks.ts`
- Produces:
  - `interface Sequence { index: number; id: number; subId: number; lengthMs: number; flags: number; probability: number; blendTimeMs: number; moveSpeed: number; nextAnimationId: number; alias: number; loops: boolean }`
  - `interface M2AnimData { animations: any[]; sequences: number[]; bones: any[]; uvAnimations?: any[]; transparencyAnimations?: any[]; vertexColorAnimations?: any[] }`
  - `class ModelAnim` with `readonly sequences: Sequence[]`, `readonly globalSequenceDurations: number[]`, `readonly animated: boolean`, `constructor(data: M2AnimData)`
  - `function sequenceLoops(flags: number): boolean`
  - `function classify(data: M2AnimData): boolean`

**Loop-flag caveat:** benilla's rule is "sequence flags bit 0 CLEAR ⇒ looping", verified for 1.12.1. This is isolated in the single function `sequenceLoops` so that Task 20's probe can correct it in one place if 3.3.5 differs.

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { classify, ModelAnim, sequenceLoops } from '../model-anim';

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [], animated: false });
const keyedBlock = () => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 100], values: [[0, 0, 0], [1, 1, 1]] }],
  animated: true,
});

const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(),
  ...over,
});

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0,
  ...over,
});

const data = (over: any = {}) => ({
  animations: [animation()], sequences: [], bones: [bone()], ...over,
});

describe('sequenceLoops', () => {
  it('loops when bit 0 is clear', () => {
    expect(sequenceLoops(0)).toBe(true);
    expect(sequenceLoops(0x20)).toBe(true);
  });

  it('is one-shot when bit 0 is set', () => {
    expect(sequenceLoops(0x01)).toBe(false);
    expect(sequenceLoops(0x21)).toBe(false);
  });
});

describe('classify', () => {
  it('is false for a model with no animated channel', () => {
    expect(classify(data())).toBe(false);
  });

  it('is true when a bone has any animated channel', () => {
    expect(classify(data({ bones: [bone({ rotation: keyedBlock() })] }))).toBe(true);
  });

  it('is true for a model animated only through UV', () => {
    expect(classify(data({ uvAnimations: [{ translation: keyedBlock() }] }))).toBe(true);
  });

  it('is true for a model animated only through transparency', () => {
    expect(classify(data({ transparencyAnimations: [keyedBlock()] }))).toBe(true);
  });
});

describe('ModelAnim', () => {
  it('builds a sequence table off the parsed animation structs', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, length: 1200, blendTime: 150, flags: 0 })],
    }));
    expect(m.sequences).toHaveLength(1);
    expect(m.sequences[0]).toMatchObject({
      index: 0, id: 0, lengthMs: 1200, blendTimeMs: 150, loops: true,
    });
  });

  it('marks a bit-0 sequence as one-shot', () => {
    const m = new ModelAnim(data({ animations: [animation({ flags: 0x01 })] }));
    expect(m.sequences[0].loops).toBe(false);
  });

  it('carries the global sequence duration table', () => {
    const m = new ModelAnim(data({ sequences: [500, 0, 1500] }));
    expect(m.globalSequenceDurations).toEqual([500, 0, 1500]);
  });

  it('reports animated for a model with keyed bones', () => {
    expect(new ModelAnim(data({ bones: [bone({ rotation: keyedBlock() })] })).animated).toBe(true);
    expect(new ModelAnim(data()).animated).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: FAIL — `Cannot find module '../model-anim'`

- [ ] **Step 3: Write the implementation**

```ts
import { AnimBlock } from './tracks';

/** One entry of the model's sequence table, off the parsed `Animation` struct. */
export interface Sequence {
  /** File slot -- what indexes every animation block's `tracks` array. */
  index: number;
  /** `AnimationData.dbc` id. Several sequences can share one id as variations. */
  id: number;
  /** Variation discriminator within an id. */
  subId: number;
  lengthMs: number;
  flags: number;
  /** Selection weight among variations sharing `id`. */
  probability: number;
  blendTimeMs: number;
  /** Authored design movement speed, yd/s. `0` for a non-locomotion sequence. */
  moveSpeed: number;
  nextAnimationId: number;
  alias: number;
  /** Derived from `flags` -- the clock law for every track this sequence drives. */
  loops: boolean;
}

/** The subset of parsed M2 data the animation layer reads. */
export interface M2AnimData {
  animations: any[];
  /** Global sequence durations, ms. */
  sequences: number[];
  bones: any[];
  uvAnimations?: any[];
  transparencyAnimations?: any[];
  vertexColorAnimations?: any[];
}

/**
 * Whether a sequence loops.
 *
 * benilla's rule, verified for 1.12.1 (`key_anim.rs:57`): sequence flags bit 0 CLEAR means the band
 * loops. Isolated in one function on purpose -- it is the one piece of benilla's semantics whose
 * 3.3.5 equivalence has not been confirmed against real data, and Task 20's probe corrects it here
 * if it differs.
 */
export function sequenceLoops(flags: number): boolean {
  return (flags & 0x01) === 0;
}

/** Does an animation block hold any keys at all? */
function blockAnimated(block: AnimBlock | undefined): boolean {
  if (!block || !block.tracks) {
    return false;
  }
  for (let i = 0, len = block.tracks.length; i < len; ++i) {
    if (block.tracks[i].timestamps.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Does this model animate anything at all?
 *
 * benilla measured that roughly nine in ten PLACED doodads animate no channel
 * (`doodad_anim.rs:17-19`). Those keep the existing static path and never allocate an instance,
 * which is the single largest performance win available here -- and it costs nothing at runtime,
 * because the work simply never starts.
 */
export function classify(data: M2AnimData): boolean {
  const bones = data.bones || [];
  for (let i = 0, len = bones.length; i < len; ++i) {
    const bone = bones[i];
    if (blockAnimated(bone.translation) || blockAnimated(bone.rotation) || blockAnimated(bone.scaling)) {
      return true;
    }
  }

  const uv = data.uvAnimations || [];
  for (let i = 0, len = uv.length; i < len; ++i) {
    if (blockAnimated(uv[i].translation) || blockAnimated(uv[i].rotation) || blockAnimated(uv[i].scaling)) {
      return true;
    }
  }

  const transparency = data.transparencyAnimations || [];
  for (let i = 0, len = transparency.length; i < len; ++i) {
    if (blockAnimated(transparency[i])) {
      return true;
    }
  }

  const colors = data.vertexColorAnimations || [];
  for (let i = 0, len = colors.length; i < len; ++i) {
    if (blockAnimated(colors[i].color) || blockAnimated(colors[i].alpha)) {
      return true;
    }
  }

  return false;
}

/**
 * Per-model animation data: immutable, built ONCE per model path in the M2Blueprint cache.
 *
 * This is the whole fix for the bug that got the old system switched off. `THREE.AnimationMixer`
 * bound tracks by `bone.uuid + '.property'`, so every placement appended its own copy of every
 * track into the SHARED clips its instances took from the source M2 -- one clip accumulating tens
 * of thousands of tracks across a couple of hundred torches. Keyframes live here, once, and
 * placements hold nothing but a clock.
 */
export class ModelAnim {
  readonly sequences: Sequence[] = [];
  readonly globalSequenceDurations: number[];
  readonly animated: boolean;

  constructor(data: M2AnimData) {
    const animations = data.animations || [];
    for (let i = 0, len = animations.length; i < len; ++i) {
      const a = animations[i];
      this.sequences.push({
        index: i,
        id: a.id,
        subId: a.subID,
        lengthMs: a.length,
        flags: a.flags,
        probability: a.probability,
        blendTimeMs: a.blendTime,
        moveSpeed: a.movementSpeed,
        nextAnimationId: a.nextAnimationID,
        alias: a.alias,
        loops: sequenceLoops(a.flags),
      });
    }

    this.globalSequenceDurations = data.sequences || [];
    this.animated = classify(data);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/model-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts
git commit -m "feat(m2): per-model sequence table, loop flag and animated classification"
```

---

### Task 6: `pickVariation` and `resolve`

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/model-anim.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts`

**Interfaces:**
- Consumes: `ModelAnim`, `Sequence` from Task 5
- Produces: methods on `ModelAnim`:
  - `variationsOf(animId: number): Sequence[]`
  - `pickVariation(animId: number, roll: number): Sequence | null`
  - `resolve(requestedId: number): Sequence | null`

**Reference:** [`anims.rs:189, 213`](../../../samples/benilla/crates/benilla-assets/src/model/anims.rs).

- [ ] **Step 1: Write the failing test**

Append to `__tests__/model-anim.test.ts`:

```ts
describe('pickVariation', () => {
  const m = new ModelAnim(data({
    animations: [
      animation({ id: 0, subID: 0, probability: 30000 }),
      animation({ id: 0, subID: 1, probability: 2767 }),
      animation({ id: 4, subID: 0, probability: 32767 }),
    ],
  }));

  it('lists every variation sharing an id', () => {
    expect(m.variationsOf(0).map((s) => s.subId)).toEqual([0, 1]);
    expect(m.variationsOf(4).map((s) => s.subId)).toEqual([0]);
  });

  it('selects by cumulative probability weight', () => {
    expect(m.pickVariation(0, 0)!.subId).toBe(0);
    expect(m.pickVariation(0, 29999)!.subId).toBe(0);
    expect(m.pickVariation(0, 30000)!.subId).toBe(1);
    expect(m.pickVariation(0, 32766)!.subId).toBe(1);
  });

  it('clamps a roll at or past the total weight to the last variation', () => {
    expect(m.pickVariation(0, 999999)!.subId).toBe(1);
  });

  it('returns null for an id the model does not own', () => {
    expect(m.pickVariation(77, 0)).toBeNull();
  });

  it('returns the only variation regardless of roll when weights are all zero', () => {
    const zero = new ModelAnim(data({
      animations: [animation({ id: 2, subID: 0, probability: 0 }),
                   animation({ id: 2, subID: 1, probability: 0 })],
    }));
    expect(zero.pickVariation(2, 12345)).not.toBeNull();
  });
});

describe('resolve', () => {
  it('returns a directly owned sequence', () => {
    const m = new ModelAnim(data({ animations: [animation({ id: 5 })] }));
    expect(m.resolve(5)!.id).toBe(5);
  });

  it('follows nextAnimationID when the requested id is absent', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, nextAnimationID: -1 })],
    }));
    // 5 is absent; nothing chains to it, so it falls back to Stand (id 0).
    expect(m.resolve(5)!.id).toBe(0);
  });

  it('follows an alias to its target', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 0, flags: 0 }),
        animation({ id: 9, flags: 0x40, alias: 0 }),
      ],
    }));
    expect(m.resolve(9)!.id).toBe(0);
  });

  it('does not hang on an alias cycle', () => {
    const m = new ModelAnim(data({
      animations: [
        animation({ id: 1, flags: 0x40, alias: 1 }),
        animation({ id: 2, flags: 0x40, alias: 0 }),
      ],
    }));
    expect(() => m.resolve(1)).not.toThrow();
  });

  it('returns null for a model with no sequences at all', () => {
    expect(new ModelAnim(data({ animations: [] })).resolve(0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: FAIL — `m.variationsOf is not a function`

- [ ] **Step 3: Write the implementation**

Add to `model-anim.ts`. First, a module constant above the class:

```ts
/** Sequence flag 0x40: this sequence is an alias for the one `alias` points at. */
const FLAG_ALIAS = 0x40;

/** Guard against a malformed alias ring. Real chains are one or two hops. */
const MAX_ALIAS_HOPS = 8;
```

Then, as methods on `ModelAnim`:

```ts
  /** Every sequence sharing an `AnimationData.dbc` id -- the variation set. */
  variationsOf(animId: number): Sequence[] {
    const out: Sequence[] = [];
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].id === animId) {
        out.push(this.sequences[i]);
      }
    }
    return out;
  }

  /**
   * Choose among an id's variations by frequency weight.
   *
   * Port of benilla's `pick_variation` (`anims.rs:189`). `roll` comes from the single shared RNG
   * stream -- see `variation-cycle.ts` for why the stream must be shared rather than seeded per
   * placement.
   *
   * An all-zero weight set still returns a variation: some models leave `probability` unset, and
   * refusing to pick would freeze them instead of animating them uniformly.
   */
  pickVariation(animId: number, roll: number): Sequence | null {
    const variations = this.variationsOf(animId);
    if (variations.length === 0) {
      return null;
    }

    let total = 0;
    for (let i = 0, len = variations.length; i < len; ++i) {
      total += variations[i].probability;
    }
    if (total <= 0) {
      return variations[roll % variations.length];
    }

    // NO modulo on `roll`. Wrapping it back into the distribution biases mass toward the first
    // variation, and it also makes the trailing clamp below dead code -- with `target < total`
    // guaranteed, the loop's final comparison always fires. `roll` comes from a stream returning
    // [0, 32767] and an id's weights conventionally sum to 32767, so `roll >= total` is reachable
    // at the boundary; clamping there is correct and wrapping is a real distribution bug.
    const target = roll;
    let cumulative = 0;
    for (let i = 0, len = variations.length; i < len; ++i) {
      cumulative += variations[i].probability;
      if (target < cumulative) {
        return variations[i];
      }
    }

    return variations[variations.length - 1];
  }

  /**
   * Resolve a requested animation id to a sequence this model actually owns.
   *
   * Port of benilla's `resolve` (`anims.rs:213`). Three steps, in order: follow an alias chain to
   * its target; return a directly owned id; otherwise fall back to sequence 0 (Stand).
   *
   * Falling back rather than returning null for an unowned id is deliberate -- a unit asked to play
   * an animation its model lacks should stand, not freeze in bind pose.
   */
  resolve(requestedId: number): Sequence | null {
    if (this.sequences.length === 0) {
      return null;
    }

    let current = this.findById(requestedId);

    for (let hop = 0; current && (current.flags & FLAG_ALIAS) !== 0 && hop < MAX_ALIAS_HOPS; ++hop) {
      const target = this.sequences[current.alias];
      if (!target || target === current) {
        break;
      }
      current = target;
    }

    return current || this.sequences[0];
  }

  private findById(animId: number): Sequence | null {
    for (let i = 0, len = this.sequences.length; i < len; ++i) {
      if (this.sequences[i].id === animId) {
        return this.sequences[i];
      }
    }
    return null;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: PASS (21 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/model-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts
git commit -m "feat(m2): frequency-weighted variation picking and alias resolution"
```

---

### Task 7: Global sequence channels hoisted to the model

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/model-anim.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts`

**Interfaces:**
- Produces: `ModelAnim.globalSequenceCursor(gseqIndex: number, worldClockMs: number): number`

**Why here and not on the instance:** a global sequence is a pure function of world time and cannot differ between placements. WebWoWViewer keeps `globalSequenceTimes` per instance; that is per-instance state which provably cannot vary, so a courtyard of a hundred braziers evaluates its glow pulse a hundred times for one answer. This is a deliberate, documented divergence from that reference.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/model-anim.test.ts`:

```ts
describe('globalSequenceCursor', () => {
  const m = new ModelAnim(data({ sequences: [1000, 0, 250] }));

  it('wraps world time on the sequence duration', () => {
    expect(m.globalSequenceCursor(0, 2500)).toBe(500);
    expect(m.globalSequenceCursor(2, 600)).toBe(100);
  });

  it('is identical for every caller at the same world time -- there is no per-instance state', () => {
    expect(m.globalSequenceCursor(0, 12345)).toBe(m.globalSequenceCursor(0, 12345));
  });

  it('returns 0 for a zero-duration global sequence', () => {
    expect(m.globalSequenceCursor(1, 9999)).toBe(0);
  });

  it('returns 0 for an out-of-range index', () => {
    expect(m.globalSequenceCursor(9, 9999)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: FAIL — `m.globalSequenceCursor is not a function`

- [ ] **Step 3: Write the implementation**

Add the import at the top of `model-anim.ts`:

```ts
import { AnimBlock, cursorMs, WRAP } from './tracks';
```

Add the method to `ModelAnim`:

```ts
  /**
   * The cursor for a global-sequence channel at a given world time.
   *
   * Lives on the MODEL, not the instance. A global sequence is clock-driven with zero arming
   * (benilla `doodad_anim.rs:9`) -- it is a pure function of world time, so every placement of a
   * model computes an identical value. Hoisting it here means a courtyard of a hundred braziers
   * evaluates its glow pulse once instead of a hundred times.
   *
   * This is a deliberate divergence from WebWoWViewer, which keeps `globalSequenceTimes` per
   * instance -- per-instance state that provably cannot differ between instances.
   */
  globalSequenceCursor(gseqIndex: number, worldClockMs: number): number {
    const duration = this.globalSequenceDurations[gseqIndex];
    if (duration === undefined || duration <= 0) {
      return 0;
    }
    return cursorMs(WRAP, worldClockMs, duration);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: PASS (25 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/model-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts
git commit -m "perf(m2): evaluate global sequences once per model, not per instance"
```

---

### Task 8: `InstanceAnim` — the clock and clock-indexed resume

The property every gate in Tasks 15–17 depends on. It must be a test, not an argument.

**Files:**
- Create: `client/src/game/pipeline/m2/anim/instance-anim.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/instance-anim.test.ts`

**Interfaces:**
- Consumes: `ModelAnim`, `Sequence` from Tasks 5–7; `ClockLaw`, `cursorMs`, `clockLaw` from Task 4
- Produces:
  - `class InstanceAnim` with `constructor(model: ModelAnim)`, `arm(seq: Sequence, worldClockMs: number): void`, `cursor(worldClockMs: number): number`, `readonly current: Sequence | null`, `readonly armedAtMs: number`

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 150, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const model = (over: any = {}) => new ModelAnim({
  animations: [animation()], sequences: [], bones: [], ...over,
});

describe('InstanceAnim clock', () => {
  it('starts unarmed with a zero cursor', () => {
    const inst = new InstanceAnim(model());
    expect(inst.current).toBeNull();
    expect(inst.cursor(5000)).toBe(0);
  });

  it('measures the cursor from the arm time, not from accumulated deltas', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 1000);
    expect(inst.cursor(1000)).toBe(0);
    expect(inst.cursor(1400)).toBe(400);
  });

  it('wraps a looping sequence on its length', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(500);
  });

  it('clamps a one-shot sequence at its length', () => {
    const m = model({ animations: [animation({ flags: 0x01, length: 1000 })] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.cursor(2500)).toBe(1000);
  });
});

/**
 * The load-bearing property. Gating an offscreen instance is only safe if a resumed instance shows
 * the pose the shared clock dictates -- not a pose behind by however long it was skipped. A
 * delta-accumulating clock fails this; a clock-indexed one passes it by construction.
 */
describe('clock-indexed resume', () => {
  it('a paused instance resumes to the same cursor as one that never paused', () => {
    const m = model();

    const continuous = new InstanceAnim(m);
    continuous.arm(m.sequences[0], 0);
    for (let t = 0; t <= 2500; t += 16) {
      continuous.cursor(t);
    }

    const paused = new InstanceAnim(m);
    paused.arm(m.sequences[0], 0);
    paused.cursor(100);
    // ... skipped entirely from 100ms to 2500ms ...

    expect(paused.cursor(2500)).toBe(continuous.cursor(2500));
  });

  it('does not drift across many pause/resume cycles', () => {
    const m = model();
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    for (let t = 0; t < 100_000; t += 997) {
      inst.cursor(t);
    }
    expect(inst.cursor(100_000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/instance-anim"`
Expected: FAIL — `Cannot find module '../instance-anim'`

- [ ] **Step 3: Write the implementation**

```ts
import { ModelAnim, Sequence } from './model-anim';
import { ClockLaw, clockLaw, cursorMs } from './tracks';

/**
 * Per-placement animation state: a clock, and nothing else that could have lived on the model.
 *
 * Sampling is CLOCK-INDEXED (`cursor = worldClock - armedAt`), never delta-accumulated
 * (benilla `doodad_anim.rs:14-16`). That is not a stylistic choice -- it is what makes the
 * offscreen gating in `gating.ts` correct. A delta-accumulated clock falls behind by exactly the
 * time it was skipped, so a doodad that leaves the frustum for ten seconds resumes ten seconds
 * behind every other copy of the same model, and the whole set drifts apart permanently. A
 * clock-indexed one resumes to the pose the shared clock dictates: pausing costs nothing and
 * drifts nothing.
 */
export class InstanceAnim {
  readonly model: ModelAnim;

  current: Sequence | null = null;
  armedAtMs = 0;

  /** Cached from `current`, so the per-frame path does not re-derive it. */
  private law: ClockLaw = 0;
  private periodMs = 0;

  constructor(model: ModelAnim) {
    this.model = model;
  }

  /**
   * Start a sequence at `worldClockMs`.
   *
   * The clock law is resolved once, here, from the sequence's own loop flag -- never per sample.
   */
  arm(seq: Sequence, worldClockMs: number): void {
    this.current = seq;
    this.armedAtMs = worldClockMs;
    this.periodMs = seq.lengthMs;
    // A sequence-timeline channel: `globalSequenceID` -1 defers to the sequence's loop flag.
    this.law = clockLaw({ interpolationType: 1, globalSequenceID: -1, tracks: [] }, seq.loops);
  }

  /** Where this instance's own sequence clock stands at `worldClockMs`. */
  cursor(worldClockMs: number): number {
    if (this.current === null) {
      return 0;
    }
    return cursorMs(this.law, worldClockMs - this.armedAtMs, this.periodMs);
  }

  /** Has the current one-shot or loop reached the end of its play window? */
  windowElapsed(worldClockMs: number): boolean {
    if (this.current === null || this.periodMs <= 0) {
      return false;
    }
    return worldClockMs - this.armedAtMs >= this.periodMs;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/instance-anim"`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/instance-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/instance-anim.test.ts
git commit -m "feat(m2): clock-indexed per-placement animation instance"
```

---

### Task 9: Bone evaluation — lazy, parent-first

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/instance-anim.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/instance-anim.test.ts`
- Modify: `client/src/game/pipeline/m2/anim/model-anim.ts` (expose bone defs)

**Interfaces:**
- Consumes: `sampleVec3`, `sampleQuat`, `trackFor`, `isStep` from Tasks 2–3
- Produces:
  - `ModelAnim.boneDefs: any[]`
  - `InstanceAnim.palette: Float32Array` (16 floats per bone)
  - `InstanceAnim.solveBones(worldClockMs: number): number` — returns bones solved

- [ ] **Step 1: Write the failing test**

Append to `__tests__/instance-anim.test.ts`:

```ts
import * as THREE from 'three';

const emptyBlock = () => ({ interpolationType: 1, globalSequenceID: -1, tracks: [] });
const vec3Block = (values: number[][]) => ({
  interpolationType: 1,
  globalSequenceID: -1,
  tracks: [{ animationIndex: 0, timestamps: [0, 1000], values }],
});
const bone = (over: any = {}) => ({
  parentID: -1, flags: 0, keyBoneID: -1, pivotPoint: [0, 0, 0],
  translation: emptyBlock(), rotation: emptyBlock(), scaling: emptyBlock(), ...over,
});

const matrixOf = (inst: InstanceAnim, index: number) =>
  new THREE.Matrix4().fromArray(inst.palette, index * 16);

describe('solveBones', () => {
  it('produces identity for an unanimated bone', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(0);
    expect(matrixOf(inst, 0).equals(new THREE.Matrix4())).toBe(true);
  });

  it('applies a translated bone at the sampled cursor', () => {
    const m = model({
      bones: [bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(500);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 0));
    expect(p.x).toBeCloseTo(5, 4);
  });

  it('composes a child onto its parent', () => {
    const m = model({
      bones: [
        bone({ translation: vec3Block([[0, 0, 0], [10, 0, 0]]) }),
        bone({ parentID: 0, translation: vec3Block([[0, 0, 0], [0, 4, 0]]) }),
      ],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    inst.solveBones(1000);
    const p = new THREE.Vector3().setFromMatrixPosition(matrixOf(inst, 1));
    expect(p.x).toBeCloseTo(10, 4);
    expect(p.y).toBeCloseTo(4, 4);
  });

  it('solves each bone exactly once however many children request it', () => {
    const m = model({
      bones: [bone(), bone({ parentID: 0 }), bone({ parentID: 0 }), bone({ parentID: 1 })],
    });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    expect(inst.solveBones(0)).toBe(4);
  });

  it('allocates no new palette between frames', () => {
    const m = model({ bones: [bone()] });
    const inst = new InstanceAnim(m);
    inst.arm(m.sequences[0], 0);
    const first = inst.palette;
    inst.solveBones(0);
    inst.solveBones(16);
    expect(inst.palette).toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/instance-anim"`
Expected: FAIL — `inst.solveBones is not a function`

- [ ] **Step 3: Expose bone defs on `ModelAnim`**

In `model-anim.ts`, add the field and assign it in the constructor:

```ts
  /** Parsed bone defs, file order. A vertex's bone indices index this list. */
  readonly boneDefs: any[];
```

```ts
    this.boneDefs = data.bones || [];
```

- [ ] **Step 4: Write the bone solver**

Add to `instance-anim.ts`. Imports first:

```ts
import * as THREE from 'three';
import { isStep, sampleQuat, sampleVec3, trackFor } from './tracks';
```

Module-level scratch objects — the solver runs per bone per instance per frame and must not allocate:

```ts
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchPivot = new THREE.Vector3();
const scratchLocal = new THREE.Matrix4();
const scratchPivotTo = new THREE.Matrix4();
const scratchPivotBack = new THREE.Matrix4();
```

Fields on `InstanceAnim`:

```ts
  /** Bone world matrices, 16 floats each, model space. Allocated once. */
  readonly palette: Float32Array;

  /** Per-bone "already solved this frame" flags, cleared at the top of each solve. */
  private readonly solved: Uint8Array;

  /** Scratch matrices, one per bone, so composition never allocates. */
  private readonly matrices: THREE.Matrix4[] = [];
```

Constructor additions, after `this.model = model;`:

```ts
    const boneCount = model.boneDefs.length;
    this.palette = new Float32Array(boneCount * 16);
    this.solved = new Uint8Array(boneCount);
    for (let i = 0; i < boneCount; ++i) {
      this.matrices.push(new THREE.Matrix4());
    }
```

Methods:

```ts
  /**
   * Solve every bone into `palette` and return how many were solved.
   *
   * Lazy and parent-first, following WebWoWViewer's `calcBones`: a bone is solved at most once per
   * frame however many children ask for it, and the recursion means an unanimated branch costs one
   * flag check rather than a matrix compose.
   */
  solveBones(worldClockMs: number): number {
    const count = this.model.boneDefs.length;
    this.solved.fill(0);

    for (let i = 0; i < count; ++i) {
      this.solveBone(i, worldClockMs);
    }

    for (let i = 0; i < count; ++i) {
      this.matrices[i].toArray(this.palette, i * 16);
    }

    return count;
  }

  private solveBone(index: number, worldClockMs: number): void {
    if (this.solved[index]) {
      return;
    }
    // Marked BEFORE recursing: a malformed parent cycle would otherwise recurse until the stack
    // blows, and a cycle in shipped data should degrade to a wrong pose, not a crash.
    this.solved[index] = 1;

    const def = this.model.boneDefs[index];
    const seqIndex = this.current ? this.current.index : 0;
    const t = this.cursor(worldClockMs);

    scratchPos.set(0, 0, 0);
    scratchQuat.set(0, 0, 0, 1);
    scratchScale.set(1, 1, 1);

    const translation = trackFor(def.translation, seqIndex);
    if (translation) {
      sampleVec3(translation, isStep(def.translation), t, scratchPos);
    }

    const rotation = trackFor(def.rotation, seqIndex);
    if (rotation) {
      sampleQuat(rotation, isStep(def.rotation), t, scratchQuat);
    }

    const scaling = trackFor(def.scaling, seqIndex);
    if (scaling) {
      sampleVec3(scaling, isStep(def.scaling), t, scratchScale);
    }

    // M2 animates AROUND the pivot: translate to the pivot, apply the animated TRS, translate back.
    const pivot = def.pivotPoint;
    scratchPivot.set(pivot[0], pivot[1], pivot[2]);
    scratchPivotTo.makeTranslation(scratchPivot.x, scratchPivot.y, scratchPivot.z);
    scratchPivotBack.makeTranslation(-scratchPivot.x, -scratchPivot.y, -scratchPivot.z);

    scratchLocal.compose(scratchPos, scratchQuat, scratchScale);

    const out = this.matrices[index];
    out.copy(scratchPivotTo).multiply(scratchLocal).multiply(scratchPivotBack);

    if (def.parentID > -1 && def.parentID < this.model.boneDefs.length) {
      this.solveBone(def.parentID, worldClockMs);
      out.premultiply(this.matrices[def.parentID]);
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/instance-anim"`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/anim/instance-anim.ts \
        client/src/game/pipeline/m2/anim/model-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/instance-anim.test.ts
git commit -m "feat(m2): lazy parent-first bone solver into a preallocated palette"
```

---

### Task 10: The variation cycle and its shared RNG

**Files:**
- Create: `client/src/game/pipeline/m2/anim/variation-cycle.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/variation-cycle.test.ts`

**Interfaces:**
- Consumes: `ModelAnim`, `InstanceAnim`
- Produces:
  - `class SharedRng` with `next(): number` (returns `[0, 32767]`), `reset(seed?: number): void`
  - `const sharedRng: SharedRng`
  - `function armDoodad(inst: InstanceAnim, worldClockMs: number, rng?: SharedRng): void`
  - `function cycleDoodad(inst: InstanceAnim, worldClockMs: number, rng?: SharedRng): boolean`

**Reference:** [`doodad_anim.rs:1-45`](../../../samples/benilla/crates/benilla/src/doodad_anim.rs).

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { InstanceAnim } from '../instance-anim';
import { ModelAnim } from '../model-anim';
import { armDoodad, cycleDoodad, SharedRng, sharedRng } from '../variation-cycle';

const animation = (over: any = {}) => ({
  id: 0, subID: 0, length: 1000, flags: 0, probability: 32767,
  blendTime: 0, movementSpeed: 0, nextAnimationID: -1, alias: 0, ...over,
});

const twoVariations = () => new ModelAnim({
  animations: [
    animation({ id: 0, subID: 0, length: 1000, probability: 16000 }),
    animation({ id: 0, subID: 1, length: 700, probability: 16767 }),
  ],
  sequences: [], bones: [],
});

describe('SharedRng', () => {
  it('stays within the client rand() range', () => {
    const rng = new SharedRng(1);
    for (let i = 0; i < 500; ++i) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });

  it('is deterministic from a seed, so tests can assert exact sequences', () => {
    expect(new SharedRng(7).next()).toBe(new SharedRng(7).next());
  });

  it('advances -- consecutive draws differ', () => {
    const rng = new SharedRng(1);
    const a = rng.next();
    const b = rng.next();
    expect(a).not.toBe(b);
  });
});

describe('armDoodad', () => {
  it('arms animation id 0 at the given world time', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 500, new SharedRng(1));
    expect(inst.current!.id).toBe(0);
    expect(inst.armedAtMs).toBe(500);
  });

  it('leaves an instance unarmed when the model owns no animation 0', () => {
    const m = new ModelAnim({ animations: [], sequences: [], bones: [] });
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    expect(inst.current).toBeNull();
  });
});

describe('cycleDoodad', () => {
  it('does not re-arm before the play window elapses', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    const armedAt = inst.armedAtMs;
    expect(cycleDoodad(inst, 500, new SharedRng(1))).toBe(false);
    expect(inst.armedAtMs).toBe(armedAt);
  });

  it('re-arms once the window elapses', () => {
    const m = twoVariations();
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, new SharedRng(1));
    const length = inst.current!.lengthMs;
    expect(cycleDoodad(inst, length + 1, new SharedRng(1))).toBe(true);
    expect(inst.armedAtMs).toBe(length + 1);
  });
});

/**
 * De-sync comes from ONE shared stream drawn consecutively -- not from a per-placement seed.
 * benilla shipped a position hash first: it de-synced correctly but PERMANENTLY, so the Blasted
 * Lands lightning struck from one fixed spot every session (`doodad_anim.rs:37-45`).
 */
describe('de-sync through the shared stream', () => {
  it('gives consecutive instances different variations from one stream', () => {
    const m = twoVariations();
    const rng = new SharedRng(1);
    const picked = new Set<number>();
    for (let i = 0; i < 40; ++i) {
      const inst = new InstanceAnim(m);
      armDoodad(inst, 0, rng);
      picked.add(inst.current!.subId);
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  it('re-arming the same instance can change its variation, so it is not permanent', () => {
    const m = twoVariations();
    const rng = new SharedRng(1);
    const inst = new InstanceAnim(m);
    armDoodad(inst, 0, rng);
    const seen = new Set<number>([inst.current!.subId]);
    let clock = 0;
    for (let i = 0; i < 40; ++i) {
      clock += inst.current!.lengthMs + 1;
      cycleDoodad(inst, clock, rng);
      seen.add(inst.current!.subId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('sharedRng singleton', () => {
  it('exists and produces in-range values', () => {
    sharedRng.reset(1);
    expect(sharedRng.next()).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/variation-cycle"`
Expected: FAIL — `Cannot find module '../variation-cycle'`

- [ ] **Step 3: Write the implementation**

```ts
import { InstanceAnim } from './instance-anim';

/** The doodad arming animation id: Stand. */
const DOODAD_ANIM_ID = 0;

/**
 * The client's single global `rand()` stream -- the MSVC LCG at `0x7400e5`, returning `[0, 32767]`
 * (benilla `doodad_anim.rs:31-35`).
 *
 * ONE shared stream, drawn consecutively, is what de-syncs a stand of identical props. It is
 * deliberately NOT a per-placement seed: benilla shipped a position-derived hash first, and while
 * it de-synced instances correctly it did so PERMANENTLY -- the same placement rolled the same
 * variation on every re-stream and every run, so the Blasted Lands lightning struck from one fixed
 * spot for ever instead of wandering.
 *
 * Seedable only so the tests can be exact; production uses the module singleton.
 */
export class SharedRng {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  reset(seed = 1): void {
    this.state = seed >>> 0;
  }

  /** Next draw in `[0, 32767]`. */
  next(): number {
    // MSVC's LCG: state = state * 214013 + 2531011; result = (state >> 16) & 0x7fff.
    // Math.imul keeps the multiply in 32-bit, which a plain `*` would not.
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
}

/** The one stream every doodad draws from. */
export const sharedRng = new SharedRng(1);

/**
 * Arm a doodad's animation, rolling a fresh frequency-weighted variation.
 *
 * A doodad is NOT "animation 0 on loop". Per benilla (`doodad_anim.rs:4-9`) it is armed at bone 0 /
 * animation id 0 / `linkFlag=1`, and then re-arms itself at every play-window boundary for ever,
 * rolling a new variation each time. Global sequences run underneath with no arming at all.
 */
export function armDoodad(
  inst: InstanceAnim,
  worldClockMs: number,
  rng: SharedRng = sharedRng,
): void {
  const seq = inst.model.pickVariation(DOODAD_ANIM_ID, rng.next());
  if (!seq) {
    return;
  }
  inst.arm(seq, worldClockMs);
}

/**
 * Advance the self-sustaining variation cycle. Returns true if it re-armed this call.
 *
 * Gated on RESIDENCY, not on the draw -- the two gates are deliberately different
 * (`doodad_anim.rs:20-25`). A doodad behind the camera keeps cycling variations; it just stops
 * being posed. Because sampling is clock-indexed, that costs nothing and drifts nothing.
 */
export function cycleDoodad(
  inst: InstanceAnim,
  worldClockMs: number,
  rng: SharedRng = sharedRng,
): boolean {
  if (inst.current === null) {
    armDoodad(inst, worldClockMs, rng);
    return inst.current !== null;
  }
  if (!inst.windowElapsed(worldClockMs)) {
    return false;
  }
  armDoodad(inst, worldClockMs, rng);
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/variation-cycle"`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/variation-cycle.ts \
        client/src/game/pipeline/m2/anim/__tests__/variation-cycle.test.ts
git commit -m "feat(m2): self-sustaining doodad variation cycle on one shared RNG stream"
```

---

### Task 11: Gating — decimation buckets and the bone budget

**Files:**
- Create: `client/src/game/pipeline/m2/anim/gating.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/gating.test.ts`

**Interfaces:**
- Produces:
  - `const NEAR_YD = 40`, `const MID_YD = 120`
  - `function decimationPeriod(distanceYd: number): number`
  - `function shouldPose(instanceId: number, distanceYd: number, frameIndex: number): boolean`
  - `class BoneBudget` with `constructor(limit: number)`, `beginFrame(): void`, `request(bones: number): boolean`, `readonly spent: number`

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { BoneBudget, decimationPeriod, shouldPose } from '../gating';

describe('decimationPeriod', () => {
  it('poses near instances every frame', () => {
    expect(decimationPeriod(0)).toBe(1);
    expect(decimationPeriod(39)).toBe(1);
  });

  it('halves the rate at mid distance', () => {
    expect(decimationPeriod(40)).toBe(2);
    expect(decimationPeriod(119)).toBe(2);
  });

  it('quarters the rate far out', () => {
    expect(decimationPeriod(120)).toBe(4);
    expect(decimationPeriod(1000)).toBe(4);
  });
});

describe('shouldPose', () => {
  it('always poses a near instance', () => {
    for (let f = 0; f < 8; ++f) {
      expect(shouldPose(3, 10, f)).toBe(true);
    }
  });

  it('poses a mid instance every second frame', () => {
    const posed = [0, 1, 2, 3].map((f) => shouldPose(0, 60, f));
    expect(posed).toEqual([true, false, true, false]);
  });

  /**
   * The stagger matters more than the decimation. Bucketing by instance id spreads updates across
   * frames; without it every instance lands on the same frame and the scheme CREATES the spike it
   * was meant to prevent.
   */
  it('staggers instances across frames rather than aligning them', () => {
    const perFrame = [0, 1, 2, 3].map(
      (f) => [0, 1, 2, 3, 4, 5, 6, 7].filter((id) => shouldPose(id, 200, f)).length,
    );
    // Eight instances, period 4: two per frame, never eight on one frame and zero on the rest.
    expect(perFrame).toEqual([2, 2, 2, 2]);
  });
});

describe('BoneBudget', () => {
  it('grants requests until the limit is reached', () => {
    const b = new BoneBudget(100);
    b.beginFrame();
    expect(b.request(40)).toBe(true);
    expect(b.request(40)).toBe(true);
    expect(b.request(40)).toBe(false);
    expect(b.spent).toBe(80);
  });

  it('resets each frame', () => {
    const b = new BoneBudget(100);
    b.beginFrame();
    b.request(100);
    expect(b.request(1)).toBe(false);
    b.beginFrame();
    expect(b.request(1)).toBe(true);
  });

  it('always grants the first request, however large, so a heavy model is never frozen', () => {
    const b = new BoneBudget(10);
    b.beginFrame();
    expect(b.request(500)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/gating"`
Expected: FAIL — `Cannot find module '../gating'`

- [ ] **Step 3: Write the implementation**

```ts
/** Below this, pose every frame. */
export const NEAR_YD = 40;
/** Below this, pose every second frame; beyond it, every fourth. */
export const MID_YD = 120;

/** How many frames apart an instance at this distance is re-posed. */
export function decimationPeriod(distanceYd: number): number {
  if (distanceYd < NEAR_YD) {
    return 1;
  }
  return distanceYd < MID_YD ? 2 : 4;
}

/**
 * Whether this instance is posed on this frame.
 *
 * The modulo is taken on `frameIndex + instanceId` rather than `frameIndex` alone, and that stagger
 * is the whole point. Decimating without it means every instance shares one phase: three frames
 * cost nothing and the fourth poses the entire set at once, which is a WORSE worst-frame number
 * than never decimating at all. The headline metric here is worst frame, not average.
 *
 * Holding the previous palette between poses is safe because sampling is clock-indexed -- a stale
 * pose is a slightly old pose, never a drifting one. See `InstanceAnim`.
 */
export function shouldPose(instanceId: number, distanceYd: number, frameIndex: number): boolean {
  const period = decimationPeriod(distanceYd);
  if (period === 1) {
    return true;
  }
  return (frameIndex + instanceId) % period === 0;
}

/**
 * A hard per-frame ceiling on bone evaluations, spent in caller-chosen priority order.
 *
 * This is the backstop that actually protects the worst-frame number. Rounding a corner into a
 * dense city is exactly when the animated-instance count jumps, and exactly when a scheme tuned
 * against an average fails. Instances denied a grant hold last frame's pose for a frame.
 */
export class BoneBudget {
  readonly limit: number;
  spent = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  beginFrame(): void {
    this.spent = 0;
  }

  /**
   * Request `bones` evaluations. Returns whether the caller may proceed.
   *
   * The first request of a frame is always granted, whatever its size: a single model with more
   * bones than the whole budget would otherwise never animate at all, which reads as a broken model
   * rather than a busy frame.
   */
  request(bones: number): boolean {
    if (this.spent === 0) {
      this.spent += bones;
      return true;
    }
    if (this.spent + bones > this.limit) {
      return false;
    }
    this.spent += bones;
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/gating"`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/anim/gating.ts \
        client/src/game/pipeline/m2/anim/__tests__/gating.test.ts
git commit -m "feat(m2): phase-staggered decimation and a hard per-frame bone budget"
```

---

### Task 12: Remove the mixer from `M2`

The single risky integration point. Everything before this was additive; this deletes the old path.

**Files:**
- Delete: `client/src/game/pipeline/m2/animation-manager.js`
- Modify: `client/src/game/pipeline/m2/index.ts:121-137, 254-294, 575-671`
- Modify: `client/src/game/pipeline/m2/material/index.ts:496-560`
- Modify: `client/src/game/pipeline/m2/blueprint.js`

**Interfaces:**
- Consumes: `ModelAnim`, `InstanceAnim`, `classify`
- Produces: `M2.modelAnim: ModelAnim`, `M2.instanceAnim: InstanceAnim | null`, `M2Blueprint.modelAnims: Map<string, ModelAnim>`

- [ ] **Step 1: Replace the animation manager in `M2`**

In `client/src/game/pipeline/m2/index.ts`, remove the `AnimationManager` import and replace the block at lines 121-137:

```ts
    // Per-model animation data is shared across every placement -- built once by M2Blueprint and
    // handed in, never rebuilt per clone. The old AnimationManager was shared the same way, but
    // createSkeleton() below then registered THIS clone's bone tracks into it, so every placement
    // appended its own copy of every track to the shared clips. That is the bug that got the whole
    // animation system commented out; ModelAnim holds keyframes and nothing placement-specific.
    this.modelAnim = instance && instance.modelAnim
      ? instance.modelAnim
      : new ModelAnim(data);

    this.animated = this.modelAnim.animated;
    this.instanceAnim = this.animated ? new InstanceAnim(this.modelAnim) : null;
```

Add the import:

```ts
import { InstanceAnim } from './anim/instance-anim';
import { ModelAnim } from './anim/model-anim';
```

Update the class field declarations near line 61, replacing `animationManager: AnimationManager;`:

```ts
  modelAnim: ModelAnim;
  instanceAnim: InstanceAnim | null;
```

Remove `receivesAnimationUpdates` entirely — the blueprint no longer drives shared managers, so the flag has nothing to guard.

- [ ] **Step 2: Delete the eight `registerTrack` call sites**

In `index.ts`, delete the three `this.animationManager.registerTrack({...})` blocks inside `createSkeleton` (lines 254-294) — bone TRS is now read directly from `modelAnim.boneDefs` by the solver.

In `createUVAnimations`, `createTransparencyAnimations` and `createVertexColorAnimations` (lines 575-671), delete every `registerTrack` call and the `animationManager.on('update', updater)` subscription plus its `eventListeners.push`. Keep the default-value initialisation of `uvAnimationValues`, `transparencyAnimationValues` and `vertexColorAnimationValues` — Task 14 writes into those.

- [ ] **Step 3: Delete the material subscriptions**

In `client/src/game/pipeline/m2/material/index.ts`, delete `registerUVAnimations`, `registerTransparencyAnimation` and `registerVertexColorAnimation` (lines 496-560) and the `registerAnimations` method that calls them. Their subscriptions were already commented out; the subscription model is what was wrong, so they are removed rather than restored. Task 14 replaces them with an `onBeforeRender` push.

- [ ] **Step 4: Move the `ModelAnim` cache into the blueprint**

In `client/src/game/pipeline/m2/blueprint.js`, replace `animationUpdateTargets` with a `ModelAnim` cache and rewrite `animate`:

```js
  static modelAnims = new Map();
```

In `load`, inside the `.then((args) => {...})`, after `const m2 = new M2(path, data, skinData);`:

```js
        this.modelAnims.set(path, m2.modelAnim);
```

Replace `animate(delta)` entirely:

```js
  /**
   * Global sequences advance on world time alone -- there is nothing per-instance to tick here.
   * The old `animate(delta)` walked every loaded model to push a delta into a shared
   * AnimationMixer; instances now read `worldClockMs` directly, so this method is gone. Instance
   * posing lives in `WorldMap#animate` via `DoodadManager`.
   */
```

Remove `animationUpdateTargets.delete(path)` from `backgroundUnload` and add `this.modelAnims.delete(path)`.

- [ ] **Step 5: Delete the animation manager**

```bash
git rm client/src/game/pipeline/m2/animation-manager.js
```

- [ ] **Step 6: Fix the remaining callers so the build passes**

Three files still reference `animationManager`. Make them compile; Tasks 13 and 16 give them real behaviour.

`client/src/game/world/doodad-manager.js:144-155` — replace the body of `enableDoodadAnimations`:

```js
  enableDoodadAnimations(entry, doodad) {
    // Maintain separate entries for animated doodads to avoid excessive iterations on each
    // call to animate() during the render loop.
    this.animatedDoodads.set(entry.id, doodad);
  }
```

`client/src/game/world/index.ts:447-449` — remove the `model.receivesAnimationUpdates` block from `animateEntities`.

`client/src/game/classes/unit.ts:296-297, 310-313` — comment out the `playAnimation`/`playAllSequences`/`currentAnimation` uses with a `// Task 16:` marker.

- [ ] **Step 7: Verify the whole suite still passes and the app builds**

Run: `cd client && CI=true npm test`
Expected: PASS — no suite references `animation-manager`.

Run: `cd client && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add -A client/src/game/pipeline/m2 client/src/game/world client/src/game/classes
git commit -m "refactor(m2): remove the AnimationMixer path in favour of the evaluator"
```

---

### Task 13: Drive doodad instances from the world

**Files:**
- Modify: `client/src/game/world/doodad-manager.js:241-260`
- Modify: `client/src/game/world/index.ts:415-430`

**Interfaces:**
- Consumes: `cycleDoodad`, `shouldPose`, `BoneBudget`, `animCounters`
- Produces: `DoodadManager.animate(delta, camera, cameraMoved)` posing instances

- [ ] **Step 1: Add the world clock and frame index to `DoodadManager`**

In `client/src/game/world/doodad-manager.js`, add to the constructor:

```js
    // World clock, ms. Instances are CLOCK-INDEXED, not delta-accumulated -- see InstanceAnim.
    this.worldClockMs = 0;
    this.frameIndex = 0;
    this.boneBudget = new BoneBudget(gameSettings.m2.boneBudgetPerFrame);
```

Add the imports:

```js
import { BoneBudget, shouldPose } from '../pipeline/m2/anim/gating';
import { cycleDoodad } from '../pipeline/m2/anim/variation-cycle';
import { animCounters } from '../pipeline/m2/anim/counters';
```

- [ ] **Step 2: Add the budget setting**

In `client/src/game/settings.js` (or wherever `gameSettings.m2` is defined), add to the `m2` block:

```js
    // Hard ceiling on bone evaluations per frame. Instances beyond it hold last frame's pose.
    // Sized against the 16.67 ms budget; tune from the HUD's animBonesSolved row.
    boneBudgetPerFrame: 4000,
```

- [ ] **Step 3: Rewrite `DoodadManager#animate`**

```js
  animate(delta, camera, cameraMoved) {
    this.worldClockMs += delta * 1000;
    this.frameIndex++;
    this.boneBudget.beginFrame();

    const cameraPosition = camera.position;

    this.animatedDoodads.forEach((doodad, id) => {
      const inst = doodad.instanceAnim;
      if (!inst) {
        return;
      }

      animCounters.resident++;

      // RESIDENCY gate: the variation cycle runs for every loaded doodad, drawn or not. Deliberately
      // separate from the pose gate below -- benilla `doodad_anim.rs:20-25`. A doodad behind the
      // camera keeps cycling; it just stops being posed.
      cycleDoodad(inst, this.worldClockMs);

      // DRAW gate: only what is actually visible gets posed.
      if (!doodad.visible) {
        animCounters.skipped++;
        return;
      }

      const distanceYd = cameraPosition.distanceTo(doodad.position);
      if (!shouldPose(id, distanceYd, this.frameIndex)) {
        animCounters.skipped++;
        return;
      }

      if (!this.boneBudget.request(inst.model.boneDefs.length)) {
        animCounters.skipped++;
        return;
      }

      animCounters.posed++;
      animCounters.bonesSolved += inst.solveBones(this.worldClockMs);
      doodad.uploadPalette();

      if (cameraMoved && doodad.billboards.length > 0) {
        doodad.applyBillboards(camera);
      }
    });
  }
```

- [ ] **Step 4: Add `uploadPalette` to `M2`**

In `client/src/game/pipeline/m2/index.ts`:

```ts
  /**
   * Copy this instance's solved palette into the three.js skeleton and flag the bone texture.
   *
   * Only called for instances that were actually posed this frame, so a gated doodad costs no
   * upload at all.
   */
  uploadPalette() {
    if (!this.instanceAnim || !this.skeleton) {
      return;
    }
    this.skeleton.boneMatrices.set(this.instanceAnim.palette);
    if (this.skeleton.boneTexture) {
      this.skeleton.boneTexture.needsUpdate = true;
    }
    animCounters.paletteUploads++;
  }
```

Add the import:

```ts
import { animCounters } from './anim/counters';
```

- [ ] **Step 5: Delete the redundant scene-graph walk**

In `client/src/game/world/index.ts`, delete the `map.doodadManager` and `map.wmoManager` blocks from `updateDynamicMatrices` (lines 418-430).

Leave this comment in their place:

```ts
    // Animated doodads are NOT walked here any more. The evaluator computes bone world matrices
    // itself, parent-first, and writes them straight into the skeleton palette -- having three.js
    // re-walk the same hierarchy per animated doodad per frame was doing the identical work twice.
```

- [ ] **Step 6: Verify**

Run: `cd client && CI=true npm test`
Expected: PASS

Run: `cd client && npm run build`
Expected: succeeds.

Run the app and load a zone with visible flags or torches (Elwynn Forest, Goldshire).
Expected: doodads animate. The HUD shows non-zero `animResident`, `animPosed` and `animBonesSolved`.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/world/doodad-manager.js \
        client/src/game/world/index.ts \
        client/src/game/pipeline/m2/index.ts \
        client/src/game/settings.js
git commit -m "feat(world): pose animated doodads through the evaluator with both gates"
```

---

### Task 14: Per-instance material values via `onBeforeRender`

**Files:**
- Modify: `client/src/game/pipeline/m2/submesh.js:18-29, 60-95`
- Modify: `client/src/game/pipeline/m2/index.ts` (UV/transparency/colour evaluation)

**Interfaces:**
- Consumes: `InstanceAnim`, `ModelAnim.globalSequenceCursor`
- Produces: `M2.evaluateMaterialChannels(worldClockMs: number): void`; `applyAnimatedUniformsBeforeRender` in `submesh.js`

**Why not a subscription:** M2 materials are cached and shared across every placement ([`submesh.js:9-13`](../../../client/src/game/pipeline/m2/submesh.js)). Writing per-instance values from a per-doodad loop means whichever placement wrote last wins for all of them. The existing `applyFadeAlphaBeforeRender` in the same file already solves exactly this for distance-fade alpha; this follows it.

- [ ] **Step 1: Evaluate the channels on the instance**

In `client/src/game/pipeline/m2/index.ts`, add:

```ts
  /**
   * Sample this placement's UV, transparency and vertex-colour channels into its own value arrays.
   *
   * Global-sequence channels read their cursor from `modelAnim` -- one evaluation shared by every
   * placement -- while sequence channels read this instance's own clock.
   */
  evaluateMaterialChannels(worldClockMs: number) {
    const inst = this.instanceAnim;
    if (!inst) {
      return;
    }

    const seqIndex = inst.current ? inst.current.index : 0;
    const seqCursor = inst.cursor(worldClockMs);

    const cursorFor = (block) =>
      block.globalSequenceID > -1
        ? this.modelAnim.globalSequenceCursor(block.globalSequenceID, worldClockMs)
        : seqCursor;

    for (let i = 0, len = this.uvAnimationDefs.length; i < len; ++i) {
      const def = this.uvAnimationDefs[i];
      const value = this.uvAnimationValues[i];
      const track = trackFor(def.translation, seqIndex);
      if (track) {
        sampleVec3(track, isStep(def.translation), cursorFor(def.translation), scratchUVTranslation);
      } else {
        scratchUVTranslation.set(0, 0, 0);
      }
      // Written in place: `value.matrix` is allocated once at construction. The old code did
      // `new THREE.Matrix4()` per animation per frame, which is per-frame garbage, and GC pauses
      // land squarely on the worst-frame metric this whole plan is judged by.
      value.matrix.makeTranslation(
        scratchUVTranslation.x, scratchUVTranslation.y, scratchUVTranslation.z,
      );
    }

    for (let i = 0, len = this.transparencyAnimationDefs.length; i < len; ++i) {
      const def = this.transparencyAnimationDefs[i];
      const track = trackFor(def, seqIndex);
      this.transparencyAnimationValues[i] = track
        ? sampleScalar(track, isStep(def), cursorFor(def), 1.0)
        : 1.0;
    }

    for (let i = 0, len = this.vertexColorAnimationDefs.length; i < len; ++i) {
      const def = this.vertexColorAnimationDefs[i];
      const value = this.vertexColorAnimationValues[i];
      const colorTrack = trackFor(def.color, seqIndex);
      if (colorTrack) {
        sampleVec3(colorTrack, isStep(def.color), cursorFor(def.color), scratchColor);
        value.color[0] = scratchColor.x;
        value.color[1] = scratchColor.y;
        value.color[2] = scratchColor.z;
      }
      const alphaTrack = trackFor(def.alpha, seqIndex);
      value.alpha = alphaTrack
        ? sampleScalar(alphaTrack, isStep(def.alpha), cursorFor(def.alpha), 1.0)
        : 1.0;
    }
  }
```

Add module-level scratch objects near the top of `index.ts`:

```ts
const scratchUVTranslation = new THREE.Vector3();
const scratchColor = new THREE.Vector3();
```

Add the imports:

```ts
import { isStep, sampleScalar, sampleVec3, trackFor } from './anim/tracks';
```

Store the defs during construction so the evaluator can reach them — in `createUVAnimations`, `createTransparencyAnimations` and `createVertexColorAnimations`, assign `this.uvAnimationDefs = uvAnimationDefs;` and the equivalents, defaulting each to `[]` in the constructor.

- [ ] **Step 2: Call it from the pose path**

In `client/src/game/world/doodad-manager.js#animate`, after `inst.solveBones(...)`:

```js
      doodad.evaluateMaterialChannels(this.worldClockMs);
```

- [ ] **Step 3: Push the values at draw time**

In `client/src/game/pipeline/m2/submesh.js`, add beside `applyFadeAlphaBeforeRender`:

```js
/**
 * Push the owning placement's animated UV / transparency / vertex-colour values into the shared
 * material, immediately before this batch is drawn.
 *
 * Same reason as `applyFadeAlphaBeforeRender` directly above: M2 materials are cached and shared
 * across every placement, so writing these from a per-doodad loop would leave every placement
 * rendering with whichever one happened to write last. `onBeforeRender` is the per-draw seam.
 *
 * It is also cheaper -- a culled batch never pays for the write at all.
 */
function applyAnimatedUniformsBeforeRender(_renderer, _scene, _camera, _geometry, material) {
  if (!material || !material.uniforms) {
    return;
  }

  let node = this;
  while (node && node.uvAnimationValues === undefined) {
    node = node.parent;
  }
  if (!node) {
    return;
  }

  const def = material.animationDef;
  if (!def) {
    return;
  }

  const { uniforms } = material;

  if (uniforms.animatedUVs && def.uvAnimationIndices) {
    for (let i = 0, len = def.uvAnimationIndices.length; i < len; ++i) {
      const source = node.uvAnimationValues[def.uvAnimationIndices[i]];
      if (source) {
        uniforms.animatedUVs.value[i] = source.matrix;
      }
    }
  }

  if (uniforms.animatedTransparency && def.transparencyAnimationIndex >= 0) {
    const value = node.transparencyAnimationValues[def.transparencyAnimationIndex];
    if (value !== undefined) {
      uniforms.animatedTransparency.value = value;
    }
  }

  if (uniforms.animatedVertexColorRGB && def.vertexColorAnimationIndex >= 0) {
    const source = node.vertexColorAnimationValues[def.vertexColorAnimationIndex];
    if (source) {
      uniforms.animatedVertexColorRGB.value = source.color;
      uniforms.animatedVertexColorAlpha.value = source.alpha;
    }
  }
}
```

In `applyBatches`, chain both handlers rather than overwriting the fade one:

```js
      batchMesh.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
        applyFadeAlphaBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
        applyAnimatedUniformsBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
      };
```

- [ ] **Step 4: Carry the animation def onto the material**

In `client/src/game/pipeline/m2/material/index.ts`, in the constructor where `registerAnimations(def)` used to be called, store the def instead:

```ts
    // Read per-draw by `applyAnimatedUniformsBeforeRender`. Stored rather than subscribed: the
    // material is shared across placements, so it cannot hold any placement's values itself.
    this.animationDef = {
      uvAnimationIndices: def.uvAnimationIndices || [],
      transparencyAnimationIndex: def.transparencyAnimationIndex ?? -1,
      vertexColorAnimationIndex: def.vertexColorAnimationIndex ?? -1,
    };
```

- [ ] **Step 5: Verify**

Run: `cd client && CI=true npm test && npm run build`
Expected: PASS, build succeeds.

Run the app in a zone with a water wheel or scrolling-texture doodad.
Expected: UV scroll animates, and two placements of the same model do not share one placement's values.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/submesh.js \
        client/src/game/pipeline/m2/index.ts \
        client/src/game/pipeline/m2/material/index.ts \
        client/src/game/world/doodad-manager.js
git commit -m "fix(m2): push per-placement animated uniforms at draw time, not by subscription"
```

---

### Task 15: Per-submesh skinning

**Files:**
- Modify: `client/src/game/pipeline/m2/index.ts:100-104, 211-310, 530-560`
- Modify: `client/src/game/pipeline/m2/submesh.js:33-95`
- Create: `client/src/game/pipeline/m2/anim/__tests__/skinning-scope.test.ts`

**Interfaces:**
- Produces: `function submeshBoneSet(submeshDef: any, skinData: any): Set<number>`; `function needsSkinning(boneCount: number): boolean`

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { needsSkinning } from '../../anim/skinning-scope';

describe('needsSkinning', () => {
  it('is false for a submesh riding exactly one bone', () => {
    expect(needsSkinning(1)).toBe(false);
  });

  it('is false for a submesh riding no bones at all', () => {
    expect(needsSkinning(0)).toBe(false);
  });

  it('is true as soon as two bones are involved', () => {
    expect(needsSkinning(2)).toBe(true);
    expect(needsSkinning(40)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="skinning-scope"`
Expected: FAIL — `Cannot find module '../../anim/skinning-scope'`

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/anim/skinning-scope.ts`:

```ts
/**
 * Whether a submesh needs GPU skinning, decided PER SUBMESH.
 *
 * `M2#useSkinning` was model-global: one animated bone anywhere forced every submesh of the model
 * onto `THREE.SkinnedMesh`, a skinning shader and a bone texture. Most animated doodad submeshes
 * ride exactly one bone -- a flag, a windmill blade, a swinging sign -- and for those the bone's
 * matrix is simply the submesh's transform.
 *
 * A zero-bone submesh is static and needs nothing either.
 */
export function needsSkinning(boneCount: number): boolean {
  return boneCount > 1;
}

/** The distinct bones a submesh's vertices are weighted to. */
export function submeshBoneSet(submeshDef: any, skinData: any): Set<number> {
  const bones = new Set<number>();
  const start = submeshDef.vertexStart;
  const end = start + submeshDef.vertexCount;

  for (let i = start; i < end; ++i) {
    const vertexIndex = skinData.vertices[i];
    const vertex = skinData.m2Vertices ? skinData.m2Vertices[vertexIndex] : null;
    if (!vertex) {
      continue;
    }
    for (let b = 0; b < 4; ++b) {
      if (vertex.boneWeights[b] > 0) {
        bones.add(vertex.boneIndices[b]);
      }
    }
  }

  return bones;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="skinning-scope"`
Expected: PASS (3 tests)

- [ ] **Step 5: Use it in `createSubmeshes`**

In `client/src/game/pipeline/m2/index.ts`, where each `Submesh` is constructed, compute the bone set and pass a per-submesh flag instead of `this.useSkinning`:

```ts
      const boneSet = submeshBoneSet(submeshDef, skinData);
      const submeshSkinned = this.animated && needsSkinning(boneSet.size);
      const soleBone = boneSet.size === 1 ? boneSet.values().next().value : -1;
```

Pass `useSkinning: submeshSkinned` and `soleBoneIndex: soleBone` into the `Submesh` options.

- [ ] **Step 6: Honour the single-bone path in `Submesh`**

In `client/src/game/pipeline/m2/submesh.js`, store `this.soleBoneIndex = opts.soleBoneIndex ?? -1;` in the constructor, and add:

```js
  /**
   * Drive a single-bone submesh from its one bone's palette entry.
   *
   * No skeleton, no bone texture, no skinning shader -- the bone's world matrix IS this submesh's
   * transform. This is the common shape for animated doodads and it is why `useSkinning` had to
   * stop being model-global.
   */
  applySoleBone(palette) {
    if (this.soleBoneIndex < 0) {
      return;
    }
    this.matrix.fromArray(palette, this.soleBoneIndex * 16);
    this.matrix.decompose(this.position, this.quaternion, this.scale);
  }
```

- [ ] **Step 7: Call it from the pose path**

In `client/src/game/pipeline/m2/index.ts`, add to `uploadPalette`, before the skeleton copy:

```ts
    for (let i = 0, len = this.submeshes.length; i < len; ++i) {
      const submesh = this.submeshes[i];
      if (submesh.soleBoneIndex >= 0) {
        submesh.applySoleBone(this.instanceAnim.palette);
      }
    }
```

- [ ] **Step 8: Verify**

Run: `cd client && CI=true npm test && npm run build`
Expected: PASS, build succeeds.

Run the app in Goldshire. Expected: flags and signs still animate; the HUD's `animBonesSolved` is unchanged but `programs` drops, since fewer materials compile a skinning variant.

- [ ] **Step 9: Commit**

```bash
git add client/src/game/pipeline/m2/anim/skinning-scope.ts \
        client/src/game/pipeline/m2/anim/__tests__/skinning-scope.test.ts \
        client/src/game/pipeline/m2/index.ts \
        client/src/game/pipeline/m2/submesh.js
git commit -m "perf(m2): decide skinning per submesh so single-bone parts skip it entirely"
```

---

### Task 16: WMO doodads and units

**Files:**
- Modify: `client/src/game/pipeline/wmo/index.js:266-274, 628-660`
- Modify: `client/src/game/classes/unit.ts:290-340`

- [ ] **Step 1: Enable WMO doodad animation**

In `client/src/game/pipeline/wmo/index.js`, replace the commented block at lines 266-274:

```js
    // WMO doodads animate identically to terrain doodads. The split only ever existed because the
    // two call sites were disabled at different times.
    if (doodad.animated) {
      this.animatedDoodads.set(doodadEntry.id, doodad);
    }
```

- [ ] **Step 2: Pose them in `WMO#animate`**

In the same file's `animate(delta, camera, cameraMoved)` (line 628), add:

```js
    this.worldClockMs += delta * 1000;
    this.frameIndex++;

    this.animatedDoodads.forEach((doodad, id) => {
      const inst = doodad.instanceAnim;
      if (!inst) {
        return;
      }

      animCounters.resident++;
      cycleDoodad(inst, this.worldClockMs);

      if (!doodad.visible) {
        animCounters.skipped++;
        return;
      }

      const distanceYd = camera.position.distanceTo(doodad.position);
      if (!shouldPose(id, distanceYd, this.frameIndex)) {
        animCounters.skipped++;
        return;
      }

      animCounters.posed++;
      animCounters.bonesSolved += inst.solveBones(this.worldClockMs);
      doodad.evaluateMaterialChannels(this.worldClockMs);
      doodad.uploadPalette();

      if (cameraMoved && doodad.billboards.length > 0) {
        doodad.applyBillboards(camera);
      }
    });
```

Initialise `this.worldClockMs = 0;` and `this.frameIndex = 0;` in the constructor, and add the same three imports used in Task 13.

- [ ] **Step 3: Route units through `resolve`**

In `client/src/game/classes/unit.ts`, replace the commented-out Task 12 markers around line 296:

```ts
      // Resolve through the model's own sequence table rather than indexing it raw: a unit asked
      // for an animation its model lacks should fall back to Stand, not freeze in bind pose.
      const seq = m2.modelAnim.resolve(this.currentAnimationId);
      if (seq && m2.instanceAnim) {
        m2.instanceAnim.arm(seq, this.worldClockMs);
      }
```

Replace `this.currentAnimationIndex` with `this.currentAnimationId` throughout the class, and remove the `currentAnimation?.isRunning()` block at lines 310-313 — one-shot completion is now `instanceAnim.windowElapsed(worldClockMs)`:

```ts
    const finished = this.model.instanceAnim?.windowElapsed(this.worldClockMs) ?? false;
```

- [ ] **Step 4: Pose units in `animateEntities`**

In `client/src/game/world/index.ts`, replace the body of the `entities.forEach` in `animateEntities`:

```ts
      entity.update(delta);

      const inst = model.instanceAnim;
      if (inst) {
        animCounters.resident++;
        animCounters.posed++;
        animCounters.bonesSolved += inst.solveBones(this.worldClockMs);
        model.evaluateMaterialChannels(this.worldClockMs);
        model.uploadPalette();
      }

      if (cameraMoved && model.billboards.length > 0) {
        model.applyBillboards(camera);
      }
```

Units are never decimated or budget-gated: there are few of them, they are the objects the player looks at directly, and a held pose on a moving creature reads immediately as a stutter in a way it never does on a distant flag.

Add `this.worldClockMs = 0;` to the `World` constructor and `this.worldClockMs += delta * 1000;` at the top of `animate`.

- [ ] **Step 5: Verify**

Run: `cd client && CI=true npm test && npm run build`
Expected: PASS, build succeeds.

Run the app and enter a WMO interior with animated props (Stormwind's Trade District buildings, any inn).
Expected: interior doodads animate; nearby creatures animate.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/wmo/index.js \
        client/src/game/classes/unit.ts \
        client/src/game/world/index.ts
git commit -m "feat(anim): animate WMO doodads and units through the evaluator"
```

---

> **Tasks 17–21 were rewritten on 2026-08-04 after the probe originally scheduled as Task 17 was
> run headlessly by the controller.** The asset host answers `curl`, so three real creature models
> (`wolf`, `murloc`, `kobold`) were fetched and parsed with the project's own parser. Four findings
> forced a re-plan:
>
> 1. **`.anim` naming confirmed:** `<stem><animId:04d>-<subId:02d>.anim`, lowercase.
>    `creature/wolf/wolf0097-00.anim` → 200; every other spelling 404s.
> 2. **Quaternion range confirmed:** 203,524 components, min `-1.00000`, max `1.00003`, zero
>    non-finite. `sampleQuat` needs no decode step. Task 3 Step 6 is closed.
> 3. **Locomotion is INLINE, not external.** Wolf Stand/Walk/Run are all flagged `0x20`; murloc has
>    zero external sequences. External ids observed are 96–101, 69, 128, 62 — emotes and specials.
>    The spec's claim that locomotion lives in `.anim` files is **false for 3.3.5a**.
> 4. **External sequences parse as GARBAGE, not empty** — a live bug, not a gap. See Task 17.

---

### Task 17: Quarantine external sequences

The spec assumed a sequence with no inline data parses as empty. It does not: the animation block's
offsets point into the `.anim` file and are read against the `.m2` buffer, yielding plausible-looking
arrays of noise. Measured: **302** bone-tracks on `wolf.m2` and **130** on `kobold.m2` carry
timestamps far past their sequence length — slot 19 (id 97, length 2000 ms) holds a timestamp of
3,197,923,783 ms.

This is reachable in normal play. `unit.ts` arms whatever id the SMSG handler supplies, and
`ModelAnim#resolve` returns an external sequence when the model declares that id.

**Files:**
- Modify: `client/src/game/pipeline/m2/anim/model-anim.ts`
- Modify: `client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts`

**Interfaces:**
- Produces: `function hasInlineData(flags: number): boolean`; `Sequence.inline: boolean`

- [ ] **Step 1: Write the failing tests**

```ts
describe('hasInlineData', () => {
  it('is true when any of 0x10 / 0x20 / 0x100 is set', () => {
    expect(hasInlineData(0x20)).toBe(true);   // wolf Stand/Walk/Run
    expect(hasInlineData(0x21)).toBe(true);
    expect(hasInlineData(0x10)).toBe(true);
    expect(hasInlineData(0x100)).toBe(true);
  });

  it('is false for the external flag values observed in real data', () => {
    // wolf ids 97/96/98/100/99/101, kobold id 62 -- measured, not invented.
    [0, 1, 3, 5, 8].forEach((f) => expect(hasInlineData(f)).toBe(false));
  });
});

describe('external sequences are quarantined', () => {
  const seqs = [
    animation({ id: 0, flags: 0x20 }),
    animation({ id: 97, flags: 0 }),
  ];

  it('marks each sequence with whether its data is inline', () => {
    const m = new ModelAnim(data({ animations: seqs }));
    expect(m.sequences.map((s) => s.inline)).toEqual([true, false]);
  });

  it('never picks an external variation', () => {
    const m = new ModelAnim(data({
      animations: [animation({ id: 0, subID: 0, flags: 0, probability: 32767 })],
    }));
    expect(m.pickVariation(0, 0)).toBeNull();
  });

  it('resolve falls back rather than returning an external sequence', () => {
    const m = new ModelAnim(data({ animations: seqs }));
    const got = m.resolve(97);
    expect(got).not.toBeNull();
    expect(got.inline).toBe(true);
    expect(got.id).toBe(0);
  });

  it('classify ignores keys that live in an external slot', () => {
    // A bone whose ONLY keys sit in an external slot is not animated -- those keys are noise.
    const boneWithExternalKeysOnly = bone({
      rotation: {
        interpolationType: 1,
        globalSequenceID: -1,
        tracks: [
          { animationIndex: 0, timestamps: [], values: [] },
          { animationIndex: 1, timestamps: [0, 999999999], values: [[0, 0, 0, 1], [0, 0, 0, 1]] },
        ],
      },
    });
    expect(classify(data({ animations: seqs, bones: [boneWithExternalKeysOnly] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__/model-anim"`
Expected: FAIL — `hasInlineData is not a function`

- [ ] **Step 3: Implement**

In `model-anim.ts`:

```ts
/**
 * Sequence flag bits meaning "this sequence's keyframes are inline in the .m2".
 *
 * The same mask the old AnimationManager used to SKIP such sequences. Measured against real 3.3.5a
 * data: wolf Stand/Walk/Run carry 0x20; the external ids 96-101 carry 0, 1, 3, 5 and 8.
 */
const INLINE_MASK = 0x130;

/**
 * Whether a sequence's keyframes live in the .m2 rather than a sibling .anim file.
 *
 * This is a SAFETY gate, not an optimization. An external sequence's animation-block offsets point
 * into the .anim file, but the parser reads them against the .m2 buffer -- so the arrays are not
 * empty, they are NOISE. Measured: 302 bone-tracks on wolf.m2 and 130 on kobold.m2 carry timestamps
 * far past their own sequence length, one of them 3,197,923,783 ms against a 2000 ms sequence.
 *
 * Arming such a sequence samples that noise and wrecks the pose, and it is reachable in normal play
 * because `unit.ts` arms whatever id the server sends. Everything downstream of `ModelAnim` therefore
 * treats an external sequence as absent until Task 20 merges its real data.
 */
export function hasInlineData(flags: number): boolean {
  return (flags & INLINE_MASK) !== 0;
}
```

Add `inline: hasInlineData(a.flags)` to the `Sequence` interface and to the constructor's table build.

Then quarantine at the three consumption points:

- `variationsOf` filters to `s.inline`.
- `findById` filters to `s.inline`.
- `resolve`'s final fallback returns the first **inline** sequence, or `null` if the model has none.
- `classify`'s `blockAnimated` takes the inline slot set and ignores tracks outside it.

Every quarantine site carries a one-line comment saying it is guarding against parsed noise, and
naming Task 20 as what lifts it.

- [ ] **Step 4: Run to verify they pass**

Run: `cd client && CI=true npm test -- --testPathPattern="anim/__tests__"`
Expected: PASS.

- [ ] **Step 5: Full suite and build**

Run: `cd client && CI=true npm test` then `cd client && npm run build`
Expected: both green. 1327 tests currently.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/anim/model-anim.ts \
        client/src/game/pipeline/m2/anim/__tests__/model-anim.test.ts
git commit -m "fix(m2): quarantine external sequences, whose keyframes parse as noise"
```

---

### Task 18: Unit locomotion

Units route through the evaluator but nothing drives them: `Unit#updateMoving` has no callers, so
every unit including the player avatar arms `resolve(0)` → Stand and holds it. The probe proved the
data needed is **inline** — wolf Walk is id 4 flag `0x20`, Run is id 5 — so this needs no `.anim`
support.

**Files:**
- Modify: `client/src/game/classes/unit.ts`
- Modify: `client/src/game/classes/__tests__/unit-animation.test.ts`
- Read first: `client/src/game/world/index.ts` (`animateEntities`), and whatever drives player
  movement from Controls.

**Interfaces:**
- Produces: `Unit#updateLocomotion(delta: number): void`, called once per frame per unit.

- [ ] **Step 1: Establish the animation ids from data, not memory**

`AnimationData.dbc` ids used below were observed directly in the probe: `0` Stand, `4` Walk,
`5` Run, `1` Death, `16`/`17` attack variants. **Confirm each against the parsed sequence tables of
at least two models before relying on it** — read `client/src/game/pipeline/dbc/` for how DBCs are
already loaded here and prefer the catalog over a hard-coded map if one is available.

- [ ] **Step 2: Write the failing tests**

Cover, with a fake model exposing `modelAnim`/`instanceAnim`:
- a stationary unit arms Stand and **stays armed** — no re-arm on subsequent frames (assert
  `armedAtMs` is unchanged, the guard Task 16 retained);
- a unit whose speed crosses zero arms Walk exactly once, and re-arming does not restart every frame;
- a unit above the run threshold arms Run;
- returning to zero speed arms Stand again;
- a model lacking Walk falls back through `resolve` rather than freezing;
- **the failure mode Task 16 flagged:** wiring locomotion without the idle branch leaves a unit
  running in place after it stops. Assert stopping arms Stand.

Sample times must avoid the WRAP-at-exactly-`length` boundary — `cursorMs(WRAP, 1000, 1000)` is `0`.

- [ ] **Step 3: Implement `updateLocomotion`**

Derive speed from the unit's own movement state. Pick the id by threshold, `resolve` it, and arm
**only when the resolved sequence differs from the current one** — the `if (seq.loops) return;`
guard Task 16 added is what stops a per-frame re-arm, and this must not defeat it.

Un-comment `setAnimation(Animation.idle)` at the stop transition, which Task 16 flagged as the trap.

- [ ] **Step 4: Call it**

From `World#animateEntities`, alongside the existing per-unit work, before posing. One call site.

- [ ] **Step 5: Both gates**

`cd client && CI=true npm test` and `cd client && npm run build`.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(anim): drive unit locomotion from movement state"
```

---

### Task 19: `.anim` fetch and cache

Naming is **confirmed against the live host**: `<stem><animId:04d>-<subId:02d>.anim`, lowercase.
`creature/wolf/wolf0097-00.anim` returns 200 at 5712 bytes; `wolf-0097-00.anim`, `wolf0097-0.anim`,
`wolf097-00.anim` and `Wolf0097-00.anim` all 404. A 404 returns an HTML error page, which
`Loader#load` already rejects on `!response.ok`.

**Files:**
- Create: `client/src/game/pipeline/m2/anim/external-anim.ts`
- Create: `client/src/game/pipeline/m2/anim/__tests__/external-anim.test.ts`

**Interfaces:**
- Produces: `externalAnimPath(modelPath, animId, subId): string`; `class ExternalAnimCache` with
  `request(modelPath, seq): void` and `readonly pending: number`.

- [ ] **Step 1: Write the failing tests**

Assert the exact confirmed pattern (`creature/wolf/wolf.m2`, id 97, sub 0 →
`creature/wolf/wolf0097-00.anim`), multi-digit sub ids, case preservation of the stem, that an
**inline** sequence is never requested, that each path is requested at most once, that a rejected
fetch neither throws nor is retried, and that `pending` returns to zero on failure.

- [ ] **Step 2–4: Implement, run, commit**

Lazy, cached per path, off the frame path, parsed in the existing worker pool. A failure logs once
and leaves the model on its inline sequences. Mirror Task 18's original brief, but with the
**confirmed** pattern rather than a guess.

```bash
git commit -m "feat(m2): lazy cached external .anim fetching off the frame path"
```

---

### Task 20: Parse `.anim` payloads and lift the quarantine

**This is the task with no reference.** benilla is 1.12.1 and vanilla has no `.anim` files;
WebWoWViewer is the only guide. Do not write the byte layout from memory.

- [ ] **Step 1: Determine the layout empirically**

A `.anim` file is the raw keyframe payload the `.m2`'s animation blocks point into for one sequence.
Download `creature/wolf/wolf0097-00.anim` (5712 bytes, confirmed reachable) and cross-check the
offsets recorded in `wolf.m2`'s slot-19 blocks against it. Verify by reconstructing one bone's
rotation track and checking the timestamps land inside the sequence's 2000 ms length — the same
sanity test that exposed the garbage in Task 17.

**If the layout cannot be established from data, stop and report.** Do not ship a parser that
produces plausible noise; that is the exact failure Task 17 exists to contain.

- [ ] **Step 2: Merge**

`ModelAnim#mergeExternal(seqIndex, boneTracks)` splices the parsed tracks into `boneDefs` and then
**clears that sequence's quarantine** — flip `Sequence.inline` to true for the merged slot so
`variationsOf`, `findById`, `resolve` and `classify` begin admitting it. Re-run `classify`, since
external data can be the first real keys a model has.

Guard a bone-count mismatch by ignoring the merge rather than applying it partially.

- [ ] **Step 3: Tests, gates, commit**

Include a test that a merged sequence becomes armable and an unmerged one stays quarantined.

```bash
git commit -m "feat(m2): parse external .anim payloads and lift the quarantine"
```

---

### Task 21: Measure, and derive the frame gate

The spec's ≤ 2 ms figure is **void as a target**. It rested partly on §5.1.4 ("drop the
per-animated-doodad `updateMatrixWorld`"), which Task 13 proved impossible — three recomputes the
bone palette from `bone.matrixWorld` every frame, so the walk must stay. Two further changes push
the same way: terrain and WMO hold **separate** `BoneBudget` instances, so the ceiling is 2× the
configured value, and units are exempt from the budget by design.

**Derive the number from measurement. Do not defend the old one.**

- [ ] **Step 1: Baseline**

Check out the merge base, run with the HUD open, and record `worst`, `p50`, `p99` and `over-budget`
over a 30-second sample at: Goldshire facing the inn; Stormwind Trade District centre; Westfall open
terrain facing away from buildings.

- [ ] **Step 2: This branch**

Same three positions, same figures, plus the `anim` section time and every `anim*` counter
(`animResident`, `animPosed`, `animSkipped`, `animBonesSolved`, `animMaterialsEvaluated`).

- [ ] **Step 3: Write it up**

`docs/superpowers/plans/2026-08-04-m2-animation-measurements.md`, table filled with observed
numbers, then a proposed gate justified by the data and a note on the dual-budget ceiling.

- [ ] **Step 4: If the delta is unacceptable**

Tighten in this order, re-measuring each time: unify the two `BoneBudget` instances; lower
`gameSettings.m2.boneBudgetPerFrame`; reduce `NEAR_YD`; raise the far decimation period; last,
introduce a priority-ordered budget covering units.

Do not mark complete on an unmeasured gate.

```bash
git commit -m "perf(anim): measure the evaluator and derive the frame gate"
```

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 root cause — shared manager, per-clone bones | 5 (ModelAnim), 12 (removal) |
| §3.1 sampler, four rules | 2, 3 |
| §3.1 clock law | 4 |
| §3.2 sequence table, `pickVariation`, `resolve`, `classify` | 5, 6 |
| §3.3 clock-indexed instance, lazy bone solve | 8, 9 |
| §3.4 variation cycle, shared RNG, two gates | 10, 13 |
| §4.1 bone palettes | 13 (`uploadPalette`), 15 (single-bone) |
| §4.2 shared materials via `onBeforeRender` | 14 |
| §5 instrument first | 1 |
| §5.1.1 classify | 5 |
| §5.1.2 per-submesh skinning | 15 |
| §5.1.3 global sequences once per model | 7 |
| §5.1.4 drop `updateMatrixWorld` | 13 |
| §5.1.5 no hot-loop allocation | 3, 9, 14 |
| §5.2.6 draw gate | 13 |
| §5.2.7 decimation stagger | 11, 13 |
| §5.2.8 bone budget | 11, 13 |
| §5.2.9 blend cap | **Gap — see below** |
| §6 `.anim` | 17, 18, 19 |
| §7 call sites | 12, 13, 16 |
| §8 testing | throughout |
| Acceptance gate | 20 |

**Gap found:** spec §5.2.9 (blending capped to near instances) has no task. Blending itself is not implemented anywhere in this plan — `InstanceAnim` has a `blend state` mention in the spec but no cross-fade. Rather than add a half-specified blend, this is now recorded as deferred:

> **Deferred to a follow-up:** animation cross-fade blending (spec §5.2.9 and the `blendTimeMs` field populated in Task 5). Sequences snap on change. `Sequence.blendTimeMs` is parsed and carried so the follow-up needs no re-plumbing. Units are the only objects where a snap is noticeable, and they were the last thing wired up (Task 16) — this is the natural seam.

**Placeholder scan:** Tasks 17 and 19 contain deliberate `<FILL IN>` markers in a *findings document the task exists to produce* — those are outputs, not unspecified work. Task 19 Step 6 explicitly instructs stopping rather than guessing a byte layout. No other placeholders.

**Type consistency:** `sampleScalar`/`sampleVec3`/`sampleQuat`/`trackFor`/`isStep` used identically in Tasks 9 and 14 as defined in 2–3. `Sequence` fields (`index`, `lengthMs`, `blendTimeMs`, `subId`, `loops`) consistent across 5, 6, 8, 10, 18. `InstanceAnim.palette`/`solveBones`/`cursor`/`arm`/`windowElapsed` consistent across 8, 9, 10, 13, 16. `animCounters` fields match `SceneCounters` additions in Task 1.
