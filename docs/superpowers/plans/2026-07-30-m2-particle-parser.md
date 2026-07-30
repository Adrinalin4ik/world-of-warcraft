# M2 Particle Parser (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse M2 particle and ribbon emitter data, and stop particle-template quads from rendering as opaque blobs.

**Architecture:** Add an `FBlock`/`M2PartTrack` decoder and a WotLK `M2Particle` struct to the existing `restructure`-based M2 parser, then wire `particleEmitters` and `ribbonEmitters` to pass their element types. Separately, a pure predicate module decides which submeshes are particle templates, and `M2#createSubmeshes` skips them. No simulation or rendering in this phase.

**Tech Stack:** JavaScript/TypeScript, `restructure` 0.5.0 for binary parsing, three.js 0.150, Jest via ejected CRA (`npm test`).

## Global Constraints

- Target M2 version is **264** (WotLK, build 12340). Fields guarded `#if ≥ Cata` are absent; fields guarded `#if ≥ Wrath` are present.
- `restructure` 0.5.0 requires a Node `Buffer`, not a `Uint8Array`. Decoding from a plain typed array fails with `this.buffer[key] is not a function`.
- `M2Array<T>` is `{uint32 size; uint32 offset;}` and is already implemented by `client/src/wow-data-parser/m2/nofs.js` (`Nofs`). Use `Nofs`, never hand-roll it.
- `M2Track<T>` is already implemented by `client/src/wow-data-parser/m2/animation-block.js` (`AnimationBlock(type)`). Use it for the emitter's animated inputs.
- Game assets are **never committed**. Test fixtures download on demand to a gitignored cache from `https://data-direct.spelunkerdb.com/12340/<lowercased, forward-slashed path>`.
- Run tests with `cd client && npx jest --watchAll=false <path>`. `npm test` runs CRA's watch runner, which is not suitable for one-shot verification.
- **Every test file in this plan must open with this docblock**, before any import:

  ```js
  /**
   * @jest-environment node
   */
  ```

  The project's global `testEnvironment` is `jest-environment-jsdom-fourteen`, which lacks
  `getVmContext` and cannot run under the installed Jest 29. These tests parse bytes and need no DOM,
  so the docblock selects `jest-environment-node` per file and sidesteps it. Without the docblock the
  suite fails to run at all, with an error that looks nothing like a test failure.
