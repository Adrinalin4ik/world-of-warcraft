# M2 Particle Simulation Core (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simulate M2 particles — spawn them from parsed emitter definitions, move them, and evaluate their lifetime tracks — with nothing rendered yet.

**Architecture:** Five pure, independently testable units under `client/src/game/pipeline/m2/particle/`: a structure-of-arrays pool with a free list, track evaluation for both `FBlock` (particle lifetime) and `AnimationBlock` (animation time), per-`emitterType` spawn functions, a motion integrator, and a runtime emitter that ties them together with a fractional emission accumulator. Randomness is injected so every unit is deterministic under test.

**Tech Stack:** TypeScript, three.js 0.185 (vectors only in this phase — no rendering), Jest via ejected CRA.

## Global Constraints

- Phase 1 is complete and committed. `client/src/wow-data-parser/m2/particle/emitter.js` exports `default ParticleEmitter`, `PARTICLE_EMITTER_SIZE` (476) and `EMITTER_TYPE` (`{PLANE: 1, SPHERE: 2, SPLINE: 3, BONE: 4}`). `part-track.js` exports `FIXED16_SCALE` (32767), `decodeFixed16`, and a default `FBlock(type)` factory.
- **Exact emitter field names**, as parsed (use these verbatim; do not rename): `particleId`, `flags`, `position` (`{x,y,z}`), `boneId`, `textureId`, `blendingType`, `emitterType`, `particleColorIndex`, `particleType`, `headOrTail`, `priorityPlane`, `rows`, `columns`, `emissionSpeed`, `speedVariation`, `verticalRange`, `horizontalRange`, `gravity`, `lifespan`, `lifespanVariation`, `emissionRate`, `emissionRateVariation`, `emissionAreaWidth`, `emissionAreaLength`, `zSource`, `colorTrack`, `alphaTrack`, `scaleTrack`, `scaleVary`, `headUVAnim`, `tailUVAnim`, `tailLength`, `twinkleSpeed`, `twinklePercent`, `twinkleScaleMin`, `twinkleScaleMax`, `inheritVelocityScale`, `drag`, `baseSpin`, `baseSpinVariation`, `spinSpeed`, `spinSpeedVariation`, `tumbleMin`, `tumbleMax`, `windVector`, `windTime`, `followSpeed1`, `followScale1`, `followSpeed2`, `followScale2`, `splinePoints`, `enabledIn`.
- **Value shapes differ per track and are easy to get wrong:**
  - `colorTrack` values are `{x, y, z}` objects, each channel 0–255.
  - `alphaTrack` values are raw `int16` in 0–32767. Divide by `FIXED16_SCALE`.
  - `scaleTrack` values and `scaleVary` are 2-element arrays `[x, y]`, not objects.
  - `headUVAnim` / `tailUVAnim` values are `uint16` cell indices.
  - `FBlock.keys` is `[{time, value}]` with `time` already normalised to 0–1.
  - `AnimationBlock` exposes `.tracks`, an array of `{animationIndex, timestamps, values}`, with timestamps in **milliseconds**.
- `delta` throughout this codebase is **seconds** (`THREE.Clock.getDelta()`).
- **Never write a capitalised top-level function declaration** (`export default function Foo`, `export function Foo`). `react-refresh/babel` is enabled (`client/config/webpack.config.js:452`) and injects a `$RefreshReg$(...)` call for them; outside a React module the refresh runtime is absent, so it throws `Cannot read properties of undefined (reading 'register')` during module evaluation and takes down every importer. This broke the whole M2 import chain once already, and it fails **silently** — the map simply never loads, with no console error. Jest cannot catch it, because babel-jest does not run the react-refresh plugin. Anonymous or lowercase-initial only. Capitalised `const`s holding plain objects or class declarations are fine.
- **Every test file must open with this docblock**, before any import:

  ```js
  /**
   * @jest-environment node
   */
  ```

  These are pure-logic tests and need no DOM, and the node environment keeps them fast.

  (An earlier revision of this constraint claimed three.js could not be imported under jsdom at all,
  because "THREE.Mesh is not a constructor". That diagnosis was wrong. The real cause was CRA's Jest
  `transform` catch-all not excluding `.cjs`, so `require('three')` was routed through the static-asset
  transformer and returned the string "three.cjs". Fixed in commit cf3571f; three.js imports fine under
  jsdom now.)
- Run tests with `cd client && npx jest --watchAll=false <path>`. `npm test` starts a watch runner.
- **Commit with an explicit pathspec:** `git commit -m "<message>" -- <path> <path>`. `git add` each new file individually first, because a pathspec commit cannot pick up an untracked path. Never `git add -A`, `git add .`, `git reset`, `git checkout -- .`, or `git stash`. Afterwards run `git show --stat HEAD` and confirm only intended files appear.
- Do not touch any `.glsl`, the renderer, or `WorldMap` in this phase. Rendering, batching, the manager and the budget allocator are Phase 2b.

---

## File Structure

**Create:**
- `client/src/game/pipeline/m2/particle/tracks.ts` — evaluation of `FBlock` lifetime tracks and `AnimationBlock` scalar tracks. Knows nothing about pools or emitters.
- `client/src/game/pipeline/m2/particle/pool.ts` — structure-of-arrays particle storage with a free list. Knows nothing about emitters or M2.
- `client/src/game/pipeline/m2/particle/spawn.ts` — one spawn function per `emitterType`, writing into a pool slot. Takes an injected RNG.
- `client/src/game/pipeline/m2/particle/integrate.ts` — per-step motion applied across a pool.
- `client/src/game/pipeline/m2/particle/runtime-emitter.ts` — one live emitter: emission accumulator, spawn/kill, and stepping.
- Tests, one per unit, under `client/src/game/pipeline/m2/particle/__tests__/`.

**Modify:**
- `client/src/game/pipeline/m2/index.ts` — retain the parsed emitter definitions on the instance.

Naming note: the runtime emitter file is `runtime-emitter.ts`, not `emitter.ts`, so it is never confused with the parser's `wow-data-parser/m2/particle/emitter.js`.

---

### Task 1: Retain emitter definitions on the M2 instance, and evaluate tracks

