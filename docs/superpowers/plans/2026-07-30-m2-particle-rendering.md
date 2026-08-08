# M2 Particle Rendering — First Light (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M2 particles visible — billboarded, correctly blended, driven from the render loop — and retire the single-quad suppression heuristic.

**Architecture:** Phase 2a built the simulation (`pool.ts`, `spawn.ts`, `integrate.ts`, `tracks.ts`, `runtime-emitter.ts`) and nothing imports it. This phase adds three units beside them — a `ShaderMaterial` reusing the M2 blend-mode mapping, an `InstancedBufferGeometry` batch that packs live particles into instanced attributes, and a manager owning emitters and batches — then wires the manager into `WorldMap#animate` and registers emitters where doodads load.

**Tech Stack:** TypeScript, three.js 0.185, GLSL, Jest via ejected CRA.

## Global Constraints

- **Per-emitter pools, deliberately, for this phase.** Each `RuntimeEmitter` gets its own `ParticlePool` sized from its own emission rate and lifespan. The spec's global 20 000-particle budget with proximity ranking is **Phase 2c**, and it is what requires a shared pool with per-slot ownership. Do not attempt the shared pool here: `RuntimeEmitter.step()` integrates its whole pool and `liveCount` reports its whole pool, which is correct only while each emitter owns its pool exclusively — the WARNING block at the top of `runtime-emitter.ts` spells out the three ways sharing breaks it.
- `RuntimeEmitter`'s signature is `step(dt: number, animationTimeMs: number)`. It does **not** advance animation time itself; the caller supplies time already wrapped to the model's animation duration. Passing `undefined` makes every track evaluation return its fallback, which fails silently.
- `delta` in this codebase is **seconds** (`THREE.Clock.getDelta()`); `AnimationBlock` timestamps are **milliseconds**.
- three.js is **0.185**. `BufferAttribute.updateRange` no longer exists — use `addUpdateRange(start, count)` and `clearUpdateRanges()`. `InstancedBufferGeometry` has `instanceCount`.
- **Colour management is pinned off**: `THREE.ColorManagement.enabled = false` in `src/index.tsx` and `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`. Every shader here was authored against that. Do not set `texture.colorSpace`, and do not re-enable colour management.
- **Never write a capitalised top-level function declaration** (`export function Foo`, `export default function Foo`). `react-refresh/babel` is enabled (`client/config/webpack.config.js:452`) and injects a `$RefreshReg$(...)` call for them; outside a React module the refresh runtime is absent, so it throws during module evaluation and takes down every importer. This silently broke the whole M2 import chain earlier in this project — the map simply never loaded, with no console error — and it is invisible to both `tsc` and Jest. Use `export const`; `class` declarations are fine.
- **Shader files reached through `#pragma glslify: import` do not invalidate their parent module.** After editing any `.glsl`, run `rm -rf client/node_modules/.cache` **and restart the dev server**, or the change is silently discarded. This has cost real debugging time twice in this repository. The shaders in this plan are imported directly rather than via glslify, but the cache clear is still the safe move after any shader edit.
- **Every test file must open with this docblock**, before any import:

  ```js
  /**
   * @jest-environment node
   */
  ```

  These tests need no DOM and the node environment keeps them fast. (Note: an earlier revision claimed
  three.js could not be imported under jsdom. That was a misdiagnosis of CRA's Jest `transform` catch-all
  not excluding `.cjs`; fixed in cf3571f. three.js imports fine under either environment now.)
- Run tests with `cd client && npx jest --watchAll=false <path>`. `npm test` starts a watch runner.
- **Commit with an explicit pathspec:** `git commit -m "<message>" -- <path> <path>`. `git add` each new file individually first, because a pathspec commit cannot pick up an untracked path. Never `git add -A`, `git add .`, `git reset`, `git checkout -- .`, or `git stash`. Afterwards run `git show --stat HEAD` and confirm only intended files appear.
- Do not start the dev server or attempt in-browser verification. The controller does that with a headless-browser harness, on port 3000 — the asset host's CORS allowlist covers only ports 3000 and 5173, so no other port can load game assets.

---

## File Structure

**Create:**
- `client/src/game/pipeline/m2/particle/material.ts` — the particle `ShaderMaterial`: blend modes 0–6, billboarding, flipbook cell sampling. Knows nothing about pools or emitters.
- `client/src/game/pipeline/m2/particle/shader.vert` — billboarding and per-instance transform.
- `client/src/game/pipeline/m2/particle/shader.frag` — texture sampling and colour/alpha application.
- `client/src/game/pipeline/m2/particle/batch.ts` — one `InstancedBufferGeometry` plus the packing pass that fills its instanced attributes from a pool. Knows nothing about the manager.
- `client/src/game/pipeline/m2/particle/manager.ts` — `ParticleManager`: owns emitters and batches, steps them, parents batch meshes into the scene.
- Tests under `client/src/game/pipeline/m2/particle/__tests__/`.

**Modify:**
- `client/src/game/world/map.js` — construct the manager and step it from `animate(delta, camera, cameraMoved)`.
- `client/src/game/world/doodad-manager.js` — register on doodad load, unregister on unload.
- `client/src/game/pipeline/wmo/index.js:213-247` — register WMO doodads the same way.
- `client/src/game/pipeline/m2/index.ts` — replace the single-quad suppression heuristic.
- `client/src/game/pipeline/m2/particle/template.ts` — delete the heuristic predicate (superseded).

---

### Task 1: Particle material

A `ShaderMaterial` that billboards a unit quad toward the camera and samples one cell of a flipbook. Blend modes reuse the mapping `client/src/game/pipeline/m2/material/index.ts` already applies for M2 batches — read `applyBlendingMode` there and mirror its `blendSrc`/`blendDst` pairs exactly rather than inventing new ones.