- **Commit with an explicit pathspec, never with a bare `git commit`.** Use the form
  `git commit -m "<message>" -- <path> <path>`, which commits those paths from the working tree and
  ignores the rest of the index. This repository has **507 files with pre-existing staged changes**
  unrelated to this work (Windows exec-bit mode changes and an earlier session's staged edits). A bare
  `git commit`, or `git add` followed by a bare `git commit`, would sweep all of them into your commit.
  Never run `git add -A`, `git add .`, `git reset`, `git checkout -- .`, or `git stash` — the working
  tree holds substantial uncommitted work that is not yours to move.

  **Files new to git must be `git add`ed first**, naming them individually: a pathspec commit cannot
  pick up an untracked path and fails with "pathspec did not match any files". So for a task creating
  new files: `git add <each new file>` and then the pathspec `git commit`. Adding specific new paths is
  safe — it is additive and touches nothing else. Afterwards confirm the scope with
  `git show --stat HEAD` and check that only your intended files appear.
- **Never write a capitalised top-level function declaration** (`export default function Foo(...)`,
  `export function Foo(...)`). `react-refresh/babel` is enabled in this project's webpack build
  (`client/config/webpack.config.js:452`) and treats any capitalised module-level function declaration
  as a React component, injecting a `$RefreshReg$(...)` call. Outside a React module the refresh runtime
  is absent, so that call throws `Cannot read properties of undefined (reading 'register')` while the
  module is still evaluating — taking down every module that imports it. This broke the entire M2 import
  chain once already, and it fails **silently**: the map simply never loads, with no console error.
  Jest cannot catch it, because babel-jest does not run the react-refresh plugin, so a green test suite
  proves nothing here. Use an anonymous `export default function(type)`, as
  `client/src/wow-data-parser/m2/animation-block.js:5` does. Capitalised `const`s holding struct
  instances are fine; it is function declarations and capitalised function/arrow assignments that get
  registered.
- Do not edit any `.glsl` in this phase. If a future phase does: shader files reached via `#pragma glslify: import` do not invalidate their parent module, so `rm -rf node_modules/.cache` **and restart the dev server**, or the edit is silently discarded.

---

## File Structure

**Create:**
- `client/src/wow-data-parser/m2/particle/part-track.js` — `fixed16` conversion and the `FBlock`/`M2PartTrack` struct factory. No knowledge of emitters.
- `client/src/wow-data-parser/m2/particle/emitter.js` — the `M2Particle` struct for version 264.
- `client/src/wow-data-parser/m2/particle/ribbon.js` — the `M2Ribbon` struct.
- `client/src/game/pipeline/m2/particle/template.ts` — pure predicates deciding whether a submesh is a particle template. No three.js imports.
- `client/src/wow-data-parser/m2/particle/__tests__/part-track.test.js`
- `client/src/wow-data-parser/m2/particle/__tests__/emitter.test.js`
- `client/src/wow-data-parser/m2/particle/test-support/fixtures.js` — download-and-cache helper shared by fixture-backed tests. Deliberately NOT under `__tests__/`: CRA's `testMatch` collects every `.js` there as a test suite, and a helper with no tests fails the run.
- `client/src/game/pipeline/m2/particle/__tests__/template.test.ts`

**Modify:**
- `client/src/wow-data-parser/m2/index.js:156-157` — give `ribbonEmitters` and `particleEmitters` their element types.
- `client/src/game/pipeline/m2/index.ts:365-388` — skip template submeshes in `createSubmeshes`.
- `client/.gitignore` — ignore the fixture cache directory.

---

### Task 1: fixed16 and the FBlock decoder

`M2PartTrack<T>` (the wiki also calls it `FBlock<T>`) is `{M2Array<fixed16> times; M2Array<T> values;}`. Unlike `M2Track`, it is **not** nested — `times` is a flat array of `int16`, each a lifetime position normalised by 32767. It is used for values that vary over a single particle's life, not over animation time.

**Files:**
- Create: `client/src/wow-data-parser/m2/particle/part-track.js`
- Test: `client/src/wow-data-parser/m2/particle/__tests__/part-track.test.js`

**Interfaces:**
- Consumes: `Nofs` from `client/src/wow-data-parser/m2/nofs.js`.
- Produces:
  - `FIXED16_SCALE: number` (32767)
  - `decodeFixed16(raw: number): number`
  - `default FBlock(type): r.Struct` — decoded instances expose `times: number[]` (raw int16), `values: T[]`, and a computed `keys: Array<{time: number, value: T}>` where `time` is normalised.

- [ ] **Step 1: Write the failing test**

Create `client/src/wow-data-parser/m2/particle/__tests__/part-track.test.js`:

```js
/**
 * @jest-environment node
 */
import * as r from 'restructure';
import { DecodeStream } from 'restructure';

import FBlock, { decodeFixed16, FIXED16_SCALE } from '../part-track';

// An FBlock lives at offset 0 and points at its two arrays further into the buffer, exactly as it
// does inside a real M2: the struct itself is only the two 8-byte M2Array descriptors.
const buildFBlockBuffer = () => {
  const buffer = Buffer.alloc(64);

  // times: M2Array<fixed16> — 3 entries at offset 16
  buffer.writeUInt32LE(3, 0);
  buffer.writeUInt32LE(16, 4);

  // values: M2Array<uint16> — 3 entries at offset 24
  buffer.writeUInt32LE(3, 8);
  buffer.writeUInt32LE(24, 12);

  buffer.writeInt16LE(0, 16);
  buffer.writeInt16LE(16384, 18);
  buffer.writeInt16LE(FIXED16_SCALE, 20);

  buffer.writeUInt16LE(10, 24);
  buffer.writeUInt16LE(20, 26);
  buffer.writeUInt16LE(30, 28);

  return buffer;
};

describe('decodeFixed16', () => {
  it('maps 0 to 0 and 32767 to 1', () => {
    expect(decodeFixed16(0)).toBe(0);
    expect(decodeFixed16(FIXED16_SCALE)).toBe(1);
  });

  it('maps the midpoint to about a half', () => {
    expect(decodeFixed16(16384)).toBeCloseTo(0.5, 4);
  });
});

describe('FBlock', () => {
  it('decodes parallel time and value arrays into normalised keys', () => {
    const stream = new DecodeStream(buildFBlockBuffer());
    const block = FBlock(r.uint16le).decode(stream);

    expect(block.values).toEqual([10, 20, 30]);
    expect(block.keys.map((key) => key.value)).toEqual([10, 20, 30]);
    expect(block.keys[0].time).toBeCloseTo(0, 5);
    expect(block.keys[1].time).toBeCloseTo(0.5, 4);
    expect(block.keys[2].time).toBeCloseTo(1, 5);
  });

  it('consumes exactly sixteen bytes, being two M2Array descriptors', () => {
    const stream = new DecodeStream(buildFBlockBuffer());
    FBlock(r.uint16le).decode(stream);

    expect(stream.pos).toBe(16);
  });

  it('produces no keys when the block is empty', () => {
    const buffer = Buffer.alloc(32);
    const stream = new DecodeStream(buffer);
    const block = FBlock(r.uint16le).decode(stream);

    expect(block.keys).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/__tests__/part-track.test.js`

Expected: FAIL — cannot resolve `../part-track`.

- [ ] **Step 3: Write the implementation**

Create `client/src/wow-data-parser/m2/particle/part-track.js`:

```js
import * as r from 'restructure';

import Nofs from '../nofs';

/**
 * fixed16 is an int16 where 0x7FFF represents 1.0. The ribbon alpha track documents the convention
 * explicitly: 0 is transparent, 0x7FFF opaque.
 */
export const FIXED16_SCALE = 32767;

export const decodeFixed16 = (raw) => raw / FIXED16_SCALE;

/**
 * M2PartTrack<T>, which the wiki also writes as FBlock<T>.
 *
 * Not to be confused with AnimationBlock (M2Track): that is keyed on animation timestamps and its
 * arrays are nested one level deeper, one inner array per animation. This is keyed on a fraction of a
 * single particle's lifetime, and its arrays are flat.
 *
 * @param type - restructure type of each value
 */
export default function FBlock(type) {
  return new r.Struct({
    times: new Nofs(r.int16le),
    values: new Nofs(type),

    keys: function() {
      const count = Math.min(this.times.length, this.values.length);
      const keys = [];

      for (let index = 0; index < count; index++) {
        keys.push({ time: decodeFixed16(this.times[index]), value: this.values[index] });
      }

      return keys;
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/__tests__/part-track.test.js`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(m2): add fixed16 and FBlock particle track decoder" --   client/src/wow-data-parser/m2/particle/part-track.js   client/src/wow-data-parser/m2/particle/__tests__/part-track.test.js
```

---

### Task 2: M2Particle struct and wiring

Field order and version guards below are transcribed from wowdev.wiki's `M2ParticleOld` struct. For version 264 the `≥ Wrath` branches are taken and the `≥ Cata` branches are not, which means: `textureId` is a plain `uint16` (no multi-texture bitfield), `particleType` and `headOrTail` are present, colour/alpha/scale are `FBlock`s rather than fixed three-element arrays, and spin is four floats rather than one.

Summing that field list gives **476 bytes** per emitter. That number is the layout's canary: if it is wrong, everything after the first mistake decodes as garbage.

**Files:**
- Create: `client/src/wow-data-parser/m2/particle/emitter.js`
- Create: `client/src/wow-data-parser/m2/particle/__tests__/fixtures.js`
- Modify: `client/src/wow-data-parser/m2/index.js:157`
- Modify: `client/.gitignore`
- Test: `client/src/wow-data-parser/m2/particle/__tests__/emitter.test.js`

**Interfaces:**
- Consumes: `FBlock`, `decodeFixed16` from Task 1; `Nofs`; `AnimationBlock` from `../animation-block`; `Vec3Float`/`Vec2Float` — check `client/src/wow-data-parser/m2/index.js` for the existing vector type names and reuse them rather than redefining.
- Produces:
  - `default ParticleEmitter: r.Struct` — the emitter struct.
  - `PARTICLE_EMITTER_SIZE: number` (476)
  - `EMITTER_TYPE: {PLANE: 1, SPHERE: 2, SPLINE: 3, BONE: 4}`
  - From `__tests__/fixtures.js`: `fetchFixture(path: string): Promise<Buffer | null>` — returns `null` when the asset host is unreachable, so callers can skip.

- [ ] **Step 1: Add the fixture cache to .gitignore**

Append to `client/.gitignore`:

```
# Downloaded M2/BLP test fixtures. Game assets are never committed; they come from the asset host.
/src/**/__tests__/.fixture-cache/
```

- [ ] **Step 2: Write the fixture helper**

Create `client/src/wow-data-parser/m2/particle/test-support/fixtures.js`:

```js
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_URI = process.env.REACT_APP_DATA_URI || 'https://data-direct.spelunkerdb.com/12340';
const CACHE_DIR = path.join(__dirname, '.fixture-cache');

const normalize = (assetPath) => assetPath.trim().toLowerCase().replace(/\\/g, '/');

const download = (url) => new Promise((resolve) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      resolve(null);
      return;
    }

    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
  }).on('error', () => resolve(null));
});