`client/src/game/pipeline/m2/index.ts` currently reads `data.particleEmitters` only to count it (line ~383, for the template-suppression check) and then discards it. Nothing downstream can see the definitions. This task keeps them and adds the track evaluation every later task needs.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/tracks.ts`
- Modify: `client/src/game/pipeline/m2/index.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/tracks.test.ts`

**Interfaces:**
- Consumes: `FIXED16_SCALE` from `client/src/wow-data-parser/m2/particle/part-track.js`.
- Produces (the `evaluateFBlock*` family is consumed by Phase 2b's batch packer, which reads colour,
  alpha, scale and cell per particle at `t = age / lifespan`; only `evaluateAnimationTrack` is used
  within this phase, by Task 5. They are implemented together because they are one coherent module and
  the spec assigns lifetime-track evaluation to the simulation phase):
  - `evaluateFBlockScalar(block, t): number` — `block` is `{keys: Array<{time, value: number}>}`.
  - `evaluateFBlockColor(block, t, out): {r,g,b}` — values are `{x,y,z}` in 0–255; `out` receives 0–1 floats.
  - `evaluateFBlockVec2(block, t, out): {x,y}` — values are `[x, y]` arrays.
  - `evaluateFBlockAlpha(block, t): number` — raw int16 divided by `FIXED16_SCALE`.
  - `evaluateFBlockCell(block, t): number` — nearest-key cell index, no interpolation.
  - `evaluateAnimationTrack(track, animationIndex, timeMs, fallback): number`
  - On `M2`: a public `particleEmitters: any[]` field.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/tracks.test.ts`:

```ts
/**
 * @jest-environment node
 */
import {
  evaluateAnimationTrack,
  evaluateFBlockAlpha,
  evaluateFBlockCell,
  evaluateFBlockColor,
  evaluateFBlockScalar,
  evaluateFBlockVec2,
} from '../tracks';

const scalarBlock = { keys: [{ time: 0, value: 10 }, { time: 0.5, value: 20 }, { time: 1, value: 0 }] };

describe('evaluateFBlockScalar', () => {
  it('returns the endpoints exactly', () => {
    expect(evaluateFBlockScalar(scalarBlock, 0)).toBeCloseTo(10, 5);
    expect(evaluateFBlockScalar(scalarBlock, 1)).toBeCloseTo(0, 5);
  });

  it('interpolates linearly between keys', () => {
    expect(evaluateFBlockScalar(scalarBlock, 0.25)).toBeCloseTo(15, 5);
    expect(evaluateFBlockScalar(scalarBlock, 0.75)).toBeCloseTo(10, 5);
  });

  it('clamps outside the key range instead of extrapolating', () => {
    expect(evaluateFBlockScalar(scalarBlock, -1)).toBeCloseTo(10, 5);
    expect(evaluateFBlockScalar(scalarBlock, 5)).toBeCloseTo(0, 5);
  });

  it('returns zero for an empty block', () => {
    expect(evaluateFBlockScalar({ keys: [] }, 0.5)).toBe(0);
  });

  it('returns the single value when there is only one key', () => {
    expect(evaluateFBlockScalar({ keys: [{ time: 0.3, value: 7 }] }, 0.9)).toBeCloseTo(7, 5);
  });
});

describe('evaluateFBlockColor', () => {
  it('normalises 0-255 channels to 0-1 and interpolates', () => {
    const block = { keys: [{ time: 0, value: { x: 255, y: 0, z: 0 } },
                           { time: 1, value: { x: 0, y: 0, z: 255 } }] };
    const out = { r: 0, g: 0, b: 0 };

    evaluateFBlockColor(block, 0, out);
    expect(out).toEqual({ r: 1, g: 0, b: 0 });

    evaluateFBlockColor(block, 0.5, out);
    expect(out.r).toBeCloseTo(0.5, 3);
    expect(out.b).toBeCloseTo(0.5, 3);
  });

  it('leaves the output white for an empty block', () => {
    const out = { r: 0, g: 0, b: 0 };
    evaluateFBlockColor({ keys: [] }, 0.5, out);
    expect(out).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe('evaluateFBlockVec2', () => {
  it('reads array-shaped values and interpolates both components', () => {
    const block = { keys: [{ time: 0, value: [1, 3] }, { time: 1, value: [3, 1] }] };
    const out = { x: 0, y: 0 };

    evaluateFBlockVec2(block, 0.5, out);
    expect(out.x).toBeCloseTo(2, 5);
    expect(out.y).toBeCloseTo(2, 5);
  });

  it('leaves the output at 1,1 for an empty block', () => {
    const out = { x: 0, y: 0 };
    evaluateFBlockVec2({ keys: [] }, 0.5, out);
    expect(out).toEqual({ x: 1, y: 1 });
  });
});

describe('evaluateFBlockAlpha', () => {
  it('divides the raw int16 by 32767', () => {
    const block = { keys: [{ time: 0, value: 32767 }, { time: 1, value: 0 }] };

    expect(evaluateFBlockAlpha(block, 0)).toBeCloseTo(1, 5);
    expect(evaluateFBlockAlpha(block, 1)).toBeCloseTo(0, 5);
    expect(evaluateFBlockAlpha(block, 0.5)).toBeCloseTo(0.5, 3);
  });

  it('is fully opaque for an empty block', () => {
    expect(evaluateFBlockAlpha({ keys: [] }, 0.5)).toBe(1);
  });
});

describe('evaluateFBlockCell', () => {
  it('snaps to the nearest key rather than interpolating', () => {
    const block = { keys: [{ time: 0, value: 0 }, { time: 1, value: 8 }] };

    expect(evaluateFBlockCell(block, 0.1)).toBe(0);
    expect(evaluateFBlockCell(block, 0.9)).toBe(8);
  });

  it('is cell zero for an empty block', () => {
    expect(evaluateFBlockCell({ keys: [] }, 0.5)).toBe(0);
  });
});

describe('evaluateAnimationTrack', () => {
  const track = {
    tracks: [
      { animationIndex: 0, timestamps: [0, 1000], values: [2, 6] },
      { animationIndex: 1, timestamps: [0], values: [9] },
    ],
  };

  it('interpolates within the requested animation', () => {
    expect(evaluateAnimationTrack(track, 0, 500, -1)).toBeCloseTo(4, 5);
  });

  it('clamps past the last timestamp', () => {
    expect(evaluateAnimationTrack(track, 0, 99999, -1)).toBeCloseTo(6, 5);
  });

  it('handles a single-key animation', () => {
    expect(evaluateAnimationTrack(track, 1, 500, -1)).toBeCloseTo(9, 5);
  });

  it('falls back to animation zero when the index is absent', () => {
    expect(evaluateAnimationTrack(track, 7, 0, -1)).toBeCloseTo(2, 5);
  });

  it('returns the fallback when the track holds nothing', () => {
    expect(evaluateAnimationTrack({ tracks: [] }, 0, 0, -1)).toBe(-1);
    expect(evaluateAnimationTrack(undefined, 0, 0, -1)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/tracks.test.ts`

