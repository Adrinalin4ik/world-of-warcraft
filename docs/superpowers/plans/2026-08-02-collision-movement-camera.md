# Collision, Movement, Camera and Swim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player a body that walks, jumps, falls, climbs stairs, slides off steep faces, wades and swims with vanilla WoW's feel, under a third-person camera that turns, orbits, zooms and collides like vanilla's.

**Architecture:** Collision reads the acceleration structures the WoW files already ship — the ADT MCVT heightmap grid (O(1), no tree), the WMO MOBN/MOBR BSP, M2 low-poly bounding hulls, and ADT MH2O / WMO MLIQ liquid grids. A candidate-triangle gather feeds one swept-capsule cast, and every movement rule from `samples/benilla` is ported on top of that single primitive. No physics engine, no BVH builds over streamed geometry.

**Tech Stack:** TypeScript, three.js r185 (Z-up, WoW-native coords), jest (CRA runner), restructure (DBC/chunk parsing), web workers for asset decode.

**Reference:** `samples/benilla/crates/benilla/src/` — `collision.rs`, `player/mover.rs`, `player/state.rs`, `player/swim.rs`, `player/camera.rs`.

**Spec:** `docs/superpowers/specs/2026-08-02-collision-movement-camera-design.md`

## Global Constraints

- **Coordinate system is Z-up, WoW-native.** The reference is Bevy Y-up. Every port applies: `normal1.y` → `normal.z`; `Vec3::NEG_Y * d` → `(0,0,-d)`; `d.x.hypot(d.z)` → `Math.hypot(d.x, d.y)`; yaw about Y → yaw about Z.
- **Units are WoW yards in both.** No scaling. `Chunk.SIZE = 33.33333` = 100/3 yd.
- **Verified constants keep their provenance comments.** When porting a constant from `player/state.rs` or `player/swim.rs`, copy the byte address / decision number / VERIFIED marker into the TypeScript comment. These numbers are unmaintainable without it.
- **Every mover and swim function takes its world access as a parameter** (a `cast` closure, a `surfaceAt` closure) exactly as the reference does. This is what makes them testable with no world loaded. Do not reach for a module-level singleton inside them.
- **Test command:** from `client/`, `CI=true npm test -- --testPathPattern="<pattern>"`. (PowerShell: `$env:CI='true'; npm test -- --testPathPattern="<pattern>"`.)
- **Test files** live in a `__tests__/` directory beside the code, named `<module>.test.ts`, and start with `/** @jest-environment node */` — matching `client/src/game/world/light/__tests__/`.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`, `chore:`), matching this repo's history.
- **Deferred but prepared for:** networking. Keep `faceYaw`/`modelYaw` separate, keep `mover.step()` returning its `Outcome`, and keep the wire-facing state fields maintained. Do not add wire code.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `client/src/game/collision/types.ts` | `Triangle`, `CastHit`, `CollisionLayer`, `LiquidClaim` — shared shapes only |
| `client/src/game/collision/layers.ts` | MOPY masks; which face set each audience sees |
| `client/src/game/collision/capsule-cast.ts` | Swept capsule vs triangle list — the one primitive |
| `client/src/game/collision/terrain-provider.ts` | MCVT grid → candidate triangles |
| `client/src/game/collision/wmo-provider.ts` | MOBN/MOBR BSP box query → candidate triangles |
| `client/src/game/collision/doodad-provider.ts` | M2 bounding hulls → candidate triangles |
| `client/src/game/collision/liquid-query.ts` | MH2O / MLIQ grid → surface Z at XY |
| `client/src/game/collision/collision-world.ts` | Owns the providers; the `cast` + `surfaceAt` closures the movers take |
| `client/src/game/movement/constants.ts` | Every verified movement constant, with provenance |
| `client/src/game/movement/player-state.ts` | `PlayerMoveState` — the mover's mutable state |
| `client/src/game/movement/slide.ts` | `moveAndSlide` + the two hit rules |
| `client/src/game/movement/step-up.ts` | The atomic rise/advance/settle maneuver |
| `client/src/game/movement/mover.ts` | `step`, `groundedStep`, `airborneStep` |
| `client/src/game/movement/swim.ts` | Depth latch, rest line, cap redirect, swim/breach steps |
| `client/src/game/movement/move-trace.ts` | Per-frame probe trace (the `WOW_MOVE_TRACE` equivalent) |
| `client/src/game/camera/rig.ts` | `CameraControl` state, look session, zoom glide, `seatCamera` |
| `client/src/game/camera/pivot.ts` | `headHeight` — attachment-17 pivot with bbox fallback |

**Modified:**

| File | Change |
|---|---|
| `client/src/game/pipeline/wmo/group/loader/definition.js` | Carry MOPY flags into `attributes` + transferables |
| `client/src/wow-data-parser/dbc/entities/creature-model-data.js` | Reach `collisionWidth` / `collisionHeight` |
| `blizzardry/src/lib/dbc/entities/creature-model-data.js` | Same, kept in sync |
| `client/src/game/world/terrain-manager.js` | Register chunks with `CollisionWorld` |
| `client/src/game/world/wmo-manager.js` | Register WMO placements with `CollisionWorld` |
| `client/src/game/pipeline/m2/index.ts` | Register bounding hulls with `CollisionWorld` |
| `client/src/game/classes/unit.ts` | Drive the mover; delete the dead movement/collision code |
| `client/src/pages/game/controls/controls.tsx` | Thin input adapter over the rig |
| `client/src/pages/game/debug/debug.tsx` | Surface the move trace |

**Deleted:** `client/src/game/world/collider-manager.js`

---

## Task 1: MOPY triangle flags cross the worker boundary

Without this the walk and camera face sets cannot differ, so it blocks every later collision task.

**Files:**
- Modify: `client/src/game/pipeline/wmo/group/loader/definition.js`
- Test: `client/src/game/pipeline/wmo/group/loader/__tests__/definition-mopy.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `WMOGroupDefinition.attributes.triangleFlags: Uint8Array` — one byte per triangle, MOPY's `flags`. Length equals `attributes.indices.length / 3`.

- [ ] **Step 1: Read the file to find the attribute block and the transferable list**

Run: read `client/src/game/pipeline/wmo/group/loader/definition.js`. The attribute block starts near line 56 (`const attributes = this.attributes = {}`); the transferable list is near line 470 (`list.push(this.attributes.indices.buffer)`).

- [ ] **Step 2: Write the failing test**

Create `client/src/game/pipeline/wmo/group/loader/__tests__/definition-mopy.test.ts`:

```ts
/** @jest-environment node */
import WMOGroupDefinition from '../definition';

/**
 * MOPY carries one byte of flags per triangle. It is parsed but was previously dropped before the
 * worker postMessage, so the walk (drop DETAIL 0x04) and camera (drop NOCAMCOLLIDE 0x02) face sets
 * had nothing to filter on. See collision.rs in the reference.
 */
function groupDataWithTriangles(flags: number[]) {
  const triangleCount = flags.length;
  return {
    MOGP: {
      flags: 0,
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      portalOffset: 0, portalCount: 0,
      batchOffsets: { a: 0, b: 0, c: 0 },
      materialRefs: [], doodadRefs: [], lightRefs: [], fogOffsets: [0, 0, 0, 0],
      groupID: 0,
    },
    MOPY: { triangles: flags.map((f) => ({ flags: f, materialID: 0 })) },
    MOVI: { triangles: new Array(triangleCount * 3).fill(0) },
    MOVT: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
    MONR: { normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]] },
    MOTV: { textureCoords: [[0, 0], [1, 0], [0, 1]] },
    MOBA: { batches: [] },
    MOBN: { nodes: [] },
    MOBR: { indices: [] },
    MOCV: null,
    MODR: null,
    MOLR: null,
    MLIQ: null,
    interior: false,
    exterior: true,
  };
}

test('MOPY flags reach attributes.triangleFlags, one byte per triangle', () => {
  const def: any = new (WMOGroupDefinition as any)(
    'TEST.WMO', 0, { materialCount: 0 }, groupDataWithTriangles([0x00, 0x04, 0x02, 0x24]),
  );

  expect(def.attributes.triangleFlags).toBeInstanceOf(Uint8Array);
  expect(Array.from(def.attributes.triangleFlags)).toEqual([0x00, 0x04, 0x02, 0x24]);
  expect(def.attributes.triangleFlags.length).toBe(def.attributes.indices.length / 3);
});

test('the flags buffer is listed as transferable so it survives postMessage', () => {
  const def: any = new (WMOGroupDefinition as any)(
    'TEST.WMO', 0, { materialCount: 0 }, groupDataWithTriangles([0x04, 0x02]),
  );

  expect(def.transferable).toContain(def.attributes.triangleFlags.buffer);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="definition-mopy"`
Expected: FAIL — `def.attributes.triangleFlags` is `undefined`, so `toBeInstanceOf(Uint8Array)` fails.

If the constructor throws instead because the fixture is missing a field the real constructor reads, add that field to `groupDataWithTriangles` with a harmless value and re-run. The fixture must exercise the real constructor, not a stub.

- [ ] **Step 4: Add the attribute**

In `definition.js`, inside the attribute block beside `indices` / `positions`:

```js
    // MOPY: one flags byte per triangle. The player body and the camera collide against different
    // face sets -- walk drops DETAIL (0x04), camera drops NOCAMCOLLIDE (0x02) -- so the collision
    // layer needs these per-face. Parsed all along; it just never crossed the worker boundary.
    const triangleFlags = attributes.triangleFlags = new Uint8Array(indexCount / 3);
    const mopy = groupData.MOPY.triangles;
    for (let i = 0, len = triangleFlags.length; i < len; ++i) {
      triangleFlags[i] = mopy[i] ? mopy[i].flags : 0;
    }
```

- [ ] **Step 5: Add it to the transferable list**

Beside the existing `list.push(this.attributes.indices.buffer)`:

```js
    list.push(this.attributes.triangleFlags.buffer);
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="definition-mopy"`
Expected: PASS, 2 tests.

- [ ] **Step 7: Confirm nothing else broke**

Run: `cd client && CI=true npm test -- --testPathPattern="wmo"`
Expected: PASS — no pre-existing WMO test regresses.

- [ ] **Step 8: Commit**

```bash
git add client/src/game/pipeline/wmo/group/loader/definition.js client/src/game/pipeline/wmo/group/loader/__tests__/definition-mopy.test.ts
git commit -m "feat(wmo): carry MOPY triangle flags across the worker boundary

The player body and the camera collide against different WMO face sets --
walk drops DETAIL (0x04), camera drops NOCAMCOLLIDE (0x02). MOPY was
parsed but never copied into the group attributes, so there was nothing
to filter on."
```

---

## Task 2: Reach `CreatureModelData.collisionHeight`

Every swim depth line is a fraction of this value, so swimming cannot be correct without it. The entity currently ends at `bloodID` followed by `Reserved(uint32, 22)`, which swallows it.

**Files:**
- Modify: `client/src/wow-data-parser/dbc/entities/creature-model-data.js`
- Modify: `blizzardry/src/lib/dbc/entities/creature-model-data.js`
- Test: `client/src/wow-data-parser/dbc/entities/__tests__/creature-model-data.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `CreatureModelData` records gain `collisionWidth: number` and `collisionHeight: number` (both float32). The unit's world collision height is `collisionHeight × displayScale`.

- [ ] **Step 1: Confirm the field layout**

Vanilla 1.12 `CreatureModelData.dbc` is 28 fields:

```
 0 ID                     10 foleyMaterialID        20..22 geoBoxMax[3]
 1 flags                  11 footstepShakeSize      23 worldEffectScale
 2 modelName (StringRef)  12 deathThudShakeSize     24 attachedEffectScale
 3 sizeClass              13 soundID                25 missileCollisionRadius
 4 modelScale             14 collisionWidth         26 missileCollisionPush
 5 blood_ID               15 collisionHeight        27 missileCollisionRaise
 6..9 footprint*          16 mountHeight
                          17..19 geoBoxMin[3]
```

The current struct is 6 named fields + `Reserved(22)` = 28. So the replacement must also sum to 22: skip 8 (indices 6–13), read 2 floats (14, 15), skip 12 (16–27).

- [ ] **Step 2: Write the failing test**

Create `client/src/wow-data-parser/dbc/entities/__tests__/creature-model-data.test.ts`:

```ts
/** @jest-environment node */
import * as r from 'restructure';
import CreatureModelData from '../creature-model-data';

/**
 * Builds one 28-field record as raw little-endian bytes and decodes it, so the test pins the field
 * OFFSETS rather than trusting the struct declaration to be self-consistent. collisionHeight is
 * field 15; every swim depth line is a fraction of it (reference: swim.rs, decision 0645).
 */
function encodeRecord(fields: Array<{ i: number; f?: number; u?: number }>) {
  const buf = Buffer.alloc(28 * 4);
  for (const { i, f, u } of fields) {
    if (f !== undefined) buf.writeFloatLE(f, i * 4);
    else buf.writeUInt32LE(u!, i * 4);
  }
  return buf;
}

test('collisionWidth and collisionHeight decode from fields 14 and 15', () => {
  const buf = encodeRecord([
    { i: 0, u: 42 },       // ID
    { i: 4, f: 1.15 },     // modelScale
    { i: 14, f: 0.75 },    // collisionWidth
    { i: 15, f: 2.031 },   // collisionHeight -- human male
  ]);

  const record: any = (CreatureModelData as any).decode(new r.DecodeStream(buf));

  expect(record.id).toBe(42);
  expect(record.scale).toBeCloseTo(1.15, 5);
  expect(record.collisionWidth).toBeCloseTo(0.75, 5);
  expect(record.collisionHeight).toBeCloseTo(2.031, 5);
});

test('the record is still 28 fields wide, so the DBC row stride is unchanged', () => {
  expect((CreatureModelData as any).size()).toBe(28 * 4);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="creature-model-data"`
Expected: FAIL — `record.collisionHeight` is `undefined`.

If `CreatureModelData.decode` is not directly callable because `Entity` wraps it, read `client/src/wow-data-parser/dbc/entity.js` and call whatever it exposes; adapt the test to the real API rather than changing the entity to suit the test.

- [ ] **Step 4: Split the reserved block**

In `client/src/wow-data-parser/dbc/entities/creature-model-data.js`, replace `skips: new r.Reserved(r.uint32le, 22)` with:

```js
  // Fields 6..13: footprintTextureID, footprintTextureLength, footprintTextureWidth,
  // footprintParticleScale, foleyMaterialID, footstepShakeSize, deathThudShakeSize, soundID.
  skipsBeforeCollision: new r.Reserved(r.uint32le, 8),

  // Field 14/15. collisionHeight x displayScale is the unit's world collision height -- the number
  // every swim depth line is a fraction of (reference: swim.rs `swim_enter_depth`, decision 0645).
  // It is NOT the movement capsule height, which is a constant feel knob; the two are deliberately
  // different quantities.
  collisionWidth: r.floatle,
  collisionHeight: r.floatle,

  // Fields 16..27: mountHeight, geoBoxMin[3], geoBoxMax[3], worldEffectScale, attachedEffectScale,
  // missileCollisionRadius, missileCollisionPush, missileCollisionRaise.
  skipsAfterCollision: new r.Reserved(r.uint32le, 12)
```

- [ ] **Step 5: Mirror the change into blizzardry**

Apply the identical edit to `blizzardry/src/lib/dbc/entities/creature-model-data.js` (it uses `import r from 'restructure'` rather than `import * as r`; keep the file's existing import style).

- [ ] **Step 6: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="creature-model-data"`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add client/src/wow-data-parser/dbc/entities/creature-model-data.js blizzardry/src/lib/dbc/entities/creature-model-data.js client/src/wow-data-parser/dbc/entities/__tests__/creature-model-data.test.ts
git commit -m "feat(dbc): reach CreatureModelData.collisionWidth/collisionHeight

Fields 14 and 15 sat inside a Reserved(22) block. Every swim depth line
is a fraction of collisionHeight x displayScale, and using one constant
for every race puts a gnome's rest line above her own head."
```

---

## Task 3: Collision types and the two face-set layers

**Files:**
- Create: `client/src/game/collision/types.ts`
- Create: `client/src/game/collision/layers.ts`
- Test: `client/src/game/collision/__tests__/layers.test.ts`

**Interfaces:**
- Consumes: `attributes.triangleFlags` from Task 1
- Produces:
  - `interface Triangle { a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; normal: THREE.Vector3; source: object }`
  - `interface CastHit { distance: number; normal: THREE.Vector3; source: object }`
  - `enum CollisionLayer { Walk, Camera }`
  - `interface LiquidClaim { wmoGroup: object | null }`
  - `MOPY_DETAIL = 0x04`, `MOPY_NOCAMCOLLIDE = 0x02`
  - `wmoFaceIsCollidable(flags: number, layer: CollisionLayer): boolean`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/layers.test.ts`:

```ts
/** @jest-environment node */
import { CollisionLayer, MOPY_DETAIL, MOPY_NOCAMCOLLIDE, wmoFaceIsCollidable } from '../layers';

/**
 * The reference's collision.rs: the player body and the camera collide against DIFFERENT sets of
 * WMO faces. Walk drops DETAIL (0x04); camera drops NOCAMCOLLIDE (0x02). So the camera collides
 * with visible decals and overhangs the player walks under, and passes through NOCAMCOLLIDE faces
 * the player still stands on.
 */
test('a plain face is collidable by both audiences', () => {
  expect(wmoFaceIsCollidable(0x00, CollisionLayer.Walk)).toBe(true);
  expect(wmoFaceIsCollidable(0x00, CollisionLayer.Camera)).toBe(true);
});

test('a DETAIL face is walked under but the camera still hits it', () => {
  expect(wmoFaceIsCollidable(MOPY_DETAIL, CollisionLayer.Walk)).toBe(false);
  expect(wmoFaceIsCollidable(MOPY_DETAIL, CollisionLayer.Camera)).toBe(true);
});

test('a NOCAMCOLLIDE face is stood on but the camera passes through it', () => {
  expect(wmoFaceIsCollidable(MOPY_NOCAMCOLLIDE, CollisionLayer.Walk)).toBe(true);
  expect(wmoFaceIsCollidable(MOPY_NOCAMCOLLIDE, CollisionLayer.Camera)).toBe(false);
});

test('a face flagged both ways is collidable by neither', () => {
  const both = MOPY_DETAIL | MOPY_NOCAMCOLLIDE;
  expect(wmoFaceIsCollidable(both, CollisionLayer.Walk)).toBe(false);
  expect(wmoFaceIsCollidable(both, CollisionLayer.Camera)).toBe(false);
});

test('unrelated MOPY bits do not affect either audience', () => {
  // 0x08 COLLIDE_HIT, 0x20 COLLISION, 0x40 HINT, 0x80 RENDER -- none of them gate these two sets.
  for (const bit of [0x01, 0x08, 0x10, 0x20, 0x40, 0x80]) {
    expect(wmoFaceIsCollidable(bit, CollisionLayer.Walk)).toBe(true);
    expect(wmoFaceIsCollidable(bit, CollisionLayer.Camera)).toBe(true);
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="collision/__tests__/layers"`
Expected: FAIL — `Cannot find module '../layers'`.

- [ ] **Step 3: Write `types.ts`**

```ts
import * as THREE from 'three';

/**
 * One candidate collision triangle in WORLD space, with its face normal precomputed.
 *
 * The movement rules are all normal-driven (walkable iff `normal.z >= GROUND_COS`, the steep-wall
 * flatten, the election snap), so the normal travels with the triangle rather than being recomputed
 * per query. `source` is whatever produced it -- a terrain Chunk, a WMO group view, an M2 hull --
 * kept so a caller can tell what it stood on (the reference's `MoveHitData.entity`, which the
 * transport attach keys off).
 */
export interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  source: object;
}

/** What a swept capsule cast found. Mirrors the reference's `MoveHitData`. */
export interface CastHit {
  /** Distance travelled along the cast direction before contact (yards). Never negative. */
  distance: number;
  /** The contacted face's outward normal. */
  normal: THREE.Vector3;
  /** The `Triangle.source` of the contacted face. */
  source: object;
}

/**
 * The two collision AUDIENCES (reference: collision.rs). Terrain and doodads belong to both; only
 * WMO faces are filtered, and they are filtered differently for each.
 */
export enum CollisionLayer {
  Walk = 'walk',
  Camera = 'camera',
}

/**
 * Which room's liquid answers a surface query. Inside a WMO group only THAT placement's own MLIQ
 * answers; outdoors only the ADT's. Without the scoping, a building's floor liquid answers for
 * someone standing outside it -- the reference's "swim in air" defect class (decisions 0634/0696).
 */
export interface LiquidClaim {
  /** The WMO group the player is currently inside, or null when outdoors. */
  wmoGroup: object | null;
}
```

- [ ] **Step 4: Write `layers.ts`**

```ts
import { CollisionLayer } from './types';

export { CollisionLayer };

/**
 * MOPY `0x04` DETAIL -- decorative geometry the player walks under but the camera must still see.
 * Dropped from the WALK face set. VERIFIED (reference: collision.rs, wow-5875-re
 * system/collision/collision.md).
 */
export const MOPY_DETAIL = 0x04;

/**
 * MOPY `0x02` NOCAMCOLLIDE -- faces the player stands on but the camera passes through. Dropped
 * from the CAMERA face set. VERIFIED, same source.
 */
export const MOPY_NOCAMCOLLIDE = 0x02;

/**
 * Is this WMO face part of the given audience's collision set?
 *
 * The player body collides with terrain/doodads plus WMO faces minus DETAIL; the camera collides
 * with terrain/doodads plus WMO faces minus NOCAMCOLLIDE. That asymmetry is the whole point: the
 * camera stops at the forge pipes you walk under, and threads the railings you stand on.
 */
export function wmoFaceIsCollidable(flags: number, layer: CollisionLayer): boolean {
  const reject = layer === CollisionLayer.Walk ? MOPY_DETAIL : MOPY_NOCAMCOLLIDE;
  return (flags & reject) === 0;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="collision/__tests__/layers"`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/collision/types.ts client/src/game/collision/layers.ts client/src/game/collision/__tests__/layers.test.ts
git commit -m "feat(collision): the two WMO collision audiences

Walk drops DETAIL (0x04), camera drops NOCAMCOLLIDE (0x02), so the
camera stops at overhangs the player walks under and threads railings
the player stands on."
```

---

## Task 4: The swept capsule cast

This is the single primitive every movement rule and the camera boom are built on — the reference's `cast_move`. It is the highest-risk piece in the plan, so it is tested hardest.

**Files:**
- Create: `client/src/game/collision/capsule-cast.ts`
- Test: `client/src/game/collision/__tests__/capsule-cast.test.ts`

**Interfaces:**
- Consumes: `Triangle`, `CastHit` from Task 3
- Produces:
  - `CAPSULE_CAST_EPS = 1e-4`
  - `closestDistanceCapsuleTriangle(base: THREE.Vector3, halfSegment: number, radius: number, tri: Triangle): number` — signed gap, negative while overlapping
  - `castCapsuleAgainstTriangles(from, dir, maxDist, radius, halfSegment, tris, skin): CastHit | null`

  `from` is the capsule **centre**. The axis is vertical (Z), running `from ± halfSegment·ẑ`, where `halfSegment = CAPSULE_HEIGHT/2 − radius`. `dir` must be unit length. `skin` is the gap kept off the surface.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/capsule-cast.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { castCapsuleAgainstTriangles } from '../capsule-cast';
import { Triangle } from '../types';

const RADIUS = 1 / 3;
const HALF_SEGMENT = 2.0277777 / 2 - RADIUS;

/** A triangle with an explicit outward normal, in world space. */
function tri(
  a: [number, number, number], b: [number, number, number], c: [number, number, number],
  normal: [number, number, number], source: object = {},
): Triangle {
  return {
    a: new THREE.Vector3(...a), b: new THREE.Vector3(...b), c: new THREE.Vector3(...c),
    normal: new THREE.Vector3(...normal).normalize(), source,
  };
}

/** A large flat floor at z = height, as two triangles, normal +Z. */
function floor(height: number, source: object = {}): Triangle[] {
  const s = 50;
  return [
    tri([-s, -s, height], [s, -s, height], [s, s, height], [0, 0, 1], source),
    tri([-s, -s, height], [s, s, height], [-s, s, height], [0, 0, 1], source),
  ];
}

/** A large vertical wall at x = at, facing -X. */
function wall(at: number, source: object = {}): Triangle[] {
  const s = 50;
  return [
    tri([at, -s, -s], [at, s, -s], [at, s, s], [-1, 0, 0], source),
    tri([at, -s, -s], [at, s, s], [at, -s, s], [-1, 0, 0], source),
  ];
}

const cast = (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, tris: Triangle[], skin = 0) =>
  castCapsuleAgainstTriangles(from, dir, maxDist, RADIUS, HALF_SEGMENT, tris, skin);

test('a downward cast onto a floor stops with the bottom cap touching it', () => {
  // Capsule centre 5 above a floor at 0. The bottom of the capsule sits HALF_SEGMENT + RADIUS below
  // the centre, so it has that much less than 5 of free travel.
  const hit = cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1), 10, floor(0));

  expect(hit).not.toBeNull();
  expect(hit!.distance).toBeCloseTo(5 - (HALF_SEGMENT + RADIUS), 3);
  expect(hit!.normal.z).toBeCloseTo(1, 5);
});

test('a cast that cannot reach the floor within maxDist misses', () => {
  expect(cast(new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, -1), 1, floor(0))).toBeNull();
});

test('a horizontal cast into a wall stops one radius short of it', () => {
  const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 20, wall(10));

  expect(hit).not.toBeNull();
  expect(hit!.distance).toBeCloseTo(10 - RADIUS, 3);
  expect(hit!.normal.x).toBeCloseTo(-1, 5);
});

test('the skin width is held back off the surface', () => {
  const from = new THREE.Vector3(0, 0, 0);
  const bare = cast(from, new THREE.Vector3(1, 0, 0), 20, wall(10), 0);
  const skinned = cast(from, new THREE.Vector3(1, 0, 0), 20, wall(10), 0.02);

  expect(skinned!.distance).toBeCloseTo(bare!.distance - 0.02, 4);
});

test('the nearest of several triangles wins, and reports its own source', () => {
  const near = {}; const far = {};
  const tris = [...wall(15, far), ...wall(6, near)];
  const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 30, tris);

  expect(hit!.distance).toBeCloseTo(6 - RADIUS, 3);
  expect(hit!.source).toBe(near);
});

test('a cast parallel to a wall never touches it', () => {
  const from = new THREE.Vector3(10 - RADIUS - 0.05, 0, 0);
  expect(cast(from, new THREE.Vector3(0, 1, 0), 20, wall(10))).toBeNull();
});

test('a cast away from a surface misses it', () => {
  expect(cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 1), 10, floor(0))).toBeNull();
});

test('origin penetration is ignored so a grazing body can still cast outward', () => {
  // Reference (camera.rs): "cast_move ignores origin penetration, so a head grazing a surface still
  // casts outward". Start the capsule already intersecting the wall, cast AWAY from it.
  const from = new THREE.Vector3(10 - RADIUS * 0.5, 0, 0);
  expect(cast(from, new THREE.Vector3(-1, 0, 0), 20, wall(10))).toBeNull();
});

test('a walkable ramp reports its true normal, not a flattened one', () => {
  // A 30-degree ramp rising toward +x: normal is (-sin30, 0, cos30).
  const s = 50, k = Math.tan(Math.PI / 6);
  const n: [number, number, number] = [-Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
  const ramp: Triangle[] = [
    tri([-s, -s, -s * k], [s, -s, s * k], [s, s, s * k], n),
    tri([-s, -s, -s * k], [s, s, s * k], [-s, s, -s * k], n),
  ];
  const hit = cast(new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, -1), 20, ramp);

  expect(hit).not.toBeNull();
  expect(hit!.normal.z).toBeCloseTo(Math.cos(Math.PI / 6), 4);
});

test('an empty candidate list misses', () => {
  expect(cast(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1), 10, [])).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="capsule-cast"`
Expected: FAIL — `Cannot find module '../capsule-cast'`.

- [ ] **Step 3: Write `client/src/game/collision/capsule-cast.ts`**

```ts
import * as THREE from 'three';
import { CastHit, Triangle } from './types';

/** Convergence tolerance for the advance loop (yards). */
export const CAPSULE_CAST_EPS = 1e-4;

/**
 * Iteration ceiling for conservative advancement. Each step advances by the full free gap, so the
 * loop converges geometrically; 48 is far above what any real candidate set needs and exists only
 * so a degenerate triangle cannot spin the frame.
 */
const MAX_ADVANCE_STEPS = 48;

const _closestTri = new THREE.Vector3();
const _closestSeg = new THREE.Vector3();
const _segStart = new THREE.Vector3();
const _segEnd = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _line = new THREE.Line3();
const _three = new THREE.Triangle();

/**
 * Distance from the capsule's AXIS SEGMENT to a triangle, minus the radius: the signed gap between
 * the capsule surface and the face. Negative while overlapping.
 *
 * `base` is the capsule centre; the axis runs +/- `halfSegment` along Z from it.
 */
export function closestDistanceCapsuleTriangle(
  base: THREE.Vector3, halfSegment: number, radius: number, tri: Triangle,
): number {
  _segStart.set(base.x, base.y, base.z - halfSegment);
  _segEnd.set(base.x, base.y, base.z + halfSegment);
  _line.set(_segStart, _segEnd);
  _three.set(tri.a, tri.b, tri.c);
  return _three.closestPointToSegment(_line, _closestTri, _closestSeg) - radius;
}

/**
 * Sweep a vertical capsule from `from` along unit `dir` for at most `maxDist`, returning the first
 * contact -- the reference's `cast_move` (mover.rs), and the one world primitive the whole movement
 * and camera stack is built on.
 *
 * **Conservative advancement.** At each step the smallest gap over the candidate triangles is the
 * furthest the capsule can possibly travel without touching anything: `dir` is unit length, so the
 * gap can shrink at most one yard per yard travelled. Advance by exactly that and repeat. This is
 * exact at convergence, needs no substep tuning, and is affordable precisely because the candidate
 * list is small -- tens of triangles, gathered from the structures the WoW files ship.
 *
 * **Origin penetration is ignored**, matching the reference: a capsule already overlapping a face
 * (a head grazing a ceiling) still casts outward instead of reporting an instant hit. Any triangle
 * whose gap is already negative at t = 0 is dropped for the whole sweep.
 *
 * Returns `null` when nothing is reached within `maxDist`. `skin` is subtracted from the reported
 * distance so the caller stops that far off the surface; the result is clamped at 0.
 */
export function castCapsuleAgainstTriangles(
  from: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  radius: number,
  halfSegment: number,
  tris: Triangle[],
  skin = 0,
): CastHit | null {
  if (tris.length === 0 || maxDist <= 0) {
    return null;
  }

  // Drop faces we START inside. Reporting those would stop every cast dead the moment a capsule
  // rested against anything -- including the down-probe that runs every grounded frame.
  const candidates: Triangle[] = [];
  for (let i = 0; i < tris.length; ++i) {
    if (closestDistanceCapsuleTriangle(from, halfSegment, radius, tris[i]) > 0) {
      candidates.push(tris[i]);
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  let travelled = 0;
  for (let step = 0; step < MAX_ADVANCE_STEPS; ++step) {
    _probe.copy(dir).multiplyScalar(travelled).add(from);

    let nearestGap = Infinity;
    let nearest: Triangle | null = null;
    for (let i = 0; i < candidates.length; ++i) {
      const gap = closestDistanceCapsuleTriangle(_probe, halfSegment, radius, candidates[i]);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = candidates[i];
      }
    }

    if (nearest === null) {
      return null;
    }

    if (nearestGap <= CAPSULE_CAST_EPS) {
      return {
        distance: Math.max(0, travelled - skin),
        normal: nearest.normal.clone(),
        source: nearest.source,
      };
    }

    travelled += nearestGap;
    if (travelled > maxDist) {
      return null;
    }
  }

  // Did not converge within the ceiling. Report no hit rather than a wrong one: a missed contact
  // costs one frame of penetration that the next frame's cast corrects, a fabricated one wedges the
  // mover in place.
  return null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="capsule-cast"`
Expected: PASS, 10 tests.

If `the skin width is held back off the surface` fails outside its tolerance, the cause is the advance loop terminating at `CAPSULE_CAST_EPS` rather than exactly 0. Tighten `CAPSULE_CAST_EPS`; do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/collision/capsule-cast.ts client/src/game/collision/__tests__/capsule-cast.test.ts
git commit -m "feat(collision): swept capsule cast by conservative advancement

The one world primitive the movement and camera stack is built on -- the
reference's cast_move. Conservative advancement is exact, needs no
substep tuning, and is affordable because the candidate list is tens of
triangles gathered from structures the WoW files already ship.

Origin penetration is ignored, matching the reference, so a capsule
already grazing a face still casts outward."
```

---

## Task 5: The terrain candidate provider

Terrain needs no acceleration structure at all: MCVT is a regular grid, so a query box maps straight onto a range of 4.1667 yd cells.

**Files:**
- Create: `client/src/game/collision/terrain-provider.ts`
- Test: `client/src/game/collision/__tests__/terrain-provider.test.ts`

**Interfaces:**
- Consumes: `Triangle` from Task 3
- Produces:
  - `class TerrainProvider` with `add(chunk)`, `remove(chunk)`, `gather(worldBox: THREE.Box3, out: Triangle[]): void`, `clear()`
  - `TERRAIN_CELL_SIZE = 33.33333 / 8`

**Background the implementer needs.** An ADT chunk (`client/src/game/pipeline/adt/chunk/index.ts`) is a `THREE.Mesh` of 145 vertices in the standard 17-per-row MCVT pattern: 9×9 outer vertices interleaved with 8×8 cell centres. In chunk-LOCAL space the constructor lays them out as `localX = -(row · cell)` and `localY = -(col · cell)` — both axes mirrored, which is why the mapping back from a position to a row/col is a negation, not a division alone. Each of the 8×8 cells is four triangles fanning from its centre vertex at index `9 + row·17 + col`, with corners at `index−9` (row, col), `index−8` (row, col+1), `index+9` (row+1, col+1) and `index+8` (row+1, col). `isHole(row, col)` marks cells with no geometry — real gaps you fall through.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/terrain-provider.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { TERRAIN_CELL_SIZE, TerrainProvider } from '../terrain-provider';
import { Triangle } from '../types';

/**
 * A stand-in for an ADT Chunk carrying only what the provider reads: a position attribute in the
 * 17-per-row MCVT layout, a hole mask, and a world matrix. Built flat at `height` so the expected
 * triangles are trivial to reason about.
 */
function fakeChunk(height: number, holes = 0, origin = new THREE.Vector3(0, 0, 0)) {
  const positions = new Float32Array(145 * 3);
  for (let i = 0; i < 145; ++i) {
    let row = Math.floor(i / 17);
    let col = i % 17;
    if (col > 8) { row += 0.5; col -= 8.5; }
    positions[i * 3] = -(row * TERRAIN_CELL_SIZE);
    positions[i * 3 + 1] = -(col * TERRAIN_CELL_SIZE);
    positions[i * 3 + 2] = height;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const chunk: any = new THREE.Mesh(geometry);
  chunk.position.copy(origin);
  chunk.holes = holes;
  chunk.isHole = (row: number, col: number) => {
    const bit = 1 << (Math.floor(row / 2) * 4 + Math.floor(col / 2));
    return (bit & chunk.holes) !== 0;
  };
  chunk.updateMatrix();
  chunk.updateMatrixWorld(true);
  return chunk;
}

/** The world-space XY footprint of a whole chunk is [-33.333, 0] on both axes (mirrored layout). */
function boxAround(x: number, y: number, r: number) {
  return new THREE.Box3(
    new THREE.Vector3(x - r, y - r, -100),
    new THREE.Vector3(x + r, y + r, 100),
  );
}

test('a box over one cell gathers exactly that cell four triangles', () => {
  const provider = new TerrainProvider();
  provider.add(fakeChunk(12));

  const out: Triangle[] = [];
  // Centre of cell (row 0, col 0) sits at local (-0.5, -0.5) cells.
  provider.gather(boxAround(-TERRAIN_CELL_SIZE * 0.5, -TERRAIN_CELL_SIZE * 0.5, 0.2), out);

  expect(out).toHaveLength(4);
  for (const t of out) {
    expect(t.a.z).toBeCloseTo(12, 5);
    expect(t.normal.z).toBeCloseTo(1, 5);
  }
});

test('a box spanning a 2x2 block of cells gathers sixteen triangles', () => {
  const provider = new TerrainProvider();
  provider.add(fakeChunk(0));

  const out: Triangle[] = [];
  provider.gather(boxAround(-TERRAIN_CELL_SIZE, -TERRAIN_CELL_SIZE, TERRAIN_CELL_SIZE * 0.6), out);

  expect(out).toHaveLength(16);
});

test('a hole cell contributes nothing -- it is a real gap you fall through', () => {
  const provider = new TerrainProvider();
  provider.add(fakeChunk(0, 1)); // bit 0 covers rows 0-1, cols 0-1

  const out: Triangle[] = [];
  provider.gather(boxAround(-TERRAIN_CELL_SIZE * 0.5, -TERRAIN_CELL_SIZE * 0.5, 0.2), out);

  expect(out).toHaveLength(0);
});

test('a box outside the chunk footprint gathers nothing', () => {
  const provider = new TerrainProvider();
  provider.add(fakeChunk(0));

  const out: Triangle[] = [];
  provider.gather(boxAround(500, 500, 1), out);

  expect(out).toHaveLength(0);
});

test('the chunk world transform is applied to the emitted triangles', () => {
  const provider = new TerrainProvider();
  provider.add(fakeChunk(0, 0, new THREE.Vector3(1000, 2000, 30)));

  const out: Triangle[] = [];
  provider.gather(
    boxAround(1000 - TERRAIN_CELL_SIZE * 0.5, 2000 - TERRAIN_CELL_SIZE * 0.5, 0.2),
    out,
  );

  expect(out).toHaveLength(4);
  expect(out[0].a.z).toBeCloseTo(30, 5);
  expect(out[0].a.x).toBeLessThan(1000);
  expect(out[0].a.x).toBeGreaterThan(1000 - 33.4);
});

test('a removed chunk stops contributing', () => {
  const provider = new TerrainProvider();
  const chunk = fakeChunk(0);
  provider.add(chunk);
  provider.remove(chunk);

  const out: Triangle[] = [];
  provider.gather(boxAround(-TERRAIN_CELL_SIZE * 0.5, -TERRAIN_CELL_SIZE * 0.5, 0.2), out);

  expect(out).toHaveLength(0);
});

test('every emitted normal points up -- terrain never overhangs', () => {
  const provider = new TerrainProvider();
  const chunk = fakeChunk(0);
  // Tilt one cell centre downward so the fan is genuinely sloped, not degenerate.
  const pos = chunk.geometry.getAttribute('position');
  pos.setZ(9, -3);
  provider.add(chunk);

  const out: Triangle[] = [];
  provider.gather(boxAround(-TERRAIN_CELL_SIZE * 0.5, -TERRAIN_CELL_SIZE * 0.5, 0.2), out);

  expect(out.length).toBeGreaterThan(0);
  for (const t of out) {
    expect(t.normal.z).toBeGreaterThan(0);
    expect(t.normal.length()).toBeCloseTo(1, 5);
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="terrain-provider"`
Expected: FAIL — `Cannot find module '../terrain-provider'`.

- [ ] **Step 3: Write `client/src/game/collision/terrain-provider.ts`**

```ts
import * as THREE from 'three';
import { Triangle } from './types';

/** One MCVT cell is an eighth of a chunk (yards). */
export const TERRAIN_CELL_SIZE = 33.33333 / 8;

/** Outer vertices per MCVT row, counting the interleaved cell centres. */
const ROW_STRIDE = 17;

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * Terrain collision candidates, straight off the MCVT heightmap.
 *
 * There is no acceleration structure here and there does not need to be one: MCVT is a regular
 * grid, so a query box maps arithmetically onto a range of cells. That is the whole reason this
 * client can afford swept-capsule movement without a physics engine -- the expensive part of
 * collision, finding the candidates, is O(1) for the surface the player spends nearly all its time
 * standing on.
 *
 * Chunk-LOCAL layout (see `pipeline/adt/chunk/index.ts`): `localX = -(row * cell)` and
 * `localY = -(col * cell)`, both mirrored -- hence the negations below. Each of the 8x8 cells is
 * four triangles fanning from its centre vertex at `9 + row * 17 + col`.
 */
export class TerrainProvider {
  private chunks = new Set<any>();

  add(chunk: any): void {
    this.chunks.add(chunk);
  }

  remove(chunk: any): void {
    this.chunks.delete(chunk);
  }

  clear(): void {
    this.chunks.clear();
  }

  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    for (const chunk of this.chunks) {
      this.gatherChunk(chunk, worldBox, out);
    }
  }

  private gatherChunk(chunk: any, worldBox: THREE.Box3, out: Triangle[]): void {
    const positions = chunk.geometry?.getAttribute('position');
    if (!positions) {
      return;
    }

    // Query in chunk-local space: one inverse matrix per chunk beats transforming 256 triangles.
    _inverse.copy(chunk.matrixWorld).invert();
    _localBox.copy(worldBox).applyMatrix4(_inverse);

    // Mirrored axes: local -33.33 maps to row/col 8, local 0 maps to row/col 0. So the low local
    // bound gives the HIGH index and vice versa.
    const rowLo = Math.floor(-_localBox.max.x / TERRAIN_CELL_SIZE);
    const rowHi = Math.floor(-_localBox.min.x / TERRAIN_CELL_SIZE);
    const colLo = Math.floor(-_localBox.max.y / TERRAIN_CELL_SIZE);
    const colHi = Math.floor(-_localBox.min.y / TERRAIN_CELL_SIZE);

    for (let row = Math.max(0, rowLo); row <= Math.min(7, rowHi); ++row) {
      for (let col = Math.max(0, colLo); col <= Math.min(7, colHi); ++col) {
        if (chunk.isHole && chunk.isHole(row, col)) {
          continue;
        }

        const centre = 9 + row * ROW_STRIDE + col;
        // The four corners, in the winding the renderer uses.
        const tl = centre - 9;
        const tr = centre - 8;
        const br = centre + 9;
        const bl = centre + 8;

        this.emit(chunk, positions, centre, tl, tr, out);
        this.emit(chunk, positions, centre, tr, br, out);
        this.emit(chunk, positions, centre, br, bl, out);
        this.emit(chunk, positions, centre, bl, tl, out);
      }
    }
  }

  private emit(
    chunk: any, positions: THREE.BufferAttribute, i0: number, i1: number, i2: number,
    out: Triangle[],
  ): void {
    _a.fromBufferAttribute(positions, i0).applyMatrix4(chunk.matrixWorld);
    _b.fromBufferAttribute(positions, i1).applyMatrix4(chunk.matrixWorld);
    _c.fromBufferAttribute(positions, i2).applyMatrix4(chunk.matrixWorld);

    _e1.subVectors(_b, _a);
    _e2.subVectors(_c, _a);
    const normal = new THREE.Vector3().crossVectors(_e1, _e2);
    const len = normal.length();
    if (len < 1e-9) {
      return; // degenerate face (a fully flat hole edge) -- nothing to collide with
    }
    normal.divideScalar(len);

    // Terrain never overhangs, so a downward normal is a winding artifact of the mirrored layout,
    // not real geometry. Force it up: every movement rule keys off `normal.z`, and a flipped
    // normal would read a walkable floor as a ceiling.
    if (normal.z < 0) {
      normal.negate();
    }

    out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: chunk });
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="terrain-provider"`
Expected: PASS, 7 tests.

If the cell-range arithmetic is off by one, the `2x2 block` test will report 4 or 36 instead of 16. Fix the range mapping, not the expectation — the mirrored axes are the trap, and getting them wrong here would silently misplace all terrain collision.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/collision/terrain-provider.ts client/src/game/collision/__tests__/terrain-provider.test.ts
git commit -m "feat(collision): terrain candidates straight off the MCVT grid

MCVT is a regular grid, so a query box maps arithmetically onto a range
of 4.1667 yd cells -- no acceleration structure, no build cost. This is
why swept-capsule movement is affordable without a physics engine: the
surface the player stands on nearly all the time is an O(1) lookup."
```

---

## Task 6: The WMO candidate provider

WMO collision is the MOBN/MOBR BSP tree — the client's own collision structure, already parsed and already built per group. This task queries it; it does not build anything.

**Files:**
- Create: `client/src/game/collision/wmo-provider.ts`
- Modify: `client/src/game/pipeline/wmo/group/index.js` (keep the flags reachable)
- Test: `client/src/game/collision/__tests__/wmo-provider.test.ts`

**Interfaces:**
- Consumes: `Triangle`, `CollisionLayer` (Task 3), `wmoFaceIsCollidable` (Task 3), `attributes.triangleFlags` (Task 1)
- Produces:
  - `interface WmoCollider { view: THREE.Object3D; bspTree: any; triangleFlags: Uint8Array }`
  - `class WmoProvider` with `add(collider: WmoCollider)`, `remove(view)`, `gather(worldBox, layer, out)`, `clear()`

**Background the implementer needs.** `client/src/game/utils/bsp-tree.ts` exposes:
- `nodes: BSPTreeNode[]` — each `{ flags, negChild, posChild, nFaces, faceStart, planeDist }`. `flags & 0x4` marks a leaf; `flags` 0/1/2 are X/Y/Z split planes.
- `indices.plane: number[]` — MOBR. A leaf owns `nFaces` entries starting at `faceStart`; each entry is a **triangle index**.
- `indices.face: number[]` — MOVI. Triangle `t` has vertices `indices.face[3t]`, `[3t+1]`, `[3t+2]`.
- `vertices: number[]` — MOVT, flattened xyz.
- `query(box, startingNodeIndex): number[]` — returns leaf node indices for a box **in model-local space**.

The triangle index from `indices.plane` is also the index into `triangleFlags` from Task 1. That correspondence is what makes the two collision audiences possible.

- [ ] **Step 1: Keep the flags reachable on the group**

In `client/src/game/pipeline/wmo/group/index.js`, in `createBSPTree`, also stash the flags:

```js
  createBSPTree(nodes, planeIndices, attributes) {
    const { indices, positions } = attributes;

    this.bspTree = new BSPTree(nodes, planeIndices, indices, positions);

    // MOPY flags, one byte per triangle, indexed by the SAME triangle index the BSP's MOBR entries
    // carry. The collision layer needs them to build the walk face set (minus DETAIL) and the
    // camera face set (minus NOCAMCOLLIDE) out of one shared BSP.
    this.triangleFlags = attributes.triangleFlags;
  }
```

- [ ] **Step 2: Write the failing test**

Create `client/src/game/collision/__tests__/wmo-provider.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CollisionLayer, MOPY_DETAIL, MOPY_NOCAMCOLLIDE } from '../layers';
import { Triangle } from '../types';
import { WmoProvider } from '../wmo-provider';

/**
 * A stand-in BSP with a single leaf owning every triangle, exercising the provider's face walk and
 * layer filter without depending on real MOBN node geometry. `query` returns the one leaf whenever
 * the box overlaps the unit cube the fake geometry lives in.
 */
function fakeBsp(triangleCount: number) {
  const vertices: number[] = [];
  const face: number[] = [];
  const plane: number[] = [];

  for (let t = 0; t < triangleCount; ++t) {
    const base = t * 3;
    // A flat triangle at z = t, inside x,y in [0,1].
    vertices.push(0, 0, t, 1, 0, t, 0, 1, t);
    face.push(base, base + 1, base + 2);
    plane.push(t);
  }

  return {
    nodes: [{ flags: 0x4, negChild: -1, posChild: -1, nFaces: triangleCount, faceStart: 0, planeDist: 0 }],
    indices: { plane, face },
    vertices,
    query(box: THREE.Box3) {
      return box.max.x >= 0 && box.min.x <= 1 && box.max.y >= 0 && box.min.y <= 1 ? [0] : [];
    },
  };
}

function collider(flags: number[], position = new THREE.Vector3(0, 0, 0)) {
  const view = new THREE.Object3D();
  view.position.copy(position);
  view.updateMatrix();
  view.updateMatrixWorld(true);
  return { view, bspTree: fakeBsp(flags.length), triangleFlags: Uint8Array.from(flags) };
}

const bigBox = () => new THREE.Box3(
  new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10),
);