Per-instance data arrives as instanced attributes, which Task 2 fills: `iOffset` (vec3, world position), `iScale` (vec2), `iRotation` (float, radians), `iColor` (vec4, rgb + alpha), `iUvRect` (vec4, `x,y` origin and `z,w` size within the atlas).

**Files:**
- Create: `client/src/game/pipeline/m2/particle/material.ts`
- Create: `client/src/game/pipeline/m2/particle/shader.vert`
- Create: `client/src/game/pipeline/m2/particle/shader.frag`
- Test: `client/src/game/pipeline/m2/particle/__tests__/material.test.ts`

**Interfaces:**
- Consumes: `TextureLoader` from `client/src/game/pipeline/texture-loader.js` — `TextureLoader.load(path)` returns a `Promise<THREE.Texture>`, and `TextureLoader.PLACEHOLDER` is a shared empty texture for the slot while it loads.
- Produces:
  - `export const PARTICLE_BLEND_MODE = {OPAQUE: 0, ALPHA_KEY: 1, ALPHA: 2, ADD: 3, ADD_ALPHA: 4, MODULATE: 5, MODULATE_2X: 6}`
  - `export const applyParticleBlending = (material: THREE.Material, blendingType: number): void`
  - `export class ParticleMaterial extends THREE.ShaderMaterial` with `constructor(texturePath: string, blendingType: number)` and a `readonly blendingType: number`. Rows and columns are a property of the *batch*, not the material, because the flipbook rect is per-instance data.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/material.test.ts`:

```ts
/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { applyParticleBlending, PARTICLE_BLEND_MODE } from '../material';

describe('applyParticleBlending', () => {
  it('leaves mode 0 unblended', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.OPAQUE);

    expect(material.blending).toBe(THREE.NoBlending);
    expect(material.transparent).toBe(false);
  });

  it('alpha-keys mode 1 with a mid alpha test', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ALPHA_KEY);

    expect(material.alphaTest).toBeCloseTo(0.5, 5);
  });

  it('uses src-alpha over one-minus-src-alpha for mode 2', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ALPHA);

    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
  });

  it('uses additive factors for mode 4', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, PARTICLE_BLEND_MODE.ADD_ALPHA);

    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(material.blendDst).toBe(THREE.OneFactor);
  });

  it('marks every blended mode transparent and disables depth write', () => {
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      const material = new THREE.MeshBasicMaterial();
      applyParticleBlending(material, mode);

      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
    }
  });

  it('falls back to alpha blending for an unknown mode rather than leaving it unset', () => {
    const material = new THREE.MeshBasicMaterial();
    applyParticleBlending(material, 99);

    expect(material.blending).toBe(THREE.CustomBlending);
    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/material.test.ts`

Expected: FAIL — cannot resolve `../material`.

- [ ] **Step 3: Write the shaders**

Create `client/src/game/pipeline/m2/particle/shader.vert`:

```glsl
precision highp float;

attribute vec3 iOffset;
attribute vec2 iScale;
attribute float iRotation;
attribute vec4 iColor;
attribute vec4 iUvRect;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  // `position` is the unit quad, spanning -0.5..0.5 in x and y with z = 0.
  vec2 corner = position.xy * iScale;

  float s = sin(iRotation);
  float c = cos(iRotation);
  vec2 spun = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);

  // Billboard: build the quad in view space so it always faces the camera, then let the projection
  // matrix do the rest. Taking the camera's right and up out of the view matrix is what keeps the quad
  // facing us without a per-particle lookAt on the CPU.
  vec4 viewCenter = viewMatrix * vec4(iOffset, 1.0);
  viewCenter.xy += spun;

  // position.xy spans -0.5..0.5, so +0.5 maps it to 0..1 within the atlas cell.
  vUv = iUvRect.xy + (position.xy + 0.5) * iUvRect.zw;
  vColor = iColor;

  gl_Position = projectionMatrix * viewCenter;
}
```

Create `client/src/game/pipeline/m2/particle/shader.frag`:

```glsl
precision highp float;

uniform sampler2D texture_sampler;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  vec4 sampled = texture2D(texture_sampler, vUv);

  // Colour and alpha both come from the emitter's lifetime tracks, already normalised to 0..1 by
  // tracks.ts. The texture supplies the shape; the tracks supply the tint and the fade.
  gl_FragColor = vec4(sampled.rgb * vColor.rgb, sampled.a * vColor.a);
}
```

- [ ] **Step 4: Write the material**

Create `client/src/game/pipeline/m2/particle/material.ts`:

```ts
import * as THREE from 'three';

import TextureLoader from '../../texture-loader';
import fragmentShader from './shader.frag';
import vertexShader from './shader.vert';

/**
 * M2Particle.blendingType. Same numbering as the M2 material blend modes, and the factor pairs below
 * mirror `applyBlendingMode` in `client/src/game/pipeline/m2/material/index.ts` deliberately -- particles
 * and batches must blend identically or the same texture reads differently in each.
 */
export const PARTICLE_BLEND_MODE = {
  OPAQUE: 0,
  ALPHA_KEY: 1,
  ALPHA: 2,
  ADD: 3,
  ADD_ALPHA: 4,
  MODULATE: 5,
  MODULATE_2X: 6,
};