Expected: FAIL — cannot resolve `../tracks`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/tracks.ts`:

```ts
import { FIXED16_SCALE } from '../../../../wow-data-parser/m2/particle/part-track';

/**
 * Track evaluation for M2 particle emitters.
 *
 * Two unrelated kinds of track are involved, and conflating them is the easy mistake:
 *
 *   FBlock (M2PartTrack) is keyed on a fraction of a single particle's lifetime, 0 to 1. Its `keys`
 *   are already normalised by the parser. Colour, alpha, scale and cell index come from these.
 *
 *   AnimationBlock (M2Track) is keyed on animation time in milliseconds and holds one sub-track per
 *   animation. The emitter's inputs -- emission rate, speed, gravity, lifespan and so on -- come from
 *   these.
 */

interface Key<T> { time: number; value: T; }
interface Block<T> { keys: Array<Key<T>>; }

/** Locate the bracketing keys for `t` and the 0-1 blend between them. */
const bracket = <T>(keys: Array<Key<T>>, t: number) => {
  if (t <= keys[0].time) {
    return { a: 0, b: 0, mix: 0 };
  }

  const last = keys.length - 1;

  if (t >= keys[last].time) {
    return { a: last, b: last, mix: 0 };
  }

  let b = 1;
  while (b < last && keys[b].time < t) {
    b++;
  }

  const a = b - 1;
  const span = keys[b].time - keys[a].time;

  return { a, b, mix: span > 0 ? (t - keys[a].time) / span : 0 };
};

const lerp = (from: number, to: number, mix: number) => from + (to - from) * mix;

export const evaluateFBlockScalar = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 0;
  }

  const { a, b, mix } = bracket(keys, t);

  return lerp(keys[a].value, keys[b].value, mix);
};

/** Raw int16 in 0..32767. Absent means fully opaque, which is the sane default for a missing track. */
export const evaluateFBlockAlpha = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 1;
  }

  const { a, b, mix } = bracket(keys, t);

  return lerp(keys[a].value, keys[b].value, mix) / FIXED16_SCALE;
};

/** Values are {x,y,z} with each channel 0..255. Absent means white, so the texture passes through. */
export const evaluateFBlockColor = (
  block: Block<{ x: number; y: number; z: number }> | undefined,
  t: number,
  out: { r: number; g: number; b: number },
) => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    out.r = 1;
    out.g = 1;
    out.b = 1;
    return out;
  }

  const { a, b, mix } = bracket(keys, t);

  out.r = lerp(keys[a].value.x, keys[b].value.x, mix) / 255;
  out.g = lerp(keys[a].value.y, keys[b].value.y, mix) / 255;
  out.b = lerp(keys[a].value.z, keys[b].value.z, mix) / 255;

  return out;
};

/** Values are 2-element arrays, not objects. Absent means unit scale. */
export const evaluateFBlockVec2 = (
  block: Block<number[]> | undefined,
  t: number,
  out: { x: number; y: number },
) => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    out.x = 1;
    out.y = 1;
    return out;
  }

  const { a, b, mix } = bracket(keys, t);

  out.x = lerp(keys[a].value[0], keys[b].value[0], mix);
  out.y = lerp(keys[a].value[1], keys[b].value[1], mix);

  return out;
};

/**
 * Texture cell index. Snapped rather than interpolated: a blended cell index would sample a
 * meaningless sub-rect halfway between two frames of the flipbook.
 */
export const evaluateFBlockCell = (block: Block<number> | undefined, t: number): number => {
  const keys = block && block.keys;
  if (!keys || keys.length === 0) {
    return 0;
  }

  const { a, b, mix } = bracket(keys, t);

  return mix < 0.5 ? keys[a].value : keys[b].value;
};

/**
 * Evaluate an AnimationBlock at a time in milliseconds.
 *
 * Falls back to animation 0 when the requested animation has no sub-track, and to `fallback` when the
 * block holds nothing at all -- emitters routinely leave inputs unanimated, and the caller knows the
 * right constant far better than this function does.
 */