test('every plain face is gathered for both audiences', () => {
  const provider = new WmoProvider();
  provider.add(collider([0, 0, 0]));

  const walk: Triangle[] = [];
  const camera: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, walk);
  provider.gather(bigBox(), CollisionLayer.Camera, camera);

  expect(walk).toHaveLength(3);
  expect(camera).toHaveLength(3);
});

test('DETAIL faces are dropped from the walk set only', () => {
  const provider = new WmoProvider();
  provider.add(collider([0, MOPY_DETAIL, 0]));

  const walk: Triangle[] = [];
  const camera: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, walk);
  provider.gather(bigBox(), CollisionLayer.Camera, camera);

  expect(walk).toHaveLength(2);
  expect(camera).toHaveLength(3);
});

test('NOCAMCOLLIDE faces are dropped from the camera set only', () => {
  const provider = new WmoProvider();
  provider.add(collider([MOPY_NOCAMCOLLIDE, 0, 0]));

  const walk: Triangle[] = [];
  const camera: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, walk);
  provider.gather(bigBox(), CollisionLayer.Camera, camera);

  expect(walk).toHaveLength(3);
  expect(camera).toHaveLength(2);
});

test('the placement transform is applied, and the query runs in model-local space', () => {
  const provider = new WmoProvider();
  provider.add(collider([0], new THREE.Vector3(100, 200, 300)));

  const out: Triangle[] = [];
  // A world box around the placed geometry. If the provider queried the BSP in WORLD space, the
  // fake `query` would see x ~ 100 and return no leaves.
  provider.gather(
    new THREE.Box3(new THREE.Vector3(99, 199, 299), new THREE.Vector3(102, 202, 302)),
    CollisionLayer.Walk,
    out,
  );

  expect(out).toHaveLength(1);
  expect(out[0].a.x).toBeCloseTo(100, 5);
  expect(out[0].a.z).toBeCloseTo(300, 5);
});

test('a box that misses the geometry gathers nothing', () => {
  const provider = new WmoProvider();
  provider.add(collider([0, 0]));

  const out: Triangle[] = [];
  provider.gather(
    new THREE.Box3(new THREE.Vector3(500, 500, 500), new THREE.Vector3(501, 501, 501)),
    CollisionLayer.Walk,
    out,
  );

  expect(out).toHaveLength(0);
});

test('a removed placement stops contributing', () => {
  const provider = new WmoProvider();
  const c = collider([0, 0]);
  provider.add(c);
  provider.remove(c.view);

  const out: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, out);

  expect(out).toHaveLength(0);
});

test('a face is emitted once even when several leaves reference it', () => {
  // MOBR lets two leaves own the same triangle where it straddles a split plane. Collision must
  // not see it twice: a doubled face is a doubled contact in the slide.
  const provider = new WmoProvider();
  const c = collider([0, 0]);
  c.bspTree.nodes = [
    { flags: 0x4, negChild: -1, posChild: -1, nFaces: 2, faceStart: 0, planeDist: 0 },
    { flags: 0x4, negChild: -1, posChild: -1, nFaces: 2, faceStart: 0, planeDist: 0 },
  ];
  c.bspTree.query = () => [0, 1];
  provider.add(c);

  const out: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, out);

  expect(out).toHaveLength(2);
});