export const applyParticleBlending = (material: any, blendingType: number): void => {
  if (blendingType === PARTICLE_BLEND_MODE.OPAQUE) {
    material.blending = THREE.NoBlending;
    material.transparent = false;
    material.depthWrite = true;
    return;
  }

  // Particles never write depth: they are unsorted and semi-transparent, so depth writes would let
  // whichever particle drew first occlude the ones behind it.
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;

  switch (blendingType) {
    case PARTICLE_BLEND_MODE.ALPHA_KEY:
      material.alphaTest = 0.5;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.ZeroFactor;
      break;

    case PARTICLE_BLEND_MODE.ADD:
      material.blendSrc = THREE.SrcColorFactor;
      material.blendDst = THREE.DstColorFactor;
      break;

    case PARTICLE_BLEND_MODE.ADD_ALPHA:
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneFactor;
      break;

    case PARTICLE_BLEND_MODE.MODULATE:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.ZeroFactor;
      break;

    case PARTICLE_BLEND_MODE.MODULATE_2X:
      material.blendSrc = THREE.DstColorFactor;
      material.blendDst = THREE.SrcColorFactor;
      break;

    case PARTICLE_BLEND_MODE.ALPHA:
    default:
      // Alpha blending is the safe fallback for an unrecognised mode: it shows the particle rather than
      // dropping it, which makes a bad mode visible instead of silently invisible.
      material.blendSrc = THREE.SrcAlphaFactor;
      material.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
  }
};

export class ParticleMaterial extends THREE.ShaderMaterial {

  readonly blendingType: number;

  constructor(texturePath: string, blendingType: number) {
    super();

    this.blendingType = blendingType;

    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;

    this.uniforms = {
      texture_sampler: { value: TextureLoader.PLACEHOLDER },
    };

    // Both faces: a billboarded quad's winding depends on the camera, and culling it would make
    // particles vanish from half the angles a player can stand at.
    this.side = THREE.DoubleSide;

    applyParticleBlending(this, blendingType);

    TextureLoader.load(texturePath)
      .then((texture) => {
        this.uniforms.texture_sampler.value = texture;
      })
      .catch((error) => {
        console.error(`Failed to load particle texture ${texturePath}:`, error);
      });
  }

}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/material.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck**

Run: `cd client && npx tsc --noEmit -p tsconfig.json` — expect exit 0. `client/src/react-app-env.d.ts` already declares `*.glsl`, `*.frag` and `*.vert` modules (lines 10, 15, 19), so the shader imports need no new declaration.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/pipeline/m2/particle/material.ts \
        client/src/game/pipeline/m2/particle/shader.vert \
        client/src/game/pipeline/m2/particle/shader.frag \
        client/src/game/pipeline/m2/particle/__tests__/material.test.ts
git commit -m "feat(particle): add billboarded particle material with M2 blend modes" -- \
  client/src/game/pipeline/m2/particle/material.ts \
  client/src/game/pipeline/m2/particle/shader.vert \
  client/src/game/pipeline/m2/particle/shader.frag \
  client/src/game/pipeline/m2/particle/__tests__/material.test.ts
```

---

### Task 2: Batch and attribute packing

One `InstancedBufferGeometry` per emitter, plus the pass that fills its instanced attributes from a pool each frame. Packing is where the simulation meets the renderer, and it is the one piece worth testing hard: it reads pool slots and lifetime tracks and writes five interleaved attribute arrays.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/batch.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/batch.test.ts`

**Interfaces:**
- Consumes: `ParticlePool` from `./pool`; `evaluateFBlockAlpha`, `evaluateFBlockCell`, `evaluateFBlockColor`, `evaluateFBlockVec2` from `./tracks`; `ParticleMaterial` from `./material` (Task 1).
- Produces: `export class ParticleBatch extends THREE.Mesh` with
  - `constructor(material: ParticleMaterial, capacity: number, rows: number, columns: number)`
  - `pack(pool: ParticlePool, definition: any, worldMatrix: THREE.Matrix4): number` — returns the instance count written
  - `readonly capacity: number`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/batch.test.ts`:

```ts
/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { ParticleBatch } from '../batch';
import { ParticlePool } from '../pool';

// A material stand-in: ParticleBatch only stores it, and constructing the real one would fetch a texture.
const stubMaterial: any = new THREE.MeshBasicMaterial();

const definition = {
  colorTrack: { keys: [{ time: 0, value: { x: 255, y: 0, z: 0 } }] },
  alphaTrack: { keys: [{ time: 0, value: 32767 }] },
  scaleTrack: { keys: [{ time: 0, value: [2, 3] }] },
  headUVAnim: { keys: [{ time: 0, value: 0 }] },
  scaleVary: [0, 0],
};

const seed = (pool: ParticlePool, position: number[], lifespan: number) => {
  const slot = pool.allocate();
  pool.position.set(position, slot * 3);
  pool.lifespan[slot] = lifespan;
  pool.age[slot] = 0;
  pool.spin[slot] = 0;
  return slot;
};