export const evaluateAnimationTrack = (
  block: { tracks?: Array<{ animationIndex: number; timestamps: number[]; values: number[] }> } | undefined,
  animationIndex: number,
  timeMs: number,
  fallback: number,
): number => {
  const tracks = block && block.tracks;
  if (!tracks || tracks.length === 0) {
    return fallback;
  }

  const track = tracks.find((candidate) => candidate.animationIndex === animationIndex) || tracks[0];

  const { timestamps, values } = track;
  if (!timestamps || !values || values.length === 0) {
    return fallback;
  }

  if (values.length === 1 || timeMs <= timestamps[0]) {
    return values[0];
  }

  const last = values.length - 1;
  if (timeMs >= timestamps[last]) {
    return values[last];
  }

  let b = 1;
  while (b < last && timestamps[b] < timeMs) {
    b++;
  }

  const a = b - 1;
  const span = timestamps[b] - timestamps[a];

  return lerp(values[a], values[b], span > 0 ? (timeMs - timestamps[a]) / span : 0);
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/tracks.test.ts`

Expected: PASS, 17 tests.

- [ ] **Step 5: Retain the emitter definitions on the M2 instance**

In `client/src/game/pipeline/m2/index.ts`, find the field declarations near `suppressedBatches` (around line 45) and add:

```ts
  // Parsed M2Particle definitions, retained so the particle system can register emitters for this
  // model. Previously only the array's length was read, for the template-suppression check, and the
  // definitions themselves were dropped on the floor.
  particleEmitters: any[];
```

Then in the constructor, next to `this.suppressedBatches = [];` (around line 91), add:

```ts
    this.particleEmitters = data.particleEmitters || [];
```

Then change the suppression count at line ~383 from reading `data.particleEmitters` to reading the retained field, so there is one source of truth:

```ts
    const emitterCount = this.particleEmitters.length;
```

- [ ] **Step 6: Verify the retained field and that nothing regressed**

Run: `cd client && npx tsc --noEmit -p tsconfig.json` — expect exit 0.

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/` — expect all suites passing, exit 0. The Phase 1 template-suppression tests must still pass, which is what proves the `emitterCount` change is equivalent.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/pipeline/m2/particle/tracks.ts client/src/game/pipeline/m2/particle/__tests__/tracks.test.ts
git commit -m "feat(particle): evaluate emitter tracks and retain emitter definitions" -- \
  client/src/game/pipeline/m2/particle/tracks.ts \
  client/src/game/pipeline/m2/particle/__tests__/tracks.test.ts \
  client/src/game/pipeline/m2/index.ts
```

---

### Task 2: Particle pool

Structure-of-arrays storage with a free list. No per-particle objects: at the 20 000-particle budget in the spec, object churn would dominate the frame.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/pool.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/pool.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParticlePool` class with
  - `constructor(capacity: number)`
  - `readonly capacity: number`, `get liveCount(): number`
  - typed arrays, each length `capacity` except `position`/`velocity` which are length `capacity * 3`: `position: Float32Array`, `velocity: Float32Array`, `age: Float32Array`, `lifespan: Float32Array`, `seed: Float32Array`, `spin: Float32Array`, `spinSpeed: Float32Array`
  - `allocate(): number` — returns a slot index, or `-1` when full
  - `free(slot: number): void`
  - `forEachLive(visit: (slot: number) => void): void`
  - `reset(): void`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/pool.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { ParticlePool } from '../pool';

describe('ParticlePool', () => {
  it('allocates distinct slots up to capacity, then reports full', () => {
    const pool = new ParticlePool(3);
    const slots = [pool.allocate(), pool.allocate(), pool.allocate()];

    expect(new Set(slots).size).toBe(3);
    expect(slots.every((s) => s >= 0 && s < 3)).toBe(true);
    expect(pool.allocate()).toBe(-1);
    expect(pool.liveCount).toBe(3);
  });

  it('reuses a freed slot', () => {
    const pool = new ParticlePool(2);
    const first = pool.allocate();
    pool.allocate();

    pool.free(first);
    expect(pool.liveCount).toBe(1);

    expect(pool.allocate()).toBe(first);
    expect(pool.liveCount).toBe(2);
  });

  it('sizes position and velocity for three components per particle', () => {
    const pool = new ParticlePool(4);

    expect(pool.position.length).toBe(12);
    expect(pool.velocity.length).toBe(12);
    expect(pool.age.length).toBe(4);
    expect(pool.lifespan.length).toBe(4);
    expect(pool.seed.length).toBe(4);
    expect(pool.spin.length).toBe(4);
    expect(pool.spinSpeed.length).toBe(4);
  });

  it('visits exactly the live slots', () => {
    const pool = new ParticlePool(4);
    const a = pool.allocate();
    const b = pool.allocate();
    const c = pool.allocate();
    pool.free(b);

    const visited: number[] = [];
    pool.forEachLive((slot) => visited.push(slot));

    expect(visited.sort()).toEqual([a, c].sort());
  });

  it('does not visit anything when empty', () => {
    const pool = new ParticlePool(3);
    let count = 0;
    pool.forEachLive(() => count++);

    expect(count).toBe(0);
  });

  it('tolerates freeing a slot that is already free', () => {
    const pool = new ParticlePool(2);
    const slot = pool.allocate();

    pool.free(slot);
    pool.free(slot);

    expect(pool.liveCount).toBe(0);
    expect(pool.allocate()).toBe(slot);
    expect(pool.allocate()).toBeGreaterThanOrEqual(0);
    expect(pool.allocate()).toBe(-1);
  });

  it('clears live state and zeroes age on reset', () => {
    const pool = new ParticlePool(2);
    const slot = pool.allocate();
    pool.age[slot] = 5;

    pool.reset();

    expect(pool.liveCount).toBe(0);
    expect(pool.age[slot]).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/pool.test.ts`

Expected: FAIL — cannot resolve `../pool`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/pool.ts`:

```ts
/**
 * Structure-of-arrays particle storage.
 *
 * One typed array per attribute rather than one object per particle: the spec's budget is 20 000
 * concurrent particles stepped every frame, and per-particle objects would spend the frame in the
 * allocator. Slots are handed out from a free list so allocation is O(1) and slot indices stay stable
 * for as long as a particle lives.
 */
export class ParticlePool {

  readonly capacity: number;

  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly age: Float32Array;
  readonly lifespan: Float32Array;
  readonly seed: Float32Array;
  readonly spin: Float32Array;
  readonly spinSpeed: Float32Array;

  private live: Uint8Array;
  private freeList: Int32Array;
  private freeCount: number;

  constructor(capacity: number) {
    this.capacity = capacity;

    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.lifespan = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.spinSpeed = new Float32Array(capacity);

    this.live = new Uint8Array(capacity);
    this.freeList = new Int32Array(capacity);
    this.freeCount = capacity;

    // Seeded in reverse so the first allocations come back as 0, 1, 2..., which makes both debugging
    // and the tests far easier to read than an arbitrary order.
    for (let index = 0; index < capacity; index++) {
      this.freeList[index] = capacity - 1 - index;
    }
  }

  get liveCount() {
    return this.capacity - this.freeCount;
  }

  allocate(): number {
    if (this.freeCount === 0) {
      return -1;
    }

    const slot = this.freeList[--this.freeCount];
    this.live[slot] = 1;

    return slot;
  }

  free(slot: number) {
    // Guarded because a double free would push the same slot twice and hand it out to two particles.
    if (this.live[slot] !== 1) {
      return;
    }

    this.live[slot] = 0;
    this.freeList[this.freeCount++] = slot;
  }

  forEachLive(visit: (slot: number) => void) {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.live[slot] === 1) {
        visit(slot);
      }
    }
  }

  reset() {
    this.live.fill(0);
    this.age.fill(0);
    this.freeCount = this.capacity;

    for (let index = 0; index < this.capacity; index++) {
      this.freeList[index] = this.capacity - 1 - index;
    }
  }

}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/pool.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/particle/pool.ts client/src/game/pipeline/m2/particle/__tests__/pool.test.ts
git commit -m "feat(particle): add structure-of-arrays particle pool" -- \
  client/src/game/pipeline/m2/particle/pool.ts \
  client/src/game/pipeline/m2/particle/__tests__/pool.test.ts
```

---

### Task 3: Spawn functions for plane and sphere emitters

Per wowdev, for a **plane** generator `emissionAreaWidth`/`emissionAreaLength` are the area's dimensions and `verticalRange`/`horizontalRange` are the maximum polar and azimuth angles of the initial *velocity*, where zero polar makes velocity straight up (+Z). For a **sphere** generator the same width/length fields are the maximum and minimum *radius*, and the ranges bound the initial *position* instead.

Spline (3) and bone (4) are out of scope for this task; they fall back to a point spawn at the emitter origin so no emitter type crashes.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/spawn.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/spawn.test.ts`

**Interfaces:**
- Consumes: `ParticlePool` from Task 2; `EMITTER_TYPE` from `client/src/wow-data-parser/m2/particle/emitter.js`.
- Produces: `spawnParticle(pool, slot, params, random): void` where `params` is
  `{emitterType: number, areaWidth: number, areaLength: number, verticalRange: number, horizontalRange: number, speed: number, speedVariation: number, lifespan: number, baseSpin: number, spinSpeed: number, zSource: number}`
  and `random` is a `() => number` in [0, 1).

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/spawn.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { EMITTER_TYPE } from '../../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from '../pool';
import { spawnParticle } from '../spawn';

const baseParams = {
  emitterType: EMITTER_TYPE.PLANE,
  areaWidth: 4,
  areaLength: 6,
  verticalRange: 0,
  horizontalRange: 0,
  speed: 10,
  speedVariation: 0,
  lifespan: 2,
  baseSpin: 0,
  spinSpeed: 0,
};

// A deterministic stand-in for Math.random that cycles a fixed script.
const scriptedRandom = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

describe('spawnParticle — plane emitter', () => {
  it('places the particle inside the emission area', () => {
    const pool = new ParticlePool(64);

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, baseParams, Math.random);

      expect(Math.abs(pool.position[slot * 3])).toBeLessThanOrEqual(baseParams.areaWidth / 2 + 1e-6);
      expect(Math.abs(pool.position[slot * 3 + 1])).toBeLessThanOrEqual(baseParams.areaLength / 2 + 1e-6);
      expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 6);
    }
  });

  it('sends velocity straight up when both ranges are zero', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.5]));

    expect(pool.velocity[slot * 3]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 1]).toBeCloseTo(0, 6);
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(baseParams.speed, 5);
  });

  it('keeps speed within the variation band', () => {
    const pool = new ParticlePool(64);
    const params = { ...baseParams, speedVariation: 0.5 };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const vx = pool.velocity[slot * 3];
      const vy = pool.velocity[slot * 3 + 1];
      const vz = pool.velocity[slot * 3 + 2];
      const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);

      expect(magnitude).toBeGreaterThanOrEqual(params.speed * 0.5 - 1e-4);
      expect(magnitude).toBeLessThanOrEqual(params.speed * 1.5 + 1e-4);
    }
  });

  it('tilts velocity off the axis when verticalRange is set', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...baseParams, verticalRange: Math.PI / 2 }, scriptedRandom([1, 0]));

    // Full polar angle with azimuth 0 lays the velocity into the XY plane.
    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(0, 5);
  });
});

describe('spawnParticle — sphere emitter', () => {
  it('places the particle between the minimum and maximum radius', () => {
    const pool = new ParticlePool(64);
    const params = {
      ...baseParams,
      emitterType: EMITTER_TYPE.SPHERE,
      areaWidth: 10,
      areaLength: 4,
      verticalRange: Math.PI,
      horizontalRange: Math.PI * 2,
    };

    for (let i = 0; i < 40; i++) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, params, Math.random);

      const x = pool.position[slot * 3];
      const y = pool.position[slot * 3 + 1];
      const z = pool.position[slot * 3 + 2];
      const radius = Math.sqrt(x * x + y * y + z * z);

      expect(radius).toBeGreaterThanOrEqual(4 - 1e-4);
      expect(radius).toBeLessThanOrEqual(10 + 1e-4);
    }
  });
});

describe('spawnParticle — common state', () => {
  it('records lifespan, resets age, and seeds the particle', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();
    pool.age[slot] = 99;

    spawnParticle(pool, slot, baseParams, scriptedRandom([0.25]));

    expect(pool.lifespan[slot]).toBeCloseTo(2, 5);
    expect(pool.age[slot]).toBe(0);
    expect(pool.seed[slot]).toBeGreaterThanOrEqual(0);
    expect(pool.seed[slot]).toBeLessThan(1);
  });

  it('carries baseSpin and spinSpeed through', () => {
    const pool = new ParticlePool(4);
    const slot = pool.allocate();

    spawnParticle(pool, slot, { ...baseParams, baseSpin: 1.5, spinSpeed: 3 }, scriptedRandom([0]));

    expect(pool.spin[slot]).toBeCloseTo(1.5, 5);
    expect(pool.spinSpeed[slot]).toBeCloseTo(3, 5);
  });

  it('spawns at the origin for spline and bone emitters rather than throwing', () => {
    const pool = new ParticlePool(4);

    for (const emitterType of [EMITTER_TYPE.SPLINE, EMITTER_TYPE.BONE]) {
      const slot = pool.allocate();
      spawnParticle(pool, slot, { ...baseParams, emitterType }, scriptedRandom([0.5]));

      expect(pool.position[slot * 3]).toBeCloseTo(0, 6);
      expect(pool.position[slot * 3 + 1]).toBeCloseTo(0, 6);
      expect(pool.position[slot * 3 + 2]).toBeCloseTo(0, 6);
      expect(pool.lifespan[slot]).toBeCloseTo(2, 5);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/spawn.test.ts`

Expected: FAIL — cannot resolve `../spawn`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/spawn.ts`:

```ts
import { EMITTER_TYPE } from '../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from './pool';

/**
 * Initial state for one particle, in the emitter's local space.
 *
 * The width and length fields mean different things per generator, which is a genuine quirk of the
 * format rather than a naming slip:
 *
 *   plane  -- areaWidth and areaLength are the emission rectangle's dimensions, and verticalRange /
 *             horizontalRange bound the initial *velocity* direction. Zero polar angle sends velocity
 *             straight up (+Z).
 *   sphere -- areaWidth is the maximum radius and areaLength the minimum, and the ranges bound the
 *             initial *position* on the shell instead.
 *
 * `random` is injected rather than calling Math.random directly so that spawn distributions are
 * testable.
 */
export interface SpawnParams {
  emitterType: number;
  areaWidth: number;
  areaLength: number;
  verticalRange: number;
  horizontalRange: number;
  speed: number;
  speedVariation: number;
  lifespan: number;
  baseSpin: number;
  spinSpeed: number;
}

const spawnPlane = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  const base = slot * 3;

  pool.position[base] = (random() - 0.5) * params.areaWidth;
  pool.position[base + 1] = (random() - 0.5) * params.areaLength;
  pool.position[base + 2] = 0;

  const polar = params.verticalRange * random();
  const azimuth = params.horizontalRange * (random() - 0.5) * 2;

  const sinPolar = Math.sin(polar);

  pool.velocity[base] = sinPolar * Math.cos(azimuth);
  pool.velocity[base + 1] = sinPolar * Math.sin(azimuth);
  pool.velocity[base + 2] = Math.cos(polar);
};

const spawnSphere = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  const base = slot * 3;

  const maxRadius = params.areaWidth;
  const minRadius = params.areaLength;
  const radius = minRadius + (maxRadius - minRadius) * random();

  const polar = params.verticalRange * random();
  const azimuth = params.horizontalRange * random();

  const sinPolar = Math.sin(polar);
  const dirX = sinPolar * Math.cos(azimuth);
  const dirY = sinPolar * Math.sin(azimuth);
  const dirZ = Math.cos(polar);

  pool.position[base] = dirX * radius;
  pool.position[base + 1] = dirY * radius;
  pool.position[base + 2] = dirZ * radius;

  // Emitted outward along the shell normal.
  pool.velocity[base] = dirX;
  pool.velocity[base + 1] = dirY;
  pool.velocity[base + 2] = dirZ;
};

const spawnPoint = (pool: ParticlePool, slot: number) => {
  const base = slot * 3;

  pool.position[base] = 0;
  pool.position[base + 1] = 0;
  pool.position[base + 2] = 0;

  pool.velocity[base] = 0;
  pool.velocity[base + 1] = 0;
  pool.velocity[base + 2] = 1;
};

export const spawnParticle = (
  pool: ParticlePool, slot: number, params: SpawnParams, random: () => number,
) => {
  switch (params.emitterType) {
    case EMITTER_TYPE.PLANE:
      spawnPlane(pool, slot, params, random);
      break;

    case EMITTER_TYPE.SPHERE:
      spawnSphere(pool, slot, params, random);
      break;

    default:
      // Spline and bone generators are Phase 2b+. A point spawn keeps them harmless meanwhile rather
      // than leaving position and velocity holding whatever the previous occupant of the slot left.
      spawnPoint(pool, slot);
      break;
  }

  // The direction written above is a unit vector; scale it to the emission speed.
  const variation = 1 + params.speedVariation * (random() * 2 - 1);
  const speed = params.speed * variation;
  const base = slot * 3;

  pool.velocity[base] *= speed;
  pool.velocity[base + 1] *= speed;
  pool.velocity[base + 2] *= speed;

  pool.age[slot] = 0;
  pool.lifespan[slot] = params.lifespan;
  pool.seed[slot] = random();
  pool.spin[slot] = params.baseSpin;
  pool.spinSpeed[slot] = params.spinSpeed;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/spawn.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/particle/spawn.ts client/src/game/pipeline/m2/particle/__tests__/spawn.test.ts
git commit -m "feat(particle): add plane and sphere spawn functions" -- \
  client/src/game/pipeline/m2/particle/spawn.ts \
  client/src/game/pipeline/m2/particle/__tests__/spawn.test.ts
```

---

### Task 4: Motion integrator

Per-step motion across a whole pool: age, gravity, drag, `zSource`, spin, then position. Particles past their lifespan are freed.

`drag` is documented as `speed *= exp(-drag * t)`, which per step of `dt` is a multiply by `exp(-drag * dt)`. `zSource`, when greater than zero, pulls velocity toward the direction from `(0, 0, zSource)` to the particle.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/integrate.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/integrate.test.ts`

**Interfaces:**
- Consumes: `ParticlePool` from Task 2.
- Produces: `integratePool(pool, dt, forces): number` returning the number of particles freed this step, where `forces` is `{gravity: number, drag: number}`.

**Correction to an earlier draft of this plan:** `zSource` is NOT a continuous force and does not belong
here. wowdev's `M2Particle` says: "When greater than 0, the **initial velocity** of the particle is
`(particle.position - C3Vector(0, 0, zSource)).Normalize()`". It is a spawn-time direction override, so
it lives in `spawn.ts`, not in the integrator.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/integrate.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { integratePool } from '../integrate';
import { ParticlePool } from '../pool';

const noForces = { gravity: 0, drag: 0, zSource: 0 };

const place = (pool: ParticlePool, position: number[], velocity: number[], lifespan: number) => {
  const slot = pool.allocate();
  pool.position.set(position, slot * 3);
  pool.velocity.set(velocity, slot * 3);
  pool.lifespan[slot] = lifespan;
  pool.age[slot] = 0;
  return slot;
};

describe('integratePool', () => {
  it('advances position by velocity times dt', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [2, 0, 0], 10);

    integratePool(pool, 0.5, noForces);

    expect(pool.position[slot * 3]).toBeCloseTo(1, 5);
  });

  it('accumulates age and frees particles at their lifespan', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 1);

    expect(integratePool(pool, 0.5, noForces)).toBe(0);
    expect(pool.liveCount).toBe(1);
    expect(pool.age[slot]).toBeCloseTo(0.5, 5);

    expect(integratePool(pool, 0.6, noForces)).toBe(1);
    expect(pool.liveCount).toBe(0);
  });

  it('applies gravity along -Z', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 10);

    integratePool(pool, 1, { gravity: 9.8, drag: 0, zSource: 0 });

    expect(pool.velocity[slot * 3 + 2]).toBeCloseTo(-9.8, 4);
    expect(pool.position[slot * 3 + 2]).toBeCloseTo(-9.8, 4);
  });

  it('decays speed exponentially under drag', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [10, 0, 0], 10);

    integratePool(pool, 1, { gravity: 0, drag: 1, zSource: 0 });

    expect(pool.velocity[slot * 3]).toBeCloseTo(10 * Math.exp(-1), 4);
  });

  it('leaves velocity untouched when drag is zero', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [10, 0, 0], 10);

    integratePool(pool, 1, noForces);

    expect(pool.velocity[slot * 3]).toBeCloseTo(10, 5);
  });

  it('pushes velocity away from the zSource point', () => {
    const pool = new ParticlePool(4);
    // Particle sits above the source at z=0, so the outward direction is +Z.
    const slot = place(pool, [0, 0, 5], [0, 0, 0], 10);

    integratePool(pool, 1, { gravity: 0, drag: 0, zSource: 1 });

    expect(pool.velocity[slot * 3 + 2]).toBeGreaterThan(0);
  });

  it('advances spin by spinSpeed', () => {
    const pool = new ParticlePool(4);
    const slot = place(pool, [0, 0, 0], [0, 0, 0], 10);
    pool.spin[slot] = 0;
    pool.spinSpeed[slot] = 2;

    integratePool(pool, 0.5, noForces);

    expect(pool.spin[slot]).toBeCloseTo(1, 5);
  });

  it('frees a particle whose lifespan is zero on the first step', () => {
    const pool = new ParticlePool(4);
    place(pool, [0, 0, 0], [0, 0, 0], 0);

    expect(integratePool(pool, 0.016, noForces)).toBe(1);
    expect(pool.liveCount).toBe(0);
  });

  it('does nothing and frees nothing on an empty pool', () => {
    const pool = new ParticlePool(4);

    expect(integratePool(pool, 0.5, noForces)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/integrate.test.ts`

Expected: FAIL — cannot resolve `../integrate`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/integrate.ts`:

```ts
import { ParticlePool } from './pool';

export interface Forces {
  gravity: number;
  drag: number;
  zSource: number;
}

/**
 * Step every live particle in a pool and free the expired ones.
 *
 * Order matters: forces adjust velocity, then velocity moves the particle. Doing it the other way
 * round makes the first frame of a particle's life ignore gravity entirely.
 *
 * @returns how many particles were freed this step
 */
export const integratePool = (pool: ParticlePool, dt: number, forces: Forces): number => {
  // exp() once per step rather than once per particle.
  const dragFactor = forces.drag > 0 ? Math.exp(-forces.drag * dt) : 1;
  const gravityStep = forces.gravity * dt;

  let freed = 0;

  pool.forEachLive((slot) => {
    pool.age[slot] += dt;

    if (pool.age[slot] >= pool.lifespan[slot]) {
      pool.free(slot);
      freed++;
      return;
    }

    const base = slot * 3;

    if (gravityStep !== 0) {
      pool.velocity[base + 2] -= gravityStep;
    }

    if (dragFactor !== 1) {
      pool.velocity[base] *= dragFactor;
      pool.velocity[base + 1] *= dragFactor;
      pool.velocity[base + 2] *= dragFactor;
    }

    if (forces.zSource > 0) {
      // Documented as: velocity is pushed along (particle.position - (0, 0, zSource)) normalised.
      const dx = pool.position[base];
      const dy = pool.position[base + 1];
      const dz = pool.position[base + 2] - forces.zSource;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (length > 1e-6) {
        const scale = gravityStep !== 0 ? Math.abs(gravityStep) : dt;

        pool.velocity[base] += (dx / length) * scale;
        pool.velocity[base + 1] += (dy / length) * scale;
        pool.velocity[base + 2] += (dz / length) * scale;
      }
    }

    pool.position[base] += pool.velocity[base] * dt;
    pool.position[base + 1] += pool.velocity[base + 1] * dt;
    pool.position[base + 2] += pool.velocity[base + 2] * dt;

    pool.spin[slot] += pool.spinSpeed[slot] * dt;
  });

  return freed;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/integrate.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/particle/integrate.ts client/src/game/pipeline/m2/particle/__tests__/integrate.test.ts
git commit -m "feat(particle): add motion integrator" -- \
  client/src/game/pipeline/m2/particle/integrate.ts \
  client/src/game/pipeline/m2/particle/__tests__/integrate.test.ts
```

---

### Task 5: Runtime emitter

Ties a parsed definition to a pool: reads the animated inputs off the `AnimationBlock`s, accumulates fractional emission so low rates survive high frame rates, spawns, and steps.

The fractional accumulator is the point of this task. An emission rate of 3 per second at 60 FPS is 0.05 particles per frame; truncating that to an integer each frame emits nothing, forever.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/runtime-emitter.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts`

**Interfaces:**
- Consumes: `ParticlePool` (Task 2), `spawnParticle`/`SpawnParams` (Task 3), `integratePool` (Task 4), `evaluateAnimationTrack` (Task 1).
- Produces: `RuntimeEmitter` class with
  - `constructor(definition: any, pool: ParticlePool, random?: () => number)`
  - `animationIndex: number`, `animationTimeMs: number`, `enabled: boolean`, `capacity: number`
  - `step(dt: number): void`
  - `get liveCount(): number`
  - `stop(): void` — stops emission, lets existing particles finish
  - `readonly definition: any`, `readonly pool: ParticlePool`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { EMITTER_TYPE } from '../../../../../wow-data-parser/m2/particle/emitter';
import { ParticlePool } from '../pool';
import { RuntimeEmitter } from '../runtime-emitter';

// A definition shaped exactly like the parser's output, with unanimated single-key tracks.
const constantTrack = (value: number) => ({
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
});

const makeDefinition = (overrides: Record<string, any> = {}) => ({
  emitterType: EMITTER_TYPE.PLANE,
  emissionRate: constantTrack(10),
  emissionSpeed: constantTrack(5),
  speedVariation: constantTrack(0),
  verticalRange: constantTrack(0),
  horizontalRange: constantTrack(0),
  gravity: constantTrack(0),
  lifespan: constantTrack(1),
  emissionAreaWidth: constantTrack(2),
  emissionAreaLength: constantTrack(2),
  zSource: constantTrack(0),
  lifespanVariation: 0,
  emissionRateVariation: 0,
  drag: 0,
  baseSpin: 0,
  baseSpinVariation: 0,
  spinSpeed: 0,
  spinSpeedVariation: 0,
  enabledIn: { tracks: [] },
  ...overrides,
});

describe('RuntimeEmitter', () => {
  it('emits at the configured rate over one second', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    // 10 per second for one second, minus none expired yet (lifespan 1s, and the earliest particle is
    // exactly at its lifespan boundary), so allow one either way.
    expect(emitter.liveCount).toBeGreaterThanOrEqual(9);
    expect(emitter.liveCount).toBeLessThanOrEqual(10);
  });

  it('accumulates fractional emission instead of never emitting', () => {
    const pool = new ParticlePool(64);
    // 3 per second stepped at 60 FPS is 0.05 particles per frame.
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(3) }), pool, () => 0.5);

    for (let i = 0; i < 60; i++) {
      emitter.step(1 / 60);
    }

    expect(emitter.liveCount).toBeGreaterThanOrEqual(2);
  });

  it('emits nothing when the rate is zero', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(0) }), pool, () => 0.5);

    for (let i = 0; i < 30; i++) {
      emitter.step(1 / 30);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('stops emitting after stop() but lets existing particles finish', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }
    const afterEmitting = emitter.liveCount;
    expect(afterEmitting).toBeGreaterThan(0);

    emitter.stop();
    emitter.step(0.1);

    expect(emitter.liveCount).toBeLessThanOrEqual(afterEmitting);

    // Everything expires once a full lifespan has elapsed.
    for (let i = 0; i < 20; i++) {
      emitter.step(0.1);
    }
    expect(emitter.liveCount).toBe(0);
  });

  it('respects its capacity cap', () => {
    const pool = new ParticlePool(64);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(1000) }), pool, () => 0.5);
    emitter.capacity = 5;

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeLessThanOrEqual(5);
  });

  it('emits nothing while disabled', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);
    emitter.enabled = false;

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('cannot exceed the pool when the pool is smaller than the cap', () => {
    const pool = new ParticlePool(3);
    const emitter = new RuntimeEmitter(makeDefinition({ emissionRate: constantTrack(1000) }), pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeLessThanOrEqual(3);
  });

  it('does not emit while enabledIn evaluates to zero for the current animation', () => {
    const pool = new ParticlePool(16);
    const definition = makeDefinition({
      enabledIn: { tracks: [{ animationIndex: 0, timestamps: [0], values: [0] }] },
    });
    const emitter = new RuntimeEmitter(definition, pool, () => 0.5);

    for (let i = 0; i < 10; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBe(0);
  });

  it('emits when enabledIn evaluates to non-zero', () => {
    const pool = new ParticlePool(16);
    const definition = makeDefinition({
      enabledIn: { tracks: [{ animationIndex: 0, timestamps: [0], values: [1] }] },
    });
    const emitter = new RuntimeEmitter(definition, pool, () => 0.5);

    for (let i = 0; i < 5; i++) {
      emitter.step(0.1);
    }

    expect(emitter.liveCount).toBeGreaterThan(0);
  });

  it('advances animation time as it steps', () => {
    const pool = new ParticlePool(16);
    const emitter = new RuntimeEmitter(makeDefinition(), pool, () => 0.5);

    emitter.step(0.5);

    expect(emitter.animationTimeMs).toBeCloseTo(500, 3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts`

Expected: FAIL — cannot resolve `../runtime-emitter`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/runtime-emitter.ts`:

```ts
import { integratePool } from './integrate';
import { ParticlePool } from './pool';
import { spawnParticle, SpawnParams } from './spawn';
import { evaluateAnimationTrack } from './tracks';

/**
 * One live particle emitter: a parsed M2Particle definition bound to a pool.
 *
 * Emission is accumulated as a fraction. A rate of 3 per second stepped at 60 FPS works out to 0.05
 * particles per frame, so truncating each frame's share to an integer would emit nothing at all,
 * forever -- and would silently make an emitter's behaviour depend on frame rate.
 *
 * `capacity` is a cap the Phase 2b budget allocator writes to each frame; on its own an emitter is
 * limited only by its pool.
 */
export class RuntimeEmitter {

  readonly definition: any;
  readonly pool: ParticlePool;

  animationIndex = 0;
  animationTimeMs = 0;
  enabled = true;
  capacity: number;

  private random: () => number;
  private pending = 0;
  private spawnParams: SpawnParams;

  constructor(definition: any, pool: ParticlePool, random: () => number = Math.random) {
    this.definition = definition;
    this.pool = pool;
    this.random = random;
    this.capacity = pool.capacity;

    // Reused every spawn; allocating one of these per particle would defeat the pool.
    this.spawnParams = {
      emitterType: definition.emitterType,
      areaWidth: 0,
      areaLength: 0,
      verticalRange: 0,
      horizontalRange: 0,
      speed: 0,
      speedVariation: 0,
      lifespan: 0,
      baseSpin: 0,
      spinSpeed: 0,
      zSource: 0,
    };
  }

  get liveCount() {
    return this.pool.liveCount;
  }

  /** Stop emitting. Particles already alive keep running until their lifespan expires. */
  stop() {
    this.enabled = false;
    this.pending = 0;
  }

  step(dt: number) {
    this.animationTimeMs += dt * 1000;

    const definition = this.definition;
    const at = (block: any, fallback: number) =>
      evaluateAnimationTrack(block, this.animationIndex, this.animationTimeMs, fallback);

    integratePool(this.pool, dt, {
      gravity: at(definition.gravity, 0),
      drag: definition.drag || 0,
    });

    if (!this.enabled) {
      return;
    }

    // enabledIn gates emission on the owning model's current animation. An emitter with no track is
    // always enabled -- most world emitters leave it empty -- so the fallback must be 1, not 0.
    if (at(definition.enabledIn, 1) === 0) {
      this.pending = 0;
      return;
    }

    const rate = at(definition.emissionRate, 0);
    if (rate <= 0) {
      this.pending = 0;
      return;
    }

    this.pending += rate * dt;

    const params = this.spawnParams;
    params.emitterType = definition.emitterType;
    params.areaWidth = at(definition.emissionAreaWidth, 0);
    params.areaLength = at(definition.emissionAreaLength, 0);
    params.verticalRange = at(definition.verticalRange, 0);
    params.horizontalRange = at(definition.horizontalRange, 0);
    params.speed = at(definition.emissionSpeed, 0);
    params.speedVariation = at(definition.speedVariation, 0);
    params.baseSpin = definition.baseSpin || 0;
    params.spinSpeed = definition.spinSpeed || 0;
    // Spawn-time initial-velocity override, not a force. See the correction note in Task 4.
    params.zSource = at(definition.zSource, 0);

    const baseLifespan = at(definition.lifespan, 0);
    const lifespanVariation = definition.lifespanVariation || 0;

    while (this.pending >= 1) {
      this.pending -= 1;

      if (this.pool.liveCount >= this.capacity) {
        // Over budget. Drop the backlog rather than carrying it, so that an emitter which spends a
        // while at its cap does not burst the instant capacity frees up.
        this.pending = 0;
        break;
      }

      const slot = this.pool.allocate();
      if (slot < 0) {
        this.pending = 0;
        break;
      }

      params.lifespan = baseLifespan + lifespanVariation * (this.random() * 2 - 1);
      if (params.lifespan <= 0) {
        params.lifespan = baseLifespan;
      }

      spawnParticle(this.pool, slot, params, this.random);
    }
  }

}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole particle suite and typecheck**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/` — expect all suites passing, exit 0.

Run: `cd client && npx tsc --noEmit -p tsconfig.json` — expect exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/particle/runtime-emitter.ts client/src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts
git commit -m "feat(particle): add runtime emitter with fractional emission" -- \
  client/src/game/pipeline/m2/particle/runtime-emitter.ts \
  client/src/game/pipeline/m2/particle/__tests__/runtime-emitter.test.ts
```

---

## Verification summary

After all five tasks:

- `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/` — all green, exit 0. 51 new tests on top of Phase 1's 21.
- `cd client && npx tsc --noEmit -p tsconfig.json` — exit 0.
- `M2` instances expose `particleEmitters`, so Phase 2b can register them.
- Nothing renders and nothing in the running client changes. The client must behave exactly as before: this phase adds unreferenced modules plus one retained field. That is the point — all the visual risk sits in Phase 2b.

## Out of scope for this phase

Rendering, batching, the material and blend modes, billboarding, the `ParticleManager`, the global budget allocator and distance culling, bone attachment, the spawn/stop lifecycle API, and removing the single-quad suppression heuristic. All of that is Phase 2b.

Also deferred, per the spec's phase 3: spline and bone emitter types, tumble, multi-texture, and tail particles. `spawn.ts` spawns spline and bone emitters at a point so they are harmless until then.