/**
 * Fetch a game asset for use as a test fixture, caching it on disk.
 *
 * Returns null when the asset host cannot be reached, so that an offline checkout skips the
 * fixture-backed assertions rather than failing them.
 */
const fetchFixture = async (assetPath) => {
  const normalized = normalize(assetPath);
  const cached = path.join(CACHE_DIR, normalized.replace(/\//g, '_'));

  if (fs.existsSync(cached)) {
    return fs.readFileSync(cached);
  }

  const buffer = await download(`${DATA_URI}/${normalized}`);

  if (!buffer) {
    return null;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, buffer);

  return buffer;
};

module.exports = { fetchFixture, DATA_URI };
```

- [ ] **Step 3: Write the failing test**

Create `client/src/wow-data-parser/m2/particle/__tests__/emitter.test.js`:

```js
/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import M2 from '../../index';
import ParticleEmitter, { PARTICLE_EMITTER_SIZE, EMITTER_TYPE } from '../emitter';
const { fetchFixture } = require('../test-support/fixtures');

const MODELS = [
  'WORLD\\GENERIC\\PASSIVEDOODADS\\PARTICLEEMITTERS\\LAVASPLASHPARTICLE.M2',
  'WORLD\\GENERIC\\PASSIVEDOODADS\\PARTICLEEMITTERS\\LAVASMOKEEMITTERB.M2'
];

describe('ParticleEmitter struct', () => {
  it('consumes exactly 476 bytes, the WotLK M2Particle size', () => {
    const buffer = Buffer.alloc(PARTICLE_EMITTER_SIZE * 2);
    const stream = new DecodeStream(buffer);

    ParticleEmitter.decode(stream);

    expect(stream.pos).toBe(PARTICLE_EMITTER_SIZE);
    expect(PARTICLE_EMITTER_SIZE).toBe(476);
  });

  it('reads the scalar fields at their documented offsets', () => {
    const buffer = Buffer.alloc(PARTICLE_EMITTER_SIZE);

    buffer.writeUInt32LE(0xFFFFFFFF, 0x00);   // particleId
    buffer.writeUInt32LE(0x00001000, 0x04);   // flags
    buffer.writeUInt16LE(7, 0x14);            // boneId
    buffer.writeUInt16LE(3, 0x16);            // textureId
    buffer.writeUInt8(4, 0x28);               // blendingType
    buffer.writeUInt8(EMITTER_TYPE.SPHERE, 0x29);
    buffer.writeUInt16LE(11, 0x2a);           // particleColorIndex
    buffer.writeUInt8(1, 0x2c);               // particleType
    buffer.writeUInt8(2, 0x2d);               // headOrTail

    const emitter = ParticleEmitter.decode(new DecodeStream(buffer));

    expect(emitter.boneId).toBe(7);
    expect(emitter.textureId).toBe(3);
    expect(emitter.blendingType).toBe(4);
    expect(emitter.emitterType).toBe(EMITTER_TYPE.SPHERE);
    expect(emitter.particleColorIndex).toBe(11);
    expect(emitter.particleType).toBe(1);
    expect(emitter.headOrTail).toBe(2);
  });
});

describe('real emitter models', () => {
  MODELS.forEach((model) => {
    it(`decodes plausible emitters from ${model}`, async () => {
      const buffer = await fetchFixture(model);

      if (!buffer) {
        console.warn(`Skipping ${model}: asset host unreachable`);
        return;
      }

      const data = M2.decode(new DecodeStream(buffer));

      expect(Array.isArray(data.particleEmitters)).toBe(true);
      expect(data.particleEmitters.length).toBeGreaterThan(0);

      const validTypes = Object.values(EMITTER_TYPE);

      data.particleEmitters.forEach((emitter) => {
        // A misaligned struct almost never yields a valid enum, so this is the strongest single check.
        expect(validTypes).toContain(emitter.emitterType);

        expect(emitter.textureId).toBeLessThan(data.textures.length);
        expect(emitter.rows).toBeGreaterThanOrEqual(1);
        expect(emitter.columns).toBeGreaterThanOrEqual(1);

        const lifespans = emitter.lifespan.tracks
          .flatMap((track) => track.values);

        lifespans.forEach((lifespan) => {
          expect(lifespan).toBeGreaterThan(0);
          expect(lifespan).toBeLessThan(60);
        });
      });
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/__tests__/emitter.test.js`

Expected: FAIL — cannot resolve `../emitter`.

- [ ] **Step 5: Write the emitter struct**

Reuse the project's shared types from `client/src/wow-data-parser/types/`: `Vec3Float` is `{x, y, z}` and `float32array2` is a 2-element float array, which is the right shape for `C2Vector` here.

Note that the same directory exports `compfixed16`, which converts as `(value - 32767) / 32767` — a signed −1..1 mapping over `uint16`. That is **not** the `fixed16` used by `FBlock` times and alpha, which is `int16 / 32767` over 0..1. Do not substitute one for the other.

Create `client/src/wow-data-parser/m2/particle/emitter.js`:

```js
import * as r from 'restructure';

import { float32array2, Vec3Float } from '../../types';
import AnimationBlock from '../animation-block';
import Nofs from '../nofs';
import FBlock from './part-track';

/** Sum of the version-264 field list below. The layout's canary; see the plan. */
export const PARTICLE_EMITTER_SIZE = 476;

export const EMITTER_TYPE = { PLANE: 1, SPHERE: 2, SPLINE: 3, BONE: 4 };

/**
 * M2Particle for version 264 (WotLK).
 *
 * Transcribed from wowdev.wiki's M2ParticleOld. Version 264 takes every `>= Wrath` branch and no
 * `>= Cata` branch, so: textureId is a plain uint16 rather than three packed 5-bit indices,
 * particleType and headOrTail are still present, colour/alpha/scale are FBlocks rather than fixed
 * three-element arrays, and spin is four floats rather than one.
 */
const ParticleEmitter = new r.Struct({
  particleId: r.uint32le,
  flags: r.uint32le,
  position: Vec3Float,
  boneId: r.uint16le,
  textureId: r.uint16le,

  particleModelFilename: new Nofs(r.uint8),
  childEmittersModelFilename: new Nofs(r.uint8),

  blendingType: r.uint8,
  emitterType: r.uint8,
  particleColorIndex: r.uint16le,

  particleType: r.uint8,
  headOrTail: r.uint8,

  priorityPlane: r.int16le,
  rows: r.uint16le,
  columns: r.uint16le,

  emissionSpeed: AnimationBlock(r.floatle),
  speedVariation: AnimationBlock(r.floatle),
  verticalRange: AnimationBlock(r.floatle),
  horizontalRange: AnimationBlock(r.floatle),
  gravity: AnimationBlock(r.floatle),
  lifespan: AnimationBlock(r.floatle),
  lifespanVariation: r.floatle,
  emissionRate: AnimationBlock(r.floatle),
  emissionRateVariation: r.floatle,
  emissionAreaWidth: AnimationBlock(r.floatle),
  emissionAreaLength: AnimationBlock(r.floatle),
  zSource: AnimationBlock(r.floatle),

  colorTrack: FBlock(Vec3Float),
  alphaTrack: FBlock(r.int16le),
  scaleTrack: FBlock(float32array2),
  scaleVary: float32array2,
  headUVAnim: FBlock(r.uint16le),
  tailUVAnim: FBlock(r.uint16le),

  tailLength: r.floatle,
  twinkleSpeed: r.floatle,
  twinklePercent: r.floatle,
  twinkleScaleMin: r.floatle,
  twinkleScaleMax: r.floatle,
  inheritVelocityScale: r.floatle,
  drag: r.floatle,

  baseSpin: r.floatle,
  baseSpinVariation: r.floatle,
  spinSpeed: r.floatle,
  spinSpeedVariation: r.floatle,

  tumbleMin: Vec3Float,
  tumbleMax: Vec3Float,

  windVector: Vec3Float,
  windTime: r.floatle,

  followSpeed1: r.floatle,
  followScale1: r.floatle,
  followSpeed2: r.floatle,
  followScale2: r.floatle,

  splinePoints: new Nofs(Vec3Float),

  enabledIn: AnimationBlock(r.uint8)
});

export default ParticleEmitter;
```

- [ ] **Step 6: Wire the emitter array into the M2 header**

In `client/src/wow-data-parser/m2/index.js`, add the import near the other parser imports:

```js
import ParticleEmitter from './particle/emitter';
```

Then change line 157 from:

```js
  particleEmitters: new Nofs(),
```

to:

```js
  particleEmitters: new Nofs(ParticleEmitter),
```

- [ ] **Step 7: Confirm nothing depended on the old count-only value**

Run: `cd client && grep -rn "particleEmitters" src/`

Expected: only the declaration in `wow-data-parser/m2/index.js` and the new files. `particleEmitters` previously decoded to a *number* (the count) because `Nofs` with no type returns the length; it now decodes to an array. If any other consumer appears, stop and report it before continuing.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/__tests__/emitter.test.js`

Expected: PASS. If the 476-byte assertion fails, the field list is wrong — recount against the struct in the plan rather than adjusting the constant to match.

- [ ] **Step 9: Typecheck**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(m2): parse particle emitters (version 264 layout)" --   client/.gitignore   client/src/wow-data-parser/m2/particle/emitter.js   client/src/wow-data-parser/m2/particle/__tests__/   client/src/wow-data-parser/m2/index.js
```

---

### Task 3: M2Ribbon struct and wiring

Ribbons are not particles — they are trailing strips generated from a bone's motion — but their struct sits in the same header and is cheap to parse now. Nothing consumes it in this phase.

**Files:**
- Create: `client/src/wow-data-parser/m2/particle/ribbon.js`
- Modify: `client/src/wow-data-parser/m2/index.js:156`
- Test: `client/src/wow-data-parser/m2/particle/__tests__/ribbon.test.js`

**Interfaces:**
- Consumes: `Nofs`, `AnimationBlock`, and the vector types as in Task 2.
- Produces: `default Ribbon: r.Struct`, `RIBBON_SIZE: number` (176).

- [ ] **Step 1: Write the failing test**

Create `client/src/wow-data-parser/m2/particle/__tests__/ribbon.test.js`:

```js
/**
 * @jest-environment node
 */
import { DecodeStream } from 'restructure';

import Ribbon, { RIBBON_SIZE } from '../ribbon';

describe('Ribbon struct', () => {
  it('consumes exactly its documented size', () => {
    const buffer = Buffer.alloc(RIBBON_SIZE * 2);
    const stream = new DecodeStream(buffer);

    Ribbon.decode(stream);

    expect(stream.pos).toBe(RIBBON_SIZE);
  });

  it('reads bone index and position', () => {
    const buffer = Buffer.alloc(RIBBON_SIZE);
    buffer.writeUInt32LE(9, 0x04);      // boneIndex
    buffer.writeFloatLE(1.5, 0x08);     // position.x

    const ribbon = Ribbon.decode(new DecodeStream(buffer));

    expect(ribbon.boneIndex).toBe(9);
    expect(ribbon.position.x).toBeCloseTo(1.5, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/__tests__/ribbon.test.js`

Expected: FAIL — cannot resolve `../ribbon`.

- [ ] **Step 3: Write the ribbon struct**

Create `client/src/wow-data-parser/m2/particle/ribbon.js`:

```js
import * as r from 'restructure';

import { Vec3Float } from '../../types';
import AnimationBlock from '../animation-block';
import Nofs from '../nofs';

/**
 * Version-264 field sizes, in order:
 *   ribbonId 4, boneIndex 4, position 12, textureIndices 8, materialIndices 8,
 *   colorTrack 20, alphaTrack 20, heightAboveTrack 20, heightBelowTrack 20,
 *   edgesPerSecond 4, edgeLifetime 4, gravity 4, textureRows 2, textureCols 2,
 *   texSlotTrack 20, visibilityTrack 20,
 *   priorityPlane 2, ribbonColorIndex 1, textureTransformLookupIndex 1
 * = 176 bytes.
 */
export const RIBBON_SIZE = 176;

/**
 * M2Ribbon, transcribed from wowdev.wiki. Parsed for completeness; ribbon rendering is a later phase.
 */
const Ribbon = new r.Struct({
  ribbonId: r.uint32le,
  boneIndex: r.uint32le,
  position: Vec3Float,

  textureIndices: new Nofs(r.uint16le),
  materialIndices: new Nofs(r.uint16le),

  colorTrack: AnimationBlock(Vec3Float),
  alphaTrack: AnimationBlock(r.int16le),
  heightAboveTrack: AnimationBlock(r.floatle),
  heightBelowTrack: AnimationBlock(r.floatle),

  edgesPerSecond: r.floatle,
  edgeLifetime: r.floatle,
  gravity: r.floatle,
  textureRows: r.uint16le,
  textureCols: r.uint16le,

  texSlotTrack: AnimationBlock(r.uint16le),
  visibilityTrack: AnimationBlock(r.uint8),

  // Present from Wrath onward.
  priorityPlane: r.int16le,
  ribbonColorIndex: r.int8,
  textureTransformLookupIndex: r.int8
});

export default Ribbon;
```

If the size assertion fails, recount the field list in the docstring above rather than adjusting the constant to silence it.

- [ ] **Step 4: Wire it into the header**

In `client/src/wow-data-parser/m2/index.js`, import it and change line 156 from `ribbonEmitters: new Nofs(),` to `ribbonEmitters: new Nofs(Ribbon),`.

- [ ] **Step 5: Run both parser test files**

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/`

Expected: PASS. The real-model test from Task 2 still passes, which also proves the ribbon array parses without shifting the emitter array.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(m2): parse ribbon emitters" --   client/src/wow-data-parser/m2/particle/ribbon.js   client/src/wow-data-parser/m2/particle/__tests__/ribbon.test.js   client/src/wow-data-parser/m2/index.js
```

---

### Task 4: Suppress particle-template submeshes

Measured on both Blackrock emitters: the template submesh has 6 vertices, **no index buffer**, and one group of count 6 — so it draws 2 triangles and is visible. It must not be drawn.

An earlier version of this rule suppressed a submesh only when every texture its batches used was
also referenced by a particle emitter (texture ownership). That premise was measured to be
**unsatisfiable** and must not be reintroduced:

- `LAVASMOKEEMITTERB.M2`: model textures `0:SMOKEWISPY02`, `1:CREATURE\GHOST\BLACK32`,
  `2:GENERICGLOW2_32`; emitter `textureId`s `[0, 0, 0, 2]`; `textureLookups = [1]` and the single
  batch has `textureLookup = 0`, so the drawn submesh resolves to texture index **1**, which no
  emitter references.
- `LAVASPLASHPARTICLE.M2`: textures `0:LAVASPLASHBUBLE`, `1:Ball1`; emitter `textureId` `[0]`;
  resolves to index **1**.

The rule shipped here instead relies on shape alone. Three conditions must all hold:

1. the model has at least one particle emitter, and
2. the model has exactly one submesh, and
3. that submesh's built geometry is a single quad — 6 vertices, 2 triangles.

Condition 2 is what keeps ordinary multi-part doodads (e.g. a torch: post plus flame) safe, since they
have more than one submesh even if one of those submeshes is itself a quad.

**Known false-positive class, accepted for this phase:** single-quad additive doodads that are not
emitter templates — glow/halo sprites, godray planes, and especially `SPELLS\*.M2` visual models, which
are often one flare quad plus spark emitters. Under this rule such a model (one emitter + one quad
submesh) is suppressed even though the quad is meant to render. Phase 4 routes spell M2s through this
same pipeline, so such a visual would currently render nothing at all. **Removing this heuristic is an
exit criterion for Phase 2**: once particles actually render, the correct rule is "do not build
geometry for submeshes the particle system owns," decided at emitter-registration time rather than by
guessing at shape.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/template.ts`
- Modify: `client/src/game/pipeline/m2/index.ts:365-388`
- Test: `client/src/game/pipeline/m2/particle/__tests__/template.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime; relies on `data.particleEmitters` being an array (Task 2) and on the submesh count/geometry already computed by `createBatches()`/`createSubmeshGeometry`.
- Produces:
  - `isParticleTemplate(input: {emitterCount: number, submeshCount: number, vertexCount: number, triangleCount: number}): boolean`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/template.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { isParticleTemplate } from '../template';

describe('isParticleTemplate', () => {
  it('accepts a single quad in a single-submesh model with at least one emitter', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 1, vertexCount: 6, triangleCount: 2
    })).toBe(true);
  });

  it('rejects geometry larger than one quad', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 1, vertexCount: 24, triangleCount: 12
    })).toBe(false);
  });

  it('rejects a model with more than one submesh, even if this one is a quad', () => {
    expect(isParticleTemplate({
      emitterCount: 1, submeshCount: 2, vertexCount: 6, triangleCount: 2
    })).toBe(false);
  });

  it('rejects everything when the model has no emitters', () => {
    expect(isParticleTemplate({
      emitterCount: 0, submeshCount: 1, vertexCount: 6, triangleCount: 2
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/template.test.ts`

Expected: FAIL — cannot resolve `../template`.

- [ ] **Step 3: Write the predicate module**

Create `client/src/game/pipeline/m2/particle/template.ts` implementing `isParticleTemplate` per the
three-condition rule in the spec's "Suppressing the template geometry" section: emitter count ≥ 1,
submesh count === 1, and the submesh geometry is exactly one quad (6 vertices, 2 triangles). The
module must stay pure — no three.js imports — since `client/src/game/pipeline/m2/index.ts` computes
`vertexCount`/`triangleCount` from the already-built `BufferGeometry` before calling in.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/template.test.ts`

Expected: PASS.

- [ ] **Step 5: Apply the predicate in createSubmeshes**

In `client/src/game/pipeline/m2/index.ts`, add the import:

```ts
import { isParticleTemplate } from './particle/template';
```

In `createSubmeshes`, compute `emitterCount` (`data.particleEmitters?.length ?? 0`) and
`submeshCount` (`submeshes.length`) once per call, then for each submesh call a small
`isTemplateSubmesh(geometry, emitterCount, submeshCount)` helper that reads `vertexCount` and
`triangleCount` off the built `BufferGeometry` and delegates to `isParticleTemplate`. When it returns
true, skip building the `Submesh` for scene-graph purposes, but push that submesh's already-built
`M2Material` batches onto an instance-level `suppressedBatches` list so `M2#dispose()` can release
their textures later (see the ownership note added to this plan after Finding 1 of the Phase 1 review:
a suppressed submesh is otherwise never reachable from `this.submeshes`, so its material and texture
reference would leak on every load/unload cycle).

- [ ] **Step 6: Typecheck and run the whole new suite**

Run: `cd client && npx tsc --noEmit -p tsconfig.json && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/`

Expected: tsc exit 0; all tests pass.

- [ ] **Step 7: Verify the blobs are gone in the running client**

Restart the dev server, then load `http://localhost:3000/game` and teleport to the Blackrock lava:

```js
window.world.player.worldport(0, [-7553, -1077, 210]);
```

Check in the console that the emitter doodads no longer contribute drawn meshes:

```js
(() => {
  let templates = 0;
  for (const wmo of window.world.map.wmoManager.entries.values()) {
    if (!wmo.doodads) continue;
    for (const d of wmo.doodads.values()) {
      if (!/PARTICLEEMITTER/i.test(String(d.path || ''))) continue;
      d.traverse((c) => {
        if (c.isMesh && c.material && c.material.constructor.name === 'M2Material') templates++;
      });
    }
  }
  return templates;
})();
```

Expected: `0`, where it was 1 per emitter doodad before. Visually, the dark lumps with the violet fringe over the lava are gone and nothing else has disappeared.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(m2): stop drawing particle emitter template quads" --   client/src/game/pipeline/m2/particle/   client/src/game/pipeline/m2/index.ts
```

---

## Verification summary

After all four tasks:

- `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/` — all green.
- `cd client && npx tsc --noEmit -p tsconfig.json` — exit 0.
- The Blackrock lava has no dark emitter blobs, and torches, doodads and creatures elsewhere are unchanged.
- `data.particleEmitters` and `data.ribbonEmitters` are arrays of decoded structs, ready for Phase 2's simulation.

## Out of scope for this phase

Simulation, rendering, batching, the budget allocator, bone binding, and the spawn/stop API. Those are Phase 2 and Phase 4 of the spec.