test('a group with no flags array is treated as all-collidable rather than skipped', () => {
  // Defensive: a WMO loaded before the Task 1 plumbing (or from a cache) must still collide, or
  // buildings silently become walk-through.
  const provider = new WmoProvider();
  const c: any = collider([0, 0]);
  c.triangleFlags = undefined;
  provider.add(c);

  const out: Triangle[] = [];
  provider.gather(bigBox(), CollisionLayer.Walk, out);

  expect(out).toHaveLength(2);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="wmo-provider"`
Expected: FAIL — `Cannot find module '../wmo-provider'`.

- [ ] **Step 4: Write `client/src/game/collision/wmo-provider.ts`**

```ts
import * as THREE from 'three';
import { wmoFaceIsCollidable } from './layers';
import { CollisionLayer, Triangle } from './types';

/** One placed WMO group's collision data. */
export interface WmoCollider {
  /** The placed group view -- its `matrixWorld` is the placement transform. */
  view: THREE.Object3D;
  /** The group's MOBN/MOBR tree (`client/src/game/utils/bsp-tree.ts`). */
  bspTree: any;
  /** MOPY flags, one byte per triangle, sharing the BSP's triangle indexing. */
  triangleFlags?: Uint8Array;
}

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * WMO collision candidates from the MOBN/MOBR BSP tree.
 *
 * This is the structure the reference client itself collides buildings with, shipped in the file
 * and already built per group by `WMOGroup#createBSPTree` -- so there is nothing to construct here
 * and nothing to keep in sync as placements stream. The query runs in MODEL-LOCAL space (one
 * inverse matrix per placement) rather than transforming geometry to world, which is both cheaper
 * and what the reference does.
 *
 * The walk and camera audiences share one tree and differ only in the MOPY filter, because the
 * triangle index MOBR carries is also the index into the group's `triangleFlags`.
 */
export class WmoProvider {
  private colliders = new Map<THREE.Object3D, WmoCollider>();
  /** Reused across calls; a face straddling a split plane is owned by more than one leaf. */
  private seen = new Set<number>();

  add(collider: WmoCollider): void {
    this.colliders.set(collider.view, collider);
  }

  remove(view: THREE.Object3D): void {
    this.colliders.delete(view);
  }

  clear(): void {
    this.colliders.clear();
  }

  gather(worldBox: THREE.Box3, layer: CollisionLayer, out: Triangle[]): void {
    for (const collider of this.colliders.values()) {
      this.gatherOne(collider, worldBox, layer, out);
    }
  }

  private gatherOne(
    collider: WmoCollider, worldBox: THREE.Box3, layer: CollisionLayer, out: Triangle[],
  ): void {
    const { view, bspTree, triangleFlags } = collider;
    if (!bspTree || !bspTree.nodes || bspTree.nodes.length === 0) {
      return;
    }

    _inverse.copy(view.matrixWorld).invert();
    _localBox.copy(worldBox).applyMatrix4(_inverse);

    const leaves: number[] = bspTree.query(_localBox, 0);
    if (!leaves || leaves.length === 0) {
      return;
    }

    const { plane, face } = bspTree.indices;
    const verts = bspTree.vertices;

    this.seen.clear();
    for (let l = 0; l < leaves.length; ++l) {
      const node = bspTree.nodes[leaves[l]];
      if (!node) {
        continue;
      }

      const begin = node.faceStart;
      const end = node.faceStart + node.nFaces;
      for (let p = begin; p < end; ++p) {
        const triangle = plane[p];
        if (this.seen.has(triangle)) {
          continue;
        }
        this.seen.add(triangle);

        // No flags array means the group predates the MOPY plumbing: collide with everything
        // rather than turning the building into a walk-through.
        if (triangleFlags && !wmoFaceIsCollidable(triangleFlags[triangle], layer)) {
          continue;
        }

        const i0 = face[3 * triangle];
        const i1 = face[3 * triangle + 1];
        const i2 = face[3 * triangle + 2];

        _a.set(verts[3 * i0], verts[3 * i0 + 1], verts[3 * i0 + 2]).applyMatrix4(view.matrixWorld);
        _b.set(verts[3 * i1], verts[3 * i1 + 1], verts[3 * i1 + 2]).applyMatrix4(view.matrixWorld);
        _c.set(verts[3 * i2], verts[3 * i2 + 1], verts[3 * i2 + 2]).applyMatrix4(view.matrixWorld);

        _e1.subVectors(_b, _a);
        _e2.subVectors(_c, _a);
        const normal = new THREE.Vector3().crossVectors(_e1, _e2);
        const len = normal.length();
        if (len < 1e-9) {
          continue;
        }
        normal.divideScalar(len);

        // Unlike terrain, a WMO normal is NOT forced up: a building genuinely has ceilings and
        // overhangs, and the steep-wall rule reads `normal.z < 0` to leave them alone.
        out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: view });
      }
    }
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="wmo-provider"`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/collision/wmo-provider.ts client/src/game/collision/__tests__/wmo-provider.test.ts client/src/game/pipeline/wmo/group/index.js
git commit -m "feat(collision): WMO candidates from the MOBN/MOBR BSP

The structure the reference client collides buildings with, shipped in
the file and already built per group -- nothing to construct, nothing to
keep in sync as placements stream. The query runs in model-local space,
and the walk/camera audiences share one tree because MOBR's triangle
index is also the index into the group's MOPY flags."
```

---

## Task 7: The doodad candidate provider

M2 doodads collide with their own low-poly hull — `boundingVertices` / `boundingTriangles` / `boundingNormals`, which the pipeline already builds into a `BoundingMesh`.

**Files:**
- Create: `client/src/game/collision/doodad-provider.ts`
- Test: `client/src/game/collision/__tests__/doodad-provider.test.ts`

**Interfaces:**
- Consumes: `Triangle` from Task 3
- Produces: `class DoodadProvider` with `add(mesh: THREE.Mesh)`, `remove(mesh)`, `gather(worldBox, out)`, `clear()`

**Background.** `client/src/game/pipeline/m2/index.ts` (`createBoundingMesh`, ~line 174) builds a `THREE.Mesh` named `BoundingMesh` from the M2's bounding hull, indexed, and adds it as a child of the M2. Hulls are tens to a few hundred triangles, so a per-triangle AABB test after a whole-mesh bounds rejection is enough — no tree.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/doodad-provider.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { DoodadProvider } from '../doodad-provider';
import { Triangle } from '../types';

/** A unit box hull, 12 triangles, optionally placed. */
function hull(position = new THREE.Vector3(0, 0, 0), scale = 1) {
  const geometry = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const mesh = new THREE.Mesh(geometry);
  mesh.name = 'BoundingMesh';
  mesh.position.copy(position);
  mesh.scale.setScalar(scale);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);
  return mesh;
}

const boxAt = (x: number, y: number, z: number, r: number) => new THREE.Box3(
  new THREE.Vector3(x - r, y - r, z - r), new THREE.Vector3(x + r, y + r, z + r),
);

test('a box overlapping the hull gathers its triangles', () => {
  const provider = new DoodadProvider();
  provider.add(hull());

  const out: Triangle[] = [];
  provider.gather(boxAt(0, 0, 0, 2), out);

  expect(out).toHaveLength(12);
  for (const t of out) {
    expect(t.normal.length()).toBeCloseTo(1, 5);
  }
});

test('a box far from the hull gathers nothing', () => {
  const provider = new DoodadProvider();
  provider.add(hull());

  const out: Triangle[] = [];
  provider.gather(boxAt(100, 100, 100, 1), out);

  expect(out).toHaveLength(0);
});

test('only the triangles the box actually overlaps are gathered', () => {
  const provider = new DoodadProvider();
  provider.add(hull());

  const out: Triangle[] = [];
  // A thin slab around the +Z face only.
  provider.gather(new THREE.Box3(
    new THREE.Vector3(-1, -1, 0.45), new THREE.Vector3(1, 1, 0.55),
  ), out);

  expect(out.length).toBeGreaterThan(0);
  expect(out.length).toBeLessThan(12);
});

test('the placement transform and scale are applied', () => {
  const provider = new DoodadProvider();
  provider.add(hull(new THREE.Vector3(50, 60, 70), 4));

  const out: Triangle[] = [];
  provider.gather(boxAt(50, 60, 70, 5), out);

  expect(out).toHaveLength(12);
  const xs = out.flatMap((t) => [t.a.x, t.b.x, t.c.x]);
  expect(Math.max(...xs)).toBeCloseTo(52, 4);
  expect(Math.min(...xs)).toBeCloseTo(48, 4);
});

test('a removed hull stops contributing', () => {
  const provider = new DoodadProvider();
  const mesh = hull();
  provider.add(mesh);
  provider.remove(mesh);

  const out: Triangle[] = [];
  provider.gather(boxAt(0, 0, 0, 2), out);

  expect(out).toHaveLength(0);
});

test('an indexed hull geometry is handled as well as a non-indexed one', () => {
  const provider = new DoodadProvider();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.updateMatrixWorld(true);
  provider.add(mesh);

  const out: Triangle[] = [];
  provider.gather(boxAt(0, 0, 0, 2), out);

  expect(out).toHaveLength(12);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="doodad-provider"`
Expected: FAIL — `Cannot find module '../doodad-provider'`.

- [ ] **Step 3: Write `client/src/game/collision/doodad-provider.ts`**

```ts
import * as THREE from 'three';
import { Triangle } from './types';

const _localBox = new THREE.Box3();
const _inverse = new THREE.Matrix4();
const _meshBounds = new THREE.Box3();
const _triBox = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/**
 * Doodad collision candidates from each M2's own low-poly hull -- `boundingVertices` /
 * `boundingTriangles`, which `pipeline/m2/index.ts` already meshes as `BoundingMesh`.
 *
 * This is the model's authored collision volume, not its render geometry: a tree that draws tens of
 * thousands of triangles collides as a handful. So no acceleration structure is needed here either
 * -- a whole-mesh bounds rejection followed by a per-triangle AABB test is cheaper than building
 * and maintaining a tree per placement, and there are a lot of placements.
 */
export class DoodadProvider {
  private hulls = new Set<THREE.Mesh>();

  add(mesh: THREE.Mesh): void {
    this.hulls.add(mesh);
  }

  remove(mesh: THREE.Mesh): void {
    this.hulls.delete(mesh);
  }

  clear(): void {
    this.hulls.clear();
  }

  gather(worldBox: THREE.Box3, out: Triangle[]): void {
    for (const mesh of this.hulls) {
      this.gatherOne(mesh, worldBox, out);
    }
  }

  private gatherOne(mesh: THREE.Mesh, worldBox: THREE.Box3, out: Triangle[]): void {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positions = geometry?.getAttribute('position') as THREE.BufferAttribute;
    if (!positions) {
      return;
    }

    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    _meshBounds.copy(geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (!_meshBounds.intersectsBox(worldBox)) {
      return;
    }

    // Per-triangle rejection happens in LOCAL space -- one inverse matrix beats transforming every
    // vertex of a hull we are mostly going to reject.
    _inverse.copy(mesh.matrixWorld).invert();
    _localBox.copy(worldBox).applyMatrix4(_inverse);

    const index = geometry.getIndex();
    const count = index ? index.count : positions.count;

    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;

      _a.fromBufferAttribute(positions, i0);
      _b.fromBufferAttribute(positions, i1);
      _c.fromBufferAttribute(positions, i2);

      _triBox.makeEmpty().expandByPoint(_a).expandByPoint(_b).expandByPoint(_c);
      if (!_triBox.intersectsBox(_localBox)) {
        continue;
      }

      _a.applyMatrix4(mesh.matrixWorld);
      _b.applyMatrix4(mesh.matrixWorld);
      _c.applyMatrix4(mesh.matrixWorld);

      _e1.subVectors(_b, _a);
      _e2.subVectors(_c, _a);
      const normal = new THREE.Vector3().crossVectors(_e1, _e2);
      const len = normal.length();
      if (len < 1e-9) {
        continue;
      }
      normal.divideScalar(len);

      out.push({ a: _a.clone(), b: _b.clone(), c: _c.clone(), normal, source: mesh });
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="doodad-provider"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/collision/doodad-provider.ts client/src/game/collision/__tests__/doodad-provider.test.ts
git commit -m "feat(collision): doodad candidates from the M2 bounding hull

The model's own authored collision volume, already meshed by the M2
pipeline: a tree that draws tens of thousands of triangles collides as
a handful. Bounds rejection plus a per-triangle AABB test beats building
a tree per placement, and there are a lot of placements."
```

---

## Task 8: The liquid surface query

Liquid is not a collider — you do not collide with water, you ask how deep you are in it. So this is a separate, simpler interface than the triangle providers.

**Files:**
- Create: `client/src/game/collision/liquid-query.ts`
- Test: `client/src/game/collision/__tests__/liquid-query.test.ts`

**Interfaces:**
- Consumes: `LiquidClaim` from Task 3
- Produces:
  - `interface LiquidSurface { mesh: THREE.Mesh; perRow: number; rows: number; cols: number; owner: object | null; isFilled(row: number, col: number): boolean }`
  - `class LiquidRegistry` with `add(surface)`, `remove(mesh)`, `clear()`, `surfaceAt(x, y, claim): { surfaceZ: number; owner: object | null } | null`
  - `adtLiquidSurface(layer: any): LiquidSurface`
  - `wmoLiquidSurface(layer: any, owner: object): LiquidSurface`

**Background the implementer needs.** The two liquid meshes have *different* local layouts:
- ADT (`pipeline/liquid/layer.js`): mirrored like terrain — `localX = -(row · cell)`, `localY = -(col · cell)`; `perRow = data.width + 1`; grid is `data.height` × `data.width` tiles; `isFilled(row, col)` reads a bitmask.
- WMO (`pipeline/liquid/wmo-layer.js`): **not** mirrored — `localX = col · TILE_SIZE`, `localY = row · TILE_SIZE`; `perRow = data.liquidVerts.x`; tiles are `data.tiles`.

Rather than hard-code either layout, derive the axis mapping from the geometry's own `position` attribute: vertex 0, vertex 1 (one column step) and vertex `perRow` (one row step) give the column and row basis vectors, sign included. One derivation, both formats, and it cannot drift if either constructor changes.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/liquid-query.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { LiquidRegistry, LiquidSurface } from '../liquid-query';

const CELL = 33.33333 / 8;

/**
 * Builds a liquid grid mesh directly, in either the mirrored (ADT) or unmirrored (WMO) layout, so
 * the test pins that the query derives the axis mapping from the geometry rather than assuming one.
 * `heightAt(row, col)` supplies the surface height.
 */
function surface(
  rows: number, cols: number, mirrored: boolean,
  heightAt: (row: number, col: number) => number,
  opts: { owner?: object; filled?: (row: number, col: number) => boolean; origin?: THREE.Vector3 } = {},
): LiquidSurface {
  const perRow = cols + 1;
  const count = perRow * (rows + 1);
  const positions = new Float32Array(count * 3);

  for (let row = 0; row <= rows; ++row) {
    for (let col = 0; col <= cols; ++col) {
      const i = row * perRow + col;
      positions[i * 3] = mirrored ? -(row * CELL) : col * CELL;
      positions[i * 3 + 1] = mirrored ? -(col * CELL) : row * CELL;
      positions[i * 3 + 2] = heightAt(row, col);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry);
  if (opts.origin) mesh.position.copy(opts.origin);
  mesh.updateMatrix();
  mesh.updateMatrixWorld(true);

  return {
    mesh, perRow, rows, cols,
    owner: opts.owner ?? null,
    isFilled: opts.filled ?? (() => true),
  };
}

test('a flat ADT sheet answers its own height anywhere inside it', () => {
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 25));

  const hit = registry.surfaceAt(-CELL * 1.5, -CELL * 2.5, { wmoGroup: null });

  expect(hit).not.toBeNull();
  expect(hit!.surfaceZ).toBeCloseTo(25, 5);
});

test('a flat WMO sheet answers despite the opposite axis layout', () => {
  const room = {};
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, false, () => 12, { owner: room }));

  const hit = registry.surfaceAt(CELL * 1.5, CELL * 2.5, { wmoGroup: room });

  expect(hit).not.toBeNull();
  expect(hit!.surfaceZ).toBeCloseTo(12, 5);
  expect(hit!.owner).toBe(room);
});

test('a sloped sheet interpolates between its vertices', () => {
  const registry = new LiquidRegistry();
  // Height rises 1 per column step.
  registry.add(surface(4, 4, true, (_row, col) => col));

  const midway = registry.surfaceAt(-CELL * 0.5, -CELL * 1.5, { wmoGroup: null });

  expect(midway).not.toBeNull();
  expect(midway!.surfaceZ).toBeCloseTo(1.5, 3);
});

test('a point outside the grid gets no answer', () => {
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 5));

  expect(registry.surfaceAt(500, 500, { wmoGroup: null })).toBeNull();
  expect(registry.surfaceAt(CELL * 2, CELL * 2, { wmoGroup: null })).toBeNull();
});

test('an unfilled tile is a hole in the sheet', () => {
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 5, { filled: (row, col) => !(row === 1 && col === 1) }));

  expect(registry.surfaceAt(-CELL * 1.5, -CELL * 1.5, { wmoGroup: null })).toBeNull();
  expect(registry.surfaceAt(-CELL * 2.5, -CELL * 2.5, { wmoGroup: null })).not.toBeNull();
});

test('indoors, only the claimed room liquid answers', () => {
  // The "swim in air" defect class: a building's floor liquid must not answer for someone standing
  // outside it, and the ADT's must not answer for someone inside (reference decisions 0634/0696).
  const room = {};
  const otherRoom = {};
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, false, () => 40, { owner: room }));

  expect(registry.surfaceAt(CELL, CELL, { wmoGroup: room })!.surfaceZ).toBeCloseTo(40, 5);
  expect(registry.surfaceAt(CELL, CELL, { wmoGroup: otherRoom })).toBeNull();
  expect(registry.surfaceAt(CELL, CELL, { wmoGroup: null })).toBeNull();
});

test('outdoors, only unowned ADT liquid answers', () => {
  const room = {};
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 8));                       // ADT, unowned
  registry.add(surface(4, 4, true, () => 99, { owner: room }));     // a room sheet at the same XY

  const outdoors = registry.surfaceAt(-CELL * 1.5, -CELL * 1.5, { wmoGroup: null });

  expect(outdoors!.surfaceZ).toBeCloseTo(8, 5);
});

test('the highest of several overlapping eligible sheets wins', () => {
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 8));
  registry.add(surface(4, 4, true, () => 14));

  expect(registry.surfaceAt(-CELL, -CELL, { wmoGroup: null })!.surfaceZ).toBeCloseTo(14, 5);
});

test('the mesh world transform is applied to the answer', () => {
  const registry = new LiquidRegistry();
  registry.add(surface(4, 4, true, () => 0, { origin: new THREE.Vector3(500, 600, 70) }));

  const hit = registry.surfaceAt(500 - CELL * 1.5, 600 - CELL * 1.5, { wmoGroup: null });

  expect(hit).not.toBeNull();
  expect(hit!.surfaceZ).toBeCloseTo(70, 5);
});

test('a removed sheet stops answering', () => {
  const registry = new LiquidRegistry();
  const s = surface(4, 4, true, () => 5);
  registry.add(s);
  registry.remove(s.mesh);

  expect(registry.surfaceAt(-CELL, -CELL, { wmoGroup: null })).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="liquid-query"`
Expected: FAIL — `Cannot find module '../liquid-query'`.

- [ ] **Step 3: Write `client/src/game/collision/liquid-query.ts`**

```ts
import * as THREE from 'three';
import { LiquidClaim } from './types';

/**
 * One liquid sheet -- an ADT MH2O layer or a WMO MLIQ layer -- described uniformly enough to query.
 *
 * `owner` is the WMO group whose MLIQ this is, or `null` for outdoor ADT liquid. It is the scope
 * key: indoors only the claimed room's sheet answers, outdoors only unowned sheets do.
 */
export interface LiquidSurface {
  mesh: THREE.Mesh;
  /** Vertices per grid row (columns + 1). */
  perRow: number;
  /** Tile rows and columns. */
  rows: number;
  cols: number;
  owner: object | null;
  isFilled(row: number, col: number): boolean;
}

const _inverse = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _colStep = new THREE.Vector3();
const _rowStep = new THREE.Vector3();
const _world = new THREE.Vector3();

/**
 * The liquid surface query -- how deep the water over a point is, which is all swimming needs. This
 * is deliberately NOT a collider: you do not collide with water, you compare its surface against
 * your feet.
 *
 * The lookup is the same O(1) grid walk terrain uses, and for the same reason: MH2O and MLIQ are
 * both regular grids. It answers for ALL liquids, not just water -- you swim in lava and slime too;
 * Blackrock's magma and Undercity's sludge are surfaces you enter, not ones you fall through
 * (reference decision 0634).
 *
 * The axis mapping is derived from each mesh's own geometry rather than hard-coded, because the two
 * layouts disagree: the ADT grid is mirrored on both axes and the WMO grid is not.
 */
export class LiquidRegistry {
  private surfaces = new Map<THREE.Mesh, LiquidSurface>();

  add(surface: LiquidSurface): void {
    this.surfaces.set(surface.mesh, surface);
  }

  remove(mesh: THREE.Mesh): void {
    this.surfaces.delete(mesh);
  }

  clear(): void {
    this.surfaces.clear();
  }

  /**
   * The liquid surface height (world Z) over `(x, y)`, or `null` when no eligible sheet covers it.
   * Where several eligible sheets overlap, the highest wins -- a swimmer belongs to the surface
   * above them.
   */
  surfaceAt(x: number, y: number, claim: LiquidClaim): { surfaceZ: number; owner: object | null } | null {
    let best: { surfaceZ: number; owner: object | null } | null = null;

    for (const surface of this.surfaces.values()) {
      // The scope key. Indoors, only THIS room's sheet answers; outdoors, only unowned ADT sheets.
      // Without it a building's floor liquid answers for someone standing outside it, and the
      // ADT's for someone inside -- the reference's "swim in air" family (decisions 0634/0696).
      if (surface.owner !== claim.wmoGroup) {
        continue;
      }

      const z = this.heightOn(surface, x, y);
      if (z !== null && (best === null || z > best.surfaceZ)) {
        best = { surfaceZ: z, owner: surface.owner };
      }
    }

    return best;
  }

  private heightOn(surface: LiquidSurface, x: number, y: number): number | null {
    const { mesh, perRow, rows, cols } = surface;
    const positions = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute;
    if (!positions || positions.count < perRow + 2) {
      return null;
    }

    _inverse.copy(mesh.matrixWorld).invert();
    _local.set(x, y, 0).applyMatrix4(_inverse);

    // Derive the grid basis from the mesh's own vertices: index 0 is the origin, index 1 is one
    // column along, index `perRow` is one row along. This handles the ADT's mirrored layout and the
    // WMO's unmirrored one with the same code, and cannot drift if either constructor changes.
    _origin.fromBufferAttribute(positions, 0);
    _colStep.fromBufferAttribute(positions, 1).sub(_origin);
    _rowStep.fromBufferAttribute(positions, perRow).sub(_origin);

    const colLen2 = _colStep.x * _colStep.x + _colStep.y * _colStep.y;
    const rowLen2 = _rowStep.x * _rowStep.x + _rowStep.y * _rowStep.y;
    if (colLen2 < 1e-9 || rowLen2 < 1e-9) {
      return null;
    }

    const dx = _local.x - _origin.x;
    const dy = _local.y - _origin.y;
    const colF = (dx * _colStep.x + dy * _colStep.y) / colLen2;
    const rowF = (dx * _rowStep.x + dy * _rowStep.y) / rowLen2;

    if (colF < 0 || rowF < 0 || colF > cols || rowF > rows) {
      return null;
    }

    const col = Math.min(cols - 1, Math.floor(colF));
    const row = Math.min(rows - 1, Math.floor(rowF));
    if (!surface.isFilled(row, col)) {
      return null;
    }

    // Bilinear over the tile's four corner heights.
    const fc = colF - col;
    const fr = rowF - row;
    const h00 = positions.getZ(row * perRow + col);
    const h01 = positions.getZ(row * perRow + col + 1);
    const h10 = positions.getZ((row + 1) * perRow + col);
    const h11 = positions.getZ((row + 1) * perRow + col + 1);
    const localZ = (h00 * (1 - fc) + h01 * fc) * (1 - fr) + (h10 * (1 - fc) + h11 * fc) * fr;

    _world.set(_local.x, _local.y, localZ).applyMatrix4(mesh.matrixWorld);
    return _world.z;
  }
}

/** Adapt an ADT MH2O layer (`pipeline/liquid/layer.js`) to a queryable surface. */
export function adtLiquidSurface(layer: any): LiquidSurface {
  return {
    mesh: layer,
    perRow: layer.data.width + 1,
    rows: layer.data.height,
    cols: layer.data.width,
    owner: null,
    isFilled: (row: number, col: number) => Boolean(layer.isFilled(row, col)),
  };
}

/** Adapt a WMO MLIQ layer (`pipeline/liquid/wmo-layer.js`) to a queryable surface. */
export function wmoLiquidSurface(layer: any, owner: object): LiquidSurface {
  const { liquidVerts, liquidTiles } = layer.data;
  return {
    mesh: layer,
    perRow: liquidVerts.x,
    rows: liquidTiles.y,
    cols: liquidTiles.x,
    owner,
    isFilled: (row: number, col: number) => {
      const tile = layer.data.tiles?.[row * liquidTiles.x + col];
      // MLIQ's SMOLTile: the low nibble is the legacy liquid type; 0x0F means "no liquid here".
      return tile ? (tile.flags & 0x0f) !== 0x0f : true;
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="liquid-query"`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the adapter field names against the real layers**

Read `client/src/game/pipeline/liquid/layer.js` and `wmo-layer.js` and confirm that `data.width`, `data.height`, `isFilled`, `data.liquidVerts`, `data.liquidTiles` and `data.tiles` are spelled exactly as the adapters use them. The adapters are the only untested surface in this task (they take real objects the unit tests do not build), so this read is the check on them.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/collision/liquid-query.ts client/src/game/collision/__tests__/liquid-query.test.ts
git commit -m "feat(collision): liquid surface query over MH2O and MLIQ

Liquid is not a collider -- you do not collide with water, you compare
its surface against your feet. Same O(1) grid walk as terrain, over data
both formats already provide, and it answers for lava and slime too.

The scope key is the room claim: indoors only that placement's own MLIQ
answers, outdoors only the ADT's. Without it a building's floor liquid
answers for someone standing outside it."
```

---

## Task 9: The collision world, and retiring `ColliderManager`

This is the seam between the collision layer and everything above it. After this task the movers can be written against a real world.

**Files:**
- Create: `client/src/game/collision/collision-world.ts`
- Modify: `client/src/game/world/terrain-manager.js`
- Modify: `client/src/game/pipeline/wmo/group/view.js`, `client/src/game/pipeline/wmo/group/loader/index.js`
- Modify: `client/src/game/pipeline/m2/index.ts`
- Delete: `client/src/game/world/collider-manager.js`
- Test: `client/src/game/collision/__tests__/collision-world.test.ts`

**Interfaces:**
- Consumes: every provider from Tasks 5–8
- Produces (the API the movers and camera use):
  - `type CastFn = (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skin?: number) => CastHit | null`
  - `class CollisionWorld`:
    - `terrain: TerrainProvider`, `wmo: WmoProvider`, `doodads: DoodadProvider`, `liquid: LiquidRegistry`
    - `castFor(layer: CollisionLayer, radius: number, halfSegment: number): CastFn`
    - `surfaceAt(x, y, claim): { surfaceZ: number; owner: object | null } | null`
    - `clear(): void`
  - `const collisionWorld: CollisionWorld` — the module singleton the streaming hooks register with. **Only integration code touches the singleton**; every mover function receives a `CastFn` as a parameter.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/collision/__tests__/collision-world.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CollisionWorld } from '../collision-world';
import { CollisionLayer } from '../types';

const RADIUS = 1 / 3;
const HALF_SEGMENT = 2.0277777 / 2 - RADIUS;

/** A one-triangle "hull" mesh in the XY plane at z, big enough to stand on. */
function slab(z: number) {
  const positions = new Float32Array([
    -20, -20, z, 20, -20, z, 20, 20, z,
    -20, -20, z, 20, 20, z, -20, 20, z,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

test('a cast reaches geometry registered on any provider', () => {
  const world = new CollisionWorld();
  world.doodads.add(slab(0));

  const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
  const hit = cast(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20);

  expect(hit).not.toBeNull();
  expect(hit!.normal.z).toBeCloseTo(1, 5);
});

test('the gather box covers the whole sweep, not just its origin', () => {
  // A slab 15 yards away horizontally. If the broadphase box were built around the origin alone,
  // the candidate list would be empty and a long cast would sail straight through the world.
  const world = new CollisionWorld();
  const far = slab(0);
  far.position.set(0, 0, 0);
  far.rotateY(Math.PI / 2); // now a vertical wall in the x = 0 plane
  far.position.set(15, 0, 0);
  far.updateMatrixWorld(true);
  world.doodads.add(far);

  const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
  const hit = cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), 30);

  expect(hit).not.toBeNull();
  expect(hit!.distance).toBeCloseTo(15 - RADIUS, 2);
});

test('a cast on the walk layer and one on the camera layer are independent', () => {
  const world = new CollisionWorld();
  world.doodads.add(slab(0));

  const walk = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
  const camera = world.castFor(CollisionLayer.Camera, 0.3, 0);

  expect(walk(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).not.toBeNull();
  expect(camera(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).not.toBeNull();
});

test('clear empties every provider', () => {
  const world = new CollisionWorld();
  world.doodads.add(slab(0));
  world.clear();

  const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);
  expect(cast(new THREE.Vector3(0, 0, 6), new THREE.Vector3(0, 0, -1), 20)).toBeNull();
});

test('an empty world reports no hit rather than throwing', () => {
  const world = new CollisionWorld();
  const cast = world.castFor(CollisionLayer.Walk, RADIUS, HALF_SEGMENT);

  expect(cast(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 100)).toBeNull();
  expect(world.surfaceAt(0, 0, { wmoGroup: null })).toBeNull();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="collision-world"`
Expected: FAIL — `Cannot find module '../collision-world'`.

- [ ] **Step 3: Write `client/src/game/collision/collision-world.ts`**

```ts
import * as THREE from 'three';
import { castCapsuleAgainstTriangles } from './capsule-cast';
import { DoodadProvider } from './doodad-provider';
import { LiquidRegistry } from './liquid-query';
import { TerrainProvider } from './terrain-provider';
import { CastHit, CollisionLayer, LiquidClaim, Triangle } from './types';
import { WmoProvider } from './wmo-provider';

/**
 * A configured swept cast: origin (capsule centre), unit direction, max distance, optional skin.
 * This is what every mover and camera function is handed -- never the world itself, so the whole
 * movement stack stays testable against synthetic geometry.
 */
export type CastFn = (
  from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, skin?: number,
) => CastHit | null;

const _box = new THREE.Box3();
const _end = new THREE.Vector3();

/**
 * Owns the candidate providers and turns them into the two things the rest of the game asks for:
 * a swept capsule cast, and a liquid surface height.
 *
 * Replaces `ColliderManager`, which was a flat Map of every mesh in the world plus an empty merged
 * `collidableMesh` nothing ever filled -- so collision was, in practice, dead code.
 */
export class CollisionWorld {
  readonly terrain = new TerrainProvider();
  readonly wmo = new WmoProvider();
  readonly doodads = new DoodadProvider();
  readonly liquid = new LiquidRegistry();

  /** Scratch candidate list, reused every cast so a frame allocates nothing here. */
  private candidates: Triangle[] = [];

  clear(): void {
    this.terrain.clear();
    this.wmo.clear();
    this.doodads.clear();
    this.liquid.clear();
  }

  /**
   * Build the cast closure for one audience and one capsule shape. The returned function gathers
   * candidates for the swept volume, then runs the swept capsule over them.
   */
  castFor(layer: CollisionLayer, radius: number, halfSegment: number): CastFn {
    return (from, dir, maxDist, skin = 0) => {
      const candidates = this.candidates;
      candidates.length = 0;

      // The broadphase box must cover the WHOLE sweep, not just its origin: a cast that gathered
      // around `from` alone would sail through anything more than a capsule-width away, which is
      // every wall a running step reaches.
      _end.copy(dir).multiplyScalar(maxDist).add(from);
      _box.makeEmpty().expandByPoint(from).expandByPoint(_end);
      const pad = radius + halfSegment + 0.5;
      _box.min.subScalar(pad);
      _box.max.addScalar(pad);

      this.terrain.gather(_box, candidates);
      this.wmo.gather(_box, layer, candidates);
      this.doodads.gather(_box, candidates);

      return castCapsuleAgainstTriangles(
        from, dir, maxDist, radius, halfSegment, candidates, skin,
      );
    };
  }

  surfaceAt(x: number, y: number, claim: LiquidClaim) {
    return this.liquid.surfaceAt(x, y, claim);
  }
}

/**
 * The process-wide world the streaming hooks register geometry with.
 *
 * Only integration code (the terrain/WMO/M2 managers and the per-frame controller) should touch
 * this. Movement and camera functions take a `CastFn` parameter instead -- that is what lets the
 * whole rule set be unit-tested with no world loaded, exactly as the reference does it.
 */
export const collisionWorld = new CollisionWorld();
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="collision-world"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire terrain streaming**

In `client/src/game/world/terrain-manager.js`, replace the `ColliderManager` import and its two call sites:

```js
import { collisionWorld } from '../collision/collision-world';
import { adtLiquidSurface } from '../collision/liquid-query';
```

In `loadChunk`, replace `ColliderManager.collidableMeshList.set(terrain.uuid, terrain)` with:

```js
    collisionWorld.terrain.add(terrain);

    // Liquid layers are children of the chunk, added in the Chunk constructor.
    terrain.traverse((child) => {
      if (child.isMesh && child.data && child.data.vertexData) {
        collisionWorld.liquid.add(adtLiquidSurface(child));
      }
    });
```

In `unloadChunk`, replace `ColliderManager.collidableMeshList.delete(terrain.uuid)` with:

```js
    collisionWorld.terrain.remove(terrain);
    terrain.traverse((child) => {
      if (child.isMesh) {
        collisionWorld.liquid.remove(child);
      }
    });
```

- [ ] **Step 6: Wire WMO streaming**

In `client/src/game/pipeline/wmo/group/view.js`, replace the `ColliderManager.collidableMeshList.set(this.uuid, this.mesh)` line with a registration carrying the BSP and flags:

```js
    collisionWorld.wmo.add({
      view: this,
      bspTree: group.bspTree,
      triangleFlags: group.triangleFlags,
    });
```

(Import `collisionWorld` from `'../../../collision/collision-world'`; adjust the relative depth to match the file's other imports. `group` is the `WMOGroup` the view is constructed from — if the constructor does not already hold a reference, keep one.)

In `client/src/game/pipeline/wmo/group/loader/index.js` and `client/src/game/pipeline/wmo/group/index.js`, replace each `ColliderManager.collidableMeshList.delete(...)` with `collisionWorld.wmo.remove(<the view>)`.

- [ ] **Step 7: Wire doodad streaming**

In `client/src/game/pipeline/m2/index.ts`, replace `ColliderManager.collidableMeshList.set(mesh.uuid, mesh)` in `createBoundingMesh` with `collisionWorld.doodads.add(mesh)`, and each `ColliderManager.collidableMeshList.delete(this.boundingMesh.uuid)` with `collisionWorld.doodads.remove(this.boundingMesh)`. Do the same in `client/src/game/pipeline/m2/blueprint.js`.

- [ ] **Step 8: Remove the last `ColliderManager` references and delete it**

Run: `cd client && npx grep -rn "ColliderManager" src/ || true`

Any remaining hit is in `client/src/game/classes/unit.ts` (the dead `updatePlayer` / `updateGroundDistance` code, removed in Task 18) — leave those for now and note them. Once nothing else imports it:

```bash
git rm client/src/game/world/collider-manager.js
```

If `unit.ts` still imports it at this point, keep the file and delete it in Task 18 instead. Do not leave a half-deleted module.

- [ ] **Step 9: Confirm the app still builds**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors beyond any already present on the branch. Record the pre-existing error count first with `git stash && npx tsc --noEmit; git stash pop` if unsure.

- [ ] **Step 10: Run the whole collision suite**

Run: `cd client && CI=true npm test -- --testPathPattern="collision/__tests__"`
Expected: PASS — every test from Tasks 3–9.

- [ ] **Step 11: Commit**

```bash
git add -A client/src/game/collision client/src/game/world/terrain-manager.js client/src/game/pipeline
git commit -m "feat(collision): a collision world fed by the streaming hooks

Turns the four providers into the two things the rest of the game asks
for: a swept capsule cast and a liquid surface height. The broadphase box
covers the whole sweep, not just its origin -- gathering around the origin
alone would sail through every wall a running step reaches.

Retires ColliderManager, a flat Map of every mesh in the world plus an
empty merged mesh nothing ever filled."
```

---

## Task 10: Movement constants and player state

No behaviour yet — this is the vocabulary the next six tasks are written in. The provenance comments are the deliverable as much as the numbers: without them these are unmaintainable magic constants.

**Files:**
- Create: `client/src/game/movement/constants.ts`
- Create: `client/src/game/movement/player-state.ts`
- Test: `client/src/game/movement/__tests__/constants.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: every constant below, plus `interface PlayerMoveState` and `createPlayerMoveState(): PlayerMoveState`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/constants.test.ts`:

```ts
/** @jest-environment node */
import {
  AIR_NUDGE_SPEED, CAPSULE_HEIGHT, CAPSULE_RADIUS, DEFAULT_COLLISION_HEIGHT, FALL_FAR_DROP,
  FALL_FAR_TIME, GRAVITY, GROUND_COS, GROUND_PROBE, JUMP_SPEED, LAND_PROBE, MOUSELOOK_PITCH_CLAMP,
  RUN_BACK_RATIO, RUN_SPEED, SKIN_WIDTH, STATIONARY_CHASE_RATE, STEP_SLOPE_RATIO, STEP_SNAP_SLACK,
  STEP_UP_HEIGHT, TERMINAL_VELOCITY, TURN_RATE, TURN_RATE_MOVING, WEDGE_MIN_FALL,
  WEDGE_STALL_RATIO, WEDGE_STILL_FRAMES, capsuleHalfSegment,
} from '../constants';
import { createPlayerMoveState } from '../player-state';

/**
 * These are binary-derived vanilla values, ported from the reference's player/state.rs. They are
 * pinned by test because a typo in one of them is a feel regression nobody can diagnose from the
 * symptom -- a jump that is subtly wrong looks like "the physics is off", not "GRAVITY has a
 * transposed digit".
 */
test('the verified vanilla constants have their exact values', () => {
  expect(GRAVITY).toBeCloseTo(19.291105, 6);
  expect(JUMP_SPEED).toBeCloseTo(7.955547, 6);
  expect(TERMINAL_VELOCITY).toBeCloseTo(60.148003, 6);
  expect(GROUND_COS).toBeCloseTo(0.642788, 6);
  expect(STEP_SLOPE_RATIO).toBeCloseTo(1.849399, 6);
  expect(STEP_SNAP_SLACK).toBeCloseTo(1 / 36, 9);
  expect(CAPSULE_HEIGHT).toBeCloseTo(2.0277777, 6);
  expect(DEFAULT_COLLISION_HEIGHT).toBeCloseTo(2.0277777, 6);
  expect(CAPSULE_RADIUS).toBeCloseTo(1 / 3, 9);
  expect(FALL_FAR_DROP).toBeCloseTo(1 / 9, 5);
  expect(FALL_FAR_TIME).toBeCloseTo(0.5, 6);
  expect(MOUSELOOK_PITCH_CLAMP).toBeCloseTo(1.553343, 6);
  expect(RUN_BACK_RATIO).toBeCloseTo(4.5 / 7.0, 9);
  expect(RUN_SPEED).toBeCloseTo(7.0, 6);
});

test('GROUND_COS is cosine of the 50 degree walkable limit', () => {
  expect(GROUND_COS).toBeCloseTo(Math.cos((50 * Math.PI) / 180), 5);
});

test('the tunable feel knobs are at their reference values', () => {
  expect(GROUND_PROBE).toBeCloseTo(0.2, 6);
  expect(LAND_PROBE).toBeCloseTo(0.05, 6);
  expect(STEP_UP_HEIGHT).toBeCloseTo(0.7, 6);
  expect(SKIN_WIDTH).toBeCloseTo(0.02, 6);
  expect(AIR_NUDGE_SPEED).toBeCloseTo(2.5, 6);
  expect(WEDGE_STILL_FRAMES).toBe(3);
  expect(WEDGE_STALL_RATIO).toBeCloseTo(0.15, 6);
  expect(WEDGE_MIN_FALL).toBeCloseTo(1.0, 6);
  expect(TURN_RATE).toBeCloseTo(Math.PI, 6);
  expect(TURN_RATE_MOVING).toBeCloseTo(0.75, 6);
  expect(STATIONARY_CHASE_RATE).toBeCloseTo(8.0, 6);
});

test('the capsule half-segment is the axis length between the two cap centres', () => {
  expect(capsuleHalfSegment()).toBeCloseTo(CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS, 9);
  expect(capsuleHalfSegment()).toBeGreaterThan(0);
});

test('a fresh state starts grounded-ish, not swimming, and at a real collision height', () => {
  const p = createPlayerMoveState();

  expect(p.velZ).toBe(0);
  expect(p.horizVel.length()).toBe(0);
  expect(p.airborneSince).toBeNull();
  expect(p.swimming).toBe(false);
  expect(p.levitating).toBe(false);
  expect(p.wedged).toBe(false);
  expect(p.fallFar).toBe(false);
  // Never zero: at zero every swim depth line collapses and the avatar swims on dry land.
  expect(p.collisionHeight).toBeCloseTo(DEFAULT_COLLISION_HEIGHT, 6);
});

test('faceYaw and modelYaw are separate fields', () => {
  const p = createPlayerMoveState();
  p.faceYaw = 1.0;

  // The aim and the rendered body heading diverge while strafing, and faceYaw is what the wire
  // will carry. Collapsing them now is the change that would have to be undone later.
  expect(p.modelYaw).toBe(0);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/constants"`
Expected: FAIL — `Cannot find module '../constants'`.

- [ ] **Step 3: Write `client/src/game/movement/constants.ts`**

Port the constant block from `samples/benilla/crates/benilla/src/player/state.rs` lines 9–147, keeping each doc comment. Z-up rename applies to nothing here (these are scalars). The file:

```ts
/**
 * Movement constants, ported from the reference's `player/state.rs`.
 *
 * Values marked VERIFIED are binary-derived from WoW.exe 5875 and carry the address they came from.
 * Values marked TUNABLE are feel knobs the reference chose; they are the ones to nudge if a real
 * spot plays wrong. Do not strip these comments: without provenance these are magic numbers and
 * nobody can tell which of them are safe to change.
 */

/** Backpedal speed as a fraction of run: vanilla MOVE_RUN_BACK 4.5 / MOVE_RUN 7.0. VERIFIED. */
export const RUN_BACK_RATIO = 4.5 / 7.0;

/** Vanilla MOVE_RUN (yd/s) -- the fallback until server speeds stream in. */
export const RUN_SPEED = 7.0;

/** Character turn rate (rad/s) when A/D rotate the avatar. VERIFIED (0x7c4f30 heading integrate). */
export const TURN_RATE = Math.PI;

/** Turn-rate scale while also translating -- the verified x0.75 (flags & 0x200f). */
export const TURN_RATE_MOVING = 0.75;

/**
 * The mouselook pitch clamp (radians) -- VERIFIED +/-89.0 degrees = 1.5533431 (0x8089d8). NOT
 * +/-pi/2: that clamp belongs to the separate rate-limited pitch-KEY integrator, default-unbound.
 */
export const MOUSELOOK_PITCH_CLAMP = 1.553343;

/**
 * Stationary body catch-up: once steering stops, the rendered body closes on the aim at
 * turnRate x 8 rad/s (the client's chase, 0x607ed0 tail).
 */
export const STATIONARY_CHASE_RATE = 8.0;

/** Player capsule radius (yd) -- the vanilla box's +/-1/3 half-width. TUNABLE. */
export const CAPSULE_RADIUS = 1 / 3;

/**
 * Player capsule total height (yd) -- the MOVEMENT capsule, deliberately a constant and
 * deliberately NOT a per-model collision height. It feeds the swept box, the step-vs-fall
 * election's reach and the head/feet offsets, where going per-race would change where every short
 * race can walk, step and fit. A unit's real collision height is a different quantity entirely
 * (see DEFAULT_COLLISION_HEIGHT and the swim depth lines). TUNABLE.
 */
export const CAPSULE_HEIGHT = 2.0277777;

/**
 * The client's empty-world collision height (yd) -- the CMovement ctor's 0x4001c71c at 0x616fd8,
 * VERIFIED, which the per-unit setter overwrites from the unit's model. The fallback for a unit
 * whose display id does not resolve. Numerically equal to CAPSULE_HEIGHT; not the same quantity.
 */
export const DEFAULT_COLLISION_HEIGHT = 2.0277777;

/** Downward gravity (yd/s^2). VERIFIED vanilla value (matches vmangos Movement::gravity). */
export const GRAVITY = 19.291105;

/** Jump take-off speed (yd/s). VERIFIED vanilla value. */
export const JUMP_SPEED = 7.955547;

/** Terminal fall speed (yd/s). VERIFIED (matches vmangos terminalVelocity). */
export const TERMINAL_VELOCITY = 60.148003;

/**
 * Standability gate: a surface is walkable iff its normal is within ~50 degrees of straight up
 * (cos 50, the vanilla threshold). Steeper than this you cannot climb and you slide back down.
 * Z-up port: compare against `normal.z`, not `normal.y`.
 */
export const GROUND_COS = 0.642788;

/** Downward probe distance (yd) to decide whether we are standing on ground. TUNABLE. */
export const GROUND_PROBE = 0.2;

/**
 * The post-move snap's slope ratio -- the client's step-vs-fall election (0x6367b0, constant
 * [0x80c740] = 1.8493990). The snap probe reaches `d_h * ratio + slack + collision height` below
 * the post-move position, where d_h is the frame's achieved HORIZONTAL travel. Scaling by travel
 * makes the absorbed SLOPE the constant (atan 1.8494 ~= 61.6 degrees), frame-rate independent.
 * VERIFIED.
 */
export const STEP_SLOPE_RATIO = 1.849399;

/** The election's fixed slack (yd) added to the travel-scaled snap reach -- [0x7ff9d0] = 1/36 yd. */
export const STEP_SNAP_SLACK = 1 / 36;

/**
 * The step-up rise ceiling (yd). TUNABLE and deliberately modest -- stairs, doorsteps, low rocks --
 * and deliberately NOT the reference client's ~2 yd body-height budget, so fences (collision tops
 * 1.8-2.3 yd) always slide. One number to nudge if a real spot feels too restrictive.
 */
export const STEP_UP_HEIGHT = 0.7;

/**
 * The landing probe (yd): while airborne, walk mode resumes only this close to the floor, so the
 * arc ends where the slide actually contacts instead of GROUND_PROBE early -- which cut the last
 * ~0.2 yd of every fall into a same-frame snap, a visible pop at every silent landing.
 */
export const LAND_PROBE = 0.05;

/** Consecutive stalled airborne frames that mean a capsule is wedged between steep faces. */
export const WEDGE_STILL_FRAMES = 3;

/**
 * A frame counts as stalled when the achieved descent is under this fraction of the descent gravity
 * intended. Free fall achieves ~100% and a steep-slope slide >=75%, so only opposing contacts hold
 * an arc under this.
 */
export const WEDGE_STALL_RATIO = 0.15;

/** Fall speed (yd/s) the arc must exceed before stalled frames count. A jump apex never qualifies. */
export const WEDGE_MIN_FALL = 1.0;

/**
 * One-shot air-control nudge (yd/s): a jump from a standstill can be steered this much in the
 * pressed direction; a jump taken with momentum keeps it locked (vanilla feel).
 */
export const AIR_NUDGE_SPEED = 2.5;

/**
 * The FALLINGFAR distance leg (yd): a JUMP arc (launch vz != 0) latches once it descends this far
 * below its launch height -- 0x633240, constant [0x80dff8] = 1/9 yd. A flat jump never descends
 * below its takeoff, so it never latches.
 */
export const FALL_FAR_DROP = 1 / 9;

/**
 * The FALLINGFAR timer leg (s): a STEP-OFF fall (launch vz = 0) latches once airborne this long --
 * 0x633240's accumulator test, 0x1f4 = 500 ms. The legs are exclusive on the launch vz.
 */
export const FALL_FAR_TIME = 0.5;

/** Skin width (yd) kept between the capsule and geometry on casts. */
export const SKIN_WIDTH = 0.02;

/** Max seconds to hold the avatar after a teleport while the world streams in. */
export const SETTLE_TIMEOUT = 6.0;

/** Max contact iterations one move-and-slide resolves before giving up on the remainder. */
export const MAX_SLIDE_ITERATIONS = 4;

/**
 * Half the capsule's AXIS SEGMENT -- the distance from the centre to either cap centre. This, not
 * half the total height, is what the swept cast wants.
 */
export function capsuleHalfSegment(): number {
  return CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS;
}
```

- [ ] **Step 4: Write `client/src/game/movement/player-state.ts`**

```ts
import * as THREE from 'three';
import { DEFAULT_COLLISION_HEIGHT } from './constants';

/**
 * The avatar's mutable movement state -- the reference's `Player` resource, minus the parts that
 * belong to systems this client does not have yet.
 *
 * Several fields are maintained but not yet read: they are the wire's entire integration surface,
 * and each is written by a behaviour being ported anyway. Leaving them out would mean deleting
 * working logic and putting it back when networking lands.
 */
export interface PlayerMoveState {
  /** Feet position (world, Z-up). The capsule centre is this plus CAPSULE_HEIGHT/2 on Z. */
  pos: THREE.Vector3;

  /** Vertical velocity (yd/s, +Z up) for gravity/jump/fall. Zeroed while grounded. */
  velZ: number;

  /**
   * Horizontal velocity (yd/s). Live from input while grounded; while airborne it is the take-off
   * momentum -- a moving jump keeps its trajectory, which is the WoW feel.
   */
  horizVel: THREE.Vector3;

  /**
   * The character's FACING (yaw about Z, radians) -- the aim, kept in sync with the camera by
   * right-drag and by movement. This is the orientation the server would be told.
   */
  faceYaw: number;

  /**
   * The rendered BODY heading (yaw about Z, radians). While strafing it eases off `faceYaw`; moving
   * without a strafe it snaps to it; standing it chases at STATIONARY_CHASE_RATE. Deliberately a
   * separate field from `faceYaw` -- see the doc on that one.
   */
  modelYaw: number;

  /** Elapsed seconds when the current airborne phase began, else null on the ground. */
  airborneSince: number | null;

  /**
   * The take-off vertical speed snapshotted when the airborne phase began: JUMP_SPEED for a jump,
   * exactly 0 for a step-off (the walk election's StartFalling(0)). The FALLINGFAR latch splits its
   * distance/timer legs on it.
   */
  jumpZSpeed: number;

  /** Launch height (world Z) snapshotted when the airborne arc began. */
  fallStartZ: number;

  /** MOVEFLAG_FALLINGFAR latched for this arc. Only landing clears it. */
  fallFar: boolean;

  /** At rest wedged between steep faces: treated as standing, walking control live. */
  wedged: boolean;

  /** Consecutive stalled airborne frames (see WEDGE_STALL_RATIO). */
  wedgeStill: number;

  /** Settling after a teleport while the world streams in: frozen in place, gravity off. */
  settling: boolean;

  /** Elapsed-seconds deadline to give up settling and release. */
  settleDeadline: number;

  /** In swim mode: the avatar floats and swims in 3D instead of walking. */
  swimming: boolean;

  /**
   * The swim pitch (radians, +up). HELD when unsteered -- an idle floater keeps its pitch and is
   * never auto-levelled. Steered by mouselook as a DIRECT set of the camera aim pitch.
   */
  swimPitch: number;

  /** This frame's flag-scalar swim travel speed (yd/s); the swim stroke's playback-rate numerator. */
  swimStrokeSpeed: number;

  /**
   * The unit's OWN collision height (yd) -- CreatureModelData.collisionHeight x displayScale. Every
   * swim depth line is a fraction of it, which is why a gnome floats with her head out and a night
   * elf sits deeper. NOT the movement capsule height.
   *
   * Defaults to DEFAULT_COLLISION_HEIGHT rather than 0 precisely because at zero every depth line
   * collapses to 0 and the avatar swims on dry land.
   */
  collisionHeight: number;

  /**
   * The server put us in free flight (MOVEFLAG_LEVITATING, GM `.cheat fly`). Always false until the
   * wire lands. It does exactly one thing, by suppression: while set, the water/depth decision does
   * not run AT ALL -- neither arm -- so a server-granted swim stays on over dry ground (which IS GM
   * flight) and real water cannot grant one.
   */
  levitating: boolean;

  /** The CMovement moveFlags last streamed. Maintained for the wire; nothing reads it yet. */
  moveFlags: number;

  /** The facing as of last frame -- the reference's facing-change detector. */
  lastFacing: number;
}

export function createPlayerMoveState(): PlayerMoveState {
  return {
    pos: new THREE.Vector3(),
    velZ: 0,
    horizVel: new THREE.Vector3(),
    faceYaw: 0,
    modelYaw: 0,
    airborneSince: null,
    jumpZSpeed: 0,
    fallStartZ: 0,
    fallFar: false,
    wedged: false,
    wedgeStill: 0,
    settling: false,
    settleDeadline: 0,
    swimming: false,
    swimPitch: 0,
    swimStrokeSpeed: 0,
    collisionHeight: DEFAULT_COLLISION_HEIGHT,
    levitating: false,
    moveFlags: 0,
    lastFacing: 0,
  };
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/constants"`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/movement/constants.ts client/src/game/movement/player-state.ts client/src/game/movement/__tests__/constants.test.ts
git commit -m "feat(movement): the verified constants and the player state

Ported from the reference's player/state.rs with provenance intact --
which addresses each value came from, and which are VERIFIED versus
TUNABLE. Pinned by test because a typo here is a feel regression nobody
can diagnose from the symptom.

faceYaw and modelYaw are separate from the start, and the wire-facing
fields exist now because each is written by a behaviour being ported
anyway."
```

---

## Task 11: The two hit rules

These are the reference's `walkable_ride_velocity` and `steep_wall_plane` — the rules that make a walkable slope feel like flat ground and a steep face feel like a wall. Both are pure functions of a normal and a velocity, and the reference's own test suite ports over directly.

**Files:**
- Create: `client/src/game/movement/slide.ts`
- Test: `client/src/game/movement/__tests__/hit-rules.test.ts`

**Interfaces:**
- Consumes: `GROUND_COS` (Task 10)
- Produces:
  - `walkableRideVelocity(n: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 | null`
  - `steepWallPlane(n: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 | null`

- [ ] **Step 1: Write the failing test**

This is a direct port of `samples/benilla/crates/benilla/src/player/mover.rs` lines 544–652, Z-up.

Create `client/src/game/movement/__tests__/hit-rules.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { steepWallPlane, walkableRideVelocity } from '../slide';

/** Outward normal of a face rising toward +x, tilted `deg` from horizontal. Z-up. */
function face(deg: number): THREE.Vector3 {
  const r = (deg * Math.PI) / 180;
  return new THREE.Vector3(-Math.sin(r), 0, Math.cos(r));
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

test('a walkable ramp rides at full horizontal speed', () => {
  // 45 degrees uphill at run speed: the ride keeps the 2D velocity exactly (the true-plane clip
  // would halve it to h*cos^2(45) = 3.5) and lies in the plane, so the clip passes it untouched.
  const n = face(45);
  const ride = walkableRideVelocity(n, v3(7, 0, 0))!;

  expect(ride).not.toBeNull();
  expect(ride.x).toBeCloseTo(7, 6);
  expect(ride.y).toBeCloseTo(0, 6);
  expect(ride.z).toBeGreaterThan(0);
  expect(Math.abs(ride.dot(n))).toBeLessThan(1e-6);
});

test('a diagonal approach is not deflected', () => {
  // Walking diagonally up a face rising toward +x: the true-plane clip bends the path toward
  // across-slope; the ride keeps both horizontal components untouched.
  const ride = walkableRideVelocity(face(40), v3(5, 5, 0))!;

  expect(ride.x).toBeCloseTo(5, 6);
  expect(ride.y).toBeCloseTo(5, 6);
});

test('a prior facet ride is recomputed, not stacked', () => {
  // Crossing a facet boundary mid-slide: the incoming vertical (facet A's ride) is discarded and
  // rebuilt for facet B -- the grounded mover owns no vertical of its own.
  const n = face(45);
  const ride = walkableRideVelocity(n, v3(7, 0, 3))!;

  expect(ride.x).toBeCloseTo(7, 6);
  expect(ride.y).toBeCloseTo(0, 6);
  expect(Math.abs(ride.dot(n))).toBeLessThan(1e-6);
});

test('steep, flat and receding planes never ride', () => {
  const push = v3(7, 0, 0);

  expect(walkableRideVelocity(face(60), push)).toBeNull();          // steep: the wall rule's
  expect(walkableRideVelocity(v3(0, 0, 1), push)).toBeNull();       // flat floor: no opposition
  expect(walkableRideVelocity(face(40), push.clone().negate())).toBeNull(); // receding
});

test('the ride covers the walkable range up to the gate', () => {
  const v = v3(7, 0, 0);
  const ride = walkableRideVelocity(face(49.9), v)!;

  expect(ride.x).toBeCloseTo(7, 6);
  expect(ride.z).toBeLessThanOrEqual(7 * Math.tan((50 * Math.PI) / 180) + 1e-3);
  expect(walkableRideVelocity(face(50.1), v)).toBeNull();
  expect(steepWallPlane(face(50.1), v)).not.toBeNull();
});

test('walking into a steep face clips as a wall', () => {
  const wall = steepWallPlane(face(60), v3(7, 0, 0))!;

  expect(wall.z).toBeCloseTo(0, 9);
  expect(wall.x).toBeLessThan(0);
  expect(wall.length()).toBeCloseTo(1, 6);
});

test('the wedge misfire window flattens', () => {
  // Falling slowly with locked forward momentum: the true-plane clip would end RISING -- the
  // descent-cancel that tripped the wedge rest into landing mid-face.
  expect(steepWallPlane(face(60), v3(7, -1.3, 0).set(7, 0, -1.3))).not.toBeNull();
});

test('a real fall keeps the true plane', () => {
  // The natural slide down a steep surface must survive: descent-dominated clips stay on the true
  // plane, because flattening them hovers the fall mid-face.
  expect(steepWallPlane(face(60), v3(0, 0, -10))).toBeNull();
  expect(steepWallPlane(face(60), v3(7, 0, -20))).toBeNull();
});

test('rising contacts flatten but a wall keeps the mover own lift', () => {
  // A jump rising along the face: the flatten removes the face's manufactured boost; the mover's
  // own +vz passes through the vertical wall untouched.
  const v = v3(7, 0, 8);
  const wall = steepWallPlane(face(60), v)!;
  const clipped = v.clone().sub(wall.clone().multiplyScalar(v.dot(wall)));

  expect(clipped.z).toBeCloseTo(v.z, 6);
});

test('walkable, overhanging and vertical faces are untouched by the wall rule', () => {
  const push = v3(7, 0, 0);

  expect(steepWallPlane(face(40), push)).toBeNull();                       // ordinary uphill walk
  expect(steepWallPlane(v3(-0.5, 0, -0.7).normalize(), push)).toBeNull();  // overhang
  expect(steepWallPlane(face(90), push)).toBeNull();                       // true vertical: no lift
  expect(steepWallPlane(face(60), push.clone().negate())).toBeNull();      // receding
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="hit-rules"`
Expected: FAIL — `Cannot find module '../slide'`.

- [ ] **Step 3: Write the rules into `client/src/game/movement/slide.ts`**

```ts
import * as THREE from 'three';
import { GROUND_COS } from './constants';

/**
 * The even-speed ramp ride: a walkable slope never slows or deflects the grounded walk.
 *
 * The real client's walk step is two-dimensional -- the resolver takes speed*dt as a HORIZONTAL
 * distance and a normalized 2D direction, and Z follows purely through the snap/step machinery
 * (0x6367b0's own signature) -- so on every walkable (< 50 degree) surface the horizontal speed is
 * exactly the run speed. Collide-and-slide's true-plane clip breaks that invariant: v' = v - (v.n)n
 * shortens the horizontal part to h*cos^2(theta) (half speed at 45 degrees) and bends a diagonal
 * approach off the input line.
 *
 * So when the grounded slide meets an opposing WALKABLE plane, replace the clip with the
 * vertical-lift projection: keep the horizontal velocity exactly, and set the vertical so the
 * motion rides along the plane (v'.n = 0, which means the plane's own clip then passes it
 * untouched). Unreal's `bMaintainHorizontalGroundVelocity` is the same standard treatment.
 *
 * Returns null when the rule does not apply -- steep faces are `steepWallPlane`'s, airborne
 * contacts keep the true clip so a landing still slides naturally, and a receding plane opposes
 * nothing. Any height the ride manufactures is bounded by the end-of-frame snap, which only ever
 * settles onto a walkable floor.
 */
export function walkableRideVelocity(n: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 | null {
  if (n.z < GROUND_COS || v.dot(n) >= 0) {
    return null;
  }
  // Walkability bounds n.z >= cos50 > 0; an opposing contact makes the recomputed vertical strictly
  // positive and at most h*tan50. A prior facet's ride vertical is DISCARDED, not stacked: the
  // grounded mover owns no vertical of its own.
  return new THREE.Vector3(v.x, v.y, -(v.x * n.x + v.y * n.y) / n.z);
}

/**
 * The steep-face wall rule: a steep (non-walkable, non-overhanging) face must never LIFT the mover.
 *
 * Collide-and-slide clips velocity onto each contact plane, and on a tilted plane that clip
 * manufactures upward motion out of a horizontal push (v'.z - v.z = -(v.n)*n.z, positive for every
 * opposing contact) -- which walks a capsule straight up 50-80 degree trunks and hillsides, and,
 * while falling with locked forward momentum, cancels enough of the descent to trip the wedge rest
 * into landing mid-face. Together, a climbing ratchet.
 *
 * When the true-plane clip would leave the mover moving UPWARD (v'.z > 0), return the face's
 * vertical-wall flatten to clip against instead: the push slides along the wall line and only the
 * mover's own vertical motion survives. A descending clip keeps the true plane -- that IS the
 * natural slide down a steep surface, and flattening those stalls real falls against the face.
 * Walkable floors and overhangs (n.z < 0) always keep their plane.
 *
 * This is the standard controller treatment (Unreal HandleSlopeBoosting, Godot floor_block_on_wall).
 * Penetration safety is untouched: the slide's sweeps still stop at the real surface, and the plane
 * only shapes the deflection.
 */
export function steepWallPlane(n: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 | null {
  if (!(n.z >= 0 && n.z < GROUND_COS)) {
    return null;
  }
  const vn = v.dot(n);
  if (vn >= 0 || v.z - vn * n.z <= 0) {
    return null;
  }
  // Steepness bounds the horizontal part below by sin 50, so the normalize is safe.
  return new THREE.Vector3(n.x, n.y, 0).normalize();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="hit-rules"`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/movement/slide.ts client/src/game/movement/__tests__/hit-rules.test.ts
git commit -m "feat(movement): the walkable-ride and steep-wall hit rules

A walkable slope must not slow or deflect the walk -- the real client's
step is two-dimensional, and collide-and-slide's true-plane clip halves
horizontal speed at 45 degrees and bends diagonals off the input line.

A steep face must never lift the mover -- the same clip manufactures
upward motion out of a horizontal push, which walks a capsule up tree
trunks and cancels enough descent to land a fall mid-face.

Test suite ported from the reference's own."
```

---

## Task 12: `moveAndSlide`

The one piece with no line-for-line source — the reference delegates it to avian. Its required behaviour is pinned by the hit-callback contract from Task 11 and by the tests here.

**Files:**
- Modify: `client/src/game/movement/slide.ts`
- Test: `client/src/game/movement/__tests__/slide.test.ts`

**Interfaces:**
- Consumes: `CastFn` (Task 9), `walkableRideVelocity` / `steepWallPlane` (Task 11), `MAX_SLIDE_ITERATIONS` / `SKIN_WIDTH` (Task 10)
- Produces:
  - `interface SlideHit { normal: THREE.Vector3; velocity: THREE.Vector3; source: object }` — mutable; a callback may rewrite either field
  - `type SlideCallback = (hit: SlideHit) => void`
  - `moveAndSlide(cast: CastFn, from: THREE.Vector3, velocity: THREE.Vector3, dt: number, onHit: SlideCallback): { position: THREE.Vector3; contacts: number }`
  - `groundedHitResponse(hit: SlideHit): void` — the grounded callback (ride, else wall-flatten)
  - `airborneHitResponse(hit: SlideHit): void` — the airborne callback (wall-flatten only)

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/slide.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { airborneHitResponse, groundedHitResponse, moveAndSlide } from '../slide';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A cast that never hits anything. */
const openWorld: CastFn = () => null;

/**
 * A cast against a single infinite plane through `point` with outward `normal`. The capsule is
 * treated as a point here, which is what makes the expected distances arithmetic rather than
 * geometry -- the real capsule offsets are Task 4's business and are tested there.
 */
function planeCast(point: THREE.Vector3, normal: THREE.Vector3, source: object = {}): CastFn {
  return (from, dir, maxDist) => {
    const denom = dir.dot(normal);
    if (denom >= -1e-9) {
      return null; // moving away from or along the plane
    }
    const t = normal.dot(point.clone().sub(from)) / denom;
    if (t < 0 || t > maxDist) {
      return null;
    }
    return { distance: t, normal: normal.clone(), source } as CastHit;
  };
}

test('an unobstructed move travels the full velocity times dt', () => {
  const out = moveAndSlide(openWorld, v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

  expect(out.position.x).toBeCloseTo(0.7, 6);
  expect(out.contacts).toBe(0);
});

test('a zero velocity does not move and takes no contacts', () => {
  const out = moveAndSlide(planeCast(v3(1, 0, 0), v3(-1, 0, 0)), v3(0, 0, 0), v3(0, 0, 0), 0.1, groundedHitResponse);

  expect(out.position.length()).toBeCloseTo(0, 9);
  expect(out.contacts).toBe(0);
});

test('a head-on wall stops the move at the wall', () => {
  const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
  const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, airborneHitResponse);

  expect(out.position.x).toBeCloseTo(0.3, 4);
  expect(out.contacts).toBeGreaterThanOrEqual(1);
});

test('an angled wall deflects the remaining motion along it', () => {
  // Wall normal pointing back along -x; moving diagonally into it should keep the +y component.
  const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
  const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 7, 0), 0.1, airborneHitResponse);

  expect(out.position.x).toBeCloseTo(0.3, 3);
  expect(out.position.y).toBeGreaterThan(0.3); // the along-wall component survived
});

test('a walkable ramp is ridden at full horizontal speed, not clipped', () => {
  // A 45-degree ramp rising toward +x, contacted immediately. The grounded response must preserve
  // the horizontal distance travelled (0.7), not shorten it to 0.7*cos^2(45) = 0.35.
  const r = Math.PI / 4;
  const n = v3(-Math.sin(r), 0, Math.cos(r));
  const cast = planeCast(v3(0, 0, 0), n);
  const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

  expect(out.position.x).toBeCloseTo(0.7, 3);
  expect(out.position.z).toBeGreaterThan(0);
});

test('a steep face does not lift a grounded push', () => {
  // A 70-degree face: the true-plane clip would manufacture upward motion. The wall flatten must
  // leave the vertical alone.
  const r = (70 * Math.PI) / 180;
  const n = v3(-Math.sin(r), 0, Math.cos(r));
  const cast = planeCast(v3(0, 0, 0), n);
  const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, groundedHitResponse);

  expect(out.position.z).toBeCloseTo(0, 3);
});

test('the callback may rewrite the normal and the velocity it is handed', () => {
  const cast = planeCast(v3(0.3, 0, 0), v3(-1, 0, 0));
  let seen = 0;
  const out = moveAndSlide(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1, (hit) => {
    seen += 1;
    hit.velocity.set(0, 7, 0); // redirect entirely sideways
    hit.normal.set(0, 0, 1);
  });

  expect(seen).toBeGreaterThanOrEqual(1);
  expect(out.position.y).toBeGreaterThan(0);
});

test('the iteration ceiling bounds the work rather than looping forever', () => {
  // A cast that always reports a zero-distance contact -- a corner the slide can never escape.
  const pathological: CastFn = (_from, _dir) => ({
    distance: 0, normal: v3(0, 0, 1), source: {},
  } as CastHit);

  const out = moveAndSlide(pathological, v3(0, 0, 0), v3(7, 0, 0), 0.1, airborneHitResponse);

  expect(out.contacts).toBeLessThanOrEqual(4);
  expect(Number.isFinite(out.position.x)).toBe(true);
});

test('the input vectors are not mutated', () => {
  const from = v3(1, 2, 3);
  const velocity = v3(7, 0, 0);
  moveAndSlide(openWorld, from, velocity, 0.1, groundedHitResponse);

  expect(from.toArray()).toEqual([1, 2, 3]);
  expect(velocity.toArray()).toEqual([7, 0, 0]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/slide"`
Expected: FAIL — `moveAndSlide is not a function`.

- [ ] **Step 3: Append to `client/src/game/movement/slide.ts`**

```ts
import { CastFn } from '../collision/collision-world';
import { MAX_SLIDE_ITERATIONS, SKIN_WIDTH } from './constants';

/**
 * One contact, handed to the slide callback. Both fields are MUTABLE: a callback rewrites
 * `velocity` to change what the remainder of the move does, and `normal` to change what plane the
 * clip happens against. This mirrors the reference's `MoveAndSlideHitResponse` contract, which is
 * how the two hit rules above get applied.
 */
export interface SlideHit {
  normal: THREE.Vector3;
  velocity: THREE.Vector3;
  source: object;
}

export type SlideCallback = (hit: SlideHit) => void;

/**
 * Collide-and-slide a capsule through the world for one frame.
 *
 * The reference delegates this to avian, so this is the one piece of the mover with no
 * line-for-line source. Its required behaviour is fixed by the callback contract: at each contact
 * the callback may rewrite the normal and velocity, then the remaining motion is clipped onto the
 * resulting plane and the sweep continues.
 *
 * Neither input vector is mutated.
 */
export function moveAndSlide(
  cast: CastFn,
  from: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
  onHit: SlideCallback,
): { position: THREE.Vector3; contacts: number } {
  const position = from.clone();
  const vel = velocity.clone();
  const remaining = vel.clone().multiplyScalar(dt);
  const dir = new THREE.Vector3();
  let contacts = 0;

  for (let i = 0; i < MAX_SLIDE_ITERATIONS; ++i) {
    const distance = remaining.length();
    if (distance < 1e-6) {
      break;
    }
    dir.copy(remaining).divideScalar(distance);

    const hit = cast(position, dir, distance, SKIN_WIDTH);
    if (!hit) {
      position.add(remaining);
      break;
    }

    contacts += 1;
    const travelled = Math.max(0, hit.distance);
    position.addScaledVector(dir, travelled);

    // Hand the contact to the caller's rule set. It may redirect the velocity outright (the
    // walkable ride) or flatten the plane we are about to clip against (the steep wall).
    const slideHit: SlideHit = { normal: hit.normal.clone(), velocity: vel, source: hit.source };
    onHit(slideHit);

    // Whatever motion was left, clipped onto the (possibly rewritten) plane.
    const leftover = Math.max(0, distance - travelled);
    remaining.copy(slideHit.velocity).normalize().multiplyScalar(leftover);
    if (!Number.isFinite(remaining.x)) {
      break; // the callback zeroed the velocity: nothing left to resolve
    }
    remaining.addScaledVector(slideHit.normal, -remaining.dot(slideHit.normal));
  }

  return { position, contacts };
}

/**
 * The GROUNDED contact response: ride an opposing walkable plane at full horizontal speed, else
 * flatten a steep face so it cannot lift us. Both rules are above; this is the order the reference
 * applies them in.
 */
export function groundedHitResponse(hit: SlideHit): void {
  const ride = walkableRideVelocity(hit.normal, hit.velocity);
  if (ride) {
    hit.velocity.copy(ride);
    return;
  }
  const wall = steepWallPlane(hit.normal, hit.velocity);
  if (wall) {
    hit.normal.copy(wall);
  }
}

/**
 * The AIRBORNE contact response: steep faces get the same wall treatment as on the ground, but
 * there is no ride -- an arc owns its own height, so the only thing the world may do to it is stop
 * it, and a landing should still slide naturally down a walkable plane.
 */
export function airborneHitResponse(hit: SlideHit): void {
  const wall = steepWallPlane(hit.normal, hit.velocity);
  if (wall) {
    hit.normal.copy(wall);
  }
}
```

Note: move the existing `import * as THREE from 'three'` to the top of the file if it is not already there, and merge the two import blocks — do not leave two `import` statements for `./constants`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/slide"`
Expected: PASS, 9 tests.

- [ ] **Step 5: Re-run the hit rules to confirm the file still exports them**

Run: `cd client && CI=true npm test -- --testPathPattern="hit-rules"`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/movement/slide.ts client/src/game/movement/__tests__/slide.test.ts
git commit -m "feat(movement): collide-and-slide with the grounded and airborne responses

The one piece of the mover with no line-for-line source -- the reference
delegates it to avian -- so its behaviour is fixed by the callback
contract instead: at each contact the callback may rewrite the normal
and the velocity, then the remainder is clipped onto the result.

Grounded rides walkable planes and flattens steep ones; airborne only
flattens, because an arc owns its own height."
```

---

## Task 13: The atomic step-up

Rise → advance → settle, committed whole inside one frame or not at all. The atomicity is the design: there is no intermediate mid-climb state to be seen wedged or bouncing in.

**Files:**
- Create: `client/src/game/movement/step-up.ts`
- Test: `client/src/game/movement/__tests__/step-up.test.ts`

**Interfaces:**
- Consumes: `CastFn` (Task 9), constants (Task 10)
- Produces:
  - `type StepUpVerdict = 'commit' | 'no-headroom' | 'no-floor' | 'steep-floor' | 'net-zero' | 'no-obstacle'`
  - `stepUp(cast: CastFn, center: THREE.Vector3, dirH: THREE.Vector3, travel: number): { landed: THREE.Vector3 | null; verdict: StepUpVerdict; climb: number }`

  `dirH` must be a unit horizontal vector. `landed` is non-null only on `'commit'`.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/step-up.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT, GROUND_COS, STEP_UP_HEIGHT } from '../constants';
import { stepUp } from '../step-up';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const FWD = v3(1, 0, 0);

/**
 * A scripted cast: each entry matches on the sign of the direction and returns a fixed hit. This
 * lets each case state exactly what the three probes (ahead, up, forward-at-height, down) find,
 * which is the only way to test a maneuver whose whole logic is "what did the probes say".
 */
function scriptedCast(script: {
  ahead?: CastHit | null;
  up?: CastHit | null;
  forward?: CastHit | null;
  down?: CastHit | null;
}): CastFn {
  let aheadUsed = false;
  return (_from, dir) => {
    if (dir.z > 0.5) return script.up ?? null;
    if (dir.z < -0.5) return script.down ?? null;
    // The first horizontal probe is the obstacle test; the second is the raised advance.
    if (!aheadUsed) { aheadUsed = true; return script.ahead ?? null; }
    return script.forward ?? null;
  };
}

const hit = (distance: number, normal: THREE.Vector3): CastHit => ({
  distance, normal: normal.clone(), source: {},
});

/** A steep face opposing +x travel: normal tilted 70 degrees from horizontal. */
const steepFace = () => {
  const r = (70 * Math.PI) / 180;
  return v3(-Math.sin(r), 0, Math.cos(r));
};

test('nothing ahead means no maneuver', () => {
  const out = stepUp(scriptedCast({ ahead: null }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('no-obstacle');
});

test('a walkable slope ahead is not an obstacle -- the plain slide handles it', () => {
  const walkable = v3(-0.3, 0, 0.954).normalize(); // ~17 degrees, comfortably walkable
  expect(walkable.z).toBeGreaterThan(GROUND_COS);

  const out = stepUp(scriptedCast({ ahead: hit(0.05, walkable) }), v3(0, 0, 0), FWD, 0.12);

  expect(out.verdict).toBe('no-obstacle');
});

test('an overhang ahead is not an obstacle', () => {
  const out = stepUp(
    scriptedCast({ ahead: hit(0.05, v3(-0.5, 0, -0.7).normalize()) }), v3(0, 0, 0), FWD, 0.12,
  );

  expect(out.verdict).toBe('no-obstacle');
});

test('a low step commits, landing on its top', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()),
    up: null,                                   // full STEP_UP_HEIGHT of headroom
    forward: null,                              // the full travel is clear at the raised height
    down: hit(STEP_UP_HEIGHT - 0.3, UP),        // floor 0.3 above where we started
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.verdict).toBe('commit');
  expect(out.landed).not.toBeNull();
  expect(out.climb).toBeCloseTo(0.3, 5);
  expect(out.landed!.z).toBeCloseTo(0.3, 5);
  expect(out.landed!.x).toBeCloseTo(0.12, 5);
});

test('no headroom above means slide instead', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()),
    up: hit(0.0005, v3(0, 0, -1)),   // a ceiling immediately overhead
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('no-headroom');
});

test('no floor under the advanced point means slide instead', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()), up: null, forward: null, down: null,
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('no-floor');
});

test('a steep landing never commits -- this is why the tree pinch cannot wedge', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()), up: null, forward: null,
    down: hit(0.2, steepFace()),
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('steep-floor');
});

test('a grazing rub nets back onto the same floor and reads as sliding', () => {
  // The settle lands us exactly where we rose from: no height gained, so no commit -- committing
  // here would dead-stop what should read as sliding along the face.
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()), up: null, forward: null,
    down: hit(STEP_UP_HEIGHT, UP),
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('net-zero');
});

test('a wall taller than the ceiling leaves no forward clearance, so it slides', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()), up: null,
    forward: hit(0, steepFace()),          // still blocked at the raised height
    down: hit(STEP_UP_HEIGHT, UP),         // settles back on the origin floor
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.landed).toBeNull();
  expect(out.verdict).toBe('net-zero');
});

test('the rise never exceeds STEP_UP_HEIGHT even with unlimited headroom', () => {
  const out = stepUp(scriptedCast({
    ahead: hit(0.05, steepFace()), up: null, forward: null,
    down: hit(0, UP),   // floor exactly at the raised height
  }), v3(0, 0, 0), FWD, 0.12);

  expect(out.verdict).toBe('commit');
  expect(out.climb).toBeCloseTo(STEP_UP_HEIGHT, 5);
});

test('the capsule height is not what bounds the rise', () => {
  // A guard against confusing the two: STEP_UP_HEIGHT is a deliberately modest tunable, well under
  // the capsule height, so fences always slide.
  expect(STEP_UP_HEIGHT).toBeLessThan(CAPSULE_HEIGHT / 2);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="step-up"`
Expected: FAIL — `Cannot find module '../step-up'`.

- [ ] **Step 3: Write `client/src/game/movement/step-up.ts`**

Port `samples/benilla/crates/benilla/src/player/mover.rs` lines 444–542, Z-up.

```ts
import * as THREE from 'three';
import { CastFn } from '../collision/collision-world';
import { GROUND_COS, STEP_SLOPE_RATIO, STEP_SNAP_SLACK, STEP_UP_HEIGHT } from './constants';

/** Why the step-up did or did not commit -- trace fodder, and the whole diagnosis of a feel report. */
export type StepUpVerdict =
  | 'commit'
  | 'no-obstacle'
  | 'no-headroom'
  | 'no-floor'
  | 'steep-floor'
  | 'net-zero';

const _up = new THREE.Vector3(0, 0, 1);
const _down = new THREE.Vector3(0, 0, -1);

/**
 * The atomic step-up -- the standard kinematic-controller maneuver: a steep opposing face within
 * this frame's travel triggers RISE -> ADVANCE -> SETTLE, committed whole inside one frame, or
 * nothing happens and the plain slide runs.
 *
 * - RISE by the free headroom, at most STEP_UP_HEIGHT -- the deliberately low ceiling that scopes
 *   this to stairs, doorsteps and low rocks, and keeps fences and walls slide-only.
 * - ADVANCE this frame's own travel along the INPUT direction at the raised height. Never a
 *   probe-length lunge.
 * - SETTLE back down by the walk election's own reach; commit ONLY onto a walkable floor that is
 *   actually higher.
 *
 * The atomicity is the point. Case by case: a square push at a low step lands on its top this
 * frame; a grazing rub settles back onto the same floor, nets zero, and reads as sliding along; a
 * face taller than the ceiling leaves no forward clearance at the raised height, so the settle
 * lands back on the origin floor and it slides; a pinch between two tree trunks offers only steep
 * landings, so it can NEVER commit. The wedge-and-bounce class of bugs is impossible by
 * construction, because there is no intermediate mid-climb state to be caught in.
 */
export function stepUp(
  cast: CastFn,
  center: THREE.Vector3,
  dirH: THREE.Vector3,
  travel: number,
): { landed: THREE.Vector3 | null; verdict: StepUpVerdict; climb: number } {
  const miss = (verdict: StepUpVerdict) => ({ landed: null, verdict, climb: 0 });

  // A steep, non-overhanging face opposing the motion, within this frame's travel. No incidence
  // gate -- the verified reference has none; a grazing contact nets zero through the settle instead.
  const ahead = cast(center, dirH, travel);
  if (!ahead) {
    return miss('no-obstacle');
  }
  const n = ahead.normal;
  if (n.z >= GROUND_COS || n.z < 0 || n.dot(dirH) >= 0) {
    return miss('no-obstacle');
  }

  // RISE: the free headroom, at most STEP_UP_HEIGHT.
  const upHit = cast(center, _up, STEP_UP_HEIGHT);
  const rise = upHit ? upHit.distance : STEP_UP_HEIGHT;
  if (rise < 1e-3) {
    return miss('no-headroom');
  }

  // ADVANCE: this frame's travel along the input direction, swept at the raised height.
  const raised = center.clone().addScaledVector(_up, rise);
  const fwdHit = cast(raised, dirH, travel);
  const forward = fwdHit ? fwdHit.distance : travel;
  const over = raised.clone().addScaledVector(dirH, forward);

  // SETTLE: the walk election's reach below the advanced point -- the rise undone, plus the
  // travel-scaled step-down allowance -- onto a WALKABLE floor only.
  const reach = rise + travel * STEP_SLOPE_RATIO + STEP_SNAP_SLACK;
  const downHit = cast(over, _down, reach);
  if (!downHit) {
    return miss('no-floor');
  }
  if (downHit.normal.z < GROUND_COS) {
    return miss('steep-floor');
  }

  const landed = over.clone().addScaledVector(_down, downHit.distance);
  const climb = landed.z - center.z;

  // Commit only a landing that actually gained a floor. A net-zero maneuver -- grazing a face,
  // pushing a too-tall wall, the tree pinch's gap grass -- belongs to the plain slide: its
  // deflection is what "sliding along the fence" IS, and committing here would dead-stop it.
  if (climb <= 0.05) {
    return miss('net-zero');
  }

  return { landed, verdict: 'commit', climb };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="step-up"`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/movement/step-up.ts client/src/game/movement/__tests__/step-up.test.ts
git commit -m "feat(movement): the atomic step-up

Rise, advance, settle -- committed whole inside one frame or not at all.
The atomicity is the design: there is no intermediate mid-climb state,
so a pinch between two tree trunks offers only steep landings and can
never commit, and the wedge-and-bounce class is impossible by
construction rather than by guard."
```

---

## Task 14: The grounded and airborne resolves

The two shared world resolves. `groundedStep` is step-up → slide → election snap; `airborneStep` is the arc's slide and nothing else. Both are exported standalone because the reference drives *every* mover through one controller — when networking lands, a remote player's dead reckoning runs this same code.

**Files:**
- Create: `client/src/game/movement/mover.ts`
- Test: `client/src/game/movement/__tests__/resolves.test.ts`

**Interfaces:**
- Consumes: `CastFn` (Task 9), constants (Task 10), `moveAndSlide` / responses (Task 12), `stepUp` (Task 13)
- Produces:
  - `interface GroundedStep { center: THREE.Vector3; ground: object | null; climb: number | null; snap: { reach: number; hit: { distance: number; normalZ: number } | null } | null }`
  - `groundedStep(cast: CastFn, center: THREE.Vector3, horizVel: THREE.Vector3, dt: number): GroundedStep`
  - `airborneStep(cast: CastFn, center: THREE.Vector3, velocity: THREE.Vector3, dt: number): THREE.Vector3`

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/resolves.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT, STEP_SLOPE_RATIO, STEP_SNAP_SLACK } from '../constants';
import { airborneStep, groundedStep } from '../mover';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);

/** No geometry anywhere. */
const empty: CastFn = () => null;

/**
 * A cast that only answers DOWNWARD probes, with a floor `drop` below the probe origin. Horizontal
 * probes miss, so the step-up finds no obstacle and the slide runs unobstructed -- isolating the
 * election snap.
 */
function floorBelow(drop: number, normal = UP, source: object = {}): CastFn {
  return (_from, dir, maxDist) => {
    if (dir.z > -0.5) return null;
    if (drop > maxDist) return null;
    return { distance: drop, normal: normal.clone(), source } as CastHit;
  };
}

test('an unobstructed grounded step travels the full horizontal distance', () => {
  const out = groundedStep(empty, v3(0, 0, 10), v3(7, 0, 0), 0.1);

  expect(out.center.x).toBeCloseTo(0.7, 5);
  expect(out.center.z).toBeCloseTo(10, 5);
  expect(out.climb).toBeNull();
  expect(out.ground).toBeNull();
});

test('the election snap follows a floor down and reports what it stood on', () => {
  const ground = {};
  const out = groundedStep(floorBelow(0.4, UP, ground), v3(0, 0, 10), v3(7, 0, 0), 0.1);

  expect(out.center.z).toBeCloseTo(10 - 0.4, 5);
  expect(out.ground).toBe(ground);
  expect(out.snap).not.toBeNull();
});

test('the snap reach scales with the horizontal travel plus the collision height', () => {
  const out = groundedStep(floorBelow(0.1), v3(0, 0, 10), v3(7, 0, 0), 0.1);

  // travel 0.7 -> reach = 0.7 * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT
  const expected = 0.7 * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT;
  expect(out.snap!.reach).toBeCloseTo(expected, 5);
});

test('standing still the reach is still enough to re-ground an idle body', () => {
  const out = groundedStep(floorBelow(0.01), v3(0, 0, 10), v3(0, 0, 0), 0.1);

  expect(out.snap!.reach).toBeCloseTo(STEP_SNAP_SLACK + CAPSULE_HEIGHT, 5);
  expect(out.center.z).toBeCloseTo(10 - 0.01, 5);
});

test('a floor deeper than the reach is not absorbed -- that gap becomes a fall', () => {
  const deep = 0.7 * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT + 5;
  const out = groundedStep(floorBelow(deep), v3(0, 0, 100), v3(7, 0, 0), 0.1);

  expect(out.center.z).toBeCloseTo(100, 5);
  expect(out.ground).toBeNull();
});

test('a steep floor under the snap is not absorbed either', () => {
  const r = (70 * Math.PI) / 180;
  const steep = v3(-Math.sin(r), 0, Math.cos(r));
  const out = groundedStep(floorBelow(0.4, steep), v3(0, 0, 10), v3(7, 0, 0), 0.1);

  expect(out.center.z).toBeCloseTo(10, 5);
  expect(out.ground).toBeNull();
  // The probe still ran and is reported, which is what makes a feel report diagnosable.
  expect(out.snap!.hit).not.toBeNull();
  expect(out.snap!.hit!.normalZ).toBeCloseTo(Math.cos(r), 4);
});

test('a committed step-up IS the frame -- no slide and no snap after it', () => {
  const r = (70 * Math.PI) / 180;
  const steepFace = v3(-Math.sin(r), 0, Math.cos(r));
  let horizontalProbes = 0;

  const cast: CastFn = (_from, dir) => {
    if (dir.z > 0.5) return null;                                     // headroom: clear
    if (dir.z < -0.5) return { distance: 0.4, normal: UP, source: {} } as CastHit;
    horizontalProbes += 1;
    // First horizontal probe is the obstacle test; later ones are the raised advance.
    return horizontalProbes === 1
      ? ({ distance: 0.05, normal: steepFace, source: {} } as CastHit)
      : null;
  };

  const out = groundedStep(cast, v3(0, 0, 0), v3(7, 0, 0), 0.1);

  expect(out.climb).not.toBeNull();
  expect(out.climb!).toBeGreaterThan(0);
  expect(out.snap).toBeNull();
});

test('an airborne step is the arc slide and nothing else', () => {
  const out = airborneStep(empty, v3(0, 0, 10), v3(7, 0, -5), 0.1);

  expect(out.x).toBeCloseTo(0.7, 5);
  expect(out.z).toBeCloseTo(9.5, 5);
});

test('an airborne step never snaps down onto a floor below it', () => {
  // The arc owns its own height: landing is next frame's ground probe to decide, not this one's.
  const out = airborneStep(floorBelow(0.4), v3(0, 0, 10), v3(7, 0, 0), 0.1);

  expect(out.z).toBeCloseTo(10, 5);
});

test('neither resolve mutates its inputs', () => {
  const center = v3(1, 2, 3);
  const vel = v3(7, 0, 0);
  groundedStep(empty, center, vel, 0.1);
  airborneStep(empty, center, vel, 0.1);

  expect(center.toArray()).toEqual([1, 2, 3]);
  expect(vel.toArray()).toEqual([7, 0, 0]);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="resolves"`
Expected: FAIL — `Cannot find module '../mover'`.

- [ ] **Step 3: Write the two resolves into `client/src/game/movement/mover.ts`**

Port `samples/benilla/crates/benilla/src/player/mover.rs` lines 233–391, Z-up.

```ts
import * as THREE from 'three';
import { CastFn } from '../collision/collision-world';
import {
  CAPSULE_HEIGHT, GROUND_COS, STEP_SLOPE_RATIO, STEP_SNAP_SLACK,
} from './constants';
import { airborneHitResponse, groundedHitResponse, moveAndSlide } from './slide';
import { stepUp } from './step-up';

const _down = new THREE.Vector3(0, 0, -1);

/** What one grounded walk step resolved against the world came out as. */
export interface GroundedStep {
  /** The resolved capsule centre. */
  center: THREE.Vector3;
  /**
   * The collider of the walkable floor the election snap settled onto, when it ran and hit one.
   * `null` means "keep whatever the caller already believed" -- a step-up commit and a missed snap
   * both leave the support unchanged.
   */
  ground: object | null;
  /** The atomic step-up's committed height gain (yd), when the maneuver ran. */
  climb: number | null;
  /** The election snap's probe reach and what it found. Trace fodder; null when the step-up took the frame. */
  snap: { reach: number; hit: { distance: number; normalZ: number } | null } | null;
}

/**
 * ONE GROUNDED WALK STEP, resolved against the world -- step-up, then slide, then the election
 * snap. The single place a walking body meets the terrain, and deliberately so: the reference
 * drives EVERY mover through one controller (0x616620 integrates any mover; the local-player GUID
 * compare gates only a timing budget). When networking lands, a remote mover's dead reckoning calls
 * this same function for its extrapolated step -- an extrapolator that ignored the world would walk
 * a watched player into a hillside and leave their height wherever the last packet put it.
 *
 * Airborne and swimming frames are NOT this function's: a jump is a ballistic arc and a swimmer's Z
 * is its depth, exactly as the reference's grounded fork excludes both.
 */
export function groundedStep(
  cast: CastFn,
  center: THREE.Vector3,
  horizVel: THREE.Vector3,
  dt: number,
): GroundedStep {
  const speed = horizVel.length();

  // The step-up is ATOMIC: a steep face in the way triggers rise -> advance -> settle, all
  // committed inside this one frame, or nothing happens and the plain slide runs below.
  if (speed > 1e-6) {
    const dirH = horizVel.clone().divideScalar(speed);
    const stepped = stepUp(cast, center, dirH, speed * dt);
    if (stepped.landed) {
      // The committed maneuver IS this frame's motion -- already settled on a walkable floor, so
      // the slide and the snap are skipped.
      return { center: stepped.landed, ground: null, climb: stepped.climb, snap: null };
    }
  }

  const slid = moveAndSlide(cast, center, horizVel, dt, groundedHitResponse).position;

  // Snap onto the surface so we follow downhill slopes and steps down -- the client's step-vs-fall
  // election (0x6367b0). The probe reaches STEP_SLOPE_RATIO * travel + STEP_SNAP_SLACK + the unit's
  // collision height, and snaps only onto a WALKABLE floor. A deeper or steeper floor is NOT
  // absorbed: no snap, the next frame's ground probe misses, and the gap becomes a fall. A short
  // ledge drop therefore reads as a quick, continuous, steep descent rather than a teleport.
  //
  // Standing still the reach is slack + collision height, which is what re-grounds an IDLE body
  // every frame.
  const dx = slid.x - center.x;
  const dy = slid.y - center.y;
  const reach = Math.hypot(dx, dy) * STEP_SLOPE_RATIO + STEP_SNAP_SLACK + CAPSULE_HEIGHT;
  const hit = cast(slid, _down, reach);
  const snap = {
    reach,
    hit: hit ? { distance: hit.distance, normalZ: hit.normal.z } : null,
  };

  let ground: object | null = null;
  if (hit && hit.normal.z >= GROUND_COS) {
    slid.z -= hit.distance;
    ground = hit.source;
  }

  return { center: slid, ground, climb: null, snap };
}

/**
 * ONE AIRBORNE STEP, resolved against the world -- the arc's slide and nothing else.
 *
 * No step-up and no election snap: the arc owns its own height (gravity carries it; the landing is
 * next frame's ground probe to call), so the only thing the world may do here is STOP it. Steep
 * faces get the same treatment they do on the ground.
 *
 * Exported alongside `groundedStep` for the same reason: when networking lands, a remote mover's
 * ballistic dead reckoning runs this, so a jump meets our walls whoever is jumping. Without it a
 * watched player who jumps into a building is drawn inside it for the length of the jump.
 */
export function airborneStep(
  cast: CastFn,
  center: THREE.Vector3,
  velocity: THREE.Vector3,
  dt: number,
): THREE.Vector3 {
  return moveAndSlide(cast, center, velocity, dt, airborneHitResponse).position;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="resolves"`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/movement/mover.ts client/src/game/movement/__tests__/resolves.test.ts
git commit -m "feat(movement): the grounded and airborne world resolves

Grounded is step-up, slide, then the step-vs-fall election snap, whose
reach scales with the frame's horizontal travel so the absorbed SLOPE is
the constant rather than the distance. Airborne is the arc's slide alone
-- it owns its own height, so the world may only stop it.

Both are exported standalone: the reference drives every mover through
one controller, and a remote player's dead reckoning will run this same
code when networking lands."
```

---

## Task 15: The mover frame step

The whole frame: classify the ground, decide grounded, apply gravity or the jump, run the right resolve, detect the wedge rest, latch FALLINGFAR. After this task the player physically moves.

**Files:**
- Modify: `client/src/game/movement/mover.ts`
- Create: `client/src/game/movement/move-trace.ts`
- Test: `client/src/game/movement/__tests__/step.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 10–14
- Produces:
  - `interface MoveInput { moving: boolean; dir: THREE.Vector3; speed: number; wantJump: boolean }`
  - `interface Outcome { held: boolean; grounded: boolean; jumped: boolean; airNudged: boolean; ground: object | null }`
  - `step(state: PlayerMoveState, cast: CastFn, input: MoveInput, dt: number, now: number): Outcome`
  - `moveTrace.enabled`, `moveTrace.frame(record)`, `moveTrace.last()` (in `move-trace.ts`)

  `Outcome` is the wire layer's entire integration surface — keep it returned even though nothing reads it yet.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/step.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import {
  CAPSULE_HEIGHT, FALL_FAR_DROP, FALL_FAR_TIME, GRAVITY, JUMP_SPEED, TERMINAL_VELOCITY,
  WEDGE_STILL_FRAMES,
} from '../constants';
import { step } from '../mover';
import { createPlayerMoveState } from '../player-state';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const HALF_H = CAPSULE_HEIGHT / 2;

const idle = { moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: false };
const walking = { moving: true, dir: v3(1, 0, 0), speed: 7, wantJump: false };
const jumping = { moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: true };

/** Open air everywhere. */
const air: CastFn = () => null;

/**
 * A world with solid ground at z = 0. Downward probes report the distance from the capsule's bottom
 * cap to the floor; everything else misses.
 */
const ground: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;             // feet height above z = 0
  if (gap < 0 || gap > maxDist) return null;
  return { distance: gap, normal: UP.clone(), source: 'floor' } as CastHit;
};

/** Feet on the floor. */
function standing() {
  const p = createPlayerMoveState();
  p.pos.set(0, 0, 0);
  return p;
}

test('a body on the floor is grounded, with no vertical velocity', () => {
  const p = standing();
  const out = step(p, ground, idle, 1 / 60, 0);

  expect(out.grounded).toBe(true);
  expect(p.velZ).toBe(0);
  expect(p.airborneSince).toBeNull();
  expect(out.ground).toBe('floor');
});

test('a body in open air falls, accelerating under gravity', () => {
  const p = standing();
  p.pos.set(0, 0, 100);
  const dt = 1 / 60;

  const out = step(p, air, idle, dt, 0);

  expect(out.grounded).toBe(false);
  expect(p.velZ).toBeCloseTo(-GRAVITY * dt, 5);
  expect(p.pos.z).toBeLessThan(100);
});

test('a long fall is capped at terminal velocity', () => {
  const p = standing();
  p.pos.set(0, 0, 10000);
  for (let i = 0; i < 600; ++i) {
    step(p, air, idle, 1 / 60, i / 60);
  }

  expect(p.velZ).toBeCloseTo(-TERMINAL_VELOCITY, 3);
});

test('a jump takes off at the verified speed and leaves the ground', () => {
  const p = standing();
  const out = step(p, ground, jumping, 1 / 60, 0);

  expect(out.jumped).toBe(true);
  expect(p.jumpZSpeed).toBeCloseTo(JUMP_SPEED, 5);
  expect(p.airborneSince).not.toBeNull();
});

test('a jump is not re-grounded on the very next frame', () => {
  // The bug that ate most jumps: "grounded" must mean on walkable ground AND not rising.
  const p = standing();
  step(p, ground, jumping, 1 / 60, 0);
  const second = step(p, ground, idle, 1 / 60, 1 / 60);

  expect(second.grounded).toBe(false);
  expect(p.velZ).toBeGreaterThan(0);
});

test('walking on flat ground moves at the full input speed', () => {
  const p = standing();
  step(p, ground, walking, 0.1, 0);

  expect(p.pos.x).toBeCloseTo(0.7, 3);
  expect(p.pos.z).toBeCloseTo(0, 3);
});

test('settling freezes the body with gravity off', () => {
  const p = standing();
  p.pos.set(0, 0, 500);
  p.settling = true;

  const out = step(p, air, walking, 1 / 60, 0);

  expect(out.held).toBe(true);
  expect(p.pos.z).toBeCloseTo(500, 6);
  expect(p.velZ).toBe(0);
  expect(p.horizVel.length()).toBe(0);
});

test('a standstill jump gets one air nudge; a moving jump keeps its momentum locked', () => {
  const fromRest = standing();
  step(fromRest, ground, jumping, 1 / 60, 0);
  const nudged = step(fromRest, air, { ...walking, wantJump: false }, 1 / 60, 1 / 60);

  expect(nudged.airNudged).toBe(true);
  expect(fromRest.horizVel.length()).toBeGreaterThan(0);

  const fromRun = standing();
  step(fromRun, ground, walking, 1 / 60, 0);          // build momentum
  step(fromRun, ground, { ...walking, wantJump: true }, 1 / 60, 1 / 60);
  const locked = fromRun.horizVel.clone();
  const after = step(fromRun, air, { moving: true, dir: v3(0, 1, 0), speed: 7, wantJump: false }, 1 / 60, 2 / 60);

  expect(after.airNudged).toBe(false);
  expect(fromRun.horizVel.x).toBeCloseTo(locked.x, 5);
});

test('a jump arc latches FALLINGFAR once it descends below its launch', () => {
  const p = standing();
  step(p, ground, jumping, 1 / 60, 0);
  expect(p.fallFar).toBe(false);

  // Run the arc past its apex and back down past the launch height.
  for (let i = 1; i < 120 && !p.fallFar; ++i) {
    step(p, air, idle, 1 / 60, i / 60);
  }

  expect(p.fallFar).toBe(true);
  expect(p.fallStartZ - p.pos.z).toBeGreaterThanOrEqual(FALL_FAR_DROP);
});

test('a step-off fall latches FALLINGFAR on the timer leg instead', () => {
  // Launch vz = 0 -- the walk election's StartFalling(0). The legs are exclusive on the launch vz.
  const p = standing();
  p.pos.set(0, 0, 1000);
  step(p, air, idle, 1 / 60, 0);
  expect(p.jumpZSpeed).toBe(0);

  let t = 1 / 60;
  for (let i = 1; i < 60; ++i) {
    t = i / 60;
    step(p, air, idle, 1 / 60, t);
  }

  expect(t).toBeGreaterThan(FALL_FAR_TIME);
  expect(p.fallFar).toBe(true);
});

test('landing clears the airborne arc and its FALLINGFAR latch', () => {
  const p = standing();
  p.pos.set(0, 0, 3);
  for (let i = 0; i < 120; ++i) {
    const out = step(p, ground, idle, 1 / 60, i / 60);
    if (out.grounded && i > 0) break;
  }

  expect(p.airborneSince).toBeNull();
  expect(p.fallFar).toBe(false);
  expect(p.pos.z).toBeCloseTo(0, 2);
});

test('a stalled fall lands standing after the wedge frames', () => {
  // A capsule held between steep faces: gravity keeps feeding the arc, the contacts cancel it, and
  // without this the falling pose is permanent with mid-air control locked.
  const wedge: CastFn = (from, dir, maxDist) => {
    if (dir.z < -0.5) {
      // Something close below, but too steep to stand on.
      const r = (78 * Math.PI) / 180;
      return maxDist >= 0.02
        ? ({ distance: 0.02, normal: v3(-Math.sin(r), 0, Math.cos(r)), source: 'funnel' } as CastHit)
        : null;
    }
    return { distance: 0, normal: v3(-1, 0, 0), source: 'funnel' } as CastHit;
  };

  const p = standing();
  p.pos.set(0, 0, 50);
  p.velZ = -5;           // already falling fast enough to qualify

  let grounded = false;
  for (let i = 0; i < WEDGE_STILL_FRAMES + 3 && !grounded; ++i) {
    grounded = step(p, wedge, idle, 1 / 60, i / 60).grounded;
  }

  expect(grounded).toBe(true);
  expect(p.wedged).toBe(true);
  expect(p.velZ).toBe(0);
});

test('the outcome shape is the wire integration surface and is always returned', () => {
  const out = step(standing(), ground, idle, 1 / 60, 0);

  expect(out).toHaveProperty('held');
  expect(out).toHaveProperty('grounded');
  expect(out).toHaveProperty('jumped');
  expect(out).toHaveProperty('airNudged');
  expect(out).toHaveProperty('ground');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/step"`
Expected: FAIL — `step is not a function`.

- [ ] **Step 3: Write `client/src/game/movement/move-trace.ts`**

```ts
/**
 * The per-frame movement trace -- the equivalent of the reference's `WOW_MOVE_TRACE`.
 *
 * Feel is not unit-testable, so this is the instrument that makes a feel report diagnosable: it
 * records every probe number and the step-up's verdict for the most recent frames, and the debug
 * panel surfaces it. The reference records that this instrument is what broke its fence and tree
 * cases when reasoning alone could not, which is why it is built up front rather than after the
 * first report that something plays wrong.
 *
 * Off by default: `moveTrace.enabled = true` (or `window.moveTrace.enabled = true` in the console)
 * turns it on. While off, `frame()` returns immediately and allocates nothing.
 */
export interface MoveTraceFrame {
  zIn: number;
  zOut: number;
  grounded: boolean;
  onWalkable: boolean;
  velZ: number;
  snap: { reach: number; hit: { distance: number; normalZ: number } | null } | null;
  climb: number | null;
  stepUpVerdict: string | null;
}

const HISTORY = 120;

class MoveTrace {
  enabled = false;
  private frames: MoveTraceFrame[] = [];

  frame(record: MoveTraceFrame): void {
    if (!this.enabled) {
      return;
    }
    this.frames.push(record);
    if (this.frames.length > HISTORY) {
      this.frames.shift();
    }
  }

  last(): MoveTraceFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  history(): readonly MoveTraceFrame[] {
    return this.frames;
  }

  clear(): void {
    this.frames.length = 0;
  }
}

export const moveTrace = new MoveTrace();
```

- [ ] **Step 4: Append `step` to `client/src/game/movement/mover.ts`**

Port `samples/benilla/crates/benilla/src/player/mover.rs` lines 41–231, Z-up.

```ts
import {
  AIR_NUDGE_SPEED, FALL_FAR_DROP, FALL_FAR_TIME, GRAVITY, GROUND_PROBE, JUMP_SPEED, LAND_PROBE,
  TERMINAL_VELOCITY, WEDGE_MIN_FALL, WEDGE_STALL_RATIO, WEDGE_STILL_FRAMES,
} from './constants';
import { moveTrace } from './move-trace';
import { PlayerMoveState } from './player-state';

/** This frame's movement intent, already resolved from keys and camera heading. */
export interface MoveInput {
  moving: boolean;
  /** Desired horizontal direction (world, Z-up). Need not be normalized. */
  dir: THREE.Vector3;
  /** Desired horizontal speed (yd/s). */
  speed: number;
  wantJump: boolean;
}

/**
 * What the step decided. This is the wire layer's ENTIRE integration surface: the reference builds
 * its movement-flag diff, its MSG_MOVE_JUMP / MSG_MOVE_FALL_LAND transitions and its heartbeat out
 * of this plus the state fields. Returning it now costs nothing.
 */
export interface Outcome {
  /** Settling after a teleport: frozen in place, gravity off. */
  held: boolean;
  /** On walkable ground and not rising this frame. */
  grounded: boolean;
  /** A jump took off this frame. */
  jumped: boolean;
  /** The standstill-jump air nudge fired. */
  airNudged: boolean;
  /** What we are standing on, if anything. */
  ground: object | null;
}

/**
 * Advance the player mover one frame.
 *
 * A thin kinematic controller over the swept cast:
 *  - probe down to classify the ground (walkable iff its normal is within ~50 degrees of up);
 *  - "grounded" means on walkable ground AND not rising, so a jump cleanly leaves the ground and is
 *    not re-grounded the next frame -- the bug that ate most jumps. While airborne the probe
 *    tightens to LAND_PROBE, so the arc ends where the slide actually contacts;
 *  - grounded moves horizontally only with NO gravity in the slide (gravity-slide was the downhill
 *    creep on micro-sloped terrain), then snaps onto the surface to follow it;
 *  - airborne, gravity carries the arc, with a one-shot nudge to steer a standstill jump;
 *  - a fall whose descent stalls (a capsule wedged between steep faces) LANDS there: standing,
 *    walking control live, instead of hanging in the falling pose forever.
 */
export function step(
  state: PlayerMoveState,
  cast: CastFn,
  input: MoveInput,
  dt: number,
  now: number,
): Outcome {
  const inputHoriz = input.moving && input.speed > 0
    ? input.dir.clone().normalize().multiplyScalar(input.speed)
    : new THREE.Vector3();

  const halfH = CAPSULE_HEIGHT * 0.5;
  let center = state.pos.clone().setZ(state.pos.z + halfH);

  // While airborne, "on the ground" means where the slide actually contacts (LAND_PROBE). The wider
  // walking probe would end the arc early and close the gap with a same-frame snap -- the visible
  // pop at every silent landing.
  const groundReach = state.airborneSince !== null ? LAND_PROBE : GROUND_PROBE;
  const classify = cast(center, _down, groundReach);
  const onWalkable = !!classify && classify.normal.z >= GROUND_COS;
  let groundEntity: object | null = onWalkable && classify ? classify.source : null;

  // Settle hold: the streamed world arrives over several frames, so the ground under a teleport
  // destination is not there yet. Gravity OFF and frozen in place until it is.
  const held = state.settling;
  const onFloor = !held && onWalkable && state.velZ <= 0;

  // The wedged rest stands until real ground takes over or the support vanishes.
  if (state.wedged && (onFloor || held || cast(center, _down, LAND_PROBE) === null)) {
    state.wedged = false;
  }
  let grounded = onFloor || state.wedged;

  let jumped = false;
  if (held) {
    state.velZ = 0;
    state.horizVel.set(0, 0, 0);
  } else if (grounded) {
    state.velZ = 0;
    if (input.wantJump) {
      state.velZ = JUMP_SPEED;
      state.wedged = false;
      jumped = true;
    }
  } else {
    state.velZ = Math.max(state.velZ - GRAVITY * dt, -TERMINAL_VELOCITY);
  }

  let airNudged = false;
  if (grounded) {
    state.horizVel.copy(inputHoriz);
  } else if (!held && input.moving && state.horizVel.lengthSq() < 0.01) {
    // Air control: one nudge to steer a jump taken from a standstill. A moving jump keeps its
    // momentum locked, because horizVel is already non-zero.
    state.horizVel.copy(input.dir).normalize().multiplyScalar(AIR_NUDGE_SPEED);
    if (!Number.isFinite(state.horizVel.x)) {
      state.horizVel.set(0, 0, 0);
    } else {
      airNudged = true;
    }
  }

  const preMove = center.clone();
  let climb: number | null = null;
  let snap: GroundedStep['snap'] = null;

  if (!held && grounded && !jumped) {
    const g = groundedStep(cast, center, state.horizVel, dt);
    center = g.center;
    climb = g.climb;
    snap = g.snap;
    if (g.ground) {
      groundEntity = g.ground;
    }
  } else {
    const velocity = held
      ? new THREE.Vector3()
      : state.horizVel.clone().setZ(state.velZ);
    center = airborneStep(cast, center, velocity, dt);
  }

  // Wedge-rest detection: airborne, already falling fast, yet the descent achieved is a sliver of
  // what gravity intended. WEDGE_STILL_FRAMES in a row is a capsule held between steep faces (a
  // ball in a V-groove -- flaring tree-trunk bases form exactly this funnel, with contact normals
  // barely above horizontal, so there is no downward exit). Land it. Free fall achieves ~100% of
  // its intent and a steep-slope slide >=75%, and a jump apex is slower than WEDGE_MIN_FALL, so
  // neither can trip this. Measuring against the INTENT (which keeps growing) catches the pinch as
  // it happens, rather than waiting out a decelerating millimetre creep in the falling pose.
  if (
    !held && !grounded && !jumped
    && state.velZ < -WEDGE_MIN_FALL
    && preMove.z - center.z < -state.velZ * dt * WEDGE_STALL_RATIO
  ) {
    state.wedgeStill += 1;
    if (state.wedgeStill >= WEDGE_STILL_FRAMES) {
      state.wedged = true;
      state.wedgeStill = 0;
      state.velZ = 0;
    }
  } else {
    state.wedgeStill = 0;
  }

  // The frame that detects the wedge reports grounded immediately, so the falling pose ends now and
  // the wire will see a normal landing this frame, not next.
  grounded = grounded || state.wedged;

  state.pos.copy(center).setZ(center.z - halfH);

  // Airborne bookkeeping: the arc's clock, its launch snapshot, and the FALLINGFAR latch.
  if (!held && !grounded) {
    if (state.airborneSince === null) {
      state.airborneSince = now;
      // A jump launches with JUMP_SPEED; a step-off fall launches with EXACTLY 0 -- the walk
      // election's StartFalling(0). The two FALLINGFAR legs are exclusive on this value.
      state.jumpZSpeed = jumped ? JUMP_SPEED : 0;
      state.fallStartZ = state.pos.z;
      state.fallFar = false;
    }
    if (!state.fallFar) {
      state.fallFar = state.jumpZSpeed !== 0
        ? state.fallStartZ - state.pos.z >= FALL_FAR_DROP
        : now - state.airborneSince >= FALL_FAR_TIME;
    }
  } else if (!held) {
    // Landing clears the arc, exactly as the client's StopFalling does.
    state.airborneSince = null;
    state.fallFar = false;
  }

  moveTrace.frame({
    zIn: preMove.z - halfH,
    zOut: state.pos.z,
    grounded,
    onWalkable,
    velZ: state.velZ,
    snap,
    climb,
    stepUpVerdict: null,
  });

  return {
    held,
    grounded,
    jumped,
    airNudged,
    ground: grounded && !held ? groundEntity : null,
  };
}
```

Note: `jumped` is set *before* the arc bookkeeping runs, so the takeoff frame is the one that snapshots `jumpZSpeed`. Also add `import * as THREE from 'three'` and `import { CastFn } from '../collision/collision-world'` if the earlier half of the file does not already have them — merge, do not duplicate.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/step"`
Expected: PASS, 13 tests.

The two most likely failures and what they mean:
- `a jump is not re-grounded on the very next frame` — the `state.velZ <= 0` term is missing from `onFloor`. That term is the whole fix; do not work around it by widening the probe.
- `a stalled fall lands standing` — the stall comparison is against the achieved descent, not the position. Re-read the `preMove.z - center.z` line.

- [ ] **Step 6: Run the whole movement suite**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__"`
Expected: PASS — every test from Tasks 10–15.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/movement/mover.ts client/src/game/movement/move-trace.ts client/src/game/movement/__tests__/step.test.ts
git commit -m "feat(movement): the mover frame step

Ground classify, gravity or jump, the right resolve, wedge-rest detection
and the FALLINGFAR latch. Grounded means on walkable ground AND not
rising, which is what stops a jump being re-grounded on its second frame.

Adds the move trace up front: feel is not unit-testable, and the
reference records that this instrument is what broke its fence and tree
cases when reasoning alone could not."
```

---

## Task 16: The swim law

The pure half of swimming: the depth latch, the rest line, and the cap redirect. The reference's test suite ports over directly and is unusually valuable here — it encodes defects that were expensive to find.

**Files:**
- Create: `client/src/game/movement/swim.ts`
- Test: `client/src/game/movement/__tests__/swim-law.test.ts`

**Interfaces:**
- Consumes: `GRAVITY` (Task 10), `PlayerMoveState` (Task 10)
- Produces:
  - `SWIM_SPEED = 4.722222`, `SWIM_BACK_SPEED = 2.5`, `SWIM_JUMP_SPEED = 9.096748`, `SWIM_DEPTH_FRAC = 0.75`, `SWIM_HYSTERESIS = 1/36`
  - `swimEnterDepth(h: number): number`
  - `swimExitDepth(h: number): number`
  - `restCap(h: number): number`
  - `settleToRest(feetZ: number, surfaceZ: number, h: number): number`
  - `capRedirect(inputVel: THREE.Vector3, cap: number): { velocity: THREE.Vector3; surfacePitch: number | null }`
  - `updateSwimming(state: PlayerMoveState, surfaceZ: number | null, now: number): boolean`

- [ ] **Step 1: Write the failing test**

Port `samples/benilla/crates/benilla/src/player/swim.rs` lines 388–687, Z-up.

Create `client/src/game/movement/__tests__/swim-law.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { DEFAULT_COLLISION_HEIGHT, GRAVITY } from '../constants';
import { createPlayerMoveState } from '../player-state';
import {
  capRedirect, restCap, settleToRest, SWIM_JUMP_SPEED, SWIM_SPEED, swimEnterDepth, swimExitDepth,
  updateSwimming,
} from '../swim';

/**
 * The shipped `CreatureModelData.collisionHeight x displayScale` for three real bodies. Human male
 * is the one the old single constant happened to match (2.031 vs 2.0278 -- 2 mm apart, which is why
 * the gnome defect hid for so long).
 */
const HUMAN_MALE = 2.031;
const GNOME_FEMALE = 1.150;   // 1.000 column x 1.15 display scale
const NIGHT_ELF_MALE = 2.438;

function playerOfHeight(z: number, h: number) {
  const p = createPlayerMoveState();
  p.pos.set(0, 0, z);
  p.collisionHeight = h;
  return p;
}
const playerAt = (z: number) => playerOfHeight(z, HUMAN_MALE);

test('swim entry and exit have the verified 1/36 yd hysteresis', () => {
  for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
    // The band is exactly 1/36 yd, INDEPENDENT of height -- so it is subtracted, never scaled.
    expect(swimEnterDepth(h) - swimExitDepth(h)).toBeCloseTo(1 / 36, 9);
    expect(swimEnterDepth(h)).toBeCloseTo(0.75 * h, 9);
  }

  const enter = swimEnterDepth(HUMAN_MALE);
  const exit = swimExitDepth(HUMAN_MALE);
  const midBand = (enter + exit) * 0.5;
  const p = playerAt(0); // feet at 0, so the surface height IS the submersion depth

  expect(updateSwimming(p, enter, 0)).toBe(false);      // exactly at the enter depth: strict >
  expect(updateSwimming(p, midBand, 0)).toBe(false);    // in the band from walking: stays walking
  expect(updateSwimming(p, enter + 0.01, 0)).toBe(true);
  expect(updateSwimming(p, midBand, 0)).toBe(true);     // same depth from swimming: hysteresis
  expect(updateSwimming(p, exit - 0.01, 0)).toBe(false);

  expect(updateSwimming(p, enter + 0.5, 0)).toBe(true);
  expect(updateSwimming(p, null, 0)).toBe(false);       // no liquid stops it regardless of depth
});

test('levitating bails the water decision in both directions', () => {
  // GM flight is the SUPPRESSION, not a lift. Dry land cannot clear a server-granted swim (which is
  // what keeps you airborne), and deep water cannot grant one. Same instruction, both arms.
  const flying = playerAt(0);
  flying.swimming = true;
  flying.levitating = true;

  expect(updateSwimming(flying, null, 0)).toBe(true);
  expect(updateSwimming(flying, -50, 0)).toBe(true);

  const dry = playerAt(0);
  dry.levitating = true;
  expect(updateSwimming(dry, swimEnterDepth(HUMAN_MALE) + 1, 0)).toBe(false);

  flying.levitating = false;
  expect(updateSwimming(flying, null, 0)).toBe(false);
});

test('the latch leaves the settle hold alone', () => {
  // The settle release belongs to world residency, in every mover mode alike. A swim latch that
  // cleared it here would race that judgement.
  for (const surface of [swimEnterDepth(HUMAN_MALE) + 1, swimExitDepth(HUMAN_MALE) - 0.5, null]) {
    const p = playerAt(0);
    p.settling = true;
    updateSwimming(p, surface, 0);
    expect(p.settling).toBe(true);
  }
});

test('the hop re-latches at half launch velocity, while still rising', () => {
  // The verified fall re-entry gate: a fresh swim jump is not re-latched until its upward velocity
  // has decayed to HALF the launch value. The release happens while STILL RISING, which is what
  // tops the dolphin hop at ~1.6 yd rather than the full ballistic apex.
  const halfDecay = SWIM_JUMP_SPEED / (2 * GRAVITY);
  const deep = swimEnterDepth(HUMAN_MALE) + 1;

  const p = playerAt(0);
  p.airborneSince = 0;
  p.jumpZSpeed = SWIM_JUMP_SPEED;
  p.velZ = SWIM_JUMP_SPEED;
  expect(updateSwimming(p, deep, halfDecay * 0.5)).toBe(false);

  p.velZ = SWIM_JUMP_SPEED * 0.49;
  expect(updateSwimming(p, deep, halfDecay + 1e-3)).toBe(true);

  // A plain fall into water (no upward velocity) enters regardless of the clock.
  const q = playerAt(0);
  q.airborneSince = 0;
  q.jumpZSpeed = SWIM_JUMP_SPEED;
  q.velZ = -0.1;
  expect(updateSwimming(q, deep, 0.01)).toBe(true);
});

test('the rest line is satisfied from above and never pulls up', () => {
  for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
    const cap = restCap(h);
    expect(settleToRest(10 - cap, 10, h)).toBeCloseTo(0, 9);           // on the line
    expect(settleToRest(10 - cap - 0.01, 10, h)).toBeCloseTo(0, 9);    // a dive: no pull up
    expect(settleToRest(10 - cap - 30, 10, h)).toBeCloseTo(0, 9);      // deep: still no pull up
    expect(settleToRest(10 - cap + 0.25, 10, h)).toBeCloseTo(0.25, 9); // above: sink exactly the excess
  }
});

test('every race floats with its head out of the water', () => {
  // The gnome defect. The rest line is 0.75*h below the waterline, so the head clears it iff
  // 0.75*h < h -- trivially true for the unit's OWN h, and false the moment one body's h is used
  // for another's.
  for (const h of [HUMAN_MALE, GNOME_FEMALE, NIGHT_ELF_MALE]) {
    const submerged = restCap(h);
    expect(submerged).toBeLessThan(h);
    expect((h - submerged) / h).toBeCloseTo(0.25, 6);
  }

  // And the shape of the defect itself: the one constant applied to a gnome puts the rest line
  // ABOVE her head, so she is held under with water to spare, unable to surface at any stroke.
  const oneConstant = restCap(DEFAULT_COLLISION_HEIGHT);
  expect(oneConstant).toBeGreaterThan(GNOME_FEMALE);
  expect(oneConstant - GNOME_FEMALE).toBeGreaterThan(0.3);
});

test('a descending surface does not flap the swim latch', () => {
  // The downhill-river jitter, as the frame loop that produces it. The slope is a real measured
  // river channel. Frozen feet cannot hold the latch for a tenth of a second: the surface descends
  // through the whole 1/36 yd band almost at once, and every crossing hands the avatar to the fall
  // mover and back. Satisfying the constraint instead pins the depth on the rest line.
  const SLOPE = 0.099;
  const DT = 1 / 60;
  const H = HUMAN_MALE;
  const cap = restCap(H);
  const surfaceAfter = (secs: number) => 100 - SLOPE * SWIM_SPEED * secs;

  // (a) frozen feet -- the pre-fix law
  const frozen = playerOfHeight(surfaceAfter(0) - cap, H);
  frozen.swimming = true;
  let leftAt: number | null = null;
  for (let i = 0; i < 600; ++i) {
    const t = i * DT;
    if (!updateSwimming(frozen, surfaceAfter(t), t)) { leftAt = t; break; }
  }
  expect(leftAt).not.toBeNull();
  expect(leftAt!).toBeLessThan(0.1);

  // (b) the shipped law -- the settle runs on the surface at the position the stroke reached
  const held = playerOfHeight(surfaceAfter(0) - cap, H);
  held.swimming = true;
  for (let i = 0; i < 600; ++i) {
    const t = i * DT;
    const surface = surfaceAfter(t);
    held.pos.z -= settleToRest(held.pos.z, surface, H);
    expect(updateSwimming(held, surface, t)).toBe(true);
    expect(surface - held.pos.z - cap).toBeCloseTo(0, 4);
  }
});

test('the rest line redirects the stroke level at full speed', () => {
  const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Cap far away (deep): untouched, no presented-pitch override.
  const free = v3(0.1, 0.2, 3);
  expect(capRedirect(free, 100).surfacePitch).toBeNull();
  expect(capRedirect(free, Infinity).surfacePitch).toBeNull();

  // Descending: the cap never touches a dive.
  expect(capRedirect(v3(1, 0, -2), 0).surfacePitch).toBeNull();

  // Pinned at the line (cap 0): a near-vertical stroke becomes a FULL-speed LEVEL stroke, not a
  // clipped one -- the difference between surface swimming and the "invisible wall".
  const steep = v3(0.08, 0, 4.72);
  const pinned = capRedirect(steep, 0);
  expect(pinned.velocity.length()).toBeCloseTo(steep.length(), 4);
  expect(pinned.velocity.z).toBeCloseTo(0, 9);
  expect(pinned.velocity.x).toBeGreaterThan(4.7);
  expect(pinned.surfacePitch).toBeCloseTo(0, 6);

  // Approaching the line (partial cap): speed still preserved, pitch eases toward level.
  const partial = capRedirect(steep, 2);
  expect(partial.velocity.length()).toBeCloseTo(steep.length(), 4);
  expect(partial.velocity.z).toBeCloseTo(2, 6);
  const aim = Math.atan2(steep.z, steep.x);
  expect(partial.surfacePitch!).toBeGreaterThan(0);
  expect(partial.surfacePitch!).toBeLessThan(aim);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="swim-law"`
Expected: FAIL — `Cannot find module '../swim'`.

- [ ] **Step 3: Write the law into `client/src/game/movement/swim.ts`**

Port `swim.rs` lines 60–262, Z-up.

```ts
import * as THREE from 'three';
import { GRAVITY } from './constants';
import { PlayerMoveState } from './player-state';

/** Swim travel speed (yd/s) -- vanilla's default MOVE_SWIM (0.66x run). */
export const SWIM_SPEED = 4.722222;

/**
 * Backward swim speed (yd/s) -- vanilla MOVE_SWIM_BACK. A net-backward swim takes
 * min(swimBack, swim), VERIFIED (0x7c4c90's swim arm), byte-identical in template to the run arm's
 * min(runBack, run). A strafe-only swim uses the forward speed.
 */
export const SWIM_BACK_SPEED = 2.5;

/**
 * Swim-jump take-off speed (yd/s) -- VERIFIED 0x7c6230's swim seed (0xc1118c48 = -9.096748; the
 * client stores fall velocity down-positive, up for us). A swim jump launches ~14% harder than the
 * land jump's 7.955547: enough to breach and hop onto a low bank.
 */
export const SWIM_JUMP_SPEED = 9.096748;

/**
 * The fraction of the unit's collision height the water must cover to start swimming -- VERIFIED
 * 0.75 (0x8012cc, the compare at 0x6030c0). Applied to the feet-referenced depth.
 */
export const SWIM_DEPTH_FRAC = 0.75;

/**
 * The enter/leave hysteresis band (yd) -- VERIFIED 1/36 (0x7ff9d0). Enter compares depth against
 * 0.75*h, leave against 0.75*h - 1/36, so between them the swim state holds.
 */
export const SWIM_HYSTERESIS = 1 / 36;

/**
 * Submersion depth (yd, water surface above the feet) to START swimming -- 0.75*h from the feet,
 * where h is THE UNIT'S OWN collision height. Water covering about three-quarters of its collision
 * box: chest or neck deep. Roughly 1.52 yd for a human male, 0.86 for a gnome female, 1.83 for a
 * night elf male.
 *
 * The FRACTION was always right; the height it multiplies is what matters. With one human-sized
 * constant, a gnome's rest line sits below her own head and she can never surface.
 *
 * This is also the WADE CEILING: wading is the implicit in-liquid-but-not-swimming state (there is
 * no wade movement flag), so "deepest water you can still wade" and "shallowest water you swim in"
 * are necessarily one number.
 */
export function swimEnterDepth(h: number): number {
  return SWIM_DEPTH_FRAC * h;
}

/**
 * Submersion depth (yd) below which swimming STOPS -- 0.75*h - 1/36, the lower edge of the
 * hysteresis band. The band is an absolute 1/36 yd independent of h, so it is SUBTRACTED, never
 * scaled.
 */
export function swimExitDepth(h: number): number {
  return swimEnterDepth(h) - SWIM_HYSTERESIS;
}

/**
 * The hard TOP-CAP line (yd below the surface) a rising swimmer stops at -- feet at
 * `surface - 0.75*h`, about three-quarters submerged, head out. VERIFIED: the floating resolver's
 * collision top-cap plane (0x632ba0 x0.75). The same 0.75*h as the enter threshold, so a capped
 * swimmer sits above the leave threshold and cannot flicker out of the mode.
 */
export function restCap(h: number): number {
  return swimEnterDepth(h);
}

/**
 * How far the feet must sink to satisfy the rest-line constraint -- the excess above
 * `surface - 0.75*h`, or zero when already at or under it.
 *
 * The rest line is a CONSTRAINT, not a one-way cap. The common way a swimmer ends up above it is
 * the surface coming down to meet them on a river; with the vertical frozen, a stroke down a
 * surface that falls ~10% loses depth fast enough to cross the whole 1/36 yd hysteresis band every
 * few frames, which flaps the latch about ten times a second and spends half the swim inside the
 * fall mover.
 */
export function settleToRest(feetZ: number, surfaceZ: number, h: number): number {
  return Math.max(0, feetZ - (surfaceZ - restCap(h)));
}

/**
 * Cap a rising stroke at the rest line -- and REDIRECT the capped speed level rather than bleed it
 * off. Reaching the surface flips a pitched-up swim into full-speed SURFACE SWIMMING.
 *
 * A plain slide against the top-cap plane leaves only cos(pitch)*speed -- about zero at a steep aim
 * -- pinning the swimmer under the waterline behind an invisible wall. The stroke's SPEED is
 * preserved instead: the upward component is clamped to `cap` (how much rise reaches the rest line
 * this frame) and the remainder rotates into the level travel direction.
 *
 * NAMED DIVERGENCE: the reference records that the exe's own-input resolver actually grinds a steep
 * aim at the cap, which contradicts the confirmed reference-client behaviour. This redirect is the
 * reference's own construction reproducing the validated feel, and it is carried across
 * deliberately rather than by oversight.
 *
 * Returns the velocity, and the effective travel pitch when the cap bit (null when it did not).
 */
export function capRedirect(
  inputVel: THREE.Vector3, cap: number,
): { velocity: THREE.Vector3; surfacePitch: number | null } {
  if (inputVel.z <= 0 || inputVel.z <= cap) {
    return { velocity: inputVel.clone(), surfacePitch: null };
  }
  const speed = inputVel.length();
  const levelDir = new THREE.Vector3(inputVel.x, inputVel.y, 0);
  if (levelDir.lengthSq() > 0) {
    levelDir.normalize();
  }
  const levelSpeed = Math.sqrt(Math.max(0, speed * speed - cap * cap));
  return {
    velocity: levelDir.multiplyScalar(levelSpeed).setZ(cap),
    surfacePitch: Math.atan2(cap, levelSpeed),
  };
}

/**
 * Update `state.swimming` from the water surface over the feet, with the verified enter/leave
 * hysteresis. Returns the new state. A null surface means not in liquid, which stops swimming.
 *
 * LEVITATING bails the whole decision -- the reference's very first instruction here
 * (0x6030d2 test ah,4). Neither the enter arm nor the stop arm runs, so the latch is left exactly
 * as it stands. This is not an optimisation, it IS the mechanism of GM flight: the server sets
 * SWIMMING and LEVITATING in one packet, and the second is what stops the dry ground under us
 * clearing the first on the very next frame.
 *
 * The enter arm carries the FALL RE-ENTRY GATE (VERIFIED 0x7c5de0): a fresh launch is not
 * re-latched into swim until its upward velocity has decayed to HALF the launch value. Note the
 * release happens while STILL RISING -- the dolphin hop tops out around 1.6 yd, then swim re-latches
 * and the floating resolver freezes the depth, discarding the residual velocity.
 *
 * The latch deliberately does NOT touch `state.settling`: that release belongs to world residency,
 * in every mover mode alike.
 */
export function updateSwimming(
  state: PlayerMoveState, surfaceZ: number | null, now: number,
): boolean {
  if (state.levitating) {
    return state.swimming;
  }
  if (surfaceZ === null) {
    state.swimming = false;
    return false;
  }

  const depth = surfaceZ - state.pos.z;
  const h = state.collisionHeight;

  if (state.swimming) {
    state.swimming = depth >= swimExitDepth(h);
  } else {
    const hopBlocked = state.velZ > 0
      && state.airborneSince !== null
      && now - state.airborneSince < state.jumpZSpeed / (2 * GRAVITY);
    state.swimming = depth > swimEnterDepth(h) && !hopBlocked;
  }

  return state.swimming;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="swim-law"`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/game/movement/swim.ts client/src/game/movement/__tests__/swim-law.test.ts
git commit -m "feat(movement): the swim law -- depth latch, rest line, cap redirect

Every depth line is a fraction of the unit's OWN collision height, not a
constant: with one human-sized value a gnome's rest line sits above her
head and she can never surface.

The rest line is a constraint re-satisfied each frame, not a one-way cap
-- on a river the surface descends to meet the swimmer, which otherwise
crosses the whole 1/36 yd hysteresis band every few frames and flaps the
latch about ten times a second.

Test suite ported from the reference's own; it encodes defects that were
expensive to find."
```

---

## Task 17: The swim and breach steps

The world-facing half of swimming: the floating physics that bypasses gravity, and the jump that leaves the water.

**Files:**
- Modify: `client/src/game/movement/swim.ts`
- Test: `client/src/game/movement/__tests__/swim-step.test.ts`

**Interfaces:**
- Consumes: Task 16's law, `CastFn` (Task 9), `moveAndSlide` / `airborneHitResponse` (Task 12), `Outcome` (Task 15)
- Produces:
  - `interface SwimOutcome { grounded: boolean; surfacePitch: number | null }`
  - `swimStep(state, cast, inputVel, surfaceZ, surfaceAt, dt): SwimOutcome`
  - `breachStep(state, cast, dt): Outcome`

  `surfaceZ` is the waterline over the feet at the START of the frame; `surfaceAt(feet)` resamples it wherever the stroke actually lands.

- [ ] **Step 1: Write the failing test**

Create `client/src/game/movement/__tests__/swim-step.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT } from '../constants';
import { createPlayerMoveState } from '../player-state';
import { breachStep, restCap, SWIM_JUMP_SPEED, SWIM_SPEED, swimStep } from '../swim';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const H = 2.031;
const HALF_H = CAPSULE_HEIGHT / 2;

const openWater: CastFn = () => null;

/** Solid ground at z = 0, for the shallows cases. */
const lakebed: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;
  if (gap < 0 || gap > maxDist) return null;
  return { distance: gap, normal: UP.clone(), source: 'bed' } as CastHit;
};

function swimmer(feetZ: number) {
  const p = createPlayerMoveState();
  p.pos.set(0, 0, feetZ);
  p.collisionHeight = H;
  p.swimming = true;
  return p;
}

test('an idle swimmer depth is frozen -- no sink, no rise, no ease', () => {
  // The verified floating resolver bypasses gravity entirely. There is no buoyancy spring and no
  // resting seek: the vertical comes ONLY from the pitched travel velocity.
  const surface = 100;
  const p = swimmer(surface - restCap(H) - 3);   // well below the rest line
  const before = p.pos.z;

  const out = swimStep(p, openWater, v3(0, 0, 0), surface, () => surface, 1 / 60);

  expect(p.pos.z).toBeCloseTo(before, 9);
  expect(p.velZ).toBe(0);
  expect(out.surfacePitch).toBeNull();
});

test('a level stroke moves horizontally at the stroke speed', () => {
  const surface = 100;
  const p = swimmer(surface - restCap(H) - 5);

  swimStep(p, openWater, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

  expect(p.pos.x).toBeCloseTo(SWIM_SPEED * 0.1, 4);
});

test('a rising stroke stops at the rest line, three-quarters submerged', () => {
  const surface = 100;
  const p = swimmer(surface - restCap(H) - 0.02);

  swimStep(p, openWater, v3(0, 0, SWIM_SPEED), surface, () => surface, 0.1);

  expect(p.pos.z).toBeCloseTo(surface - restCap(H), 4);
});

test('a swimmer already at the rest line cannot rise further', () => {
  const surface = 100;
  const p = swimmer(surface - restCap(H));

  const out = swimStep(p, openWater, v3(1, 0, 4), surface, () => surface, 0.1);

  expect(p.pos.z).toBeCloseTo(surface - restCap(H), 5);
  // The stroke is redirected level at full speed, not clipped to nothing.
  expect(p.pos.x).toBeGreaterThan(0.35);
  expect(out.surfacePitch).toBeCloseTo(0, 5);
});

test('a dive is never capped', () => {
  const surface = 100;
  const p = swimmer(surface - restCap(H));

  swimStep(p, openWater, v3(0, 0, -SWIM_SPEED), surface, () => surface, 0.1);

  expect(p.pos.z).toBeLessThan(surface - restCap(H));
});

test('with no waterline at all an ascent is free -- this is GM flight', () => {
  const p = swimmer(500);
  swimStep(p, openWater, v3(0, 0, 5), null, () => null, 0.1);

  expect(p.pos.z).toBeCloseTo(500.5, 4);
});

test('a stroke under a descending surface is settled back onto the rest line', () => {
  // The river case: the surface comes down to meet the swimmer. The settle must run on the surface
  // at the position the stroke REACHED, not the one it started from.
  const startSurface = 100;
  const endSurface = 99.5;
  const p = swimmer(startSurface - restCap(H));

  swimStep(p, openWater, v3(SWIM_SPEED, 0, 0), startSurface, () => endSurface, 0.1);

  expect(p.pos.z).toBeCloseTo(endSurface - restCap(H), 4);
});

test('the settle is a swept drop, so a shallow bottom holds the feet higher', () => {
  // A position clamp here would override terrain collision, shove the feet onto the rest line even
  // where the bottom holds them up, and pin the depth so the shore exit could never fire.
  const surface = 1.0;                    // shallow water over a bed at z = 0
  const p = swimmer(0);                   // already resting on the bed
  p.pos.set(0, 0, 0);

  swimStep(p, lakebed, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

  expect(p.pos.z).toBeGreaterThanOrEqual(-1e-3);
});

test('an idle frame does not settle at all', () => {
  // The resolver's own outer gate: an idle floater is not resolved, so its depth stays frozen even
  // above the rest line.
  const surface = 100;
  const p = swimmer(surface - restCap(H) + 0.5);   // above the line

  swimStep(p, openWater, v3(0, 0, 0), surface, () => surface, 0.1);

  expect(p.pos.z).toBeCloseTo(surface - restCap(H) + 0.5, 6);
});

test('swim step reports standing on a shallow bottom', () => {
  const p = swimmer(0);
  const out = swimStep(p, lakebed, v3(0, 0, 0), 1.0, () => 1.0, 1 / 60);

  expect(out.grounded).toBe(true);
});

test('swim step leaves a clean zero vertical for the fall that may follow', () => {
  const surface = 100;
  const p = swimmer(surface - restCap(H) - 2);
  p.velZ = -7;

  swimStep(p, openWater, v3(SWIM_SPEED, 0, 0), surface, () => surface, 0.1);

  expect(p.velZ).toBe(0);
  expect(p.horizVel.z).toBe(0);
});

test('the breach step launches the fall arc at the swim jump speed', () => {
  const p = swimmer(50);
  p.horizVel.set(3, 0, 0);

  const out = breachStep(p, openWater, 1 / 60);

  expect(p.velZ).toBeCloseTo(SWIM_JUMP_SPEED, 6);
  expect(out.jumped).toBe(true);
  expect(out.grounded).toBe(false);
  expect(p.pos.z).toBeGreaterThan(50);
  // Horizontal momentum freezes at takeoff, like every jump -- the last swim frame's travel carries
  // the leap.
  expect(p.pos.x).toBeCloseTo(3 / 60, 5);
});

test('the swim jump is harder than the land jump', () => {
  // ~14% harder: enough to breach and hop onto a low bank.
  expect(SWIM_JUMP_SPEED).toBeGreaterThan(7.955547);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="swim-step"`
Expected: FAIL — `swimStep is not a function`.

- [ ] **Step 3: Append to `client/src/game/movement/swim.ts`**

Port `swim.rs` lines 181–386, Z-up.

```ts
import { CastFn } from '../collision/collision-world';
import { CAPSULE_HEIGHT, GROUND_COS, GROUND_PROBE, SKIN_WIDTH } from './constants';
import { Outcome } from './mover';
import { airborneHitResponse, moveAndSlide } from './slide';

const _down = new THREE.Vector3(0, 0, -1);

/** The outcome of one swim step -- read for the wire and animation flags. */
export interface SwimOutcome {
  /** Solid walkable floor right under the feet. With the exit hysteresis this is how a swim into
   *  the shallows resolves back onto the ground. */
  grounded: boolean;
  /** The EFFECTIVE travel pitch after the rest-line redirect (the surface-swim regime), or null
   *  when the cap did not bite. The raw camera aim stays in `state.swimPitch` untouched. */
  surfacePitch: number | null;
}

/**
 * Advance the avatar one swim frame: the pitched travel velocity through the client's FLOATING
 * physics, a collide-and-slide against the lakebed and banks, and the hard rest-line cap.
 *
 * Gravity is bypassed entirely (VERIFIED): an idle swimmer's depth is FROZEN, and the vertical
 * comes only from `inputVel`.
 *
 * `surfaceZ` is the waterline over the feet at the START of the frame -- the rise cap is a limit on
 * THIS frame's climb, so it belongs to the position we climb from. `surfaceAt` resamples it
 * wherever the stroke actually lands, because the settle has to satisfy the constraint where the
 * swimmer ends up; on a river, reading the entry waterline instead lags by a frame's descent, which
 * on a steep enough surface is the whole hysteresis band.
 */
export function swimStep(
  state: PlayerMoveState,
  cast: CastFn,
  inputVel: THREE.Vector3,
  surfaceZ: number | null,
  surfaceAt: (feet: THREE.Vector3) => number | null,
  dt: number,
): SwimOutcome {
  const halfH = CAPSULE_HEIGHT * 0.5;
  const center = state.pos.clone().setZ(state.pos.z + halfH);

  // The one vertical constraint: never rise ABOVE the resting waterline. Cap the upward VELOCITY so
  // the feet reach at most the rest line this frame -- NOT the position after the slide. That
  // distinction is load-bearing: a position clamp overrides terrain collision, shoving the feet down
  // onto the rest line even where a shallow bottom holds them higher, which clips into the floor AND
  // pins the depth at or above rest, so `updateSwimming` never sees water shallow enough to leave
  // and you cannot get out onto land. A velocity cap leaves the bottom in charge.
  //
  // No waterline, no rest line: a null surface is GM flight, where the constraint has nothing to
  // constrain against and an ascent must be free.
  let cap = Infinity;
  if (surfaceZ !== null && dt > 0) {
    const restFeetZ = surfaceZ - restCap(state.collisionHeight);
    cap = Math.max(0, (restFeetZ - state.pos.z) / dt);
  }
  const { velocity, surfacePitch } = capRedirect(inputVel, cap);

  const resolved = moveAndSlide(cast, center, velocity, dt, airborneHitResponse).position;

  // SATISFY the rest line, do not merely guard it -- and do it with a SWEPT drop, not a clamp, so
  // the bottom stays in charge. Gated on a stroke, matching the resolver's own outer gate: an idle
  // floater is not resolved at all, so its depth stays frozen.
  if (inputVel.lengthSq() > 0) {
    const feet = resolved.clone().setZ(resolved.z - halfH);
    const surfaceNow = surfaceAt(feet);
    if (surfaceNow !== null) {
      const excess = settleToRest(feet.z, surfaceNow, state.collisionHeight);
      if (excess > 0) {
        const hit = cast(resolved, _down, excess, SKIN_WIDTH);
        resolved.z -= hit ? Math.min(hit.distance, excess) : excess;
      }
    }
  }

  state.pos.copy(resolved).setZ(resolved.z - halfH);
  // Swim owns its vertical directly. Leave a clean zero so exiting into a fall starts from rest, and
  // so horizVel drives the swim gait's playback rate like every other locomotion clip.
  state.velZ = 0;
  state.horizVel.set(velocity.x, velocity.y, 0);

  const probe = cast(resolved, _down, GROUND_PROBE, SKIN_WIDTH);
  return {
    grounded: !!probe && probe.normal.z >= GROUND_COS,
    surfacePitch,
  };
}

/**
 * The JUMP OUT OF THE WATER -- the takeoff frame of a jump while swimming (VERIFIED 0x7c6230):
 * SWIMMING selects SWIM_JUMP_SPEED over the land 7.955547, then the handler clears SWIMMING and
 * sets FALLING. The Jump command routes here at ANY depth: at the surface it breaches out,
 * submerged it is the dolphin hop.
 *
 * Horizontal momentum freezes at takeoff like every jump, so the last swim frame's travel carries
 * the leap. Like the land jump's takeoff frame there is no gravity tick here -- the walk mover
 * integrates gravity from the next frame -- so the arc snapshot carries the exact seed.
 *
 * The caller has already cleared `state.swimming`; the walk and fall machinery owns the arc now.
 */
export function breachStep(state: PlayerMoveState, cast: CastFn, dt: number): Outcome {
  state.velZ = SWIM_JUMP_SPEED;
  const halfH = CAPSULE_HEIGHT * 0.5;
  const center = state.pos.clone().setZ(state.pos.z + halfH);
  const velocity = state.horizVel.clone().setZ(state.velZ);

  const resolved = moveAndSlide(cast, center, velocity, dt, airborneHitResponse).position;
  state.pos.copy(resolved).setZ(resolved.z - halfH);

  return { held: false, grounded: false, jumped: true, airNudged: false, ground: null };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="swim-step"`
Expected: PASS, 13 tests.

If `the settle is a swept drop` fails, the settle was written as a position clamp. Re-read the comment on the cap — that clamp is the exact bug the swept version exists to avoid, and it manifests as being unable to walk out of water.

- [ ] **Step 5: Run the whole movement suite**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__"`
Expected: PASS — Tasks 10–17.

- [ ] **Step 6: Commit**

```bash
git add client/src/game/movement/swim.ts client/src/game/movement/__tests__/swim-step.test.ts
git commit -m "feat(movement): the swim and breach steps

Floating physics with gravity bypassed -- an idle swimmer's depth is
frozen, and the vertical comes only from the pitched stroke. The rest
line is enforced as a velocity cap plus a SWEPT settle, never a position
clamp: a clamp overrides terrain collision and pins the depth so you can
never walk out onto land.

Space at any depth breaches out at the verified swim jump speed, ~14%
harder than the land jump."
```

---

## Task 18: The camera pivot and the zoom glide

**Files:**
- Create: `client/src/game/camera/pivot.ts`
- Create: `client/src/game/camera/rig.ts`
- Test: `client/src/game/camera/__tests__/pivot.test.ts`
- Test: `client/src/game/camera/__tests__/zoom.test.ts`

**Interfaces:**
- Consumes: nothing outside three
- Produces:
  - `CAM_DIST_MIN = 0`, `CAM_DIST_MAX = 30`, `CAM_DIST_DEFAULT = 15`, `CAM_ZOOM_STEP = 1.0`, `CAM_MOVE_SPEED = 8.33`, `CAM_PITCH_LIMIT`, `CAM_COLLISION_RADIUS = 0.3`, `CAM_RETURN_RATE = 6.0`, `CAM_PIVOT_FLOOR = 5/6`, `CAM_PIVOT_FALLBACK = 1.8`, `CAM_NEAR = 1.0`, `LOOK_SENSITIVITY = 0.003`, `CLICK_DRAG_THRESHOLD = 4.0`
  - `headHeight(pivotLocal: number | null, scale: number): number`
  - `interface CameraControl { distance; targetDistance; collisionDistance; look; yaw; pitch; selfFadeAlpha }`
  - `createCameraControl(): CameraControl`
  - `applyZoomScroll(rig: CameraControl, notches: number): void`
  - `advanceZoom(rig: CameraControl, dt: number): void`
  - `applyLookDelta(rig: CameraControl, dxPx: number, dyPx: number): number` — returns the yaw delta applied

- [ ] **Step 1: Write the failing pivot test**

Create `client/src/game/camera/__tests__/pivot.test.ts`:

```ts
/** @jest-environment node */
import { CAM_PIVOT_FALLBACK, CAM_PIVOT_FLOOR, headHeight } from '../pivot';

/**
 * The camera framing pivot sits at `feet + H`, where H is MODEL-DERIVED, not a fixed height:
 * `(attach17.z + 0.0972) * scale` from M2 attachment id 17 -- about neck height on every character,
 * roughly 1.90 for a human and 0.88 for a gnome. A fixed height rides high on short races.
 */
test('a model-derived pivot scales with the avatar', () => {
  expect(headHeight(1.8, 1.0)).toBeCloseTo(1.8, 6);
  expect(headHeight(1.8, 0.5)).toBeCloseTo(0.9, 6);
  expect(headHeight(2.0, 1.15)).toBeCloseTo(2.3, 6);
});

test('the pivot is floored so it never sits on the ground', () => {
  expect(headHeight(0.1, 1.0)).toBeCloseTo(CAM_PIVOT_FLOOR, 6);
  expect(headHeight(0, 1.0)).toBeCloseTo(CAM_PIVOT_FLOOR, 6);
  expect(CAM_PIVOT_FLOOR).toBeCloseTo(5 / 6, 6);
});

test('before the body attaches, a neck-height fallback is used', () => {
  // So the first frames of third-person do not ride high, replaced the moment the model attaches.
  expect(headHeight(null, 1.0)).toBeCloseTo(CAM_PIVOT_FALLBACK, 6);
  expect(headHeight(null, 0.5)).toBeCloseTo(CAM_PIVOT_FALLBACK, 6);
});
```

- [ ] **Step 2: Write the failing zoom test**

Create `client/src/game/camera/__tests__/zoom.test.ts`:

```ts
/** @jest-environment node */
import {
  advanceZoom, applyLookDelta, applyZoomScroll, CAM_DIST_DEFAULT, CAM_DIST_MAX, CAM_DIST_MIN,
  CAM_MOVE_SPEED, CAM_PITCH_LIMIT, createCameraControl, LOOK_SENSITIVITY,
} from '../rig';

test('the rig starts at the default zoom, already settled', () => {
  const rig = createCameraControl();

  expect(rig.distance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
  expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
  expect(CAM_DIST_DEFAULT).toBe(15);
});

test('a wheel notch moves the target one yard', () => {
  const rig = createCameraControl();

  applyZoomScroll(rig, 1);
  expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT - 1, 6);

  applyZoomScroll(rig, -3);
  expect(rig.targetDistance).toBeCloseTo(CAM_DIST_DEFAULT + 2, 6);
});

test('the zoom target is clamped to the vanilla range, first person included', () => {
  const rig = createCameraControl();

  applyZoomScroll(rig, 100);
  expect(rig.targetDistance).toBeCloseTo(CAM_DIST_MIN, 6);
  expect(CAM_DIST_MIN).toBe(0);   // zoom-to-first-person

  applyZoomScroll(rig, -100);
  expect(rig.targetDistance).toBeCloseTo(CAM_DIST_MAX, 6);
  expect(CAM_DIST_MAX).toBe(30);
});

test('the zoom glides at a constant speed, not an exponential ease', () => {
  // Vanilla glides the distance toward the wheel target at a CONSTANT velocity (linear,
  // frame-delta-scaled), not an exponential approach.
  const rig = createCameraControl();
  rig.targetDistance = CAM_DIST_DEFAULT + 10;

  const before = rig.distance;
  advanceZoom(rig, 0.1);
  const firstStep = rig.distance - before;
  const mid = rig.distance;
  advanceZoom(rig, 0.1);
  const secondStep = rig.distance - mid;

  expect(firstStep).toBeCloseTo(CAM_MOVE_SPEED * 0.1, 5);
  expect(secondStep).toBeCloseTo(firstStep, 5);
});

test('the glide lands exactly on the target and stops', () => {
  const rig = createCameraControl();
  rig.targetDistance = CAM_DIST_DEFAULT + 0.1;

  advanceZoom(rig, 1.0);   // far more than enough time
  expect(rig.distance).toBeCloseTo(rig.targetDistance, 9);

  advanceZoom(rig, 1.0);
  expect(rig.distance).toBeCloseTo(rig.targetDistance, 9);
});

test('mouse motion rotates yaw and pitch at the look sensitivity', () => {
  const rig = createCameraControl();
  const yawDelta = applyLookDelta(rig, 100, 0);

  expect(Math.abs(yawDelta)).toBeCloseTo(100 * LOOK_SENSITIVITY, 6);
  expect(rig.yaw).toBeCloseTo(yawDelta, 6);
});

test('pitch is clamped at the verified 89 degrees, both ways and at every zoom', () => {
  const rig = createCameraControl();

  applyLookDelta(rig, 0, 100000);
  expect(Math.abs(rig.pitch)).toBeCloseTo(CAM_PITCH_LIMIT, 6);

  applyLookDelta(rig, 0, -200000);
  expect(Math.abs(rig.pitch)).toBeCloseTo(CAM_PITCH_LIMIT, 6);

  expect(CAM_PITCH_LIMIT).toBeCloseTo((89 * Math.PI) / 180, 6);
  expect(CAM_PITCH_LIMIT).toBeCloseTo(1.5533430576, 6);
});
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `cd client && CI=true npm test -- --testPathPattern="camera/__tests__"`
Expected: FAIL — `Cannot find module '../pivot'` and `'../rig'`.

- [ ] **Step 4: Write `client/src/game/camera/pivot.ts`**

```ts
/**
 * Floor (yd) on the world pivot height -- VERIFIED 5/6 (0x50e570's max(hi, target) lower bound).
 */
export const CAM_PIVOT_FLOOR = 5 / 6;

/**
 * Pivot height used before the avatar model has attached: a human's approximate neck height, so the
 * first frames of third-person do not ride high. Replaced by the exact model-derived value the
 * moment the body attaches.
 */
export const CAM_PIVOT_FALLBACK = 1.8;

/**
 * World head height above a modeled unit's feet.
 *
 * The camera framing pivot -- the point the boom looks at and seats behind, and the first-person eye
 * at zoom 0 -- sits at `feet + H`, where H is MODEL-DERIVED, not a fixed height: VERIFIED
 * `H = (attach17.z + 0.0972) * scale` from M2 attachment id 17 (0x50cbc0). That is about neck height
 * on every character -- roughly 1.90 for a human, 0.88 for a gnome -- with a `0.9 * vertex-box`
 * fallback for models lacking the attachment. A fixed height rides high on short races.
 *
 * `pivotLocal` is the per-model pre-scale height, or null before the body has attached.
 */
export function headHeight(pivotLocal: number | null, scale: number): number {
  if (pivotLocal === null) {
    return CAM_PIVOT_FALLBACK;
  }
  return Math.max(pivotLocal * scale, CAM_PIVOT_FLOOR);
}
```

- [ ] **Step 5: Write `client/src/game/camera/rig.ts`**

```ts
/**
 * Third-person orbit-distance limits (yards). VERIFIED from WoW.exe 5875: max orbit is
 * `cameraDistanceMax x cameraDistanceMaxFactor`, hard-capped at 50; the low clamp is 0 --
 * zoom-to-first-person, where the eye sits at the framing pivot inside the head and the avatar
 * fades out. The out-of-box default max is 15; 30 is the "Max Camera Distance" setting fully
 * raised. The starting zoom is 15.
 */
export const CAM_DIST_MIN = 0;
export const CAM_DIST_MAX = 30;
export const CAM_DIST_DEFAULT = 15;

/** Yards the wheel moves the target per notch -- CameraZoomIn/Out's default amount. VERIFIED 1.0. */
export const CAM_ZOOM_STEP = 1.0;

/**
 * Camera zoom speed in YARDS PER SECOND -- `cameraDistanceMoveSpeed`, VERIFIED default 8.33.
 * Vanilla glides the distance toward the wheel target at this CONSTANT velocity (linear,
 * frame-delta-scaled, FUN_005112d0), NOT an exponential ease.
 */
export const CAM_MOVE_SPEED = 8.33;

/** Mouse-look sensitivity: radians of camera rotation per pixel of mouse motion. */
export const LOOK_SENSITIVITY = 0.003;

/**
 * Camera pitch clamp (radians) -- VERIFIED +/-89.00 degrees (0x8089d8 = 1.5533430576 rad). A single
 * uniform clamp at every zoom level; the reference has NO distinct first-person look-down limit.
 */
export const CAM_PITCH_LIMIT = (89.0 * Math.PI) / 180;

/**
 * Camera-collision probe radius (yd): a small sphere swept from the head toward the desired camera
 * seat each frame. Its radius is the margin kept between the camera and the surface it stops at, so
 * the near plane does not poke through the wall. Smaller than the player capsule -- the camera
 * threads gaps the body cannot.
 */
export const CAM_COLLISION_RADIUS = 0.3;

/**
 * How fast the camera glides back out to the chosen zoom once an obstruction clears (1/s).
 * Pull-IN is instant -- a wall must never sit between the camera and the character -- and only the
 * push-OUT eases. That asymmetry is the vanilla feel of snapping close past an obstacle and easing
 * back.
 */
export const CAM_RETURN_RATE = 6.0;

/**
 * The camera near-plane distance (yd), shared by the projection and the self-avatar fade so the
 * model finishes fading exactly as the near plane would begin to slice it.
 */
export const CAM_NEAR = 1.0;

/**
 * Accumulated cursor motion (logical px) past which a held mouse button becomes a DRAG (camera
 * orbit / character turn) rather than a CLICK (target select). Small: a click has near-zero jitter,
 * and any real drag crosses it in a frame or two.
 */
export const CLICK_DRAG_THRESHOLD = 4.0;

/** The active mouse-look mode. */
export type LookButton = 'right' | 'left';

export interface CameraControl {
  /** Current orbit distance (yd) -- eased toward `targetDistance` so the wheel zoom glides. */
  distance: number;
  /** Where the wheel set the orbit distance; `distance` chases this. */
  targetDistance: number;
  /**
   * Effective arm length after world collision. Pulled in instantly when geometry intrudes, eased
   * back out when it clears. Kept SEPARATE from `distance` so the player's chosen zoom is preserved
   * while obstructed and restored once the view is open again.
   */
  collisionDistance: number;
  /** The button currently held for look, or null. */
  look: LookButton | null;
  /** Camera yaw about Z (radians, world). */
  yaw: number;
  /** Camera pitch (radians, + is looking up). */
  pitch: number;
  /** The self-avatar's render alpha this frame: 1 third-person, ramping to 0 in first person. */
  selfFadeAlpha: number;
}

export function createCameraControl(): CameraControl {
  return {
    distance: CAM_DIST_DEFAULT,
    targetDistance: CAM_DIST_DEFAULT,
    collisionDistance: CAM_DIST_DEFAULT,
    look: null,
    yaw: 0,
    pitch: 0,
    selfFadeAlpha: 1,
  };
}

/** A wheel event: positive `notches` zooms IN. Moves the target; `advanceZoom` glides to it. */
export function applyZoomScroll(rig: CameraControl, notches: number): void {
  const next = rig.targetDistance - notches * CAM_ZOOM_STEP;
  rig.targetDistance = Math.min(CAM_DIST_MAX, Math.max(CAM_DIST_MIN, next));
}

/** Advance the zoom glide one frame at the constant vanilla velocity. */
export function advanceZoom(rig: CameraControl, dt: number): void {
  const gap = rig.targetDistance - rig.distance;
  const stride = CAM_MOVE_SPEED * dt;
  rig.distance = Math.abs(gap) <= stride ? rig.targetDistance : rig.distance + Math.sign(gap) * stride;
}

/**
 * Apply this frame's accumulated mouse motion as look rotation. Returns the yaw delta applied, which
 * a right-drag also feeds into the character facing.
 */
export function applyLookDelta(rig: CameraControl, dxPx: number, dyPx: number): number {
  const yawDelta = -dxPx * LOOK_SENSITIVITY;
  rig.yaw += yawDelta;
  rig.pitch = Math.min(CAM_PITCH_LIMIT, Math.max(-CAM_PITCH_LIMIT, rig.pitch - dyPx * LOOK_SENSITIVITY));
  return yawDelta;
}
```

- [ ] **Step 6: Run both tests and confirm they pass**

Run: `cd client && CI=true npm test -- --testPathPattern="camera/__tests__"`
Expected: PASS, 10 tests across the two files.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/camera client/src/game/camera/__tests__
git commit -m "feat(camera): the pivot, the zoom glide and the look deltas

The framing pivot is model-derived from M2 attachment 17, not a fixed
height -- a constant rides high on short races. The zoom glides at a
constant 8.33 yd/s, which is what vanilla does; an exponential ease
feels different and is a common mis-port.

Pitch clamps at the verified 89 degrees, uniform at every zoom level:
the reference has no distinct first-person look-down limit."
```

---

## Task 19: The collision boom and the look session

**Files:**
- Modify: `client/src/game/camera/rig.ts`
- Test: `client/src/game/camera/__tests__/boom.test.ts`
- Test: `client/src/game/camera/__tests__/look-session.test.ts`

**Interfaces:**
- Consumes: Task 18's rig, `CastFn` (Task 9)
- Produces:
  - `seatCamera(rig, opts): { position: THREE.Vector3; quaternion: THREE.Quaternion }` where
    `opts = { feet: THREE.Vector3; head: THREE.Vector3; pivotHeight: number; cast: CastFn; dt: number }`
  - `selfFadeAlpha(cameraToPivot: number): number`
  - `interface LookButtons { left: boolean; right: boolean }`
  - `runLookSession(rig, buttons, motion, prev): LookSessionResult` where
    `motion = { dx: number; dy: number }`, `prev` is the previous frame's `LookButtons`, and
    `LookSessionResult = { yawDelta: number; turnsCharacter: boolean; bothButtonsRun: boolean; leftClick: boolean; rightClick: boolean }`

- [ ] **Step 1: Write the failing boom test**

Create `client/src/game/camera/__tests__/boom.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import {
  CAM_DIST_DEFAULT, CAM_NEAR, createCameraControl, seatCamera, selfFadeAlpha,
} from '../rig';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const openWorld: CastFn = () => null;

/** A cast that reports an obstruction `at` yards along any sweep. */
const blockedAt = (at: number): CastFn => (_from, _dir, maxDist) =>
  (at <= maxDist ? ({ distance: at, normal: v3(0, 0, 1), source: {} } as CastHit) : null);

function seat(rig: ReturnType<typeof createCameraControl>, cast: CastFn, dt = 1 / 60) {
  const feet = v3(0, 0, 0);
  const pivotHeight = 1.9;
  return seatCamera(rig, { feet, head: v3(0, 0, 1.7), pivotHeight, cast, dt });
}

test('an unobstructed camera sits the full zoom distance behind the pivot', () => {
  const rig = createCameraControl();
  const out = seat(rig, openWorld, 1.0);

  const pivot = v3(0, 0, 1.9);
  expect(out.position.distanceTo(pivot)).toBeCloseTo(CAM_DIST_DEFAULT, 2);
});

test('an obstruction pulls the camera in immediately', () => {
  // A wall must never sit between the camera and the character, so pull-in is instant.
  const rig = createCameraControl();
  const out = seat(rig, blockedAt(3), 1 / 60);

  const pivot = v3(0, 0, 1.9);
  expect(out.position.distanceTo(pivot)).toBeLessThan(CAM_DIST_DEFAULT);
  expect(rig.collisionDistance).toBeLessThanOrEqual(3.01);
});

test('the push back out eases rather than snapping', () => {
  const rig = createCameraControl();
  seat(rig, blockedAt(3), 1 / 60);
  const pulled = rig.collisionDistance;

  seat(rig, openWorld, 1 / 60);          // obstruction cleared
  const afterOne = rig.collisionDistance;

  expect(afterOne).toBeGreaterThan(pulled);
  expect(afterOne).toBeLessThan(CAM_DIST_DEFAULT);   // did not snap all the way back
});

test('the chosen zoom survives being obstructed', () => {
  // collisionDistance is separate from distance precisely so the player's zoom is preserved while
  // obstructed and restored once the view is open again.
  const rig = createCameraControl();
  seat(rig, blockedAt(2), 1 / 60);

  expect(rig.distance).toBeCloseTo(CAM_DIST_DEFAULT, 6);
  expect(rig.collisionDistance).toBeLessThan(CAM_DIST_DEFAULT);
});

test('the boom is rooted at the head, not the pivot', () => {
  // Body collision keeps the head inside the room -- even mid-jump it cannot pass the ceiling -- so
  // a boom swept from the head can never end up on the far side of a wall. Rooting it at the pivot
  // instead is what used to push the camera through the roof on a jump in a low room.
  const rig = createCameraControl();
  const seen: THREE.Vector3[] = [];
  const spy: CastFn = (from) => { seen.push(from.clone()); return null; };

  seat(rig, spy, 1 / 60);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0].z).toBeCloseTo(1.7, 6);   // the head, not the 1.9 pivot
});

test('at zoom zero the camera sits on the pivot and the avatar is invisible', () => {
  const rig = createCameraControl();
  rig.distance = 0;
  rig.targetDistance = 0;
  rig.collisionDistance = 0;

  const out = seat(rig, openWorld, 1 / 60);

  expect(out.position.distanceTo(v3(0, 0, 1.9))).toBeLessThan(0.05);
  expect(rig.selfFadeAlpha).toBeCloseTo(0, 3);
});

test('the self fade is opaque in third person and gone by the near plane', () => {
  expect(selfFadeAlpha(CAM_DIST_DEFAULT)).toBeCloseTo(1, 6);
  expect(selfFadeAlpha(0)).toBeCloseTo(0, 6);
  expect(selfFadeAlpha(CAM_NEAR)).toBeLessThan(1);

  // Monotonic: no flicker as the boom eases.
  let previous = -1;
  for (let d = 0; d <= 5; d += 0.25) {
    const a = selfFadeAlpha(d);
    expect(a).toBeGreaterThanOrEqual(previous);
    previous = a;
  }
});

test('backing into a wall thins the avatar too', () => {
  // The fade is keyed off the REALIZED camera-to-pivot distance, collision-pulled -- which is the
  // faithful behaviour, not an accident of zoom.
  const rig = createCameraControl();
  seat(rig, blockedAt(0.5), 1 / 60);

  expect(rig.selfFadeAlpha).toBeLessThan(1);
});
```

- [ ] **Step 2: Write the failing look-session test**

Create `client/src/game/camera/__tests__/look-session.test.ts`:

```ts
/** @jest-environment node */
import { CLICK_DRAG_THRESHOLD, createCameraControl, runLookSession } from '../rig';

const none = { left: false, right: false };
const still = { dx: 0, dy: 0 };
const drag = { dx: 50, dy: 0 };

test('right-drag turns the character', () => {
  const rig = createCameraControl();
  const out = runLookSession(rig, { left: false, right: true }, drag, none);

  expect(rig.look).toBe('right');
  expect(out.turnsCharacter).toBe(true);
  expect(out.yawDelta).not.toBe(0);
});

test('left-drag orbits the camera without turning the character', () => {
  const rig = createCameraControl();
  // Left engages only once the cursor drags past the threshold, so a left CLICK stays available
  // for target selection.
  runLookSession(rig, { left: true, right: false }, still, none);
  expect(rig.look).toBeNull();

  const out = runLookSession(rig, { left: true, right: false }, drag, { left: true, right: false });
  expect(rig.look).toBe('left');
  expect(out.turnsCharacter).toBe(false);
  expect(out.yawDelta).not.toBe(0);
});

test('a left press and release below the threshold is a click, not an orbit', () => {
  const rig = createCameraControl();
  runLookSession(rig, { left: true, right: false }, { dx: CLICK_DRAG_THRESHOLD / 4, dy: 0 }, none);
  const out = runLookSession(rig, none, still, { left: true, right: false });

  expect(out.leftClick).toBe(true);
  expect(rig.look).toBeNull();
});

test('a right press and release that never turned is a context click', () => {
  const rig = createCameraControl();
  runLookSession(rig, { left: false, right: true }, still, none);
  const out = runLookSession(rig, none, still, { left: false, right: true });

  expect(out.rightClick).toBe(true);
});

test('both buttons held run the character forward and steer like a right-drag', () => {
  const rig = createCameraControl();
  const out = runLookSession(rig, { left: true, right: true }, drag, none);

  expect(out.bothButtonsRun).toBe(true);
  expect(out.turnsCharacter).toBe(true);
});

test('a left join cancels the pending left click, so releasing never fires a selection', () => {
  const rig = createCameraControl();
  runLookSession(rig, { left: true, right: false }, still, none);
  runLookSession(rig, { left: true, right: true }, still, { left: true, right: false });
  const out = runLookSession(rig, none, still, { left: true, right: true });

  expect(out.leftClick).toBe(false);
});

test('releasing one button of a both-button hold hands the session to the other', () => {
  // Vanilla keeps turning or orbiting seamlessly on the remaining button, cursor staying hidden.
  const rig = createCameraControl();
  runLookSession(rig, { left: true, right: true }, drag, none);
  expect(rig.look).not.toBeNull();

  runLookSession(rig, { left: true, right: false }, drag, { left: true, right: true });
  expect(rig.look).toBe('left');
});

test('releasing every button ends the session', () => {
  const rig = createCameraControl();
  runLookSession(rig, { left: false, right: true }, drag, none);
  runLookSession(rig, none, still, { left: false, right: true });

  expect(rig.look).toBeNull();
});

test('a left-drag orbit offset persists after release', () => {
  // The vanilla auto-follow that swung the camera back behind the character while moving is
  // deliberately NOT ported: the camera stays where you put it.
  const rig = createCameraControl();
  runLookSession(rig, { left: true, right: false }, drag, none);
  runLookSession(rig, { left: true, right: false }, drag, { left: true, right: false });
  const parked = rig.yaw;

  runLookSession(rig, none, still, { left: true, right: false });
  runLookSession(rig, none, still, none);

  expect(rig.yaw).toBeCloseTo(parked, 9);
});
```

- [ ] **Step 3: Run both tests and confirm they fail**

Run: `cd client && CI=true npm test -- --testPathPattern="camera/__tests__/(boom|look-session)"`
Expected: FAIL — `seatCamera is not a function`, `runLookSession is not a function`.

- [ ] **Step 4: Append `seatCamera` and `selfFadeAlpha` to `rig.ts`**

Port `samples/benilla/crates/benilla/src/player/camera.rs` lines 369–472, Z-up (yaw about Z; the boom's forward is built from yaw and pitch in the Z-up frame).

```ts
import * as THREE from 'three';
import { CastFn } from '../collision/collision-world';

/** How far in front of the near plane the avatar has fully faded (yd). */
const SELF_FADE_WINDOW = 1.5;

/**
 * The self-avatar's render alpha from the REALIZED camera-to-pivot distance: 1 in third person,
 * ramping to 0 as the camera reaches the head. Keyed off the collision-pulled distance rather than
 * the zoom, so backing into a wall also thins you -- which is the faithful behaviour.
 */
export function selfFadeAlpha(cameraToPivot: number): number {
  const t = (cameraToPivot - CAM_NEAR) / SELF_FADE_WINDOW;
  return Math.min(1, Math.max(0, t));
}

/**
 * Orient the camera and orbit it behind the avatar, with world collision.
 *
 * The framing PIVOT is `feet + pivotHeight` (model-derived, about neck height). The camera looks at
 * it and, at zoom 0, sits ON it -- the first-person eye inside the head.
 *
 * Camera collision is a single sweep of the probe sphere from the player's HEAD (the capsule's top
 * cap centre) out to the ideal seat. Rooting the arm at the head is what makes it robust: body
 * collision keeps the head inside the room -- even mid-jump it cannot pass the ceiling -- so the
 * swept camera can never end up on the far side of a wall. That is why a jump in a low room does not
 * push it through the roof: the sweep just stops under the ceiling.
 *
 * Pull-in is instant; push-out eases at CAM_RETURN_RATE. Collision wins outright -- there is no
 * minimum-distance floor forcing the camera past a too-close hit.
 */
export function seatCamera(
  rig: CameraControl,
  opts: {
    feet: THREE.Vector3;
    head: THREE.Vector3;
    pivotHeight: number;
    cast: CastFn;
    dt: number;
  },
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const { feet, head, pivotHeight, cast, dt } = opts;

  // Z-up forward from yaw (about Z) and pitch.
  const cosPitch = Math.cos(rig.pitch);
  const forward = new THREE.Vector3(
    Math.cos(rig.yaw) * cosPitch,
    Math.sin(rig.yaw) * cosPitch,
    Math.sin(rig.pitch),
  );

  const pivot = feet.clone().setZ(feet.z + pivotHeight);
  const seat = pivot.clone().addScaledVector(forward, -rig.distance);
  const boom = seat.clone().sub(head);
  const boomLen = Math.max(boom.length(), 1e-3);
  const boomDir = boom.clone().divideScalar(boomLen);

  // The camera collides with its OWN audience (the camera face set), not the walking mesh.
  const hit = cast(head, boomDir, boomLen);
  const open = hit ? hit.distance : boomLen;

  if (open < rig.collisionDistance) {
    rig.collisionDistance = open;   // instant: a wall must never sit between camera and character
  } else {
    const t = 1 - Math.exp(-CAM_RETURN_RATE * dt);
    rig.collisionDistance += (open - rig.collisionDistance) * t;
  }

  const frac = Math.min(1, Math.max(0, rig.collisionDistance / boomLen));
  const position = head.clone().addScaledVector(boom, frac);

  rig.selfFadeAlpha = selfFadeAlpha(position.distanceTo(pivot));

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(position, pivot, new THREE.Vector3(0, 0, 1)),
  );

  return { position, quaternion };
}
```

- [ ] **Step 5: Append `runLookSession` to `rig.ts`**

Port the session state machine from `camera.rs` lines 190–330, minus the parts that belong to systems this client does not have (the egui hover test, the inspect mode).

```ts
export interface LookButtons {
  left: boolean;
  right: boolean;
}

export interface LookSessionResult {
  /** Yaw rotation applied this frame (radians). A right-drag also feeds this to the facing. */
  yawDelta: number;
  /** This frame's look turns the CHARACTER (right-drag or both-button run), not just the camera. */
  turnsCharacter: boolean;
  /** Both buttons are held: vanilla's both-button forward run. */
  bothButtonsRun: boolean;
  /** A left press+release that never dragged -- a target select. */
  leftClick: boolean;
  /** A right press+release that never turned -- the context action. */
  rightClick: boolean;
}

/** Accumulated drag distance per button while a press is being classified. */
const pending = { left: null as number | null, right: null as number | null };

/**
 * The mouse-look session state machine: start, stop and hand-off between the two look modes, plus
 * the click-versus-drag tests.
 *
 * Right-drag turns the character and engages instantly on press -- turning must feel immediate --
 * so its click test just rides the session and the release decides. Left-drag orbits the camera and
 * is DEFERRED: a left click selects a target instead, so the orbit only engages once the cursor
 * drags past CLICK_DRAG_THRESHOLD. Both buttons held is vanilla's forward run, steering like a
 * right-drag, and it is never a click.
 */
export function runLookSession(
  rig: CameraControl,
  buttons: LookButtons,
  motion: { dx: number; dy: number },
  prev: LookButtons,
): LookSessionResult {
  const bothButtonsRun = buttons.left && buttons.right;
  let leftClick = false;
  let rightClick = false;

  // Press edges start a click test.
  if (buttons.right && !prev.right) pending.right = 0;
  if (buttons.left && !prev.left) pending.left = 0;

  // A left+right gesture is a run or a turn, never a target select. Cancel the pending left test the
  // instant the right button joins, so releasing out of a both-button move fires nothing.
  if (buttons.right) pending.left = null;
  if (buttons.left && pending.right !== null && buttons.right) pending.right = null;

  const moved = Math.hypot(motion.dx, motion.dy);
  if (pending.right !== null) pending.right += moved;
  if (pending.left !== null) pending.left += moved;

  if (rig.look) {
    const held = rig.look === 'right' ? buttons.right : buttons.left;
    if (!held) {
      if (rig.look === 'right' && pending.right !== null && pending.right < CLICK_DRAG_THRESHOLD) {
        rightClick = true;
      }
      pending[rig.look] = null;

      // Hand off to the other button if it is still held, rather than ending the session -- vanilla
      // keeps turning or orbiting seamlessly, cursor staying hidden throughout.
      const other: LookButton = rig.look === 'right' ? 'left' : 'right';
      rig.look = (other === 'right' ? buttons.right : buttons.left) ? other : null;
    }
  } else {
    if (buttons.right) {
      rig.look = 'right';               // instant on press
    } else if (buttons.left && pending.left !== null && pending.left >= CLICK_DRAG_THRESHOLD) {
      rig.look = 'left';                // deferred past the drag threshold
    }
  }

  // A left release with a pending, never-dragged test is a target select.
  if (!buttons.left && prev.left && pending.left !== null) {
    leftClick = pending.left < CLICK_DRAG_THRESHOLD;
    pending.left = null;
  }
  if (!buttons.right && prev.right) {
    if (pending.right !== null && pending.right < CLICK_DRAG_THRESHOLD) rightClick = true;
    pending.right = null;
  }

  const yawDelta = rig.look ? applyLookDelta(rig, motion.dx, motion.dy) : 0;

  return {
    yawDelta,
    turnsCharacter: rig.look === 'right' || bothButtonsRun,
    bothButtonsRun,
    leftClick,
    rightClick,
  };
}
```

- [ ] **Step 6: Run both tests and confirm they pass**

Run: `cd client && CI=true npm test -- --testPathPattern="camera/__tests__"`
Expected: PASS — 10 from Task 18 plus 8 boom and 9 look-session.

The click-versus-drag edges are the fiddly part. If a test fails, work the state machine against the test's exact frame sequence rather than adjusting the test — each of these cases is a real vanilla behaviour, and the "a left join cancels the pending left click" one in particular is what stops a both-button run firing a spurious selection when you let go.

- [ ] **Step 7: Commit**

```bash
git add client/src/game/camera client/src/game/camera/__tests__
git commit -m "feat(camera): the collision boom and the two look modes

The boom is swept from the HEAD, not the pivot: body collision keeps the
head inside the room, so a head-rooted sweep can never end up on the far
side of a wall -- which is why a jump in a low room no longer pushes the
camera through the roof.

Pull-in is instant and push-out eases, and the chosen zoom is kept
separate from the collision-pulled arm so it survives being obstructed.
A left-drag orbit offset persists: the vanilla auto-follow is
deliberately not ported."
```

---

## Task 20: Make the player body render

The body does not draw today. **Diagnose before fixing** — the path has five hops and it could break at any of them. Guessing which would be the wrong move.

**Files:**
- Modify: `client/src/game/classes/unit.ts` (the `displayId` setter and the model placement)
- Modify: whichever file the diagnosis implicates
- Test: `client/src/game/classes/__tests__/display-id.test.ts`

**Interfaces:**
- Consumes: `collisionHeight` from Task 2
- Produces: `Unit.collisionHeight: number` — `CreatureModelData.collisionHeight × displayScale`, or `DEFAULT_COLLISION_HEIGHT` when unresolved. Consumed by the swim depth lines in Task 21.

- [ ] **Step 1: Instrument the chain and find where it breaks**

Run the app (`cd client && npm start`, open `http://localhost:3000`) and in the browser console step the chain by hand:

```js
// 1. Does the DBC even load, and is it an array of records?
const DBC = window.world && (await import('./game/pipeline/dbc')).default;
const cdi = await DBC.load('CreatureDisplayInfo');
console.log('CreatureDisplayInfo records:', cdi.records?.length);

// 2. Does OUR id resolve?
const info = await DBC.load('CreatureDisplayInfo', 21976);
console.log('displayInfo:', info);            // expect { modelID, ... }

// 3. Does the model row resolve, and does it have a file?
const model = await DBC.load('CreatureModelData', info.modelID);
console.log('modelData:', model, model && model.file);

// 4. Does the M2 load?
// 5. Is it in the scene, and where?
console.log('player.model:', window.player?.model);
console.log('player.view children:', window.player?.view?.children?.map((c) => c.name));
console.log('player position:', window.player?.position);
```

Record which hop fails. The likely candidates, and what each looks like:
- **DBC load fails** — `records.length` is 0 or the promise rejects. The `catch` in `DBC.load` swallows it into an empty record set, so the console error is the only signal.
- **`records` is not an array** — `DBC#index` warns "DBC records is not an array" and every id lookup returns undefined.
- **`modelData.file` path does not resolve in MPQ** — `M2Blueprint.load` rejects; the `.catch(console.error)` at the end of the `displayId` setter is where it lands.
- **The model loads but is invisible** — `player.model` is set but nothing draws. Check `model.visible`, its position, and whether `world.add(player)` ran (`World#run` calls `this.add(this.player)`).
- **The model draws at the wrong place** — the view is at the origin because `worldport` ran before the map loaded.

- [ ] **Step 2: Write a regression test for the hop that broke**

Once the failing hop is known, write a test that fails for the same reason, in `client/src/game/classes/__tests__/display-id.test.ts`. If the break is in DBC record shape, assert the shape; if it is in the path munging, assert the munging. Example for the path case (adapt to the real failure):

```ts
/** @jest-environment node */

/**
 * `Unit`'s displayId setter derives the model's directory by stripping the filename:
 * `modelData.path = modelData.file.match(/^(.+?)(?:[^\\]+)$/)[1]`. A row whose `file` has no
 * backslash -- or an empty one -- makes that match null and throws inside the promise chain, where
 * the only trace is a console error.
 */
function derivePath(file: string): string | null {
  const m = file.match(/^(.+?)(?:[^\\]+)$/);
  return m ? m[1] : null;
}

test('a normal model path yields its directory', () => {
  expect(derivePath('Creature\\Human\\HumanMale.mdx')).toBe('Creature\\Human\\');
});

test('a path with no directory separator does not throw', () => {
  expect(derivePath('HumanMale.mdx')).toBeNull();
});
```

- [ ] **Step 3: Fix the failing hop**

Make the smallest change that makes the body draw. Guard the derivation that threw, correct the record shape, or fix the path — whatever the diagnosis found. Do not "fix" hops that were working.

- [ ] **Step 4: Resolve the 180-degree rotation**

`client/src/game/classes/unit.ts:226` sets `m2.rotation.z = Math.PI` under a `TODO: Figure out whether this 180 degree rotation is correct`. Determine which it is: with the mover driving `view.rotation.z = modelYaw`, walk forward and see whether the model faces its direction of travel. If the fudge is correct, replace the TODO with a comment stating why (M2 models face -Y in model space, so a Z-up world facing +X needs the half turn). If it is wrong, remove it. Either way the TODO does not survive this task.

- [ ] **Step 5: Stamp the collision height onto the unit**

In the `displayId` setter, after `CreatureModelData` resolves:

```ts
        // The unit's OWN collision height -- what every swim depth line is a fraction of. This is
        // NOT the movement capsule height, which is a constant feel knob (see movement/constants).
        // Falls back to the client's own empty-world default when the row does not carry one.
        const raw = modelData.collisionHeight;
        this.collisionHeight = raw > 0
          ? raw * (displayInfo.scale || modelData.scale || 1)
          : DEFAULT_COLLISION_HEIGHT;
```

Declare `public collisionHeight: number = DEFAULT_COLLISION_HEIGHT;` on the class and import the constant from `../movement/constants`.

- [ ] **Step 6: Remove the model-sized collider box**

The `displayId` setter currently rebuilds `this.collider.geometry` from the M2 bounding box. The mover's capsule is a constant, so this is dead weight and actively misleading — delete those lines and the `playerGeometry` / `playerMaterial` / `collider` fields with them, along with `this.view.add(this.collider)` in the constructor.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="display-id"`
Expected: PASS.

- [ ] **Step 8: Confirm visually**

Run the app. The avatar must be visible at the player position, standing on the ground, facing a consistent direction. Take note of anything that looks wrong about its scale or orientation — that is Task 21's input.

- [ ] **Step 9: Commit**

```bash
git add client/src/game/classes/unit.ts client/src/game/classes/__tests__/display-id.test.ts
git commit -m "fix(unit): make the player body render

<Replace this line with what the diagnosis actually found and what fixed
it -- the hop that broke and why.>

Also stamps the unit's own collision height (CreatureModelData x display
scale), which the swim depth lines need, and drops the model-sized
collider box: the mover's capsule is a constant."
```

---

## Task 21: Drive the mover and the camera from input

The integration task. After this the game plays.

**Files:**
- Modify: `client/src/game/classes/unit.ts`
- Modify: `client/src/game/classes/player.ts`
- Modify: `client/src/pages/game/controls/controls.tsx`
- Modify: `client/src/pages/game/index.tsx`
- Test: `client/src/game/movement/__tests__/frame.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9–20
- Produces:
  - `movementFrame(state, deps, input, dt, now): { outcome: Outcome; swim: SwimOutcome | null }` in `client/src/game/movement/frame.ts` — the mode selector, so the walk/swim/breach decision is testable without React or a camera
  - `deps = { cast: CastFn; surfaceAt(feet): number | null }`

- [ ] **Step 1: Write the failing frame test**

Create `client/src/game/movement/__tests__/frame.test.ts`:

```ts
/** @jest-environment node */
import * as THREE from 'three';
import { CastFn } from '../../collision/collision-world';
import { CastHit } from '../../collision/types';
import { CAPSULE_HEIGHT } from '../constants';
import { movementFrame } from '../frame';
import { createPlayerMoveState } from '../player-state';
import { restCap, SWIM_JUMP_SPEED, swimEnterDepth } from '../swim';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = v3(0, 0, 1);
const H = 2.031;
const HALF_H = CAPSULE_HEIGHT / 2;

const ground: CastFn = (from, dir, maxDist) => {
  if (dir.z > -0.5) return null;
  const gap = from.z - HALF_H;
  if (gap < 0 || gap > maxDist) return null;
  return { distance: gap, normal: UP.clone(), source: 'floor' } as CastHit;
};

const dry = { cast: ground, surfaceAt: () => null };
const deep = { cast: ground, surfaceAt: () => 100 };

const idle = { moving: false, dir: v3(0, 0, 0), speed: 0, wantJump: false, jumpPressed: false };

function player(feetZ: number) {
  const p = createPlayerMoveState();
  p.pos.set(0, 0, feetZ);
  p.collisionHeight = H;
  return p;
}

test('on dry land the frame runs the walk mover', () => {
  const p = player(0);
  const out = movementFrame(p, dry, idle, 1 / 60, 0);

  expect(p.swimming).toBe(false);
  expect(out.swim).toBeNull();
  expect(out.outcome.grounded).toBe(true);
});

test('deep enough water switches the frame to the swim mover', () => {
  const p = player(100 - swimEnterDepth(H) - 1);
  const out = movementFrame(p, deep, idle, 1 / 60, 0);

  expect(p.swimming).toBe(true);
  expect(out.swim).not.toBeNull();
});

test('wading is not swimming -- there is no separate wade mode', () => {
  const p = player(100 - swimEnterDepth(H) + 0.1);
  const out = movementFrame(p, deep, idle, 1 / 60, 0);

  expect(p.swimming).toBe(false);
  expect(out.swim).toBeNull();
});

test('a jump while swimming breaches instead of walking', () => {
  const p = player(100 - restCap(H));
  p.swimming = true;
  const out = movementFrame(
    p, deep, { ...idle, wantJump: true, jumpPressed: true }, 1 / 60, 0,
  );

  expect(out.outcome.jumped).toBe(true);
  expect(p.swimming).toBe(false);
  expect(p.velZ).toBeCloseTo(SWIM_JUMP_SPEED, 5);
});

test('a held jump key does not re-fire the breach after the swim re-latch', () => {
  // One hop per PRESS: the breach is edge-triggered, not level-triggered.
  const p = player(100 - restCap(H));
  p.swimming = true;
  const held = { ...idle, wantJump: true, jumpPressed: true };

  movementFrame(p, deep, held, 1 / 60, 0);
  p.swimming = true;                                     // the re-latch
  const second = movementFrame(p, deep, { ...held, jumpPressed: false }, 1 / 60, 1 / 60);

  expect(second.outcome.jumped).toBe(false);
});

test('the swim pitch is held when unsteered', () => {
  const p = player(100 - restCap(H) - 2);
  p.swimming = true;
  p.swimPitch = 0.6;

  movementFrame(p, deep, idle, 1 / 60, 0);

  expect(p.swimPitch).toBeCloseTo(0.6, 9);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/frame"`
Expected: FAIL — `Cannot find module '../frame'`.

- [ ] **Step 3: Write `client/src/game/movement/frame.ts`**

```ts
import * as THREE from 'three';
import { CastFn } from '../collision/collision-world';
import { MoveInput, Outcome, step } from './mover';
import { PlayerMoveState } from './player-state';
import {
  breachStep, SWIM_BACK_SPEED, SWIM_SPEED, SwimOutcome, swimStep, updateSwimming,
} from './swim';

/** The world access one movement frame needs. Both are closures so this stays testable. */
export interface FrameDeps {
  cast: CastFn;
  surfaceAt(feet: THREE.Vector3): number | null;
}

/** `MoveInput` plus the jump key's PRESS edge, which the swim breach is triggered on. */
export interface FrameInput extends MoveInput {
  /** True only on the frame the jump key went down. */
  jumpPressed: boolean;
}

/**
 * One movement frame: decide the regime, then run it.
 *
 * The swim latch runs FIRST, because whether we are swimming decides which mover owns the frame. A
 * jump while swimming breaches out at any depth -- at the surface it hops onto the bank, submerged
 * it is the dolphin hop -- and it is edge-triggered, so a held key does not re-fire after the swim
 * re-latch.
 */
export function movementFrame(
  state: PlayerMoveState,
  deps: FrameDeps,
  input: FrameInput,
  dt: number,
  now: number,
): { outcome: Outcome; swim: SwimOutcome | null } {
  const surfaceZ = deps.surfaceAt(state.pos);
  updateSwimming(state, surfaceZ, now);

  if (state.swimming) {
    if (input.jumpPressed) {
      // Jump clears SWIMMING unconditionally and hands the arc to the walk/fall machinery.
      state.swimming = false;
      const outcome = breachStep(state, deps.cast, dt);
      state.airborneSince = now;
      state.jumpZSpeed = state.velZ;
      state.fallStartZ = state.pos.z;
      state.fallFar = false;
      return { outcome, swim: null };
    }

    // The pitched travel basis. Backward takes min(swimBack, swim), like the run arm's
    // min(runBack, run); a strafe-only swim uses the forward speed.
    const speed = input.moving
      ? (input.dir.dot(new THREE.Vector3(Math.cos(state.faceYaw), Math.sin(state.faceYaw), 0)) < 0
        ? Math.min(SWIM_BACK_SPEED, SWIM_SPEED)
        : SWIM_SPEED)
      : 0;

    const inputVel = new THREE.Vector3();
    if (input.moving && speed > 0) {
      inputVel.copy(input.dir).normalize().multiplyScalar(speed);
      // Pitch the travel by the swim pitch: aiming up with the mouse and swimming forward is how
      // you rise. `swimPitch` itself is written by the camera, and is HELD when unsteered.
      const level = Math.hypot(inputVel.x, inputVel.y);
      inputVel.setZ(Math.tan(state.swimPitch) * level);
      inputVel.normalize().multiplyScalar(speed);
    }
    state.swimStrokeSpeed = speed;

    const swim = swimStep(state, deps.cast, inputVel, surfaceZ, deps.surfaceAt, dt);
    return {
      outcome: {
        held: state.settling, grounded: swim.grounded, jumped: false, airNudged: false, ground: null,
      },
      swim,
    };
  }

  state.swimStrokeSpeed = 0;
  return { outcome: step(state, deps.cast, input, dt, now), swim: null };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd client && CI=true npm test -- --testPathPattern="movement/__tests__/frame"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Replace `Unit`'s movement with the mover**

In `client/src/game/classes/unit.ts`:

Delete outright: `updatePlayer`, `updateGravity`, `updateGroundFollow`, `updateGroundDistance`, `updateMoving`, `applyTranslatePosition`, `translatePosition`, `changePosition`'s translate branch, `groundDistanceRaycaster`, `arrow`, `slopeAng`, `slopeType`, `SlopeType`, `capsuleInfo`, `tempBox`, `tempMat`, `tempSegment`, `tempVector`, `tempVector2`, `upVector`, `velocity`, `moving`, `jumpMoving`, `isFly`, `flySpeed`, `jumpVelocity`, `jumpVelocityConst`, `groundDistance`, `previousGroundDistance`, `minGroundDistance`, `groundZeroConstant`, `_groundFollowConstant`, `useGravity`, and the `ColliderManager` import.

Add `public move = createPlayerMoveState();` and replace `update(delta)` for the player branch with:

```ts
  update(delta: number) {
    if (!this.isPlayer) {
      this.updateSplineFollowing(delta);
      return;
    }
    // The player's frame is driven from Controls, which owns the input and the camera heading.
    // Nothing to do here.
  }

  /** Push the mover's authoritative state onto the scene graph. Called once per frame after the step. */
  syncViewFromMove() {
    this.view.position.copy(this.move.pos);
    this.view.rotation.z = this.move.modelYaw;
    this.emit('position:change', this.position, this.view.rotation);
  }
```

Keep `jump()` only as a thin setter of a pending-jump flag, or delete it and let Controls own the key edge.

- [ ] **Step 6: Rewrite `Controls` as an input adapter**

`client/src/pages/game/controls/controls.tsx` keeps the React shell, the DOM listeners and the `update(delta)` entry point, and loses every piece of camera and movement maths (`calculateCamera`, `offset`, `theta`, `phi`, `scale`, `quat`, `rotateHorizontally`, `rotateVertically`, `zoomIn`, `zoomOut`). Its `update` becomes:

```tsx
  public update(delta: number) {
    const player = this.unit;
    const now = performance.now() / 1000;

    // 1. Look session: right-drag turns the character, left-drag orbits, both buttons run.
    const look = runLookSession(this.rig, this.buttons, this.motion, this.prevButtons);
    this.motion = { dx: 0, dy: 0 };
    this.prevButtons = { ...this.buttons };
    advanceZoom(this.rig, delta);

    if (look.turnsCharacter) {
      player.move.faceYaw += look.yawDelta;
    }
    // While swimming, mouselook is a DIRECT set of the swim pitch from the camera aim -- no
    // integrator and no rate limit, which is what makes aiming up and swimming forward feel
    // immediate. A left-drag orbit steers nothing, so it must not bend the swim.
    if (player.move.swimming && this.rig.look === 'right') {
      player.move.swimPitch = Math.max(
        -MOUSELOOK_PITCH_CLAMP, Math.min(MOUSELOOK_PITCH_CLAMP, this.rig.pitch),
      );
    }

    // 2. Keyboard: A/D turn (they do NOT strafe in vanilla), Q/E strafe, W/S drive the forward axis.
    const turning = (this.keyLeft ? 1 : 0) - (this.keyRight ? 1 : 0);
    if (turning !== 0) {
      const rate = TURN_RATE * (this.isTranslating() ? TURN_RATE_MOVING : 1);
      player.move.faceYaw += turning * rate * delta;
    }

    // 3. Movement direction in the facing basis.
    const forward = (this.keyForward || look.bothButtonsRun ? 1 : 0) - (this.keyBack ? 1 : 0);
    const strafe = (this.keyStrafeLeft ? 1 : 0) - (this.keyStrafeRight ? 1 : 0);
    const yaw = player.move.faceYaw;
    const dir = new THREE.Vector3(
      Math.cos(yaw) * forward - Math.sin(yaw) * strafe,
      Math.sin(yaw) * forward + Math.cos(yaw) * strafe,
      0,
    );
    const moving = forward !== 0 || strafe !== 0;
    const speed = forward < 0 ? RUN_SPEED * RUN_BACK_RATIO : RUN_SPEED;

    // 4. One movement frame.
    const claim = { wmoGroup: null };   // TODO in Task 22: the player's live WMO room claim
    const deps = {
      cast: collisionWorld.castFor(CollisionLayer.Walk, CAPSULE_RADIUS, capsuleHalfSegment()),
      surfaceAt: (feet: THREE.Vector3) => collisionWorld.surfaceAt(feet.x, feet.y, claim)?.surfaceZ ?? null,
    };
    movementFrame(player.move, deps, {
      moving, dir, speed, wantJump: this.jumpPressed, jumpPressed: this.jumpPressed,
    }, delta, now);
    this.jumpPressed = false;   // edge-triggered: one hop per press

    // 5. The rendered body heading. Moving without a strafe snaps to the aim; standing it chases.
    if (moving && strafe === 0) {
      player.move.modelYaw = yaw;
    } else if (!moving) {
      const gap = wrapPi(yaw - player.move.modelYaw);
      player.move.modelYaw += gap * Math.min(1, STATIONARY_CHASE_RATE * TURN_RATE * delta / Math.PI);
    }
    player.syncViewFromMove();

    // 6. Seat the camera. Its cast uses the CAMERA face set, not the walking one.
    const head = player.move.pos.clone().setZ(player.move.pos.z + CAPSULE_HEIGHT - CAPSULE_RADIUS);
    const seat = seatCamera(this.rig, {
      feet: player.move.pos,
      head,
      pivotHeight: headHeight(player.cameraPivotLocal ?? null, player.scale ?? 1),
      cast: collisionWorld.castFor(CollisionLayer.Camera, CAM_COLLISION_RADIUS, 0),
      dt: delta,
    });
    this.camera.position.copy(seat.position);
    this.camera.quaternion.copy(seat.quaternion);

    // 7. First-person: hide the body once the fade reaches zero.
    if (player.model) {
      player.model.visible = this.rig.selfFadeAlpha > 0.01;
    }
  }
```

Add `wrapPi(a)` as a small local helper (`Math.atan2(Math.sin(a), Math.cos(a))`), and the pointer-lock handling: on `mousedown` in the viewport request pointer lock, on `mouseup` with no buttons held release it, and read `event.movementX/movementY` in `mousemove` while locked, accumulating into `this.motion`.

- [ ] **Step 7: Widen the camera near plane check**

`client/src/pages/game/index.tsx:72` constructs the camera with a near plane of `2`. `CAM_NEAR` is `1.0` and the self-fade is tuned to it. Change the constructor to use `CAM_NEAR`.

- [ ] **Step 8: Run every test**

Run: `cd client && CI=true npm test`
Expected: PASS — the whole suite, including everything pre-existing on the branch.

- [ ] **Step 9: Play it**

Run the app and check each of these by hand. They are the things unit tests cannot cover:

- walking on flat ground feels like a constant speed, and so does walking up a gentle hill
- a jump leaves the ground, arcs, and lands without a visible pop
- stairs and doorsteps are walked up; a fence or a wall slides instead
- a steep hillside cannot be climbed by walking into it
- the camera stops at walls instead of passing through, and eases back out when clear
- right-drag turns the character, left-drag orbits it, both buttons run forward
- the wheel zooms smoothly, and at full zoom-in the body disappears into first person
- walking into deep water starts a swim about chest deep, and walking out of it resumes walking
- while swimming, aiming up with the right mouse and swimming forward surfaces you head-out
- Space while swimming hops you out of the water

- [ ] **Step 10: Commit**

```bash
git add client/src/game/movement/frame.ts client/src/game/movement/__tests__/frame.test.ts client/src/game/classes client/src/pages/game
git commit -m "feat(game): drive the mover and camera rig from input

The frame selector decides the regime -- walk, swim, or the breach out of
water -- before running it, so that decision is testable without React or
a camera. Controls becomes a thin input adapter: no camera or movement
maths lives in the React component any more.

Removes the dead movement code in Unit: updatePlayer was never called,
and the raycast ground-follow it sat beside has been replaced by the
swept mover."
```

---

## Task 22: The room claim and the move trace readout

Two loose ends from Task 21, both small, both worth their own gate.

**Files:**
- Modify: `client/src/pages/game/controls/controls.tsx` (the real claim)
- Modify: `client/src/pages/game/debug/debug.tsx`
- Create: `client/src/pages/game/debug/move-readout.tsx`
- Test: `client/src/pages/game/debug/__tests__/move-readout.test.tsx`

**Interfaces:**
- Consumes: `moveTrace` (Task 15), `LiquidClaim` (Task 3)
- Produces: `<MoveReadout />` — a debug panel section rendering the latest trace frame

- [ ] **Step 1: Wire the real liquid claim**

Task 21 left `const claim = { wmoGroup: null }` — ADT-only liquid, which is correct outdoors and wrong inside a flooded building. Replace it with the player's live room.

Read `client/src/game/world/visibility-manager.js` and `client/src/game/pipeline/wmo/group/index.js` to find how the camera's interior group is already determined (`bspTree.checkIfInsidePortals` is the relevant query). Apply the same classification to `player.move.pos` and pass the resulting group as `claim.wmoGroup`.

If that classification turns out to be camera-specific in a way that cannot be reused cheaply, **stop and leave the ADT-only claim in place**, and replace the TODO with a comment recording what was tried and why it did not fit. ADT-only is a bounded, visible limitation; a wrong room claim is a subtle one. Say which one shipped.

- [ ] **Step 2: Write the failing readout test**

Create `client/src/pages/game/debug/__tests__/move-readout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import React from 'react';
import { moveTrace } from '../../../../game/movement/move-trace';
import MoveReadout from '../move-readout';

beforeEach(() => {
  moveTrace.clear();
  moveTrace.enabled = true;
});

test('with no frames recorded it says so rather than rendering blanks', () => {
  moveTrace.enabled = false;
  render(<MoveReadout />);

  expect(screen.getByText(/trace off/i)).toBeInTheDocument();
});

test('the latest frame probe numbers are shown', () => {
  moveTrace.frame({
    zIn: 12.5, zOut: 12.25, grounded: true, onWalkable: true, velZ: 0,
    snap: { reach: 3.1, hit: { distance: 0.25, normalZ: 0.98 } },
    climb: null, stepUpVerdict: null,
  });

  render(<MoveReadout />);

  expect(screen.getByText(/grounded/i)).toBeInTheDocument();
  expect(screen.getByText(/3\.10/)).toBeInTheDocument();   // the snap reach
  expect(screen.getByText(/0\.25/)).toBeInTheDocument();   // the snap hit distance
});

test('a step-up verdict is surfaced, because that is the whole diagnosis of a stuck report', () => {
  moveTrace.frame({
    zIn: 0, zOut: 0, grounded: true, onWalkable: true, velZ: 0,
    snap: null, climb: null, stepUpVerdict: 'STEEP-FLOOR',
  });

  render(<MoveReadout />);

  expect(screen.getByText(/STEEP-FLOOR/)).toBeInTheDocument();
});

test('a missed snap probe reads as a miss rather than as zero', () => {
  // "reach 3.10, hit none" and "reach 3.10, hit at 0.00" mean opposite things: the first is a fall
  // about to start, the second is standing on the floor.
  moveTrace.frame({
    zIn: 50, zOut: 49.8, grounded: false, onWalkable: false, velZ: -5,
    snap: { reach: 3.1, hit: null }, climb: null, stepUpVerdict: null,
  });

  render(<MoveReadout />);

  expect(screen.getByText(/none/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `cd client && CI=true npm test -- --testPathPattern="move-readout"`
Expected: FAIL — `Cannot find module '../move-readout'`.

- [ ] **Step 4: Write `client/src/pages/game/debug/move-readout.tsx`**

```tsx
import React from 'react';
import { moveTrace } from '../../../game/movement/move-trace';

/**
 * The movement trace readout.
 *
 * Feel is not unit-testable, so this is how a "it feels stuck here" report becomes diagnosable: it
 * shows the exact probe numbers and the step-up's verdict for the current frame. The reference
 * records that this instrument is what broke its fence and tree cases when reasoning alone could
 * not.
 *
 * A missed snap probe is rendered as "none", never as 0 -- "reach 3.10, hit none" is a fall about
 * to start and "reach 3.10, hit at 0.00" is standing on the floor, and confusing the two would send
 * a diagnosis in exactly the wrong direction.
 */
export default function MoveReadout() {
  if (!moveTrace.enabled) {
    return (
      <div className="move_readout">
        trace off &mdash; set <code>moveTrace.enabled = true</code> to record
      </div>
    );
  }

  const frame = moveTrace.last();
  if (!frame) {
    return <div className="move_readout">trace on, no frames yet</div>;
  }

  const snap = frame.snap
    ? `reach ${frame.snap.reach.toFixed(2)}, hit ${
      frame.snap.hit
        ? `${frame.snap.hit.distance.toFixed(2)} (n.z ${frame.snap.hit.normalZ.toFixed(2)})`
        : 'none'
    }`
    : 'skipped (step-up took the frame)';

  return (
    <div className="move_readout">
      <div>{frame.grounded ? 'grounded' : 'airborne'}{frame.onWalkable ? ' / walkable' : ''}</div>
      <div>z {frame.zIn.toFixed(2)} &rarr; {frame.zOut.toFixed(2)}, vz {frame.velZ.toFixed(2)}</div>
      <div>snap: {snap}</div>
      {frame.climb !== null && <div>step-up climb {frame.climb.toFixed(3)}</div>}
      {frame.stepUpVerdict && <div>step-up: {frame.stepUpVerdict}</div>}
    </div>
  );
}
```

- [ ] **Step 5: Mount it in the debug panel**

Add `<MoveReadout />` to `client/src/pages/game/debug/debug.tsx`, inside a `CollapsibleSection` titled "Movement", following the pattern the lighting sections already use.

- [ ] **Step 6: Carry the step-up verdict through to the trace**

`groundedStep` currently discards the verdict when the step-up does not commit. Thread it: have `stepUp` return its verdict (it already does), have `groundedStep` include it in `GroundedStep`, and have `step` pass it into `moveTrace.frame`. Without this the readout's most useful field is always null.

- [ ] **Step 7: Run the tests**

Run: `cd client && CI=true npm test -- --testPathPattern="(move-readout|resolves|movement/__tests__/step)"`
Expected: PASS — the readout tests plus the resolve and step suites, which the threading touched.

- [ ] **Step 8: Run everything one last time**

Run: `cd client && CI=true npm test`
Expected: PASS, whole suite.

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no new errors versus the branch baseline.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/game/debug client/src/pages/game/controls client/src/game/movement
git commit -m "feat(debug): the movement trace readout, and the liquid room claim

Feel is not unit-testable, so the readout is how a 'feels stuck here'
report becomes diagnosable -- the probe numbers and the step-up verdict
for the current frame. A missed snap renders as 'none', never as 0: those
two mean opposite things.

<Say here whether the real room claim shipped or the ADT-only fallback
did, and why.>"
```

---

## Self-Review

Run against the spec after the plan is written; findings recorded here rather than left implicit.

**Spec coverage.** Every section maps to a task:

| Spec requirement | Task |
|---|---|
| Coordinate mapping | Global Constraints, applied per task |
| MOPY flags plumbing | 1 |
| `CreatureModelData.collisionHeight` | 2 |
| Two collision audiences | 3, 6 |
| `castCapsule` / `cast_move` | 4 |
| `TerrainProvider` | 5 |
| `WmoProvider` | 6 |
| `DoodadProvider` | 7 |
| `liquidAt` + room claim | 8, 22 |
| `CollisionWorld`, retire `ColliderManager` | 9 |
| `constants.ts`, `player-state.ts` | 10 |
| `walkableRideVelocity`, `steepWallPlane` | 11 |
| `moveAndSlide` | 12 |
| Atomic step-up | 13 |
| `groundedStep` / `airborneStep`, election snap | 14 |
| `step`: classify, gravity, jump, wedge, FALLINGFAR, air nudge | 15 |
| Swim latch, rest line, cap redirect | 16 |
| `swimStep`, `breachStep` | 17 |
| Camera pivot, zoom glide, pitch clamp | 18 |
| Collision boom, look modes, self-fade | 19 |
| Player body diagnosis and render | 20 |
| Integration, `Controls` rewrite | 21 |
| Move trace readout | 22 |
| Wire preparation (`Outcome`, `faceYaw`/`modelYaw`, state fields) | 10, 15 (asserted by test) |

**Known gaps, stated rather than hidden:**

1. **M2 attachment 17 is not reached.** The spec names it as the exact pivot source and names `0.9 × bbox-Z` as the documented fallback. `blizzardry/src/lib/m2/index.js:150` declares `attachments: new Nofs()` with no struct, so the data is unreachable without a parser change. This plan ships the fallback (`headHeight` takes `pivotLocal: number | null`) and does **not** include the parser task — the camera is correct-feeling on human-sized bodies and rides slightly high on short ones. Worth its own follow-up plan; it is additive and changes no interface.

2. **The self-fade may degrade to a hard hide.** The spec flags this as an implementation-time unknown. Task 21 step 7 sets `model.visible` off the alpha, which is the hard-hide behaviour. If the M2 materials do support per-instance alpha, wiring `rig.selfFadeAlpha` into them is a small follow-up; the ramp is already computed and tested.

3. **Gait and animation selection are out of scope** per the spec, so the avatar will slide rather than walk visually. `modelYaw` and `swimStrokeSpeed` are maintained and are exactly what the animation selector will read.

**Type consistency check.** `CastFn`, `CastHit`, `Triangle`, `CollisionLayer`, `LiquidClaim`, `PlayerMoveState`, `MoveInput`, `Outcome`, `GroundedStep`, `SwimOutcome`, `CameraControl`, `LookButtons` are each defined in exactly one task and referenced by that name thereafter. `capsuleHalfSegment()` is defined in Task 10 and used in Tasks 9's tests and 21. `restCap` / `settleToRest` / `capRedirect` are defined in Task 16 and used in 17 and 21.

**Ordering.** Tasks 1–2 are data plumbing and block everything. 3–9 build the collision layer bottom-up. 10–17 build movement on top of it, each testable against synthetic geometry with no world. 18–19 are the camera, independent of 10–17 and could run in parallel. 20–22 integrate. Nothing depends on a later task.