describe('ParticleBatch', () => {
  it('writes one instance per live particle and reports the count', () => {
    const pool = new ParticlePool(8);
    seed(pool, [1, 2, 3], 5);
    seed(pool, [4, 5, 6], 5);

    const batch = new ParticleBatch(stubMaterial, 8, 1, 1);
    const count = batch.pack(pool, definition, new THREE.Matrix4());

    expect(count).toBe(2);
    expect((batch.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(2);
  });

  it('writes nothing for an empty pool', () => {
    const pool = new ParticlePool(8);
    const batch = new ParticleBatch(stubMaterial, 8, 1, 1);

    expect(batch.pack(pool, definition, new THREE.Matrix4())).toBe(0);
    expect((batch.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
  });

  it('transforms particle positions by the world matrix', () => {
    const pool = new ParticlePool(4);
    seed(pool, [1, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    const worldMatrix = new THREE.Matrix4().makeTranslation(10, 20, 30);
    batch.pack(pool, definition, worldMatrix);

    const offset = batch.geometry.getAttribute('iOffset');
    expect(offset.getX(0)).toBeCloseTo(11, 4);
    expect(offset.getY(0)).toBeCloseTo(20, 4);
    expect(offset.getZ(0)).toBeCloseTo(30, 4);
  });

  it('applies the colour and alpha tracks', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const color = batch.geometry.getAttribute('iColor');
    expect(color.getX(0)).toBeCloseTo(1, 3);
    expect(color.getY(0)).toBeCloseTo(0, 3);
    expect(color.getW(0)).toBeCloseTo(1, 3);
  });

  it('applies the scale track', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const scale = batch.geometry.getAttribute('iScale');
    expect(scale.getX(0)).toBeCloseTo(2, 4);
    expect(scale.getY(0)).toBeCloseTo(3, 4);
  });

  it('derives the uv rect from the rows and columns of the flipbook', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    // 2x2 atlas, cell 0 -> origin (0, 0), size (0.5, 0.5)
    const batch = new ParticleBatch(stubMaterial, 4, 2, 2);
    batch.pack(pool, definition, new THREE.Matrix4());

    const rect = batch.geometry.getAttribute('iUvRect');
    expect(rect.getZ(0)).toBeCloseTo(0.5, 5);
    expect(rect.getW(0)).toBeCloseTo(0.5, 5);
    expect(rect.getX(0)).toBeCloseTo(0, 5);
    expect(rect.getY(0)).toBeCloseTo(0, 5);
  });

  it('treats a 1x1 flipbook as the whole texture', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const rect = batch.geometry.getAttribute('iUvRect');
    expect(rect.getZ(0)).toBeCloseTo(1, 5);
    expect(rect.getW(0)).toBeCloseTo(1, 5);
  });

  it('never writes more instances than its capacity', () => {
    const pool = new ParticlePool(16);
    for (let i = 0; i < 16; i++) {
      seed(pool, [i, 0, 0], 5);
    }

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);

    expect(batch.pack(pool, definition, new THREE.Matrix4())).toBe(4);
  });

  it('marks the attributes for upload', () => {
    const pool = new ParticlePool(4);
    seed(pool, [0, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 4, 1, 1);

    // three's `needsUpdate` is a setter with NO getter (three/src/core/BufferAttribute.js:155):
    // assigning true increments `version`, and reading the property back always yields undefined.
    // `version` is therefore the only observable evidence the attribute was marked dirty.
    const names = ['iOffset', 'iScale', 'iRotation', 'iColor', 'iUvRect'];
    const before = names.map((name) => batch.geometry.getAttribute(name).version);

    batch.pack(pool, definition, new THREE.Matrix4());

    names.forEach((name, index) => {
      expect(batch.geometry.getAttribute(name).version).toBeGreaterThan(before[index]);
    });
  });

  it('bounds the update range to the live prefix', () => {
    const pool = new ParticlePool(16);
    seed(pool, [0, 0, 0], 5);
    seed(pool, [1, 0, 0], 5);

    const batch = new ParticleBatch(stubMaterial, 16, 1, 1);
    batch.pack(pool, definition, new THREE.Matrix4());

    const offset = batch.geometry.getAttribute('iOffset');
    expect(offset.updateRanges.length).toBe(1);
    // Two live particles, three components each.
    expect(offset.updateRanges[0]).toEqual({ start: 0, count: 6 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/batch.test.ts`

Expected: FAIL — cannot resolve `../batch`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/batch.ts`:

```ts
import * as THREE from 'three';

import { ParticlePool } from './pool';
import {
  evaluateFBlockAlpha,
  evaluateFBlockCell,
  evaluateFBlockColor,
  evaluateFBlockVec2,
} from './tracks';

const scratchColor = { r: 1, g: 1, b: 1 };
const scratchScale = { x: 1, y: 1 };
const scratchPosition = new THREE.Vector3();

/**
 * One draw call's worth of particles.
 *
 * A unit quad instanced once per live particle. The per-instance attributes carry everything that
 * varies: world position, scale, rotation, colour and the sub-rect of the flipbook to sample. The
 * vertex shader billboards the quad in view space, so nothing here has to face the camera.
 */
export class ParticleBatch extends THREE.Mesh {

  readonly capacity: number;

  private rows: number;
  private columns: number;

  private offsets: Float32Array;
  private scales: Float32Array;
  private rotations: Float32Array;
  private colors: Float32Array;
  private uvRects: Float32Array;

  constructor(material: any, capacity: number, rows: number, columns: number) {
    super();

    this.capacity = capacity;
    this.rows = Math.max(1, rows);
    this.columns = Math.max(1, columns);

    const geometry = new THREE.InstancedBufferGeometry();

    // A unit quad spanning -0.5..0.5, which the vertex shader scales and spins per instance.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.5,  0.5, 0,
      -0.5,  0.5, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.offsets = new Float32Array(capacity * 3);
    this.scales = new Float32Array(capacity * 2);
    this.rotations = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 4);
    this.uvRects = new Float32Array(capacity * 4);

    geometry.setAttribute('iOffset', new THREE.InstancedBufferAttribute(this.offsets, 3));
    geometry.setAttribute('iScale', new THREE.InstancedBufferAttribute(this.scales, 2));
    geometry.setAttribute('iRotation', new THREE.InstancedBufferAttribute(this.rotations, 1));
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.colors, 4));
    geometry.setAttribute('iUvRect', new THREE.InstancedBufferAttribute(this.uvRects, 4));

    geometry.instanceCount = 0;

    this.geometry = geometry;
    this.material = material;

    // Particles are placed in world space by the packing pass, so the mesh itself must not add a
    // transform on top. Frustum culling is off because the geometry's bounding volume describes the
    // unit quad at the origin, not where the instances actually are.
    this.matrixAutoUpdate = false;
    this.frustumCulled = false;
  }

  /**
   * Fill the instanced attributes from a pool's live particles.
   *
   * @param worldMatrix transform from the emitter's local space into world space
   * @returns the number of instances written
   */
  pack(pool: ParticlePool, definition: any, worldMatrix: THREE.Matrix4): number {
    const cellCount = this.rows * this.columns;
    const cellWidth = 1 / this.columns;
    const cellHeight = 1 / this.rows;

    let index = 0;

    pool.forEachLive((slot) => {
      if (index >= this.capacity) {
        return;
      }

      const lifespan = pool.lifespan[slot];
      const t = lifespan > 0 ? Math.min(1, pool.age[slot] / lifespan) : 1;

      scratchPosition.set(
        pool.position[slot * 3],
        pool.position[slot * 3 + 1],
        pool.position[slot * 3 + 2],
      ).applyMatrix4(worldMatrix);

      this.offsets[index * 3] = scratchPosition.x;
      this.offsets[index * 3 + 1] = scratchPosition.y;
      this.offsets[index * 3 + 2] = scratchPosition.z;

      evaluateFBlockVec2(definition.scaleTrack, t, scratchScale);
      this.scales[index * 2] = scratchScale.x;
      this.scales[index * 2 + 1] = scratchScale.y;

      this.rotations[index] = pool.spin[slot];

      evaluateFBlockColor(definition.colorTrack, t, scratchColor);
      this.colors[index * 4] = scratchColor.r;
      this.colors[index * 4 + 1] = scratchColor.g;
      this.colors[index * 4 + 2] = scratchColor.b;
      this.colors[index * 4 + 3] = evaluateFBlockAlpha(definition.alphaTrack, t);

      const cell = cellCount > 1
        ? Math.min(cellCount - 1, Math.max(0, evaluateFBlockCell(definition.headUVAnim, t)))
        : 0;
      const column = cell % this.columns;
      const row = Math.floor(cell / this.columns);

      this.uvRects[index * 4] = column * cellWidth;
      this.uvRects[index * 4 + 1] = row * cellHeight;
      this.uvRects[index * 4 + 2] = cellWidth;
      this.uvRects[index * 4 + 3] = cellHeight;

      index++;
    });

    const geometry = this.geometry as THREE.InstancedBufferGeometry;
    geometry.instanceCount = index;

    // Only the live prefix changed, so bound the upload to it. r159 replaced the old single
    // `updateRange` object with these accumulating ranges, hence the clear-then-add each frame.
    for (const name of ['iOffset', 'iScale', 'iRotation', 'iColor', 'iUvRect']) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.clearUpdateRanges();
      if (index > 0) {
        attribute.addUpdateRange(0, index * attribute.itemSize);
      }
      attribute.needsUpdate = true;
    }

    return index;
  }

}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/batch.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/pipeline/m2/particle/batch.ts client/src/game/pipeline/m2/particle/__tests__/batch.test.ts
git commit -m "feat(particle): add instanced batch and attribute packing" -- \
  client/src/game/pipeline/m2/particle/batch.ts \
  client/src/game/pipeline/m2/particle/__tests__/batch.test.ts
```

---

### Task 3: Particle manager

Owns the live emitters and their batches, steps them once per frame, and parents the batch meshes into a group. One emitter, one pool, one batch, for the reasons in the Global Constraints.

Pool capacity is derived from the emitter's own numbers: `ceil(rate * lifespan) + 1`, clamped to `MAX_PARTICLES_PER_EMITTER`. The `+ 1` covers the fractional accumulator's overshoot, and the clamp stops a pathological definition allocating unbounded memory.

**Files:**
- Create: `client/src/game/pipeline/m2/particle/manager.ts`
- Test: `client/src/game/pipeline/m2/particle/__tests__/manager.test.ts`

**Interfaces:**
- Consumes: `RuntimeEmitter` from `./runtime-emitter`; `ParticlePool` from `./pool`; `ParticleBatch` from `./batch` (Task 2); `ParticleMaterial` from `./material` (Task 1); `evaluateAnimationTrack` from `./tracks`.
- Produces: `export class ParticleManager` with
  - `constructor(group: THREE.Object3D)`
  - `static MAX_PARTICLES_PER_EMITTER = 512`
  - `register(instance: any): number` — `instance` is a loaded `M2` (an `Object3D` carrying `particleEmitters` and `textures`); returns how many emitters were registered
  - `unregister(instance: any): void`
  - `animate(delta: number): void`
  - `get emitterCount(): number`
  - `get liveParticleCount(): number`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/pipeline/m2/particle/__tests__/manager.test.ts`:

```ts
/**
 * @jest-environment node
 */
import * as THREE from 'three';

import { ParticleManager } from '../manager';

const constantTrack = (value: number) => ({
  tracks: [{ animationIndex: 0, timestamps: [0], values: [value] }],
});

const emitterDefinition = (overrides: Record<string, any> = {}) => ({
  emitterType: 1,
  textureId: 0,
  blendingType: 4,
  rows: 1,
  columns: 1,
  emissionRate: constantTrack(10),
  emissionSpeed: constantTrack(1),
  speedVariation: constantTrack(0),
  verticalRange: constantTrack(0),
  horizontalRange: constantTrack(0),
  gravity: constantTrack(0),
  lifespan: constantTrack(2),
  emissionAreaWidth: constantTrack(1),
  emissionAreaLength: constantTrack(1),
  zSource: constantTrack(0),
  colorTrack: { keys: [] },
  alphaTrack: { keys: [] },
  scaleTrack: { keys: [] },
  headUVAnim: { keys: [] },
  scaleVary: [0, 0],
  lifespanVariation: 0,
  drag: 0,
  baseSpin: 0,
  spinSpeed: 0,
  enabledIn: { tracks: [] },
  ...overrides,
});

// A stand-in for a loaded M2: an Object3D carrying emitter definitions and a texture table.
const fakeInstance = (emitters: any[]) => {
  const instance: any = new THREE.Object3D();
  instance.particleEmitters = emitters;
  instance.textures = [{ filename: 'TEST\\PARTICLE.BLP' }];
  return instance;
};

describe('ParticleManager', () => {
  it('registers one emitter per definition and reports the count', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(manager.register(fakeInstance([emitterDefinition(), emitterDefinition()]))).toBe(2);
    expect(manager.emitterCount).toBe(2);
  });

  it('registers nothing for an instance with no emitters', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(manager.register(fakeInstance([]))).toBe(0);
    expect(manager.emitterCount).toBe(0);
  });

  it('is idempotent — registering the same instance twice adds nothing', () => {
    const manager = new ParticleManager(new THREE.Group());
    const instance = fakeInstance([emitterDefinition()]);

    manager.register(instance);
    manager.register(instance);

    expect(manager.emitterCount).toBe(1);
  });

  it('adds a batch mesh to the group per emitter and removes it on unregister', () => {
    const group = new THREE.Group();
    const manager = new ParticleManager(group);
    const instance = fakeInstance([emitterDefinition(), emitterDefinition()]);

    manager.register(instance);
    expect(group.children.length).toBe(2);

    manager.unregister(instance);
    expect(group.children.length).toBe(0);
    expect(manager.emitterCount).toBe(0);
  });

  it('emits particles as it animates', () => {
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition()]));

    expect(manager.liveParticleCount).toBe(0);

    for (let i = 0; i < 30; i++) {
      manager.animate(1 / 30);
    }

    expect(manager.liveParticleCount).toBeGreaterThan(0);
  });

  it('caps pool capacity from rate and lifespan', () => {
    const manager = new ParticleManager(new THREE.Group());
    // 10 per second for 2 seconds needs about 20 slots, nowhere near the per-emitter ceiling.
    manager.register(fakeInstance([emitterDefinition()]));

    for (let i = 0; i < 200; i++) {
      manager.animate(1 / 30);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
    expect(manager.liveParticleCount).toBeLessThanOrEqual(25);
  });

  it('clamps a pathological definition to the per-emitter ceiling', () => {
    const manager = new ParticleManager(new THREE.Group());
    manager.register(fakeInstance([emitterDefinition({
      emissionRate: constantTrack(100000),
      lifespan: constantTrack(100),
    })]));

    for (let i = 0; i < 60; i++) {
      manager.animate(1 / 60);
    }

    expect(manager.liveParticleCount).toBeLessThanOrEqual(ParticleManager.MAX_PARTICLES_PER_EMITTER);
  });

  it('tolerates unregistering an instance that was never registered', () => {
    const manager = new ParticleManager(new THREE.Group());

    expect(() => manager.unregister(fakeInstance([emitterDefinition()]))).not.toThrow();
  });

  it('survives an emitter whose textureId is out of range', () => {
    const manager = new ParticleManager(new THREE.Group());
    const instance = fakeInstance([emitterDefinition({ textureId: 99 })]);

    expect(manager.register(instance)).toBe(1);
    expect(() => manager.animate(1 / 60)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/manager.test.ts`

Expected: FAIL — cannot resolve `../manager`.

- [ ] **Step 3: Write the implementation**

Create `client/src/game/pipeline/m2/particle/manager.ts`:

```ts
import * as THREE from 'three';

import { ParticleBatch } from './batch';
import { ParticleMaterial } from './material';
import { ParticlePool } from './pool';
import { RuntimeEmitter } from './runtime-emitter';
import { evaluateAnimationTrack } from './tracks';

interface LiveEmitter {
  emitter: RuntimeEmitter;
  batch: ParticleBatch;
  definition: any;
  instance: any;
}

/**
 * Owns every live particle emitter and its batch.
 *
 * One emitter gets one pool and one batch. That is deliberate for this phase: RuntimeEmitter integrates
 * its whole pool and reports its whole pool's live count, which is only correct while it owns that pool
 * exclusively. The spec's global 20 000-particle budget with proximity ranking needs a shared pool with
 * per-slot ownership and is Phase 2c.
 */
export class ParticleManager {

  /**
   * Ceiling on one emitter's pool. Capacity is normally derived from the emitter's own rate and
   * lifespan; this only bounds a pathological definition, which does exist in game data.
   */
  static MAX_PARTICLES_PER_EMITTER = 512;

  private group: THREE.Object3D;
  private emitters: LiveEmitter[] = [];
  private registered = new Set<any>();

  constructor(group: THREE.Object3D) {
    this.group = group;
  }

  get emitterCount() {
    return this.emitters.length;
  }

  get liveParticleCount() {
    let total = 0;
    for (const entry of this.emitters) {
      total += entry.emitter.liveCount;
    }
    return total;
  }

  /**
   * Register every particle emitter on a loaded M2 instance.
   *
   * @returns how many emitters were registered
   */
  register(instance: any): number {
    if (!instance || this.registered.has(instance)) {
      return 0;
    }

    const definitions = instance.particleEmitters || [];
    if (definitions.length === 0) {
      return 0;
    }

    this.registered.add(instance);

    let added = 0;

    for (const definition of definitions) {
      const capacity = ParticleManager.capacityFor(definition);

      const texture = (instance.textures || [])[definition.textureId];
      const texturePath = texture && texture.filename ? texture.filename : '';

      const material = new ParticleMaterial(texturePath, definition.blendingType);
      const batch = new ParticleBatch(material, capacity, definition.rows, definition.columns);
      const pool = new ParticlePool(capacity);

      this.group.add(batch);
      this.emitters.push({ emitter: new RuntimeEmitter(definition, pool), batch, definition, instance });

      added++;
    }

    return added;
  }

  unregister(instance: any) {
    if (!this.registered.has(instance)) {
      return;
    }

    this.registered.delete(instance);

    this.emitters = this.emitters.filter((entry) => {
      if (entry.instance !== instance) {
        return true;
      }

      this.group.remove(entry.batch);
      entry.batch.geometry.dispose();
      (entry.batch.material as THREE.Material).dispose();

      return false;
    });
  }

  animate(delta: number) {
    for (const entry of this.emitters) {
      // The instance's own matrix places its particles in the world. Emitters bound to a specific bone
      // are Phase 2c; for now every emitter sits at the model's origin.
      entry.instance.updateMatrixWorld(false);

      // Animation time is not tracked per emitter yet, so unanimated inputs are evaluated at time zero.
      // Driving this from the model's animation mixer, wrapped to the clip duration, is Phase 2c.
      entry.emitter.step(delta, 0);
      entry.batch.pack(entry.emitter.pool, entry.definition, entry.instance.matrixWorld);
    }
  }

  private static capacityFor(definition: any): number {
    const rate = evaluateAnimationTrack(definition.emissionRate, 0, 0, 0);
    const lifespan = evaluateAnimationTrack(definition.lifespan, 0, 0, RuntimeEmitter.DEFAULT_LIFESPAN_SECONDS);

    // +1 covers the fractional accumulator's overshoot; the floor of 1 keeps a zero-rate emitter from
    // constructing zero-length typed arrays.
    const needed = Math.ceil(Math.max(0, rate) * Math.max(0, lifespan)) + 1;

    return Math.max(1, Math.min(ParticleManager.MAX_PARTICLES_PER_EMITTER, needed));
  }

}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/manager.test.ts`

Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and run the whole particle suite**

Run: `cd client && npx tsc --noEmit -p tsconfig.json` — expect exit 0.

Run: `cd client && npx jest --watchAll=false src/wow-data-parser/m2/particle/ src/game/pipeline/m2/particle/` — expect all suites passing, exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/pipeline/m2/particle/manager.ts client/src/game/pipeline/m2/particle/__tests__/manager.test.ts
git commit -m "feat(particle): add manager owning emitters and batches" -- \
  client/src/game/pipeline/m2/particle/manager.ts \
  client/src/game/pipeline/m2/particle/__tests__/manager.test.ts
```

---

### Task 4: Wire it up and retire the suppression heuristic

The last task connects the manager to the world and removes the stopgap it replaces.

The heuristic being retired suppressed a submesh when the model had emitters, had exactly one submesh, and that submesh was a 6-vertex quad. It was always a guess at what the particle system would own, and it misses real cases — `WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\ASHENVALEWISPS.M2` has a 15-vertex submesh and slips through, rendering its emitter geometry as solid quads. Now that emitters are actually drawn, the correct rule is direct: **a model with at least one particle emitter does not render its own submeshes**, because that geometry exists to be instanced per particle, not drawn once.

**Files:**
- Modify: `client/src/game/pipeline/m2/index.ts` — replace the heuristic
- Modify: `client/src/game/pipeline/m2/particle/template.ts` — delete the superseded predicate
- Modify: `client/src/game/world/map.js` — construct the manager, step it from `animate`
- Modify: `client/src/game/world/doodad-manager.js` — register/unregister ADT doodads
- Modify: `client/src/game/pipeline/wmo/index.js` — register WMO doodads
- Test: `client/src/game/pipeline/m2/particle/__tests__/template.test.ts` — rewrite for the new rule

**Interfaces:**
- Consumes: `ParticleManager` from Task 3.
- Produces: on `WorldMap`, a public `particleManager: ParticleManager`.

- [ ] **Step 1: Rewrite the suppression test for the new rule**

Replace the contents of `client/src/game/pipeline/m2/particle/__tests__/template.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { modelOwnsSubmeshes } from '../template';

describe('modelOwnsSubmeshes', () => {
  it('is false when the model has no particle emitters', () => {
    expect(modelOwnsSubmeshes(0)).toBe(false);
  });

  it('is true when the model has any particle emitter', () => {
    expect(modelOwnsSubmeshes(1)).toBe(true);
    expect(modelOwnsSubmeshes(4)).toBe(true);
  });

  it('treats a negative or absent count as no emitters', () => {
    expect(modelOwnsSubmeshes(-1)).toBe(false);
    expect(modelOwnsSubmeshes(undefined as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx jest --watchAll=false src/game/pipeline/m2/particle/__tests__/template.test.ts`

Expected: FAIL — `modelOwnsSubmeshes` is not exported.

- [ ] **Step 3: Replace the predicate**

Replace the contents of `client/src/game/pipeline/m2/particle/template.ts`:

```ts
/**
 * Whether a model's own submeshes belong to the particle system rather than the scene graph.
 *
 * An M2 with particle emitters carries geometry that exists to be instanced once per particle. The real
 * client never draws it directly, and drawn as ordinary geometry it appears as opaque quads -- the dark
 * lumps that used to sit over the lava at Blackrock.
 *
 * This replaces an earlier heuristic that also required exactly one submesh of exactly 6 vertices. That
 * was a guess made before the particle system existed, and it missed real models:
 * WORLD\GENERIC\PASSIVEDOODADS\PARTICLEEMITTERS\ASHENVALEWISPS.M2 has a 15-vertex submesh and slipped
 * through, drawing solid quads. Now that emitters are rendered, presence of an emitter is the whole
 * test.
 */
export const modelOwnsSubmeshes = (particleEmitterCount: number): boolean =>
  typeof particleEmitterCount === 'number' && particleEmitterCount > 0;
```

- [ ] **Step 4: Apply it in the M2 pipeline**

In `client/src/game/pipeline/m2/index.ts`:

- Change the import from `import { isParticleTemplate } from './particle/template';` to `import { modelOwnsSubmeshes } from './particle/template';`
- In `createSubmeshes`, replace the `isTemplateSubmesh(...)` call and its surrounding per-submesh check with a single decision taken once before the loop:

```ts
    // A model with particle emitters owns its own geometry; the particle system instances it per
    // particle rather than the scene graph drawing it once.
    const suppressAll = modelOwnsSubmeshes(this.particleEmitters.length);
```

  and inside the loop, where `isTemplateSubmesh` was consulted:

```ts
      if (suppressAll) {
        if (submeshBatches) {
          this.suppressedBatches.push(...submeshBatches);
        }
        continue;
      }
```

- Delete the now-unused `isTemplateSubmesh` method, and the `submeshCount` local if nothing else reads it. Leave `suppressedBatches` and `ownsBatches` alone — they still dispose the materials of suppressed submeshes.

- [ ] **Step 5: Construct and step the manager**

In `client/src/game/world/map.js`:

- Add `import { ParticleManager } from '../pipeline/m2/particle/manager';` beside the existing imports.
- In the constructor, after `this.wmoManager = new WMOManager(...)`, add:

```js
    // Particles live in their own group so that doodad visibility culling cannot take them with it.
    this.particleGroup = new THREE.Group();
    this.particleGroup.name = 'Particles';
    this.add(this.particleGroup);

    this.particleManager = new ParticleManager(this.particleGroup);
```

- In `animate(delta, camera, cameraMoved)`, after the three existing manager calls, add:

```js
    this.particleManager.animate(delta);
```

- [ ] **Step 6: Register ADT doodads**

In `client/src/game/world/doodad-manager.js`:

- In `loadDoodad`, immediately after `this.placeDoodad(doodad, entry.position, entry.rotation, entry.scale);`, add:

```js
      if (this.map.particleManager) {
        this.map.particleManager.register(doodad);
      }
```

- `DoodadManager`'s constructor stores the map as `this.map` (`doodad-manager.js:16`), so that reference is correct as written.
- `unloadDoodad(entry)` is at `doodad-manager.js:181` and reads:

```js
  unloadDoodad(entry) {
    const doodad = this.doodads.get(entry.id);
    this.doodads.delete(entry.id);
    this.animatedDoodads.delete(entry.id);
    this.view.remove(doodad);

    M2Blueprint.unload(doodad);
  }
```

  Insert the unregister immediately after the `const doodad = ...` line, while the reference is still in hand:

```js
    if (this.map.particleManager) {
      this.map.particleManager.unregister(doodad);
    }
```

- [ ] **Step 7: Register WMO doodads**

`WMO` does not hold the map, so the manager has to be threaded in. The route is already open:

- `client/src/game/world/map.js:38` constructs the manager's owner as `new WMOManager(this, this.constructor.ZEROPOINT)`, so `WMOManager`'s first constructor parameter — named `view` — **is** the `WorldMap`. `this.view.particleManager` is therefore reachable inside `WMOManager`.
- `client/src/game/world/wmo-manager.js:188` constructs WMOs as `new WMO(entry.filename, entry.doodadSet, entry.id, this.counters)`. Add a fifth argument, `this.view.particleManager`.
- `client/src/game/pipeline/wmo/index.js:20` is `constructor(filename, doodadSetIndex = null, entryID = null, parentCounters = null)`. Add `particleManager = null` as a fifth parameter and store it as `this.particleManager`.
- Register after the doodad is stored, at `wmo/index.js:247` (`this.doodads.set(doodadEntry.id, doodad);`):

```js
      if (this.particleManager) {
        this.particleManager.register(doodad);
      }
```

- The teardown path exists at `wmo/index.js:268`, which calls `M2Blueprint.unload(doodad)`. Add the matching unregister immediately before it:

```js
      if (this.particleManager) {
        this.particleManager.unregister(doodad);
      }
```

- [ ] **Step 8: Verify**

Run: `cd client && npx tsc --noEmit -p tsconfig.json` — expect exit 0.

Run: `cd client && npx jest --watchAll=false` — expect the whole suite green, exit 0.

Do **not** start the dev server. Report that in-client verification is left to the controller.

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(particle): render particles and retire the suppression heuristic" -- \
  client/src/game/pipeline/m2/index.ts \
  client/src/game/pipeline/m2/particle/template.ts \
  client/src/game/pipeline/m2/particle/__tests__/template.test.ts \
  client/src/game/world/map.js \
  client/src/game/world/doodad-manager.js \
  client/src/game/pipeline/wmo/index.js \
  client/src/game/world/wmo-manager.js
```

Adjust the pathspec to the files you actually changed, then run `git show --stat HEAD` and confirm the list matches.

---

## Verification summary

After all four tasks:

- `cd client && npx jest --watchAll=false` — whole suite green, exit 0. Roughly 24 new tests on top of Phase 2a's 82.
- `cd client && npx tsc --noEmit -p tsconfig.json` — exit 0.
- Controller verifies in the running client at Blackrock (`worldport(0, [-7553, -1077, 210])`): smoke and lava-splash particles visible over the lava, `window.world.map.particleManager.emitterCount` and `.liveParticleCount` both non-zero, no page errors, and the ordinary doodads still at 165 doodads / 405 M2 meshes so nothing was over-suppressed.

## Out of scope for this phase — Phase 2c

- The shared pool with per-slot ownership, and the global proximity-ranked 20 000-particle budget with distance culling and emitter release.
- Driving animation time from each model's animation mixer, wrapped to the clip duration. Until then animated emitter inputs are evaluated at time zero, which is correct for the unanimated majority.
- Bone-bound emitters, so an emitter follows an animated creature rather than sitting at the model's origin.
- Per-particle depth sorting; tail particles; spline and bone emitter types; tumble; multi-texture.
- Spin variation (`baseSpinVariation`, `spinSpeedVariation`), so particles in a batch stop spinning in lockstep.
- Back-dating each spawn by its fractional share of `dt`, to stop visible packet-banding at low frame rates.
- The compressed-gravity branch: when `flags & 0x800000` is set, gravity track values are packed vectors, decoded as
  `dir = C3Vector(int8 x, int8 y, 0) * (1/128); z = sqrt(1 - dir.dot(dir)); mag = int16 z * 0.04238648; if (mag < 0) { z = -z; mag = -mag; } dir.z = z; dir *= mag;`
  No emitter in the current fixture corpus sets the flag, so this is latent rather than active.
